# syncy

A replication ledger for rsync. It records which folders are present and
verified on every drive you keep them on, so you can tell when a local copy is
safe to delete.

rsync copies files; it keeps no record of having done so. syncy runs rsync,
stores the result, and applies an explicit rule for when a folder counts as
replicated.

```
  folder                        size   ext   nas   status
  ────────────────────────────────────────────────────────────────────────────────────────
  photos-2019 .............   410 gb   ✓     ✓     verified
  photos-2020 .............   382 gb   ✓     ~     unverified · nas size and date match, …
  photos-2024 .............   205 gb   ✓     ▲143  behind · nas 143 files not copied yet
» projects-archive ........    44 gb   ?     ?     unchecked · ext not connected
  video-raw ...............   1.2 tb   ✗     ✗     missing · ext never copied
  ────────────────────────────────────────────────────────────────────────────────────────
  projects-archive  ext   never checked
                    nas   never checked

  ························································································
  ✓ verified    ~ unverified    ▲ behind    ✗ missing    ? unchecked

  5 folders    410 gb verified of 2.2 tb                                             █▓▒·░

  [enter] diff   [q]/[Q] check   [d]/[D] verify   [s] sync   [p] cmds   [?] keys
```

## States

Five states, used for both a single destination and a folder overall. A
folder's state is the weakest state among its required destinations.

| | state | meaning |
|---|---|---|
| `✓` | verified | Checksummed against the source, matched, source unchanged since |
| `~` | unverified | Present, matching on size and date, but never checksummed — or the checksum has expired |
| `▲` | behind | Present, but files are missing or differ |
| `✗` | missing | Not present |
| `?` | unchecked | Destination not reachable, so nothing can be concluded |

States describe the files. They do not prescribe an action.

## When a folder reaches `verified`

For every required destination, all of:

1. A checksum verify passed.
2. The source has not changed since, tracked by a metadata fingerprint.
3. That verify is younger than `max_verify_age_days` (default 30).
4. A quick check has passed within `max_quick_age_days` (default 7).
5. The destination's identity matches now, not merely when it was checked.

Two clocks, because the two failure modes cost different amounts to detect. A
deletion or truncation at a destination shows up in a quick check in minutes, so
that clock is short. Silent corruption — same size, same timestamp, different
bytes — needs a full checksum pass, which takes hours over a network share, so
that clock is long.

Rule 5 is deliberate: a destination that cannot be reached now cannot support a
claim, however recently it verified. The history is still shown; it is not used
to conclude.

`min_targets` (default 1) is a floor on how many destinations must pass. Rule 1
already requires every *required* destination to pass, so this only matters if
some destinations are marked `required = false`.

Destinations are arbitrary named directories. There is no built-in notion of an
external drive or a NAS. One destination is a valid setup; so is five. Each gets
a column headed by its name.

## Safety properties

**Nothing is written to a destination.** Each is identified by asking the OS
which volume is mounted there — a volume UUID for local disks, the mount source
(`//user@host/share`) for network shares. Reachability is decided by comparing
that identity, not by the path existing: on macOS an unmounted `/Volumes/media`
is a writable directory on the boot disk, so a path check would let rsync fill
the startup volume with the data you were moving off it. An unmounted path
resolves to the boot volume, whose identity does not match.

A sentinel file (`.syncy-dest-id` at the destination root) is available as an
alternative. It is the stronger check — it also catches the destination
directory being deleted and recreated, which volume identity cannot see — but it
costs one 37-byte file on the volume, so it is opt-in.

**No deletion.** syncy does not delete, does not offer to, and does not print
`rm` commands. What happens to a folder that reads `verified` is outside this
tool.

**Writes go through rsync.** Direct filesystem writes happen only inside syncy's
own config and state directories. Anything landing in a source or destination
gets there via rsync, including the sentinel and the capability probe's payload,
which are staged locally and delivered with `rsync -a`. A test reads every file
under `src/` and fails on a direct write outside a short allow list.

