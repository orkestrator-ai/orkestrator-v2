import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { CODE_BLOCK_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { markdownFenceFor } from "@orkestrator/protocol/tabular-export";
import { TerminalProvider, useTerminalContext } from "@/contexts/TerminalContext";
import {
  setHighlightBackend,
  type HighlightBackend,
  type HighlightInput,
} from "@/lib/chat/highlighter/client";
import { searchRootText } from "@/lib/chat/rich-markdown/find-reveal";
import { richRenderScheduler } from "@/lib/chat/rich-render-cache";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { mockWriteText } from "../../../../../../tests/mocks/clipboard";
import {
  CodeBlock,
  INLINE_CODE_LINE_LIMIT,
  logicalLineCount,
  withinHighlightLimits,
} from "./CodeBlock";

/** Tokenizes each line as one coloured token; records every request. */
function fakeBackend(): HighlightBackend & { calls: HighlightInput[] } {
  const calls: HighlightInput[] = [];
  return {
    calls,
    async highlight(input) {
      calls.push(input);
      return {
        lines: input.code.split("\n").map((line) => (line ? [{ c: line, s: "#ff0000" }] : [])),
        stateId: `state-${calls.length}`,
      };
    },
  };
}

function RegisterCreateTab({ createTab }: { createTab: (...args: unknown[]) => boolean }) {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    setCreateTab(createTab as never);
    return () => setCreateTab(null);
  }, [createTab, setCreateTab]);
  return null;
}

function withTerminal(children: ReactNode, createTab: (...args: unknown[]) => boolean) {
  return (
    <TerminalProvider>
      <RegisterCreateTab createTab={createTab} />
      {children}
    </TerminalProvider>
  );
}

let backend: ReturnType<typeof fakeBackend>;

beforeEach(() => {
  backend = fakeBackend();
  setHighlightBackend(backend);
  richRenderScheduler.clear();
  useRichContentViewStore.getState().reset();
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => {});
});

afterEach(() => {
  cleanup();
  setHighlightBackend(undefined);
});

function body(container: HTMLElement): HTMLElement {
  return container.querySelector("[data-rich-code-body]") as HTMLElement;
}

