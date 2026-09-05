import { describe, expect, test } from "bun:test";
import { parseLocalFileLinkTarget, parseLocalFilePathFromUrl } from "./file-url";

describe("parseLocalFilePathFromUrl", () => {
  test("decodes local, Windows, and UNC file URLs", () => {
    expect(parseLocalFilePathFromUrl("file:///workspace/My%20File.ts")).toBe(
      "/workspace/My File.ts",
    );
    expect(parseLocalFilePathFromUrl("file:///C:/workspace/App.tsx")).toBe("C:/workspace/App.tsx");
    expect(parseLocalFilePathFromUrl("file://server/share/App.tsx")).toBe("//server/share/App.tsx");
  });
});

describe("parseLocalFileLinkTarget", () => {
  test.each([
    ["src/App.tsx", { filePath: "src/App.tsx" }],
    ["README.md:10", { filePath: "README.md", lineNumber: 10 }],
    ["package.json:5:2", { filePath: "package.json", lineNumber: 5, columnNumber: 2 }],
    ["/workspace/src/App.tsx:10", { filePath: "/workspace/src/App.tsx", lineNumber: 10 }],
    [
      "/workspace/src/App.tsx:10:4",
      { filePath: "/workspace/src/App.tsx", lineNumber: 10, columnNumber: 4 },
    ],
    [
      "C:/workspace/src/App.tsx:12:7",
      { filePath: "C:/workspace/src/App.tsx", lineNumber: 12, columnNumber: 7 },
    ],
    [
      "file:///workspace/My%20File.ts:8:2",
      { filePath: "/workspace/My File.ts", lineNumber: 8, columnNumber: 2 },
    ],
    ["src/App.tsx#L21C6", { filePath: "src/App.tsx", lineNumber: 21, columnNumber: 6 }],
    ["src/App.tsx#L21-L30", { filePath: "src/App.tsx", lineNumber: 21 }],
    ["src/App.tsx:10#L20", { filePath: "src/App.tsx", lineNumber: 20 }],
    [
      "file:///workspace/src/App.tsx:8:2#L9C3",
      { filePath: "/workspace/src/App.tsx", lineNumber: 9, columnNumber: 3 },
    ],
  ])("parses %s", (destination, expected) => {
    expect(parseLocalFileLinkTarget(destination)).toEqual(expected);
  });

  test("keeps browser URLs and document anchors out of the file viewer", () => {
    expect(parseLocalFileLinkTarget("https://example.com/file.ts:10")).toBeNull();
    expect(parseLocalFileLinkTarget("https://example.com/file.ts:10#L20")).toBeNull();
    expect(parseLocalFileLinkTarget("javascript:10")).toBeNull();
    expect(parseLocalFileLinkTarget("#L10")).toBeNull();
  });

  test("does not accept zero or unsafe location suffixes", () => {
    expect(parseLocalFileLinkTarget("src/App.tsx:0")).toEqual({ filePath: "src/App.tsx:0" });
    expect(parseLocalFileLinkTarget("src/App.tsx:99999999999999999999")).toEqual({
      filePath: "src/App.tsx:99999999999999999999",
    });
  });
});
