import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fingerprint } from "./fingerprint.ts";
import { stateDir } from "./paths.ts";

export interface SyncIntent {
  readonly version: 1;
  readonly token: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly unit: string;
  readonly target: string;
  readonly argv: readonly string[];
  readonly fingerprint: Fingerprint;
  readonly nChanges: number;
  /** Changed file total used for transfer progress; absent on legacy intents. */
  readonly nFiles?: number;
  readonly bytesPending: number;
  readonly needsChecksum: boolean;
}

const roots = (root: string) => ({
  pending: join(root, "sync-intents", "pending"),
  claimed: join(root, "sync-intents", "claimed"),
});

export function saveSyncIntent(intent: SyncIntent, root: string = stateDir()): void {
  const paths = roots(root);
  mkdirSync(paths.pending, { recursive: true });
  writeFileSync(join(paths.pending, `${intent.token}.json`), `${JSON.stringify(intent)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function parseIntent(raw: unknown): SyncIntent {
  if (typeof raw !== "object" || raw === null) throw new Error("sync confirmation is corrupt");
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.token !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.expiresAt !== "number" ||
    typeof value.unit !== "string" ||
    typeof value.target !== "string" ||
    !Array.isArray(value.argv) ||
    !value.argv.every((part) => typeof part === "string") ||
    typeof value.fingerprint !== "object" ||
    value.fingerprint === null ||
    typeof value.nChanges !== "number" ||
    (value.nFiles !== undefined && typeof value.nFiles !== "number") ||
    typeof value.bytesPending !== "number" ||
    typeof value.needsChecksum !== "boolean"
  ) {
    throw new Error("sync confirmation is corrupt");
  }
  const fp = value.fingerprint as Record<string, unknown>;
  if (
    typeof fp.nfiles !== "number" ||
    typeof fp.bytes !== "number" ||
    typeof fp.maxMtimeNs !== "string"
  ) {
    throw new Error("sync confirmation fingerprint is corrupt");
  }
  return value as unknown as SyncIntent;
}

/** Atomically makes a confirmation one-use while retaining its record. */
export function claimSyncIntent(
  token: string,
  now: number = Date.now(),
  root: string = stateDir(),
): SyncIntent {
  if (!/^[A-Za-z0-9-]{8,128}$/.test(token)) throw new Error("invalid sync confirmation token");
  const paths = roots(root);
  mkdirSync(paths.claimed, { recursive: true });
  const source = join(paths.pending, `${token}.json`);
  const claimed = join(paths.claimed, `${now}-${token}.json`);
  try {
    renameSync(source, claimed);
  } catch {
    throw new Error("sync confirmation is missing or has already been used");
  }
  let intent: SyncIntent;
  try {
    intent = parseIntent(JSON.parse(readFileSync(claimed, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("sync confirmation is corrupt");
    throw error;
  }
  if (intent.token !== token) throw new Error("sync confirmation token does not match its record");
  if (now > intent.expiresAt) throw new Error("sync confirmation expired; run the preflight again");
  return intent;
}
