import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import type { Config } from "../src/config.ts";
import { EMPTY_STATE, type Scan, type State } from "../src/state.ts";
import { targetIdentity } from "../src/status.ts";
import { Evidence, Help } from "../src/tui/App.tsx";
import type { Row } from "../src/tui/Ledger.tsx";
import { Mark } from "../src/tui/Mark.tsx";
import { THEMES } from "../src/tui/theme.ts";
import { displayWidth } from "../src/width.ts";

/**
 * The two screens defined inside App.tsx, measured by rendering them.
 *
 * The previous version of this file asserted against a *reimplementation* of
 * Evidence's formatting — it rebuilt the padded strings inline and checked
 * those. That cannot fail for the reason it exists: change the real screen and
 * the copy in the test still fits, so the guard reported coverage it did not
 * have. Evidence and Help are exported now so the assertions can run against
 * what is actually drawn.
 *
 * Both are checked at 76, 92 and 120 columns, the same widths every other
 * screen's test uses. 76 is `useScreen`'s MIN_WIDTH: the narrowest window the
 * interface will lay out for, and the one where Ink starts dropping lines and
 * welding the remnants together.
 */

const plain = (s: string | undefined): string => (s ?? "").replace(/\[[0-9;]*m/g, "");
const WIDTHS = [76, 92, 120] as const;
const NOW = Date.UTC(2026, 7, 23);

/** A destination name in a script where one character occupies two columns. */
const WIDE_NAME = "写真";
const LONG_PATH = "/Volumes/Archive/photography/masters/originals/by-year/2019/raw";

const config: Config = {
  source: "/src",
  maxVerifyAgeDays: 30,
  maxQuickAgeDays: 7,
  minTargets: 1,
  exclude: [],
  targets: [
    {
      name: WIDE_NAME,
      path: LONG_PATH,
      required: true,
      identity: "VOL-UUID",
      identityKind: "volume-uuid",
      fstype: "apfs",
      modifyWindow: 0,
      flagsDrop: [],
    },
  ],
};

const row: Row = {
  status: {
    unit: "photos-2019",
    state: "unverified",
    reason: "size and date match, bytes unread",
    cells: [
      {
        target: WIDE_NAME,
        state: "unverified",
        reason: "size and date match, bytes unread",
        nChanges: 0,
        bytesPending: 0,
        nExtra: 0,
      },
    ],
  },
  size: 1024 ** 3,
  files: 120,
};

/** Every rendered line, with colour stripped. */
const linesOf = (frame: string | undefined): string[] => plain(frame).split("\n");

describe("the evidence screen fits the window it is given", () => {
  for (const width of WIDTHS) {
    test(`no line exceeds ${width} columns`, () => {
      const { lastFrame } = render(
        <Evidence
          row={row}
          config={config}
          state={EMPTY_STATE}
          theme={THEMES.ansi}
          now={NOW}
          width={width}
          height={24}
        />,
      );
      for (const line of linesOf(lastFrame())) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    });
  }

  test("a destination name is padded by display width, not character count", () => {
    // 写真 is two characters and four columns. Padding it with String.padEnd
    // would shear the column beside it — the failure AGENTS.md calls the
    // highest-risk detail in this build.
    const { lastFrame } = render(
      <Evidence
        row={row}
        config={config}
        state={EMPTY_STATE}
        theme={THEMES.ansi}
        now={NOW}
        width={76}
        height={24}
      />,
    );
    const named = linesOf(lastFrame()).find((l) => l.includes(WIDE_NAME));
    expect(named, "no line carried the destination name").toBeDefined();
    // The state word follows the name in its own column; if the name were
    // padded by character count the two would collide rather than align.
    expect(named).toContain("unverified");
  });
});

/**
 * The evidence screen must not print a foreign volume's records.
 *
 * The bug this guards: the cell could read `unchecked · the records here were
 * made against a different volume` while the lines directly under it printed
 * that other volume's `deep clean · <date>` — the screen contradicting the
 * verdict above it, on the one page whose job is to show what the verdict
 * rests on. A record is evidence only if it was made against the identity the
 * destination resolves to now; a record made against some other identity must
 * leave the frame entirely — no outcome, no date.
 */
describe("the evidence screen does not print a foreign volume's records", () => {
  // The shared config's destination is on this volume now, via its `identity`;
  // this is the value the screen resolves, so it is resolved the same way.
  const currentIdentity = targetIdentity(config.targets[0]!);
  /** A different volume, mounted under the same name when the record was made. */
  const foreignIdentity = "OTHER-VOLUME-UUID";
  const FOREIGN_TS = Date.UTC(2021, 0, 15);
  const CURRENT_TS = Date.UTC(2025, 11, 20);

  /** A deep record for the shared row, made against whatever volume `sentinel` names. */
  const record = (sentinel: string, ts: number): Scan => ({
    unit: row.status.unit,
    target: WIDE_NAME,
    ts,
    method: "deep",
    outcome: "clean",
    nChanges: 0,
    nExtra: 0,
    bytesPending: 0,
    fingerprint: { nfiles: row.files ?? 0, bytes: row.size, maxMtimeNs: "0" },
    sentinel,
  });

  /** Only the other volume's record exists; the current volume has none. */
  const foreignState: State = { version: 1, scans: [record(foreignIdentity, FOREIGN_TS)] };

  test("a record made against a different volume contributes nothing to the frame", () => {
    // The acceptance criterion, asserted on both halves: the outcome word and
    // the record's date. The date is computed the way the screen renders it —
    // toLocaleString — so the absence is checked against exactly what a leak
    // would print, not a guess at the shape its locale would give it.
    expect(foreignIdentity).not.toBe(currentIdentity); // the two volumes really differ
    const { lastFrame } = render(
      <Evidence
        row={row}
        config={config}
        state={foreignState}
        theme={THEMES.ansi}
        now={NOW}
        width={92}
        height={24}
      />,
    );
    const frame = plain(lastFrame());
    expect(frame).not.toContain("clean");
    expect(frame).not.toContain(new Date(FOREIGN_TS).toLocaleString());
  });

  test("that case reads never on this volume, not the other volume's record", () => {
    // 92 is the narrowest width at which the full 72-column phrase survives
    // the screen's width - 18 budget; at 76 the same line is truncated, which
    // the width test below still measures.
    const { lastFrame } = render(
      <Evidence
        row={row}
        config={config}
        state={foreignState}
        theme={THEMES.ansi}
        now={NOW}
        width={92}
        height={24}
      />,
    );
    expect(plain(lastFrame())).toContain(
      "never on this volume · earlier records were made against a different one",
    );
  });

  test("a record made against the current volume still prints its outcome and date", () => {
    // The filter must exclude the foreign record, not evidence itself — a
    // screen that printed nothing for anyone would pass the absences above.
    const hereState: State = { version: 1, scans: [record(currentIdentity, CURRENT_TS)] };
    const { lastFrame } = render(
      <Evidence
        row={row}
        config={config}
        state={hereState}
        theme={THEMES.ansi}
        now={NOW}
        width={92}
        height={24}
      />,
    );
    expect(plain(lastFrame())).toContain(`clean · ${new Date(CURRENT_TS).toLocaleString()}`);
  });

  test("with no records at all it reads never, not the foreign-volume note", () => {
    // The note explains records that exist elsewhere; with none at all it
    // would be a claim about where nothing happened.
    const { lastFrame } = render(
      <Evidence
        row={row}
        config={config}
        state={EMPTY_STATE}
        theme={THEMES.ansi}
        now={NOW}
        width={92}
        height={24}
      />,
    );
    const frame = plain(lastFrame());
    expect(frame).toContain("never");
    expect(frame).not.toContain("on this volume");
  });

  for (const width of WIDTHS) {
    test(`no line exceeds ${width} columns with the foreign-volume note present`, () => {
      const { lastFrame } = render(
        <Evidence
          row={row}
          config={config}
          state={foreignState}
          theme={THEMES.ansi}
          now={NOW}
          width={width}
          height={24}
        />,
      );
      for (const line of linesOf(lastFrame())) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    });
  }
});

describe("the help screen fits the window it is given", () => {
  const states = new Map([[WIDE_NAME, "unverified" as const]]);

  for (const width of WIDTHS) {
    test(`no line exceeds ${width} columns`, () => {
      // Help was the only screen with nothing measuring it. This catches a
      // line the screen itself draws too wide; it cannot catch one that a
      // child draws too wide, because Ink wraps that away before it reaches
      // the frame — see the `Mark` block below, which is why that component
      // is measured on its own rather than through this one.
      const { lastFrame } = render(
        <Help
          theme={THEMES.ansi}
          width={width}
          height={24}
          config={config}
          units={3}
          states={states}
        />,
      );
      for (const line of linesOf(lastFrame())) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    });
  }

  test("it says what ctrl-c does during a transfer", () => {
    // "quit" alone stopped being true when the first ctrl-c during a transfer
    // became a cancel that keeps the screen up.
    const { lastFrame } = render(
      <Help theme={THEMES.ansi} width={92} height={24} config={config} units={3} states={states} />,
    );
    const line = linesOf(lastFrame()).find((l) => l.includes("ctrl-c"));
    expect(line, "no ctrl-c line in help").toBeDefined();
    expect(line).toContain("cancels");
  });
});

/**
 * `Mark` is measured on its own, not through the help screen that draws it.
 *
 * Inside `Screen`, Ink absorbs an over-wide row by wrapping it, so every line
 * of the frame comes back inside the limit and a composite assertion cannot
 * see the overflow at all — the same silent absorption AGENTS.md records,
 * where Ink drops lines and welds the remnants together. The row has to be
 * rendered by itself for the width to be observable.
 */
describe("the replication mark fits the window it is given", () => {
  for (const width of WIDTHS) {
    test(`a path exactly filling the old budget still fits at ${width}`, () => {
      // The discriminating case, and the only one that separates the two
      // budgets. `Mark` gave the path column `width - 33` columns while the
      // row draws 36 columns of chrome before it, so a path that fit that
      // budget *exactly* — needing no truncation, and so returned whole —
      // rendered at width + 3. Anything longer was truncated and happened to
      // land inside the limit, which is why almost every path hides this.
      const exact = "/V/" + "p".repeat(width - 33 - 3);
      expect(exact.length).toBe(width - 33);
      const { lastFrame } = render(
        <Mark
          config={{ ...config, targets: [{ ...config.targets[0]!, path: exact }] }}
          theme={THEMES.ansi}
          width={width}
          units={3}
          states={new Map([[WIDE_NAME, "unverified" as const]])}
        />,
      );
      for (const line of linesOf(lastFrame())) {
        expect(displayWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width + 2);
      }
    });
  }
});
