import { describe, expect, test } from "bun:test";
import { type CheckRunnerDependencies, runCheckQueue } from "../src/check-runner.ts";
import type { Config, Target } from "../src/config.ts";
import type { JobEvent } from "../src/engine-protocol.ts";
import type { CheckResult } from "../src/scan.ts";
import { EMPTY_STATE } from "../src/state.ts";

const targets: readonly Target[] = [
  {
    name: "archive",
    path: "/destination/archive",
    required: true,
    sentinel: "archive-id",
    fstype: "apfs",
    modifyWindow: 0,
    flagsDrop: [],
  },
  {
    name: "offline",
    path: "/destination/offline",
    required: true,
    sentinel: "offline-id",
    fstype: "apfs",
    modifyWindow: 0,
    flagsDrop: [],
  },
];

const config: Config = {
  source: "/source",
  maxVerifyAgeDays: 30,
  maxQuickAgeDays: 7,
  minTargets: 1,
  exclude: [],
  targets,
};

function checked(unit: string, target: string, mode: "quick" | "deep"): CheckResult {
  return {
    scan: {
      unit,
      target,
      ts: 1000,
      method: mode,
      outcome: "clean",
      nChanges: 0,
      nNew: 0,
      nExtra: 0,
      bytesPending: 0,
      fingerprint: { nfiles: 2, bytes: 100, maxMtimeNs: "3" },
      sentinel: `${target}-id`,
      durationMs: 500,
    },
    items: [],
    targetFingerprint: { nfiles: 2, bytes: 100, maxMtimeNs: "3" },
    argv: ["-a", "-n"],
    exitCode: 0,
  };
}

function dependencies(
  calls: string[],
  check: CheckRunnerDependencies["check"] = async (_config, unit, target, mode, options) => {
    options?.onPhase?.("inspecting-source");
    options?.onPhase?.("starting-rsync");
    options?.onPhase?.("comparing");
    options?.onFile?.(1, "one.raw");
    options?.onPhase?.("fingerprinting-destination");
    return checked(unit, target.name, mode);
  },
): CheckRunnerDependencies {
  return {
    reachability: async () =>
      new Map([
        ["archive", "ok"],
        ["offline", "unreachable"],
      ]),
    check,
    saveState: () => calls.push("state"),
    saveDiff: () => calls.push("diff"),
    appendHistory: () => calls.push("history"),
  };
}

