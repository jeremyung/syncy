import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { render } from "ink-testing-library";
import { parseConfig, type Config } from "../src/config.ts";
import {
  buildDiff,
  classify,
  diffCounts,
  diffFile,
  loadDiff,
  saveDiff,
  MAX_ENTRIES,
  type Diff as DiffRecord,
} from "../src/diff.ts";
import { parseItemizeLine, type Item } from "../src/itemize.ts";
import { Diff, diffRows, diffText, legendLine, magnitudeLine, pendingBytes, summaryLine, windowFor } from "../src/tui/Diff.tsx";
import { hintLine } from "../src/tui/Ledger.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { displayWidth } from "../src/width.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

/**
 * "504 files pending" is a count, not an answer.
 *
 * These tests hold the differences view to being specific — which files, in
 * which direction, and on rsync's own evidence — because a number alone is the
 * thing the view exists to replace.
 */

const NOW = Date.parse("2026-08-21T12:00:00Z");
const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

const item = (line: string): Item => {
  const it = parseItemizeLine(line);
  if (it === null) throw new Error(`unparsable fixture: ${line}`);
  return it;
};

// Real rsync itemize output shapes.
const NEW_FILE = item(">f+++++++++|4096|holiday/new.jpg");
const CHANGED = item(">f.st......|8192|holiday/edited.jpg");
const META = item(".f....t....|100|holiday/touched.jpg");
const SAME = item(".f         |100|holiday/fine.jpg");
const EXTRA = item("*deleting  |0|holiday/gone.jpg");
const NEW_DIR = item("cd+++++++++|0|holiday/newdir");

const config: Config = parseConfig(`
source = "/src"
[[target]]
name = "external"
path = "/dest/external"
identity = "u1"
[[target]]
name = "NAS"
path = "/dest/nas"
identity = "u2"
`);

describe("classifying a difference in the user's terms", () => {
  test("a file rsync creates from nothing is not at the destination", () => {
    expect(classify(NEW_FILE)).toBe("new");
  });

  test("a file whose content differs is reported as differing, not as new", () => {
    // The distinction matters: `new` means the copy never happened, `changed`
    // means it happened and then the source moved on.
    expect(classify(CHANGED)).toBe("changed");
  });

  test("an attributes-only difference is not content", () => {
    expect(classify(META)).toBe("metadata");
  });

  test("a file only at the destination is an extra", () => {
    expect(classify(EXTRA)).toBe("extra");
  });

  test("an extra is not mistaken for a directory", () => {
    // rsync reports extras as the literal `*deleting`, whose second character
    // is a `d`. Reading that as the type flag labelled every extra file a
    // directory, and claimed a size for something rsync never sized.
    const e = buildDiff("u", "t", "quick", [EXTRA]).entries[0]!;
    expect(e.dir).toBe(false);
    expect(e.sized).toBe(false);
  });

  test("identical files are not differences and are never stored", () => {
    // Under -vv rsync itemizes every file it looks at. Storing those would
    // record the entire tree as a diff.
    expect(classify(SAME)).toBeNull();
    expect(buildDiff("u", "t", "quick", [SAME, SAME, NEW_FILE]).entries).toHaveLength(1);
  });

  test("directories are marked, since they transfer no content", () => {
    const d = buildDiff("u", "t", "quick", [NEW_DIR]);
    expect(d.entries[0]?.dir).toBe(true);
  });

  test("rsync's own itemize string is kept, so the claim is checkable", () => {
    const d = buildDiff("u", "t", "quick", [CHANGED]);
    expect(d.entries[0]?.flags).toBe(">f.st......");
  });
});

