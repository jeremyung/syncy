import { join } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Config, Target } from "../config.ts";
import { bytes, count } from "../format.ts";
import { type Preflight, preflight } from "../guards.ts";
import { argvFor, glossArgv } from "../rsync.ts";
import { padEnd, truncate, truncatePath } from "../width.ts";
import { Rule, Screen } from "./Screen.tsx";
import type { Theme } from "./theme.ts";

/**
 * A full page, deliberately not a floating modal (DESIGN.md section 6).
 *
 * The guard rails are shown as a checklist the user can read, including
 * `dry run · no` stated plainly rather than left implied. Nothing here is
 * phrased as "are you sure?"; it states what will happen.
 */

/** One destination this folder could be synced to, for the switcher. */
export interface SyncCandidate {
  readonly name: string;
  readonly nChanges: number;
  readonly bytesPending: number;
}

export interface ConfirmProps {
  readonly config: Config;
  readonly unit: string;
  readonly target: Target;
  /**
   * Every destination this folder is behind on, in ledger order, including
   * `target`. `[tab]` moves between them.
   *
   * `s` picked the first behind-or-missing destination and offered no way to
   * reach the others: with two behind, the second was unreachable until the
   * first was clean. The choice belongs here rather than in the ledger, which
   * selects folders — a folder is the unit of work for every other key, and
   * `s` is the only one that needs a single destination.
   */
  readonly candidates?: readonly SyncCandidate[];
  /** Called with the name of the destination to switch to. */
  readonly onSwitch?: (name: string) => void;
  readonly nChanges: number;
  /** Of `nChanges`, the ones not at the destination at all. */
  readonly nNew?: number;
  readonly nExtra: number;
  readonly bytesPending: number;
  /** Repair mode: the drift was found by checksum, so the sync needs -c. */
  readonly needsChecksum?: boolean;
  readonly theme: Theme;
  readonly width: number;
  readonly height?: number;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}

/**
 * New versus replaced, which "504 files" on its own cannot say.
 *
 * A creation adds to the destination; a replacement overwrites bytes that are
 * already there. Only the second is worth pausing over, and the page was
 * asking for a decision without separating them — under a repair-mode heading
 * that says "the only way to replace them" above a transfer that replaces
 * nothing.
 *
 * Returns null for checks written before `nNew` was tracked: no breakdown is
 * better than an invented one, the same rule `behindReason` follows.
 */
export function replaceLine(nChanges: number, nNew: number | undefined): string | null {
  if (nNew === undefined) return null;
  const nOld = nChanges - nNew;
  if (nOld <= 0) return `nothing — all ${count(nChanges)} are new at the destination`;
  if (nNew <= 0) return `all ${count(nChanges)} — every one is already there and differs`;
  return `${count(nOld)} of them · the other ${count(nNew)} are new at the destination`;
}

/** The next destination in the cycle, or null when there is nowhere to go. */
export function nextCandidate(
  candidates: readonly SyncCandidate[] | undefined,
  current: string,
): string | null {
  if (candidates === undefined || candidates.length < 2) return null;
  const at = candidates.findIndex((c) => c.name === current);
  // A current destination that is not in the list means the caller and this
  // page disagree about what is on offer; cycling from position 0 is a guess.
  if (at < 0) return null;
  return candidates[(at + 1) % candidates.length]!.name;
}

