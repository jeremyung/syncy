import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Config, isWithin, type Target } from "../config.ts";
import { saveConfig, withoutTarget, withTarget } from "../configio.ts";
import { bytes } from "../format.ts";
import { type MountEntry, modifyWindowFor } from "../fstype.ts";
import { configFile } from "../paths.ts";
import { probeTarget } from "../probe.ts";
import { identityIsProof, listUnits, targetReachability } from "../scan.ts";
import { describeVolume, identify, type MountedVolume, mountedVolumes } from "../volume.ts";
import { padEnd, truncate, truncatePath } from "../width.ts";
import { Rule, Screen } from "./Screen.tsx";
import type { Theme } from "./theme.ts";

/**
 * Configuration is a screen, not a file you hand-edit (DESIGN.md section 7).
 *
 * Adding a target is the natural moment to write its sentinel, detect its
 * filesystem and probe its metadata support — none of which the user should be
 * pasting into TOML by hand.
 */

type Mode = "list" | "source" | "path" | "name";

export interface SetupProps {
  readonly config: Config;
  readonly theme: Theme;
  readonly width: number;
  readonly height?: number;
  readonly onChange: (next: Config) => void;
  readonly onExit: () => void;
}

/**
 * Resolves what was typed into an absolute path.
 *
 * `~` expands, and anything relative resolves against the working directory.
 * Config stores absolute paths only, so this is where that happens — rather
 * than rejecting a relative path the user plainly meant.
 */
export function expandPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  const home = process.env["HOME"] ?? homedir();
  const expanded =
    trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  return resolve(expanded);
}

/**
 * Directory completions for a partially typed path, **always absolute**.
 *
 * Returning them in whatever form was typed meant accepting a completion for a
 * relative path produced a relative path, which the validator then refused.
 */
export function completions(input: string, limit = 6): string[] {
  const abs = expandPath(input);
  if (abs === "") return [];
  // A trailing slash means "list this directory"; otherwise the last segment
  // is a partial name to match on.
  const listing = input.endsWith("/") || input.endsWith("~");
  const dir = listing ? abs : dirname(abs);
  const stem = listing ? "" : basename(abs);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name.startsWith(stem))
      .map((e) => join(dir, e.name))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** The checks that make a path a legitimate target, in the order they matter. */
export function validateTargetPath(path: string, config: Config): string | null {
  const abs = expandPath(path);
  if (abs === "") return "a path is required";
  if (!existsSync(abs)) return "no such directory";
  try {
    if (!statSync(abs).isDirectory()) return "not a directory";
  } catch {
    return "cannot read that path";
  }
  // Nested source and target is data loss waiting to happen. Skipped when no
  // source is set yet, since resolve("") would silently mean the cwd.
  if (config.source !== "") {
    if (isWithin(abs, config.source)) return "inside the source root";
    if (isWithin(config.source, abs)) return "contains the source root";
  }
  if (config.targets.some((t) => t.path === abs)) return "already a destination";
  return null;
}