describe("the stored diff", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeFixtureDir("syncy-diff");
  });
  afterEach(() => {
    removeFixtureDir(dir);
  });

  test("round-trips through the file", () => {
    const d = buildDiff("holiday-2024", "NAS", "quick", [NEW_FILE, CHANGED, EXTRA], { ts: NOW });
    saveDiff(d, dir);
    expect(loadDiff("holiday-2024", "NAS", dir)).toEqual(d);
  });

  test("a folder never checked reads as null, not as no differences", () => {
    // These are different facts and the view says different things about them.
    expect(loadDiff("never-checked", "NAS", dir)).toBeNull();
  });

  test("a unit name cannot steer the write out of the diff directory", () => {
    // Unit names come from a directory listing, so `..` is attacker-adjacent
    // input even in a personal tool.
    const f = diffFile("../../etc/passwd", "NAS", dir);
    expect(f.startsWith(dir + "/")).toBe(true);
    expect(f).not.toContain("..");
  });

  test("targets with the same unit name do not collide", () => {
    expect(diffFile("u", "external", dir)).not.toBe(diffFile("u", "NAS", dir));
  });

  test("a huge diff is capped and says how many it dropped", () => {
    const many = Array.from({ length: MAX_ENTRIES + 40 }, () => NEW_FILE);
    const d = buildDiff("u", "t", "quick", many);
    expect(d.entries).toHaveLength(MAX_ENTRIES);
    expect(d.truncated).toBe(40);
  });

  test("corrupt json reads as absent rather than throwing", () => {
    saveDiff(buildDiff("u", "t", "quick", [NEW_FILE]), dir);
    Bun.spawnSync(["/bin/sh", "-c", `printf 'not json' > ${JSON.stringify(diffFile("u", "t", dir))}`]);
    expect(loadDiff("u", "t", dir)).toBeNull();
  });

  test("a malformed entry inside an otherwise-valid diff is dropped, not fatal", () => {
    // Diffs are entirely derived and safe to lose, so the treatment is
    // proportionate to state.ts's: the record as a whole is kept and only the
    // one bad entry is dropped, rather than the differences screen crashing on
    // it or the whole diff being discarded like a corrupt file would be.
    const d = buildDiff("u", "t", "quick", [NEW_FILE, CHANGED], { ts: NOW });
    const raw = JSON.parse(JSON.stringify(d)) as { entries: unknown[] };
    raw.entries.push({ kind: "new", name: "no-bytes.jpg" }); // missing bytes/flags/dir/sized
    writeFileSync(diffFile("u", "t", dir), JSON.stringify(raw));
    const loaded = loadDiff("u", "t", dir);
    expect(loaded?.entries).toHaveLength(2);
    expect(loaded?.entries.map((e) => e.name)).toEqual(["holiday/new.jpg", "holiday/edited.jpg"]);
  });
});

describe("the summary line says what was found, or why nothing is shown", () => {
  test("never checked is distinguished from no differences", () => {
    expect(summaryLine(null, NOW)).toContain("never checked");
    expect(summaryLine(buildDiff("u", "t", "deep", [], { ts: NOW }), NOW)).toContain(
      "no differences",
    );
  });

  test("an absent folder says so rather than listing nothing", () => {
    // rsync itemizes nothing when the destination folder does not exist, so an
    // empty entry list here would otherwise read as "all fine".
    const d = buildDiff("u", "t", "quick", [], { ts: NOW, wholeFolderMissing: true });
    expect(summaryLine(d, NOW)).toContain("whole folder is absent");
  });

  test("counts each kind of difference separately", () => {
    const d = buildDiff("u", "t", "quick", [NEW_FILE, CHANGED, CHANGED, META, EXTRA], { ts: NOW });
    const s = summaryLine(d, NOW);
    expect(s).toContain("1 not at destination");
    expect(s).toContain("2 content differs");
    expect(s).toContain("1 attributes differ");
    expect(s).toContain("1 only at destination");
  });

  test("it names the method and the age, so a stale listing is visible", () => {
    const d = buildDiff("u", "t", "deep", [NEW_FILE], { ts: NOW - 5 * 86_400_000 });
    expect(summaryLine(d, NOW)).toContain("deep");
    expect(summaryLine(d, NOW)).toMatch(/5d|5 d/);
  });

  test("counts by kind add up to the entries stored", () => {
    const d = buildDiff("u", "t", "quick", [NEW_FILE, CHANGED, META, EXTRA]);
    const c = diffCounts(d);
    expect(c.new + c.changed + c.metadata + c.extra).toBe(d.entries.length);
  });
});

