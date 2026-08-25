import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Runtime validation is mandatory, not optional (DESIGN.md §1).
 *
 * TypeScript's types evaporate at runtime: `Bun.TOML.parse` hands back `any`
 * wearing a type annotation. A mistyped destination path that type-checks
 * perfectly is precisely how you rsync into the wrong directory. This is
 * hand-rolled rather than zod/valibot to keep the dependency count at zero —
 * the schema is small and the error messages are better for it.
 */

/**
 * Defaults, defined once.
 *
 * `EMPTY_CONFIG` and the TOML parser previously carried their own copies and
 * drifted: the parser said 1 while the setup screen still built configs with 2,
 * so a fresh single-destination setup was told it could never reach `verified`.
 */
export const DEFAULTS = {
  /** Deep: guards silent bit rot, which costs hours to detect. */
  maxVerifyAgeDays: 30,
  /** Quick: guards deletion and truncation, which cost minutes. */
  maxQuickAgeDays: 7,
  /**
   * An extra floor only. Every required target must pass regardless, so 1 is
   * the right default — one destination is a legitimate setup. Never 0, or a
   * config with no targets could roll up to `verified`.
   */
  minTargets: 1,
} as const;

export class ConfigError extends Error {
  constructor(
    readonly where: string,
    message: string,
  ) {
    super(`config: ${where}: ${message}`);
    this.name = "ConfigError";
  }
}

export interface Target {
  readonly name: string;
  readonly path: string;
  readonly required: boolean;
  /**
   * How this destination proves it is itself. Exactly one is used.
   *
   * `identity` asks the operating system which volume is mounted here and
   * writes nothing to it. `sentinel` is a file syncy places at the target root,
   * which additionally catches the directory being deleted and recreated — at
   * the cost of a file on the user's volume.
   */
  readonly identity?: string;
  readonly identityKind?: "volume-uuid" | "mount-source";
  readonly sentinel?: string;
  readonly fstype: string;
  readonly modifyWindow: number;
  readonly flagsDrop: readonly string[];
}

export interface Config {
  readonly source: string;
  readonly maxVerifyAgeDays: number;
  readonly maxQuickAgeDays: number;
  readonly minTargets: number;
  readonly exclude: readonly string[];
  readonly targets: readonly Target[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string")
    throw new ConfigError(`${where}.${key}`, `expected a string, got ${typeof v}`);
  if (v.trim() === "") throw new ConfigError(`${where}.${key}`, "must not be empty");
  return v;
}

function num(
  obj: Record<string, unknown>,
  key: string,
  where: string,
  dflt: number,
  min: number,
): number {
  const v = obj[key];
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`${where}.${key}`, `expected a number, got ${typeof v}`);
  }
  if (v < min) throw new ConfigError(`${where}.${key}`, `must be >= ${min}, got ${v}`);
  return v;
}

function bool(obj: Record<string, unknown>, key: string, where: string, dflt: boolean): boolean {
  const v = obj[key];
  if (v === undefined) return dflt;
  if (typeof v !== "boolean")
    throw new ConfigError(`${where}.${key}`, `expected true or false, got ${typeof v}`);
  return v;
}

