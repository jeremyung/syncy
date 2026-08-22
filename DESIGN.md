# syncy — replication tracker for rsync fan-out

Answers two questions about a set of source folders replicated to an external
HD and a NAS:

1. **Which folders are safe to delete?** (verified present on *both* targets)
2. **Which folders are out of sync?** (and run the rsync to fix them)

**The UI contains no deletion affordance at all.** syncy does not delete, does
not offer to delete, and does not print `rm` commands for you to copy. It
reports the state of your files. What you do with a folder that reads
`verified` happens entirely outside this tool.

---

## 0. Constraints that shape the design

Each of these was measured on a real macOS setup rather than assumed, and each
one changes a decision downstream.

| Constraint | Consequence |
|---|---|
| macOS ships **openrsync** at `/usr/bin/rsync`, which advertises itself as "rsync version 2.6.9 compatible" and then rejects `-A` outright | The binary must be pinned by absolute path and never resolved from `PATH`. syncy checks the build and refuses to run against openrsync rather than failing later, per folder. |
| Homebrew installs rsync to `/opt/homebrew` on Apple Silicon and `/usr/local` on Intel; MacPorts uses `/opt/local` | Candidates are tried in order, with `SYNCY_RSYNC` overriding. |
| SMB shares frequently cannot persist ACLs or extended attributes | `-A`/`-X` may be silently lossy, so every file reports as changed forever and nothing reaches `verified`. Needs an empirical probe (§8) and per-destination flag overrides, not an assumption. |
| An unmounted `/Volumes/<share>` is still a writable directory on the boot disk | Reachability must be decided by a sentinel file, never by the path existing (§2). |
| A metadata-only walk of ~100k files takes about 2 seconds; `du` over the same tree takes 1.7 s | Source fingerprinting is cheap enough to run on every status refresh. A synchronous `statSync` walk sits within ~1.1× of C, because it bypasses libuv's threadpool — so a compiled language was never needed for this. |
| exFAT rounds timestamps to two seconds | Without `--modify-window=2` every file on a FAT-family destination looks perpetually changed. |
| Bun exposes `Bun.TOML.parse` | Config parsing needs no dependency. The only devDependencies are `typescript` and `@types/bun`; nothing but Bun, React and Ink ships in the binary. |

The motivating situation is a laptop whose boot volume is nearly full, holding
an archive that is also on an external drive and a NAS, where the question is
whether the local copy can safely be deleted.

## 1. Stack — locked 2026-08-20

| Layer | Choice |
|---|---|
| Language | TypeScript, `strict` |
| Runtime | Bun |
| TUI | Ink + React (Yoga flexbox layout) |
| State | Two plain files: `state.json` (atomic rewrite) + `history.jsonl` (append-only) |
| Subprocess | `Bun.spawn` + line reader over stdout; `.kill()` for cancel |
| FS walk | `node:fs` `opendirSync` / `statSync` (measured above) |
| Config | TOML at a runtime path, then a **runtime schema validator** |
| Ship | `bun build --compile` → one self-contained Mach-O binary |

```bash
bun build --compile --minify --target=bun-darwin-arm64 src/main.ts --outfile syncy
```

*Resolved 2026-08-20:* Bun 1.3.14 exposes `Bun.TOML.parse`, so config parsing
needs no dependency. The only devDependencies are `typescript` and `@types/bun`;
nothing ships in the binary.

### What TypeScript costs, and the mandatory compensations

Two properties were given up relative to Go. Both are recoverable, but only
deliberately, and both sit directly on the paths that can lose data.

1. **Types evaporate at runtime.** A Go struct decode validates config as a side
   effect of parsing. A TOML parse in TS hands back `any` wearing a type
   annotation. Config therefore *must* pass through a runtime schema validator
   (zod or valibot) before any path in it is touched — a mistyped destination
   path that type-checks perfectly is precisely how you rsync into the wrong
   directory. Non-negotiable.

2. **Errors are invisible by default.** Go forces `if err != nil` at every
   syscall; in TS a rejected promise can be swallowed silently. Required:
   `strict` and `noUncheckedIndexedAccess` in tsconfig; a top-level
   `process.on('unhandledRejection')` that logs and exits non-zero rather than
   limping onward; and explicit try/catch at every fs and subprocess boundary.
   No bare `await` on a syscall anywhere in the sentinel, verify, or status
   paths.

