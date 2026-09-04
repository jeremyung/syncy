import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config, Target } from "./config.ts";
import { IS_MACOS } from "./platform.ts";

/**
 * rsync invocation (DESIGN.md section 3).
 *
 * The binary is pinned by absolute path and never resolved from PATH. On this
 * machine `rsync` resolves to /usr/bin/rsync, which is openrsync and rejects
 * these flags outright: `rsync: invalid option -- A`.
 */

/**
 * Candidate locations for a real rsync, in preference order.
 *
 * Never resolved from PATH. On macOS this never includes /usr/bin: there
 * `rsync` is openrsync, which rejects -A outright. Homebrew installs to
 * /opt/homebrew on Apple Silicon and /usr/local on Intel; MacPorts uses
 * /opt/local.
 *
 * On Linux the distribution rsync at /usr/bin is the real thing, and that is
 * where the package manager puts it, so it is the first candidate. checkBuild
 * still refuses anything older than 3.x, and the openrsync test inside it is
 * the backstop if someone installed the BSD variant on a Linux box.
 */
export const RSYNC_CANDIDATES: readonly string[] = IS_MACOS
  ? ["/opt/homebrew/bin/rsync", "/usr/local/bin/rsync", "/opt/local/bin/rsync"]
  : ["/usr/bin/rsync", "/usr/local/bin/rsync"];

