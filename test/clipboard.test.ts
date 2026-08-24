import { describe, expect, test } from "bun:test";
import { copyToClipboard } from "../src/clipboard.ts";

/**
 * Copying is a convenience with a platform-dependent toolchain behind it, so
 * the contract under test is the shape of the answer: a status string is
 * always returned, and the absence of a clipboard tool is reported rather
 * than thrown. On a machine with pbcopy or wl-clipboard the copy succeeds;
 * on a headless one it does not. Both must keep the program running.
 */
describe("clipboard", () => {
  test("always answers with a status, never throws", async () => {
    const message = await copyToClipboard("a plan that fits in a terminal\n");
    expect(typeof message).toBe("string");
    expect(message.length).toBeGreaterThan(0);
  });

  test("a short plan is not refused by the transport", async () => {
    const message = await copyToClipboard("");
    expect(typeof message).toBe("string");
  });
});
