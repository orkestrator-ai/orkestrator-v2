import { describe, expect, test } from "bun:test";
import { getFileViewerKind, isMarkdownFile } from "./FileViewerTab";

describe("FileViewerTab routing", () => {
  test("routes Markdown extensions to the rich editor", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("docs/guide.MARKDOWN")).toBe(true);
    expect(getFileViewerKind("README.md", {
      showDiff: false,
      hasDiffData: false,
    })).toBe("markdown");
  });

  test("keeps non-Markdown text files in Monaco", () => {
    expect(isMarkdownFile("src/index.ts")).toBe(false);
    expect(isMarkdownFile("component.mdx")).toBe(false);
    expect(getFileViewerKind("src/index.ts", {
      showDiff: false,
      hasDiffData: false,
    })).toBe("text");
  });

  test("keeps Markdown files in the existing diff viewer when requested", () => {
    expect(getFileViewerKind("README.md", {
      showDiff: true,
      hasDiffData: true,
    })).toBe("diff");
  });
});
