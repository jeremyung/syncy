#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EMPTY_CONFIG, serializeConfig, withTarget } from "../src/configio.ts";
import { DEFAULT_RSYNC } from "../src/rsync.ts";
import { identify } from "../src/volume.ts";

/**
 * Builds a throwaway archive to test syncy against.
 *
 *   testdata/
 *     input/            the source root — folders here are what syncy tracks
 *     output/<name>/    one directory per target, named by --targets
 *     config/  state/   syncy's own directories, redirected here
 *
 * The whole tree is gitignored, and because config and state are redirected
 * into it, nothing this creates can reach your real ~/.config/syncy or a real
 * drive.
 *
 * By default the outputs are EMPTY, so you can drive the full loop yourself:
 * missing -> sync -> quick check -> deep verify -> verified. Pass --seeded for
 * a tree already in mixed states, if you would rather look at the ledger than
 * build it up.
 */

const ROOT = resolve(import.meta.dir, "..", "testdata");
const INPUT = join(ROOT, "input");
const OUTPUT = join(ROOT, "output");
const CONFIG_HOME = join(ROOT, "config");
const STATE_HOME = join(ROOT, "state");

const seeded = process.argv.includes("--seeded");

/**
 * Target names are yours to choose — syncy has no notion of an "external" or a
 * "nas", only of N named destinations. Pass `--targets a,b,c` for any number.
 */
function targetNames(): string[] {
  const flag = process.argv.find((a) => a.startsWith("--targets="));
  const inline = flag?.slice("--targets=".length);
  const spaced = process.argv[process.argv.indexOf("--targets") + 1];
  const raw = inline ?? (process.argv.includes("--targets") ? spaced : undefined);
  const names = (raw ?? "external,nas")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (names.length === 0) throw new Error("--targets needs at least one name");
  if (new Set(names).size !== names.length) throw new Error("--targets names must be unique");
  return names;
}

const TARGETS = targetNames();
const targetPath = (name: string): string => join(OUTPUT, name);

/** Deterministic filler, so sizes are predictable but contents differ. */
function makeFile(path: string, kb: number, seed: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = `${seed} ${"x".repeat(60)}\n`;
  writeFileSync(path, line.repeat(Math.max(1, Math.round((kb * 1024) / line.length))));
}

interface Folder {
  readonly name: string;
  readonly files: number;
  readonly kb: number;
  /**
   * Which targets hold a copy, by index into TARGETS — so the seeded states
   * work for any number of targets with any names.
   */
  readonly on: (n: number) => number[];
  /** Files to remove from one target afterwards, leaving it behind. */
  readonly short?: { readonly index: number; readonly count: number };
}

const all = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

const FOLDERS: readonly Folder[] = [
  { name: "photos-2019", files: 12, kb: 40, on: all },
  { name: "photos-2024", files: 10, kb: 64, on: all, short: { index: 0, count: 3 } },
  { name: "projects-archive", files: 8, kb: 16, on: (n) => (n > 1 ? [n - 1] : []) },
  { name: "video-raw", files: 4, kb: 256, on: () => [] },
  { name: "documents", files: 20, kb: 8, on: () => [0] },
];

