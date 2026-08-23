# Working in this repo

syncy tells someone whether their irreplaceable files exist somewhere else.
Every rule below exists because something specific went wrong, and each one
names the incident. `DESIGN.md` covers what the design is and why; this covers
how to work on it.

---

## Invariants

These are the product. Breaking one is worse than shipping nothing.

**Never delete anything.** No `rm`, no offer to delete, no printing `rm`
commands for the user to paste. `--delete` appears only in the quick check,
where `-n` makes the whole command a listing — its job is to reveal files at a
destination with no counterpart at the source. `assertDeleteIsDryRun` refuses to
spawn any argv containing `--delete` without `-n`. Do not weaken it.

**Nothing reaches a source or destination except through rsync.** Direct
filesystem writes are confined to syncy's own config and state directories.
`test/write-policy.test.ts` reads every file under `src/` and fails on a direct
write outside a short allow list. Adding to that list requires a reason in the
list itself.

**A destination is identified by asking the OS, not by the path existing.** An
unmounted `/Volumes/x` is a writable directory on the boot disk; a path check
would let rsync fill the startup volume with the data being moved off it.

**Never claim more than was established.** A status reports what a check proved.
`verified` means bytes were read and compared, and nothing weaker may render as
it.

---

## Before pushing

**Scan the history, not the working tree.** A leak introduced in one commit
survives cleaning the tip, because history is immutable. This actually happened:
a comment containing a real hostname and username was caught by a pre-flight,
removed from the tree, and pushed anyway in four earlier commits — then had to
be found later and the history rewritten.

```
bun run audit
```

That scans every reachable blob, every commit message, and the working tree for
machine-specific identifiers. Run it before any push. If it finds something
already published, rewriting history is not sufficient on its own: the objects
stay fetchable by SHA until the host garbage-collects, which has to be requested.

**Comments are the usual source.** They get written during live debugging, which
is exactly when the details at hand are real hostnames, volume names, device
nodes and IP addresses. Use `//user@host/share`, `/Volumes/Archive`,
`/dev/disk4s1`. Never a path that exists on the machine you are working on —
`test/containment.test.ts` enforces that for test files, and `bun run audit`
covers the rest.

---

## Measure, don't assert

Most wrong conclusions in this repo came from a test that could not have shown
the truth, not from bad reasoning about the results.

**A fixture that finishes too fast proves nothing about streaming.** "rsync
streams its output" was concluded from a run lasting 0.27s, then contradicted by
a real archive. **A fixture of the wrong shape proves nothing either**: 40,000
tiny files stream evenly, 40 large files emit everything in the final fifth, and
only the second resembles a photo archive. Match the fixture's shape to the real
workload before drawing a conclusion from it.

**Check what a null result means before reporting it.** A probe printed `0 lines
in 0.0s` and was nearly reported as "rsync produced nothing" — the command had
not run, because `timeout` was not installed.

**Count the right thing.** A verdict of "rsync streams" was derived from a single
banner line. Filter to the output that answers the question.

**Verify a guard fails.** A test that passes proves nothing until you have seen
it fail for the reason it exists. Reintroduce the bug, watch it go red, restore.
Two guards in this repo were "verified" by sabotage that did not actually disable
the behaviour under test.

---

## Silence is the bug class

Every significant defect here was the interface knowing something the user did
not.

- A file counter frozen at `0/935` for twelve minutes while rsync worked.
- A destination that could not be reached, skipped in silence, then reported as
  `deep check finished`.
- A keypress arriving during a check, discarded by an early `return`.
- `timed()` defined and never called, so nothing said where time went.
- A per-render debug line, 38,006 of 38,025, drowning the diagnostics.

**Rules that follow.** If a key does nothing, say so. If work was skipped, name
it and what blocked it. If a number cannot be known, show elapsed time and say
why, rather than a zero that reads as a hang. If a bar cannot be honest, do not
draw it. Never report success for work that did not happen.

---

## Layout

**Ink drops overflow silently and welds the remnants together.** A notice once
rendered as `…is still running 00s`, where `00s` was the tail of a deleted line.
Layouts must fit by construction: budget the chrome, window the rows, and shed
optional parts in a stated order when the window is too short.

**Fit by measurement, never by counting characters.** The key hint line
overflowed three times because it was added up by hand. `hintLine(width)` and
`legendLine(width)` measure and trim. Every screen has a test asserting no line
exceeds its width at 76, 92 and 120 columns.

**Every glyph is multibyte.** Pad with `displayWidth`, never `.length`.

---

## Language

**One word per concept, everywhere the user reads it.** The legend said
`? unchecked` while the status column printed `unknown` for the same glyph and
condition. Destinations were `target` in half the screens and `destination` in
the other half. `Target` remains the internal type and `[[target]]` the config
key, for compatibility; no screen says both.

**Say what was established, not what was skipped.** `never checksummed`
describes an absence. `size and date match, bytes unread` describes what a quick
check proved and what it could not.

**Do not describe a method when you can describe the evidence.** "504 files
differ by content" was inferred from the check being a deep one, while the files
in question did not exist at the destination at all.

---

## Tests

**Wait on observable state, never on a duration.** Fixed sleeps made the
end-to-end test a bet on machine load. It then failed 4 runs in 6 when the
replacement waited on ledger text that still showed the *previous* pass's
verdict — so the condition was already true, and the next keypress landed
mid-check and was swallowed. Wait on the recorded scan in `state.json`, which
cannot be stale.

**Fixtures never leave the project.** `makeFixtureDir` throws on a path outside
it; `removeFixtureDir` refuses one outside the fixture root; a preload redirects
the XDG directories before any test file loads. One test asserts a full run
leaves the real config and state byte-identical.

**Tests run real rsync against real files.** That is deliberate — the behaviour
worth testing is the behaviour that touches the filesystem.

---

## Commits

Subject in the imperative, describing the change in the product's terms rather
than the code's: *Report destinations a check could not reach*, not *add skipped
array*. Where a change is a correction, the message and the comment should say
what was wrong — the reasoning is worth more than the diff.

Run `bun test`, `bunx tsc --noEmit` and `bun run build` before committing. Keep
the test count in `README.md` current; `test/readme.test.ts` checks it, along
with the rsync commands the README documents.
