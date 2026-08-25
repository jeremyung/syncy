import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { EMPTY_CONFIG } from "../src/configio.ts";
import { Setup } from "../src/tui/Setup.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

/**
 * Browsing completions with the arrow keys.
 *
 * Tab alone only ever took the first match, so reaching any other directory
 * meant typing enough to disambiguate it.
 */

const ESC = "\u001B";
const ENTER = "\r";
const TAB = "\t";
const DOWN = "\u001B[B";
const UP = "\u001B[A";
const BACKSPACE = "\u007F";

let root: string;
let prevConfigHome: string | undefined;

beforeEach(() => {
  root = makeFixtureDir("syncy-complete");
  // Deliberately ordered so the first match is not the interesting one.
  for (const d of ["alpha", "beta", "gamma", "gamma/nested"]) {
    mkdirSync(join(root, "picks", d), { recursive: true });
  }
  mkdirSync(join(root, "src"), { recursive: true });
  prevConfigHome = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "cfg");
});

afterEach(() => {
  if (prevConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevConfigHome;
  removeFixtureDir(root);
});

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mount() {
  const r = render(
    <Setup
      config={{ ...EMPTY_CONFIG(join(root, "src")) }}
      theme={THEMES.ansi}
      width={90}
      onChange={() => undefined}
      onExit={() => undefined}
    />,
  );
  return {
    ...r,
    frame: () => plain(r.lastFrame()),
    async press(s: string) {
      r.stdin.write(s);
      await tick();
    },
  };
}

/** Opens the target-path field with the fixture's picks listed. */
async function openPicks(s: ReturnType<typeof mount>): Promise<void> {
  await s.press("a");
  await s.press(join(root, "picks") + "/");
}

/** The suggestion line carrying the selection marker, if any. */
function selected(frame: string): string | undefined {
  return frame.split("\n").find((l) => l.includes("»"));
}

describe("browsing completions", () => {
  test("the list appears as you type a directory", async () => {
    const s = mount();
    await openPicks(s);
    for (const d of ["alpha", "beta", "gamma"]) expect(s.frame()).toContain(d);
    s.unmount();
  });

  test("nothing is selected until you arrow down", async () => {
    const s = mount();
    await openPicks(s);
    expect(selected(s.frame())).toBeUndefined();
    s.unmount();
  });

  test("down selects the first entry", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    expect(selected(s.frame())).toContain("alpha");
    s.unmount();
  });

  test("down again moves to the second", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    await s.press(DOWN);
    expect(selected(s.frame())).toContain("beta");
    s.unmount();
  });

  test("up moves back, and past the top returns to typing", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    await s.press(DOWN);
    await s.press(UP);
    expect(selected(s.frame())).toContain("alpha");
    await s.press(UP);
    expect(selected(s.frame())).toBeUndefined();
    s.unmount();
  });

  test("down stops at the last entry rather than wrapping", async () => {
    const s = mount();
    await openPicks(s);
    for (let i = 0; i < 10; i++) await s.press(DOWN);
    expect(selected(s.frame())).toContain("gamma");
    s.unmount();
  });
});

describe("accepting a completion", () => {
  test("enter on a selection opens it, rather than submitting", async () => {
    // The point: walk into a directory without retyping it.
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    await s.press(DOWN);
    await s.press(DOWN); // gamma
    await s.press(ENTER);
    const f = s.frame();
    expect(f).toContain("gamma/");
    // Still in the field, now listing what is inside gamma.
    expect(f).toContain("nested");
    s.unmount();
  });

  test("tab takes the selection when one is highlighted", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    await s.press(DOWN); // beta
    await s.press(TAB);
    expect(s.frame()).toContain("beta/");
    s.unmount();
  });

  test("tab still takes the first match when nothing is highlighted", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(TAB);
    expect(s.frame()).toContain("alpha/");
    s.unmount();
  });

  test("accepting clears the selection so typing resumes", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    await s.press(TAB);
    expect(selected(s.frame())).toBeUndefined();
    s.unmount();
  });

  test("typing a character returns to the input line", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    expect(selected(s.frame())).toBeDefined();
    await s.press("g");
    expect(selected(s.frame())).toBeUndefined();
    s.unmount();
  });

  test("backspace also returns to the input line", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    await s.press(BACKSPACE);
    expect(selected(s.frame())).toBeUndefined();
    s.unmount();
  });

  test("escape leaves the list before leaving the field", async () => {
    // One step at a time, so a half-typed path is not discarded by accident.
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    await s.press(ESC);
    expect(selected(s.frame())).toBeUndefined();
    expect(s.frame()).toContain("path");
    await s.press(ESC);
    expect(s.frame()).toContain("[a] add destination");
    s.unmount();
  });
});

