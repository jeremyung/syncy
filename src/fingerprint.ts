import { createHash } from "node:crypto";
import { type Dir, lstatSync, opendirSync, readlinkSync } from "node:fs";
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
  /** SHA-256 of the sorted relative tree metadata, when produced by v2+. */
  readonly digest?: string;
  /** False means the walk could not establish a complete view of the tree. */
  readonly complete?: boolean;
}

/** Read-only filesystem seam used to prove incomplete-walk handling. */
export interface FingerprintIo {
  readonly lstat: (path: string) => { readonly size: bigint; readonly mtimeNs: bigint };
  readonly open: (path: string) => Dir;
  readonly readlink: (path: string) => string;
}

const realFingerprintIo: FingerprintIo = {
  lstat: (path) => lstatSync(path, { bigint: true }),
  open: (path) => opendirSync(path),
  readlink: (path) => readlinkSync(path),
};

const EMPTY_DIGEST = createHash("sha256").digest("hex");
export const EMPTY: Fingerprint = {
  nfiles: 0,
  bytes: 0,
  maxMtimeNs: "0",
  digest: EMPTY_DIGEST,
  complete: true,
};

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

export function fingerprint(
  root: string,
  exclude: readonly string[] = [],
  io: FingerprintIo = realFingerprintIo,
): Fingerprint {
  let nfiles = 0;
  let bytes = 0;
  let maxMtime = 0n;
  let complete = true;
  const digest = createHash("sha256");

  /** Hash a record with unambiguous field boundaries. */
  const record = (
    kind: string,
    name: string,
    size: bigint,
    mtimeNs: bigint,
    linkTarget?: string,
  ): void => {
    digest.update(
      `${kind.length}:${kind}${name.length}:${name}${size.toString().length}:${size}` +
        `${mtimeNs.toString().length}:${mtimeNs}` +
        (linkTarget === undefined ? "" : `${linkTarget.length}:${linkTarget}`) +
        "\n",
    );
  };

  const failed = (name: string): void => {
    complete = false;
    // Keep failures in the digest too: two incomplete walks should not happen
    // to compare equal merely because they missed the same counters.
    digest.update(`!incomplete:${name.length}:${name}\n`);
  };

  const walk = (dir: string, relative: string): void => {
    let d: Dir;
    try {
      d = io.open(dir);
    } catch {
      // An unreadable subdirectory means this fingerprint did not establish
      // the source shape. Retaining a partial tuple here could make an older
      // clean verification look current, so mark the walk incomplete.
      failed(relative);
      return;
    }
    try {
      const entries = [];
      let entry = d.readSync();
      while (entry !== null) {
        entries.push(entry);
        entry = d.readSync();
      }
      // Directory enumeration order is filesystem-dependent. Sorting names
      // makes the digest stable across repeated walks and platforms.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const name = entry.name;
        if (!matchesAny(name, exclude)) {
          const p = join(dir, name);
          const rel = relative === "" ? name : `${relative}/${name}`;
          try {
            // lstat is intentional: following a symlink would make a source
            // alias disappear into the target tree and would omit the link
            // itself from the evidence.
            const st = io.lstat(p);
            if (entry.isDirectory()) {
              record("d", rel, st.size, st.mtimeNs);
              walk(p, rel);
            } else if (entry.isFile()) {
              record("f", rel, st.size, st.mtimeNs);
              nfiles += 1;
              bytes += Number(st.size);
              if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs;
            } else if (entry.isSymbolicLink()) {
              // The link target is included in addition to the requested
              // metadata fields so two links with the same length and mtime
              // but different targets cannot collide.
              record("l", rel, st.size, st.mtimeNs, io.readlink(p));
              if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs;
            } else {
              // Rsync can preserve other directory entry types on some
              // filesystems. Include them as evidence even though they are
              // not part of the regular-file byte counters.
              record("o", rel, st.size, st.mtimeNs);
              if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs;
            }
          } catch {
            // A file can vanish between readdir and lstat. That is an
            // incomplete observation, not an empty directory.
            failed(rel);
          }
        }
      }
    } catch {
      // A read failure part-way through the directory has the same meaning as
      // an lstat failure: the counters are only a partial view.
      failed(relative);
    } finally {
      try {
        d.closeSync();
      } catch {
        // Already closed or gone; nothing to release.
      }
    }
  };

  // Preserve the established EMPTY value for a missing root. No unit can be
  // verified without a source directory, and this keeps the public empty
  // sentinel useful to callers that render an unconfigured source. A root
  // that exists but cannot be walked falls through and is marked incomplete.
  try {
    io.lstat(root);
  } catch {
    return EMPTY;
  }
  walk(root, "");
  return {
    nfiles,
    bytes,
    maxMtimeNs: maxMtime.toString(),
    digest: digest.digest("hex"),
    complete,
  };
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  // An incomplete current walk proves nothing. This is the critical distinction
  // from an empty, successfully walked directory.
  if (a.complete === false || b.complete === false) return false;
  // A generated fingerprint carries a digest. If only one side has one, the
  // other side is an old record whose weaker tuple must not be accepted as
  // evidence for a current source.
  if (a.digest !== undefined || b.digest !== undefined) {
    return a.digest !== undefined && b.digest !== undefined && a.digest === b.digest;
  }
  return a.nfiles === b.nfiles && a.bytes === b.bytes && a.maxMtimeNs === b.maxMtimeNs;
}
