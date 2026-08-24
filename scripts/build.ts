/**
 * Compiles the self-contained binary.
 *
 * With no flags it builds for the platform it runs on, so `bun run build`
 * produces a usable `syncy` on any supported machine. `--target=<name>` builds
 * one specific target, and `--all` builds every supported target — that is
 * what the release workflow runs.
 *
 * The output is named `syncy-<target>` so a machine can keep builds for more
 * than one target without overwriting the one it runs. The native build keeps
 * the plain `syncy` name that the rest of the tooling (the testdata runner)
 * already expects.
 */

const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"] as const;
type Target = (typeof TARGETS)[number];

function nativeTarget(): Target {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  if (platform === null) throw new Error(`unsupported platform: ${process.platform}`);
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (arch === null) throw new Error(`unsupported architecture: ${process.arch}`);
  const target = `bun-${platform}-${arch}`;
  if (!(TARGETS as readonly string[]).includes(target)) {
    throw new Error(`no release target for ${target}`);
  }
  return target;
}

function build(target: Target, outfile: string): void {
  const result = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      "--minify",
      `--target=${target}`,
      "src/cli.ts",
      `--outfile=${outfile}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
}

const args = process.argv.slice(2);

if (args.includes("--all")) {
  for (const target of TARGETS) build(target, `syncy-${target}`);
} else {
  const flag = args.find((a) => a.startsWith("--target="));
  if (flag !== undefined) {
    const target = flag.slice("--target=".length);
    if (!(TARGETS as readonly string[]).includes(target)) {
      throw new Error(`unknown target ${target}; expected one of ${TARGETS.join(", ")}`);
    }
    build(target, `syncy-${target}`);
  } else {
    build(nativeTarget(), "syncy");
  }
}
