import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseItemizeLine, parseMtime } from "../src/itemize.ts";
import {
  ageAgainstSync,
  ageBucket,
  buildDiff,
  folderOf,
  groupDiff,
  splitBySync,
  typeOf,
  type DiffEntry,
} from "../src/diff.ts";
import { lastSyncAt } from "../src/state.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";
import { render } from "ink-testing-library";
import {
  Diff,
  diffRows,
  groupDetail,
  lagLine,
  selectableRows,
  snapTo,
  syncLine,
} from "../src/tui/Diff.tsx";
import { THEMES } from "../src/tui/theme.ts";

/**
 * The differences screen could not answer the question it existed for: whether
 * a missing file is a backlog or a gap. Nothing recorded when a file was
 * written, so every difference looked alike and 504 of them looked like one
 * undifferentiated wall. These cover the time dimension that fixes that.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2024, 1, 20, 12, 0, 0);

const entry = (over: Partial<DiffEntry> = {}): DiffEntry => ({
  kind: "new",
  name: "a.jpg",
  bytes: 100,
  flags: ">f+++++++++",
  dir: false,
  sized: true,
  ...over,
});

describe("rsync's %M gives every difference a date", () => {
  test("a timestamp field is read as local time", () => {
    const ms = parseMtime("2024/02/14-09:30:00");
    expect(ms).not.toBeNull();
    const d = new Date(ms!);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2024, 1, 14, 9]);
  });

  test("the epoch means no timestamp, not the first second of 1970", () => {
    // Every `*deleting` line carries it: there is no source file to date.
    expect(parseMtime("1970/01/01-00:00:00")).toBeNull();
    expect(parseItemizeLine("*deleting  |0|1969/12/31-16:00:00|old/a.jpg")!.mtime).toBeNull();
  });

  test("a four-field line yields the date and the name", () => {
    const it = parseItemizeLine(">f+++++++++|65103872|2024/02/14-09:30:00|IMG_4822.CR3")!;
    expect(it.name).toBe("IMG_4822.CR3");
    expect(it.bytes).toBe(65_103_872);
    expect(it.mtime).not.toBeNull();
  });

  test("a line written before %M was asked for still parses, undated", () => {
    // A stored log replayed after an upgrade must not read as a parse failure.
    const it = parseItemizeLine(">f+++++++++|10|a/b/c.txt")!;
    expect(it.name).toBe("a/b/c.txt");
    expect(it.mtime).toBeNull();
  });

  test("a name containing the delimiter survives both formats", () => {
    // rsync does not escape `|`, so the timestamp's shape is what separates a
    // third field from the first pipe inside a filename.
    expect(parseItemizeLine(">f+++++++++|10|weird|name.txt")!.name).toBe("weird|name.txt");
    expect(parseItemizeLine(">f+++++++++|10|2024/02/14-09:30:00|weird|name.txt")!.name).toBe(
      "weird|name.txt",
    );
  });

  test("the date reaches the stored diff", () => {
    const items = [parseItemizeLine(">f+++++++++|10|2024/02/14-09:30:00|a.jpg")!];
    expect(buildDiff("u", "t", "quick", items).entries[0]!.mtime).not.toBeUndefined();
  });
});

describe("when a sync last landed", () => {
  const made: string[] = [];
  const write = (body: string): string => {
    const dir = makeFixtureDir("history");
    made.push(dir);
    const file = join(dir, "history.jsonl");
    writeFileSync(file, body);
    return file;
  };
  const history = (lines: readonly object[]): string =>
    write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  afterAll(() => {
    for (const d of made) removeFixtureDir(d);
  });

  test("the newest successful sync for that unit and destination wins", () => {
    const f = history([
      { ts: 100, unit: "u", target: "ext", argv: [], exitCode: 0 },
      { ts: 300, unit: "u", target: "ext", argv: [], exitCode: 0 },
      { ts: 200, unit: "u", target: "ext", argv: [], exitCode: 0 },
    ]);
    expect(lastSyncAt("u", "ext", f)).toBe(300);
  });

  test("another unit or another destination is not this one's sync", () => {
    const f = history([
      { ts: 900, unit: "other", target: "ext", argv: [], exitCode: 0 },
      { ts: 800, unit: "u", target: "nas", argv: [], exitCode: 0 },
      { ts: 100, unit: "u", target: "ext", argv: [], exitCode: 0 },
    ]);
    expect(lastSyncAt("u", "ext", f)).toBe(100);
  });

  test("a failed run is not a sync that landed", () => {
    const f = history([
      { ts: 100, unit: "u", target: "ext", argv: [], exitCode: 0 },
      { ts: 500, unit: "u", target: "ext", argv: [], exitCode: 23 },
    ]);
    expect(lastSyncAt("u", "ext", f)).toBe(100);
  });

  test("exit 24 counts, as it does everywhere else", () => {
    // Files vanishing mid-run is routine on a live archive and does not mean
    // nothing was copied.
    const f = history([{ ts: 500, unit: "u", target: "ext", argv: [], exitCode: 24 }]);
    expect(lastSyncAt("u", "ext", f)).toBe(500);
  });

  test("a torn last line does not hide every sync before it", () => {
    const good = JSON.stringify({ ts: 7, unit: "u", target: "ext", argv: [], exitCode: 0 });
    expect(lastSyncAt("u", "ext", write(`${good}\n{"ts":8,`))).toBe(7);
  });

  test("never synced reads as never, not as the epoch", () => {
    const dir = makeFixtureDir("history");
    made.push(dir);
    expect(lastSyncAt("u", "ext", join(dir, "no-history-here.jsonl"))).toBeNull();
  });
});

describe("which side of the last sync a missing file falls on", () => {
  const LAST = NOW - 7 * DAY;

  test("written since the sync is a backlog; written before it is a gap", () => {
    expect(ageAgainstSync(entry({ mtime: NOW - DAY }), LAST)).toBe("since");
    expect(ageAgainstSync(entry({ mtime: NOW - 30 * DAY }), LAST)).toBe("before");
  });

  test("no date and no sync are both undated, never guessed", () => {
    expect(ageAgainstSync(entry(), LAST)).toBe("undated");
    expect(ageAgainstSync(entry({ mtime: NOW }), null)).toBe("undated");
  });

  test("only files a sync would copy are split", () => {
    // An extra is at the destination and an attribute difference is at both;
    // neither is waiting to be copied, so neither belongs in the count.
    const d = buildDiff("u", "t", "quick", [], {});
    const withEntries = {
      ...d,
      entries: [
        entry({ mtime: NOW - DAY }),
        entry({ kind: "changed", name: "b.jpg", mtime: NOW - 30 * DAY }),
        entry({ kind: "extra", name: "c.jpg", sized: false }),
        entry({ kind: "metadata", name: "d.jpg", mtime: NOW - 30 * DAY }),
      ],
    };
    expect(splitBySync(withEntries, LAST)).toEqual({
      since: 1,
      before: 1,
      undated: 0,
      lastSyncTs: LAST,
    });
  });

  test("both sides of the sync are one finding, on one line", () => {
    // Two lines each opening with a number read as two separate findings. It is
    // one finding with a split in it.
    const lines = syncLine({ since: 498, before: 6, undated: 0, lastSyncTs: LAST }, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("6 predate");
    expect(lines[0]).toContain("498 after");
  });

  test("the totals above are not restated here", () => {
    // The summary line already says 504. The only new fact is where the line
    // falls, and a screen this narrow cannot afford to say anything twice.
    expect(syncLine({ since: 498, before: 6, undated: 0, lastSyncTs: LAST }, NOW)[0]).not.toContain(
      "504",
    );
  });

  test("the split line stays inside a narrow window", () => {
    for (const split of [
      { since: 498, before: 6, undated: 2, lastSyncTs: LAST },
      { since: 0, before: 504, undated: 0, lastSyncTs: LAST },
      { since: 504, before: 0, undated: 0, lastSyncTs: LAST },
    ]) {
      const line = syncLine(split, NOW)[0]!;
      expect(line.length, line).toBeLessThanOrEqual(76);
    }
  });

  test("the gap is hedged, because an import preserves old dates", () => {
    // A preserved mtime can make a genuinely new file look old, so the wording
    // says which side of the line a file falls on and claims nothing further.
    const line = syncLine({ since: 0, before: 6, undated: 0, lastSyncTs: LAST }, NOW)[0]!;
    expect(line).toContain("imports preserve dates");
    expect(line).not.toContain("failed");
  });

  test("the caveat is dropped when nothing is on the older side of the line", () => {
    // It explains a number that is not on screen; unqualified, it is filler.
    expect(syncLine({ since: 6, before: 0, undated: 0, lastSyncTs: LAST }, NOW)[0]).not.toContain(
      "imports",
    );
  });

  test("before any sync has run, nothing is called a gap", () => {
    const lines = syncLine({ since: 0, before: 0, undated: 9, lastSyncTs: null }, NOW).join("\n");
    expect(lines).toContain("no sync has run here yet");
    expect(lines).not.toContain("predate");
  });

  test("nothing pending says nothing at all", () => {
    expect(syncLine({ since: 0, before: 0, undated: 0, lastSyncTs: LAST }, NOW)).toEqual([]);
  });
});

describe("how far behind the destination is", () => {
  const fp = (ms: number) => ({ nfiles: 1, bytes: 1, maxMtimeNs: String(BigInt(ms) * 1_000_000n) });
  const diff = (here: number, there: number) => ({
    ...buildDiff("u", "t", "quick", []),
    sourceHolds: fp(here),
    targetHolds: fp(there),
  });

  test("it names both dates and the gap between them", () => {
    const line = lagLine(diff(NOW, NOW - 11 * DAY))!;
    expect(line).toContain("newest here");
    expect(line).toContain("there");
    expect(line).toContain("11 days behind");
    expect(line.length, line).toBeLessThanOrEqual(76);
  });

  test("one day is not 1 days", () => {
    expect(lagLine(diff(NOW, NOW - DAY))).toContain("1 day behind");
  });

  test("a destination holding the newest file is not reported as behind", () => {
    expect(lagLine(diff(NOW, NOW))).not.toContain("behind");
  });

  test("a record without both fingerprints says nothing rather than guessing", () => {
    expect(lagLine(buildDiff("u", "t", "quick", []))).toBeNull();
    expect(lagLine(null)).toBeNull();
  });

  test("a hand-edited fingerprint does not crash the screen", () => {
    const d = { ...buildDiff("u", "t", "quick", []), sourceHolds: { nfiles: 1, bytes: 1, maxMtimeNs: "banana" }, targetHolds: fp(NOW) };
    expect(lagLine(d)).toBeNull();
  });
});

describe("the listing has a shape", () => {
  const shoot = (dir: string, n: number, ext: string, ts: number): DiffEntry[] =>
    Array.from({ length: n }, (_, i) =>
      entry({ name: `${dir}/DSC_${String(1000 + i)}${ext}`, mtime: ts, bytes: 6_000_000 }),
    );

  test("folders are read off the names", () => {
    expect(folderOf("2024/02-hokkaido/DSC_1895.NEF")).toBe("2024/02-hokkaido");
    expect(folderOf("top.jpg")).toBe("");
  });

  test("types are read off the names, case-folded", () => {
    expect(typeOf(entry({ name: "a/DSC_1.NEF" }))).toBe(".nef");
    expect(typeOf(entry({ name: "a/Makefile" }))).toBe("");
    expect(typeOf(entry({ name: "a/dir", dir: true }))).toBe("");
  });

  test("age buckets are coarse enough that a shoot lands in one", () => {
    expect(ageBucket(NOW - 3600_000, NOW)).toBe("today");
    expect(ageBucket(NOW - 3 * DAY, NOW)).toBe("this week");
    expect(ageBucket(NOW - 300 * DAY, NOW)).toBe("this year");
    expect(ageBucket(NOW - 800 * DAY, NOW)).toBe("older");
    expect(ageBucket(undefined, NOW)).toBe("undated");
  });

  test("one import becomes one group, not four hundred rows", () => {
    const entries = [
      ...shoot("2024/02-hokkaido", 200, ".NEF", NOW - DAY),
      ...shoot("2024/02-hokkaido", 200, ".JPG", NOW - DAY),
    ];
    const groups = groupDiff(entries, "folder", NOW - 30 * DAY, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toHaveLength(400);
    expect(groups[0]!.types.map(([e]) => e).sort()).toEqual([".jpg", ".nef"]);
  });

  test("a group states how many, how big, of what and from when", () => {
    const groups = groupDiff(shoot("shoot", 30, ".NEF", NOW - DAY), "folder", NOW - 30 * DAY, NOW);
    const detail = groupDetail(groups[0]!);
    expect(detail).toContain("30 files");
    expect(detail).toContain(".nef 30");
    expect(detail).toContain("all created new");
  });

  test("a shared itemize string is stated once, not thirty times", () => {
    const groups = groupDiff(shoot("shoot", 30, ".NEF", NOW - DAY), "folder", NOW - 30 * DAY, NOW);
    expect(groups[0]!.flags).toBe(">f+++++++++");
    expect(groupDetail(groups[0]!)).toContain(">f+++++++++");
  });

  test("a group whose rows disagree keeps the column on the rows", () => {
    const mixed = [entry({ name: "d/a.jpg" }), entry({ name: "d/b.jpg", flags: ">f.st......" })];
    expect(groupDiff(mixed, "folder", null, NOW)[0]!.flags).toBeNull();
  });

  test("files that predate the sync are their own group, not buried in the backlog", () => {
    // The whole point: six files that should already be there cannot hide
    // inside five hundred that are merely waiting.
    const entries = [
      ...shoot("2024/02-hokkaido", 400, ".NEF", NOW - DAY),
      ...shoot("2023/12-family", 6, ".JPG", NOW - 300 * DAY),
    ];
    const groups = groupDiff(entries, "folder", NOW - 30 * DAY, NOW);
    expect(groups[0]!.before).toBe(true);
    expect(groups[0]!.entries).toHaveLength(6);
    expect(groupDetail(groups[0]!)).toContain("predates the last sync");
  });

  test("the group and the split line use one word for one idea", () => {
    // "older than" on the group and "predate" on the line above it read as two
    // different findings about the same six files.
    const entries = shoot("old", 3, ".JPG", NOW - 300 * DAY);
    const detail = groupDetail(groupDiff(entries, "folder", NOW - 30 * DAY, NOW)[0]!, NOW);
    const line = syncLine({ since: 0, before: 3, undated: 0, lastSyncTs: NOW - 30 * DAY }, NOW)[0]!;
    expect(detail).toContain("predates");
    expect(line).toContain("predate");
  });

  test("a gap outranks a backlog however much larger the backlog is", () => {
    const entries = [
      ...shoot("bulk", 500, ".NEF", NOW - DAY),
      ...shoot("old", 1, ".JPG", NOW - 300 * DAY),
    ];
    const [first] = groupDiff(entries, "folder", NOW - 30 * DAY, NOW);
    expect(first!.label).toBe("old");
  });

  test("a content difference outranks a backlog, whatever the legend's order says", () => {
    const entries = [
      ...shoot("bulk", 500, ".NEF", NOW - DAY),
      entry({ kind: "changed", name: "x/edited.jpg", flags: ">f.st......", mtime: NOW - DAY }),
    ];
    const [first] = groupDiff(entries, "folder", NOW - 30 * DAY, NOW);
    expect(first!.kind).toBe("changed");
  });

  test("extras sink to the bottom, since syncy never acts on them", () => {
    const entries = [
      entry({ kind: "extra", name: "x/gone.jpg", sized: false }),
      ...shoot("bulk", 20, ".NEF", NOW - DAY),
    ];
    const groups = groupDiff(entries, "folder", NOW - 30 * DAY, NOW);
    expect(groups[groups.length - 1]!.kind).toBe("extra");
  });

  test("kinds never share a group, because they are unrelated facts", () => {
    const entries = [
      entry({ name: "d/a.jpg", mtime: NOW - DAY }),
      entry({ kind: "changed", name: "d/b.jpg", flags: ">f.st......", mtime: NOW - DAY }),
    ];
    expect(groupDiff(entries, "folder", NOW - 30 * DAY, NOW)).toHaveLength(2);
  });

  test("grouping by type cuts across folders", () => {
    const entries = [
      ...shoot("a", 5, ".NEF", NOW - DAY),
      ...shoot("b", 5, ".NEF", NOW - DAY),
      ...shoot("b", 3, ".JPG", NOW - DAY),
    ];
    const groups = groupDiff(entries, "type", NOW - 30 * DAY, NOW);
    expect(groups.map((g) => g.label).sort()).toEqual([".jpg", ".nef"]);
    expect(groups.find((g) => g.label === ".nef")!.entries).toHaveLength(10);
  });

  test("grouping by age puts a shoot in one bucket", () => {
    const entries = [
      ...shoot("a", 5, ".NEF", NOW - 2 * DAY),
      ...shoot("b", 5, ".NEF", NOW - 200 * DAY),
    ];
    const labels = groupDiff(entries, "age", null, NOW).map((g) => g.label);
    expect(labels).toContain("this week");
    expect(labels).toContain("this year");
  });

  test("every entry lands in exactly one group, whatever the grouping", () => {
    const entries = [
      ...shoot("a", 7, ".NEF", NOW - 2 * DAY),
      ...shoot("b", 4, ".JPG", NOW - 200 * DAY),
      entry({ kind: "extra", name: "c/gone.jpg", sized: false }),
    ];
    for (const by of ["folder", "type", "age"] as const) {
      const groups = groupDiff(entries, by, NOW - 30 * DAY, NOW);
      const total = groups.reduce((n, g) => n + g.entries.length, 0);
      expect(total, `by ${by}`).toBe(entries.length);
    }
  });
});

describe("opening a group and changing the grouping", () => {
  const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");
  const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
  const config = {
    source: "/src",
    targets: [{ name: "ext", path: "/ext", required: true, modifyWindow: 0, flagsDrop: [] }],
    exclude: [],
  } as never;

  const many = Array.from({ length: 60 }, (_, i) =>
    entry({ name: `shoot/DSC_${String(1000 + i)}.NEF`, mtime: NOW - DAY, bytes: 17_000_000 }),
  );
  const diff = { ...buildDiff("u", "ext", "quick", []), entries: many };

  const screen = () =>
    render(
      <Diff
        config={config}
        unit="u"
        diffs={new Map([["ext", diff]])}
        lastSync={new Map([["ext", NOW - 30 * DAY]])}
        theme={THEMES.ansi}
        width={110}
        height={30}
        now={NOW}
        onClose={() => {}}
      />,
    );

  test("a group past the threshold opens closed, and enter opens it", async () => {
    const { stdin, lastFrame } = screen();
    expect(plain(lastFrame())).not.toContain("DSC_1000.NEF");
    stdin.write("j"); // off the destination header, onto the group
    await wait();
    stdin.write("j");
    await wait();
    stdin.write("\r");
    await wait();
    expect(plain(lastFrame())).toContain("DSC_1000.NEF");
  });

  test("[b] cycles the grouping and says which one is showing", async () => {
    const { stdin, lastFrame } = screen();
    expect(plain(lastFrame())).toContain("by folder");
    stdin.write("b");
    await wait();
    expect(plain(lastFrame())).toContain("by type");
    stdin.write("b");
    await wait();
    expect(plain(lastFrame())).toContain("by age");
    stdin.write("b");
    await wait();
    const flat = plain(lastFrame());
    expect(flat).toContain("by flat");
    // Flat is the original listing: one row per file, no headers.
    expect(flat).toContain("DSC_1000.NEF");
  });

  test("the grouping wraps back round rather than sticking at the end", async () => {
    const { stdin, lastFrame } = screen();
    for (let i = 0; i < 4; i++) {
      stdin.write("b");
      await wait();
    }
    expect(plain(lastFrame())).toContain("by folder");
  });
});

describe("the cursor lands only on things that can show they are selected", () => {
  const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");
  const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
  const config = {
    source: "/src",
    targets: [{ name: "ext", path: "/ext", required: true, modifyWindow: 0, flagsDrop: [] }],
    exclude: [],
  } as never;

  const many = Array.from({ length: 40 }, (_, i) =>
    entry({ name: `shoot/DSC_${String(1000 + i)}.NEF`, mtime: NOW - DAY, bytes: 17_000_000 }),
  );
  const diff = {
    ...buildDiff("u", "ext", "quick", []),
    entries: [...many, entry({ name: "loose.jpg", mtime: NOW - DAY })],
    sourceHolds: { nfiles: 41, bytes: 1, maxMtimeNs: String(BigInt(NOW) * 1_000_000n) },
    targetHolds: { nfiles: 0, bytes: 0, maxMtimeNs: String(BigInt(NOW - 9 * DAY) * 1_000_000n) },
  };
  const rows = diffRows(["ext"], new Map([["ext", diff]]), {
    lastSync: new Map([["ext", NOW - 30 * DAY]]),
    now: NOW,
  });

  test("statements are not targets", () => {
    // The header, the totals, the lag line and the sync split are things the
    // screen says, not things a cursor visits.
    const kinds = new Set(selectableRows(rows).map((i) => rows[i]!.kind));
    expect([...kinds].sort()).toEqual(["entry", "group"]);
  });

  test("there is prose above the first selectable row", () => {
    // Which is exactly why the cursor used to look dead: several presses moved
    // through lines that had no way to show they were selected.
    expect(selectableRows(rows)[0]).toBeGreaterThan(0);
  });

  test("a cursor left on a rebuilt list snaps forward, never off the end", () => {
    const sel = selectableRows(rows);
    expect(sel).toContain(snapTo(sel, 0));
    expect(snapTo(sel, 0)).toBe(sel[0]!);
    expect(snapTo(sel, rows.length + 99)).toBe(sel[sel.length - 1]!);
    expect(snapTo([], 5)).toBe(0);
  });

  test("one press moves the selection, with nothing dead in between", async () => {
    const { stdin, lastFrame } = render(
      <Diff
        config={config}
        unit="u"
        diffs={new Map([["ext", diff]])}
        lastSync={new Map([["ext", NOW - 30 * DAY]])}
        theme={THEMES.ansi}
        width={110}
        height={30}
        now={NOW}
        onClose={() => {}}
      />,
    );
    const marked = (s: string): string =>
      s.split("\n").find((l) => l.trimStart().startsWith("»")) ?? "";
    const first = marked(plain(lastFrame()));
    expect(first, "something is marked before any key is pressed").not.toBe("");
    stdin.write("j");
    await wait();
    expect(marked(plain(lastFrame()))).not.toBe(first);
  });
});