export function Confirm(props: ConfirmProps): React.ReactElement {
  const { config, unit, target, theme, width, height, onRun, onCancel } = props;
  // The preflight is stamped with the destination it ran against. `[tab]`
  // changes the destination while the page is up, and a result carried over
  // from the previous one would put its checks under the new one's heading —
  // and, since `ok` gates the launch, would let enter run a sync nothing had
  // actually checked. Anything not stamped with the current destination reads
  // as "still running", which is what it is.
  const [pre, setPre] = useState<{ target: string; result: Preflight } | null>(null);
  const ready = pre !== null && pre.target === target.name ? pre.result : null;

  // The same argvFor the executor (startSync) calls — not a second construction
  // of the same paths that merely happens to agree with it. This is what
  // "nothing runs that is not shown here first" (below) actually rests on.
  const argv = argvFor(config, unit, target, "sync", {
    ...(props.needsChecksum === true ? { checksum: true } : {}),
  });

  // `argv` is deliberately not a dependency: listing it (a fresh array every
  // render) would re-run preflight — spawning rsync — on every parent render.
  // Everything argvFor reads is a dependency instead: `config`, `target`, and
  // `needsChecksum`, which travels with the destination. `[tab]` changes the
  // destination, so this is no longer frozen for the page's lifetime, and the
  // stamped result above is what keeps a stale preflight from being read as
  // the current one's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    let live = true;
    const ranAgainst = target.name;
    preflight(config, target, argv, props.bytesPending)
      .then((p) => {
        if (live) setPre({ target: ranAgainst, result: p });
      })
      .catch((e: unknown) => {
        // A preflight that fails to run is a blocked launch, never an allowed one.
        if (live) {
          setPre({
            target: ranAgainst,
            result: {
              ok: false,
              freeAfter: null,
              checks: [{ name: "rsync", ok: false, detail: `preflight failed: ${String(e)}` }],
            },
          });
        }
      });
    return () => {
      live = false;
    };
  }, [config, target, props.bytesPending, props.needsChecksum]);

  const nextTarget = nextCandidate(props.candidates, target.name);

  useInput((input, key) => {
    if (key.escape || input === "q") return onCancel();
    if (key.tab && nextTarget !== null && props.onSwitch !== undefined) {
      return props.onSwitch(nextTarget);
    }
    if (key.return && ready?.ok === true) return onRun();
  });

  const W = width;
  const row = (label: string, value: string, color?: string): React.ReactElement => (
    <Box key={label}>
      <Text color={theme.dim}>{"  " + padEnd(label, 22)}</Text>
      <Text color={color ?? theme.ink}>{value}</Text>
    </Box>
  );

  // Showing the argv is what the page rests on; showing it in a form someone
  // can act on is the point of showing it. `-a -A -X -i --out-format=…` is
  // exact and unreadable, and a reader who cannot tell whether a flag deletes
  // has not actually been told what will run.
  const gloss = glossArgv(argv);
  // Rows the rest of the page needs: title, the fields, the checks, the two
  // rules, the paths and the keys — plus the blank line above the legend.
  // Deliberately generous, because several of those rows wrap at a width and
  // a path length this cannot see: a check detail, or the argv itself, can
  // each take two lines. Ink clips rather than scrolls, so an overrun costs
  // the top of the page — the unit being synced and the word `checks` — while
  // an over-estimate costs only a legend that was never load-bearing.
  const RESERVED_ROWS = 26;
  const legend = height === undefined || height - RESERVED_ROWS >= gloss.length ? gloss : [];
  const flagColumn = Math.min(28, Math.max(0, ...legend.map((g) => g.flag.length)));

  // Every other destination this folder is behind on, with the figures the
  // choice is actually made on.
  const others = (props.candidates ?? [])
    .filter((c) => c.name !== target.name)
    .map((c) => `${c.name} ${count(c.nChanges)} files · ${bytes(c.bytesPending)}`)
    .join("   ");

  const footer = (
    <Box flexDirection="column">
      {/* The literal argv. Nothing runs that is not shown here first. */}
      <Text color={theme.dim}>{"  " + argv.slice(0, -2).join(" ")}</Text>
      <Text color={theme.dim}>{"      " + truncatePath(argv[argv.length - 2] ?? "", W - 8)}</Text>
      <Text color={theme.dim}>{"      " + truncatePath(argv[argv.length - 1] ?? "", W - 8)}</Text>
      {legend.length === 0 ? null : (
        <Box flexDirection="column">
          <Text> </Text>
          {legend.map((g, i) => (
            // Keyed by position: a config listing the same exclude twice would
            // otherwise collide.
            <Box key={`${g.flag}-${i}`}>
              <Text color={theme.ink}>{"  " + padEnd(g.flag, flagColumn + 2)}</Text>
              <Text color={theme.dim}>{truncate(g.gloss, Math.max(10, W - flagColumn - 4))}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Text> </Text>
      {ready !== null && !ready.ok ? (
        <Text color={theme.missing}>
          {nextTarget === null
            ? "  blocked — a check failed. [esc] back"
            : `  blocked — a check failed. [tab] try ${nextTarget}   [esc] back`}
        </Text>
      ) : (
        <Text color={theme.dim}>
          {nextTarget === null
            ? "  [enter] run   [esc] cancel"
            : `  [enter] run   [tab] switch to ${nextTarget}   [esc] cancel`}
        </Text>
      )}
    </Box>
  );

  return (
    <Screen
      title="syncy · confirm sync"
      width={W}
      theme={theme}
      footer={footer}
      {...(height === undefined ? {} : { height })}
    >
      <Box>
        <Text color={theme.figure}>{"  " + unit}</Text>
        <Text color={theme.dim}>{"  →  "}</Text>
        <Text color={theme.figure}>{target.name}</Text>
        {others.length === 0 ? null : (
          // Named, with their own figures, rather than a bare "2 others": the
          // point of showing them is to make the choice between them, and
          // "NAS · 143 files" is what that choice is made on.
          <Text color={theme.dim}>
            {truncate(
              `   also behind: ${others}`,
              Math.max(10, W - unit.length - target.name.length - 12),
            )}
          </Text>
        )}
      </Box>
      <Rule width={W} theme={theme} />

      {row("will transfer", `${count(props.nChanges)} files · ${bytes(props.bytesPending)}`)}
      {(() => {
        const line = replaceLine(props.nChanges, props.nNew);
        return line === null ? null : row("will replace", line);
      })()}
      {props.needsChecksum === true
        ? row(
            "repair mode",
            // The count only when the check recorded one; older records keep
            // the bare wording rather than reporting every change as content.
            `${props.nNew === undefined ? "these" : count(props.nChanges - props.nNew)} differ by content, so this compares by checksum — slower, and the only way to replace them`,
            theme.unverified,
          )
        : null}
      {row(
        "will not delete",
        props.nExtra > 0
          ? `${count(props.nExtra)} extra files at the target remain untouched`
          : "nothing — this command carries no --delete",
      )}
      {row("destination", truncatePath(join(target.path, unit), 50))}
      {ready?.freeAfter != null ? row("free after", bytes(ready.freeAfter)) : null}
      <Text> </Text>

      {ready === null ? (
        <Text color={theme.dim}>{"  checks                running…"}</Text>
      ) : (
        ready.checks.map((c, i) => (
          <Box key={c.name}>
            <Text color={theme.dim}>{"  " + padEnd(i === 0 ? "checks" : "", 22)}</Text>
            <Text color={theme.dim}>{padEnd(c.name, 14)}</Text>
            <Text
              color={c.ok ? (c.warn === true ? theme.unverified : theme.verified) : theme.missing}
            >
              {padEnd(c.ok ? (c.warn === true ? "no" : "ok") : "FAIL", 5)}
            </Text>
            <Text color={theme.dim}>{c.detail}</Text>
          </Box>
        ))
      )}

      <Rule width={W} theme={theme} />
    </Screen>
  );
}
