import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadHistorySnapshot } from "../src/engine-history.ts";
import { appendHistory } from "../src/state.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

let root: string;
afterEach(() => {
  if (root !== undefined) removeFixtureDir(root);
});

describe("engine history snapshot", () => {
  test("keeps literal outcomes and collapses a paired sync start", () => {
    root = makeFixtureDir("syncy-engine-history");
    const file = join(root, "history.jsonl");
    appendHistory(
      {
        ts: 1,
        unit: "photos",
        target: "archive",
        argv: ["--partial-dir=.syncy-partial"],
        exitCode: null,
        log: "/owned/sync.log",
        operation: "sync",
        outcome: "started",
      },
      file,
    );
    appendHistory(
      {
        ts: 2,
        unit: "photos",
        target: "archive",
        argv: ["--partial-dir=.syncy-partial"],
        exitCode: 0,
        log: "/owned/sync.log",
        operation: "sync",
        outcome: "completed",
      },
      file,
    );
    appendHistory(
      {
        ts: 3,
        unit: "audio",
        target: "nas",
        argv: [],
        exitCode: null,
        operation: "deep",
        outcome: "skipped",
        detail: "not connected",
      },
      file,
    );

    expect(loadHistorySnapshot(20, file)).toEqual([
      {
        ts: 3,
        unit: "audio",
        target: "nas",
        operation: "deep",
        outcome: "skipped",
        exitCode: null,
        detail: "not connected",
      },
      {
        ts: 2,
        unit: "photos",
        target: "archive",
        operation: "sync",
        outcome: "completed",
        exitCode: 0,
        log: "/owned/sync.log",
      },
    ]);
  });

  test("a torn line does not hide earlier outcomes", () => {
    root = makeFixtureDir("syncy-engine-history-torn");
    const file = join(root, "history.jsonl");
    appendHistory({ ts: 1, unit: "photos", target: "archive", argv: ["-n"], exitCode: 0 }, file);
    appendFileSync(file, "not-json\n");
    expect(loadHistorySnapshot(20, file)).toHaveLength(1);
  });
});
