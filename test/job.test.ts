import { describe, expect, test } from "bun:test";
import type { Fingerprint } from "../src/fingerprint.ts";
import { cachedSourceFingerprint, jobsRan } from "../src/tui/useJob.ts";

const FP: Fingerprint = {
  nfiles: 2,
  bytes: 8,
  maxMtimeNs: "1",
  digest: "source-digest",
  complete: true,
};

describe("queued checks cache source fingerprints", () => {
  test("walks a unit once even when multiple destinations request it", () => {
    const calls: string[] = [];
    const cache = new Map<string, Fingerprint>();
    const config = { source: "/source", exclude: [".DS_Store"] };
    const read = (path: string): Fingerprint => {
      calls.push(path);
      return FP;
    };

    expect(cachedSourceFingerprint(config, "photos", cache, read)).toBe(FP);
    expect(cachedSourceFingerprint(config, "photos", cache, read)).toBe(FP);

    expect(calls).toEqual(["/source/photos"]);
  });

  test("walks different units independently", () => {
    const calls: string[] = [];
    const cache = new Map<string, Fingerprint>();
    const config = { source: "/source", exclude: [] as readonly string[] };
    const read = (path: string): Fingerprint => {
      calls.push(path);
      return FP;
    };

    cachedSourceFingerprint(config, "a", cache, read);
    cachedSourceFingerprint(config, "b", cache, read);

    expect(calls).toEqual(["/source/a", "/source/b"]);
  });

  test("counts a completed unit when a later unit shares its skipped target", () => {
    // Two queued units produce one displayed target reason. The old target
    // based subtraction called both units skipped; only the second job was.
    expect(jobsRan(2, 1)).toBe(1);
  });
});
