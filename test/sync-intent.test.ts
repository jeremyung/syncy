import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { claimSyncIntent, type SyncIntent, saveSyncIntent } from "../src/sync-intent.ts";
import { makeFixtureDir, removeFixtureDir } from "./helpers.ts";

let root: string;
afterEach(() => {
  if (root !== undefined) removeFixtureDir(root);
});

const intent = (overrides: Partial<SyncIntent> = {}): SyncIntent => ({
  version: 1,
  token: "confirmation-123",
  createdAt: 1_000,
  expiresAt: 301_000,
  unit: "photos",
  target: "archive",
  argv: ["-a", "/source/photos/", "/destination/photos/"],
  fingerprint: { nfiles: 12, bytes: 4_096, maxMtimeNs: "100" },
  nChanges: 4,
  bytesPending: 2_048,
  needsChecksum: false,
  ...overrides,
});

describe("one-use sync confirmations", () => {
  test("claims a saved confirmation exactly once", () => {
    root = makeFixtureDir("syncy-intent-once");
    saveSyncIntent(intent(), root);
    expect(claimSyncIntent("confirmation-123", 2_000, root)).toEqual(intent());
    expect(() => claimSyncIntent("confirmation-123", 2_001, root)).toThrow(/already been used/);
  });

  test("an expired confirmation remains claimed but cannot run", () => {
    root = makeFixtureDir("syncy-intent-expired");
    saveSyncIntent(intent({ expiresAt: 1_500 }), root);
    expect(() => claimSyncIntent("confirmation-123", 2_000, root)).toThrow(/expired/);
    expect(() => claimSyncIntent("confirmation-123", 2_001, root)).toThrow(/already been used/);
  });

  test("refuses a token that could escape the owned state directory", () => {
    root = makeFixtureDir("syncy-intent-path");
    expect(() => claimSyncIntent("../../outside", 2_000, root)).toThrow(/invalid/);
    expect(existsSync(join(root, "outside"))).toBe(false);
  });
});
