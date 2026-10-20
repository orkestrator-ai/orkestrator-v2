import { describe, expect, test } from "bun:test";
import { inlineCodeFileReference, MAX_INLINE_FILE_REFERENCE_LENGTH } from "./inline-file-reference";

describe("inlineCodeFileReference", () => {
  test.each([
    ["src/app.ts:12", { filePath: "src/app.ts", lineNumber: 12 }],
    ["src/app.ts:12:4", { filePath: "src/app.ts", lineNumber: 12, columnNumber: 4 }],
    ["./README.md:3", { filePath: "./README.md", lineNumber: 3 }],
    ["C:\\repo\\a.ts:3", { filePath: "C:\\repo\\a.ts", lineNumber: 3 }],
    ["C:/repo/a.ts:3:9", { filePath: "C:/repo/a.ts", lineNumber: 3, columnNumber: 9 }],
    ["/abs/path/a%20b.ts:5", { filePath: "/abs/path/a b.ts", lineNumber: 5 }],
    ["src/a.ts#L10", { filePath: "src/a.ts", lineNumber: 10 }],
    ["src/a.ts#L10C2-L12", { filePath: "src/a.ts", lineNumber: 10, columnNumber: 2 }],
    ["file:///workspace/x.py:7", { filePath: "/workspace/x.py", lineNumber: 7 }],
    ["apps/web/.env:2", { filePath: "apps/web/.env", lineNumber: 2 }],
    ["docker/Dockerfile:14", { filePath: "docker/Dockerfile", lineNumber: 14 }],
  ])("links %s", (text, expected) => {
    expect(inlineCodeFileReference(text)).toEqual(expected);
  });

  test("same basename in different directories keeps distinct targets", () => {
    expect(inlineCodeFileReference("apps/web/index.ts:1")?.filePath).toBe("apps/web/index.ts");
    expect(inlineCodeFileReference("apps/backend/index.ts:1")?.filePath).toBe(
      "apps/backend/index.ts",
    );
  });

  test.each([
    // No line number: a mention, not a pointer.
    "src/app.ts",
    "README.md",
    // Plain words and identifiers.
    "useState",
    "foo:12",
    "obj.method:12",
    "std::vector:12",
    "12:30",
    // Bare names are ambiguous (host:port, identifiers) and lack a directory.
    "app.ts:12",
    "example.com:443",
    "localhost:3000",
    "127.0.0.1:8080",
    // URLs, with or without a scheme.
    "https://example.com/a.ts:12",
    "example.com/a.ts:12",
    "www.example.org/x.js:1",
    "mailto:a@b.c:1",
    "javascript:alert(1):1",
    // Not one token.
    "src/a b.ts:3",
    "see src/a.ts:3",
    "src/a.ts:3\n",
    // Not a file name.
    "src/v1.2:3",
    "src/dir/:3",
    "a/b:12",
    // Unparseable locations.
    "src/a.ts:0",
    "src/a.ts:12-20",
    "#L10",
    "",
  ])("leaves %p as plain code", (text) => {
    expect(inlineCodeFileReference(text)).toBe(null);
  });

  test("ignores spans beyond the length bound", () => {
    const long = `src/${"a".repeat(MAX_INLINE_FILE_REFERENCE_LENGTH)}.ts:1`;
    expect(inlineCodeFileReference(long)).toBe(null);
  });
});

test("repeated host labels and long failing suffixes complete within the input budget", () => {
  const started = performance.now();
  for (let count = 16; count <= 240; count += 16) {
    expect(inlineCodeFileReference("www.".repeat(count) + "x/a.ts:1")).not.toBeNull();
  }
  expect(performance.now() - started).toBeLessThan(250);
});
