# Syncy for Mac mockups

Open [`mac-app-mockups.html`](./mac-app-mockups.html) in a browser. It is a
self-contained static gallery with no dependencies or build step.

## Direction

The Mac app is a ledger, not a dashboard: exact, unhurried, and unpersuasive.
The warm paper-and-ink palette extends the terminal themes into native macOS
surfaces. Color is semantic and sparse. Shape and text continue to distinguish
states when color is unavailable.

The time model separates measurement from inference:

- elapsed time and current phase are always shown;
- rsync byte/file progress appears only when rsync reports it;
- silent checksum work has no progress bar;
- historical durations are labeled as a range, never a measured percentage;
- a run beyond that range remains “running” unless a failure is observed;
- partial, skipped, failed, cancelled, and missed work remain distinct outcomes.

## Existing-function coverage

| Syncy function | Mac surface in the mockups |
|---|---|
| Ledger and status | Main ledger window; menu-bar summary |
| Refresh | Main-window toolbar |
| Filter | Ledger segmented control |
| Quick check, selected or all | Folder detail and menu popover |
| Deep verify, selected or all | Folder detail, menu popover, schedule |
| Differences | Folder detail grouped by evidence type |
| Verification evidence | Folder detail evidence inspector |
| Sync plan and fresh preflight | Sync plan sheet |
| Sync confirmation | Explicit source/destination/command acknowledgement |
| Sync execution | Running task sheet and persistent task shelf |
| Cancellation | Running task plus consequence confirmation |
| Command preview and copy | Evidence inspector and sync plan |
| Source setup | Settings with native folder picker |
| Add and inspect destination | Destination settings |
| Volume identification and probe | Destination evidence and Doctor |
| Sentinel adoption/repair | Destination inspection is the intended entry point |
| Doctor | Settings diagnostics section |
| Logs | Error, task, and history actions |
| History | Task history table |
| Scheduling | Quick, deep, and explicit-write sync schedules |
| Notifications | Schedule annotation and partial-skip outcome |
| Launch at login/background life | Schedule copy and “window may close” task states |

## Review checklist

- The menu-bar mark is useful without relying on color.
- A silent deep verify answers: alive, elapsed, phase, normal range, last event.
- No silent deep verify shows a synthetic percentage or bar.
- A measured sync identifies its denominator and labels progress as measured.
- A partially skipped batch never reads as fully completed.
- A failed or cancelled job never creates new verification evidence.
- No interface contains a delete affordance.
- All desktop and narrow layouts avoid horizontal document overflow.
- Both appearances use the same semantic hierarchy.
