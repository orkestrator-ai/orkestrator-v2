import { describe, expect, test } from "bun:test";
import { MARKDOWN_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { classifyDisclosureLine } from "./disclosure-syntax";
import { parseFenceInfo, workspaceRelativeFileHint } from "./fence-info";
import { hastSearchText, markdownHast, type HastNode } from "./markdown-search";

function hast(source: string, clipped = false): HastNode {
  const tree = markdownHast(source, { rich: true, clipped });
  if (!tree) throw new Error("no tree");
  return tree;
}

function all(node: HastNode, tagName: string): HastNode[] {
  const found: HastNode[] = [];
  const walk = (current: HastNode) => {
    if (current.type === "element" && current.tagName === tagName) found.push(current);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return found;
}

function textOf(node: HastNode): string {
  return hastSearchText(node);
}

/** Depth of nested `rich-details` elements. */
function detailsDepth(node: HastNode): number {
  let max = 0;
  const walk = (current: HastNode, depth: number) => {
    const next =
      current.type === "element" && current.tagName === "rich-details" ? depth + 1 : depth;
    max = Math.max(max, next);
    for (const child of current.children ?? []) walk(child, next);
  };
  walk(node, 0);
  return max;
}

function nestedDetails(levels: number): string {
  let source = "innermost body";
  for (let level = levels; level >= 1; level--) {
    source = `<details>\n<summary>Level ${level}</summary>\n\n${source}\n\n</details>`;
  }
  return source;
}

describe("disclosure syntax", () => {
  test("classifies only the exact delimiter forms as structural", () => {
    expect(classifyDisclosureLine("<details>")).toEqual({ kind: "open" });
    expect(classifyDisclosureLine("<details>  ")).toEqual({ kind: "open" });
    expect(classifyDisclosureLine("</details>")).toEqual({ kind: "close" });
    expect(classifyDisclosureLine("<summary>A *b*</summary>")).toEqual({
      kind: "summary",
      summary: "A *b*",
    });
    for (const literal of [
      "<details open>",
      '<details class="x">',
      "<details onclick=alert(1)>",
      "<DETAILS>",
      "<details>text after",
      "<summary>unterminated",
      "<summary>a</summary></summary>",
      "<details/>",
    ]) {
      expect(classifyDisclosureLine(literal)).toEqual({ kind: "literal" });
    }
  });

  test("a well-formed disclosure becomes rich-details with its summary and body", () => {
    const tree = hast(
      "<details>\n<summary>More **info**</summary>\n\nHidden body.\n\n</details>\n\nAfter.",
    );
    const [details] = all(tree, "rich-details");
    expect(details?.properties?.summary).toBe("More **info**");
    expect(details?.properties?.blockId).toBe("details:0");
    expect(textOf(details!)).toContain("Hidden body.");
    expect(textOf(tree)).toContain("After.");
  });

  test("allows nesting to the policy depth and rejects one level more as literal text", () => {
    const depth = MARKDOWN_POLICY.maxDisclosureDepth;
    expect(detailsDepth(hast(nestedDetails(depth)))).toBe(depth);
    const tooDeep = hast(nestedDetails(depth + 1));
    expect(detailsDepth(tooDeep)).toBe(depth);
    // The over-depth level's delimiters stay visible as inert text.
    expect(textOf(tooDeep)).toContain(`<summary>Level ${depth + 1}</summary>`);
    expect(textOf(tooDeep)).toContain("innermost body");
  });

  test("delimiter-like lines inside fenced and indented code stay code", () => {
    const tree = hast(
      "```html\n<details>\n<summary>x</summary>\n</details>\n```\n\n    <details>\n    </details>\n",
    );
    expect(all(tree, "rich-details")).toHaveLength(0);
    const codes = all(tree, "rich-code");
    expect(codes[0]?.properties?.source).toBe("<details>\n<summary>x</summary>\n</details>");
    expect(codes[1]?.properties?.source).toBe("<details>\n</details>");
  });

  test("escaped tags are literal text, not delimiters", () => {
    const tree = hast("\\<details>\n\\<summary>x\\</summary>\n\nbody\n\n\\</details>");
    expect(all(tree, "rich-details")).toHaveLength(0);
    expect(textOf(tree)).toContain("<details>");
  });

  test("attributes, open and missing summaries are rejected without swallowing following content", () => {
    for (const source of [
      "<details open>\n<summary>S</summary>\n\nBody\n\n</details>\n\n# Next heading",
      '<details class="x">\n<summary>S</summary>\n\nBody\n\n</details>\n\n# Next heading',
      "<details>\n\nBody without summary\n\n</details>\n\n# Next heading",
    ]) {
      const tree = hast(source);
      expect(all(tree, "rich-details")).toHaveLength(0);
      expect(all(tree, "h1").map(textOf)).toEqual(["Next heading"]);
      expect(textOf(tree)).toContain("Body");
    }
  });

  test("a missing closer leaves literal delimiters and normal parsing afterwards", () => {
    const tree = hast(
      "<details>\n<summary>Open forever</summary>\n\n# Heading after\n\n- item one\n- item two",
    );
    expect(all(tree, "rich-details")).toHaveLength(0);
    expect(all(tree, "h1").map(textOf)).toEqual(["Heading after"]);
    expect(all(tree, "li")).toHaveLength(2);
    expect(textOf(tree)).toContain("<details>");
  });

  test("an extra summary inside the body is literal", () => {
    const tree = hast(
      "<details>\n<summary>One</summary>\n<summary>Two</summary>\n\nBody\n\n</details>",
    );
    const [details] = all(tree, "rich-details");
    expect(details?.properties?.summary).toBe("One");
    expect(textOf(details!)).toContain("<summary>Two</summary>");
  });

  test("CRLF line endings parse identically to LF", () => {
    const lf = "<details>\n<summary>S</summary>\n\nBody `code`\n\n</details>\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(all(hast(crlf), "rich-details")).toHaveLength(1);
    expect(textOf(hast(crlf))).toBe(textOf(hast(lf)));
  });

  test("reference definitions and footnotes resolve across the disclosure boundary", () => {
    const tree = hast(
      [
        "See [outside][ref] and a note[^n].",
        "",
        "<details>",
        "<summary>Inside</summary>",
        "",
        "Use [inside][ref] here.",
        "",
        "[ref]: https://example.com/doc",
        "",
        "</details>",
        "",
        "[^n]: Footnote text.",
      ].join("\n"),
    );
    const links = all(tree, "a").filter(
      (link) => link.properties?.href === "https://example.com/doc",
    );
    expect(links).toHaveLength(2);
    expect(textOf(tree)).toContain("Footnote text.");
  });

  test("only siblings pair: a closer at another container depth does not close", () => {
    const tree = hast("<details>\n<summary>S</summary>\n\n- item\n  </details>\n");
    expect(all(tree, "rich-details")).toHaveLength(0);
  });

  test("disclosures inside lists and quotes pair at their own depth", () => {
    const tree = hast("> <details>\n> <summary>Quoted</summary>\n>\n> Body\n>\n> </details>\n");
    expect(all(tree, "rich-details")).toHaveLength(1);
  });

  test("streaming the closer one character at a time only completes on the final character", () => {
    const prefix = "<details>\n<summary>S</summary>\n\nBody\n\n";
    const closer = "</details>";
    for (let length = 0; length < closer.length; length++) {
      const tree = hast(prefix + closer.slice(0, length));
      expect(all(tree, "rich-details")).toHaveLength(0);
      expect(textOf(tree)).toContain("Body");
    }
    expect(all(hast(prefix + closer), "rich-details")).toHaveLength(1);
  });
});

describe("callouts", () => {
  test.each(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"])(
    "[!%s] becomes a callout",
    (marker) => {
      const tree = hast(`> [!${marker}]\n> Body text.`);
      const [callout] = all(tree, "rich-callout");
      expect(callout?.properties?.calloutKind).toBe(marker.toLowerCase());
      expect(textOf(callout!)).not.toContain("[!");
      expect(textOf(callout!)).toContain("Body text.");
    },
  );

  test("unknown markers and markers with same-line text remain quotes", () => {
    expect(all(hast("> [!DANGER]\n> Body"), "rich-callout")).toHaveLength(0);
    expect(all(hast("> [!DANGER]\n> Body"), "blockquote")).toHaveLength(1);
    expect(all(hast("> [!NOTE] inline text"), "rich-callout")).toHaveLength(0);
  });

  test("works without remark-breaks and with a lowercase marker", () => {
    const tree = markdownHast("> [!note]\n> Body", { rich: true, enableBreaks: false })!;
    expect(all(tree, "rich-callout")).toHaveLength(1);
  });
});

describe("code fences", () => {
  test("records language, safe title/file hints, exact body and closed state", () => {
    const tree = hast('```ts title="Example" filename="src/example.ts"\nconst a = 1;\n```');
    const [code] = all(tree, "rich-code");
    expect(code?.properties).toMatchObject({
      source: "const a = 1;",
      language: "ts",
      title: "Example",
      fileHint: "src/example.ts",
      closed: true,
      fenced: true,
    });
  });

  test("an unclosed fence is incomplete, including a partial closing delimiter", () => {
    expect(all(hast("```js\nlet a"), "rich-code")[0]?.properties?.closed).toBe(false);
    expect(all(hast("```js\nlet a\n``"), "rich-code")[0]?.properties?.closed).toBe(false);
    expect(all(hast("```js\nlet a\n```"), "rich-code")[0]?.properties?.closed).toBe(true);
    expect(all(hast("~~~~\nx\n~~~"), "rich-code")[0]?.properties?.closed).toBe(false);
    expect(all(hast("~~~~\nx\n~~~~~"), "rich-code")[0]?.properties?.closed).toBe(true);
  });

  test("fences inside blockquotes detect their closer after the quote prefix", () => {
    expect(all(hast("> ```mermaid\n> graph TD\n> ```"), "rich-code")[0]?.properties?.closed).toBe(
      true,
    );
    expect(all(hast("> ```mermaid\n> graph TD"), "rich-code")[0]?.properties?.closed).toBe(false);
  });

  test("a fence at the omission boundary of a clipped render is never closed", () => {
    expect(all(hast("```mermaid\ngraph TD\n```", true), "rich-code")[0]?.properties?.closed).toBe(
      false,
    );
    expect(
      all(hast("```mermaid\ngraph TD\n```\n\nmore", true), "rich-code")[0]?.properties?.closed,
    ).toBe(true);
  });

  test("block ids come from position: identical fences differ and appends keep earlier ids", () => {
    const fence = "```mermaid\ngraph TD\n  A --> B\n```";
    const source = `${fence}\n\n${fence}`;
    const ids = all(hast(source), "rich-code").map((code) => code.properties?.blockId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    const appended = all(hast(`${source}\n\nMore text and \`\`\`ts\nx`), "rich-code").map(
      (code) => code.properties?.blockId,
    );
    expect(appended.slice(0, 2)).toEqual(ids);
  });

  test("preserves tabs, CRLF, angle brackets and emoji in the body", () => {
    const body = "\tif (a < b) {\r\n\t\treturn '🎉';\r\n\t}";
    const [code] = all(hast(`\`\`\`ts\r\n${body}\r\n\`\`\``), "rich-code");
    expect(code?.properties?.source).toBe(body);
  });
});

describe("fence info", () => {
  test("parses quoted and bare metadata, stripping control and bidi characters", () => {
    expect(parseFenceInfo("TS", 'title="A\u202eB" file=src/a.ts')).toEqual({
      language: "ts",
      title: "AB",
      fileHint: "src/a.ts",
    });
    expect(parseFenceInfo(null, null)).toEqual({ language: null, title: null, fileHint: null });
  });

  test("file hints never escape the workspace", () => {
    expect(workspaceRelativeFileHint("src/example.ts")).toBe("src/example.ts");
    expect(workspaceRelativeFileHint("src/example.ts:12")).toBe("src/example.ts");
    for (const unsafe of [
      "/etc/passwd",
      "../secret",
      "a/../../b",
      "~/x",
      "C:\\x",
      "https://x/y",
      "file:///x",
    ]) {
      expect(workspaceRelativeFileHint(unsafe)).toBeNull();
    }
  });
});
