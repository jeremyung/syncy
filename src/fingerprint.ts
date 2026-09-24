import { createHash, type Hash } from "node:crypto";
import {
  type Dir,
  type Dirent,
  lstat,
  lstatSync,
  opendir,
  opendirSync,
  readlink,
  readlinkSync,
} from "node:fs";
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

/**
 * One walk's in-progress state: the counters, the digest, and the only two
 * framings a walk ever uses. The sync and async walkers share this state and
 * the `record`/`failed`/`applyEntry` functions, so the record framing, the
 * failure framing and the directory/file/symlink branching exist exactly
 * once and cannot drift between the two walks.
 */
interface WalkState {
  readonly digest: Hash;
  nfiles: number;
  bytes: number;
  maxMtime: bigint;
  complete: boolean;
}

function newWalkState(): WalkState {
  return { digest: createHash("sha256"), nfiles: 0, bytes: 0, maxMtime: 0n, complete: true };
}

/** Hash a record with unambiguous field boundaries. */
function record(
  s: WalkState,
  kind: string,
  name: string,
  size: bigint,
  mtimeNs: bigint,
  linkTarget?: string,
): void {
  s.digest.update(
    `${kind.length}:${kind}${name.length}:${name}${size.toString().length}:${size}` +
      `${mtimeNs.toString().length}:${mtimeNs}` +
      (linkTarget === undefined ? "" : `${linkTarget.length}:${linkTarget}`) +
      "\n",
  );
}

function failed(s: WalkState, name: string): void {
  s.complete = false;
  // Keep failures in the digest too: two incomplete walks should not happen
  // to compare equal merely because they missed the same counters.
  s.digest.update(`!incomplete:${name.length}:${name}\n`);
}

/**
 * Applies one entry's evidence — the record and the counters — from its
 * dirent type and its lstat. Returns true only for a directory, the one case
 * the caller must then recurse into.
 *
 * The symlink target is read by the caller and passed in, so a readlink
 * failure lands in the caller's catch exactly as when it was read inside the
 * branch: no record yet, then the failure.
 */
function applyEntry(
  s: WalkState,
  entry: Dirent,
  rel: string,
  st: { readonly size: bigint; readonly mtimeNs: bigint },
  linkTarget?: string,
): boolean {
  if (entry.isDirectory()) {
    record(s, "d", rel, st.size, st.mtimeNs);
    return true;
  }
  if (entry.isFile()) {
    record(s, "f", rel, st.size, st.mtimeNs);
    s.nfiles += 1;
    s.bytes += Number(st.size);
    if (st.mtimeNs > s.maxMtime) s.maxMtime = st.mtimeNs;
    return false;
  }
  if (entry.isSymbolicLink()) {
    // The link target is included in addition to the requested
    // metadata fields so two links with the same length and mtime
    // but different targets cannot collide.
    record(s, "l", rel, st.size, st.mtimeNs, linkTarget);
    if (st.mtimeNs > s.maxMtime) s.maxMtime = st.mtimeNs;
    return false;
  }
  // Rsync can preserve other directory entry types on some
  // filesystems. Include them as evidence even though they are
  // not part of the regular-file byte counters.
  record(s, "o", rel, st.size, st.mtimeNs);
  if (st.mtimeNs > s.maxMtime) s.maxMtime = st.mtimeNs;
  return false;
}

function finish(s: WalkState): Fingerprint {
  return {
    nfiles: s.nfiles,
    bytes: s.bytes,
    maxMtimeNs: s.maxMtime.toString(),
    digest: s.digest.digest("hex"),
    complete: s.complete,
  };
}

