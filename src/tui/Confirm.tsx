import { join } from "node:path";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Config, Target } from "../config.ts";
import { bytes, count } from "../format.ts";
import { type Preflight, preflight } from "../guards.ts";
import { argvFor } from "../rsync.ts";
import { padEnd, truncatePath } from "../width.ts";
import { Rule, Screen } from "./Screen.tsx";
import type { Theme } from "./theme.ts";

/**
 * A full page, deliberately not a floating modal (DESIGN.md section 6).
 *
 * The guard rails are shown as a checklist the user can read, including
 * `dry run · no` stated plainly rather than left implied. Nothing here is
 * phrased as "are you sure?"; it states what will happen.
 */

export interface ConfirmProps {
  readonly config: Config;
  readonly unit: string;
  readonly target: Target;
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

export function Confirm(props: ConfirmProps): React.ReactElement {
  const { config, unit, target, theme, width, height, onRun, onCancel } = props;
  const [pre, setPre] = useState<Preflight | null>(null);

  // The same argvFor the executor (startSync) calls — not a second construction
  // of the same paths that merely happens to agree with it. This is what
  // "nothing runs that is not shown here first" (below) actually rests on.
  const argv = argvFor(config, unit, target, "sync", {
    ...(props.needsChecksum === true ? { checksum: true } : {}),
  });

  // `argv` is deliberately not a dependency: it is the same argvFor call the
  // executor makes, frozen for the lifetime of this page — the confirm screen
  // owns the keyboard while it is up, so nothing that could change the argv
  // can change the props either. Listing it (a fresh array every render)
  // would re-run preflight — spawning rsync — on every parent render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  useEffect(() => {
    let live = true;
    preflight(config, target, argv, props.bytesPending)
      .then((p) => {
        if (live) setPre(p);
      })
      .catch((e: unknown) => {
        // A preflight that fails to run is a blocked launch, never an allowed one.
        if (live) {
          setPre({
            ok: false,
            freeAfter: null,
            checks: [{ name: "rsync", ok: false, detail: `preflight failed: ${String(e)}` }],
          });
        }
      });
    return () => {
      live = false;
    };
  }, [config, target, props.bytesPending]);

  useInput((input, key) => {
    if (key.escape || input === "q") return onCancel();
    if (key.return && pre?.ok === true) return onRun();
  });

  const W = width;
  const row = (label: string, value: string, color?: string): React.ReactElement => (
    <Box key={label}>
      <Text color={theme.dim}>{"  " + padEnd(label, 22)}</Text>
      <Text color={color ?? theme.ink}>{value}</Text>
    </Box>
  );

  const footer = (
    <Box flexDirection="column">
      {/* The literal argv. Nothing runs that is not shown here first. */}
      <Text color={theme.dim}>{"  " + argv.slice(0, -2).join(" ")}</Text>
      <Text color={theme.dim}>{"      " + truncatePath(argv[argv.length - 2] ?? "", W - 8)}</Text>
      <Text color={theme.dim}>{"      " + truncatePath(argv[argv.length - 1] ?? "", W - 8)}</Text>
      <Text> </Text>
      {pre !== null && !pre.ok ? (
        <Text color={theme.missing}>{"  blocked — a check failed. [esc] back"}</Text>
      ) : (
        <Text color={theme.dim}>{"  [enter] run   [esc] cancel"}</Text>
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
      {pre?.freeAfter != null ? row("free after", bytes(pre.freeAfter)) : null}
      <Text> </Text>

      {pre === null ? (
        <Text color={theme.dim}>{"  checks                running…"}</Text>
      ) : (
        pre.checks.map((c, i) => (
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
