import { describe, expect, test } from "bun:test";
import { ConfigError, isWithin, parseConfig } from "../src/config.ts";

const VALID = `
source = "/Users/you/Pictures/Archive"
exclude = [".DS_Store", "._*"]

[status]
max_verify_age_days = 30
max_quick_age_days  = 7
min_targets         = 2

[[target]]
name     = "ext"
path     = "/Volumes/Archive/photos"
required = true
sentinel = "3f2a91c4"
fstype   = "apfs"

[[target]]
name       = "nas"
path       = "/Volumes/media/archive"
required   = true
sentinel   = "9c41e0b2"
fstype     = "smbfs"
flags_drop = ["-X"]
`;

describe("parseConfig", () => {
  test("accepts a well-formed config", () => {
    const c = parseConfig(VALID);
    expect(c.source).toBe("/Users/you/Pictures/Archive");
    expect(c.targets).toHaveLength(2);
    expect(c.targets[1]!.flagsDrop).toEqual(["-X"]);
    expect(c.maxQuickAgeDays).toBe(7);
  });

  test("accepts a config with no targets yet, which is where setup begins", () => {
    // Safe because min_targets is floored at 1, so evaluateUnit can never
    // report `verified` with nothing to verify against — asserted in
    // status.test.ts rather than relied on implicitly.
    const c = parseConfig(`source = "/a"\n`);
    expect(c.targets).toEqual([]);
    expect(c.minTargets).toBeGreaterThanOrEqual(1);
  });

  test("accepts a partially configured setup, so targets can be added one at a time", () => {
    // min_targets is a status policy applied by evaluateUnit, not a reason to
    // refuse to load the file. Enforcing it here would make the setup screen
    // unable to save after adding the first of two targets.
    const c = parseConfig(`
source = "/a"
[status]
min_targets = 2
[[target]]
name = "ext"
path = "/b"
sentinel = "s"
`);
    expect(c.targets).toHaveLength(1);
    expect(c.minTargets).toBe(2);
  });

  test("applies defaults for the optional status block", () => {
    const c = parseConfig(`
source = "/a"
[[target]]
name = "x"
path = "/b"
sentinel = "s1"
[[target]]
name = "y"
path = "/c"
sentinel = "s2"
`);
    expect(c.maxVerifyAgeDays).toBe(30);
    expect(c.maxQuickAgeDays).toBe(7);
    // 1, not 2: a single-destination setup must be able to reach `verified`.
    // Every required target still has to pass — see targets.test.tsx.
    expect(c.minTargets).toBe(1);
  });
});

describe("validation rejects what would lose data", () => {
  const expectError = (toml: string, fragment: string): void => {
    let caught: unknown;
    try {
      parseConfig(toml);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain(fragment);
  };

  test("a target nested inside the source root", () => {
    expectError(
      `
source = "/Users/you/Pictures/Archive"
[[target]]
name = "bad"
path = "/Users/you/Pictures/Archive/backup"
sentinel = "s"
`,
      "inside the source root",
    );
  });

  test("a source root nested inside a target", () => {
    expectError(
      `
source = "/Volumes/Archive/photos/live"
[[target]]
name = "bad"
path = "/Volumes/Archive/photos"
sentinel = "s"
`,
      "source root is inside this target",
    );
  });

  test("relative paths", () => {
    expectError(
      `source = "Pictures/Masters"\n[[target]]\nname="a"\npath="/b"\nsentinel="s"\n`,
      "absolute path",
    );
  });

  test("duplicate target names", () => {
    expectError(
      `
source = "/a"
[[target]]
name = "nas"
path = "/b"
sentinel = "s1"
[[target]]
name = "nas"
path = "/c"
sentinel = "s2"
`,
      "duplicate target name",
    );
  });

  test("duplicate target paths", () => {
    expectError(
      `
source = "/a"
[[target]]
name = "one"
path = "/b"
sentinel = "s1"
[[target]]
name = "two"
path = "/b"
sentinel = "s2"
`,
      "duplicate target path",
    );
  });

  test("a cheap clock looser than the expensive one", () => {
    expectError(
      `
source = "/a"
[status]
max_verify_age_days = 7
max_quick_age_days = 30
[[target]]
name = "x"
path = "/b"
sentinel = "s"
`,
      "must not exceed max_verify_age_days",
    );
  });

  test("wrong types are named precisely", () => {
    expectError(`source = 42\n`, "source: expected a string, got number");
  });

  test("malformed TOML", () => {
    expectError(`source = "unterminated\n`, "not valid TOML");
  });
});

describe("isWithin", () => {
  test("identity counts as within", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
  });
  test("true descendants", () => {
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
  });
  test("sibling prefixes are not descendants", () => {
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
  });
  test("unrelated paths", () => {
    expect(isWithin("/x/y", "/a/b")).toBe(false);
  });
});