Ink's known weak spot is high-frequency full-frame re-rendering. The log pane
(§6) tails a fast-moving rsync stream, so it batches incoming lines and commits
at a capped rate (~20 fps) instead of setting state per line.

---

## 2. Model

**Unit** — a directory that is the atom of both sync and status. There is **one
source root**, and the units are its **immediate subfolders** — not a
configurable depth, not an explicit list. Status is determined per unit, never
per file. A unit's path relative to the source root is also its path relative to
each target root, which is what makes N targets comparable at a glance.

**Target** — one of **N named target roots**, each a directory syncy can reach
and each holding the same subfolder structure as the source root. The names are
the user's; nothing in the engine knows about any particular one, and a test
fails the build if a specific name appears in `src/`. One target is a valid
configuration, as is five. `required = false` tracks a target without letting it
hold a unit back.

**Destination** — a named target: `external` (local disk) and `nas` (SMB). Each
carries a **sentinel**: `.syncy-dest-id` at the destination root holding a UUID
written once at setup.

> The sentinel is the single most important safety feature. `/Volumes/media`
> remains a writable directory *on the boot disk* when the share is unmounted,
> and macOS silently remounts at `/Volumes/media-1` when a stale mount lingers.
> Without a sentinel check, an unattended rsync fills your startup disk with a
> copy of the data you were trying to move off it. Every operation — verify,
> sync, status — refuses to proceed on a sentinel miss.

**State** — two files under `~/.local/state/syncy/`, no database.

`state.json` holds current scan results, one entry per unit × target: timestamp,
method (`quick` | `deep`), result, change and extra counts, bytes pending, the
source fingerprint at scan time, and the log path. At ~14 units × 2 targets that
is under 30 entries — read whole, rewritten whole.

`history.jsonl` is an append-only line per rsync invocation: timestamp, unit,
target, literal argv, exit code, log path.

SQLite was the earlier choice and was dropped deliberately. Its advantages —
concurrency, query planning, scale — answer problems this tool does not have at
this size and with a single process. What matters more is that a tool whose
entire product is *"trust my record"* should keep a record you can `cat`,
`grep`, diff and back up without a client. Dropping it also removes schema
migrations, since the runtime validator required for config (§1) covers both.

**`state.json` must be written atomically** — write to a temp file in the same
directory, `fsync`, then `rename`. It is the single worst file in the system to
half-write, because a torn verification record is exactly the kind of corruption
that could make an unreplicated folder read as `verified`. `history.jsonl` is
append-only precisely so history writes can never endanger state.

### Write policy

**syncy writes directly only inside its own config and state directories.**
Everything that lands in a source or target directory gets there via rsync — the
sentinel and the capability probe's payload are built in a staging directory
under `~/.local/state/syncy/staging` and delivered by `rsync`, the same path a
real transfer takes.

Consequences worth stating:

- A sync does **not** pre-create its destination; rsync does. A refused transfer
  therefore leaves nothing behind at all.
- The one direct removal outside the state directory is the probe's own
  `.syncy-probe` directory, and it refuses any path not named exactly that.
- `staging.ts` owns the only file-writing call used for target-bound content, so
  no other module needs one.

This is enforced, not documented: a test reads every file under `src/` and fails
on any direct filesystem write outside a short allow list of modules that own
syncy's own directories.

**Source fingerprint** — `(nfiles, total_bytes, max_mtime_ns)` from a
synchronous `opendirSync` walk of the unit. Metadata-only, ~2 s per 100k files.
Stored with every scan so a later run can ask *"has the source changed since I
verified this?"* without touching the destination at all. This is what makes a
stale verify detectable while the NAS is offline.

---

## 3. Verification tiers

All three share `RSYNC=/opt/homebrew/bin/rsync` and the unit's exclude list.

**Quick check** — rsync's native size+mtime comparison. Minutes.
```
$RSYNC -aAX -n -i --delete --out-format='%i|%l|%n' "SRC/" "DST/"
```

**Deep verify** — full checksum of both sides. Hours over SMB; run on demand or
overnight.
```
$RSYNC -aAXc -n -i --out-format='%i|%l|%n' "SRC/" "DST/"
```

**Sync** — the real write.
```
$RSYNC -aAX -h --info=progress2 --partial-dir=.syncy-partial \
       --exclude='.syncy-*' "SRC/" "DST/"
```

### Three deliberate changes from the current commands

