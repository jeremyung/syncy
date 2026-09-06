import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEngineMessage } from "../src/protocol-jsonl.ts";
import { checkBuild, DEFAULT_RSYNC } from "../src/rsync.ts";
import { SENTINEL_NAME, writeSentinel } from "../src/sentinel.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

const build = await checkBuild(DEFAULT_RSYNC);
const describeRsync = build.ok ? describe : describe.skip;
let root: string;

async function runEngine(
  args: readonly string[],
  configHome: string,
  stateHome: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "engine", ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      SYNCY_ACTOR: "mac",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

afterEach(() => {
  if (root !== undefined) removeFixtureDir(root);
});

describeRsync("structured engine command", () => {
  test("configures a first-run source and manages destinations", async () => {
    root = makeFixtureDir("syncy-engine-setup");
    const source = join(root, "source");
    const destination = join(root, "second-destination");
    const configHome = join(root, "config-home");
    const stateHome = join(root, "state-home");
    mkdirSync(join(source, "photos"), { recursive: true });
    mkdirSync(destination, { recursive: true });

    const sourced = await runEngine(["set-source", source], configHome, stateHome);
    expect(sourced.exitCode).toBe(0);
    expect(parseEngineMessage(sourced.stdout)).toMatchObject({
      type: "snapshot",
      source,
      targets: [],
    });

    const added = await runEngine(
      ["add-destination", destination, "second"],
      configHome,
      stateHome,
    );
    expect(added.exitCode).toBe(0);
    expect(parseEngineMessage(added.stdout)).toMatchObject({
      type: "snapshot",
      targets: [{ name: "second", required: true }],
    });

    const adopted = await runEngine(["adopt-destination", "second"], configHome, stateHome);
    expect(adopted.exitCode).toBe(0);
    expect(parseEngineMessage(adopted.stdout)).toMatchObject({
      type: "snapshot",
      targets: [{ name: "second", reachability: "ok" }],
    });
    expect(existsSync(join(destination, SENTINEL_NAME))).toBe(true);

    const removed = await runEngine(["remove-destination", "second"], configHome, stateHome);
    expect(removed.exitCode).toBe(0);
    expect(parseEngineMessage(removed.stdout)).toMatchObject({ type: "snapshot", targets: [] });
    expect(existsSync(join(destination, "photos"))).toBe(false);
  }, 30_000);

  test("streams check events and preserves released ownership", async () => {
    root = makeFixtureDir("syncy-engine-cli");
    const source = join(root, "source");
    const destination = join(root, "destination");
    const configHome = join(root, "config-home");
    const stateHome = join(root, "state-home");
    mkdirSync(join(source, "photos"), { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(source, "photos", "one.txt"), "one");
    const sentinel = await writeSentinel(destination);
    const configDir = join(configHome, "syncy");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.toml"),
      `source = "${source}"

[status]
max_verify_age_days = 30
max_quick_age_days = 7
min_targets = 1

[[target]]
name = "archive"
path = "${destination}"
required = true
sentinel = "${sentinel}"
`,
    );

    const { stdout, stderr, exitCode } = await runEngine(
      ["check", "photos"],
      configHome,
      stateHome,
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => parseEngineMessage(line));
    expect(messages.map((message) => message.type)).toEqual([
      "job.started",
      "job.phase-changed",
      "job.phase-changed",
      "job.completed",
    ]);
    expect(
      messages.flatMap((message) => (message.type === "job.phase-changed" ? [message.phase] : [])),
    ).toEqual(["inspecting-source", "recording-evidence"]);
    expect(messages.at(-1)).toMatchObject({
      type: "job.completed",
      operation: "quick",
      result: { outcome: "missing", exitCode: null },
    });
    expect(readdirSync(join(stateHome, "syncy", "job-owners"))).toHaveLength(1);

    const differences = parseEngineMessage(
      (await runEngine(["diff", "photos", "archive"], configHome, stateHome)).stdout,
    );
    expect(differences).toMatchObject({
      type: "diff",
      unit: "photos",
      target: "archive",
      diff: { wholeFolderMissing: true },
    });
    const history = parseEngineMessage(
      (await runEngine(["history"], configHome, stateHome)).stdout,
    );
    expect(history).toMatchObject({
      type: "history",
      entries: [{ operation: "quick", outcome: "completed", unit: "photos" }],
    });

    const prepared = await runEngine(["preflight", "photos", "archive"], configHome, stateHome);
    expect(prepared.exitCode).toBe(0);
    expect(prepared.stderr).toBe("");
    const preparedMessage = parseEngineMessage(prepared.stdout);
    expect(preparedMessage).toMatchObject({
      type: "sync.preflight",
      ok: true,
      unit: "photos",
      target: "archive",
      nChanges: 1,
      nNew: 1,
    });
    if (
      preparedMessage.type !== "sync.preflight" ||
      preparedMessage.confirmationToken === undefined
    ) {
      throw new Error("preflight did not return a confirmation");
    }

    const synced = await runEngine(
      ["sync", preparedMessage.confirmationToken],
      configHome,
      stateHome,
    );
    expect(synced.exitCode).toBe(0);
    expect(synced.stderr).toBe("");
    const syncEvents = synced.stdout
      .trim()
      .split("\n")
      .map((line) => parseEngineMessage(line));
    expect(
      syncEvents.find((event) => event.type === "job.completed" && event.operation === "sync"),
    ).toMatchObject({
      type: "job.completed",
      operation: "sync",
      result: { exitCode: 0, transferred: 1 },
    });
    // The transfer records nothing the ledger reads, so the sync ends with a
    // quick check of the one destination it wrote to. Without it the row goes
    // on reporting the backlog its last check found, for files now copied.
    expect(syncEvents.at(-1)).toMatchObject({
      type: "job.completed",
      operation: "quick",
      unit: "photos",
      target: "archive",
      result: { outcome: "clean", nChanges: 0 },
    });
    expect(existsSync(join(destination, "photos", "one.txt"))).toBe(true);
    expect(readdirSync(join(stateHome, "syncy", "job-owners"))).toHaveLength(2);

    const reused = await runEngine(
      ["sync", preparedMessage.confirmationToken],
      configHome,
      stateHome,
    );
    expect(reused.exitCode).not.toBe(0);
    expect(reused.stderr).toContain("already been used");

    writeFileSync(join(source, "photos", "two.txt"), "two");
    expect((await runEngine(["check", "photos"], configHome, stateHome)).exitCode).toBe(0);
    const secondPreparation = await runEngine(
      ["preflight", "photos", "archive"],
      configHome,
      stateHome,
    );
    const secondMessage = parseEngineMessage(secondPreparation.stdout);
    if (secondMessage.type !== "sync.preflight" || secondMessage.confirmationToken === undefined) {
      throw new Error("second preflight did not return a confirmation");
    }
    writeFileSync(join(source, "photos", "three.txt"), "three");
    const changed = await runEngine(
      ["sync", secondMessage.confirmationToken],
      configHome,
      stateHome,
    );
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr).toContain("source changed after review");
    expect(existsSync(join(destination, "photos", "three.txt"))).toBe(false);

    const missed = await runEngine(
      ["record-missed", "sync", "photos", String(Date.now() - 1_000), "archive"],
      configHome,
      stateHome,
    );
    expect(missed).toMatchObject({ exitCode: 0, stderr: "" });
    const finalHistory = parseEngineMessage(
      (await runEngine(["history"], configHome, stateHome)).stdout,
    );
    if (finalHistory.type !== "history") throw new Error("history envelope missing");
    expect(finalHistory.entries).toContainEqual(
      expect.objectContaining({
        operation: "sync",
        outcome: "missed",
        unit: "photos",
        target: "archive",
      }),
    );
  }, 30_000);
});