/** What `resolveTarget` produced: a usable target, or why there is none. */
export type TargetResolution =
  | { readonly ok: true; readonly target: Target; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The identify-then-probe sequence a new target goes through, factored out of
 * the `commitTarget` hook so its refusal path is directly testable.
 *
 * A destination is identified by asking the OS which volume is mounted there,
 * BEFORE any write to it (DESIGN.md, and see the comment this replaced in
 * commitTarget). A probe would rsync a directory into the destination, so
 * identify() must succeed before probeTarget() ever runs — if the volume
 * cannot be identified, nothing is written.
 *
 * `entries`, when given, bypasses identify()'s own mount-table read — the
 * same seam fstypeFor already takes a MountEntry list through. Without it,
 * "the volume cannot be identified" was true only of paths with nothing
 * mounted there at all, which no fixture inside this project can produce (the
 * root mount always matches); this is what makes the refusal path
 * reproducible in a test without spawning a real, unidentifiable destination.
 */
export async function resolveTarget(
  abs: string,
  name: string,
  entries?: readonly MountEntry[],
  onProgress?: (message: string) => void,
): Promise<TargetResolution> {
  const found = await identify(abs, entries);
  if (found === null) {
    return { ok: false, reason: `could not identify the volume at ${abs}` };
  }
  const fstype = found.fstype;
  onProgress?.(`probing ${name} for acl and xattr support…`);
  const probe = await probeTarget(abs);

  const target: Target = {
    name,
    path: abs,
    required: true,
    identity: found.id,
    identityKind: found.kind,
    fstype,
    modifyWindow: modifyWindowFor(fstype),
    flagsDrop: probe.flagsDrop,
  };
  // A device path is recorded like any other identity, and said out loud as
  // the weaker thing it is: `targetReachability` will not accept it as proof
  // on its own, so the person adding the target should hear that here rather
  // than discover it as an "unverified" row later.
  const detail = identityIsProof(target)
    ? `${name}: ${fstype} · ${found.kind} ${found.id} · ${probe.detail}`
    : `${name}: ${fstype} · device path ${found.id}, not a volume name — ` +
      `run \`syncy sentinel ${abs}\` to prove it by a file instead · ${probe.detail}`;
  return { ok: true, target, detail };
}

export function Setup({
  config,
  theme,
  width,
  height,
  onChange,
  onExit,
}: SetupProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>("list");
  const [cursor, setCursor] = useState(0);
  const [draft, setDraft] = useState("");
  const [pendingPath, setPendingPath] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  /**
   * Which completion is highlighted, or null while typing.
   *
   * Arrowing into the list is a distinct mode: enter then means "accept this
   * and keep going", so a directory can be walked down without retyping, and
   * only means "submit" when you are back on the input line.
   */
  const [highlight, setHighlight] = useState<number | null>(null);
  /**
   * Reachability per target, resolved off the render path.
   *
   * Identifying a volume can spawn `mount` and `diskutil`, which must not
   * happen while drawing a frame.
   */
  const [reachable, setReachable] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let live = true;
    void Promise.all(
      config.targets.map(async (t) => [t.name, await targetReachability(t)] as const),
    ).then((pairs) => {
      if (live) setReachable(new Map(pairs));
    });
    return () => {
      live = false;
    };
  }, [config.targets]);

  const unset = config.source === "";
  const units = useMemo(
    () => (!unset && existsSync(config.source) ? listUnits(config.source) : []),
    [config.source, unset],
  );
  const suggestions = mode === "path" || mode === "source" ? completions(draft) : [];

  // Read once when the screen opens. The mount table is cached briefly inside
  // volume.ts, but this screen is where someone is deciding between volumes and
  // a stale label would be worse than none — so it also refreshes whenever the
  // path being typed changes to a different directory.
  const [volumes, setVolumes] = useState<readonly MountedVolume[]>([]);
  const dir = draft.endsWith("/") ? draft : draft.slice(0, draft.lastIndexOf("/") + 1);
  // `dir` is a trigger dependency: the effect body does not read it, but the
  // volume list must refresh as the typed path crosses into a new directory,
  // and the mount table cache inside volume.ts keeps that re-read cheap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger dependency, see above.
  useEffect(() => {
    let live = true;
    void mountedVolumes().then((v) => {
      if (live) setVolumes(v);
    });
    return () => {
      live = false;
    };
  }, [dir]);

  const persist = useCallback(
    (next: Config) => {
      try {
        saveConfig(next, configFile());
        onChange(next);
        setStatus(`saved ${configFile()}`);
      } catch (e) {
        // A config the loader would reject must never reach disk, or syncy
        // could not start again.
        setStatus(`not saved — ${(e as Error).message}`);
      }
    },
    [onChange],
  );

  const commitTarget = useCallback(
    async (path: string, name: string) => {
      const abs = resolve(path);
      setStatus(`identifying ${name}…`);
      const result = await resolveTarget(abs, name, undefined, setStatus);
      if (!result.ok) {
        setStatus(result.reason);
        return;
      }
      persist(withTarget(config, result.target));
      setStatus(result.detail);
    },
    [config, persist],
  );

  useInput((input, key) => {
    if (mode === "list") {
      if (key.escape) return onExit();
      if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (key.downArrow || input === "j")
        setCursor((c) => Math.min(config.targets.length, c + 1));
      else if (input === "s") {
        setDraft(config.source);
        setHighlight(null);
        setMode("source");
      } else if (input === "a") {
        setDraft("");
        setStatus(null);
        setHighlight(null);
        setMode("path");
      } else if (input === "x") {
        const victim = config.targets[cursor];
        if (victim !== undefined) {
          persist(withoutTarget(config, victim.name));
          setCursor(0);
        }
      }
      return;
    }

    // Text entry modes.
    if (key.escape) {
      // Escape leaves the list first, and only then the field — so it undoes
      // one step at a time rather than discarding a half-typed path.
      if (highlight !== null) {
        setHighlight(null);
        return;
      }
      setMode("list");
      setStatus(null);
      return;
    }

    // Arrowing through the completions.
    if (key.downArrow && suggestions.length > 0) {
      setHighlight((h) => (h === null ? 0 : Math.min(suggestions.length - 1, h + 1)));
      return;
    }
    if (key.upArrow && suggestions.length > 0) {
      setHighlight((h) => (h === null || h === 0 ? null : h - 1));
      return;
    }

    /** Take a completion and stay in the field, ready to go deeper. */
    const accept = (index: number): void => {
      const pick = suggestions[index];
      if (pick === undefined) return;
      setDraft(pick + "/");
      setHighlight(null);
      setStatus(null);
    };

    if (key.tab) {
      accept(highlight ?? 0);
      return;
    }
    if (key.return && highlight !== null) {
      accept(highlight);
      return;
    }
    if (key.return) {
      if (mode === "source") {
        const abs = expandPath(draft);
        if (abs === "" || !existsSync(abs)) {
          setStatus("no such directory");
          return;
        }
        persist({ ...config, source: abs });
        setMode("list");
        return;
      }
      if (mode === "path") {
        const problem = validateTargetPath(draft, config);
        if (problem !== null) {
          setStatus(problem);
          return;
        }
        setPendingPath(expandPath(draft));
        setDraft(basename(expandPath(draft)));
        setMode("name");
        return;
      }
      // mode === "name"
      const name = draft.trim();
      if (name === "") {
        setStatus("a name is required");
        return;
      }
      if (config.targets.some((t) => t.name === name)) {
        setStatus(`there is already a target called ${name}`);
        return;
      }
      setMode("list");
      void commitTarget(pendingPath, name);
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((d) => d.slice(0, -1));
      setHighlight(null);
      return;
    }
    if (input !== "" && !key.ctrl && !key.meta) {
      setDraft((d) => d + input);
      setHighlight(null);
    }
  });

  const W = width;

  const footer = (
    <Box flexDirection="column">
      {status !== null ? <Text color={theme.unverified}>{"  " + status}</Text> : null}
      <Text color={theme.dim}>
        {mode === "list"
          ? "  [s] source   [a] add destination   [x] remove   [esc] back"
          : highlight !== null
            ? "  [↑↓] choose   [enter] open   [esc] back to typing"
            : suggestions.length > 0
              ? "  [↓] browse   [tab] complete   [enter] save   [esc] cancel"
              : "  [enter] save   [esc] cancel"}
      </Text>
    </Box>
  );

  return (
    <Screen
      title="syncy · setup"
      width={W}
      theme={theme}
      footer={footer}
      {...(height === undefined ? {} : { height })}
    >
      <Text color={theme.dim}>{"  source"}</Text>
      <Rule width={W} theme={theme} />
      {mode === "source" ? (
        <Entry
          label="path"
          draft={draft}
          suggestions={suggestions}
          theme={theme}
          width={W}
          highlight={highlight}
          volumes={volumes}
        />
      ) : (
        <Box>
          <Text color={unset ? theme.dim : theme.figure}>
            {"  " + padEnd(unset ? "not set" : truncatePath(config.source, 52), 54)}
          </Text>
          <Text color={theme.dim}>
            {unset
              ? "press [s] to choose"
              : existsSync(config.source)
                ? `${units.length} subfolders`
                : "not found"}
          </Text>
        </Box>
      )}
      <Text> </Text>

      <Text color={theme.dim}>{"  destinations"}</Text>
      <Rule width={W} theme={theme} />
      {config.targets.length === 0 && mode === "list" ? (
        <Text color={theme.dim}>{"  none yet — press [a] to add one"}</Text>
      ) : null}
      {config.targets.map((t, i) => {
        const reach = reachable.get(t.name) ?? "unreachable";
        return (
          <Box key={t.name} flexDirection="column">
            <Box>
              <Text color={cursor === i && mode === "list" ? theme.figure : theme.dim}>
                {cursor === i && mode === "list" ? "» " : "  "}
              </Text>
              <Text color={theme.figure}>{padEnd(t.name, 6)}</Text>
              <Text color={theme.ink}>{padEnd(truncatePath(t.path, 44), 46)}</Text>
              <Text color={reach === "ok" ? theme.verified : theme.unchecked}>
                {reach === "ok" ? "connected" : "not connected"}
              </Text>
            </Box>
            <Text color={theme.dim}>
              {`        ${t.fstype} · ${
                t.identity !== undefined
                  ? `volume ${truncate(t.identity, 26)}`
                  : `sentinel ${(t.sentinel ?? "").slice(0, 8)}`
              } · ${
                t.flagsDrop.length === 0
                  ? "acls and xattrs ok"
                  : `dropping ${t.flagsDrop.join(" ")}`
              } · ${t.required ? "required" : "optional"}`}
            </Text>
          </Box>
        );
      })}

      {mode === "path" ? (
        <Entry
          label="path"
          draft={draft}
          suggestions={suggestions}
          theme={theme}
          width={W}
          highlight={highlight}
          volumes={volumes}
        />
      ) : null}
      {mode === "name" ? (
        <Entry
          label="name"
          draft={draft}
          suggestions={[]}
          theme={theme}
          width={W}
          highlight={null}
        />
      ) : null}

      <Rule width={W} theme={theme} />
      <Text color={theme.dim}>{"  syncy tracks the immediate subfolders of this root"}</Text>
      {(() => {
        const have = config.targets.filter((t) => t.required).length;
        if (have >= config.minTargets) return null;
        const need = config.minTargets - have;
        return (
          <Text color={theme.unverified}>
            {`  nothing can reach verified yet — add ${need} more required ${
              need === 1 ? "target" : "targets"
            }`}
          </Text>
        );
      })()}
    </Screen>
  );
}

