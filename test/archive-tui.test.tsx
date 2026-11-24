import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { catalogFolders } from "../src/archive-catalog.ts";
import { runPairJob } from "../src/archive-job.ts";
import { archiveLedger } from "../src/archive-ledger.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { loadHistorySnapshot } from "../src/engine-history.ts";
import { fingerprint } from "../src/fingerprint.ts";
import { stamp } from "../src/format.ts";
import { SENTINEL_NAME } from "../src/sentinel.ts";
import { loadState } from "../src/state.ts";
import { App } from "../src/tui/App.tsx";
import { FolderPicker, PairView } from "../src/tui/Archive.tsx";
import { resolveTheme } from "../src/tui/theme.ts";
import { displayWidth } from "../src/width.ts";
import { makeFixtureDir, removeFixtureDir, waitFor } from "./helpers.ts";

const ESC = "\u001B";
const ENTER = "\r";
const unit = "photos";
const peers = ["one", "two"];
let config: Config;
let root: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.XDG_STATE_HOME;
  root = makeFixtureDir("archive-tui");
  process.env.XDG_STATE_HOME = join(root, "state");
  for (const name of ["local", ...peers]) {
    const folder = join(root, name, unit);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "print"), "image");
    utimesSync(join(folder, "print"), 100000, 100000);
    utimesSync(folder, 100000, 100000);
    if (name !== "local") writeFileSync(join(root, name, SENTINEL_NAME), name);
  }
  config = parseConfig(
    "source=" +
      JSON.stringify(join(root, "local")) +
      "\n" +
      peers
        .map(
          (name) =>
            '[[target]]\nname="' +
            name +
            '"\nsentinel="' +
            name +
            '"\npath=' +
            JSON.stringify(join(root, name)) +
            "\n",
        )
        .join(""),
  );
  catalogFolders(config);
  renameSync(join(root, "local", unit), join(root, "away"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  removeFixtureDir(root);
});

test("resume from the keyboard, compare both copies, then check a returning local folder", async () => {
  const view = render(<App config={config} />);
  const frame = () => view.lastFrame() ?? "";
  const see = (text: string) =>
    waitFor(() => frame().includes(text), { what: text }).catch((error) => {
      throw new Error(String(error) + "\n" + frame());
    });
  const key = async (key: string, text: string) => {
    view.stdin.write(key);
    await see(text);
  };
  try {
    await see("Absent locally");
    await key("a", "Remembered folders");
    await see("photos · Remembered");
    await key("x", "Stopped tracking photos");
    await waitFor(() => !catalogFolders(config)[0]?.active, { what: "stopped catalog record" });
    await key(ENTER, "Absent locally");
    expect(catalogFolders(config)).toHaveLength(1);
    expect(catalogFolders(config)[0]?.active).toBe(1);

    await key("d", "one ↔ two");
    await see("[enter] deep check");
    await key(ENTER, "Verified against each other");
    await key(ESC, "[enter] copies");
    writeFileSync(join(root, "two", unit, "extra"), "unique");
    await key("q", "[enter] quick check");
    await key(ENTER, "Only on two · 1");
    await see("Only on two · extra");
    await key(ESC, "[enter] copies");
    renameSync(join(root, "two"), join(root, "unmounted"));
    await key("r", "last result");
    await key(ENTER, "not connected");
    await see("Historical");
    await key(ESC, "[enter] copies");
    await key("D", "Local check skipped");
    expect(loadState().scans).toHaveLength(0);
    expect(
      loadHistorySnapshot().some(
        (entry) =>
          entry.unit === unit &&
          entry.target === "Local source" &&
          entry.outcome === "skipped" &&
          entry.detail?.includes("Absent locally"),
      ),
    ).toBe(true);
    renameSync(join(root, "away"), join(root, "local", unit));
    await key("r", "Local copy present");
    await key("c", "Local copy present · awaiting check");
    await see("Only on two · extra");
    await key(ESC, "[q] check");
    expect(catalogFolders(config)).toHaveLength(1);
    view.stdin.write("q");
    await waitFor(
      () =>
        loadState().scans.some(
          (s) => s.source === config.source && s.unit === unit && s.target === "one",
        ),
      { what: "fresh local scan on the returned folder" },
    );
    await see("skipped");
  } finally {
    view.unmount();
  }
}, 30_000);

