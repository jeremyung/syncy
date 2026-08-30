import { describe, expect, test } from "bun:test";
import { parseItemizeLine, summarize } from "../src/itemize.ts";

describe("parseItemizeLine", () => {
  test("parses a new file", () => {
    const item = parseItemizeLine(">f+++++++++|65103872|IMG_4822.CR3");
    expect(item).not.toBeNull();
    expect(item!.kind).toBe("change");
    expect(item!.bytes).toBe(65_103_872);
    expect(item!.name).toBe("IMG_4822.CR3");
  });

  test("parses a changed file", () => {
    const item = parseItemizeLine(">f.st......|1024|a/b/c.txt");
    expect(item!.kind).toBe("change");
    expect(item!.name).toBe("a/b/c.txt");
  });

  test("parses a directory entry", () => {
    const item = parseItemizeLine("cd+++++++++|96|subdir");
    expect(item!.kind).toBe("change");
    expect(item!.flags[1]).toBe("d");
  });

  test("classifies deletions as extras, not changes", () => {
    const item = parseItemizeLine("*deleting  |0|old/IMG_0001.CR3");
    expect(item!.kind).toBe("extra");
    expect(item!.name).toBe("old/IMG_0001.CR3");
  });

  test("ignores rsync's summary chatter", () => {
    expect(parseItemizeLine("sending incremental file list")).toBeNull();
    expect(parseItemizeLine("")).toBeNull();
    expect(parseItemizeLine("total size is 6  speedup is 0.03 (DRY RUN)")).toBeNull();
  });

  test("keeps filenames containing the delimiter intact", () => {
    const item = parseItemizeLine(">f+++++++++|10|weird|name.txt");
    expect(item!.name).toBe("weird|name.txt");
    expect(item!.bytes).toBe(10);
  });

  test("keeps filenames containing spaces intact", () => {
    const item = parseItemizeLine(">f+++++++++|10|From Desktop/a b c.jpg");
    expect(item!.name).toBe("From Desktop/a b c.jpg");
  });
});

describe("attribute-only entries are not pending changes", () => {
  // Deleting one file at the target moves its parent directory's mtime, so
  // rsync itemizes `.d..t......` for the directory. Counting that as pending
  // made a fully-present unit read as behind, intermittently.
  test("a directory whose timestamp moved is metadata, not a change", () => {
    const item = parseItemizeLine(".d..t......|96|.");
    expect(item!.kind).toBe("metadata");
  });

  test("a file whose attributes differ is metadata, not a change", () => {
    expect(parseItemizeLine(".f...p.....|10|a.txt")!.kind).toBe("metadata");
  });

  test("a transferred file is still a change", () => {
    expect(parseItemizeLine(">f.st......|10|a.txt")!.kind).toBe("change");
    expect(parseItemizeLine(">f+++++++++|10|a.txt")!.kind).toBe("change");
    expect(parseItemizeLine("cd+++++++++|96|d")!.kind).toBe("change");
  });

  test("metadata entries contribute no pending bytes and do not block clean", () => {
    const items = [".d..t......|96|.", ".f...p.....|4096|a.txt"]
      .map(parseItemizeLine)
      .filter((i) => i !== null);
    const s = summarize(items);
    expect(s.nChanges).toBe(0);
    expect(s.nMetadata).toBe(2);
    expect(s.bytesPending).toBe(0);
  });

  test("they are still counted, so a share that cannot hold xattrs is visible", () => {
    // Silently ignoring them would mask the SMB failure mode the probe guards.
    const s = summarize([parseItemizeLine(".f.....x...|10|a.txt")!]);
    expect(s.nMetadata).toBe(1);
  });
});

describe("summarize", () => {
  const lines = [
    ">f+++++++++|1000|a.cr3",
    ">f.st......|2000|b.cr3",
    "cd+++++++++|96|subdir",
    "*deleting  |0|gone.cr3",
    "*deleting  |0|gone2.cr3",
  ];

  test("counts changes and extras separately", () => {
    const items = lines.map(parseItemizeLine).filter((i) => i !== null);
    const s = summarize(items);
    expect(s.nChanges).toBe(3);
    expect(s.nExtra).toBe(2);
  });

  test("counts bytes for files only, not directories", () => {
    const items = lines.map(parseItemizeLine).filter((i) => i !== null);
    // 1000 + 2000; the directory's 96 bytes transfer nothing.
    expect(summarize(items).bytesPending).toBe(3000);
  });

  test("an empty result is clean", () => {
    expect(summarize([])).toEqual({
      nChanges: 0,
      nNew: 0,
      nMetadata: 0,
      nSame: 0,
      nExtra: 0,
      bytesPending: 0,
    });
  });
});
