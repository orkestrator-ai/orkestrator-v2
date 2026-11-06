import { describe, expect, test } from "bun:test";
import {
  parseArguments as parseRecurrence,
  verdictLine,
} from "../../scripts/flaky-tests/recurrence-check";
import {
  caseMatcher,
  caseStatus,
  citedHashes,
  daysBetween,
  newestDate,
  owningFiles,
  parseIndexRows,
  resolutionText,
} from "../../scripts/flaky-tests/registry";
import { parseArguments as parseStale } from "../../scripts/flaky-tests/stale-report";

describe("flake registry parsing", () => {
  test("cites backticked hashes of any shape and bare ones only when they mix digits and letters", () => {
    const text = [
      "Fixed in `0123abc` and `1234567`; see 74d5e3cf6 on main.",
      "Duration 5000000 ms, run id f127c41c-116f, path /tmp/abcdef1234/x.",
      "Again `0123abc`, and a full 0014505caeed69395b3cc996dd541fcc6df12c23.",
    ].join("\n");
    expect(citedHashes(text)).toEqual([
      "0123abc",
      "1234567",
      "74d5e3cf6",
      // A UUID segment is a candidate too; callers drop it when Git cannot resolve it.
      "f127c41c",
      "0014505caeed69395b3cc996dd541fcc6df12c23",
    ]);
  });

  test("keeps only Resolution sections, at any heading level", () => {
    const text = [
      "# Case",
      "- **Status:** resolved",
      "Observed on `aaaaaaa1`.",
      "## Resolution (2026-10-01)",
      "Fix: `bbbbbbb2`.",
      "### Stress",
      "Passed 200 times.",
      "## Recurrence",
      "Seen on `ccccccc3`.",
      "### Resolution, second",
      "Fix: `ddddddd4`.",
    ].join("\n");
    const resolution = resolutionText(text);
    expect(citedHashes(resolution)).toEqual(["bbbbbbb2", "ddddddd4"]);
    expect(resolution).toContain("Passed 200 times.");
    expect(caseStatus(text)).toBe("resolved");
  });

  test("finds the newest real date that is not in the future", () => {
    const text = "Seen 2026-10-01, again 2026-10-17T03:00Z, bogus 2026-02-30, planned 2027-01-01.";
    expect(newestDate(text, "2026-11-06")).toBe("2026-10-17");
    expect(newestDate("no dates", "2026-11-06")).toBeUndefined();
    expect(daysBetween("2026-10-17", "2026-11-06")).toBe(20);
  });

  test("reads owning files from every File column shape", () => {
    expect(owningFiles("apps/web/src/a.test.tsx")).toEqual(["apps/web/src/a.test.tsx"]);
    expect(owningFiles("`tests/unit/x.test.ts:21`")).toEqual(["tests/unit/x.test.ts"]);
    expect(owningFiles("a/b.test.ts; c/d.test.ts, e/f.spec.ts and others")).toEqual([
      "a/b.test.ts",
      "c/d.test.ts",
      "e/f.spec.ts",
    ]);
    expect(owningFiles("a/b.test.ts<br>c/d.test.ts")).toEqual(["a/b.test.ts", "c/d.test.ts"]);
    expect(owningFiles("Workspace and browser suites; exact owners in case")).toEqual([]);
  });

  test("parses index rows and ignores the header and prose", () => {
    const index = [
      "# Flaky tests: Example",
      "",
      "| ID | Status | Test | File | Symptom | Case |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 0001 | open | `A > b` | tests/a.test.ts | Times out. | [0001-a.md](0001-a.md) |",
      "| 0002 | resolved | `C` | tests/c.test.ts:9 | Races. | [0002-c.md](0002-c.md) |",
    ].join("\n");
    expect(parseIndexRows("example", index)).toEqual([
      {
        group: "example",
        id: "0001",
        status: "open",
        test: "`A > b`",
        fileColumn: "tests/a.test.ts",
        caseFile: "0001-a.md",
      },
      {
        group: "example",
        id: "0002",
        status: "resolved",
        test: "`C`",
        fileColumn: "tests/c.test.ts:9",
        caseFile: "0002-c.md",
      },
    ]);
  });

  test("matches a case by number, padded number or file name", () => {
    expect(caseMatcher("210")("0210-fake.md")).toBe(true);
    expect(caseMatcher("0210")("0210-fake.md")).toBe(true);
    expect(caseMatcher("0210")("1210-fake.md")).toBe(false);
    expect(caseMatcher("0147-cursor-sdk.md")("0147-cursor-sdk.md")).toBe(true);
    expect(caseMatcher("0147-cursor-sdk")("0147-other.md")).toBe(false);
    expect(() => caseMatcher("fake")).toThrow(/Not a case id/);
  });
});

describe("registry tool arguments", () => {
  test("recurrence check defaults its base to HEAD and reads the working tree", () => {
    const options = parseRecurrence(["0210"]);
    expect(options.query).toBe("0210");
    expect(options.base).toBe("HEAD");
    expect(options.registryRef).toBeUndefined();
    expect(
      parseRecurrence(["--", "0210", "--base", "abc1234", "--registry-ref", "origin/main"]),
    ).toMatchObject({ query: "0210", base: "abc1234", registryRef: "origin/main" });
    expect(() => parseRecurrence([])).toThrow(/No case id/);
    expect(() => parseRecurrence(["0210", "--base"])).toThrow(/needs a value/);
    expect(() => parseRecurrence(["0210", "0211"])).toThrow(/Unexpected argument/);
  });

  test("stale report defaults to 21 days and today's UTC date", () => {
    const options = parseStale([], new Date("2026-11-06T23:30:00Z"));
    expect(options).toMatchObject({ days: 21, today: "2026-11-06" });
    expect(options.group).toBeUndefined();
    expect(parseStale(["--days", "7", "--group", "web-ui"])).toMatchObject({
      days: 7,
      group: "web-ui",
    });
    expect(() => parseStale(["--days", "soon"])).toThrow(/whole number/);
  });

  test("verdicts name the action a recorder takes", () => {
    expect(verdictLine({ kind: "real-recurrence", fixes: ["0123456789abcdef"] })).toMatch(
      /^resolved, and the base contains its fix \(0123456789\)\. This is a real recurrence: reopen/,
    );
    expect(verdictLine({ kind: "base-predates-fix", missing: ["0123456789abcdef"] })).toMatch(
      /^resolved, but the base predates fix 0123456789\. Not a recurrence/,
    );
    expect(verdictLine({ kind: "open" })).toMatch(/^open\. Record the failure as a recurrence/);
  });
});