test("a retired pair keeps its dated evidence and differences after a destination is removed", async () => {
  writeFileSync(join(root, "two", unit, "extra"), "unique");
  await runPairJob(config, unit, peers, "deep", { actor: "cli", onEvent: () => {} });
  const before = loadHistorySnapshot().length;
  const recorded = archiveLedger(
    config,
    loadState(),
    new Map(peers.map((n) => [n, "ok" as const])),
    Date.now(),
  ).records[0]!.archive.pairs[0]!;
  const view = render(<App config={{ ...config, targets: [config.targets[0]!] }} />);
  const see = (text: string) =>
    waitFor(() => (view.lastFrame() ?? "").includes(text), { what: text });
  try {
    await see("one ↔ two");
    expect(view.lastFrame()).toContain("one ↔ two · " + stamp(recorded.at));
    view.stdin.write("c");
    await see("Historical · deep");
    await see("Only on two · extra");
    await see("Destination pair is no longer configured");
    expect(view.lastFrame()).not.toContain("[d] deep");
    view.stdin.write("d");
    await see("[r] refresh");
    expect(loadHistorySnapshot()).toHaveLength(before);
  } finally {
    view.unmount();
  }
});

test("incomplete local measurements show an unknown size and retry when a check is requested", async () => {
  renameSync(join(root, "away"), join(config.source, unit));
  let incomplete = true;
  const measure: typeof fingerprint = (...args) => ({
    ...fingerprint(...args),
    complete: !incomplete,
  });
  const view = render(<App config={config} measureFolder={measure} />);
  const see = (text: string) =>
    waitFor(() => (view.lastFrame() ?? "").includes(text), { what: text });
  try {
    await see("Local size unavailable");
    await see("No local copies measured");
    view.stdin.write("q");
    await see("Could not measure the complete local folder");
    expect(loadHistorySnapshot().some((x) => x.outcome === "skipped" && x.unit === unit)).toBe(
      true,
    );
    expect(loadState().scans).toHaveLength(0);
    incomplete = false;
    view.stdin.write("q");
    await waitFor(() => loadState().scans.filter((s) => s.unit === unit).length === 2, {
      what: "fresh measurements on both destinations",
    });
    await waitFor(() => !(view.lastFrame() ?? "").includes("Local size unavailable"), {
      what: "complete local size",
    });
  } finally {
    view.unmount();
  }
}, 30_000);

test("returning local copy needs a fresh sync review even after switching destinations", async () => {
  renameSync(join(root, "away"), join(config.source, unit));
  for (const peer of peers) renameSync(join(root, peer, unit), join(root, peer + "-held"));
  const view = render(<App config={config} />);
  const see = (text: string) =>
    waitFor(() => (view.lastFrame() ?? "").includes(text), { what: text }).catch((error) => {
      throw new Error(String(error) + "\n" + view.lastFrame());
    });
  try {
    await see("photos ..");
    view.stdin.write("q");
    await see("quick check finished");
    view.stdin.write("s");
    await see("[enter] run");
    view.stdin.write("\t");
    await see("[tab] switch to one");
    await see("[enter] run");
    renameSync(join(config.source, unit), join(root, "reviewed"));
    mkdirSync(join(config.source, unit));
    writeFileSync(join(config.source, unit, "replacement"), "new local copy");
    view.stdin.write(ENTER);
    await see("local copy changed after review");
    expect(existsSync(join(root, "two", unit))).toBe(false);
    view.stdin.write(ESC);
    await see("awaiting check");
  } finally {
    view.unmount();
  }
}, 30_000);

test("choose destination discovery scope before inspecting any roots", async () => {
  mkdirSync(join(root, "two", "watercolors"));
  renameSync(join(root, "one"), join(root, "unmounted"));
  const view = render(<App config={config} />);
  const see = (text: string) =>
    waitFor(() => (view.lastFrame() ?? "").includes(text), { what: text });
  try {
    await see("Absent locally");
    view.stdin.write("a");
    await see("[s] choose destinations");
    view.stdin.write("s");
    await see("» [x] one");
    view.stdin.write(" ");
    await see("» [ ] one");
    view.stdin.write(ENTER);
    await see("watercolors · two");
    expect(view.lastFrame()).toContain("copies on two");
    expect(view.lastFrame()).not.toContain("Could not inspect one");
    view.stdin.write("s");
    await see("» [ ] one");
    view.stdin.write(" ");
    await see("» [x] one");
    view.stdin.write(ENTER);
    await see("Could not inspect one");
    expect(view.lastFrame()).toContain("copies on all destinations");
  } finally {
    view.unmount();
  }
});

test("destination discovery can track a new folder while another destination is offline", async () => {
  const newUnit = "watercolors";
  mkdirSync(join(root, "two", newUnit));
  renameSync(join(root, "one"), join(root, "unmounted"));
  const view = render(<App config={config} />);
  const see = (text: string) =>
    waitFor(() => (view.lastFrame() ?? "").includes(text), { what: text });
  try {
    await see("Absent locally");
    view.stdin.write("a");
    await see("Remembered folders");
    view.stdin.write("f");
    await see(newUnit + " · two");
    await see("Could not inspect one");
    view.stdin.write("/");
    await see("[enter] apply filter");
    view.stdin.write("Water");
    await see("» " + newUnit);
    view.stdin.write(ENTER);
    await see("[enter] track folder");
    view.stdin.write(ENTER);
    await see("» " + newUnit + " ..");
    expect(catalogFolders(config).map((r) => r.unit)).toEqual([unit, newUnit]);
  } finally {
    view.unmount();
  }
});