interface EntryProps {
  /** Mounted volumes, so a suggestion that is one can say what it is. */
  readonly volumes?: readonly MountedVolume[];
  readonly label: string;
  readonly draft: string;
  readonly suggestions: readonly string[];
  readonly theme: Theme;
  readonly width: number;
  readonly highlight: number | null;
}

/**
 * A note beside a suggestion that is a volume root.
 *
 * Two volumes can differ by a single letter and a capital — a network share
 * and a USB disk sitting next to each other in /Volumes — and nothing on screen
 * said which was which, so picking the right one meant already knowing. The
 * kernel already knows, so the list says it.
 */
function annotate(path: string, volumes: readonly MountedVolume[]): string | null {
  const v = volumes.find((x) => x.mountPoint === path);
  if (v === undefined) return null;
  return v.free === null ? describeVolume(v) : `${describeVolume(v)} · ${bytes(v.free)} free`;
}

function Entry({
  label,
  draft,
  suggestions,
  theme,
  width,
  highlight,
  volumes = [],
}: EntryProps): React.ReactElement {
  // Keep the tail visible. An untruncated path wraps and splits mid-word, which
  // both mangles the layout and hides the part being typed.
  const room = Math.max(20, width - 14);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.dim}>{"  " + padEnd(label, 10)}</Text>
        <Text color={theme.figure}>{truncatePath(draft, room)}</Text>
        {/* The cursor only sits on the input line; in the list the highlight
            is the thing that moves. */}
        <Text color={theme.unverified}>{highlight === null ? "▏" : ""}</Text>
      </Box>
      {suggestions.length > 0 ? (
        <Box flexDirection="column">
          <Text color={theme.rule}>{"            " + "─".repeat(Math.max(20, width - 16))}</Text>
          {suggestions.map((s, i) => {
            const on = i === highlight;
            const note = annotate(s, volumes);
            // Budgeted against the 12-column indent, or the note wraps onto a
            // second line and shears the row beneath it. The name keeps what
            // the note does not take; both are truncated to fit.
            const INDENT = 12;
            const noteRoom = note === null ? 0 : Math.min(42, Math.max(14, width - INDENT - 26));
            const nameRoom = Math.max(12, width - INDENT - (note === null ? 0 : noteRoom + 2));
            return (
              <Box key={s}>
                <Text color={on ? theme.figure : theme.dim}>
                  {on ? "          » " : "            "}
                </Text>
                <Text color={on ? theme.figure : theme.dim} bold={on}>
                  {padEnd(truncatePath(s, nameRoom), note === null ? 0 : nameRoom + 2)}
                </Text>
                {note === null ? null : <Text color={theme.rule}>{truncate(note, noteRoom)}</Text>}
              </Box>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
}
