import { describe, expect, test } from "bun:test";
import { displayWidth, fit, padEnd, padStart, truncate } from "../src/width.ts";

/**
 * The ledger is nothing but aligned columns and every state glyph is multibyte.
 * This bug was hit twice while drafting the mocks (DESIGN.md section 6), so it
 * gets the most direct test in the suite.
 */
describe("displayWidth", () => {
  test("state glyphs are one column each despite being multibyte", () => {
    for (const glyph of ["✓", "~", "▲", "✗", "?", "!"]) {
      expect(displayWidth(glyph)).toBe(1);
    }
    // The trap: byte length disagrees with display width.
    expect(Buffer.byteLength("✓", "utf8")).toBe(3);
    expect(displayWidth("✓")).toBe(1);
  });

  test("box drawing and ledger punctuation are one column", () => {
    expect(displayWidth("─")).toBe(1);
    expect(displayWidth("·")).toBe(1);
    expect(displayWidth("»")).toBe(1);
    expect(displayWidth("━")).toBe(1);
  });

  test("CJK is two columns", () => {
    expect(displayWidth("写真")).toBe(4);
    expect(displayWidth("a写真b")).toBe(6);
  });

  test("emoji are two columns", () => {
    expect(displayWidth("📁")).toBe(2);
  });

  test("combining marks do not add width", () => {
    expect(displayWidth("é")).toBe(1);
  });

  test("plain ASCII matches .length", () => {
    expect(displayWidth("photos/2019")).toBe("photos/2019".length);
  });
});

describe("padding", () => {
  test("padEnd aligns glyph cells to the same column", () => {
    const rows = [padEnd("✓", 5), padEnd("▲143", 5), padEnd("?", 5)];
    for (const r of rows) expect(displayWidth(r)).toBe(5);
    // Naive .length padding would have produced differing widths here.
    expect(new Set(rows.map((r) => displayWidth(r))).size).toBe(1);
  });

  test("padStart right-aligns figures", () => {
    expect(padStart("412 gb", 10)).toBe("    412 gb");
    expect(displayWidth(padStart("1.2 tb", 10))).toBe(10);
  });

  test("padding never truncates an over-long string", () => {
    expect(padEnd("photos/2019", 4)).toBe("photos/2019");
  });
});

describe("truncate", () => {
  test("cuts to the display budget including the ellipsis", () => {
    const out = truncate("keep this reasonably long status text", 12);
    expect(displayWidth(out)).toBeLessThanOrEqual(12);
    expect(out.endsWith("…")).toBe(true);
  });

  test("leaves short strings untouched", () => {
    expect(truncate("verified", 20)).toBe("verified");
  });

  test("never splits a wide character across the boundary", () => {
    const out = truncate("写真写真写真", 5);
    expect(displayWidth(out)).toBeLessThanOrEqual(5);
  });
});

describe("fit", () => {
  test("produces exactly the requested width in both directions", () => {
    expect(displayWidth(fit("short", 20))).toBe(20);
    expect(displayWidth(fit("a very long status reason indeed", 20))).toBe(20);
    expect(displayWidth(fit("写真写真写真写真写真写真", 20))).toBe(20);
  });
});
