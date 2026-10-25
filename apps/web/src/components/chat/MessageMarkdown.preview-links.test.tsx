import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  TERMINAL_BROWSER_TAB_REQUEST_EVENT,
  type TerminalBrowserTabRequest,
} from "@/lib/terminal-links";
import { PreviewLinkSourceContext } from "./link-source-context";
import { MarkdownLink } from "./MessageMarkdown";

describe("agent loopback links", () => {
  const requests: TerminalBrowserTabRequest[] = [];
  const openExternal = mock(async (_url: string) => undefined);
  const record = (event: Event) =>
    requests.push((event as CustomEvent<TerminalBrowserTabRequest>).detail);
  const previousOrkestrator = window.orkestrator;

  beforeEach(() => {
    requests.length = 0;
    openExternal.mockClear();
    window.orkestrator = { shell: { openExternal } } as unknown as typeof window.orkestrator;
    window.addEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, record);
  });
  afterEach(() => {
    cleanup();
    window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, record);
    window.orkestrator = previousOrkestrator;
  });

  function renderLink(href: string, source = true) {
    const link = <MarkdownLink href={href}>dev server</MarkdownLink>;
    render(
      source ? (
        <PreviewLinkSourceContext.Provider value={{ environmentId: "env-a", tabId: "agent-1" }}>
          {link}
        </PreviewLinkSourceContext.Provider>
      ) : (
        link
      ),
    );
    return screen.getByText("dev server");
  }

  test("⌘⇧-click opens a preview tab resolved in the agent's environment", () => {
    const link = renderLink("http://localhost:5173/app");
    expect(link.getAttribute("title")).toBe("⌘⇧-click (Ctrl+Shift-click) opens a preview tab");
    fireEvent.click(link, { metaKey: true, shiftKey: true });
    expect(requests).toEqual([
      {
        environmentId: "env-a",
        sourceTabId: "agent-1",
        url: "http://localhost:5173/app",
        origin: "agent",
      },
    ]);
    expect(openExternal).not.toHaveBeenCalled();
  });

  test("a plain click keeps opening the system browser", () => {
    fireEvent.click(renderLink("http://localhost:5173/"));
    expect(requests).toEqual([]);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  test("non-loopback links and links outside an environment's agent tab are unchanged", () => {
    const remote = renderLink("https://example.com/");
    expect(remote.getAttribute("title")).toBeNull();
    fireEvent.click(remote, { metaKey: true, shiftKey: true });
    cleanup();
    const coordinator = renderLink("http://localhost:5173/", false);
    expect(coordinator.getAttribute("title")).toBeNull();
    fireEvent.click(coordinator, { ctrlKey: true, shiftKey: true });
    expect(requests).toEqual([]);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});
