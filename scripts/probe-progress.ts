#!/usr/bin/env bun
/**
 * Does rsync stream its itemize output for *this* archive?
 *
 * The ledger's file counter sat at 0/935 for a twelve-minute deep check that
 * was in fact working. In a local fixture — 40,000 files a side — the lines
 * stream evenly and syncy's own reader sees all 40,000 as they arrive, so the
 * plumbing is not obviously at fault. The difference that could not be tested
 * here is the archive itself: large files, over SMB, on a real NAS.
 *
 * So this runs the exact argv syncy builds, against the real config, and
 * timestamps what comes back. It settles which half is wrong.
 *
 * Read-only. It builds a check argv, which is always `-n`, and it writes
 * nothing: no state, no history, no diff, nothing to the target.
 */
import { loadConfig } from "./../src/config.ts";
import { configFile } from "./../src/paths.ts";
import { assertDeleteIsDryRun, buildArgv, DEFAULT_RSYNC, type Mode } from "./../src/rsync.ts";
import { join } from "node:path";
import { parseItemizeLine } from "./../src/itemize.ts";

const args = process.argv.slice(2);
const outbuf = args.includes("--outbuf") ? (args.splice(args.indexOf("--outbuf"), 1), true) : false;
const [unitArg, targetArg, modeArg = "deep", secsArg = "120"] = args;
if (unitArg === undefined) {
  console.error("usage: bun scripts/probe-progress.ts <folder> [target] [quick|deep] [seconds] [--outbuf]");
  process.exit(2);
}
const mode = modeArg as Mode;
const limitMs = Number(secsArg) * 1000;

const config = loadConfig(configFile());
const target = targetArg === undefined ? config.targets[0] : config.targets.find((t) => t.name === targetArg);
if (target === undefined) {
  console.error(`no such target; configured: ${config.targets.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

const argv = buildArgv(
  mode,
  join(config.source, unitArg),
  { ...target, path: join(target.path, unitArg) },
  config.exclude,
);
/**
 * `--outbuf=L` is the hypothesis under test.
 *
 * rsync block-buffers stdout when it is a pipe. At a high line rate the buffer
 * fills constantly and the output looks like it streams — which is exactly what
 * a 40,000-file fixture showed. A 935-file archive over SMB emits roughly 40
 * bytes a second, so an 8 KB buffer takes about three minutes to fill, and the
 * reader sees nothing at all until it does. Line buffering removes the wait.
 */
if (outbuf) argv.push("--outbuf=L");

// The same guard the app runs. A probe is still a program that spawns rsync.
assertDeleteIsDryRun(argv);

/**
 * Shell-quoted, because this line gets copied.
 *
 * The unquoted form looks harmless and is not: zsh reads the `|` in
 * `--out-format=%i|%l|%n` as a pipe and expands the `*` in `--exclude=.syncy-*`
 * as a glob. The probe itself spawns rsync with an argv array and never goes
 * near a shell, so this string is only ever documentation — but documentation
 * that gets pasted into a prompt needs to survive the paste.
 */
const shellQuote = (s: string): string => (/^[A-Za-z0-9_.\/=:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
console.log(`\n  ${shellQuote(DEFAULT_RSYNC)} ${argv.map(shellQuote).join(" ")}\n`);
console.log(`  read-only · stopping after ${secsArg}s · ctrl-c any time\n`);

const proc = Bun.spawn([DEFAULT_RSYNC, ...argv], { stdout: "pipe", stderr: "pipe" });
const t0 = Date.now();
let n = 0;
let firstAt: number | null = null;
let lastAt = 0;

const stop = setTimeout(() => proc.kill(), limitMs);

/**
 * A heartbeat, because the interesting answer is *when* output starts.
 *
 * A silent probe is indistinguishable from a hung one — which is the very
 * complaint that started this. Printing the elapsed time and the running count
 * every fifteen seconds makes a long silence legible as a measurement rather
 * than a failure, and pins down the moment the first line arrives.
 */
const beat = setInterval(() => {
  const s = Math.round((Date.now() - t0) / 1000);
  console.log(`  ── ${String(s).padStart(4)}s · ${n} itemize lines so far`);
}, 15_000);
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of proc.stdout) {
  buf += decoder.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") continue;
    // rsync's own chatter ("sending incremental file list") is not progress.
    // Counting it is what made this script report "rsync streams" off a single
    // banner line while the itemize stream had produced nothing at all.
    if (parseItemizeLine(line) === null) continue;
    n += 1;
    const t = Date.now() - t0;
    if (firstAt === null) firstAt = t;
    lastAt = t;
    if (n <= 5 || n % 50 === 0) {
      console.log(`  ${String(n).padStart(6)}  ${(t / 1000).toFixed(1).padStart(7)}s  ${line.slice(0, 62)}`);
    }
  }
}
clearTimeout(stop);
clearInterval(beat);

const elapsed = (Date.now() - t0) / 1000;
console.log(`\n  ${n} lines in ${elapsed.toFixed(1)}s`);
if (n === 0) {
  console.log(`\n  VERDICT: no itemize lines in ${elapsed.toFixed(0)}s` + (outbuf ? " even with --outbuf=L." : "."));
  console.log(outbuf
    ? `  Line buffering is not the cause; the counter cannot work for this archive.`
    : `  Re-run with --outbuf to test whether block buffering is the cause.`);
} else {
  console.log(`  first line at ${((firstAt ?? 0) / 1000).toFixed(1)}s, last at ${(lastAt / 1000).toFixed(1)}s`);
  console.log(`\n  VERDICT: ${n} itemize lines arrived` + (outbuf ? " with --outbuf=L" : "") + `. rsync streams here,`);
  console.log(`  so syncy can show real progress` + (outbuf ? ` — add --outbuf=L to the check argv.` : `.`));
}