**`--delete` is always a dry run.** It appears only in the quick check, where
`-n` makes the whole command a dry run, and its purpose is to make rsync report
files present at a destination but absent from the source. Those are otherwise
invisible, and a destination can accumulate gigabytes of them while reporting
clean. They never block a verified state. The executor refuses to spawn any
command containing `--delete` without `-n`, and the sync command carries no
`--delete` at all.

**`--partial-dir`, not `-P`.** A bare `--partial` leaves the fragment at the
final path when a transfer is interrupted — a 9 mb file named `big.bin` where a
400 mb one belongs. syncy's own quick check catches that (rsync reports
`>f.s.......`, size differing), but until a check runs, anything else looking at
the destination — a person, Finder, another backup tool — sees a plausibly named
file with nothing to mark it as a stump. `--partial-dir` quarantines it under a
dot-directory, where it is visibly not archive content and rsync can still
resume from it.

## Commands run

These three, and nothing else:

```
quick   -a -A -X -n -i -vv --out-format=%i|%l|%n --delete --exclude=… SRC/ DST/
deep    -a -A -X -c -n -i -vv --out-format=%i|%l|%n         --exclude=… SRC/ DST/
sync    -a -A -X -i --out-format=%i|%l|%n
        --partial-dir=.syncy-partial                        --exclude=… SRC/ DST/
```

`-vv` makes rsync itemize every file it examines, not only those that differ.
Sync adds `-c` when a deep verify found content drift, since size and date alone
would skip the corrupted file.

Per destination: `--modify-window=2` on FAT-family filesystems, whose two-second
timestamp granularity otherwise makes every file look changed; `-A` and `-X`
dropped where the capability probe finds the destination cannot preserve ACLs or
extended attributes.

## Requirements

**rsync 3.x.** macOS ships openrsync at `/usr/bin/rsync`, which reports itself
as "rsync version 2.6.9 compatible" and then rejects `-A`. syncy does not
resolve rsync from `PATH`. It checks `/opt/homebrew/bin`, `/usr/local/bin` and
`/opt/local/bin` in that order, and refuses to run against openrsync rather than
failing later per folder. `SYNCY_RSYNC` overrides the path.

```
brew install rsync
```

**Bun**, to build.

```
brew install bun
```

## Install

```
bun install
bun run build          # produces a self-contained ./syncy
cp syncy ~/.local/bin/
```

## Use

```
syncy                  open the ledger
syncy status           print the ledger and exit — works over ssh
syncy check [folder]   quick check against every destination
syncy verify [folder]  deep verify against every destination
syncy doctor           check the rsync build and destination reachability
```

Keys: `enter` differences, `q` quick check, `d` deep verify, `s` sync,
`p` commands, `e` evidence, `f` filter, `,` setup, `?` all keys, `ctrl-c` quit.
Hold shift to run a check against every folder rather than the selected one.

syncy sets the terminal window and tab title, so a check running in a background
window can be read from the tab strip: `50% deep 19-01-01 - 2019 · syncy` while
one runs, `syncy · 1/12 verified` at rest. The title is handed back to the shell
on exit, including after a signal.

First run opens setup. Set a source root, then add destinations; adding one
records its identity, detects its filesystem, and probes what metadata it can
preserve. syncy tracks the immediate subfolders of the source root.

### Differences

`enter` lists the differing files for the selected folder, per destination, with
rsync's itemize string for each:

```
nas   504 not at destination · 1 attributes differ · 5.4 gb to copy · deep check today
source 935 files · 12 gb   destination 431 files · 6.7 gb   504 files short · 5.4 gb short
  + DSC_0122.NEF                                              17 mb  >f+++++++++
  ≠ DSC_0140.NEF                                              18 mb  >f.st......
  − old-export.jpg                                                —  *deleting
```

`+` not copied yet, `≠` copied then diverged, `·` attributes only, `−` present
at the destination and not at the source. These call for different responses,
which a single "504 files pending" cannot express.

Both totals are measured. The destination is walked read-only during the check,
because rsync reports the source length for every item and never the
destination's, so a destination byte total cannot be derived from the itemize
stream.

