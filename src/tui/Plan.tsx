import { join } from "node:path";
import { Box, Text, useInput } from "ink";
import type { Config, Target } from "../config.ts";
import { argvFor, DEFAULT_RSYNC, type Mode } from "../rsync.ts";
import { padEnd, truncate, truncatePath } from "../width.ts";
import { Rule, Screen } from "./Screen.tsx";
import type { Theme } from "./theme.ts";

/**
 * What each key will actually run.
 *
 * Grouped by command rather than by destination: the flags are the same for
 * every target unless one of them drops a metadata flag, so repeating all three
 * commands per target was noise that buried the one thing worth reading.
 *
 * The commands come from the same `argvFor` the executor calls, so this
 * cannot drift from what happens — a screen describing them in prose would
 * eventually lie. That includes the checksum flag: a repair sync (started
 * when a deep verify found drift by content) runs with `-c`, and this screen
 * has to show `-c` for exactly the targets that would get it, or the promise
 * is only half true.
 */

export interface PlanProps {
  readonly config: Config;
  readonly unit: string;
  readonly theme: Theme;
  readonly width: number;
  readonly height?: number;
  readonly onClose: () => void;
  /** Called with the whole plan as text, for the clipboard. */
  readonly onCopy: (text: string) => void;
  /**
   * Targets whose most recent deep verify found drift by content rather than
   * by size or date — so a sync to them runs with `-c`, the same as
   * Confirm's `needsChecksum`.
   */
  readonly needsChecksum?: ReadonlySet<string>;
}

interface ModeInfo {
  readonly key: string;
  readonly mode: Mode;
  readonly title: string;
  readonly cost: string;
  readonly writes: boolean;
  /** Shown under the command when a flag needs defending. */
  readonly note?: string;
}

const MODES: readonly ModeInfo[] = [
  {
    key: "q",
    mode: "quick",
    title: "quick check",
    cost: "compares size and date · minutes",
    writes: false,
    // `--delete` on a line labelled "reads only" looks alarming, and should.
    // The reason belongs next to it, not in a README.
    note:
      "--delete here lists, it does not delete: -n makes the whole command a dry run. " +
      "It asks rsync to also report files present at the destination but not at the " +
      "source, which are invisible without it. Those never block anything.",
  },
  {
    key: "d",
    mode: "deep",
    title: "deep verify",
    cost: "checksums every byte on both sides · hours over a network share",
    writes: false,
  },
  {
    key: "s",
    mode: "sync",
    title: "sync",
    cost: "copies what is missing · carries no --delete, so it removes nothing",
    writes: true,
  },
];

/** Whether `target`'s sync needs `-c`, per the same rule Confirm and Job use. */
function checksumFor(target: Target, needsChecksum: ReadonlySet<string> | undefined): boolean {
  return needsChecksum?.has(target.name) === true;
}