function strArray(obj: Record<string, unknown>, key: string, where: string): readonly string[] {
  const v = obj[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ConfigError(`${where}.${key}`, "expected an array of strings");
  return v.map((item, i) => {
    if (typeof item !== "string")
      throw new ConfigError(`${where}.${key}[${i}]`, "expected a string");
    return item;
  });
}

function absolutePath(value: string, where: string): string {
  if (!isAbsolute(value)) throw new ConfigError(where, `must be an absolute path, got "${value}"`);
  return resolve(value);
}

/** True when `inner` is the same as, or nested beneath, `outer`. */
export function isWithin(inner: string, outer: string): boolean {
  const a = resolve(inner);
  const b = resolve(outer);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export function parseConfig(text: string): Config {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(text);
  } catch (e) {
    throw new ConfigError("<file>", `not valid TOML: ${(e as Error).message}`);
  }
  if (!isRecord(raw)) throw new ConfigError("<file>", "expected a table at the top level");

  const source = absolutePath(str(raw, "source", "root"), "source");

  const statusRaw = raw["status"];
  const status = statusRaw === undefined ? {} : statusRaw;
  if (!isRecord(status)) throw new ConfigError("status", "expected a table");

  const maxVerifyAgeDays = num(
    status,
    "max_verify_age_days",
    "status",
    DEFAULTS.maxVerifyAgeDays,
    1,
  );
  const maxQuickAgeDays = num(status, "max_quick_age_days", "status", DEFAULTS.maxQuickAgeDays, 1);
  const minTargets = num(status, "min_targets", "status", DEFAULTS.minTargets, 1);

  if (maxQuickAgeDays > maxVerifyAgeDays) {
    throw new ConfigError(
      "status.max_quick_age_days",
      `must not exceed max_verify_age_days (${maxVerifyAgeDays}); the cheap clock is the tighter one`,
    );
  }

  // Zero targets is a legitimate intermediate state: the setup screen saves the
  // source root before any target exists. It is safe because minTargets is at
  // least 1, so evaluateUnit can never report `verified` with nothing to verify
  // against.
  const targetsRaw = raw["target"] ?? [];
  if (!Array.isArray(targetsRaw)) {
    throw new ConfigError("target", "expected [[target]] entries");
  }

  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  const targets: Target[] = targetsRaw.map((entry, i) => {
    const where = `target[${i}]`;
    if (!isRecord(entry)) throw new ConfigError(where, "expected a table");

    const name = str(entry, "name", where);
    if (seenNames.has(name))
      throw new ConfigError(`${where}.name`, `duplicate target name "${name}"`);
    seenNames.add(name);

    const path = absolutePath(str(entry, "path", where), `${where}.path`);
    if (seenPaths.has(path))
      throw new ConfigError(`${where}.path`, `duplicate target path "${path}"`);
    seenPaths.add(path);

    // Nested source and target is data loss waiting to happen (DESIGN.md §7).
    if (isWithin(path, source)) {
      throw new ConfigError(`${where}.path`, `target is inside the source root (${source})`);
    }
    if (isWithin(source, path)) {
      throw new ConfigError(`${where}.path`, `source root is inside this target (${path})`);
    }

    const identity =
      typeof entry["identity"] === "string" ? (entry["identity"] as string) : undefined;
    const sentinel =
      typeof entry["sentinel"] === "string" ? (entry["sentinel"] as string) : undefined;
    if ((identity ?? "") === "" && (sentinel ?? "") === "") {
      throw new ConfigError(
        `${where}`,
        "needs either `identity` (asks the OS which volume is mounted) or `sentinel` (a file at the target root)",
      );
    }
    const kindRaw = entry["identity_kind"];
    const identityKind =
      kindRaw === "volume-uuid" || kindRaw === "mount-source" ? kindRaw : undefined;

    return {
      name,
      path,
      required: bool(entry, "required", where, true),
      ...(identity !== undefined && identity !== "" ? { identity } : {}),
      ...(identityKind !== undefined ? { identityKind } : {}),
      ...(sentinel !== undefined && sentinel !== "" ? { sentinel } : {}),
      fstype: typeof entry["fstype"] === "string" ? (entry["fstype"] as string) : "unknown",
      modifyWindow: num(entry, "modify_window", where, 0, 0),
      flagsDrop: strArray(entry, "flags_drop", where),
    };
  });

  // min_targets is deliberately NOT enforced here. It is a status policy,
  // applied by evaluateUnit, and enforcing it at parse time would make it
  // impossible to add targets one at a time from the setup screen.

  return {
    source,
    maxVerifyAgeDays,
    maxQuickAgeDays,
    minTargets,
    exclude: strArray(raw, "exclude", "root"),
    targets,
  };
}

export function loadConfig(file: string): Config {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new ConfigError(file, "not found — run `syncy init` or add targets in the setup screen");
  }
  return parseConfig(text);
}
