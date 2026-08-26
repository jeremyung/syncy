import { existsSync } from "node:fs";
import { IS_MACOS } from "./platform.ts";

/**
 * Putting the plan on the clipboard.
 *
 * macOS has pbcopy in /usr/bin. Linux has no standard clipboard binary: the
 * Wayland world uses wl-clipboard and the X11 world uses xclip or xsel, so the
 * first one that is installed is used. Every path is absolute and pinned, like
 * every other binary syncy runs.
 *
 * Copying is a convenience, and its absence is reported rather than thrown: a
 * machine without a clipboard tool must still be able to read the plan.
 */
export async function copyToClipboard(text: string): Promise<string> {
  const candidates: readonly (readonly string[])[] = IS_MACOS
    ? [["/usr/bin/pbcopy"]]
    : [
        ["/usr/bin/wl-copy"],
        ["/usr/bin/xclip", "-selection", "clipboard"],
        ["/bin/xclip", "-selection", "clipboard"],
        ["/usr/bin/xsel", "-ib"],
        ["/bin/xsel", "-ib"],
      ];

  for (const argv of candidates) {
    const bin = argv[0];
    if (bin === undefined || !existsSync(bin)) continue;
    try {
      const proc = Bun.spawn(argv as string[], {
        stdin: new TextEncoder().encode(text),
        stdout: "ignore",
        stderr: "pipe",
      });
      const code = await proc.exited;
      if (code === 0) return "plan copied to the clipboard";
    } catch {
      // The tool exists but failed (no display, no clipboard): try the next.
    }
  }
  return IS_MACOS
    ? "could not reach pbcopy"
    : "no clipboard tool found — install wl-clipboard or xclip";
}
