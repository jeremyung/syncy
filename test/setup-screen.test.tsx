import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFixtureDir, removeFixtureDir, waitFor } from "./helpers.ts";
import { render } from "ink-testing-library";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type Config } from "../src/config.ts";
import { displayWidth } from "../src/width.ts";
import { EMPTY_CONFIG } from "../src/configio.ts";
import { configFile } from "../src/paths.ts";
import { SENTINEL_NAME } from "../src/sentinel.ts";
import { Setup } from "../src/tui/Setup.tsx";
import { THEMES } from "../src/tui/theme.ts";

/**
 * Drives the setup screen through simulated keystrokes. Ink's useInput needs a
 * TTY, which ink-testing-library provides; piping into a pty via `script` does
 * not deliver stdin and silently does nothing.
 */

const ESC = "\u001B";
const ENTER = "\r";
const TAB = "\t";

let root: string;
let prevConfigHome: string | undefined;

beforeEach(() => {
  root = makeFixtureDir("syncy-screen");
  mkdirSync(join(root, "src/alpha"), { recursive: true });
  mkdirSync(join(root, "src/beta"), { recursive: true });
  mkdirSync(join(root, "dst"), { recursive: true });
  prevConfigHome = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = join(root, "cfg");
});

afterEach(() => {
  if (prevConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevConfigHome;
  removeFixtureDir(root);
});

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");

function mount(config: Config = EMPTY_CONFIG(join(root, "src"))) {
  let latest = config;
  let exited = false;
  const r = render(
    <Setup
      config={config}
      theme={THEMES.ansi}
      width={76}
      onChange={(next) => {
        latest = next;
      }}
      onExit={() => {
        exited = true;
      }}
    />,
  );
  return {
    ...r,
    frame: () => plain(r.lastFrame()),
    config: () => latest,
    exited: () => exited,
  };
}

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the setup screen at rest", () => {
  test("shows the source root and how many subfolders it holds", () => {
    const s = mount();
    // The path is truncated from the left, so the leaf survives.
    expect(s.frame()).toContain("/src");
    expect(s.frame()).toContain("2 subfolders");
  });

  test("says so plainly when there are no targets yet", () => {
    expect(mount().frame()).toContain("none yet");
  });

  test("explains what is still missing, in the singular", () => {
    // min_targets defaults to 1, so an empty config needs exactly one more —
    // and the sentence has to read correctly at that count.
    const line = mount()
      .frame()
      .split("\n")
      .find((l) => l.includes("nothing can reach verified"))!;
    expect(line).toContain("add 1 more required target");
    // Scoped to the line: "targets" legitimately appears elsewhere on screen.
    expect(line).not.toContain("targets");
  });

  test("states which folders it tracks, since that is not configurable", () => {
    expect(mount().frame()).toContain("immediate subfolders");
  });

  test("reports a source root that does not exist", () => {
    expect(mount(EMPTY_CONFIG(join(root, "nope"))).frame()).toContain("not found");
  });

  test("escape leaves the screen", async () => {
    const s = mount();
    s.stdin.write(ESC);
    await tick();
    expect(s.exited()).toBe(true);
  });
});

describe("editing the source root", () => {
  test("[s] opens an editable path field", async () => {
    const s = mount();
    s.stdin.write("s");
    await tick();
    expect(s.frame()).toContain("path");
  });

  test("typing a valid path and pressing enter saves it", async () => {
    const s = mount(EMPTY_CONFIG(join(root, "nope")));
    s.stdin.write("s");
    await tick();
    // The field is pre-filled with the current value; clear it first.
    for (let i = 0; i < 200; i++) s.stdin.write("\u007F");
    await tick();
    s.stdin.write(join(root, "src"));
    await tick();
    s.stdin.write(ENTER);
    await tick(120);
    expect(s.config().source).toBe(join(root, "src"));
    expect(existsSync(configFile())).toBe(true);
  });

  test("a nonexistent path is refused with a reason, not silently accepted", async () => {
    const s = mount();
    s.stdin.write("s");
    await tick();
    for (let i = 0; i < 200; i++) s.stdin.write("\u007F");
    s.stdin.write("/definitely/not/here");
    await tick();
    s.stdin.write(ENTER);
    await tick();
    expect(s.frame()).toContain("no such directory");
  });

  test("escape abandons the edit", async () => {
    const s = mount();
    const before = s.config().source;
    s.stdin.write("s");
    await tick();
    s.stdin.write("/junk");
    s.stdin.write(ESC);
    await tick();
    expect(s.config().source).toBe(before);
  });

  test("tab completes to a matching directory", async () => {
    const s = mount();
    s.stdin.write("s");
    await tick();
    for (let i = 0; i < 200; i++) s.stdin.write("\u007F");
    s.stdin.write(join(root, "src/al"));
    await tick();
    s.stdin.write(TAB);
    await tick();
    // The field keeps the tail visible rather than wrapping, so assert on the
    // end of the completed path.
    expect(s.frame()).toContain("alpha/");
  });
});

