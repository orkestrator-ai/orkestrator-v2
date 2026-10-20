import { afterEach, describe, expect, mock, test } from "bun:test";
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalProvider, useTerminalContext } from "@/contexts";
import { searchRootText } from "@/lib/chat/rich-markdown/find-reveal";
import { clearMarkdownSearchCache } from "@/lib/chat/rich-markdown/markdown-search";
import type { NativeMessage as NativeMessageType } from "@/lib/chat/native-message-types";
import { mockToastInfo } from "../../../../../../tests/mocks/sonner";
import { NativeMessage } from "../NativeMessage";
import { getNativeMessageSearchText } from "../native-message-search";

function message(content: string): NativeMessageType {
  return {
    id: "assistant-inline-files",
    role: "assistant",
    content: "",
    createdAt: "2026-10-20T10:00:00.000Z",
    parts: [{ type: "text", content }],
  };
}

function renderWithFileTabs(content: string) {
  const openFile = mock((_path: string, _options?: unknown) => undefined);
  function RegisterFileTab() {
    const { setCreateFileTab } = useTerminalContext();
    useEffect(() => {
      setCreateFileTab(openFile);
      return () => setCreateFileTab(null);
    }, [setCreateFileTab]);
    return null;
  }
  const view = render(
    <TerminalProvider>
      <RegisterFileTab />
      <NativeMessage message={message(content)} />
    </TerminalProvider>,
  );
  return { ...view, openFile };
}

afterEach(() => {
  cleanup();
  clearMarkdownSearchCache();
});

describe("inline code file references", () => {
  test.each([
    ["src/app.ts:12", "src/app.ts", { lineNumber: 12 }],
    ["src/app.ts:12:4", "src/app.ts", { lineNumber: 12, columnNumber: 4 }],
    ["C:\\repo\\a.ts:3", "C:\\repo\\a.ts", { lineNumber: 3 }],
    ["/abs/path/a%20b.ts:5", "/abs/path/a b.ts", { lineNumber: 5 }],
    ["src/a.ts#L10", "src/a.ts", { lineNumber: 10 }],
    ["./docs/guide.md:7", "./docs/guide.md", { lineNumber: 7 }],
  ])("`%s` opens the exact file and line through the environment", (text, path, location) => {
    const { container, openFile } = renderWithFileTabs(`See \`${text}\` for details.`);
    const link = screen.getByRole("link", { name: text });
    // Visible text is exactly the code text, inside the <code> element.
    expect(link.textContent).toBe(text);
    const code = link.closest("code");
    expect(code?.textContent).toBe(text);
    expect(code?.getAttribute("data-inline-file-reference")).toBe("true");
    expect(link.getAttribute("title")).toContain(`line ${location.lineNumber}`);
    fireEvent.click(link);
    expect(openFile).toHaveBeenCalledWith(path, location);
    // Nothing interactive is nested.
    expect(link.querySelector("a, button") === null).toBe(true);
    expect(container.querySelectorAll("a a, button a, a button")).toHaveLength(0);
  });

  test("a fence containing the same text stays unlinked", () => {
    const { container } = renderWithFileTabs(
      ["Inline `src/app.ts:12` here.", "", "```", "src/app.ts:12", "```"].join("\n"),
    );
    expect(screen.getAllByRole("link", { name: "src/app.ts:12" })).toHaveLength(1);
    const fence = container.querySelector<HTMLElement>('[data-rich-block="code"]');
    expect(fence?.textContent).toContain("src/app.ts:12");
    expect(fence?.querySelector("a") === null).toBe(true);
  });

  test("identifiers, URLs, bare names and paths without a line stay plain code", () => {
    const { container } = renderWithFileTabs(
      "Use `useState`, `src/app.ts`, `app.ts:12`, `localhost:3000`, `https://example.com/a.ts:1` and `example.com/a.ts:2`.",
    );
    expect(container.querySelectorAll("code a")).toHaveLength(0);
    expect(container.querySelectorAll("code")).toHaveLength(6);
  });

  test("inline code inside a Markdown link does not nest a second link", () => {
    const { container, openFile } = renderWithFileTabs(
      "Open [`src/app.ts:12`](https://example.com/blob/app.ts) now.",
    );
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("https://example.com/blob/app.ts");
    expect(container.querySelector("a a") === null).toBe(true);
    expect(openFile).not.toHaveBeenCalled();
  });

  test("without an environment the link explains how to open the file", () => {
    render(<NativeMessage message={message("See `src/app.ts:12`.")} />);
    fireEvent.click(screen.getByRole("link", { name: "src/app.ts:12" }));
    expect(mockToastInfo).toHaveBeenCalledTimes(1);
    expect(String(mockToastInfo.mock.calls[0]?.[0])).toContain("Start or open the environment");
  });

  test("find text is unchanged by the link", () => {
    const content = "Check `src/app.ts:12:4` and `C:\\repo\\a.ts:3` twice: `src/app.ts:12:4`.";
    const msg = message(content);
    const { container } = renderWithFileTabs(content);
    const rendered = Array.from(
      container.querySelectorAll<HTMLElement>("[data-agent-chat-search-content]"),
    )
      .map((root) => searchRootText(root))
      .join("\n\n");
    expect(rendered).toBe(getNativeMessageSearchText(msg));
    expect(container.querySelectorAll("code a")).toHaveLength(3);
  });
});