/** The plan as plain text, for the clipboard and for tests. */
export function planText(
  config: Config,
  unit: string,
  needsChecksum?: ReadonlySet<string>,
  bin = DEFAULT_RSYNC,
): string {
  const lines: string[] = [`# syncy — commands for ${unit}`, ""];
  for (const t of config.targets) {
    lines.push(`# target: ${t.name}`);
    for (const m of MODES) {
      const opts = m.mode === "sync" && checksumFor(t, needsChecksum) ? { checksum: true } : {};
      const argv = argvFor(config, unit, t, m.mode, opts);
      lines.push(`# ${m.title}${m.writes ? " — WRITES to the destination" : " — writes nothing"}`);
      lines.push(`${bin} ${argv.join(" ")}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/** Flags only, without the two path arguments. */
function flagsFor(
  config: Config,
  unit: string,
  target: Target,
  mode: Mode,
  needsChecksum?: ReadonlySet<string>,
): string {
  const opts = mode === "sync" && checksumFor(target, needsChecksum) ? { checksum: true } : {};
  return argvFor(config, unit, target, mode, opts).slice(0, -2).join(" ");
}

/** Targets whose flags differ from the first one's, and how. */
export function deviations(
  config: Config,
  unit: string,
  needsChecksum?: ReadonlySet<string>,
): { name: string; why: string }[] {
  const first = config.targets[0];
  if (first === undefined) return [];
  const out: { name: string; why: string }[] = [];
  for (const t of config.targets.slice(1)) {
    const differs = MODES.some(
      (m) =>
        flagsFor(config, unit, t, m.mode, needsChecksum) !==
        flagsFor(config, unit, first, m.mode, needsChecksum),
    );
    if (!differs) continue;
    const why = [
      t.flagsDrop.length > 0 ? `dropping ${t.flagsDrop.join(" ")}` : "",
      t.modifyWindow > 0 ? `--modify-window=${t.modifyWindow}` : "",
      checksumFor(t, needsChecksum) !== checksumFor(first, needsChecksum) ? "checksum repair" : "",
    ]
      .filter((s) => s !== "")
      .join(" · ");
    out.push({ name: t.name, why: why === "" ? "different flags" : why });
  }
  return out;
}

export function Plan(props: PlanProps): React.ReactElement {
  const { config, unit, theme, width, height, onClose, needsChecksum } = props;

  useInput((input, key) => {
    if (key.escape || input === "q" || input === "p") return onClose();
    if (input === "c") props.onCopy(planText(config, unit, needsChecksum));
  });

  const W = width;
  const first = config.targets[0];
  const differing = deviations(config, unit, needsChecksum);

  return (
    <Screen
      title="syncy · what each key runs"
      width={W}
      theme={theme}
      footer={
        <Box flexDirection="column">
          <Rule width={W} theme={theme} />
          <Text color={theme.dim}>
            {"  none of these have run — this is what each key would run"}
          </Text>
          <Text color={theme.dim}>{"  [c] copy all   [esc] back"}</Text>
        </Box>
      }
      {...(height === undefined ? {} : { height })}
    >
      <Box>
        <Text color={theme.figure}>{"  " + unit}</Text>
        <Text color={theme.dim}>{"   the selected folder"}</Text>
      </Box>
      <Rule width={W} theme={theme} />

      {first === undefined ? (
        <Text color={theme.dim}>{"  no destinations configured — press , to add one"}</Text>
      ) : (
        <Box flexDirection="column">
          {MODES.map((m) => (
            <Box key={m.mode} flexDirection="column">
              <Box>
                <Text color={theme.figure}>{`  [${m.key}] `}</Text>
                <Text color={theme.figure}>{padEnd(m.title, 13)}</Text>
                <Text color={m.writes ? theme.unverified : theme.verified}>
                  {padEnd(m.writes ? "WRITES" : "reads only", 12)}
                </Text>
                <Text color={theme.dim}>{truncate(m.cost, Math.max(10, W - 32))}</Text>
              </Box>
              <Text color={theme.ink}>
                {"       " +
                  truncate(
                    `${DEFAULT_RSYNC} ${flagsFor(config, unit, first, m.mode, needsChecksum)}`,
                    W - 7,
                  )}
              </Text>
              {m.note === undefined ? null : <Note text={m.note} theme={theme} width={W} />}
              {m.mode === "sync" && checksumFor(first, needsChecksum) ? (
                <Note
                  text={
                    `${first.name}'s last deep verify found drift by content, so this sync compares by ` +
                    "checksum (-c) — slower, and the only way that repairs it."
                  }
                  theme={theme}
                  width={W}
                />
              ) : null}
              <Text> </Text>
            </Box>
          ))}

          {/* The paths are the only thing that varies per destination. */}
          <Rule width={W} theme={theme} char="·" />
          <Box>
            <Text color={theme.dim}>{"  from  "}</Text>
            <Text color={theme.ink}>{truncatePath(join(config.source, unit) + "/", W - 10)}</Text>
          </Box>
          {config.targets.map((t, i) => (
            <Box key={t.name}>
              <Text color={theme.dim}>{i === 0 ? "  to    " : "        "}</Text>
              <Text color={theme.ink}>
                {padEnd(truncatePath(join(t.path, unit) + "/", W - 26), W - 24)}
              </Text>
              <Text color={theme.dim}>{t.name}</Text>
            </Box>
          ))}
          {differing.length === 0 ? null : (
            <Box flexDirection="column">
              <Text> </Text>
              {differing.map((d) => (
                <Text key={d.name} color={theme.unverified}>
                  {`  ${d.name} differs — ${d.why}; press [c] for its exact command`}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Screen>
  );
}

/** Wraps an explanatory sentence to the available width. */
function Note({
  text,
  theme,
  width,
}: {
  readonly text: string;
  readonly theme: Theme;
  readonly width: number;
}): React.ReactElement {
  const room = Math.max(20, width - 9);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if ((line + " " + word).length <= room) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} color={theme.dim}>
          {"       " + l}
        </Text>
      ))}
    </Box>
  );
}
