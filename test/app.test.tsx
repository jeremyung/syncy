import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { type Config, parseConfig } from "../src/config.ts";
import { EMPTY_CONFIG } from "../src/configio.ts";
import { writeSentinel } from "../src/sentinel.ts";
import { App } from "../src/tui/App.tsx";
import { makeFixtureDir, removeFixtureDir, waitFor } from "./helpers.ts";

/**
 * Guards the first-run hang.
 *
 * `syncy` with no config defaulted its source root to the home directory, and
 * App computed the ledger rows — fingerprinting every unit — during render,
 * before returning the setup screen. A useMemo runs whatever the component
 * returns, so first run stat-ed ~1.7 million files before drawing anything.
 */

let root: string;
let prevConfigHome: string | undefined;
let prevStateHome: string | undefined;

/** A source root big enough that walking it would be obvious in the timings. */
function makeBusySource(): string {
  const src = join(root, "src");
  for (let unit = 0; unit < 12; unit++) {
    const dir = join(src, `unit-${unit}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 60; f++) writeFileSync(join(dir, `f${f}.bin`), "x".repeat(64));
  }
  return src;
}

beforeEach(() => {
  root = makeFixtureDir("syncy-app");
  prevConfigHome = process.env["XDG_CONFIG_HOME"];
  prevStateHome = process.env["XDG_STATE_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "cfg");
  process.env["XDG_STATE_HOME"] = join(root, "state");
});

afterEach(() => {
  for (const [k, v] of [
    ["XDG_CONFIG_HOME", prevConfigHome],
    ["XDG_STATE_HOME", prevStateHome],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeFixtureDir(root);
});

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

function mountTimed(config: Config): { frame: string; ms: number; unmount: () => void } {
  const started = Date.now();
  const r = render(<App config={config} />);
  const ms = Date.now() - started;
  return { frame: plain(r.lastFrame()), ms, unmount: r.unmount };
}

describe("first run", () => {
  test("an empty config has no source root, rather than defaulting to home", () => {
    // The default of `~` is what made first run scan the whole home directory.
    expect(EMPTY_CONFIG().source).toBe("");
  });

  test("opens the setup screen when nothing is configured", () => {
    const m = mountTimed(EMPTY_CONFIG());
    expect(m.frame).toContain("syncy · setup");
    expect(m.frame).toContain("not set");
    m.unmount();
  });

  test("renders immediately, without walking anything", () => {
    const m = mountTimed(EMPTY_CONFIG());
    expect(m.ms).toBeLessThan(500);
    m.unmount();
  });
});

describe("the ledger never walks a source it cannot use", () => {
  test("a configured source with no targets is not fingerprinted", () => {
    // Nothing meaningful can be shown without a target, so the walk is waste.
    const src = makeBusySource();
    const config = { ...EMPTY_CONFIG(src) };
    const m = mountTimed(config);
    expect(m.ms).toBeLessThan(500);
    m.unmount();
  });

  test("an unset source yields no units even if the cwd is full of folders", () => {
    const m = mountTimed(EMPTY_CONFIG());
    expect(m.frame).not.toContain("units ·");
    m.unmount();
  });
});

describe("with a real config the ledger does render", () => {
  test("shows the units once a target exists", async () => {
    const src = makeBusySource();
    mkdirSync(join(root, "dst"), { recursive: true });
    const id = await writeSentinel(join(root, "dst"));
    const config = parseConfig(`
source = "${src}"
[[target]]
name = "dst"
path = "${join(root, "dst")}"
required = true
sentinel = "${id}"
`);
    // The source is read in an effect now, so the first frame says so and the
    // rows arrive once it finishes.
    const started = Date.now();
    const r = render(<App config={config} />);
    expect(plain(r.lastFrame())).toContain("reading");
    await waitFor(() => plain(r.lastFrame()).includes("unit-0"), { what: "the ledger to fill" });
    expect(plain(r.lastFrame())).toContain("folder");
    expect(Date.now() - started).toBeLessThan(5000);
    r.unmount();
  });
});

describe("the ledger opens even when state.json cannot be parsed", () => {
  /**
   * `App` called `loadState` in a useState initializer, and a state file that
   * is not JSON at the top level made it throw there — so the interface died
   * before it drew, in exactly the situation (a hand edit, a half-restored
   * backup) in which the ledger is most needed. An unreadable file is now set
   * aside on the way in, and the first ledger frame says so.
   */
  test("a corrupt state file is set aside, and every row still reads unchecked", async () => {
    const src = join(root, "src");
    for (let unit = 0; unit < 3; unit++) mkdirSync(join(src, `unit-${unit}`), { recursive: true });
    mkdirSync(join(root, "dst"), { recursive: true });
    const id = await writeSentinel(join(root, "dst"));
    // The state file is under the syncy subdirectory of the state home.
    mkdirSync(join(root, "state", "syncy"), { recursive: true });
    writeFileSync(join(root, "state", "syncy", "state.json"), "{");
    const config = parseConfig(`
source = "${src}"
[[target]]
name = "dst"
path = "${join(root, "dst")}"
required = true
sentinel = "${id}"
`);
    // A render that throws in the useState initializer is the bug: this line
    // is the assertion that the interface draws at all.
    const r = render(<App config={config} />);
    await waitFor(() => plain(r.lastFrame()).includes("unit-0"), { what: "the ledger to fill" });
    const frame = plain(r.lastFrame());
    expect(frame).toContain("folder");
    // The unreadable record may only mean unchecked, nothing stronger: all
    // three rows read it in the status column, and no row carries another
    // state's word there.
    expect(frame.match(/unchecked · /g) ?? []).toHaveLength(3);
    expect(frame).not.toMatch(/\b(verified|unverified|behind|missing|error) · /);
    expect(frame).toContain("set aside as state.json.corrupt-");
    r.unmount();
  });
});