describe("the differences screen", () => {
  const frame = (
    diffs: ReadonlyMap<string, DiffRecord | null>,
    width = 92,
    height?: number,
  ): string => {
    const { lastFrame } = render(
      <Diff
        config={config}
        unit="holiday-2024"
        diffs={diffs}
        theme={THEMES.ansi}
        width={width}
        {...(height === undefined ? {} : { height })}
        now={NOW}
        onClose={() => {}}
      />,
    );
    return plain(lastFrame());
  };

  const both = new Map<string, DiffRecord | null>([
    ["external", buildDiff("holiday-2024", "external", "quick", [NEW_FILE, CHANGED], { ts: NOW })],
    ["NAS", null],
  ]);

  test("it names the folder being examined", () => {
    expect(frame(both)).toContain("holiday-2024");
  });

  test("every configured destination gets a section, checked or not", () => {
    const out = frame(both);
    expect(out).toContain("external");
    expect(out).toContain("NAS");
  });

  test("it lists the actual filenames, which is the whole point", () => {
    const out = frame(both);
    expect(out).toContain("new.jpg");
    expect(out).toContain("edited.jpg");
  });

  test("it shows rsync's itemize string next to each file", () => {
    expect(frame(both)).toContain(">f+++++++++");
  });

  test("it offers nothing that deletes, and says so", () => {
    const out = frame(both).toLowerCase();
    expect(out).not.toContain("[x] delete");
    expect(out).toContain("nothing here deletes anything");
  });

  test("the legend covers every kind that can appear in the listing", () => {
    const d = buildDiff("holiday-2024", "external", "quick", [NEW_FILE, CHANGED, META, EXTRA], {
      ts: NOW,
    });
    const out = frame(new Map([["external", d], ["NAS", null]]));
    for (const glyph of ["+", "≠", "·", "−"]) expect(out).toContain(glyph);
  });

  test("no line overflows the window", () => {
    const d = buildDiff(
      "holiday-2024",
      "external",
      "quick",
      [item(">f+++++++++|4096|a/very/deeply/nested/path/that/keeps/going/" + "x".repeat(120))],
      { ts: NOW },
    );
    for (const width of [76, 92, 120]) {
      for (const line of frame(new Map([["external", d], ["NAS", null]]), width).split("\n")) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    }
  });

  test("a long listing is scrollable and says where you are in it", () => {
    // It used to show a fixed dozen and hide the other 490 with no way to
    // reach them, which is what made a 504-file folder unreadable.
    const many = Array.from({ length: 200 }, (_, i) =>
      item(`>f+++++++++|100|file-${String(i).padStart(3, "0")}.jpg`),
    );
    const d = buildDiff("holiday-2024", "external", "quick", many, { ts: NOW });
    const out = frame(new Map([["external", d], ["NAS", null]]), 92, 24);
    expect(out).toMatch(/\d+–\d+ of \d+/);
    expect(out).toContain("scroll");
  });

  test("the summary never wraps, which would cost a line of the listing", () => {
    const d = buildDiff("holiday-2024", "external", "quick", [NEW_FILE, CHANGED, META, EXTRA], {
      ts: NOW,
    });
    const out = frame(new Map([["external", d], ["NAS", null]]), 76);
    // A wrapped summary shows as a continuation line with no glyph column.
    const orphan = out.split("\n").find((l) => /^\s{12,}[a-z]/.test(l) && !l.includes("["));
    expect(orphan, `wrapped: ${orphan}`).toBeUndefined();
  });

  test("differences are ordered worst first", () => {
    const d = buildDiff("holiday-2024", "external", "quick", [EXTRA, META, CHANGED, NEW_FILE], {
      ts: NOW,
    });
    const out = frame(new Map([["external", d], ["NAS", null]]));
    expect(out.indexOf("new.jpg")).toBeLessThan(out.indexOf("edited.jpg"));
    expect(out.indexOf("edited.jpg")).toBeLessThan(out.indexOf("touched.jpg"));
    expect(out.indexOf("touched.jpg")).toBeLessThan(out.indexOf("gone.jpg"));
  });

  test("the clipboard text carries the same facts as the screen", () => {
    const text = diffText(config, "holiday-2024", both, NOW);
    expect(text).toContain("holiday-2024");
    expect(text).toContain("new.jpg");
    expect(text).toContain(">f+++++++++");
    expect(text).toContain("never checked");
  });
});

