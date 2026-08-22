import { opendirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A cheap, metadata-only signature of a source unit.
 *
 * Stored alongside every scan so a later run can ask "has the source changed
 * since I verified this?" without touching the destination at all — which is
 * what makes a stale verify detectable while the NAS is offline (DESIGN.md §2).
 *
 * Measured on this machine: 99,701 files / 494 GB in ~1.9s warm.
 */
export interface Fingerprint {
  readonly nfiles: number;
  readonly bytes: number;
  readonly maxMtimeNs: string; // bigint as string; JSON has no bigint
}

export const EMPTY: Fingerprint = { nfiles: 0, bytes: 0, maxMtimeNs: "0" };

/**
 * Basename matcher supporting a single leading and/or trailing `*`.
 * Deliberately not full rsync filter syntax — excludes here exist to keep the
 * fingerprint consistent with what rsync transfers, and the config screen only
 * ever produces simple patterns.
 */
export function matchesAny(name: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p === name) return true;
    const star = p.indexOf("*");
    if (star < 0) continue;
    const head = p.slice(0, star);
    const tail = p.slice(star + 1);
    if (name.length >= head.length + tail.length && name.startsWith(head) && name.endsWith(tail)) {
      return true;
    }
  }
  return false;
}

export function fingerprint(root: string, exclude: readonly string[] = []): Fingerprint {
  let nfiles = 0;
  let bytes = 0;
  let maxMtime = 0n;

  const walk = (dir: string): void => {
    let d;
    try {
      d = opendirSync(dir);
    } catch {
      // An unreadable or missing directory must not abort the walk. The
      // counters are left untouched; the deep verify is the authority anyway.
      return;
    }
    try {
      let entry = d.readSync();
      while (entry !== null) {
        const name = entry.name;
        if (!matchesAny(name, exclude)) {
          const p = join(dir, name);
          if (entry.isDirectory()) {
            walk(p);
          } else if (entry.isFile()) {
            try {
              const st = statSync(p, { bigint: true });
              nfiles += 1;
              bytes += Number(st.size);
              if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs;
            } catch {
              // Vanished between readdir and stat; skip.
            }
          }
        }
        entry = d.readSync();
      }
    } catch {
      // Bun's opendirSync succeeds on a missing directory and raises ENOENT
      // here instead, so the guard has to cover the read loop as well — a
      // subdirectory that vanishes mid-walk must not crash a status run.
    } finally {
      try {
        d.closeSync();
      } catch {
        // Already closed or gone; nothing to release.
      }
    }
  };

  walk(root);
  return { nfiles, bytes, maxMtimeNs: maxMtime.toString() };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.nfiles === b.nfiles && a.bytes === b.bytes && a.maxMtimeNs === b.maxMtimeNs;
}
