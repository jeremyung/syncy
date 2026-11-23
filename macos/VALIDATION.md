# Personal Mac build acceptance

The Mac app is implemented. Release acceptance still requires a clean-machine
smoke test; a successful build or a resident process cannot establish that the
interface launches, cancels work, or recovers its ledger correctly.

## Integration checked on 2026-11-22

The scheduling changes in PR #55 and engine ownership refactor in PR #54 were
combined against the same main revision. Their only merge conflict was the
README test count, updated to the measured combined count.

| Gate | Observed result |
|---|---|
| `bun test` | 1,070 passed, zero failed |
| `bunx tsc --noEmit` | Passed |
| `bun run lint` | Passed |
| `swift test` in `macos/` | 33 passed, zero failed |
| `./scripts/build-mac-app.sh` | Built the engine and Mac bundle; signature verification passed |
| `bun run audit` | Working tree, commit messages, and all reachable blobs clean |

The process-cleanup tests require permission to run `ps`. In a restricted
sandbox, 1,068 passed and two failed because `ps` could not run. The complete
suite was then rerun with process inspection allowed and all 1,070 passed.
Apple's icon compiler likewise needed to run outside the restricted sandbox.
Swift module caches were redirected into the build directory.

Two guards were independently checked by restoring their bugs: an engine
import from the interface made the layering test fail, and removing the
preflight configuration-revision validator made its required-field test fail.
Both changes were restored; all 24 layering and protocol tests then passed.

The desktop inspection tool timed out without returning an app window state.
An attempted sandboxed launch exited with status 134 and supplied no diagnostic
output. Neither observation establishes a successful visual launch or proves a
production launch defect. The smoke test below remains outstanding.

## Remaining smoke test for issue #32

Use a clean Mac account with supported macOS and rsync 3.x installed. Use only
synthetic files under this repository's `.test-tmp/` directory. Keep both XDG
config and state directories there as well. Retain the fixture and its records
for inspection.

1. Build and sign the app using the documented personal build path. Put a copy
   in Applications. Launch with `SYNCY_ENGINE` unset so engine discovery must
   find the bundled helper. Ensure the app process receives the isolated XDG
   directories; do not use a live archive for this test.
2. Confirm the menu-bar item and ledger window appear. Configure the fixture's
   source and destination through setup. Confirm the displayed folder and
   destination match the fixture, and Doctor reports the rsync build and
   destination identity.
3. Run a quick check. Wait for a newly recorded scan in the fixture's
   `state.json`, then compare the displayed verdict and history with that
   record. A previously displayed verdict is not completion evidence.
4. Prepare matching synthetic large files at both sides, copying to the
   destination through rsync. Start a deep verify. Wait for recorded live job
   ownership before pressing Stop. Confirm cancellation appears in history,
   ownership is released, and no rsync process associated with the fixture
   survives. Cancellation must not create a successful deep verification.
5. Start another check, quit using **Quit and Keep Running**, then relaunch.
   Confirm the app discovers the existing owner or the newly recorded outcome,
   and cannot launch conflicting work. Closing only the ledger window must
   leave the menu-bar app and owned work available.
6. Record the macOS and rsync versions, signing mode, exact build revision,
   observed outcomes, and any failure diagnostics. Close #32 only after every
   step has been observed. Reconcile umbrella issue #25 with that evidence.

## Separate scheduling decision

PR #55 makes a scheduled sync's refusal visible. It does not add a quick check
before that sync. Once the recorded backlog has been copied, later occurrences
can skip with “no recorded files to sync” until another check finds changes.
Deciding whether a sync schedule should discover new work first is a separate
product change, with its own ownership, cancellation, and outcome requirements.