describe("adding a target", () => {
  test("[a] opens the path field with completions", async () => {
    const s = mount();
    s.stdin.write("a");
    await tick();
    s.stdin.write(root + "/");
    await tick();
    const f = s.frame();
    expect(f).toContain("dst");
    expect(f).toContain("src");
  });

  test("refuses a target inside the source root, naming the reason", async () => {
    const s = mount();
    s.stdin.write("a");
    await tick();
    s.stdin.write(join(root, "src/alpha"));
    await tick();
    s.stdin.write(ENTER);
    await tick();
    expect(s.frame()).toContain("inside the source root");
  });

  test("refuses a path that does not exist", async () => {
    const s = mount();
    s.stdin.write("a");
    await tick();
    s.stdin.write(join(root, "absent"));
    await tick();
    s.stdin.write(ENTER);
    await tick();
    expect(s.frame()).toContain("no such directory");
  });

  test("a valid path advances to naming, pre-filled with the basename", async () => {
    const s = mount();
    s.stdin.write("a");
    await tick();
    s.stdin.write(join(root, "dst"));
    await tick();
    s.stdin.write(ENTER);
    await tick();
    expect(s.frame()).toContain("name");
    expect(s.frame()).toContain("dst");
  });

  test("saving records the volume identity and writes nothing to the target", async () => {
    const s = mount();
    s.stdin.write("a");
    await tick();
    s.stdin.write(join(root, "dst"));
    await tick();
    s.stdin.write(ENTER);
    await tick();
    s.stdin.write(ENTER);
    // The sentinel and the probe both spawn rsync; wait for the result rather
    // than betting on how long that takes.
    await waitFor(() => s.config().targets.length === 1, { what: "the target to be saved" });

    const written = s.config();
    expect(written.targets).toHaveLength(1);
    const target = written.targets[0]!;
    expect(target.path).toBe(join(root, "dst"));

    // Nothing is placed on the user's volume: the destination is identified by
    // asking the operating system which volume is mounted there.
    expect(existsSync(join(root, "dst", SENTINEL_NAME))).toBe(false);
    expect(target.identity).toBeTruthy();
    expect(target.identityKind === "volume-uuid" || target.identityKind === "mount-source").toBe(true);

    // And it round-trips through the loader.
    const onDisk = parseConfig(readFileSync(configFile(), "utf8"));
    expect(onDisk.targets[0]!.identity).toBe(target.identity);
    expect(onDisk.targets[0]!.fstype).not.toBe("");
  }, 15_000);

  test("the probe leaves no artefacts in the target", async () => {
    const s = mount();
    s.stdin.write("a");
    await tick();
    s.stdin.write(join(root, "dst"));
    await tick();
    s.stdin.write(ENTER);
    await tick();
    s.stdin.write(ENTER);
    await waitFor(() => s.config().targets.length === 1, { what: "the probe to finish" });
    await tick(200);

    const leftovers = require("node:fs")
      .readdirSync(join(root, "dst"))
      .filter((n: string) => n.includes("probe"));
    expect(leftovers).toEqual([]);
  }, 15_000);
});

describe("browsing volumes says what each one is", () => {
  /**
   * A share and a local disk can differ by a single letter and a capital in
   * their volume names, and nothing on screen distinguished them — picking
   * correctly required already knowing which was which. The kernel reports it,
   * so the listing does too.
   */
  test("a network share and a local disk are labelled differently", async () => {
    const { classify, describeVolume } = await import("../src/volume.ts");
    const share = {
      device: "//you@nas.local/media", mountPoint: "/Volumes/media",
      fstype: "smbfs", flags: ["nodev"], local: false,
    };
    const disk = {
      device: "/dev/disk5s1", mountPoint: "/Volumes/Archive",
      fstype: "exfat", flags: ["local", "nodev"], local: true,
    };
    expect(classify(share)).toBe("network");
    expect(classify(disk)).not.toBe("network");
    expect(
      describeVolume({ ...share, name: "media", kind: "network", free: null }),
    ).toContain("//you@nas.local/media");
  });

  test("the label names the server, which is the part that identifies it", async () => {
    // "network share" alone would not distinguish two shares on one host.
    const { describeVolume } = await import("../src/volume.ts");
    const a = describeVolume({ mountPoint: "/Volumes/pics", name: "pics", kind: "network",
      fstype: "smbfs", device: "//you@server.local/pics", free: null });
    const b = describeVolume({ mountPoint: "/Volumes/scratch", name: "scratch", kind: "network",
      fstype: "smbfs", device: "//you@server.local/scratch", free: null });
    expect(a).not.toBe(b);
  });

  test("a listing with annotations never overflows the window", async () => {
    // The note wrapped onto a second line and sheared the row beneath it.
    const s = mount();
    await tick();
    s.stdin.write("a");
    await tick(100);
    s.stdin.write("/Vol");  // enough to list, without naming a real volume
    await tick(500);
    for (const line of s.frame().split("\n")) {
      // The harness renders at 76 columns; the two-space gutter is the
      // established allowance everywhere else in this suite.
      expect(displayWidth(line), line).toBeLessThanOrEqual(78);
    }
    s.unmount();
  });
});