async function replicate(from: string, to: string): Promise<void> {
  mkdirSync(to, { recursive: true });
  const proc = Bun.spawn([DEFAULT_RSYNC, "-a", from + "/", to + "/"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`rsync failed: ${err.trim()}`);
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  for (const d of [INPUT, CONFIG_HOME, STATE_HOME, ...TARGETS.map(targetPath)]) {
    mkdirSync(d, { recursive: true });
  }

  for (const f of FOLDERS) {
    for (let i = 0; i < f.files; i++) {
      makeFile(join(INPUT, f.name, `${f.name}-${String(i).padStart(3, "0")}.dat`), f.kb, f.name);
    }
    // A stray macOS artefact, so the exclude list has something real to do.
    makeFile(join(INPUT, f.name, ".DS_Store"), 1, "junk");
  }

  // Destinations are identified by asking the OS which volume is mounted there;
  // nothing is written into them.
  process.env["XDG_STATE_HOME"] = STATE_HOME;
  const identities = new Map<string, { id: string; kind: "volume-uuid" | "mount-source" }>();
  for (const name of TARGETS) {
    const found = await identify(targetPath(name));
    if (found === null) throw new Error(`could not identify the volume at ${targetPath(name)}`);
    identities.set(name, { id: found.id, kind: found.kind });
  }

  if (seeded) {
    for (const f of FOLDERS) {
      for (const i of f.on(TARGETS.length)) {
        await replicate(join(INPUT, f.name), join(targetPath(TARGETS[i]!), f.name));
      }
      if (f.short !== undefined && f.short.index < TARGETS.length) {
        const dir = join(targetPath(TARGETS[f.short.index]!), f.name);
        for (let i = 0; i < f.short.count; i++) {
          rmSync(join(dir, `${f.name}-${String(i).padStart(3, "0")}.dat`), { force: true });
        }
      }
    }
  }

  let config = { ...EMPTY_CONFIG(INPUT), exclude: [".DS_Store", "._*"] };
  for (const name of TARGETS) {
    config = withTarget(config, {
      name,
      path: targetPath(name),
      required: true,
      identity: identities.get(name)!.id,
      identityKind: identities.get(name)!.kind,
      fstype: "apfs",
      modifyWindow: 0,
      flagsDrop: [],
    });
  }

  const configFile = join(CONFIG_HOME, "syncy", "config.toml");
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, serializeConfig(config), "utf8");

  // Rebuilding generates fresh sentinels. If the user's real config points into
  // this tree — convenient, so plain `syncy` opens on it — those sentinels are
  // now stale and every folder would read `sentinel mismatch`. Refresh it.
  const realConfig = join(homedir(), ".config", "syncy", "config.toml");
  let refreshed = false;
  try {
    if (existsSync(realConfig) && readFileSync(realConfig, "utf8").includes(ROOT)) {
      writeFileSync(realConfig, serializeConfig(config), "utf8");
      refreshed = true;
    }
  } catch {
    // A config we cannot read is one we must not overwrite.
  }

  const total = FOLDERS.reduce((a, f) => a + f.files * f.kb, 0);
  console.log(`testdata ready — ${FOLDERS.length} folders, ~${Math.round(total / 1024)} mb

  testdata/
    input/                    the source root
${FOLDERS.map((f) => `      ${f.name.padEnd(20)} ${f.files} files`).join("\n")}
${TARGETS.map((n, i) => `    output/${(n + "/").padEnd(22)} destination ${i + 1}${seeded ? "" : "  (empty)"}`).join("\n")}
    config/  state/           syncy's own directories, redirected here

${refreshed ? `Refreshed ${realConfig}, which pointed at this tree — its sentinels\nwould otherwise be stale and every folder would read \`sentinel mismatch\`.\n\n` : ""}Nothing here can reach your real config, state or drives.

  ./scripts/testdata-run.sh            open the ledger
  ./scripts/testdata-run.sh status     print it and exit
  ./scripts/testdata-run.sh doctor     check rsync and reachability
`);

  if (!seeded) {
    console.log(`Nothing has been checked yet, so every folder reads \`unknown\` — syncy
does not assume a destination is empty just because it has not looked.
Press q first and they become \`missing\`. To drive the whole loop:

  q   quick check      — asks the destinations what is actually there
  s   sync             — copies the selected folder to a destination
  d   deep verify      — checksums both sides; the only route to \`verified\`

All ${TARGETS.length} destination(s) are required, so a folder needs syncing to each.
Prefer a tree already in mixed states?  bun run testdata --seeded
Different destinations?  bun run testdata --targets=laptop,offsite,archive
`);
  }
}

await main();
