import { describe, expect, test } from "bun:test";
import { displayWidth, padEnd, truncatePath } from "../src/width.ts";

/**
 * Tests the Evidence screen's text formatting with multibyte characters and
 * long paths, asserting that rendered lines fit within terminal widths.
 */

describe("Evidence screen rendering", () => {
  test("destination names with multibyte characters are padded by display width", () => {
    // 写真 is a 2-character string with 4 display columns (2 per character)
    // padEnd should pad to 10 display columns total
    const name = "写真";
    const padded = padEnd(name, 10);
    expect(displayWidth(padded)).toBe(10);
  });

  test("long paths are truncated to fit within available width", () => {
    const longPath = "/very/long/path/that/would/overflow/a/narrow/terminal/archive/photos";
    const availableWidth = 58;
    const truncated = truncatePath(longPath, availableWidth);
    expect(displayWidth(truncated)).toBeLessThanOrEqual(availableWidth);
  });

  test("Evidence line formatting with multibyte names and long paths", () => {
    // Test that the formatted lines fit within the terminal width
    for (const width of [76, 92, 120]) {
      // Format name line: "  " + name padded to 10 columns + state padded to 12 columns
      const name = "写真";
      const nameLine = "  " + padEnd(name, 10) + padEnd("verified", 12);
      expect(displayWidth(nameLine), `name line at width ${width}`).toBeLessThanOrEqual(width);

      // Format path line: "      path        " + truncated path
      const longPath = "/very/long/path/that/would/overflow/a/narrow/terminal/archive/photos";
      const pathLine = "      path        " + truncatePath(longPath, width - 18);
      expect(displayWidth(pathLine), `path line at width ${width}`).toBeLessThanOrEqual(width);
    }
  });
});