describe("CodeBlock", () => {
  test("shows exact source immediately and then highlighted tokens with the same text", async () => {
    const source = "const a = 1;\nconst b = 2;";
    const { container } = render(<CodeBlock source={source} language="ts" closed blockKey="k1" />);
    expect(body(container).textContent).toBe(source);
    await waitFor(() =>
      expect(body(container).getAttribute("data-highlight-status")).toBe("ready"),
    );
    expect(body(container).textContent).toBe(source);
    expect(container.querySelector('[style*="color"]')).toBeTruthy();
    expect(backend.calls[0]).toMatchObject({ lang: "typescript", code: source });
  });

  test("search text excludes toolbar chrome and equals the displayed code", () => {
    const source = "a\tb\n<tag>\n";
    const { container } = render(
      <CodeBlock source={source} language="ts" title="Example" closed blockKey="k2" />,
    );
    expect(searchRootText(container)).toBe(source);
  });

  test("copies the exact body: tabs, angle brackets, emoji and trailing newline", async () => {
    const source = "\tif (a < b && c > d) {\r\n\t\treturn '🎉';\r\n\t}\n";
    render(<CodeBlock source={source} language="ts" closed blockKey="k3" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(source));
  });

  test("Copy as Markdown uses a fence longer than any backtick run in the body", async () => {
    const source = "const label = `Count: ${n}`;\n```nested```\n";
    render(<CodeBlock source={source} language="ts" title="Example" closed blockKey="k4" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalled());
    const copied = (mockWriteText.mock.calls[0] as unknown as [string])[0];
    const fence = markdownFenceFor(source);
    expect(fence.length).toBe(4);
    expect(copied).toBe(`${fence}ts title="Example"\n${source}${fence}`);
  });

  test("highlights exactly at the byte and line limits and not above them", () => {
    const atLines = Array.from({ length: CODE_BLOCK_POLICY.maxHighlightLines }, () => "x").join(
      "\n",
    );
    const aboveLines = `${atLines}\nx`;
    expect(logicalLineCount(atLines)).toBe(CODE_BLOCK_POLICY.maxHighlightLines);
    expect(withinHighlightLimits(atLines)).toBe(true);
    expect(withinHighlightLimits(aboveLines)).toBe(false);
    const atBytes = "é".repeat(CODE_BLOCK_POLICY.maxHighlightBytes / 2);
    expect(withinHighlightLimits(atBytes)).toBe(true);
    expect(withinHighlightLimits(`${atBytes}a`)).toBe(false);
  });

  test("an oversized fence stays plain, is never queued, and offers the viewer", async () => {
    const source = "y".repeat(CODE_BLOCK_POLICY.maxHighlightBytes + 1);
    const { container } = render(<CodeBlock source={source} language="ts" closed blockKey="k5" />);
    expect(body(container).getAttribute("data-highlight-status")).toBe("plain");
    expect(screen.getByText(/Plain text/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(backend.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open in viewer" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("an unknown language and a missing backend both keep copyable plain text", async () => {
    const { container } = render(
      <CodeBlock source="plain" language="brainfuck" closed blockKey="k6" />,
    );
    expect(body(container).getAttribute("data-highlight-status")).toBe("plain");
    cleanup();
    setHighlightBackend(null);
    const second = render(<CodeBlock source="let a" language="ts" closed blockKey="k7" />);
    await waitFor(() =>
      expect(body(second.container).getAttribute("data-highlight-status")).toBe("error"),
    );
    expect(body(second.container).textContent).toBe("let a");
  });

  test("a worker failure offers retry, which then highlights", async () => {
    let fail = true;
    setHighlightBackend({
      async highlight(input) {
        if (fail) throw new Error("worker crashed");
        return {
          lines: input.code.split("\n").map((line) => [{ c: line, s: "#00ff00" }]),
          stateId: null,
        };
      },
    });
    const { container } = render(
      <CodeBlock source="let a = 1;" language="ts" closed blockKey="k8" />,
    );
    const retry = await screen.findByRole("button", { name: "Retry syntax highlighting" });
    fail = false;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(body(container).getAttribute("data-highlight-status")).toBe("ready"),
    );
  });

  test("streaming fences keep exact plain text and highlight once closed", async () => {
    const { container, rerender } = render(
      <CodeBlock source={"line one\nline tw"} language="ts" closed={false} live blockKey="k9" />,
    );
    expect(backend.calls).toHaveLength(0);
    rerender(
      <CodeBlock
        source={"line one\nline two\nline th"}
        language="ts"
        closed={false}
        live
        blockKey="k9"
      />,
    );
    expect(backend.calls).toHaveLength(0);
    expect(body(container).textContent).toBe("line one\nline two\nline th");
    rerender(
      <CodeBlock source={"line one\nline two\nline th"} language="ts" closed blockKey="k9" />,
    );
    await waitFor(() => expect(backend.calls).toHaveLength(1));
    expect(backend.calls[0]?.code).toBe("line one\nline two\nline th");
  });

  test("Run in terminal is enabled only for a complete single-line shell fence and runs once per click", () => {
    const createTab = mock((..._args: unknown[]) => true);
    const { rerender } = render(
      withTerminal(
        <CodeBlock source="bun test" language="bash" closed blockKey="k10" />,
        createTab,
      ),
    );
    const run = screen.getByRole("button", { name: "Run in new terminal" }) as HTMLButtonElement;
    expect(run.disabled).toBe(false);
    // Rendering alone never runs anything.
    expect(createTab).not.toHaveBeenCalled();
    fireEvent.click(run);
    expect(createTab).toHaveBeenCalledTimes(1);
    expect(createTab.mock.calls[0]?.[1]).toMatchObject({ initialCommands: ["bun test"] });

    for (const props of [
      { source: "bun test", closed: false },
      { source: "bun test", closed: true, live: true },
      { source: "bun test", closed: true, clipped: true },
      { source: "a\nb", closed: true },
    ]) {
      rerender(withTerminal(<CodeBlock language="bash" blockKey="k10" {...props} />, createTab));
      expect(
        (screen.getByRole("button", { name: "Run in new terminal" }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    rerender(
      withTerminal(<CodeBlock source="bun test" language="ts" closed blockKey="k10" />, createTab),
    );
    expect(screen.queryByRole("button", { name: "Run in new terminal" }) === null).toBe(true);
  });

  test("wrap and expansion are persisted per block key across remounts", () => {
    const source = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const first = render(<CodeBlock source={source} language="ts" closed blockKey="k11" />);
    fireEvent.click(screen.getByRole("button", { name: "Wrap lines" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand code" }));
    first.unmount();
    render(<CodeBlock source={source} language="ts" closed blockKey="k11" />);
    expect(screen.getByRole("button", { name: "Wrap lines" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "Collapse code" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  test("a 5,000-line fence keeps no per-line nodes and a bounded inline region, collapsed and expanded", async () => {
    const source = `${Array.from({ length: 5_000 }, (_, index) => `row ${index}\t<x>`).join("\n")}\n`;
    expect(withinHighlightLimits(source)).toBe(false);
    const { container } = render(
      <CodeBlock source={source} language="ts" closed blockKey="k-big" />,
    );
    const code = () => body(container).querySelector("code")!;
    // Collapsed: plain text in a single text node holding only the inline region.
    expect(container.querySelectorAll("[data-code-line]")).toHaveLength(0);
    expect(code().childNodes).toHaveLength(1);
    expect(code().textContent!.split("\n")).toHaveLength(INLINE_CODE_LINE_LIMIT);
    expect(
      screen.getByRole("button", { name: `Show ${INLINE_CODE_LINE_LIMIT} of 5000 lines` }),
    ).toBeTruthy();
    // Find still sees exactly the whole source, in order.
    expect(searchRootText(container)).toBe(source);

    fireEvent.click(screen.getByRole("button", { name: "Expand code" }));
    expect(container.querySelectorAll("[data-code-line]")).toHaveLength(0);
    expect(code().childNodes).toHaveLength(1);
    expect(code().textContent!.split("\n")).toHaveLength(INLINE_CODE_LINE_LIMIT);
    const notice = container.querySelector("[data-code-omitted-lines]")!;
    expect(notice.getAttribute("data-code-omitted-lines")).toBe(
      String(5_000 - INLINE_CODE_LINE_LIMIT),
    );
    expect(notice.textContent).toContain(`${5_000 - INLINE_CODE_LINE_LIMIT} more lines`);
    expect(searchRootText(container)).toBe(source);

    // Copy code copies the full exact source, not the inline region.
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(source));

    fireEvent.click(screen.getByRole("button", { name: "Open all 5000 lines in viewer" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("pre")?.textContent).toBe(source);
  });

  test("a highlightable fence over the inline bound renders at most the bound as line nodes", async () => {
    const lineTotal = 1_500;
    const source = Array.from(
      { length: lineTotal },
      (_, index) => `const v${index} = ${index};`,
    ).join("\n");
    expect(withinHighlightLimits(source)).toBe(true);
    const { container } = render(
      <CodeBlock source={source} language="ts" closed blockKey="k-mid" />,
    );
    await waitFor(() =>
      expect(body(container).getAttribute("data-highlight-status")).toBe("ready"),
    );
    expect(container.querySelectorAll("[data-code-line]")).toHaveLength(INLINE_CODE_LINE_LIMIT);
    expect(searchRootText(container)).toBe(source);
    fireEvent.click(screen.getByRole("button", { name: "Expand code" }));
    // Expansion keeps the same rendered region (no new rows), only unclipped.
    expect(container.querySelectorAll("[data-code-line]")).toHaveLength(INLINE_CODE_LINE_LIMIT);
    expect(
      container.querySelector("[data-code-omitted-lines]")?.getAttribute("data-code-omitted-lines"),
    ).toBe(String(lineTotal - INLINE_CODE_LINE_LIMIT));
    expect(searchRootText(container)).toBe(source);
  });

  test("a fence within the inline bound renders every line and shows no omission notice", () => {
    const source = Array.from({ length: INLINE_CODE_LINE_LIMIT }, (_, index) => `l${index}`).join(
      "\n",
    );
    const { container } = render(
      <CodeBlock source={source} language="ts" closed blockKey="k-edge" />,
    );
    expect(container.querySelectorAll("[data-code-line]")).toHaveLength(INLINE_CODE_LINE_LIMIT);
    fireEvent.click(screen.getByRole("button", { name: "Expand code" }));
    expect(container.querySelector("[data-code-omitted-lines]") === null).toBe(true);
    expect(container.querySelector("[data-rich-search-mirror]") === null).toBe(true);
    expect(screen.queryByText(`Show all ${INLINE_CODE_LINE_LIMIT} lines`) === null).toBe(true);
  });
});
