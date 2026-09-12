# Syncy Mac canonical UI state matrix

This is the copy contract for the Mac surface. It describes evidence, not a
recommendation. The same words appear in the ledger, Differences, menu bar,
popover, notifications, and task history.

## Vocabulary

| Reader-facing term | Meaning |
| --- | --- |
| `destination` | A named place Syncy identifies and checks. `target` remains an internal configuration name only. |
| `verified` | Bytes were read and compared; the source is unchanged and the evidence is current. |
| `unverified` | Size and date match, but bytes are unread, or the checksum evidence is stale. |
| `behind` | Files are missing at a destination; the count is shown when known. |
| `missing` | The folder is not present at a required destination. |
| `unchecked` | Nothing can be concluded because the destination cannot be identified, or it has never been checked. |
| `error` | A task or configuration failed; no new verification is implied. |

`unknown`, `offline`, `synced`, and `clean` are not ledger status words. “Clean”
may describe a Differences result only when a recorded check has no entries.

## Differences states

| State | Canonical title | Supporting copy |
| --- | --- | --- |
| clean | **No differences** | The recorded check found no differences. Include method, read time, and counts. |
| no record | **No check recorded** | No recorded check for this destination. Run a check to record differences. |
| error | **Differences unavailable** | The recorded listing could not be read. No new verification was recorded; previous evidence remains unchanged. |
| stale | **Evidence is stale** | Name the age or source change. Current status is `unverified`, never `verified`. |
| wrong volume | **Destination identity changed** | The records here were made against a different volume. Current status is `unchecked`. |
| whole folder missing | **Whole folder missing** | The source holds the files; nothing was itemized at this destination. |
| truncated | **Listing truncated** | `N more not stored · counts remain exact.` The cap limits rows, not totals. |

The Differences destination defaults to the first required destination that
needs work. If none needs work, it defaults to the first recorded destination.
The user can change it explicitly; the visible label remains `Destination`.

## Work in progress

| Evidence available | Render | Never render |
| --- | --- | --- |
| Checksum work is silent | Elapsed time, phase, typical duration when known, and last observable event. | A synthetic percentage, spinner-as-progress, or empty bar. |
| Rsync reports a denominator | A measured bar plus `N of M files observed` or measured bytes. | A percentage whose denominator was inferred. |

## Task outcomes

| Outcome | Canonical copy | Evidence rule |
| --- | --- | --- |
| `completed` | `Deep verify · 5 folders · evidence recorded` | The work ran and recorded its result. |
| `skipped` | `Studio NAS · not connected · skipped` | No check ran; never label it completed. |
| `failed` | `rsync exited with code 12` | No new verification was recorded. |
| `cancelled` | `Check cancelled · no verification was recorded` | Preserve the previous evidence and its original time. |
| `missed` | `Quick check · Mac asleep · missed` | Nothing ran; name the absence. |

Background refresh is quiet when it records no new evidence: `No new evidence
recorded · ledger remains unchanged.` The menu bar may say when it refreshed,
but it does not claim that a check completed.