export function fingerprint(
  root: string,
  exclude: readonly string[] = [],
  io: FingerprintIo = realFingerprintIo,
): Fingerprint {
  const state = newWalkState();

  const walk = (dir: string, relative: string): void => {
    let d: Dir;
    try {
      d = io.open(dir);
    } catch {
      // An unreadable subdirectory means this fingerprint did not establish
      // the source shape. Retaining a partial tuple here could make an older
      // clean verification look current, so mark the walk incomplete.
      failed(state, relative);
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
            const linkTarget = entry.isSymbolicLink() ? io.readlink(p) : undefined;
            if (applyEntry(state, entry, rel, st, linkTarget)) walk(p, rel);
          } catch {
            // A file can vanish between readdir and lstat. That is an
            // incomplete observation, not an empty directory.
            failed(state, rel);
          }
        }
      }
    } catch {
      // A read failure part-way through the directory has the same meaning as
      // an lstat failure: the counters are only a partial view.
      failed(state, relative);
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
  return finish(state);
}

/** Read-only async filesystem seam, mirroring FingerprintIo. */
export interface FingerprintIoAsync {
  readonly lstat: (path: string) => Promise<{ readonly size: bigint; readonly mtimeNs: bigint }>;
  readonly opendir: (path: string) => Promise<AsyncIterable<Dirent>>;
  readonly readlink: (path: string) => Promise<string>;
}

/**
 * The callback form of node:fs, promisified. It is the same libuv work as
 * node:fs/promises, and it deliberately stays out of that module: this file
 * is not on the write-policy allow list, which treats any node:fs/promises
 * import as a potential direct write.
 */
const realFingerprintIoAsync: FingerprintIoAsync = {
  lstat: (path) =>
    new Promise((resolve, reject) => {
      lstat(path, { bigint: true }, (err, st) => (err !== null ? reject(err) : resolve(st)));
    }),
  opendir: (path) =>
    new Promise((resolve, reject) => {
      opendir(path, (err, d) => (err !== null ? reject(err) : resolve(d)));
    }),
  readlink: (path) =>
    new Promise((resolve, reject) => {
      readlink(path, (err, target) => (err !== null ? reject(err) : resolve(target)));
    }),
};

/**
 * One entry's pooled lookup: its `lstat`, plus its `readlink` target when the
 * dirent is a symlink. `ok: false` is the same fact the old sequential walk
 * hit its `catch` on — the entry is recorded incomplete, and nothing else.
 */
type Lookup =
  | {
      readonly ok: true;
      readonly st: { readonly size: bigint; readonly mtimeNs: bigint };
      readonly linkTarget: string | undefined;
    }
  | { readonly ok: false };

/**
 * Concurrent lookups per directory. The bound exists at all because an
 * unbounded map over a 100k-entry directory would issue 100k concurrent
 * syscalls and starve the same thread pool this walk is trying to keep free.
 */
const ASYNC_LOOKUP_POOL = 32;

/**
 * Runs `fn` over every item with at most `limit` promises in flight and
 * returns the results in input order. `fn` must settle rather than reject:
 * a pooled rejection would sink the whole batch, so the caller resolves its
 * per-item failures (`probe` does, by returning `ok: false`).
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The async twin of `fingerprint()`: the identical walk through the async
 * filesystem seam, for a destination where a synchronous lstat of every file
 * would hold the event loop for minutes — over SMB the interface cannot
 * paint and the abort signal is not read while it runs.
 *
 * It shares `record`/`failed`/`applyEntry` with `fingerprint()`, so the
 * digest is framed character for character the same: directory entries are
 * sorted by name before walking, `lstat` and never `stat`, excludes match
 * via the same `matchesAny`, and the directory/file/symlink branches and
 * counters — including the `!incomplete:` update for an unreadable
 * subdirectory — are the code the sync walk runs.
 *
 * Within one directory the entries' lookups are dispatched concurrently
 * through a bounded pool and then consumed one at a time in sorted order, so
 * records and recursion stay strictly sequential and the digest is byte for
 * byte the one the sync walk produces.
 *
 * `signal` is read before dispatching a directory's lookups and between
 * entries. When it is set the walk stops promptly and returns with
 * `complete: false`: an aborted walk proved nothing, and only the refusal of
 * only the refusal of incomplete fingerprints stands between that partial
 * value and being mistaken for a whole one.
 */
