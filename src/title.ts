/**
 * The terminal window and tab title.
 *
 * A full-screen program owns the whole viewport, so the title bar is the only
 * place it can say what it is doing to someone looking at a window list. syncy
 * runs checks lasting tens of minutes; reading progress from the tab, without
 * switching to it, is most of the value.
 *
 * OSC 0 sets both the window title and the icon/tab name: `ESC ] 0 ; text BEL`.
 * Written straight to stdout, which is safe alongside Ink — the sequence moves
 * no cursor and occupies no cells, so it cannot disturb what is drawn.
 */

const ESC = "";
const BEL = "";
const ST = `${ESC}\\`;

/**
 * Inside tmux an escape sequence must be wrapped in a passthrough or tmux
 * consumes it; screen uses its own form. Outside either, it goes as-is.
 */
export function wrap(
  sequence: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const tmux = env["TMUX"];
  if (tmux !== undefined && tmux !== "") {
    // tmux passthrough: DCS tmux ; <sequence, with ESC doubled> ST
    return `${ESC}Ptmux;${sequence.split(ESC).join(ESC + ESC)}${ST}`;
  }
  if ((env["TERM"] ?? "").startsWith("screen")) return `${ESC}P${sequence}${ST}`;
  return sequence;
}

/**
 * Strips anything that would break out of the sequence or mangle a title bar.
 *
 * Folder names come from a directory listing, so they are not trusted input: a
 * name containing BEL or ESC would terminate the sequence early and leave the
 * rest to be interpreted by the terminal.
 */
export function sanitize(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, 120);
}

export interface TitleTarget {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

/**
 * Sets the title, if there is a terminal to set it on.
 *
 * A redirected stdout gets nothing: escape sequences written into a pipe or a
 * file would corrupt whatever reads it, and `syncy status` is documented as
 * working over a pipe.
 */
export function setTitle(text: string, out: TitleTarget = process.stdout): void {
  if (out.isTTY !== true) return;
  try {
    out.write(wrap(`${ESC}]0;${sanitize(text)}${BEL}`));
  } catch {
    // A terminal that refuses the write is not a reason to fail a check.
  }
}

/** Clears the title, so the shell's own naming resumes after syncy exits. */
export function clearTitle(out: TitleTarget = process.stdout): void {
  setTitle("", out);
}

/**
 * The title for a given moment: what is running, or what the archive is.
 *
 * Kept short and front-loaded. A tab strip truncates from the right, so the
 * part that distinguishes one window from another has to come first — which is
 * why the percentage leads while a check is running.
 */
export function titleFor(state: {
  readonly running?: { readonly mode: string; readonly unit: string; readonly percent?: number | null } | null;
  readonly folders?: number;
  readonly verified?: number;
}): string {
  const r = state.running;
  if (r != null) {
    const pct = r.percent == null ? "" : `${Math.round(r.percent * 100)}% `;
    return `${pct}${r.mode} ${r.unit} · syncy`;
  }
  if (state.folders !== undefined && state.verified !== undefined) {
    return `syncy · ${state.verified}/${state.folders} verified`;
  }
  return "syncy";
}