- **`--delete` added to verification only.** The current verify omits it, which
  means extra files *at the destination* are invisible — a destination can hold
  gigabytes of deleted-at-source cruft and still report clean. Under `-n` this is
  read-only and purely informational; extras are counted separately as `n_extra`
  and do **not** prevent a `verified` status (junk at the destination doesn't endanger source
  data). Hard invariant in the executor: `--delete` may only ever appear in an
  argv that also contains `-n`, asserted at spawn time, process refuses to start
  otherwise.

- **`-P` replaced with `--partial-dir` + `--info=progress2`.** `-P` is
  `--partial --progress`. Bare `--partial` leaves a truncated file at the final
  path when a transfer is interrupted — and a truncated file is exactly what a
  later quick check will compare by size and mtime. `--partial-dir` parks the
  fragment out of the way instead, so an interrupted sync can never leave
  something that a verify might bless. (On a `--dry-run`, `-P` was doing nothing
  at all.)

- **`-c` moved out of the routine path.** `-c` checksums every file on *both*
  sides. Against 12 TiB over SMB that is an overnight job, not a status check.

Parsing: `--out-format='%i|%l|%n'` yields the itemize flags, byte length, and
name per line — so `bytes_pending` is exact rather than estimated.

**Column 1 of the itemize string decides the classification**, and getting this
wrong was a real defect. `>` `<` `c` `h` mean the item is being transferred or
created; `.` means it is *not* being updated and only attributes differ;
`*deleting` marks an extra at the target.

Counting `.` entries as pending changes made a fully-replicated unit read as
`behind`. Deleting one file at a target moves its parent directory's mtime, so
rsync itemizes `.d..t......` for the directory alongside the genuinely missing
file — and the unit would then show `▲1` indefinitely, never reaching
`verified`. Intermittently, too, since it depended on whether the directory
mtimes happened to diverge.

Attribute-only entries are therefore counted as `n_metadata`: they do not block
a `clean` result and contribute no pending bytes, but they are still counted
rather than discarded, because a share that cannot persist xattrs shows up here
as every file differing forever — the exact failure the probe (§8) exists to
catch.

---

## 4. Cell states — one per (unit × destination)

Five states. They collapsed from seven by asking *what action does this state
demand?* — two states that produce the same next command are one state with two
reasons, and a symbol you have to memorise should always earn its place.

| | State | Means | Action |
|---|---|---|---|
| `✓` | **verified** | Checksummed against source, matched, source unchanged since | none |
| `~` | **unverified** | Present and matching on size+date, but contents never checksummed — or were, and that verify has since expired or been invalidated | deep verify |
| `▲` | **behind** | Present, N files not yet copied (count shown inline: `▲143`) | sync |
| `✗` | **missing** | Not present at the destination at all | sync (full copy) |
| `?` | **unchecked** | Cannot see this destination right now | mount the volume |
| `!` | **error** | rsync exited non-zero; log linked | read the log |

Three former states merged into `~`: *quick-checked only*, *source changed since
verify*, and *verify older than `max_verify_age_days`*. All three mean "the
checksum evidence is not good right now, go get some." The distinction survives
as reason text, not as a glyph.

Vocabulary notes: **behind** rather than "drift" (says which direction, implies
the fix). **missing** rather than "absent". **unchecked** rather than "offline" —
the old word described the drive, but the cell reports the state of our
*knowledge*. A detached drive is not a fact about the data.

Symbols are single-width text glyphs, never emoji. Emoji are double-width,
render inconsistently in Menlo, and some carry variation selectors that shift
column math — they would break the alignment this design rests on.

## 5. Unit status and the `verified` rule

Unit status is **the weakest state among its required destinations** — the same
five words as §4, at both levels. Status describes the state of the files; it
never prescribes an action.

| Unit status | Means |
|---|---|
| `verified` | Every required destination checksum-verified, source unchanged, sentinels present. This is the state in which deleting the source is safe. |
| `unverified` | Present on every required destination and matching on size+date, but at least one was never checksummed — or its verify expired |
| `behind` | Present everywhere, but at least one destination is missing files |
| `missing` | At least one required destination does not have it at all |
| `unknown` | A required destination cannot be checked right now |

No row, footer, or screen frames status as an action. The footer totals
`412 gb verified` and `44 gb awaiting external` — both statements of fact.

