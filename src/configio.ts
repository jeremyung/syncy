import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Config, DEFAULTS, parseConfig, type Target } from "./config.ts";

/**
 * Writing the config back out (DESIGN.md section 7).
 *
 * The setup screen owns this file; it is not hand-authored. It is still parsed
 * and schema-validated on every read, because it can be edited or corrupted
 * between runs.
 */

/** TOML basic strings: escape backslash and quote, reject control characters. */
function tomlString(value: string): string {
  // Control characters cannot appear in a TOML basic string. The range is
  // written out by code point rather than as a regex class, because a literal
  // range or a \u-escape in the pattern is easy to mangle.
  if (
    Array.from(value).some((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new Error(
      `value contains a control character and cannot be written: ${JSON.stringify(value)}`,
    );
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const tomlArray = (values: readonly string[]): string => `[${values.map(tomlString).join(", ")}]`;

function target(t: Target): string {
  return [
    "[[target]]",
    `name          = ${tomlString(t.name)}`,
    `path          = ${tomlString(t.path)}`,
    `required      = ${t.required}`,
    ...(t.identity !== undefined ? [`identity      = ${tomlString(t.identity)}`] : []),
    ...(t.identityKind !== undefined ? [`identity_kind = ${tomlString(t.identityKind)}`] : []),
    ...(t.sentinel !== undefined ? [`sentinel      = ${tomlString(t.sentinel)}`] : []),
    `fstype        = ${tomlString(t.fstype)}`,
    `modify_window = ${t.modifyWindow}`,
    `flags_drop    = ${tomlArray(t.flagsDrop)}`,
  ].join("\n");
}

export function serializeConfig(config: Config): string {
  const head = [
    "# syncy — written by the setup screen. Edits are validated on load.",
    "",
    `source = ${tomlString(config.source)}`,
    `exclude = ${tomlArray(config.exclude)}`,
    "",
    "[status]",
    `max_verify_age_days = ${config.maxVerifyAgeDays}   # deep: guards silent bit rot`,
    `max_quick_age_days  = ${config.maxQuickAgeDays}    # quick: guards deletion and truncation`,
    `min_targets         = ${config.minTargets}`,
    "",
  ].join("\n");
  return head + config.targets.map(target).join("\n\n") + "\n";
}

/**
 * Round-trips through the validator before touching disk.
 *
 * The setup screen must not be able to write a config the loader would then
 * reject — that would leave syncy unable to start with no way back in.
 */
export function saveConfig(config: Config, file: string): void {
  const text = serializeConfig(config);
  parseConfig(text);

  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/**
 * An unconfigured config. `source` is deliberately empty rather than defaulting
 * to the home directory: a default of `~` made the ledger try to fingerprint
 * every subfolder of home (~1.7M files) before it could draw anything.
 */
export const EMPTY_CONFIG = (source = ""): Config => ({
  source,
  maxVerifyAgeDays: DEFAULTS.maxVerifyAgeDays,
  maxQuickAgeDays: DEFAULTS.maxQuickAgeDays,
  minTargets: DEFAULTS.minTargets,
  exclude: [".DS_Store", "._*"],
  targets: [],
});

export function withTarget(config: Config, t: Target): Config {
  const targets = config.targets.filter((x) => x.name !== t.name);
  targets.push(t);
  targets.sort((a, b) => a.name.localeCompare(b.name));
  return { ...config, targets };
}

export function withoutTarget(config: Config, name: string): Config {
  return { ...config, targets: config.targets.filter((t) => t.name !== name) };
}
