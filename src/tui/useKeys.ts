import { useInput } from "ink";

/**
 * The ledger's keyboard, as a state machine rather than a cascade of guards.
 *
 * Every key goes through the same decision: which screen owns the keyboard
 * right now? `App` used to answer that with a chain of early returns woven
 * through its key handler; the chain is the behaviour, and it is exactly this
 * code, moved out so the component can stay a composition of screens.
 *
 * The order of the guards is part of the contract: ctrl-c always comes first,
 * the help screen swallows every key, and a screen that owns the keyboard
 * (diff, plan, setup, the confirm and job pages) swallows it entirely —
 * `App`'s handler must not act on a key that screen has not decided with.
 */

/** Which screen owns the keyboard. */
export type KeyMode =
  | "ledger"
  | "help"
  | "evidence"
  /** Diff, plan, setup, confirm and job: the keyboard belongs to that screen. */
  | "inert";

/** What the ledger screen can do with a key. */
export interface LedgerKeys {
  readonly up: () => void;
  readonly down: () => void;
  readonly quick: () => void;
  readonly quickAll: () => void;
  readonly deep: () => void;
  readonly deepAll: () => void;
  readonly refresh: () => void;
  readonly cycleFilter: () => void;
  readonly evidence: () => void;
  readonly openDiff: () => void;
  readonly openPlan: () => void;
  readonly startSync: () => void;
  readonly setup: () => void;
  readonly help: () => void;
}

export interface KeyActions {
  /**
   * ctrl-c, before any other screen sees it. The caller decides whether it
   * exits right away: while a transfer is running, the first press is the job
   * screen's to act on (it cancels rsync), and only a second press exits.
   */
  readonly controlC: () => void;
  /** Any key closes the help screen. */
  readonly closeHelp: () => void;
  readonly closeEvidence: () => void;
  readonly ledger: LedgerKeys;
}

export function useKeys(mode: KeyMode, actions: KeyActions): void {
  useInput((input, key) => {
    if (key.ctrl && input === "c") return actions.controlC();
    if (mode === "help") {
      actions.closeHelp();
      return;
    }
    if (mode === "evidence") {
      if (key.escape || input === "e") actions.closeEvidence();
      return;
    }
    if (mode === "inert") return; // The owning screen has the keyboard.

    const k = actions.ledger;
    if (key.upArrow || input === "k") k.up();
    else if (key.downArrow || input === "j") k.down();
    else if (input === "q") k.quick();
    else if (input === "Q") k.quickAll();
    else if (input === "d") k.deep();
    else if (input === "D") k.deepAll();
    else if (input === "r") k.refresh();
    else if (input === "f") k.cycleFilter();
    else if (input === "e") k.evidence();
    else if (key.return) k.openDiff();
    else if (input === "p") k.openPlan();
    else if (input === "s") k.startSync();
    else if (input === ",") k.setup();
    else if (input === "?") k.help();
  });
}
