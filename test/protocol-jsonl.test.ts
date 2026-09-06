import { describe, expect, test } from "bun:test";
import {
  ENGINE_PROTOCOL_VERSION,
  type JobEvent,
  type SnapshotMessage,
  type SyncPreflightMessage,
} from "../src/engine-protocol.ts";
import {
  EngineMessageDecoder,
  ProtocolError,
  parseEngineMessage,
  serializeEngineMessage,
} from "../src/protocol-jsonl.ts";

const snapshot: SnapshotMessage = {
  protocolVersion: ENGINE_PROTOCOL_VERSION,
  type: "snapshot",
  generatedAt: 1_750_000_000_000,
  source: "/source",
  configRevision: "revision-1",
  activeJob: {
    actor: "mac",
    operation: "deep",
    startedAt: 1_750_000_000_000,
    heartbeatAt: 1_750_000_000_500,
    activity: {
      unit: "photos-2019",
      target: "archive",
      phase: "comparing-content",
      at: 1_750_000_000_400,
      filesSeen: 12,
      filesTotal: 120,
    },
  },
  targets: [{ name: "archive", required: true, reachability: "ok" }],
  units: [
    {
      unit: "photos-2019",
      state: "unverified",
      reason: "size and date match, bytes unread",
      fingerprint: { nfiles: 12, bytes: 4096, maxMtimeNs: "1700000000000000000" },
      cells: [
        {
          target: "archive",
          state: "unverified",
          reason: "size and date match, bytes unread",
          nChanges: 0,
          nExtra: 0,
          bytesPending: 0,
        },
      ],
    },
  ],
};

const started: JobEvent = {
  protocolVersion: ENGINE_PROTOCOL_VERSION,
  type: "job.started",
  jobId: "job-1",
  at: 1_750_000_000_100,
  operation: "deep",
  unit: "photos-2019",
  target: "archive",
  phase: "queued",
  batch: { position: 1, total: 2, bytesDone: 0, bytesTotal: 8192 },
  unitSize: { files: 12, bytes: 4096 },
  priorDurationMs: 42_000,
};

const preflight: SyncPreflightMessage = {
  protocolVersion: ENGINE_PROTOCOL_VERSION,
  type: "sync.preflight",
  generatedAt: 1_750_000_000_000,
  unit: "photos-2019",
  target: "archive",
  argv: ["-a", "/source/photos-2019/", "/destination/photos-2019/"],
  checks: [
    { name: "volume", ok: true, detail: "archive · volume-1" },
    { name: "dry run", ok: true, warn: true, detail: "no — this writes to the target" },
  ],
  ok: true,
  nChanges: 4,
  nNew: 3,
  nExtra: 1,
  bytesPending: 2048,
  needsChecksum: false,
  confirmationToken: "confirmation-123",
  expiresAt: 1_750_000_300_000,
};

describe("engine JSON Lines protocol", () => {
  test("round-trips a full snapshot as one newline-delimited record", () => {
    const line = serializeEngineMessage(snapshot);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n")).toHaveLength(2);
    expect(parseEngineMessage(line)).toEqual(snapshot);
  });

  test("round-trips job events without turning estimates into measurements", () => {
    expect(parseEngineMessage(serializeEngineMessage(started))).toEqual(started);
    const parsed = parseEngineMessage(serializeEngineMessage(started));
    if (parsed.type !== "job.started") throw new Error("wrong event type");
    expect(parsed.priorDurationMs).toBe(42_000);
  });

  test("round-trips a guarded sync preflight with a one-use confirmation", () => {
    expect(parseEngineMessage(serializeEngineMessage(preflight))).toEqual(preflight);
  });

  test("a successful preflight cannot omit its confirmation", () => {
    const invalid = { ...preflight, confirmationToken: undefined };
    expect(() => parseEngineMessage(JSON.stringify(invalid))).toThrow(/confirmationToken/);
  });

  test("frames records split across arbitrary stdout chunks", () => {
    const decoder = new EngineMessageDecoder();
    const wire = serializeEngineMessage(snapshot) + serializeEngineMessage(started);
    expect(decoder.push(wire.slice(0, 17))).toEqual([]);
    expect(decoder.push(wire.slice(17, wire.length - 9))).toEqual([snapshot]);
    expect(decoder.push(wire.slice(-9))).toEqual([started]);
    expect(decoder.finish()).toEqual([]);
  });

  test("finish returns a valid final record even without a newline", () => {
    const decoder = new EngineMessageDecoder();
    decoder.push(JSON.stringify(started).slice(0, 20));
    decoder.push(JSON.stringify(started).slice(20));
    expect(decoder.finish()).toEqual([started]);
  });

  test("rejects unsupported versions rather than guessing compatibility", () => {
    const wrong = JSON.stringify({ ...started, protocolVersion: 2 });
    expect(() => parseEngineMessage(wrong)).toThrow(/unsupported version 2/);
  });

  test("rejects a skipped destination described as reachable", () => {
    const bad = JSON.stringify({
      ...started,
      type: "job.skipped",
      reachability: "ok",
      reason: "not run",
    });
    expect(() => parseEngineMessage(bad)).toThrow(/cannot be "ok"/);
  });

  test("rejects progress with no observable measurement", () => {
    const bad = JSON.stringify({ ...started, type: "job.progress-observed" });
    expect(() => parseEngineMessage(bad)).toThrow(/must contain an observation/);
  });

  test("rejects malformed nested snapshot evidence", () => {
    const bad = structuredClone(snapshot) as unknown as {
      units: Array<{ fingerprint: { nfiles: unknown } }>;
    };
    bad.units[0]!.fingerprint.nfiles = "twelve";
    expect(() => parseEngineMessage(JSON.stringify(bad))).toThrow(/fingerprint.nfiles/);
  });

  test("reports malformed JSON as a protocol error", () => {
    expect(() => parseEngineMessage("{not json")).toThrow(ProtocolError);
  });

  test("does not silently accept blank records", () => {
    expect(() => parseEngineMessage("\n")).toThrow(/blank record/);
  });
});