describe("the legend fits the window", () => {
  test("it never wraps, at any width", () => {
    // It wrapped at 76 and Ink split "destination" onto its own line, which
    // silently cost a row of the file listing.
    for (const w of [50, 76, 80, 92, 120]) {
      expect(displayWidth(legendLine(w)), `width ${w}`).toBeLessThanOrEqual(w - 2);
    }
  });

  test("every kind stays in the legend even when the words shrink", () => {
    for (const w of [50, 76, 120]) {
      for (const glyph of ["+", "≠", "·", "−"]) {
        expect(legendLine(w), `width ${w}`).toContain(glyph);
      }
    }
  });

  test("a wide window gets the unabbreviated wording", () => {
    expect(legendLine(120)).toContain("not at destination");
  });
});

describe("the ledger's key hints fit the window they are drawn in", () => {
  test("they never overflow, at any width", () => {
    for (const w of [40, 60, 76, 80, 92, 120, 200]) {
      expect(displayWidth(hintLine(w)), `width ${w}`).toBeLessThanOrEqual(w - 2);
    }
  });

  test("[?] survives even when nothing else fits", () => {
    expect(hintLine(12)).toContain("[?]");
  });

  test("a wide window shows every hint", () => {
    expect(hintLine(120)).toContain("[p]");
    expect(hintLine(120)).toContain("[enter]");
  });

  test("hints are dropped from the least important end", () => {
    // [enter] and the check keys are what the screen is for; [p] is a detour.
    const narrow = hintLine(76);
    expect(narrow).toContain("[enter]");
    expect(narrow).toContain("[q] check");
  });
});

describe("the differences list scrolls", () => {
  const many = Array.from({ length: 300 }, (_, i) =>
    item(`>f+++++++++|1000000|file-${String(i).padStart(3, "0")}.jpg`),
  );
  const big = buildDiff("holiday-2024", "external", "deep", many, { ts: NOW });
  const rows = diffRows(["external", "NAS"], new Map([["external", big], ["NAS", null]]));

  test("every entry is reachable, not just the first screenful", () => {
    // The regression this replaces: a fixed dozen shown and the other 490
    // dropped with no way to reach them.
    expect(rows.filter((r) => r.kind === "entry")).toHaveLength(300);
  });

  test("each destination gets a header in the one flat list", () => {
    expect(rows.filter((r) => r.kind === "header").map((r) => (r as { target: string }).target)).toEqual([
      "external",
      "NAS",
    ]);
  });

  test("the window keeps the cursor on screen", () => {
    for (const cursor of [0, 5, 150, 299, 302]) {
      const w = windowFor(cursor, rows.length, 12);
      expect(cursor, `cursor ${cursor}`).toBeGreaterThanOrEqual(w.start);
      expect(cursor, `cursor ${cursor}`).toBeLessThan(w.end);
    }
  });

  test("the window never runs past either end", () => {
    for (const cursor of [0, 1, rows.length - 1]) {
      const w = windowFor(cursor, rows.length, 12);
      expect(w.start).toBeGreaterThanOrEqual(0);
      expect(w.end).toBeLessThanOrEqual(rows.length);
      expect(w.end - w.start).toBe(12);
    }
  });

  test("a list that fits is not windowed at all", () => {
    expect(windowFor(0, 5, 40)).toEqual({ start: 0, end: 5 });
  });

  test("arrow keys move through the list", async () => {
    const { stdin, lastFrame } = render(
      <Diff config={config} unit="holiday-2024" diffs={new Map([["external", big], ["NAS", null]])}
        theme={THEMES.ansi} width={92} height={20} now={NOW} onClose={() => {}} />,
    );
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 40));
    const before = plain(lastFrame());
    stdin.write("G"); // jump to the end
    await wait();
    const after = plain(lastFrame());
    expect(after).not.toBe(before);
    expect(after).toContain("of");
    stdin.write("g"); // back to the start
    await wait();
    expect(plain(lastFrame())).toContain("1–");
  });
});