Two naming decisions worth preserving. `synced` is *not* used for the top state:
in rsync usage it means "rsync reported no changes," which is the size-and-date
check — weaker than what this tool means when it clears a folder for deletion,
and reusing the word would quietly borrow rsync's looser guarantee. And
`unverified` and `behind` are kept apart rather than merged into a single
`partial`, because "on both drives but never checksummed" and "8.4 gb genuinely
not copied yet" are the exact distinction the tool exists to draw.

`missing` and `unknown` both mean the source must be kept, and are deliberately
distinct anyway. *We checked and it is not replicated* and *we could not check*
must never look alike; collapsing them is how a tool ends up implying certainty
it does not have.

A unit reaches `verified` only when, for *every* destination marked
`required = true`:

1. `result == verified`, and
2. `method == deep`, and
3. the stored source fingerprint equals the fingerprint right now, and
4. the deep verify is younger than `max_verify_age_days` (default 30) **and**
   a quick check has passed within `max_quick_age_days` (default 7), and
5. the sentinel matches **right now**, not merely at scan time,

and the number of satisfying destinations is `>= min_destinations` (default 2).

**Rule 5 is strict, by explicit decision (2026-08-20).** A destination that
cannot be seen at this moment cannot support a `verified` status, regardless of
how recently it verified clean. The known cost: while the external drive is
detached, affected units read `?` / `unknown` and the ledger cannot clear them.
That was accepted over a hybrid that trusted the record for browsing and
demanded proof only at deletion time.

**Strictness governs the verdict, not the display.** An unchecked destination
still shows its full history in the selected-row detail line — when it last
verified, when it was last connected. Reporting history is not the same as
concluding from it. The footer likewise reports `44 gb awaiting external`
separately from `412 gb verified`, so what is merely unconfirmed never gets
totalled with what is proven.

Rules 3 and 4 are what separate this from a naive "it copied once" tracker.
Rule 3 catches *you* changing the source after verifying, at any age.

Rule 4 runs **two clocks**, because the two risks have wildly different costs to
detect. A deletion or truncation at the destination is caught by a *quick* check
in minutes, so that clock is short (7 days). Silent bit rot — same size, same
mtime, different bytes — needs a full checksum pass costing hours over SMB, so
that clock is long (30 days). One clock forced a bad trade: short enough to
catch accidents meant nothing ever stayed `verified`, and a tool where every row
reads `unverified` is a tool you stop reading.

Note the deep window is only ever guarding bit rot. Whether 30 days is right
depends on how long a full deep verify actually takes against `the NAS`, which
is unmeasured — settle it after phase 1 with a real timing, not by argument.

Anything short of all five reports the specific reason (`nas not checksummed`,
`external not connected`, `8.4 gb on nas`) rather than a bare glyph, because
the reason names the next command to run.

## 6. TUI

Ink + React, single screen. The layout is 76 columns — fits an 80-column
Terminal.app window without degradation — and widens to at most 110 on a larger
one. It **fills the terminal**: the ledger sits at the top and a flexible spacer
pushes the legend and footer to the bottom edge, so the layout does not jump as
rows are filtered away.

syncy takes the **alternate screen buffer**, so quitting restores whatever was
on screen before rather than leaving a ledger in the scrollback. Every exit path
— normal, SIGINT/SIGTERM/SIGHUP, and an error out of the render loop — restores
it, because stranding a terminal in the alternate buffer with a hidden cursor is
the classic full-screen failure. It is a no-op when stdout is not a tty, so
piping `syncy` emits no escape sequences.

This is screen *occupancy*, not colour: syncy still never paints a background.

```
  syncy                                           archive ledger · 20 aug 2026

  folder                        size   ext  nas    status
  ────────────────────────────────────────────────────────────────────────────
  photos/2019 .............   412 gb   ✓    ✓      verified
  photos/2020 .............   388 gb   ✓    ~      unverified · nas not checksummed
  photos/2024 .............   210 gb   ✓    ▲143   behind · 8.4 gb on nas
» projects/archive ........    44 gb   ?    ✓      unknown · external not connected
  video/raw ...............   1.2 tb   ✗    ✗      missing · never copied
  ────────────────────────────────────────────────────────────────────────────
  projects/archive  ext  verified 15 aug · 09:12 — not connected since 18 aug
                    nas  verified 15 aug · 18:40
                    source unchanged since verify · 3,204 files · 44.1 gb
  ············································································
  ✓ verified    ~ unverified    ▲ behind    ✗ missing    ? unchecked

  5 units · 2.25 tb             412 gb verified        44 gb awaiting external

  [q] quick   [d] deep   [s] sync   [e] evidence   [f] filter   [?] keys
```

