import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEngineMessage } from "../src/protocol-jsonl.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "fixtures", "ui-contract", name), "utf8").trim();

describe("cross-platform UI contract", () => {
  test("snapshot carries canonical language and file-only counts", () => {
    const message = parseEngineMessage(fixture("snapshot.json"));
    expect(message.type).toBe("snapshot");
    if (message.type !== "snapshot") return;
    expect(message.targets[1]?.reachabilityPhrase).toBe("different volume");
    expect(message.units[0]?.cells[1]?.differenceSummary).toBe("2 files not copied yet");
    expect(message.units[0]?.cells[1]?.nFiles).toBe(2);
    expect(message.units[0]?.cells[0]?.evidence?.lastCheck).toMatchObject({
      method: "deep",
      durationMs: 42_000,
    });
    expect(message.activeJob).toMatchObject({
      actor: "scheduler",
      estimatedDurationMs: 42_000,
      batchPosition: 2,
      batchTotal: 4,
      activity: { phase: "comparing-content", lastItem: "rsync started" },
    });
  });

  test("difference provenance and labels survive the wire", () => {
    const message = parseEngineMessage(fixture("diff.json"));
    expect(message.type).toBe("diff");
    if (message.type !== "diff") return;
    expect(message.provenance?.current).toBe(false);
    expect(message.provenance).toMatchObject({ identityMatches: false, reachability: "mismatch" });
    expect(message.presentation?.parts[0]?.label).toBe("not at destination");
  });

  test("job events preserve measured and silent progress semantics", () => {
    const messages = fixture("events.jsonl").split("\n").map(parseEngineMessage);
    expect(messages.map((message) => message.type)).toEqual([
      "job.started",
      "job.phase-changed",
      "job.progress-observed",
      "job.completed",
    ]);
    expect(messages[2]).toMatchObject({ filesSeen: 4, filesTotal: 12 });
  });
});
