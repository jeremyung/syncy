import { describe, expect, test } from "bun:test";
import { clearTitle, sanitize, setTitle, titleFor, wrap } from "../src/title.ts";

/**
 * The terminal window and tab title.
 *
 * A full-screen program owns the viewport, so the title bar is the only place
 * it can report to someone looking at a window list. A deep verify runs for
 * tens of minutes, which is exactly when that matters.
 */

const ESC = "";
const BEL = "";

const sink = (): { written: string[]; isTTY: boolean; write: (c: string) => number } => {
  const written: string[] = [];
  return { written, isTTY: true, write: (c: string) => written.push(c) };
};

describe("setting the title", () => {
  test("it emits OSC 0, which names both the window and the tab", () => {
    const out = sink();
    setTitle("syncy", out);
    expect(out.written.join("")).toBe(`${ESC}]0;syncy${BEL}`);
  });

  test("a redirected stdout gets nothing", () => {
    // `syncy status` is documented as working over a pipe. Escape sequences
    // written into one would corrupt whatever reads it.
    const written: string[] = [];
    setTitle("syncy", { isTTY: false, write: (c: string) => written.push(c) });
    expect(written).toEqual([]);
  });

  test("clearing hands naming back to the shell", () => {
    const out = sink();
    clearTitle(out);
    expect(out.written.join("")).toBe(`${ESC}]0;${BEL}`);
  });
});

describe("a folder name cannot break out of the sequence", () => {
  /**
   * Names come from a directory listing, so they are untrusted input. One
   * containing BEL would end the sequence early and leave the remainder for the
   * terminal to interpret as commands.
   */
  test("an embedded escape is neutralised", () => {
    expect(sanitize(`photos${ESC}]0;pwned`)).not.toContain(ESC);
  });

  test("an embedded bell is neutralised", () => {
    expect(sanitize(`photos${BEL}rest`)).not.toContain(BEL);
  });

  test("the written sequence contains exactly one terminator", () => {
    const out = sink();
    setTitle(`photos${BEL}${ESC}]0;pwned`, out);
    const written = out.written.join("");
    expect(written.split(BEL)).toHaveLength(2);
    expect(written.indexOf(ESC)).toBe(written.lastIndexOf(ESC));
  });

  test("newlines and tabs collapse rather than wrapping a title bar", () => {
    expect(sanitize("a\n\nb\tc")).toBe("a b c");
  });

  test("a very long name is bounded", () => {
    expect(sanitize("x".repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe("multiplexers need the sequence wrapped", () => {
  test("tmux takes a passthrough with the escape doubled", () => {
    const w = wrap(`${ESC}]0;x`, { TMUX: "tmux-socket,1,0" } as NodeJS.ProcessEnv);
    expect(w).toContain("Ptmux;");
    expect(w).toContain(`${ESC}${ESC}]0;x`);
  });

  test("screen uses its own device-control wrapper", () => {
    expect(wrap(`${ESC}]0;x`, { TERM: "screen.xterm" } as NodeJS.ProcessEnv)).toStartWith(
      `${ESC}P`,
    );
  });

  test("a plain terminal gets it unchanged", () => {
    expect(wrap(`${ESC}]0;x`, { TERM: "xterm-256color" } as NodeJS.ProcessEnv)).toBe(
      `${ESC}]0;x`,
    );
  });
});

describe("what the title says", () => {
  test("a running check leads with what distinguishes the window", () => {
    // Tab strips truncate from the right, so the percentage and the folder have
    // to come before the program name.
    const t = titleFor({ running: { mode: "deep", unit: "photos-2019", percent: 0.5 } });
    expect(t).toStartWith("50% deep photos-2019");
    expect(t).toContain("syncy");
  });

  test("with no estimate it still names the folder", () => {
    expect(titleFor({ running: { mode: "quick", unit: "photos-2019", percent: null } })).toStartWith(
      "quick photos-2019",
    );
  });

  test("at rest it reports how much of the archive is proven", () => {
    expect(titleFor({ folders: 12, verified: 1 })).toBe("syncy · 1/12 verified");
  });

  test("knowing nothing, it is just the program's name", () => {
    expect(titleFor({})).toBe("syncy");
  });
});
