import { describe, expect, test } from "bun:test";
import { runCheckQueue } from "../src/check-runner.ts";
import type { Config } from "../src/config.ts";
import { TargetCheckError } from "../src/scan.ts";
import { EMPTY_STATE } from "../src/state.ts";

const target = {
  name: "archive",
  path: "/destination/archive",
  required: true,
  sentinel: "archive-id",
  fstype: "apfs",
  modifyWindow: 0,
  flagsDrop: [],
} as const;

const config: Config = {
  source: "/source",
  maxVerifyAgeDays: 30,
  maxQuickAgeDays: 7,
  minTargets: 1,
  exclude: [],
  targets: [target],
};

describe("queued checks revalidate destinations", () => {
  test("reports a destination lost at the fresh rsync boundary as skipped", async () => {
    const history: unknown[] = [];
    const events: string[] = [];
    const result = await runCheckQueue(
      config,
      EMPTY_STATE,
      "quick",
      [{ unit: "photos", bytes: 8, files: 2 }],
      {
        dependencies: {
          reachability: async () => new Map([[target.name, "ok"]]),
          check: async () => {
            throw new TargetCheckError(target, "unreachable");
          },
          saveState: () => {
            throw new Error("a skipped check must record no state");
          },
          saveDiff: () => {
            throw new Error("a skipped check must record no diff");
          },
          appendHistory: (entry) => history.push(entry),
        },
        onEvent: (event) => events.push(event.type),
        now: () => 1000,
      },
    );

    expect(result.ran).toBe(0);
    expect(result.skipped).toEqual([{ target: "archive", why: "unreachable" }]);
    expect(events).toEqual(["job.started", "job.skipped"]);
    expect(history).toEqual([
      expect.objectContaining({ target: "archive", outcome: "skipped", exitCode: null }),
    ]);
  });
});
