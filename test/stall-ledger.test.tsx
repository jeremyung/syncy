import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { type Config, parseConfig } from "../src/config.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import { App } from "../src/tui/App.tsx";
import { makeFixtureDir, removeFixtureDir, waitFor } from "./helpers.ts";

/**
 * The acceptance criterion for a destination that stops answering.
 *
 * A destination can die without unmounting: the path stays, and a read of it
 * blocks until the kernel gives up. Through the whole interface, that must
 * read as a named wait that settles into an unchecked row — never as a
 * frozen screen.
 *
 * `App` calls `allReachability` with its own options, so the stall cannot be
 * injected the way the unit tests inject it; it has to be real. A FIFO held
 * open at the write end is that real: the sentinel read blocks the way a
 * dead mount does, in a worker thread, while Ink keeps painting. The price
 * is the product's own deadline — REACHABILITY_TIMEOUT_MS, five real seconds
 * — because that constant is part of what is under test.
 */

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

/**
 * One unit's ledger row, the way keys.test.tsx reads it: the legend and the
 * footer carry every state word, so only a data row can be asserted on.
 */
function rowFor(frame: string, unit: string): string {
  const line = frame.split("\n").find((l) => l.includes(unit) && l.includes("....."));
  if (line === undefined) throw new Error(`no ledger row for ${unit} in:\n${frame}`);
  return line;
}

let root: string;
let config: Config;
let prevConfigHome: string | undefined;
let prevStateHome: string | undefined;
/** The held-open write end of the sentinel FIFO, or null while it is not up. */
let writer: number | null = null;

const closeWriter = (): void => {
  if (writer !== null) {
    try {
      closeSync(writer);
    } catch {
      // Already closed: nothing left for the blocked read to wait on.
    }
    writer = null;
  }
};

beforeEach(async () => {
  root = makeFixtureDir("syncy-stall");
  mkdirSync(join(root, "src/photos-2019"), { recursive: true });
  writeFileSync(join(root, "src/photos-2019/a.txt"), "aaa");
  mkdirSync(join(root, "dst"), { recursive: true });

  prevConfigHome = process.env["XDG_CONFIG_HOME"];
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "cfg");
  process.env["XDG_STATE_HOME"] = join(root, "state");

  const id = await writeSentinel(join(root, "dst"));
  config = parseConfig(`
source = "${join(root, "src")}"
[[target]]
name = "dst"
path = "${join(root, "dst")}"
required = true
sentinel = "${id}"
`);
});

afterEach(() => {
  // Closing the write end first hands the abandoned sentinel read its EOF,
  // so no blocked reader outlives the test.
  closeWriter();
  for (const [k, v] of [
    ["XDG_CONFIG_HOME", prevConfigHome],
    ["XDG_STATE_HOME", prevStateHome],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeFixtureDir(root);
});

describe("a destination that stops answering", () => {
  // The product's own deadline is part of what is under test: the row can
  // only settle after REACHABILITY_TIMEOUT_MS has run out, so this test
  // cannot finish faster than five real seconds. The extended timeout is
  // that allowance, not a bet on machine speed — every wait inside polls
  // observable state.
  test("the ledger draws, names the wait, and the row reads unchecked with a reason", async () => {
    const r = render(<App config={config} />);
    const frame = (): string => plain(r.lastFrame());
    const unmount = (): void => r.unmount();

    // The ledger draws with the destination answering: the fast path is
    // intact, and the row is unchecked for having never been checked —
    // nothing about waiting.
    await waitFor(() => frame().includes("[q]"), { what: "the ledger's first frame" });
    expect(rowFor(frame(), "photos-2019")).toContain("never checked");

    // Now the destination stops answering. The sentinel read is the
    // destination-touching read of the status path, and a FIFO with its
    // write end held open blocks it the way a dead mount does.
    const sentinelFile = join(root, "dst", SENTINEL_NAME);
    unlinkSync(sentinelFile);
    expect(Bun.spawnSync(["mkfifo", sentinelFile]).exitCode).toBe(0);
    writer = openSync(sentinelFile, "w+");

    // [r] re-runs the refresh against the stall.
    r.stdin.write("r");

    // 1 · The ledger DRAWS while the read is blocked: a new frame arrives,
    //     with the destination being waited on named on the notice line.
    //     That frame is the evidence the interface is not frozen — the
    //     renderer painted it while the sentinel read was still in the
    //     kernel.
    await waitFor(() => frame().includes("waiting on dst"), {
      timeout: 4_000,
      what: "the notice line to name the destination being waited on",
    });

    // 2 · The wait settles within its own deadline, and the row reads
    //     unchecked with the reason — the verdict a timeout supports and
    //     nothing stronger.
    await waitFor(() => rowFor(frame(), "photos-2019").includes("did not answer within"), {
      timeout: 8_000,
      what: "the row to carry the timeout reason",
    });
    const row = rowFor(frame(), "photos-2019");
    expect(row).toContain("unchecked");
    expect(row).toContain("did not answer within 5s");
    // The named wait did not outlive the answer.
    expect(frame()).not.toContain("waiting on dst");

    unmount();
  }, 20_000);
});