export async function fingerprintAsync(
  root: string,
  exclude: readonly string[] = [],
  io: FingerprintIoAsync = realFingerprintIoAsync,
  signal?: AbortSignal,
): Promise<Fingerprint> {
  const state = newWalkState();

  const stopIfAborted = (): boolean => {
    if (signal?.aborted) {
      state.complete = false;
      return true;
    }
    return false;
  };

  // One entry's lookup: the lstat, and the readlink when the dirent is a
  // symlink — the pair the sequential walk ran, in the same order. It
  // settles to `ok: false` instead of rejecting: a rejection inside the pool
  // would sink the whole directory, and the failure could not be attributed
  // to the name that caused it.
  async function probe(entry: Dirent, p: string): Promise<Lookup> {
    try {
      // lstat is intentional: following a symlink would make a source
      // alias disappear into the target tree and would omit the link
      // itself from the evidence.
      const st = await io.lstat(p);
      const linkTarget = entry.isSymbolicLink() ? await io.readlink(p) : undefined;
      return { ok: true, st, linkTarget };
    } catch {
      return { ok: false };
    }
  }

  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries: AsyncIterable<Dirent>;
    try {
      entries = await io.opendir(dir);
    } catch {
      // Same meaning as the sync walk: an unreadable subdirectory means this
      // fingerprint did not establish the source shape. Retaining a partial
      // tuple here could make an older clean verification look current, so
      // mark the walk incomplete.
      failed(state, relative);
      return;
    }
    try {
      const collected: Dirent[] = [];
      for await (const entry of entries) {
        collected.push(entry);
        if (stopIfAborted()) return;
      }
      // Directory enumeration order is filesystem-dependent. Sorting names
      // makes the digest stable across repeated walks and platforms.
      collected.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      // The lookups of this directory's entries are dispatched concurrently
      // through the bounded pool, then consumed one at a time in sorted
      // order below: recording and recursion stay strictly sequential, so
      // the digest is the one the sync walk produces.
      const work = collected
        .map((entry, at) => ({ at, entry, p: join(dir, entry.name) }))
        .filter((w) => !matchesAny(w.entry.name, exclude));
      if (stopIfAborted()) return;
      const settled = await mapBounded(work, ASYNC_LOOKUP_POOL, ({ entry, p }) => probe(entry, p));
      const lookup: (Lookup | undefined)[] = new Array(collected.length).fill(undefined);
      for (let i = 0; i < work.length; i++) lookup[work[i]!.at] = settled[i]!;
      for (let at = 0; at < collected.length; at++) {
        if (stopIfAborted()) return;
        const entry = collected[at]!;
        const name = entry.name;
        if (matchesAny(name, exclude)) continue;
        const p = join(dir, name);
        const rel = relative === "" ? name : `${relative}/${name}`;
        const result = lookup[at];
        if (result === undefined || !result.ok) {
          // A file can vanish between readdir and lstat. That is an
          // incomplete observation, not an empty directory.
          failed(state, rel);
          continue;
        }
        if (applyEntry(state, entry, rel, result.st, result.linkTarget)) await walk(p, rel);
      }
    } catch {
      // A read failure part-way through the directory has the same meaning as
      // an lstat failure: the counters are only a partial view. The async
      // iterator closes the directory handle when the loop ends, so nothing
      // is left to release here.
      failed(state, relative);
    }
  };

  // Preserve the established EMPTY value for a missing root. No unit can be
  // verified without a source directory, and this keeps the public empty
  // sentinel useful to callers that render an unconfigured source. A root
  // that exists but cannot be walked falls through and is marked incomplete.
  try {
    await io.lstat(root);
  } catch {
    return EMPTY;
  }
  await walk(root, "");
  return finish(state);
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