describe("the summary states the size of the job", () => {
  test("bytes to copy are totalled, so the cost is visible", () => {
    const d = buildDiff("u", "t", "deep", [NEW_FILE, CHANGED], { ts: NOW });
    expect(summaryLine(d, NOW)).toContain("to copy");
    expect(pendingBytes(d)).toBe(4096 + 8192);
  });

  test("extras and directories are not counted — nothing transfers for them", () => {
    const d = buildDiff("u", "t", "deep", [EXTRA, NEW_DIR, NEW_FILE], { ts: NOW });
    expect(pendingBytes(d)).toBe(4096);
  });

  test("a clean destination claims no size", () => {
    expect(summaryLine(buildDiff("u", "t", "deep", [], { ts: NOW }), NOW)).not.toContain("to copy");
  });
});

describe("the magnitude line gives the listing a denominator", () => {
  const fp = (nfiles: number, b: number) => ({ nfiles, bytes: b, maxMtimeNs: "1" });
  const mk = (source?: ReturnType<typeof fp>, target?: ReturnType<typeof fp> | null): DiffRecord =>
    buildDiff("u", "NAS", "deep", [], {
      ts: NOW,
      ...(source === undefined ? {} : { source }),
      ...(target === undefined ? {} : { target }),
    });

  test("both sides are stated, so 504 has something to be 504 of", () => {
    // "504 not at destination" reads the same whether the folder holds 505
    // files or fifty thousand.
    const line = magnitudeLine(mk(fp(935, 13e9), fp(431, 7.2e9)))!;
    expect(line).toContain("source 935 files");
    expect(line).toContain("destination 431 files");
  });

  test("the shortfall is named in both files and bytes", () => {
    const line = magnitudeLine(mk(fp(935, 13e9), fp(431, 7.2e9)))!;
    expect(line).toContain("504 files short");
    expect(line).toMatch(/gb short/);
  });

  test("a destination holding more is described as extra, not as negative", () => {
    // Extras are never deleted, so a destination can legitimately exceed the
    // source. A signed shortfall rendered this as "short by −12".
    const line = magnitudeLine(mk(fp(900, 10e9), fp(912, 11e9)))!;
    expect(line).toContain("12 files extra");
    expect(line).not.toContain("−");
  });

  test("the mixed case is expressible — fewer files, more bytes", () => {
    const line = magnitudeLine(mk(fp(935, 13e9), fp(900, 14e9)))!;
    expect(line).toContain("35 files short");
    expect(line).toContain("extra");
  });

  test("matching totals say so rather than showing a zero", () => {
    expect(magnitudeLine(mk(fp(935, 13e9), fp(935, 13e9)))).toContain("identical totals");
  });

  test("an unmeasured destination is not reported as empty", () => {
    // A record written before the destination was measured must not read as
    // "destination 0 files", which would be a claim, not an absence.
    const line = magnitudeLine(mk(fp(935, 13e9), null))!;
    expect(line).toContain("not measured");
    expect(line).not.toContain("destination 0");
  });

  test("with nothing measured at all there is no line to show", () => {
    expect(magnitudeLine(mk())).toBeNull();
    expect(magnitudeLine(null)).toBeNull();
  });

  test("it appears on screen beneath its destination's header", () => {
    const d = mk(fp(935, 13e9), fp(431, 7.2e9));
    const rows = diffRows(["NAS"], new Map([["NAS", d]]));
    expect(rows[0]?.kind).toBe("header");
    expect(rows[1]?.kind).toBe("magnitude");
  });

  test("it never overflows the window", () => {
    const d = mk(fp(9_999_999, 999e12), fp(1, 1));
    for (const w of [76, 92, 120]) {
      const { lastFrame } = render(
        <Diff config={config} unit="u" diffs={new Map([["external", d], ["NAS", null]])}
          theme={THEMES.ansi} width={w} height={24} now={NOW} onClose={() => {}} />,
      );
      for (const line of plain(lastFrame()).split("\n")) {
        expect(displayWidth(line), `width ${w}: ${line}`).toBeLessThanOrEqual(w + 2);
      }
    }
  });
});

describe("the footer explains the shift rule", () => {
  test("it names shift rather than showing an unexplained capital", () => {
    // "[q]/[Q] check" required knowing what the capital meant; a reader had to
    // open the help screen to find out that shift widens it to every folder.
    expect(hintLine(92)).toContain("[shift] all");
    expect(hintLine(92)).not.toContain("[Q]");
  });

  test("it survives a narrow window, since it explains two keys at once", () => {
    expect(hintLine(76)).toContain("[shift] all");
  });
});
