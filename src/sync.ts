import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, Target } from "./config.ts";
import { parseItemizeLine, type Item } from "./itemize.ts";
import { debug } from "./log.ts";
import { ensureLogDir } from "./scan.ts";
import { argvFor, assertDeleteIsDryRun, DEFAULT_RSYNC, RsyncError } from "./rsync.ts";
import { appendHistory } from "./state.ts";

/**
 * Real syncing (DESIGN.md section 6). The first code in syncy that writes to a
 * target, and the only code that ever will.
 */

export interface SyncHandle {
  readonly argv: readonly string[];
  readonly logPath: string;
  /** Resolves when rsync exits, whether it succeeded, failed or was cancelled. */
  readonly done: Promise<SyncResult>;
  /** Sends SIGTERM. `--partial-dir` means an interrupted transfer leaves no half-file at the final path. */
  cancel(): void;
}

export interface SyncResult {
  readonly exitCode: number | null;
  readonly cancelled: boolean;
  readonly transferred: number;
  readonly stderr: string;
}

export interface SyncOptions {
  readonly bin?: string;
  /** Repair mode: decide by checksum, for drift a deep verify found. */
  readonly checksum?: boolean;
  /** Called with each raw stdout line. Batch on the UI side, not here. */
  readonly onLine?: (line: string) => void;
  readonly onItem?: (item: Item) => void;
  readonly logPath?: string;
  readonly now?: number;
}

export function syncLogPath(unit: string, target: string, now: number): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  return join(ensureLogDir(), `${stamp}-${unit.replace(/\//g, "_")}-${target}.log`);
}

/**
 * Starts a real transfer.
 *
 * The argv is written to history *before* the process starts, so a sync that
 * crashes the machine still leaves a record of exactly what was attempted.
 */
export function startSync(
  config: Config,
  unit: string,
  target: Target,
  opts: SyncOptions = {},
): SyncHandle {
  const now = opts.now ?? Date.now();
  const source = join(config.source, unit);
  if (!existsSync(source)) {
    throw new RsyncError(`no such unit at the source: ${source}`);
  }

  const argv = argvFor(config, unit, target, "sync", {
    ...(opts.checksum === true ? { checksum: true } : {}),
  });

  // Belt and braces: the executor asserts this too, but a sync must never get
  // as far as spawning if the invariant is broken.
  assertDeleteIsDryRun(argv);

  const logPath = opts.logPath ?? syncLogPath(unit, target.name, now);
  appendHistory({ ts: now, unit, target: target.name, argv, exitCode: null, log: logPath });

  // No mkdir: rsync creates the destination itself. syncy writes directly
  // only inside its own state directory (DESIGN.md section 2).
  const writer = Bun.file(logPath).writer();
  writer.write(`# ${new Date(now).toISOString()}\n# ${[opts.bin ?? DEFAULT_RSYNC, ...argv].join(" ")}\n`);

  // Its own process group (POSIX setsid): a cancellation must reach everything
  // the transfer forked, not just this process — and a terminal ctrl-c can no
  // longer kill rsync under the app's feet. App's two-press handler is the
  // single place a cancellation is decided.
  const proc = Bun.spawn([opts.bin ?? DEFAULT_RSYNC, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  // Marks that separate rsync's own time from syncy's. "Slow to start" and
  // "slow to finish" have completely different causes — rsync enumerating a
  // network share, versus syncy doing work around it — and without these there
  // is no way to tell which is which from the outside.
  const spawnedAt = Date.now();
  let firstLineAt: number | null = null;
  debug("sync.spawned", { unit, target: target.name });
  let cancelled = false;
  let transferred = 0;

  const pump = async (): Promise<void> => {
    const decoder = new TextDecoder();
    let carry = "";
    for await (const chunk of proc.stdout) {
      carry += decoder.decode(chunk, { stream: true });
      let nl = carry.indexOf("\n");
      while (nl >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        nl = carry.indexOf("\n");
        writer.write(line + "\n");
        if (firstLineAt === null) {
          firstLineAt = Date.now();
          debug("sync.firstOutput", { msAfterSpawn: firstLineAt - spawnedAt });
        }
        opts.onLine?.(line);
        const item = parseItemizeLine(line);
        if (item !== null) {
          if (item.kind === "change") transferred += 1;
          opts.onItem?.(item);
        }
      }
    }
    if (carry !== "") {
      writer.write(carry + "\n");
      opts.onLine?.(carry);
    }
  };

  const done = (async (): Promise<SyncResult> => {
    const [, stderr, exitCode] = await Promise.all([
      pump(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const exitedAt = Date.now();
    debug("sync.rsyncExited", {
      msTotal: exitedAt - spawnedAt,
      msToFirstOutput: firstLineAt === null ? null : firstLineAt - spawnedAt,
      msAfterLastOutput: firstLineAt === null ? null : exitedAt - firstLineAt,
      transferred,
    });
    if (stderr !== "") writer.write(stderr);
    await writer.end();
    appendHistory({ ts: Date.now(), unit, target: target.name, argv, exitCode, log: logPath });
    debug("sync.teardown", { ms: Date.now() - exitedAt });
    return { exitCode, cancelled, transferred, stderr };
  })();

  return {
    argv,
    logPath,
    done,
    cancel(): void {
      cancelled = true;
      // The whole group, not just the leader. rsync's local copy runs its
      // helper as a child of the process spawned here: a lone SIGTERM orphans
      // the helper, which keeps the log pipes open (so `done` hangs until it
      // notices on its own) and, mid-transfer, keeps writing to the target.
      if (proc.exitCode === null) {
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          proc.kill();
        }
      }
    },
  };
}
