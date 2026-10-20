import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toCsv } from "@orkestrator/protocol/tabular-export";
import { setHighlightBackend } from "@/lib/chat/highlighter/client";
import {
  restoreRichFindReveals,
  revealRichBlockForFind,
  searchRootText,
} from "@/lib/chat/rich-markdown/find-reveal";
import {
  setMermaidRenderer,
  setMermaidSvgSanitizer,
} from "@/lib/chat/rich-markdown/mermaid-render";
import { clearMarkdownSearchCache } from "@/lib/chat/rich-markdown/markdown-search";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { RichTranscriptScopeContext } from "@/lib/chat/rich-identity";
import { mockWriteText } from "../../../../../../tests/mocks/clipboard";
import { NativeMessage } from "../NativeMessage";
import { TextPart } from "../NativeMessage.file-parts";
import { getNativeMessageSearchText } from "../native-message-search";
import { findAgentChatTextMatches } from "../AgentChatFind";
import { csvDownloadText } from "./RichTable";

const MERMAID = [
  "```mermaid",
  "flowchart TD",
  "  A[Input] --> B{Valid?}",
  "  B -->|Yes| C[Render]",
  "```",
].join("\n");

/** The spec's rich Markdown fixture plus nested lists and a repeated diagram. */
const FIXTURE = [
  "## Review notes",
  "",
  "> [!NOTE]",
  "> The following is a synthetic rendering fixture.",
  "",
  "<details>",
  "<summary>Inspect the implementation notes</summary>",
  "",
  "Use `src/example.ts:12` to inspect the example.",
  "",
  '```ts title="Example" filename="src/example.ts"',
  "const label = `Count: ${items.length}`;",
  "console.log(label);",
  "```",
  "",
  "</details>",
  "",
  "- Outer item",
  "  - Nested item with [a link](https://example.com)",
  "    1. Deep ordered item",
  "",
  "| Check | Result | Notes |",
  "| :--- | ---: | :--- |",
  "| Unit tests | 44 | Synthetic fixture |",
  '| Browser tests | 8 | Quotes: "kept" |',
  "",
  MERMAID,
  "",
  MERMAID,
  "",
  "````md",
  "Inline ```fences``` stay inside.",
  "````",
].join("\n");

function message(content: string, id = "assistant-rich"): NativeMessageType {
  return {
    id,
    role: "assistant",
    content: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    parts: [{ type: "text", content }],
  };
}

/** What find indexes for a rendered row: each search root's searchable text. */
function renderedSearchText(container: HTMLElement): string {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-agent-chat-search-content]"))
    .map((root) => searchRootText(root))
    .join("\n\n");
}

beforeEach(() => {
  setHighlightBackend(null);
  setMermaidRenderer(() => new Promise(() => {}));
  setMermaidSvgSanitizer((markup) => ({ svg: markup }));
  richRenderScheduler.clear();
  clearMarkdownSearchCache();
  useRichContentViewStore.getState().reset();
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
  setMermaidRenderer(null);
  setMermaidSvgSanitizer(null);
});

