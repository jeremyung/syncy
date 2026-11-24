import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogFolders, trackFolder } from "../src/archive-catalog.ts";
import { compareCopies, pairEvidence } from "../src/archive-pair.ts";
import { type Config, parseConfig } from "../src/config.ts";
import { SENTINEL_NAME } from "../src/sentinel.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

let root: string;
let previous: string | undefined;
let config: Config;
beforeEach(() => {
  previous = process.env.XDG_STATE_HOME;
  root = makeFixtureDir("archive");
  process.env.XDG_STATE_HOME = join(root, "state");
  for (const name of ["local", "one", "two"]) {
    mkdirSync(join(root, name, "photos"), { recursive: true });
    writeFileSync(join(root, name, "photos", "image"), "same");
    utimesSync(join(root, name, "photos", "image"), 100000, 100000);
    utimesSync(join(root, name, "photos"), 100000, 100000);
    if (name !== "local") writeFileSync(join(root, name, SENTINEL_NAME), name);
  }
  config = parseConfig(
    "source = " +
      JSON.stringify(join(root, "local")) +
      "\n" +
      ["one", "two"]
        .map(
          (name) =>
            '[[target]]\nname="' +
            name +
            '"\npath=' +
            JSON.stringify(join(root, name)) +
            '\nsentinel="' +
            name +
            '"\n',
        )
        .join(""),
  );
});
afterEach(() => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previous;
  removeFixtureDir(root);
});

test("absent, inaccessible, stopped and returned folders retain their one catalog entry", () => {
  expect(catalogFolders(config, 1)[0]?.local).toBe("present");
  renameSync(join(root, "local", "photos"), join(root, "away"));
  expect(catalogFolders(config, 2)[0]?.local).toBe("absent");
  renameSync(join(root, "local"), join(root, "offline"));
  expect(catalogFolders(config, 3)[0]?.local).toBe("unavailable");
  renameSync(join(root, "offline"), join(root, "local"));
  renameSync(join(root, "away"), join(root, "local", "photos"));
  trackFolder(config, "photos", false);
  expect(catalogFolders(config, 4)).toEqual([
    { unit: "photos", active: 0, local: "present", since: 4 },
  ]);
  trackFolder(config, "photos");
  trackFolder(config, "photos");
  expect(catalogFolders(config, 5)).toEqual([
    { unit: "photos", active: 1, local: "present", since: 4 },
  ]);
});
test("pair checks read bytes, detect a destination-only path, and preserve the source trees", async () => {
  const run = (method: "deep" | "quick") => compareCopies(config, "photos", ["two", "one"], method);
  expect((await run("deep")).outcome).toBe("agree");
  const file = join(root, "two", "photos", "image");
  writeFileSync(file, "else");
  utimesSync(file, 100000, 100000);
  expect((await run("quick")).outcome).toBe("agree");
  expect((await run("deep")).counts["Content differs"]).toBe(1);
  writeFileSync(join(root, "two", "photos", "extra"), "unique");
  const changed = await run("deep");
  expect(changed.counts["Only on two"]).toBe(1);
  expect(changed.samples.some((s) => s.kind === "Only on two" && s.name === "extra")).toBe(true);
  expect(await Bun.file(join(root, "two", "photos", "extra")).text()).toBe("unique");
  const offline = pairEvidence(
    config,
    "photos",
    new Map([
      ["one", "ok"],
      ["two", "unreachable"],
    ]),
    Date.now(),
  );
  expect(offline.every((r) => !r.current)).toBe(true);
});

test("a quick difference permanently invalidates an older clean checksum", async () => {
  const run = (method: "quick" | "deep") => compareCopies(config, "photos", ["one", "two"], method);
  const verified = await run("deep");
  const extra = join(root, "two/photos/extra");
  writeFileSync(extra, "x");
  await run("quick");
  renameSync(extra, join(root, "removed-extra"));
  utimesSync(join(root, "two/photos"), 100000, 100000);
  expect((await run("quick")).outcome).toBe("agree");
  const rows = pairEvidence(
    config,
    "photos",
    new Map([
      ["one", "ok"],
      ["two", "ok"],
    ]),
    Date.now(),
  );
  expect(rows.find((r) => r.at === verified.at && r.method === "deep")?.current).toBe(false);
});