/** `SYNCY_RSYNC` overrides everything, for an rsync installed elsewhere. */
export function resolveRsync(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SYNCY_RSYNC"]?.trim();
  if (override !== undefined && override !== "") return override;
  for (const c of RSYNC_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  // Nothing found: return the first candidate so checkBuild reports a clear
  // "not executable" rather than silently falling back to openrsync.
  return RSYNC_CANDIDATES[0]!;
}

export const DEFAULT_RSYNC: string = resolveRsync();
/**
 * %M — the source file's mtime — rides along with the fields already asked
 * for. It is what lets the differences screen separate a file written since
 * the last sync from one that predates it and never copied; without it the
 * listing has no time dimension at all and every difference looks alike.
 */
export const OUT_FORMAT = "%i|%l|%M|%n";
export const PARTIAL_DIR = ".syncy-partial";

export type Mode = "quick" | "deep" | "sync";

export class RsyncError extends Error {}

/** Directory arguments must carry a trailing slash or rsync nests a level. */
function asDir(p: string): string {
  return p.endsWith("/") ? p : p + "/";
}

export interface ArgvOptions {
  /**
   * Decide what to send by checksum rather than size and date.
   *
   * Required to repair a file the deep verify flagged: bit rot leaves size and
   * mtime intact, so rsync's default quick check skips exactly the file that
   * needs replacing. Costly — it reads both sides in full — so it is used only
   * when a deep verify is what found the difference.
   */
  readonly checksum?: boolean;
}

export function buildArgv(
  mode: Mode,
  source: string,
  target: Target,
  exclude: readonly string[],
  opts: ArgvOptions = {},
): string[] {
  const drop = new Set(target.flagsDrop);
  const argv: string[] = ["-a"];
  if (!drop.has("-A")) argv.push("-A");
  if (!drop.has("-X")) argv.push("-X");
  // `-p` is implied by `-a`, so it cannot be dropped by omission — it has to be
  // switched off explicitly. Without this, a share that cannot store POSIX
  // modes reports every file as differing in permissions on every check, and
  // no amount of syncing ever resolves it.
  if (drop.has("-p")) argv.push("--no-perms");

  if (mode === "deep" || (mode === "sync" && opts.checksum === true)) argv.push("-c");

  if (mode === "quick" || mode === "deep") {
    // -vv makes rsync itemize every file it finishes with, not only the ones
    // that differ. That is the only source of progress inside a folder: a dry
    // run emits nothing otherwise, and --info=progress2 reports 0% because
    // nothing transfers. Costs one line of output per file.
    argv.push("-n", "-i", "-vv", `--out-format=${OUT_FORMAT}`);
    // --delete is dry-run only. Without it, files present at the destination but
    // absent at the source are invisible, so a destination can hold gigabytes of
    // deleted-at-source cruft and still report clean. Extras never block a
    // `verified` status; they are counted separately (DESIGN.md section 3).
    if (mode === "quick") argv.push("--delete");
  } else {
    // Itemized, not --info=progress2. progress2 emits carriage-return progress
    // lines, which a newline-delimited reader cannot surface live; itemize
    // gives one line per file, which is what the job pane shows and what makes
    // the transferred count real.
    argv.push("-i", `--out-format=${OUT_FORMAT}`);
    // Not `-P`. Bare --partial leaves the fragment at the *final path* on
    // interruption — a 9 mb file named big.bin where a 400 mb one belongs.
    //
    // A quick check does catch that: rsync reports `>f.s.......`, size
    // differing. What it cannot fix is that until a check runs, everything
    // else looking at the destination — a person browsing it, Finder, another
    // backup tool — sees a plausibly named file and no indication it is a
    // stump. --partial-dir quarantines it under a dot-directory instead, where
    // it is obviously not archive content, and rsync still resumes from it.
    argv.push(`--partial-dir=${PARTIAL_DIR}`);
  }

  // exFAT's two-second timestamp granularity makes every file look changed.
  if (target.modifyWindow > 0) argv.push(`--modify-window=${target.modifyWindow}`);

  argv.push(`--exclude=.syncy-*`);
  for (const e of exclude) argv.push(`--exclude=${e}`);

  argv.push(asDir(source), asDir(target.path));
  return argv;
}

export interface FlagGloss {
  readonly flag: string;
  /** What this flag does, in the terms the screen's reader needs. */
  readonly gloss: string;
}

/**
 * The argv in words, for the screens that show it (DESIGN.md section 6).
 *
 * The confirm page's promise is that nothing runs that is not shown first —
 * which only holds if the thing shown can be read. `-a -A -X -i
 * --out-format=%i|%l|%M|%n` is exact and inert: it satisfies the letter of
 * "shown" while telling someone deciding whether to write to a drive nothing
 * they can decide on.
 *
 * Glossed here rather than in the components, beside the `buildArgv` that
 * emits them, so a flag and its explanation are added in one place. The test
 * suite walks every mode and option `argvFor` can produce and fails on any
 * flag this does not cover — the only thing that actually keeps the two from
 * drifting.
 *
 * The two path arguments are dropped: the screens already show them, on their
 * own lines, where a long path can be truncated from the middle.
 */
export function glossArgv(argv: readonly string[]): FlagGloss[] {
  const flags = argv.slice(0, -2);
  // `--delete` means something different depending on company it keeps, and
  // this is read by someone deciding whether to let it run. Never describe it
  // as listing-only without checking that -n is actually there.
  const dryRun = flags.some(
    (a) => a === "-n" || a === "--dry-run" || (/^-[a-zA-Z]+$/.test(a) && a.includes("n")),
  );
  const out: FlagGloss[] = [];
  for (const flag of flags) {
    const gloss = glossFlag(flag, dryRun);
    if (gloss !== null) out.push({ flag, gloss });
  }
  return out;
}

/** Returns null for a flag with no gloss, which the screens show bare. */
export function glossFlag(flag: string, dryRun: boolean): string | null {
  switch (flag) {
    case "-a":
      return "recurse; keep times, permissions, symlinks, owner and group";
    case "-A":
      return "keep ACLs too";
    case "-X":
      return "keep extended attributes — Finder tags, quarantine";
    case "--no-perms":
      return "do not keep permissions — this destination cannot store them";
    case "-c":
      return "compare contents, not size and date — slow, catches bit rot";
    case "-n":
      return "dry run — reports what it would do, writes nothing";
    case "-i":
      return "one line per file it acts on";
    case "-vv":
      return "a line for files it leaves alone too — the only progress there is";
    case "--delete":
      return dryRun
        ? "also list destination-only files — under -n, deletes nothing"
        : "DELETES files at the destination that are not at the source";
  }
  if (flag.startsWith("--out-format=")) {
    return "each line: change flags, size, source mtime, name";
  }
  if (flag.startsWith("--partial-dir=")) {
    const dir = flag.slice("--partial-dir=".length);
    return `an interrupted file parks under ${dir}, not at its final name`;
  }
  if (flag.startsWith("--modify-window=")) {
    const n = flag.slice("--modify-window=".length);
    return `timestamps within ${n}s count as equal — this filesystem's granularity`;
  }
  if (flag.startsWith("--exclude=")) {
    const pat = flag.slice("--exclude=".length);
    return pat.startsWith(".syncy-")
      ? "skip syncy's own scratch files, a parked partial among them"
      : `skip anything matching ${pat}`;
  }
  return null;
}

/**
 * Builds the argv for one unit at one destination — the single place every
 * caller turns a (config, unit, target) triple into a real rsync invocation.
 *
 * Five call sites used to do this independently: `buildArgv(mode,
 * join(config.source, unit), { ...target, path: join(target.path, unit) },
 * config.exclude)`, repeated in scan.ts, sync.ts and twice in Plan.tsx —
 * and Confirm.tsx built the same pair with template strings
 * (`${config.source}/${unit}`) instead of `join()`. Confirm's own comment
 * claims "nothing runs that is not shown here first"; that promise rested on
 * those constructions happening to agree, not on them being the same code.
 * Routing every call site through this function makes it structural.
 */
export function argvFor(
  config: Config,
  unit: string,
  target: Target,
  mode: Mode,
  opts: ArgvOptions = {},
): string[] {
  return buildArgv(
    mode,
    join(config.source, unit),
    { ...target, path: join(target.path, unit) },
    config.exclude,
    opts,
  );
}

/**
 * Hard invariant, asserted at spawn time: `--delete` may only ever appear in an
 * argv that also carries `-n`. The process refuses to start otherwise.
 */
export function assertDeleteIsDryRun(argv: readonly string[]): void {
  const deletes = argv.some((a) => a === "--delete" || a.startsWith("--delete-"));
  if (!deletes) return;
  const dryRun = argv.some(
    (a) => a === "-n" || a === "--dry-run" || (/^-[a-zA-Z]+$/.test(a) && a.includes("n")),
  );
  if (!dryRun) {
    throw new RsyncError(
      `refusing to run: argv contains --delete without --dry-run\n  ${argv.join(" ")}`,
    );
  }
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly stderr: string;
}

export interface RunOptions {
  readonly bin?: string;
  readonly onLine?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export async function runRsync(argv: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  assertDeleteIsDryRun(argv);
  const bin = opts.bin ?? DEFAULT_RSYNC;

  const proc = Bun.spawn([bin, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  const pump = async (): Promise<void> => {
    if (!opts.onLine) return;
    const decoder = new TextDecoder();
    let carry = "";
    for await (const chunk of proc.stdout) {
      carry += decoder.decode(chunk, { stream: true });
      let nl = carry.indexOf("\n");
      while (nl >= 0) {
        opts.onLine(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
        nl = carry.indexOf("\n");
      }
    }
    if (carry !== "") opts.onLine(carry);
  };

  const [, stderr, exitCode] = await Promise.all([
    pump(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stderr };
}

export interface RsyncBuild {
  readonly ok: boolean;
  readonly version: string;
  readonly detail: string;
}

/**
 * Refuse to proceed against openrsync. It advertises itself as "rsync version
 * 2.6.9 compatible" and then rejects -A, so failing loudly here beats failing
 * per-unit later.
 */
export async function checkBuild(bin: string = DEFAULT_RSYNC): Promise<RsyncBuild> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const first = out.split("\n")[0] ?? "";
    if (/openrsync/i.test(out)) {
      return {
        ok: false,
        version: first.trim(),
        detail: `${bin} is openrsync; it rejects -A and -X`,
      };
    }
    const m = /rsync\s+version\s+(\d+)\.(\d+)/i.exec(out);
    if (!m || Number(m[1]) < 3) {
      return { ok: false, version: first.trim(), detail: `${bin} is older than rsync 3.x` };
    }
    return { ok: true, version: `${m[1]}.${m[2]}`, detail: bin };
  } catch (e) {
    return { ok: false, version: "", detail: `${bin} not executable: ${(e as Error).message}` };
  }
}
