import { describe, expect, test } from "bun:test";
import {
  linearFileReferences,
  linearFileUrl,
  unsignedLinearFileMarkdown,
  MAX_LINEAR_ISSUE_FILES,
} from "./linear-files.js";

const ZIP = "https://uploads.linear.app/ws/aaaa/bbbb";
const LOGO = "https://uploads.linear.app/ws/cccc/dddd";

describe("linearFileUrl", () => {
  test("is the link without its signature or fragment", () => {
    expect(linearFileUrl(`${ZIP}?signature=secret#x`)).toBe(ZIP);
  });

  test.each([
    "http://uploads.linear.app/a",
    "https://uploads.linear.app/",
    "https://uploads.linear.app:8443/a",
    "https://user:pass@uploads.linear.app/a",
    "https://uploads.linear.app.evil.test/a",
    "https://evil.test/https://uploads.linear.app/a",
    "https://linear.app/a",
    "not a url",
  ])("refuses %s", (value) => {
    expect(linearFileUrl(value)).toBeNull();
  });
});

describe("linearFileReferences", () => {
  test("finds links, images and bare addresses once each, in order", () => {
    const text = [
      `Bare first: ${ZIP}.`,
      `[package \\[v2\\].zip](${ZIP})`,
      `![logo.png](${LOGO}?signature=x "Logo")`,
      "https://example.com/other.zip",
    ].join("\n");
    expect(linearFileReferences(text)).toEqual([
      { url: ZIP, name: "package [v2].zip" },
      { url: LOGO, name: "logo.png" },
    ]);
  });

  test("reads an angle-bracketed target and ignores trailing punctuation", () => {
    expect(linearFileReferences(`[a.zip](<${ZIP}>) and **${LOGO}**`)).toEqual([
      { url: ZIP, name: "a.zip" },
      { url: LOGO },
    ]);
  });

  test("discovers complete Markdown destinations and strips their credentials", () => {
    const path = "https://uploads.linear.app/ws/spec(v2).zip";
    const port = path.replace("linear.app", "linear.app:443");
    const input = `[angle](<${port}?signature=secret#fragment>) [balanced](${path}?signature=secret)`;
    expect(linearFileReferences(input)).toEqual([{ url: path, name: "angle" }]);
    expect(unsignedLinearFileMarkdown(input)).toBe(`[angle](<${port}>) [balanced](${path})`);
  });

  test("collects beyond the batch limit, and stays fast on text full of brackets", () => {
    const many = Array.from({ length: MAX_LINEAR_ISSUE_FILES + 5 }, (_, i) => `${ZIP}${i}`);
    expect(linearFileReferences(many.join(" "))).toHaveLength(many.length);
    expect(linearFileReferences("[".repeat(100_000))).toEqual([]);
  });
});
