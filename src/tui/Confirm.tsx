import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import type { Config, Target } from "../config.ts";
import { bytes, count } from "../format.ts";
import { preflight, type Preflight } from "../guards.ts";
import { buildArgv } from "../rsync.ts";
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

export function Confirm(props: ConfirmProps): React.ReactElement {
  const { config, unit, target, theme, width, height, onRun, onCancel } = props;
  const [pre, setPre] = useState<Preflight | null>(null);

  const argv = buildArgv(
    "sync",
    `${config.source}/${unit}`,
    { ...target, path: `${target.path}/${unit}` },
    config.exclude,
    { ...(props.needsChecksum === true ? { checksum: true } : {}) },
  );

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
    <Screen title="syncy · confirm sync" width={W} theme={theme} footer={footer} {...(height === undefined ? {} : { height })}>
      <Box>
        <Text color={theme.figure}>{"  " + unit}</Text>
        <Text color={theme.dim}>{"  →  "}</Text>
        <Text color={theme.figure}>{target.name}</Text>
      </Box>
      <Rule width={W} theme={theme} />

      {row("will transfer", `${count(props.nChanges)} files · ${bytes(props.bytesPending)}`)}
      {props.needsChecksum === true
        ? row(
            "repair mode",
            "these differ by content, so this compares by checksum — slower, and the only way to replace them",
            theme.unverified,
          )
        : null}
      {row(
        "will not delete",
        props.nExtra > 0
          ? `${count(props.nExtra)} extra files at the target remain untouched`
          : "nothing — this command carries no --delete",
      )}
      {row("destination", truncatePath(`${target.path}/${unit}`, 50))}
      {pre?.freeAfter != null ? row("free after", bytes(pre.freeAfter)) : null}
      <Text> </Text>

      {pre === null ? (
        <Text color={theme.dim}>{"  checks                running…"}</Text>
      ) : (
        pre.checks.map((c, i) => (
          <Box key={c.name}>
            <Text color={theme.dim}>{"  " + padEnd(i === 0 ? "checks" : "", 22)}</Text>
            <Text color={theme.dim}>{padEnd(c.name, 14)}</Text>
            <Text color={c.ok ? (c.warn === true ? theme.unverified : theme.verified) : theme.missing}>
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