describe("the UI-independent check runner", () => {
  test("sequences units, records each result, and explicitly emits every skip", async () => {
    const calls: string[] = [];
    const events: JobEvent[] = [];
    const published: number[] = [];
    const result = await runCheckQueue(
      config,
      EMPTY_STATE,
      "deep",
      [
        { unit: "photos-2019", bytes: 100, files: 2 },
        { unit: "photos-2020", bytes: 300, files: 4 },
      ],
      {
        dependencies: dependencies(calls),
        onEvent: (event) => events.push(event),
        onState: (state) => published.push(state.scans.length),
        now: () => 2000,
        jobId: (unit, target) => `${unit}:${target}`,
      },
    );

    expect(result.status).toBe("completed");
    expect(result.total).toBe(4);
    expect(result.ran).toBe(2);
    expect(result.skipped).toEqual([{ target: "offline", why: "unreachable" }]);
    expect(calls).toEqual([
      "state",
      "diff",
      "history",
      "history", // the first explicit skip
      "state",
      "diff",
      "history",
      "history", // the second explicit skip
    ]);
    expect(published).toEqual([1, 2]);
    expect(events.filter((event) => event.type === "job.completed")).toHaveLength(2);
    expect(events.filter((event) => event.type === "job.skipped")).toHaveLength(2);
    expect(
      events.filter(
        (event) => event.type === "job.phase-changed" && event.phase === "comparing-content",
      ),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.type === "job.progress-observed" && event.filesSeen === 1),
    ).toHaveLength(2);
  });

  test("carries batch bytes and measured prior duration into the start event", async () => {
    const events: JobEvent[] = [];
    const priorState = {
      version: 1,
      scans: [
        {
          ...checked("older", "archive", "deep").scan,
          durationMs: 1000,
          fingerprint: { nfiles: 2, bytes: 100, maxMtimeNs: "3" },
        },
      ],
    } as const;
    await runCheckQueue(config, priorState, "deep", [{ unit: "new", bytes: 200, files: 7 }], {
      dependencies: dependencies([]),
      onEvent: (event) => events.push(event),
      now: () => 2000,
    });
    const started = events.find(
      (event) => event.type === "job.started" && event.target === "archive",
    );
    if (started?.type !== "job.started") throw new Error("missing start event");
    expect(started.batch).toEqual({ position: 1, total: 2, bytesDone: 0, bytesTotal: 400 });
    expect(started.unitSize).toEqual({ files: 7, bytes: 200 });
    expect(started.priorDurationMs).toBe(2000);
  });

  test("reuses one cached source fingerprint across every destination", async () => {
    const fingerprints: unknown[] = [];
    const check: CheckRunnerDependencies["check"] = async (
      _config,
      unit,
      target,
      mode,
      options,
    ) => {
      fingerprints.push(options?.fingerprint);
      return checked(unit, target.name, mode);
    };
    const fingerprint = { nfiles: 7, bytes: 200, maxMtimeNs: "9" } as const;
    await runCheckQueue(
      config,
      EMPTY_STATE,
      "quick",
      [{ unit: "new", bytes: 200, files: 7, fingerprint }],
      {
        dependencies: {
          ...dependencies([], check),
          reachability: async () =>
            new Map([
              ["archive", "ok"],
              ["offline", "ok"],
            ]),
        },
      },
    );
    expect(fingerprints).toEqual([fingerprint, fingerprint]);
  });

  test("a fingerprint measured by the first check is reused by the next destination", async () => {
    const fingerprints: unknown[] = [];
    const check: CheckRunnerDependencies["check"] = async (
      _config,
      unit,
      target,
      mode,
      options,
    ) => {
      fingerprints.push(options?.fingerprint);
      return checked(unit, target.name, mode);
    };
    await runCheckQueue(config, EMPTY_STATE, "quick", [{ unit: "new", bytes: 200, files: 7 }], {
      dependencies: {
        ...dependencies([], check),
        reachability: async () =>
          new Map([
            ["archive", "ok"],
            ["offline", "ok"],
          ]),
      },
    });
    expect(fingerprints).toEqual([undefined, { nfiles: 2, bytes: 100, maxMtimeNs: "3" }]);
  });

  test("announces evidence recording before writes and publishes only after them", async () => {
    const order: string[] = [];
    await runCheckQueue(
      { ...config, targets: [targets[0]!] },
      EMPTY_STATE,
      "quick",
      [{ unit: "one", bytes: 1, files: 1 }],
      {
        dependencies: {
          ...dependencies([]),
          reachability: async () => new Map([["archive", "ok"]]),
          saveState: () => order.push("state"),
          saveDiff: () => order.push("diff"),
          appendHistory: () => order.push("history"),
        },
        onEvent: (event) => {
          if (event.type === "job.phase-changed" && event.phase === "recording-evidence") {
            order.push("recording");
          }
          if (event.type === "job.completed") order.push("completed");
        },
        onState: () => order.push("published"),
      },
    );
    expect(order).toEqual(["recording", "state", "diff", "history", "published", "completed"]);
  });

  test("an abort records no verdict and never drains the remaining queue", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const events: JobEvent[] = [];
    let checks = 0;
    const check: CheckRunnerDependencies["check"] = async (_config, unit, target, mode) => {
      checks += 1;
      controller.abort();
      return checked(unit, target.name, mode);
    };
    const result = await runCheckQueue(
      { ...config, targets: [targets[0]!] },
      EMPTY_STATE,
      "quick",
      [
        { unit: "one", bytes: 1, files: 1 },
        { unit: "two", bytes: 1, files: 1 },
      ],
      {
        signal: controller.signal,
        dependencies: {
          ...dependencies(calls, check),
          reachability: async () => new Map([["archive", "ok"]]),
        },
        onEvent: (event) => events.push(event),
      },
    );

    expect(result.status).toBe("cancelled");
    expect(checks).toBe(1);
    expect(calls).toEqual([]);
    expect(result.state).toEqual(EMPTY_STATE);
    expect(events.some((event) => event.type === "job.cancelled")).toBe(true);
    expect(events.some((event) => event.type === "job.completed")).toBe(false);
  });

  test("a thrown check is visible and does not prevent the next job", async () => {
    const events: JobEvent[] = [];
    let checks = 0;
    const check: CheckRunnerDependencies["check"] = async (_config, unit, target, mode) => {
      checks += 1;
      if (unit === "one") throw new Error("rsync unavailable");
      return checked(unit, target.name, mode);
    };
    const result = await runCheckQueue(
      { ...config, targets: [targets[0]!] },
      EMPTY_STATE,
      "quick",
      [
        { unit: "one", bytes: 1, files: 1 },
        { unit: "two", bytes: 1, files: 1 },
      ],
      {
        dependencies: {
          ...dependencies([], check),
          reachability: async () => new Map([["archive", "ok"]]),
        },
        onEvent: (event) => events.push(event),
      },
    );

    expect(checks).toBe(2);
    expect(result.failed).toEqual([
      { unit: "one", target: "archive", message: "rsync unavailable" },
    ]);
    expect(events.some((event) => event.type === "job.failed")).toBe(true);
    expect(events.some((event) => event.type === "job.completed" && event.unit === "two")).toBe(
      true,
    );
  });
  test("confines a run to the named destinations", async () => {
    // What the trailing check after a sync needs: the one destination the
    // transfer wrote to, not a fan-out that would make a two-second recheck
    // wait on every other drive — or, worse, report the others as skipped.
    const visited: string[] = [];
    const events: JobEvent[] = [];
    const result = await runCheckQueue(
      config,
      EMPTY_STATE,
      "quick",
      [{ unit: "photos-2019", bytes: 100, files: 2 }],
      {
        dependencies: dependencies([], async (_config, unit, target, mode) => {
          visited.push(target.name);
          return checked(unit, target.name, mode);
        }),
        onEvent: (event) => events.push(event),
        targets: ["archive"],
      },
    );

    expect(visited).toEqual(["archive"]);
    expect(result.total).toBe(1);
    expect(result.ran).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(events.some((event) => event.target === "offline")).toBe(false);
  });
});