rsync itemizes these during a check regardless, so recording them costs no extra
work. They are stored under the state directory and can be deleted at any time;
the cost is a re-check.

### Progress

Progress is reported where rsync provides it, and not otherwise. Under
`--checksum` rsync reads whole files and reports nothing until that work is
done: on an archive of large photos over SMB the itemize stream stays silent for
the entire run. The file counter therefore appears only when lines are actually
arriving. Otherwise the line shows elapsed time and bytes to read, plus a bar
estimated from measured throughput at that destination — bytes read per second,
pooled from previous checks of the same kind — marked with `~` to distinguish an
estimate from counted work. One completed deep verify gives every other folder
on that destination an estimate. Until there is one, no bar is drawn: a bar that
reads 0%% for twelve minutes and then 100%% is indistinguishable from a hang.

## Try it

```
bun run testdata
./scripts/testdata-run.sh
```

Builds a throwaway archive under `testdata/`, which is gitignored:

```
testdata/
  input/                 the source root — these folders are what syncy tracks
    photos-2019/         12 files
    photos-2024/         10 files
    projects-archive/     8 files
    video-raw/            4 files
    documents/           20 files
  output/external/       destination 1  (empty)
  output/nas/            destination 2  (empty)
  config/  state/        syncy's own directories, redirected here
```

Config and state are redirected into the tree, so nothing it does can reach
`~/.config/syncy` or a real drive.

The destinations start empty, so you can drive the whole loop: `q` to check, `s`
to sync, `d` to deep verify, watching a folder move from `unchecked` through
`missing` and `behind` to `verified`.

`bun run testdata --seeded` builds a tree already in mixed states.
`--targets=laptop,offsite,archive` builds any number of destinations with names
you choose.

## Configuration

Written by the setup screen at `~/.config/syncy/config.toml`, and validated on
every read since it can be edited or corrupted between runs. Destinations are
`[[target]]` tables — the key predates the interface wording and is kept for
compatibility with existing configs.

State lives in `~/.local/state/syncy`:

```
state.json       current result per folder, destination and method
history.jsonl    every rsync invocation, with literal argv and exit code
diffs/           which files differ, per folder and destination
logs/
```

Plain files rather than a database, so the record can be read with `cat`,
`grep` and `diff`, and backed up without a client. `diffs/` is derived and safe
to delete; the cost is a re-check.

`SYNCY_DEBUG=1` writes diagnostics to `state/debug.log`, which is where a
full-screen interface that appears to hang can say why. It is cheap enough to
leave on — about fifty lines and under two milliseconds for a full run — and
rotates at 2 MB, keeping one previous file. It times each pre-flight
check and marks the phases of a sync, which separates rsync's own startup and
teardown from syncy's work around it:

```
preflight.rsyncBuild   {"ms":6}
preflight.reachability {"ms":0}
preflight.freeSpace    {"ms":0}
sync.spawned           {"unit":"u","target":"dst"}
sync.firstOutput       {"msAfterSpawn":9}
sync.rsyncExited       {"msTotal":32,"msToFirstOutput":9,"msAfterLastOutput":23}
sync.teardown          {"ms":0}
```
`SYNCY_THEME=dark|light|ansi` selects a theme. `NO_COLOR` uses the terminal's
own palette.

## Development

```
bun test               # 656 tests
bunx tsc --noEmit
bun run build
bun run audit          # no machine-specific data in the tree or the history
```

Tests create real files and run real rsync, because the behaviour worth testing
is the behaviour that touches the filesystem. Fixtures are confined to
`.test-tmp/` by a helper that throws on any path outside it, and a preload
redirects the XDG directories into the project before any test file loads. One
test asserts that a full run leaves the real config and state byte-identical;
another rejects any test file naming a path that exists on the machine running
it.

`DESIGN.md` records the decisions and the reasoning behind them.

## Licence

MIT — see [LICENSE](LICENSE).

syncy invokes rsync as a separate program rather than linking or bundling it, so
rsync's GPL does not extend to this project. Everything embedded in the compiled
binary (Bun, React, Ink) is MIT.
