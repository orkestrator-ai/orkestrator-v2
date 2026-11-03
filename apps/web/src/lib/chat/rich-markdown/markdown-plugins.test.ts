import { describe, expect, test } from "bun:test";
import { markdownUrlTransform } from "./markdown-plugins";

const anchor: Parameters<typeof markdownUrlTransform>[2] = {
  type: "element",
  tagName: "a",
  properties: {},
  children: [],
};

describe("markdownUrlTransform", () => {
  test.each([
    ["java\tscript:alert(1)"],
    ["java\nscript:alert(1)"],
    ["\u0001javascript:alert(1)"],
    ["vb\rscript:msgbox(1)"],
    ["javascript:alert(1)"],
  ])("blanks an unsafe href hidden by a control character: %j", (href) => {
    expect(markdownUrlTransform(href, "href", anchor)).toBe("");
  });

  test.each([
    ["path/file.ts:12:4"],
    ["path/file.ts#L12C4"],
    ["file:///workspace/My%20File.ts:8:2"],
    ["C:\\workspace\\App.tsx:12"],
    ["C:/workspace/App.tsx"],
  ])("keeps a local file link unchanged: %s", (href) => {
    expect(markdownUrlTransform(href, "href", anchor)).toBe(href);
  });

  test("leaves ordinary web links to the default transform", () => {
    expect(markdownUrlTransform("https://example.com/a", "href", anchor)).toBe(
      "https://example.com/a",
    );
  });
});