- **Rows are sorted alphabetically by folder path, always.** A folder keeps a
  stable screen position across runs — worth more over years than sorting by
  whatever happens to be verified today.
- **Verify ages live in the detail line, not the row.** That is how a cell stays
  one glyph wide without losing evidence-forward density. The detail line
  follows the selection.
- **`▲` carries its count inline** (`▲143`) because magnitude changes the
  decision: 143 files behind is a two-minute sync, 1.2 tb missing is overnight.
  It is the one number worth spending row width on.
- **Selection is a left-margin mark (`»`)**, never a colored side stripe.
- `e` expands the full evidence trail for the selected unit — every destination,
  when it verified, when it was last seen, the source fingerprint. It ends
  there: no recommendation, no command to copy.
- `f` filters the ledger by status (`verified`, `behind`, `unknown`, …). A
  filtered list of fully-verified units serves the same purpose without the
  action framing.
- `p` copies the *sync* plan — the rsync commands needed to bring destinations
  up to date — to the clipboard via `pbcopy`. Only ever sync commands.

**Column alignment is the highest-risk detail in the build.** Every glyph in the
legend is multibyte: `✓` is three bytes and one display column. Any padding done
with `.length` — or with `printf %-5s`, which is how this was hit twice while
drafting these mocks — pads by bytes and shears the columns. All column padding
must go through a string-width function that accounts for multibyte and
double-width characters. This is worth a unit test with a `✓`, a `▲`, and a CJK
character in it.

**Job runner.** Jobs run one worker per destination so two jobs never contend
for the same SMB link. Each writes to
`~/.local/state/syncy/logs/<ts>-<unit>-<dest>.log`; the TUI tails the file
rather than holding the pipe, so a job survives the TUI being closed and
reattaches on restart. React state is only ever updated from a drained queue —
the render loop never blocks on rsync, and log lines commit in batches at
~20 fps rather than per line.

**Sync guard rails.** `s` opens a full-page confirm — not a floating modal —
showing the literal argv, the pending change count, and five checks as a
readable list: `rsync`, `source`, `sentinel`, `space`, `dry run`. It refuses to
launch when the sentinel is missing or mismatched, when free space is under
`bytes_pending * 1.05`, or when `--delete` appears without `-n`. The `dry run`
row reads `no · this writes to the target` on a real sync — stated, never
implied.

The argv is appended to `history.jsonl` with `exitCode: null` **before** the
process spawns, and again with the real exit code when it finishes, so a sync
that takes the machine down still leaves a record of what was attempted.

After a transfer the job view says the target is *not verified until it is
checked*. A completed rsync proves a copy happened; it never proves the copy
matches, and only a deep verify may move a unit to `verified`.

## 7. Setup screen — configuration is UI, not a text file

*Implemented 2026-08-20. Reached with `,` from the ledger, and opened
automatically on first run when no config exists.*

Configuration happens in the app. Adding a target is the natural moment to write
its sentinel, detect its filesystem, and probe its metadata support — none of
which the user should be pasting into TOML by hand.

```
  syncy · setup                                   archive ledger · 20 aug 2026

  source
  ────────────────────────────────────────────────────────────────────────────
  /Users/you/Pictures/Archive                                 14 subfolders
                                                                     2.25 tb

  targets
  ────────────────────────────────────────────────────────────────────────────
» ext   /Volumes/Archive/photos                                not connected
        apfs · sentinel 3f2a91c4 · xattrs ok · required

  nas   /Volumes/media/archive                                   4.9 tb free
        smbfs · sentinel 9c41e0b2 · xattrs dropped · required

  + add target
  ────────────────────────────────────────────────────────────────────────────
  units are the immediate subfolders of the source root
  ············································································
  [enter] edit   [a] add   [x] remove   [p] probe   [esc] back
```

Adding a target, with path completion against the live filesystem:

```
  syncy · setup · add target                      archive ledger · 20 aug 2026

  targets
  ────────────────────────────────────────────────────────────────────────────
  path      /Volumes/media/arch▏
            ────────────────────────────────────────────
            /Volumes/media/archive
            /Volumes/media/archive-2024

  name      nas
  required  yes
  ────────────────────────────────────────────────────────────────────────────
  smbfs detected · will probe for acl and xattr support on save
  ············································································
  [tab] complete   [enter] save   [esc] cancel
```

