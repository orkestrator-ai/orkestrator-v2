import { describe, expect, test } from "bun:test";
import {
  mergeMarkdownIndex,
  type TextMerge,
} from "../../../scripts/merge-drivers/markdown-index-merge";

// Two branches that each add a to-do append a row after the same last row, so
// Git's line merge always conflicts there and someone recounted ranks by hand.

const HEADER = `# Area

Intro prose.

| Rank | File | Criticality | Status | Needs you | Covers | Why this rating |
| --- | --- | --- | --- | --- | --- | --- |`;

function row(rank: number, file: string, status = "backlog", covers = "Covers.") {
  return `| ${rank} | [${file}](${file}) | Low | ${status} | — | ${covers} | Why. |`;
}

function index(rows: string[], tail = "\nClosing prose.\n") {
  return `${HEADER}\n${rows.join("\n")}\n${tail}`;
}

/** A text merge that refuses anything the fast paths did not settle. */
const noTextMerge: TextMerge = () => null;

const base = index([row(1, "0001-a.md"), row(2, "0002-b.md")]);

describe("mergeMarkdownIndex", () => {
  test("keeps rows both sides appended and renumbers the ranks", () => {
    const ours = index([row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0003-ours.md")]);
    const theirs = index([row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0004-theirs.md")]);

    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBe(
      index([
        row(1, "0001-a.md"),
        row(2, "0002-b.md"),
        row(3, "0003-ours.md"),
        row(4, "0004-theirs.md"),
      ]),
    );
  });

  test("takes each side's change to a different row", () => {
    const ours = index([row(1, "0001-a.md", "blocked"), row(2, "0002-b.md")]);
    const theirs = index([row(1, "0001-a.md"), row(2, "0002-b.md", "blocked")]);

    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBe(
      index([row(1, "0001-a.md", "blocked"), row(2, "0002-b.md", "blocked")]),
    );
  });

  test("a row retired on one side goes, and ranks close up", () => {
    const ours = index([row(1, "0002-b.md")]);
    const theirs = index([row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0003-new.md")]);

    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBe(
      index([row(1, "0002-b.md"), row(2, "0003-new.md")]),
    );
  });

  test("a new row lands where its side put it, after its preceding row", () => {
    const ours = index([row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0009-ours.md")]);
    const theirs = index([row(1, "0001-a.md"), row(2, "0005-high.md"), row(3, "0002-b.md")]);

    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBe(
      index([
        row(1, "0001-a.md"),
        row(2, "0005-high.md"),
        row(3, "0002-b.md"),
        row(4, "0009-ours.md"),
      ]),
    );
  });

  test("follows the side that re-ranked the rows", () => {
    const ours = index([row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0003-ours.md")]);
    const theirs = index([row(1, "0002-b.md"), row(2, "0001-a.md")]);

    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBe(
      index([row(1, "0002-b.md"), row(2, "0001-a.md"), row(3, "0003-ours.md")]),
    );
  });

  test("refuses the same row changed differently on both sides", () => {
    const ours = index([row(1, "0001-a.md", "blocked"), row(2, "0002-b.md")]);
    const theirs = index([row(1, "0001-a.md", "backlog", "Other."), row(2, "0002-b.md")]);
    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBeNull();
  });

  test("refuses a row retired on one side and changed on the other", () => {
    const ours = index([row(1, "0002-b.md")]);
    const theirs = index([row(1, "0001-a.md", "blocked"), row(2, "0002-b.md")]);
    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBeNull();
  });

  test("refuses both sides re-ranking differently", () => {
    const three = index([row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0003-c.md")]);
    const ours = index([row(1, "0003-c.md"), row(2, "0001-a.md"), row(3, "0002-b.md")]);
    const theirs = index([row(1, "0002-b.md"), row(2, "0001-a.md"), row(3, "0003-c.md")]);
    expect(mergeMarkdownIndex(three, ours, theirs, noTextMerge)).toBeNull();
  });

  test("merges the prose around the table with the text merge", () => {
    const ours = index([row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0003-ours.md")]);
    const theirs = index([row(1, "0001-a.md"), row(2, "0002-b.md")], "\nNew closing prose.\n");
    const calls: string[][] = [];
    const textMerge: TextMerge = (b, o, t) => {
      calls.push([b, o, t]);
      return t;
    };

    expect(mergeMarkdownIndex(base, ours, theirs, textMerge)).toBe(
      index(
        [row(1, "0001-a.md"), row(2, "0002-b.md"), row(3, "0003-ours.md")],
        "\nNew closing prose.\n",
      ),
    );
    // Only the theirs side changed the prose, so no text merge was needed.
    expect(calls).toEqual([]);
  });

  test("a prose conflict falls back", () => {
    const ours = index([row(1, "0001-a.md"), row(2, "0002-b.md")], "\nOurs.\n");
    const theirs = index([row(1, "0001-a.md"), row(2, "0002-b.md")], "\nTheirs.\n");
    expect(mergeMarkdownIndex(base, ours, theirs, noTextMerge)).toBeNull();
  });

  test("keeps an ID table in ID order", () => {
    const head =
      "| ID | Status | Test | File | Symptom | Case |\n| --- | --- | --- | --- | --- | --- |";
    const flake = (id: string) =>
      `| ${id} | open | \`t\` | f.test.ts | timeout | [${id}-x.md](${id}-x.md) |`;
    const table = (ids: string[]) => `# Flakes\n\n${head}\n${ids.map(flake).join("\n")}\n`;

    expect(
      mergeMarkdownIndex(
        table(["0001"]),
        table(["0001", "10012"]),
        table(["0001", "10005"]),
        noTextMerge,
      ),
    ).toBe(table(["0001", "10005", "10012"]));
  });

  test("handles a top-level index keyed by folder links", () => {
    const head = "| Folder | Covers |\n| --- | --- |";
    const folder = (name: string) => `| [${name}](${name}/0000-index.md) | ${name}. |`;
    const top = (names: string[]) => `# Todo\n\n${head}\n${names.map(folder).join("\n")}\n`;

    expect(mergeMarkdownIndex(top(["a"]), top(["a", "b"]), top(["a", "c"]), noTextMerge)).toBe(
      top(["a", "b", "c"]),
    );
  });
});
