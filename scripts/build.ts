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

/**
 * Ink keeps its optional DevTools integration behind `DEV=true`, but Bun's
 * bundler cannot prove that a runtime environment variable is false. The
 * resulting production executable used to carry the DevTools client (and its
 * optional react-devtools-core import) even though syncy never enables it.
 * Patch both upstream development guards in the build graph (DevTools and
 * development renderer metadata); node_modules itself is never modified, and
 * development-only behavior cannot enter the release bundle.
 */
const noInkDevtools: Bun.BunPlugin = {
  name: "syncy-production-ink",
  setup(build) {
    build.onLoad({ filter: /reconciler/ }, async (args) => {
      if (!/[\\/]ink[\\/]build[\\/]reconciler\.js$/.test(args.path)) return;
      const source = await Bun.file(args.path).text();
      const guard = "if (process.env['DEV'] === 'true') {";
      const guardCount = source.split(guard).length - 1;
      if (guardCount !== 2) {
        throw new Error(`expected two Ink development guards in ${args.path}; found ${guardCount}`);
      }
      return { contents: source.replaceAll(guard, "if (false) {"), loader: "js" };
    });
  },
};

async function build(target: Target, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["src/cli.ts"],
    target: "bun",
    minify: true,
    // React's development reconciler is several hundred kilobytes and
    // carries diagnostics useful only while developing. Defining the
    // condition explicitly selects React's lean runtime even if a developer
    // has NODE_ENV set differently in their shell.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    external: ["react-devtools-core"],
    plugins: [noInkDevtools],
    compile: { target, outfile },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

const args = process.argv.slice(2);

if (args.includes("--all")) {
  for (const target of TARGETS) await build(target, `syncy-${target}`);
} else {
  const flag = args.find((a) => a.startsWith("--target="));
  if (flag !== undefined) {
    const target = flag.slice("--target=".length);
    if (!(TARGETS as readonly string[]).includes(target)) {
      throw new Error(`unknown target ${target}; expected one of ${TARGETS.join(", ")}`);
    }
    await build(target, `syncy-${target}`);
  } else {
    await build(nativeTarget(), "syncy");
  }
}