test("deep agreement expires when its file inventory is stale", async () => {
  const result = await compareCopies(config, "photos", ["one", "two"], "deep");
  const later = result.at + (config.maxQuickAgeDays + 1) * 86400000;
  expect(
    pairEvidence(
      config,
      "photos",
      new Map([
        ["one", "ok"],
        ["two", "ok"],
      ]),
      later,
    )[0]?.current,
  ).toBe(false);
});

test("substituting an entry type identifies the shared path on both copies", async () => {
  mkdirSync(join(root, "one/photos/changed"));
  writeFileSync(join(root, "two/photos/changed"), "a");
  const result = await compareCopies(config, "photos", ["one", "two"], "deep");
  expect(result.counts["Entry type differs"]).toBe(1);
  expect(result.counts["Only on one"]).toBeUndefined();
});

test("the post-run boundary rejects an endpoint directory that has been replaced", async () => {
  let changed = false;
  await expect(
    compareCopies(config, "photos", ["one", "two"], "deep", {
      phase: (phase) => {
        if (phase === "recording-evidence" && !changed) {
          changed = true;
          renameSync(join(root, "two/photos"), join(root, "previous"));
          mkdirSync(join(root, "two/photos"));
          writeFileSync(join(root, "two/photos/image"), "same");
          utimesSync(join(root, "two/photos/image"), 100000, 100000);
          utimesSync(join(root, "two/photos"), 100000, 100000);
        }
      },
    }),
  ).rejects.toThrow(/changed/);
  expect(pairEvidence(config, "photos", new Map(), Date.now())).toEqual([]);
});

test("shared metadata rules and timestamps determine whether a dated observation is current", async () => {
  const [a, b] = config.targets;
  config = {
    ...config,
    targets: [{ ...a!, modifyWindow: 2, flagsDrop: ["-p"] }, b!],
    exclude: ["preview-*"],
  };
  utimesSync(join(root, "two/photos/image"), 100001, 100001);
  chmodSync(join(root, "two/photos/image"), 0o400);
  writeFileSync(join(root, "two/photos/preview-small"), "excluded");
  utimesSync(join(root, "two/photos"), 100000, 100000);
  const result = await compareCopies(config, "photos", ["one", "two"], "deep");
  expect(result.outcome).toBe("agree");
  expect(result.comparisonRules).toContain("Timestamp tolerance 2s");
  expect(result.comparisonRules).toContain("permissions");
  expect(result.comparisonRules).toContain("preview-*");
  const reach = new Map([
    ["one", "ok"],
    ["two", "ok"],
  ] as const);
  expect(pairEvidence({ ...config, exclude: [] }, "photos", reach, Date.now())[0]?.current).toBe(
    false,
  );
  expect(pairEvidence(config, "photos", reach, result.at - 1)[0]?.current).toBe(false);
});

test("missing and substituted volumes retain the last dated result without establishing a fresh match", async () => {
  renameSync(join(root, "one/photos"), join(root, "absent"));
  expect((await compareCopies(config, "photos", ["one", "two"], "quick")).detail).toBe(
    "Folder missing on one",
  );
  renameSync(join(root, "two/photos"), join(root, "also-absent"));
  const both = await compareCopies(config, "photos", ["two", "one"], "deep");
  expect(both.outcome).toBe("missing");
  expect(both.detail).toContain("one and two");
  writeFileSync(join(root, "two", SENTINEL_NAME), "replacement");
  await expect(compareCopies(config, "photos", ["one", "two"], "deep")).rejects.toThrow(/two/);
  const past = pairEvidence(
    config,
    "photos",
    new Map([
      ["one", "ok"],
      ["two", "mismatch"],
    ]),
    Date.now(),
  );
  expect(past.every((r) => !r.current)).toBe(true);
  expect(past.find((r) => r.method === "deep")?.at).toBe(both.at);
});

test("cancellation, vanished files and partial transfer exits produce no verification evidence", async () => {
  for (const code of [23, 24]) {
    const bin = join(root, "exit-code-" + code);
    writeFileSync(bin, "#!/bin/sh\nexit " + code + "\n", { mode: 0o700 });
    await expect(compareCopies(config, "photos", ["one", "two"], "deep", { bin })).rejects.toThrow(
      "exit " + code,
    );
  }
  const cancel = new AbortController();
  await expect(
    compareCopies(config, "photos", ["two", "one"], "deep", {
      signal: cancel.signal,
      phase: (phase) => {
        if (phase === "recording-evidence") cancel.abort();
      },
    }),
  ).rejects.toThrow();
  expect(pairEvidence(config, "photos", new Map(), Date.now())).toEqual([]);
});