test("the pair picker names both endpoints before work starts and supports revisiting the choice", async () => {
  config = {
    ...config,
    targets: [
      ...config.targets,
      { ...config.targets[0]!, name: "three", path: join(root, "unmounted") },
    ],
  };
  const view = render(<App config={config} />);
  const see = (text: string) =>
    waitFor(() => (view.lastFrame() ?? "").includes(text), { what: text });
  try {
    await see("Absent locally");
    view.stdin.write("d");
    await see("Choose two destinations");
    view.stdin.write("j");
    await see("» one ↔ three");
    view.stdin.write(ENTER);
    await see("[enter] deep check");
    expect(view.lastFrame()).toContain("three · not connected");
    view.stdin.write("c");
    await see("Choose two destinations");
    expect(view.lastFrame()).toContain("» one ↔ three");
    view.stdin.write(ENTER);
    await see("[enter] deep check");
    view.stdin.write(ESC);
    await see("[enter] copies");
    expect(view.lastFrame()).toContain("one ↔ three");
    view.stdin.write("c");
    await see("These copies have not been compared");
    expect(view.lastFrame()).toContain("one ↔ three");
  } finally {
    view.unmount();
  }
});

test("escape cancels the running comparison and keeps its folder open", async () => {
  const reach = new Map(peers.map((name) => [name, "ok" as const]));
  const archive = archiveLedger(config, loadState(), reach, Date.now()).records[0]!.archive;
  let signal: AbortSignal | undefined;
  let closed = false;
  let refreshed = false;
  const view = render(
    <PairView
      config={config}
      width={76}
      height={12}
      theme={resolveTheme()}
      unit={unit}
      archive={archive}
      selectedPair={undefined}
      onSelectPair={() => {}}
      refresh={() => {
        refreshed = true;
      }}
      onClose={() => {
        closed = true;
      }}
      compare={(_config, _unit, _peers, _method, options) => {
        signal = options.signal;
        return new Promise<never>((_, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }),
        );
      }}
    />,
  );
  try {
    await waitFor(() => (view.lastFrame() ?? "").includes("one ↔ two"), {
      what: "named comparison",
    });
    view.stdin.write("d");
    await waitFor(() => (view.lastFrame() ?? "").includes("[esc] cancel comparison"), {
      what: "running cancellation control",
    });
    view.stdin.write(ESC);
    await waitFor(() => (view.lastFrame() ?? "").includes("Comparison cancelled"), {
      what: "terminal cancellation outcome",
    });
    expect(signal?.aborted).toBe(true);
    expect(refreshed).toBe(true);
    expect(closed).toBe(false);
    expect(view.lastFrame()).toContain("one ↔ two");
    view.stdin.write(ESC);
    await waitFor(() => closed, { what: "back to the ledger after cancellation" });
  } finally {
    view.unmount();
  }
});

for (const columns of [76, 92, 120]) {
  test("archive screens fit " + columns + " columns and a short terminal", async () => {
    const width = columns - 2;
    const height = 12;
    const longUnit = "長".repeat(80);
    mkdirSync(join(root, "local", longUnit));
    const reach = new Map(peers.map((name) => [name, "ok" as const]));
    const archive = archiveLedger(config, loadState(), reach, Date.now()).records.find(
      (r) => r.unit === longUnit,
    )!.archive;
    const props = { config, width, height, theme: resolveTheme(), onClose: () => {} };
    const picker = render(<FolderPicker {...props} onChange={() => {}} onChoose={() => {}} />);
    const pair = render(
      <PairView
        {...props}
        unit={longUnit}
        archive={archive}
        selectedPair={undefined}
        onSelectPair={() => {}}
        refresh={() => {}}
      />,
    );
    try {
      await waitFor(() => (picker.lastFrame() ?? "").includes("長"), {
        what: "remembered long folder name",
      });
      for (const view of [picker, pair]) {
        const lines = (view.lastFrame() ?? "").split("\n");
        expect(lines.length).toBeLessThanOrEqual(height);
        for (const line of lines) expect(displayWidth(line), line).toBeLessThanOrEqual(columns);
        expect(lines.at(-1)).toContain("esc");
      }
      picker.stdin.write("s");
      await waitFor(() => (picker.lastFrame() ?? "").includes("Choose destinations to inspect"), {
        what: "scope chooser",
      });
      const scopeLines = (picker.lastFrame() ?? "").split("\n");
      expect(scopeLines.length).toBeLessThanOrEqual(height);
      for (const line of scopeLines) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
      expect(scopeLines.at(-1)).toContain("[esc] back");
    } finally {
      picker.unmount();
      pair.unmount();
    }
  });
}