**On save, syncy does four things** the user would otherwise have to do by hand:

1. Writes `.syncy-dest-id` with a fresh UUID, and records it (§2 sentinel).
2. Reads the filesystem type from `mount` and stores the implied
   `--modify-window` — exFAT gets `2`, since its two-second timestamp
   granularity otherwise makes every file look perpetually changed.
3. Runs the capability probe (§8) and stores the resulting `flags_drop`, so a
   share that cannot persist xattrs is discovered at setup rather than through
   months of phantom drift.
4. Refuses the path outright if it is inside the source root, or if the source
   root is inside it. Nested source and target is data loss waiting to happen.

A config with **zero targets is valid and loadable** — it is where setup
begins. That is safe only because `min_targets` is floored at 1, so an empty
roll-up can never read as "all targets verified"; `evaluateUnit` refuses it. The
guarantee is asserted directly in the tests rather than left implicit.

Each target has a `required` flag. Only required targets participate in the
`verified` rule (§5); a target marked optional is tracked and displayed but
never blocks a unit from reaching `verified`.

### On-disk form — `~/.config/syncy/config.toml`

Still TOML, still validated against a runtime schema on read (§1) — the file can
be edited or corrupted between runs even though the app owns it — but it is
written by the setup screen, not authored by hand.

```toml
source = "/Users/you/Pictures/Archive"

[status]
max_verify_age_days = 30   # deep: guards silent bit rot
max_quick_age_days  = 7    # quick: guards deletion and truncation
min_targets         = 2

[[target]]
name          = "ext"
path          = "/Volumes/Archive/photos"
required      = true
sentinel      = "3f2a91c4-..."
fstype        = "apfs"
modify_window = 0
flags_drop    = []

[[target]]
name          = "nas"
path          = "/Volumes/media/archive"
required      = true
sentinel      = "9c41e0b2-..."
fstype        = "smbfs"
modify_window = 0
flags_drop    = ["-X"]
```

## 8. Capability probe — `syncy probe nas`

Before trusting `-A`/`-X` against an SMB share, measure it. The probe writes one
temp file carrying an xattr, a resource fork, and an ACL; rsyncs it to the
destination; reads it back; and reports what survived the round trip. Output is
a recommended `flags_drop` line to paste into the config.

Without this you get the classic SMB failure mode: `-X` cannot persist, every
verify reports the same files as changed forever, and nothing ever reaches
`verified`, with no explanation.

---

## 9. Scope and build order

**v1 is manually triggered from the TUI.** No launchd job, no headless
`check --all`, no unattended syncing. Deferred to v2 once the interactive tool
has proved itself; an unwatched sync that fails into a partial state is exactly
what this tool exists to detect, so it should not be the thing that creates one.

### Order

1. ~~**Engine + `syncy status` / `syncy verify` as plain CLI.**~~ **Done
   2026-08-20** — 109 tests, typecheck clean, compiles to a 59 MB binary. Config parse and
   schema validation, sentinel check, fingerprint walk, rsync invocation,
   itemize parser, `state.json` + `history.jsonl`, status ladder. Everything load-bearing is here
   and testable with `bun test`, before any Ink component exists.
2. ~~**Ink TUI** over that engine~~ **Done 2026-08-20** — ledger, selection,
   filters, evidence view, help, and the two non-destructive checks bound to
   keys. Themes are semantic tokens with `dark` / `light` / `ansi`
   implementations. The setup screen (§7) is done: source root and targets are
   configured in the app, with path completion, and saving a target writes its
   sentinel, detects the filesystem, and runs the capability probe.
3. ~~**Sync execution** with the confirm page and guard rails.~~ **Done
   2026-08-20** — `s` opens a full-page confirm showing the literal argv and
   every guard verdict; only `[enter]` there starts a transfer, and only when
   all five checks pass. The job view batches log lines at ~20fps and can be
   cancelled. Sync uses `-i --out-format` rather than `--info=progress2`,
   because progress2 emits carriage-return lines a newline reader cannot
   surface live.
4. **`probe`, `plan`, evidence view, filters, history.**
5. **`bun build --compile`**, binary into `~/.local/bin/syncy`.

Phase 1 alone already answers both original questions; phases 2–5 are ergonomics
and packaging.
