import { describe, expect, test } from "bun:test";
import {
  MAX_PROJECT_FOLDER_NAME_LENGTH,
  listProjectFolderNames,
  normalizeProjectFolderName,
  projectFolderKey,
  resolveProjectFolderName,
} from "./project-folders";

describe("normalizeProjectFolderName", () => {
  test("trims and collapses whitespace into a single line", () => {
    expect(normalizeProjectFolderName("  Work   Projects \n")).toBe("Work Projects");
  });

  test("strips control characters that arrive with pasted text", () => {
    expect(normalizeProjectFolderName("Work\u0007ing")).toBe("Work ing");
    expect(normalizeProjectFolderName("\u0000Work\u007f")).toBe("Work");
  });

  test("treats blank and non-string input as no folder", () => {
    expect(normalizeProjectFolderName("   ")).toBeNull();
    expect(normalizeProjectFolderName("")).toBeNull();
    expect(normalizeProjectFolderName(null)).toBeNull();
    expect(normalizeProjectFolderName(undefined)).toBeNull();
    expect(normalizeProjectFolderName(7)).toBeNull();
  });

  test("bounds the stored name and never leaves trailing space behind", () => {
    const long = `${"a".repeat(MAX_PROJECT_FOLDER_NAME_LENGTH - 1)} bbbb`;
    const normalized = normalizeProjectFolderName(long);
    expect(normalized).toBe("a".repeat(MAX_PROJECT_FOLDER_NAME_LENGTH - 1));
    expect(normalized!.length).toBeLessThanOrEqual(MAX_PROJECT_FOLDER_NAME_LENGTH);
  });
});

describe("projectFolderKey", () => {
  test("folds case so one folder cannot be spelled into two", () => {
    expect(projectFolderKey("Work")).toBe(projectFolderKey("wORK"));
    expect(projectFolderKey("Work")).not.toBe(projectFolderKey("Play"));
  });

  test("folds dotted I the same way on every host locale", () => {
    // `toLocaleLowerCase` folds "I" to a dotless "\u0131" under tr/az, which would
    // split one folder into two on those machines only. This is an identity
    // key, so the folding has to be locale-independent.
    expect(projectFolderKey("IT")).toBe(projectFolderKey("it"));
    expect(projectFolderKey("I")).toBe("i");
  });
});

describe("listProjectFolderNames", () => {
  test("lists each folder once, in order, spelled the way its first member spells it", () => {
    expect(
      listProjectFolderNames([
        { id: "a", folder: "Work" },
        { id: "b" },
        { id: "c", folder: "  " },
        { id: "d", folder: "WORK" },
        { id: "e", folder: "Play" },
      ]),
    ).toEqual(["Work", "Play"]);
  });
});

describe("resolveProjectFolderName", () => {
  const projects = [{ id: "a", folder: "Work" }];

  test("joins an existing folder regardless of how the name is typed", () => {
    expect(resolveProjectFolderName("  work ", projects)).toBe("Work");
  });

  test("keeps a genuinely new name as typed", () => {
    expect(resolveProjectFolderName("Play", projects)).toBe("Play");
  });

  test("reports blank input as no folder", () => {
    expect(resolveProjectFolderName("   ", projects)).toBeNull();
  });
});
