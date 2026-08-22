import { render } from "ink";
import type { Config } from "../config.ts";
import { debug } from "../log.ts";
import { clearTitle, setTitle } from "../title.ts";
import { App } from "./App.tsx";

/**
 * Full-screen entry point.
 *
 * syncy is a dashboard, so it takes the alternate screen buffer: it fills the
 * terminal, and quitting restores whatever was on screen before, leaving no
 * ledger stuck in the scrollback.
 *
 * Note this is about screen *occupancy*, not colour. syncy still never paints a
 * background — it draws foreground on the terminal's own canvas, which is why
 * light and dark are separate themes (DESIGN.md section 6).
 */

const ENTER_ALT = "\u001B[?1049h";
const LEAVE_ALT = "\u001B[?1049l";
const HOME = "\u001B[H";
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";

/** Minimal surface so this is testable without a real terminal. */
export interface ScreenStream {
  readonly isTTY?: boolean | undefined;
  write(chunk: string): unknown;
}

/**
 * Takes the alternate screen buffer and returns the function that gives it
 * back. Idempotent: several exit paths race to call restore.
 *
 * A no-op when stdout is not a tty, so piping `syncy` does not spray escape
 * sequences into the pipe.
 */
export function enterFullscreen(out: ScreenStream): () => void {
  if (out.isTTY !== true) return () => undefined;
  out.write(ENTER_ALT + HOME + HIDE_CURSOR);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    // Hand the title back before the screen, so the shell's own naming resumes
    // whichever exit path ran — including a signal or a crash.
    clearTitle(out as unknown as Parameters<typeof clearTitle>[0]);
    out.write(SHOW_CURSOR + LEAVE_ALT);
  };
}

export function startTui(config: Config): void {
  const out = process.stdout;
  const fullscreen = out.isTTY === true;
  const restore = enterFullscreen(out);

  if (fullscreen) {
    // A crash must not strand the terminal in the alternate buffer with a
    // hidden cursor, so every exit path restores it.
    process.once("exit", restore);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(sig, () => {
        restore();
        process.exit(sig === "SIGINT" ? 130 : 143);
      });
    }
  }

  // Named before the first frame, so a window that is still reading the source
  // is already identifiable in a tab strip.
  setTitle("syncy");

  debug("startTui", { fullscreen, columns: out.columns, rows: out.rows });

  const app = render(<App config={config} />, {
    // syncy handles ctrl-c itself so the alt screen is left cleanly.
    exitOnCtrlC: false,
  });

  app
    .waitUntilExit()
    .catch((e: unknown) => {
      debug("tui exited with an error", { error: String(e) });
    })
    .finally(restore);
}
