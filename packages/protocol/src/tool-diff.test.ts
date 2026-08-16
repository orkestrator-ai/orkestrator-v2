import { describe, expect, test } from "bun:test";
import {
  countTextLines,
  filePathFromToolInput,
  lineChangeStatsFromSides,
  splitTextLines,
  toolDiffFromToolInput,
} from "./tool-diff";

describe("tool diff line stats", () => {
  test("counts logical lines without treating a trailing newline as another line", () => {
    expect(countTextLines(undefined)).toBe(0);
    expect(countTextLines("")).toBe(0);
    expect(countTextLines("one")).toBe(1);
    expect(countTextLines("one\ntwo")).toBe(2);
    expect(countTextLines("one\ntwo\n")).toBe(2);
    expect(countTextLines("\n\n")).toBe(2);
  });

  test("splits the same logical lines the counter would count", () => {
    expect(splitTextLines(undefined)).toEqual([]);
    expect(splitTextLines("")).toEqual([]);
    expect(splitTextLines("one")).toEqual(["one"]);
    expect(splitTextLines("one\ntwo")).toEqual(["one", "two"]);
    expect(splitTextLines("one\ntwo\n")).toEqual(["one", "two"]);
    expect(splitTextLines("\n")).toEqual([""]);
    expect(splitTextLines("\n\n")).toEqual(["", ""]);
    expect(splitTextLines("one\nfour\n")).toEqual(["one", "four"]);
    for (const value of [undefined, "", "one", "one\ntwo", "one\ntwo\n", "\n", "\n\n", "one\r\ntwo\r\n"]) {
      expect(splitTextLines(value)).toHaveLength(countTextLines(value));
    }
  });

  test("counts a CRLF payload by its line terminators, not its carriage returns", () => {
    expect(countTextLines("one\r\ntwo\r\n")).toBe(2);
    expect(countTextLines("one\r\ntwo")).toBe(2);
  });

  test("derives compact additions and deletions only when a side is known", () => {
    expect(lineChangeStatsFromSides(undefined, undefined)).toBeUndefined();
    expect(lineChangeStatsFromSides("old\nlines", "new\nlines\nhere")).toEqual({
      additions: 3,
      deletions: 2,
    });
    expect(lineChangeStatsFromSides("", "created\nfile\n")).toEqual({
      additions: 2,
      deletions: 0,
    });
  });
});

describe("filePathFromToolInput", () => {
  test("prefers the most specific key and skips non-strings", () => {
    expect(filePathFromToolInput({ file_path: "a.ts", path: "b.ts" })).toBe("a.ts");
    expect(filePathFromToolInput({ filePath: "a.ts", notebook_path: "n.ipynb" })).toBe("a.ts");
    expect(filePathFromToolInput({ notebook_path: "n.ipynb", path: "b.ts" })).toBe("n.ipynb");
    expect(filePathFromToolInput({ path: "b.ts" })).toBe("b.ts");
    expect(filePathFromToolInput({ file_path: 42, path: "b.ts" })).toBe("b.ts");
  });

  test("treats a blank path as no path at all", () => {
    // Returning "" would render a nameless file row rather than falling through
    // to the caller's "no location" branch.
    expect(filePathFromToolInput({ file_path: "" })).toBeUndefined();
    expect(filePathFromToolInput({ file_path: "", path: "b.ts" })).toBe("b.ts");
    expect(filePathFromToolInput({})).toBeUndefined();
  });
});