describe("the key hints follow the mode", () => {
  test("typing with completions offers browsing", async () => {
    const s = mount();
    await openPicks(s);
    expect(s.frame()).toContain("[↓] browse");
    s.unmount();
  });

  test("a selection offers opening it", async () => {
    const s = mount();
    await openPicks(s);
    await s.press(DOWN);
    expect(s.frame()).toContain("[enter] open");
    s.unmount();
  });
});

describe("completions and input always resolve to absolute paths", () => {
  test("a relative path completes to an absolute one", async () => {
    // Relative in, relative out meant accepting a completion produced a path
    // the validator then refused with "must be an absolute path".
    const { completions } = await import("../src/tui/Setup.tsx");
    const rel = join(root, "picks").replace(process.cwd() + "/", "");
    const out = completions(rel + "/al");
    expect(out).toHaveLength(1);
    expect(out[0]!.startsWith("/")).toBe(true);
    expect(out[0]).toBe(join(root, "picks", "alpha"));
  });

  test("every completion is absolute, whatever was typed", async () => {
    const { completions } = await import("../src/tui/Setup.tsx");
    for (const typed of [join(root, "picks") + "/", "~/", "./"]) {
      for (const c of completions(typed)) {
        expect(c.startsWith("/"), `${typed} -> ${c}`).toBe(true);
      }
    }
  });

  test("expandPath handles ~, bare ~, relative and ./", async () => {
    const { expandPath } = await import("../src/tui/Setup.tsx");
    const home = process.env["HOME"]!;
    expect(expandPath("~")).toBe(home);
    expect(expandPath("~/x")).toBe(join(home, "x"));
    expect(expandPath("./a/b")).toBe(join(process.cwd(), "a/b"));
    expect(expandPath("a/b")).toBe(join(process.cwd(), "a/b"));
    expect(expandPath("/already/absolute")).toBe("/already/absolute");
    expect(expandPath("   ")).toBe("");
  });

  test("a relative target path is accepted, not refused", async () => {
    const { validateTargetPath } = await import("../src/tui/Setup.tsx");
    const rel = join(root, "picks", "alpha").replace(process.cwd() + "/", "");
    expect(validateTargetPath(rel, EMPTY_CONFIG(join(root, "src")))).toBeNull();
  });

  test("an empty path says so plainly", async () => {
    const { validateTargetPath } = await import("../src/tui/Setup.tsx");
    expect(validateTargetPath("", EMPTY_CONFIG("/src"))).toBe("a path is required");
  });

  test("nesting checks still apply to a relative path once resolved", async () => {
    // The safety check must not be dodgeable by typing a relative path.
    const { validateTargetPath } = await import("../src/tui/Setup.tsx");
    const src = join(root, "src");
    mkdirSync(join(src, "inside"), { recursive: true });
    const rel = join(src, "inside").replace(process.cwd() + "/", "");
    expect(validateTargetPath(rel, EMPTY_CONFIG(src))).toBe("inside the source root");
  });

  test("accepting a completion puts an absolute path in the field", async () => {
    const s = mount();
    await s.press("a");
    const rel = join(root, "picks").replace(process.cwd() + "/", "");
    await s.press(rel + "/");
    await s.press(DOWN);
    await s.press(TAB);
    expect(s.frame()).toContain("/picks/alpha/");
    s.unmount();
  });
});
