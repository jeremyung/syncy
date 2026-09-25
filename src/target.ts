import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { type Config, canonicalPath, containmentError, type Target } from "./config.ts";
import { type MountEntry, modifyWindowFor } from "./fstype.ts";
import { probeTarget } from "./probe.ts";
import { identityIsProof } from "./scan.ts";
import { identify } from "./volume.ts";

/**
 * Turning a typed path into a destination: expand it, validate it, identify
 * the volume mounted there and probe it.
 *
 * This is engine logic, and it used to live in the setup screen's component
 * file, so the headless `syncy engine add-destination` imported an Ink module
 * to add a destination. It imports no interface module; the setup screen and
 * the CLI both import it from here.
 */

/**
 * Resolves what was typed into an absolute path.
 *
 * `~` expands, and anything relative resolves against the working directory.
 * Config stores absolute paths only, so this is where that happens — rather
 * than rejecting a relative path the user plainly meant.
 */
export function expandPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  const home = process.env["HOME"] ?? homedir();
  const expanded =
    trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  return resolve(expanded);
}

/**
 * Directory completions for a partially typed path, **always absolute**.
 *
 * Returning them in whatever form was typed meant accepting a completion for a
 * relative path produced a relative path, which the validator then refused.
 */
export function completions(input: string, limit = 6): string[] {
  const abs = expandPath(input);
  if (abs === "") return [];
  // A trailing slash means "list this directory"; otherwise the last segment
  // is a partial name to match on.
  const listing = input.endsWith("/") || input.endsWith("~");
  const dir = listing ? abs : dirname(abs);
  const stem = listing ? "" : basename(abs);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name.startsWith(stem))
      .map((e) => join(dir, e.name))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** The checks that make a path a legitimate target, in the order they matter. */
export function validateTargetPath(path: string, config: Config): string | null {
  const abs = expandPath(path);
  if (abs === "") return "a path is required";
  if (!existsSync(abs)) return "no such directory";
  try {
    if (!statSync(abs).isDirectory()) return "not a directory";
  } catch {
    return "cannot read that path";
  }
  // Nested source and target is data loss waiting to happen. The shared check
  // compares both lexical and canonical paths, so a symlink alias cannot make
  // an apparently separate destination point back into the source.
  if (config.source !== "") {
    const nested = containmentError(config.source, abs);
    if (nested?.startsWith("target is inside")) return "inside the source root";
    if (nested?.startsWith("source root is inside")) return "contains the source root";
  }
  const canonical = canonicalPath(abs);
  if (
    config.targets.some(
      (t) => t.path === abs || (canonical !== null && canonicalPath(t.path) === canonical),
    )
  ) {
    return "already a destination";
  }
  return null;
}

/** What `resolveTarget` produced: a usable target, or why there is none. */
export type TargetResolution =
  | { readonly ok: true; readonly target: Target; readonly detail: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The identify-then-probe sequence a new target goes through, factored out of
 * the `commitTarget` hook so its refusal path is directly testable.
 *
 * A destination is identified by asking the OS which volume is mounted there,
 * BEFORE any write to it (DESIGN.md, and see the comment this replaced in
 * commitTarget). A probe would rsync a directory into the destination, so
 * identify() must succeed before probeTarget() ever runs — if the volume
 * cannot be identified, nothing is written.
 *
 * `entries`, when given, bypasses identify()'s own mount-table read — the
 * same seam fstypeFor already takes a MountEntry list through. Without it,
 * "the volume cannot be identified" was true only of paths with nothing
 * mounted there at all, which no fixture inside this project can produce (the
 * root mount always matches); this is what makes the refusal path
 * reproducible in a test without spawning a real, unidentifiable destination.
 */
export async function resolveTarget(
  abs: string,
  name: string,
  entries?: readonly MountEntry[],
  onProgress?: (message: string) => void,
): Promise<TargetResolution> {
  const found = await identify(abs, entries);
  if (found === null) {
    return { ok: false, reason: `could not identify the volume at ${abs}` };
  }
  const fstype = found.fstype;
  onProgress?.(`probing ${name} for acl and xattr support…`);
  const probe = await probeTarget(abs);

  const target: Target = {
    name,
    path: abs,
    required: true,
    identity: found.id,
    identityKind: found.kind,
    fstype,
    modifyWindow: modifyWindowFor(fstype),
    flagsDrop: probe.flagsDrop,
  };
  // A device path is recorded like any other identity, and said out loud as
  // the weaker thing it is: `targetReachability` will not accept it as proof
  // on its own, so the person adding the target should hear that here rather
  // than discover it as an "unverified" row later.
  const detail = identityIsProof(target)
    ? `${name}: ${fstype} · ${found.kind} ${found.id} · ${probe.detail}`
    : `${name}: ${fstype} · device path ${found.id}, not a volume name — ` +
      `run \`syncy sentinel ${abs}\` to prove it by a file instead · ${probe.detail}`;
  return { ok: true, target, detail };
}
