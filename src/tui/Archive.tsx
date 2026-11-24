import { Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { type FolderCandidate, folderCandidates, trackFolder } from "../archive-catalog.ts";
import { runPairJob } from "../archive-job.ts";
import type { ArchiveRecord } from "../archive-ledger.ts";
import type { Config } from "../config.ts";
import { stamp } from "../format.ts";
import { loadState, type Method } from "../state.ts";
import { displayWidth, truncate } from "../width.ts";
import { Screen } from "./Screen.tsx";
import type { Theme } from "./theme.ts";

const historicalBlocker = "Destination pair is no longer configured";
export function pairChoices(archive: ArchiveRecord) {
  const pairs = [...archive.pairOptions];
  const keys = new Set(pairs.map((p) => JSON.stringify(p.endpoints)));
  for (const result of archive.pairs) {
    const key = JSON.stringify(result.endpoints);
    if (keys.has(key)) continue;
    keys.add(key);
    pairs.push({ endpoints: result.endpoints, blocker: historicalBlocker });
  }
  return pairs;
}

interface PageProps {
  config: Config;
  width: number;
  height: number;
  theme: Theme;
  onClose: () => void;
}

function fit(text: string, width: number): string {
  return "  " + truncate(text.replace(/\p{Cc}/gu, " "), width - 2);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Count each wrapped line against the scroll window so the full rules and paths
// remain inspectable, including an unbroken filename wider than the terminal.
function wrapDetail(text: string, width: number): string[] {
  const cleaned = text.replace(/\p{Cc}/gu, " ");
  if (displayWidth(cleaned) <= width) return [cleaned];
  const lines: string[] = [];
  let line = "";
  let columns = 0;
  for (const { segment } of graphemes.segment(cleaned)) {
    const advance = displayWidth(segment);
    if (columns + advance > width) {
      // Break at the last space when there is one. Preserve interior spaces in a
      // path exactly, including repeated spaces in a filename.
      const split = line.lastIndexOf(" ");
      if (split > 0) {
        lines.push(line.slice(0, split));
        line = line.slice(split + 1);
        columns = displayWidth(line);
      }
      if (columns + advance > width) {
        lines.push(line);
        line = "";
        columns = 0;
      }
    }
    line += segment;
    columns += advance;
  }
  lines.push(line);
  return lines;
}

function windowStart(cursor: number, length: number, room: number): number {
  return Math.min(Math.max(0, cursor - Math.floor(room / 2)), Math.max(0, length - room));
}

export function FolderPicker({
  config,
  width,
  height,
  theme,
  onClose,
  onChoose,
  onChange,
}: PageProps & {
  onChoose: (unit: string) => void;
  onChange: () => void;
}): React.ReactElement {
  const [candidates, setCandidates] = useState<FolderCandidate[]>([]);
  const [blocked, setBlocked] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [cursor, setCursor] = useState(0);
  const [query, setQuery] = useState("");
  const [editingQuery, setEditingQuery] = useState(false);
  const [discover, setDiscover] = useState(false);
  const [destinations, setDestinations] = useState<string[]>();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [destinationCursor, setDestinationCursor] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation re-reads after a tracking edit or explicit discovery.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setBlocked([]);
    folderCandidates(config, loadState(), discover, destinations ? { destinations } : {})
      .then((result) => {
        if (!live) return;
        setCandidates(result.candidates);
        setBlocked(result.blocked);
        setLoading(false);
      })
      .catch((error) => {
        if (live) {
          setMessage(String(error));
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [config, discover, destinations, generation]);

  // Blockers share the scrollable list so every unreachable root is readable
  // even when the terminal is shorter than the list of destinations.
  const matches = candidates.filter((candidate) =>
    candidate.unit.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const rows = [
    ...matches.map(
      (c) => c.unit + " · " + c.locations.join(", ") + (c.tracked ? " · tracked" : ""),
    ),
    ...blocked.map((detail) => "Could not inspect " + detail),
  ];
  const index = Math.min(cursor, Math.max(0, rows.length - 1));
  const entry = matches[index];
  useInput((input, key) => {
    if (editingQuery) {
      if (key.return) setEditingQuery(false);
      else if (key.escape) {
        setQuery("");
        setEditingQuery(false);
      } else if (key.backspace || key.delete)
        setQuery((previous) =>
          Array.from(graphemes.segment(previous), (g) => g.segment)
            .slice(0, -1)
            .join(""),
        );
      else if (input && !key.ctrl && !key.meta && !/\p{Cc}/u.test(input))
        setQuery((previous) => previous + input);
      setCursor(0);
      return;
    }
    if (draft !== null) {
      const name = config.targets[destinationCursor]?.name;
      if (key.escape) {
        setDraft(null);
        setMessage("");
      } else if (key.upArrow || input === "k")
        setDestinationCursor(Math.max(0, destinationCursor - 1));
      else if (key.downArrow || input === "j")
        setDestinationCursor(Math.min(config.targets.length - 1, destinationCursor + 1));
      else if (input === " " && name) {
        setDraft(draft.includes(name) ? draft.filter((n) => n !== name) : [...draft, name]);
        setMessage("");
      } else if (key.return) {
        if (!draft.length) {
          setMessage("Select at least one destination");
          return;
        }
        setLoading(true);
        setDestinations(draft.length === config.targets.length ? undefined : draft);
        setDiscover(true);
        setGeneration((v) => v + 1);
        setDraft(null);
        setCursor(0);
        setMessage("");
      }
      return;
    }
    if (input === "s") {
      if (!config.targets.length) {
        setMessage("No destinations configured");
        return;
      }
      setDraft(destinations ?? config.targets.map((t) => t.name));
      setDestinationCursor(0);
      setMessage("");
      return;
    }
    if (input === "/") {
      setEditingQuery(true);
      setMessage("");
      return;
    }
    if (key.escape) return onClose();
    if (input === "f") {
      setLoading(true);
      setDiscover(true);
      setGeneration((v) => v + 1);
      setMessage("");
      return;
    }
    if (loading) return;
    if (!rows.length) return;
    if (key.upArrow || input === "k") setCursor(Math.max(0, index - 1));
    else if (key.downArrow || input === "j") setCursor(Math.min(rows.length - 1, index + 1));
    else if ((key.return || input === "x") && entry) {
      try {
        if (input === "x") {
          if (!entry.tracked) {
            setMessage(entry.unit + " is already outside the ledger");
            return;
          }
          trackFolder(config, entry.unit, false);
          setMessage("Stopped tracking " + entry.unit + " · history retained");
          onChange();
          setGeneration((v) => v + 1);
        } else {
          if (!entry.tracked) trackFolder(config, entry.unit);
          onChoose(entry.unit);
        }
      } catch (error) {
        setMessage(String(error));
      }
    }
  });

  const room = Math.max(1, height - 7);
  if (draft !== null) {
    const start = windowStart(destinationCursor, config.targets.length, room);
    return (
      <Screen
        title="syncy · find on destinations"
        {...{ width, height, theme }}
        footer={
          <Text color={theme.dim}>
            {fit("[↑ ↓] select   [space] toggle   [enter] find   [esc] back", width)}
          </Text>
        }
      >
        <Text color={theme.figure}>{fit("Choose destinations to inspect", width)}</Text>
        {config.targets.slice(start, start + room).map((target, i) => (
          <Text
            key={target.name}
            color={destinationCursor === start + i ? theme.figure : theme.dim}
          >
            {fit(
              (destinationCursor === start + i ? "» " : "  ") +
                (draft.includes(target.name) ? "[x] " : "[ ] ") +
                target.name,
              width,
            )}
          </Text>
        ))}
        <Text color={theme.dim}>
          {fit(
            message || draft.length + " of " + config.targets.length + " destinations selected",
            width,
          )}
        </Text>
      </Screen>
    );
  }
  const start = windowStart(index, rows.length, room);
  const action = entry?.tracked
    ? "open folder"
    : entry?.remembered
      ? "resume tracking"
      : "track folder";
  return (
    <Screen
      title="syncy · add folder"
      {...{ width, height, theme }}
      footer={
        <>
          <Text color={theme.dim}>
            {fit(
              editingQuery
                ? "[enter] apply filter   [esc] clear filter"
                : "[↑ ↓] select   [enter] " + action + "   [f] find on destinations",
              width,
            )}
          </Text>
          <Text color={theme.dim}>
            {fit("[s] choose destinations   [/] filter   [x] stop tracking   [esc] ledger", width)}
          </Text>
        </>
      }
    >
      <Text color={theme.figure}>
        {fit(
          query || editingQuery
            ? "Find folder · " + query
            : discover
              ? "Remembered folders and copies on " +
                (destinations?.join(", ") ?? "all destinations")
              : "Remembered folders",
          width,
        )}
      </Text>
      {loading ? (
        <Text>
          {fit(discover ? "Identifying destinations…" : "Reading remembered folders…", width)}
        </Text>
      ) : rows.length === 0 ? (
        <Text>
          {fit(
            query
              ? "No matching folders"
              : discover
                ? "No folders found on the inspected destinations"
                : "No remembered folders · press f to find copies",
            width,
          )}
        </Text>
      ) : (
        rows.slice(start, start + room).map((line, i) => (
          <Text key={start + i} color={start + i === index ? theme.figure : theme.dim}>
            {fit((start + i === index ? "» " : "  ") + line, width)}
          </Text>
        ))
      )}
      <Text color={theme.dim}>
        {fit(message || (rows.length > room ? index + 1 + " of " + rows.length : ""), width)}
      </Text>
    </Screen>
  );
}

export function PairView({
  config,
  width,
  height,
  theme,
  onClose,
  archive,
  unit,
  selectedPair,
  onSelectPair,
  refresh,
  initialMethod,
  compare = runPairJob,
}: PageProps & {
  unit: string;
  archive: ArchiveRecord;
  selectedPair: readonly string[] | undefined;
  onSelectPair: (pair: readonly string[]) => void;
  refresh: () => void;
  initialMethod?: Method;
  compare?: typeof runPairJob;
}): React.ReactElement {
  const pairs = useMemo(() => pairChoices(archive), [archive]);
  const preferredIndex = pairs.findIndex((p) =>
    p.endpoints.every((name, i) => name === selectedPair?.[i]),
  );
  const [choosing, setChoosing] = useState(
    pairs.length > 1 && archive.pairOptions.length !== 1 && preferredIndex < 0,
  );
  const [index, setIndex] = useState(Math.max(0, preferredIndex));
  const [pending, setPending] = useState<Method | undefined>(initialMethod);
  const [scroll, setScroll] = useState(0);
  const [phase, setPhase] = useState("");
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState("");
  const abort = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (started === null) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [started]);
  const option = pairs[index];
  const pair = option?.endpoints;
  const run = async (method: Method) => {
    if (!pair) {
      setMessage("Add a second destination to compare copies");
      return;
    }
    if (option.blocker) {
      setMessage(option.blocker);
      return;
    }
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setPending(undefined);
    setStarted(Date.now());
    setNow(Date.now());
    setPhase("checking destinations");
    setMessage("");
    try {
      const result = await compare(config, unit, pair, method, {
        actor: "cli",
        signal: controller.signal,
        onEvent(event) {
          if (mounted.current && event.type === "job.phase-changed")
            setPhase(event.phase.replaceAll("-", " "));
        },
      });
      if (mounted.current) setMessage(result.detail);
    } catch (error) {
      if (mounted.current)
        setMessage(controller.signal.aborted ? "Comparison cancelled" : String(error));
    } finally {
      abort.current = null;
      if (mounted.current) {
        setStarted(null);
        refresh();
        setScroll(0);
      }
    }
  };
  const lines = useMemo(() => {
    const details: string[] = [];
    if (choosing) {
      details.push(
        ...pairs.map(
          (p, i) =>
            (i === index ? "» " : "  ") +
            p.endpoints.join(" ↔ ") +
            (p.blocker ? " · " + p.blocker : ""),
        ),
      );
    } else {
      const results = archive.pairs.filter((p) =>
        p.endpoints.every((name, i) => name === pair?.[i]),
      );
      if (!option) details.push("Add a second destination to compare copies");
      if (option?.blocker) details.push(option.blocker);
      if (option && !results.length) details.push("These copies have not been compared");
      for (const result of results) {
        details.push(
          (result.current ? "" : "Historical · ") + result.method + " · " + stamp(result.at),
          result.detail,
        );
      }
      if (!archive.localChecks.length) details.push("Local verification · no dated result");
      for (const check of archive.localChecks)
        details.push("Last verified against local · " + check.target + " · " + stamp(check.at));
      for (const result of results) {
        details.push(result.method + " rules · " + result.comparisonRules);
        if (!result.samples.length) continue;
        const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
        details.push(
          result.method + " differences · " + result.samples.length + " shown of " + total,
        );
        details.push(...result.samples.map((item) => item.kind + " · " + item.name));
      }
    }
    return choosing ? details : details.flatMap((line) => wrapDetail(line, width - 2));
  }, [archive, choosing, index, option, pair, pairs, width]);
  // Two header rows, three lines of content chrome and two footer rows.
  const room = Math.max(1, height - 8);
  const start = choosing
    ? windowStart(index, lines.length, room)
    : Math.min(scroll, Math.max(0, lines.length - room));
  useInput((input, key) => {
    if (abort.current) {
      if (key.escape || (key.ctrl && input === "c")) {
        abort.current.abort();
        setPhase("cancelling");
      }
      return;
    }
    if (key.escape || (key.ctrl && input === "c")) return onClose();
    if (choosing) {
      if (key.downArrow || input === "j") setIndex((v) => Math.min(v + 1, pairs.length - 1));
      else if (key.upArrow || input === "k") setIndex((v) => Math.max(0, v - 1));
      else if (key.return && pair) {
        onSelectPair(pair);
        setChoosing(false);
        setScroll(0);
        setMessage("");
      }
      return;
    }
    if (input === "r") {
      refresh();
      setMessage("");
    } else if (input === "c" && pairs.length > 1) {
      setChoosing(true);
      setMessage("");
    } else if (key.downArrow || input === "j")
      setScroll(Math.min(start + 1, Math.max(0, lines.length - room)));
    else if (key.upArrow || input === "k") setScroll(Math.max(0, start - 1));
    else if (input === "d" || input === "q") void run(input === "d" ? "deep" : "quick");
    else if (key.return && pending) void run(pending);
  });
  const hint =
    started !== null
      ? "[esc] cancel comparison"
      : choosing
        ? "[↑ ↓] choose pair   [enter] select   [esc] ledger"
        : option?.blocker === historicalBlocker
          ? "[r] refresh   [esc] ledger"
          : (pending ? "[enter] " + pending + " check   " : "") +
            "[q] quick   [d] deep   [r] refresh   [esc] ledger";
  return (
    <Screen
      title="syncy · compare copies"
      {...{ width, height, theme }}
      footer={
        <>
          <Text color={theme.dim}>
            {fit(
              !choosing && started === null
                ? [
                    pairs.length > 1 ? "[c] change pair" : "",
                    lines.length > room ? "[↑ ↓] scroll" : "",
                    lines.length > room
                      ? start +
                        1 +
                        "–" +
                        Math.min(lines.length, start + room) +
                        " of " +
                        lines.length
                      : "",
                  ]
                    .filter(Boolean)
                    .join("   ")
                : "",
              width,
            )}
          </Text>
          <Text color={theme.dim}>{fit(hint, width)}</Text>
        </>
      }
    >
      <Text color={theme.figure}>{fit(unit + " · " + archive.label, width)}</Text>
      <Text color={theme.figure}>
        {fit(
          choosing ? "Choose two destinations" : (pair?.join(" ↔ ") ?? "Destination copies"),
          width,
        )}
      </Text>
      {lines.slice(start, start + room).map((line, i) => (
        <Text key={start + i}>{fit(line, width)}</Text>
      ))}
      <Text color={theme.unverified}>
        {fit(
          started === null
            ? message
            : phase + " · " + Math.max(0, Math.floor((now - started) / 1000)) + "s elapsed",
          width,
        )}
      </Text>
    </Screen>
  );
}