describe.each([
  ["LF", FIXTURE],
  ["CRLF", FIXTURE.replace(/\n/g, "\r\n")],
])("rich Markdown fixture (%s)", (_label, content) => {
  test("renders every rich construct in the real transcript path", () => {
    const { container } = render(<NativeMessage message={message(content)} />);
    expect(screen.getByRole("note", { name: "Note" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inspect the implementation notes/ })).toBeTruthy();
    expect(container.querySelectorAll('[data-rich-block="table"]')).toHaveLength(1);
    const diagrams = container.querySelectorAll<HTMLElement>('[data-rich-block="mermaid"]');
    expect(diagrams).toHaveLength(2);
    // Repeated identical fences have distinct view identities.
    expect(diagrams[0]!.dataset.richBlockKey).not.toBe(diagrams[1]!.dataset.richBlockKey);
    expect(container.querySelectorAll("li")).toHaveLength(3);
    // Merely rendering never executes or downloads anything.
    expect(container.querySelector("script") === null).toBe(true);
  });

  test("find text equals the rendered search roots, including the collapsed disclosure body", () => {
    const msg = message(content);
    const { container } = render(<NativeMessage message={msg} />);
    const searchText = getNativeMessageSearchText(msg);
    expect(searchText).toBe(renderedSearchText(container));
    expect(findAgentChatTextMatches(searchText, "items.length")).toHaveLength(1);
    // Toolbar chrome (labels, titles) is not indexed.
    expect(searchText).not.toContain("Mermaid diagram");
  });

  test("find reveals the disclosure holding items.length and restores it afterwards", () => {
    const { container } = render(<NativeMessage message={message(content)} />);
    const mirror = Array.from(
      container.querySelectorAll<HTMLElement>("[data-rich-search-mirror]"),
    ).find((node) => node.textContent?.includes("items.length"));
    const key = mirror?.dataset.richRevealKey;
    expect(key).toBeTruthy();
    act(() => revealRichBlockForFind(key!, "find-test"));
    const toggle = screen.getByRole("button", { name: /Inspect the implementation notes/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const code = container.querySelector<HTMLElement>(
      '[data-rich-block="code"] [data-rich-code-body]',
    );
    expect(code?.textContent).toContain("items.length");
    // Parity holds while revealed too.
    expect(renderedSearchText(container)).toBe(getNativeMessageSearchText(message(content)));
    act(() => restoreRichFindReveals("find-test"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  test("a user toggle during a find reveal survives find closing", () => {
    const { container } = render(<NativeMessage message={message(content)} />);
    const key = container.querySelector<HTMLElement>('[data-rich-block="details"]')!.dataset
      .richBlockKey!;
    act(() => revealRichBlockForFind(key, "find-test"));
    const toggle = screen.getByRole("button", { name: /Inspect the implementation notes/ });
    fireEvent.click(toggle); // user closes it
    fireEvent.click(toggle); // and deliberately opens it again
    act(() => restoreRichFindReveals("find-test"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  test("Copy code copies the exact fence body and the file hint opens nothing", async () => {
    render(<NativeMessage message={message(content)} />);
    fireEvent.click(screen.getByRole("button", { name: /Inspect the implementation notes/ }));
    const block = screen.getByRole("group", { name: "Example code block" });
    fireEvent.click(within(block).getByRole("button", { name: "Copy code" }));
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    await waitFor(() =>
      expect(mockWriteText).toHaveBeenCalledWith(
        `const label = \`Count: \${items.length}\`;${eol}console.log(label);`,
      ),
    );
    // Without an environment there is no workspace-file action at all.
    expect(within(block).queryByRole("button", { name: /Open workspace file/ }) === null).toBe(
      true,
    );
  });
});

describe("find projection", () => {
  test("a duplicate phrase in prose, a hidden disclosure and diagram source is counted once per place", async () => {
    setMermaidRenderer(async ({ source }) => ({
      ok: true,
      svg: '<svg viewBox="0 0 10 10"><text>dup phrase</text></svg>',
      diagramType: "flowchart",
      rendererVersion: "t",
      svgBytes: source.length,
      svgElements: 2,
      edges: 0,
      renderDigest: "d",
    }));
    const content = [
      "The dup phrase in prose.",
      "",
      "<details>",
      "<summary>Hidden</summary>",
      "",
      "Inside: dup phrase.",
      "",
      "</details>",
      "",
      "```mermaid",
      "flowchart TD",
      "  A[dup phrase] --> B",
      "```",
    ].join("\n");
    const msg = message(content, "dup-message");
    const { container } = render(<NativeMessage message={msg} />);
    // Wait for the diagram preview, so its source is only in the hidden mirror.
    await waitFor(() =>
      expect(container.querySelector("[data-rich-search-exclude] svg")).toBeTruthy(),
    );
    const searchText = getNativeMessageSearchText(msg);
    expect(findAgentChatTextMatches(searchText, "dup phrase")).toHaveLength(3);
    expect(renderedSearchText(container)).toBe(searchText);
    // Two of the three are behind reveal actions.
    const mirrors = Array.from(
      container.querySelectorAll<HTMLElement>("[data-rich-search-mirror]"),
    );
    expect(
      mirrors.filter(
        (mirror) => mirror.textContent?.includes("dup phrase") && mirror.dataset.richRevealKey,
      ),
    ).toHaveLength(2);
  });

  test("user messages are indexed exactly as their rich render", () => {
    const msg: NativeMessageType = {
      id: "user-rich",
      role: "user",
      content: "",
      createdAt: "2026-10-20T10:00:00.000Z",
      parts: [
        { type: "text", content: "Please run:\n\n```bash\nbun test\n```\n\n> [!TIP]\n> Quick." },
      ],
    };
    const { container } = render(<NativeMessage message={msg} />);
    expect(getNativeMessageSearchText(msg)).toBe(renderedSearchText(container));
  });
});

describe("block identity", () => {
  test("identical message and part ids in two environments never share view state", () => {
    const scope = (environmentId: string) => ({
      backendId: "backend-1",
      environmentId,
      logicalSessionKey: "session",
      generation: "1",
    });
    const content = "<details>\n<summary>Same</summary>\n\nBody\n\n</details>";
    const { container } = render(
      <>
        <RichTranscriptScopeContext value={scope("env-a")}>
          <NativeMessage message={message(content, "same-id")} />
        </RichTranscriptScopeContext>
        <RichTranscriptScopeContext value={scope("env-b")}>
          <NativeMessage message={message(content, "same-id")} />
        </RichTranscriptScopeContext>
      </>,
    );
    const keys = Array.from(
      container.querySelectorAll<HTMLElement>('[data-rich-block="details"]'),
    ).map((node) => node.dataset.richBlockKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    const [first, second] = screen.getAllByRole("button", { name: /Same/ });
    fireEvent.click(first!);
    expect(first!.getAttribute("aria-expanded")).toBe("true");
    expect(second!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("streaming", () => {
  const STREAMED = [
    "Intro with a [link](https://example.com) and `code` 🎉 emoji.\r\n",
    "\r\n",
    "- list\r\n",
    "  - nested `x`\r\n",
    "\r\n",
    "````ts\r\n",
    'const fence = "```";\r\n',
    "````\r\n",
    "\r\n",
    "<details>\r\n<summary>S</summary>\r\n\r\nBody 😀\r\n\r\n</details>\r\n",
    "\r\n",
    MERMAID,
  ].join("");

  test("one character at a time, the final output equals a non-streamed render", async () => {
    const settled = (container: HTMLElement) =>
      waitFor(() =>
        expect(container.querySelector('[data-highlight-status="pending"]') === null).toBe(true),
      );
    const reference = render(<TextPart content={STREAMED} expansionKey="ref" />);
    await settled(reference.container);
    const expected = searchRootText(reference.container);
    // React's useId values differ between the two trees; nothing else may.
    const normalize = (html: string, key: string) =>
      html.replace(/_r_[a-z0-9]+_/g, "ID").replaceAll(`&quot;${key}&quot;`, "X");
    const expectedHtml = normalize(reference.container.querySelector(".prose")!.innerHTML, "ref");
    reference.unmount();

    const view = render(<TextPart content="" expansionKey="stream" />);
    // Walk code units so CRLF pairs and surrogate pairs are split mid-way.
    for (let index = 1; index <= STREAMED.length; index++) {
      view.rerender(<TextPart content={STREAMED.slice(0, index)} expansionKey="stream" />);
    }
    await waitFor(() => expect(searchRootText(view.container)).toBe(expected));
    await settled(view.container);
    expect(normalize(view.container.querySelector(".prose")!.innerHTML, "stream")).toBe(
      expectedHtml,
    );
  });
});

describe("fence routing", () => {
  test("mermaid, chart, malformed chart, json, html, svg and javascript each take their route", () => {
    const content = [
      MERMAID,
      "",
      "```chart",
      JSON.stringify({
        schemaVersion: 1,
        kind: "donut",
        title: "Share",
        description: "Split",
        valueLabel: "Count",
        slices: [{ id: "a", label: "Alpha", value: 2 }],
      }),
      "```",
      "",
      "```chart",
      '{"schemaVersion": 1, "kind": ',
      "```",
      "",
      "```json",
      '{"a": 1}',
      "```",
      "",
      "```html",
      '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      "```",
      "",
      "```svg",
      '<svg onload="alert(3)"><script>alert(4)</script></svg>',
      "```",
      "",
      "```js",
      "window.__executed = true;",
      "```",
    ].join("\n");
    const { container } = render(<TextPart content={content} expansionKey="routes" />);
    expect(container.querySelectorAll('[data-rich-block="mermaid"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-rich-block="chart"]').length).toBeGreaterThanOrEqual(
      2,
    );
    expect(screen.getByText("The chart specification is invalid")).toBeTruthy();
    const codes = Array.from(
      container.querySelectorAll<HTMLElement>('[data-rich-block="code"] [data-rich-code-body]'),
    );
    expect(codes.map((code) => code.textContent)).toEqual([
      '{"a": 1}',
      '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      '<svg onload="alert(3)"><script>alert(4)</script></svg>',
      "window.__executed = true;",
    ]);
    // Inert: no element was created from fence content and nothing ran.
    expect(container.querySelector("script") === null).toBe(true);
    expect(container.querySelector("img[onerror]") === null).toBe(true);
    expect((window as unknown as { __executed?: boolean }).__executed).toBeUndefined();
  });

  test("an inline chart's labels are findable through its mirror", () => {
    const content = [
      "```chart",
      JSON.stringify({
        schemaVersion: 1,
        kind: "donut",
        title: "Quarterly share",
        description: "Split by team",
        valueLabel: "Count",
        slices: [{ id: "a", label: "Alpha team", value: 2 }],
      }),
      "```",
    ].join("\n");
    const msg = message(content, "chart-message");
    const { container } = render(<NativeMessage message={msg} />);
    const searchText = getNativeMessageSearchText(msg);
    expect(searchText).toBe(renderedSearchText(container));
    expect(searchText).toContain("Alpha team");
  });
});

describe("tables", () => {
  const TABLE = [
    "| Name | Formula | Code |",
    "| --- | :---: | ---: |",
    "| pipe \\| inside | =SUM(A1:A2) | `a \\| b` |",
    '| quote "q" | -12 | `x` |',
  ].join("\n");

  test("copies exact Markdown and CSV and offers distinct exact and spreadsheet-safe downloads", async () => {
    render(<TextPart content={TABLE} expansionKey="table" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(TABLE));
    fireEvent.click(screen.getByRole("button", { name: "Copy as CSV" }));
    const header = ["Name", "Formula", "Code"];
    const rows = [
      ["pipe | inside", "=SUM(A1:A2)", "a | b"],
      ['quote "q"', "-12", "x"],
    ];
    await waitFor(() => expect(mockWriteText.mock.calls.length).toBe(2));
    expect(JSON.stringify((mockWriteText.mock.calls as unknown as string[][])[1]?.[0])).toBe(
      JSON.stringify(toCsv(header, rows)),
    );
    expect(
      csvDownloadText({ header, rows, align: [] }, "exact").startsWith(
        `${String.fromCharCode(0xfeff)}Name,Formula,Code`,
      ),
    ).toBe(true);
    const safe = csvDownloadText({ header, rows, align: [] }, "spreadsheet-safe");
    expect(safe).toContain("'=SUM(A1:A2)");
    expect(safe).toContain("'-12");
    expect(screen.getByRole("button", { name: "Download CSV (exact text)" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download CSV for spreadsheets (formulas neutralized)" }),
    ).toBeTruthy();
    // Rows keep their source order: nothing is sorted.
    const cells = Array.from(document.querySelectorAll("tbody tr td:first-child")).map(
      (cell) => cell.textContent,
    );
    expect(cells).toEqual(["pipe | inside", 'quote "q"']);
  });

  test("a 30-column table scrolls in its own region and an empty table renders", () => {
    const columns = Array.from({ length: 30 }, (_, index) => `C${index}`);
    const wide = [
      `| ${columns.join(" | ")} |`,
      `| ${columns.map(() => "---").join(" | ")} |`,
      `| ${columns.join(" | ")} |`,
    ].join("\n");
    const { container } = render(
      <TextPart content={`${wide}\n\n| Only |\n| --- |`} expansionKey="wide" />,
    );
    const regions = screen.getAllByRole("region", { name: /scroll horizontally/ });
    expect(regions).toHaveLength(2);
    expect(regions[0]!.className).toContain("overflow-x-auto");
    expect(container.querySelector('[data-rich-block="table"]')!.className).toContain("max-w-full");
    expect(screen.getByRole("group", { name: "Table with 30 columns and 1 rows" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Table with 1 columns and 0 rows" })).toBeTruthy();
  });

  test("a clipped table is labelled partial", () => {
    const rows = Array.from(
      { length: 2_000 },
      (_, index) => `| row ${index} | ${"x".repeat(10)} |`,
    );
    const content = ["| A | B |", "| --- | --- |", ...rows].join("\n");
    render(<TextPart content={content} expansionKey="partial" />);
    expect(screen.getByText(/Partial ·/)).toBeTruthy();
    expect(screen.getByText(/additional characters omitted/)).toBeTruthy();
  });
});

describe("callouts", () => {
  test("each kind has an icon, a text label and keeps its body; unknown markers stay quotes", () => {
    const content = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION", "UNKNOWN"]
      .map((kind) => `> [!${kind}]\n> ${kind.toLowerCase()} body`)
      .join("\n\n");
    const { container } = render(<TextPart content={content} expansionKey="callouts" />);
    for (const label of ["Note", "Tip", "Important", "Warning", "Caution"]) {
      const note = screen.getByRole("note", { name: label });
      expect(note.textContent).toContain(label);
      expect(note.querySelector("svg")).toBeTruthy();
    }
    expect(container.querySelector("blockquote")?.textContent).toContain("[!UNKNOWN]");
  });
});

describe("omission", () => {
  test("a clipped message offers its exact full source", async () => {
    const content = `${"word ".repeat(7_000)}tail-marker`;
    render(<TextPart content={content} expansionKey="clip" showCopy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy full source" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(content));
    const onError = mock(() => {});
    expect(onError).not.toHaveBeenCalled();
  });
});