describe("toolDiffFromToolInput", () => {
  test("ignores tools that carry no edit payload", () => {
    expect(toolDiffFromToolInput(undefined, { file_path: "a.ts" })).toBeUndefined();
    expect(toolDiffFromToolInput("Bash", { command: "ls" })).toBeUndefined();
    // A path alone is not an edit; the caller decides what to do with it.
    expect(toolDiffFromToolInput("Read", { file_path: "a.ts" })).toBeUndefined();
  });

  test("maps every edit-shaped tool name and both field casings", () => {
    for (const name of ["Edit", "file_edit", "STR_REPLACE_EDITOR", "replace"]) {
      expect(toolDiffFromToolInput(name, {
        file_path: "a.ts",
        old_string: "one\ntwo",
        new_string: "three",
      })).toEqual({
        filePath: "a.ts",
        before: "one\ntwo",
        after: "three",
        additions: 1,
        deletions: 2,
      });
    }

    expect(toolDiffFromToolInput("edit", {
      filePath: "a.ts",
      oldString: "one",
      newString: "two\nthree",
    })).toEqual({
      filePath: "a.ts",
      before: "one",
      after: "two\nthree",
      additions: 2,
      deletions: 1,
    });
  });

  test("treats an edit with no replacement pair as having no counts", () => {
    expect(toolDiffFromToolInput("edit", { file_path: "a.ts" })).toEqual({
      filePath: "a.ts",
      before: undefined,
      after: undefined,
    });
  });

  test("maps write-shaped tools against an empty prior state", () => {
    for (const name of ["Write", "create_file"]) {
      expect(toolDiffFromToolInput(name, {
        file_path: "a.ts",
        content: "one\ntwo\n",
      })).toEqual({
        filePath: "a.ts",
        before: "",
        after: "one\ntwo\n",
        additions: 2,
        deletions: 0,
      });
    }
  });

  test("reports a write with non-string content as writing nothing", () => {
    expect(toolDiffFromToolInput("write", { file_path: "a.ts", content: 42 })).toEqual({
      filePath: "a.ts",
      before: "",
      after: undefined,
      additions: 0,
      deletions: 0,
    });
  });

  test("does not charge multiedit for the separators it never wrote", () => {
    /*
     * A chunk that already ends in a newline supplies its own separator. Joining
     * unconditionally would put a blank line after "four\n" — a line the file
     * never had — and count it, so the badge would read -3 for two deletions.
     */
    expect(toolDiffFromToolInput("MultiEdit", {
      file_path: "c.ts",
      edits: [
        { old_string: "four\n", new_string: "x\n" },
        { old_string: "one", new_string: "y" },
      ],
    })).toEqual({
      filePath: "c.ts",
      before: "four\none",
      after: "x\ny",
      additions: 2,
      deletions: 2,
    });
  });

  test("counts each multiedit chunk on its own so multi-line chunks still add up", () => {
    expect(toolDiffFromToolInput("multiedit", {
      file_path: "c.ts",
      edits: [
        { old_string: "one", new_string: "two\nthree" },
        { old_string: "four\n", new_string: "five" },
      ],
    })).toEqual({
      filePath: "c.ts",
      before: "one\nfour\n",
      after: "two\nthree\nfive",
      additions: 3,
      deletions: 2,
    });
  });

  test("skips malformed multiedit entries and survives an absent edits array", () => {
    expect(toolDiffFromToolInput("multiedit", {
      file_path: "c.ts",
      edits: [
        null,
        ["old", "new"],
        "not an edit",
        { old_string: 42, new_string: "kept" },
        { oldString: "camel", newString: "case" },
      ],
    })).toEqual({
      filePath: "c.ts",
      before: "camel",
      after: "kept\ncase",
      additions: 2,
      deletions: 1,
    });

    expect(toolDiffFromToolInput("multiedit", { file_path: "c.ts" })).toEqual({
      filePath: "c.ts",
      before: "",
      after: "",
      additions: 0,
      deletions: 0,
    });
  });

  test("maps a notebook edit and omits counts when there is no new source", () => {
    expect(toolDiffFromToolInput("NotebookEdit", {
      notebook_path: "n.ipynb",
      new_source: "a\nb\n",
    })).toEqual({
      filePath: "n.ipynb",
      after: "a\nb\n",
      additions: 2,
      deletions: 0,
    });

    // Delete-mode removes a cell and carries no source. Reporting zero
    // additions there would state a count nothing measured.
    expect(toolDiffFromToolInput("NotebookEdit", {
      notebook_path: "n.ipynb",
      edit_mode: "delete",
    })).toEqual({
      filePath: "n.ipynb",
      after: undefined,
    });
  });
});