test("selection cannot compare a folder to an alias of itself or follow a unit symlink", async () => {
  const [one, two] = config.targets;
  const alias = join(root, "alias");
  symlinkSync(one!.path, alias);
  const aliased = { ...config, targets: [one!, { ...two!, path: alias, sentinel: "one" }] };
  await expect(compareCopies(aliased, "photos", ["one", "two"], "deep")).rejects.toThrow(
    "distinct",
  );
  await expect(compareCopies(config, "photos", ["one", "one"], "deep")).rejects.toThrow("distinct");
  await expect(compareCopies(config, "../photos", ["two", "one"], "quick")).rejects.toThrow(
    "immediate",
  );
  renameSync(join(root, "two/photos"), join(root, "outside"));
  symlinkSync(join(root, "outside"), join(root, "two/photos"));
  await expect(compareCopies(config, "photos", ["two", "one"], "deep")).rejects.toThrow(
    "not a directory",
  );
  expect(pairEvidence(config, "photos", new Map(), Date.now())).toEqual([]);
});

test("counts stay exact beyond the bounded samples in both picker orders", async () => {
  for (let i = 0; i < 102; i++) writeFileSync(join(root, "one/photos", "frame-" + i), "x");
  writeFileSync(join(root, "two/photos", "other"), "y");
  for (const names of [
    ["one", "two"],
    ["two", "one"],
  ]) {
    const result = await compareCopies(config, "photos", names, "quick");
    expect(result.counts["Only on one"]).toBe(102);
    expect(result.counts["Only on two"]).toBe(1);
    expect(result.samples).toHaveLength(100);
    expect(result.endpoints).toEqual(["one", "two"]);
  }
});

test("escaped filename bytes, hash digits, pipes and trailing spaces survive pair differences", async () => {
  const names = ["literal#123", "tab\tname", "one|two", "space "];
  for (const name of names) {
    mkdirSync(join(root, "one/photos", name));
    writeFileSync(join(root, "two/photos", name), "replaced type");
  }
  writeFileSync(join(root, "two/photos/loose "), "extra");
  const result = await compareCopies(config, "photos", ["one", "two"], "deep");
  expect(result.counts["Entry type differs"]).toBe(4);
  expect(result.samples.map((s) => s.name)).toContain("loose ");
  expect(result.samples.map((s) => s.name)).toContain("space /");
  expect(result.samples.map((s) => s.name)).toContain("one|two/");
  expect(result.samples.map((s) => s.name)).toContain("literal#123/");
});

test("a post-check fingerprint detects an in-place file change between comparison and recording", async () => {
  let inventories = 0;
  await expect(
    compareCopies(config, "photos", ["one", "two"], "deep", {
      phase: (phase) => {
        if (phase === "fingerprinting-destination" && ++inventories === 2)
          writeFileSync(join(root, "two/photos/image"), "longer");
      },
    }),
  ).rejects.toThrow("changed");
  expect(pairEvidence(config, "photos", new Map(), Date.now())).toEqual([]);
});

test("one extra file alone prevents a deep agreement regardless of picker order", async () => {
  writeFileSync(join(root, "two/photos/single-extra"), "only here");
  utimesSync(join(root, "two/photos"), 100000, 100000);
  for (const names of [
    ["two", "one"],
    ["one", "two"],
  ]) {
    const result = await compareCopies(config, "photos", names, "deep");
    expect(result.outcome).toBe("different");
    expect(result.counts).toEqual({ "Only on two": 1 });
  }
});

test("restoring a prior rule set cannot resurrect a checksum contradicted by a newer pair check", async () => {
  const names = ["one", "two"];
  const first = await compareCopies(config, "photos", names, "deep");
  writeFileSync(join(root, "two/photos/changed"), "later");
  await compareCopies({ ...config, exclude: ["unrelated.tmp"] }, "photos", names, "quick");
  const results = pairEvidence(
    config,
    "photos",
    new Map([
      ["one", "ok"],
      ["two", "ok"],
    ]),
    Date.now(),
  );
  expect(results.find((row) => row.at === first.at && row.method === "deep")?.current).toBe(false);
});
