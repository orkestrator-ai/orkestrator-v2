import { describe, expect, mock, test } from "bun:test";
import {
  createTerminalLinkActivator,
  getTerminalLinkTarget,
  listenForTerminalBrowserTabRequests,
  requestTerminalBrowserTab,
  type TerminalBrowserTabRequest,
} from "./terminal-links";

describe("getTerminalLinkTarget", () => {
  test("keeps unmodified clicks inside the terminal", () => {
    expect(
      getTerminalLinkTarget({
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe("none");
  });

  test("opens Cmd+Click and Ctrl+Click externally", () => {
    expect(
      getTerminalLinkTarget({
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe("external");
    expect(
      getTerminalLinkTarget({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe("external");
  });

  test("opens shifted modifier clicks in an Orkestrator browser tab", () => {
    expect(
      getTerminalLinkTarget({
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe("browser-tab");
    expect(
      getTerminalLinkTarget({
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe("browser-tab");
  });
});

describe("createTerminalLinkActivator", () => {
  const click = (modifiers: Partial<MouseEvent>) => modifiers as MouseEvent;

  test("opens modified clicks externally and ignores plain or right clicks", () => {
    const openExternal = mock((_url: string) => Promise.resolve());
    const activate = createTerminalLinkActivator({
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      openExternal,
    });

    activate(click({ metaKey: true }), "https://example.com/a");
    activate(click({}), "https://example.com/b");

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/a");
  });

  test("routes shifted clicks to a browser tab request", () => {
    const openExternal = mock((_url: string) => Promise.resolve());
    const listener = mock((_request: TerminalBrowserTabRequest) => undefined);
    const stopListening = listenForTerminalBrowserTabRequests(listener);
    const activate = createTerminalLinkActivator({
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      openExternal,
    });

    try {
      activate(click({ metaKey: true, shiftKey: true }), "https://example.com/");
      expect(openExternal).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith({
        environmentId: "environment-1",
        sourceTabId: "terminal-1",
        url: "https://example.com/",
      });
    } finally {
      stopListening();
    }
  });
});

describe("terminal browser tab requests", () => {
  test("delivers the exact request detail once", () => {
    const listener = mock((_request: TerminalBrowserTabRequest) => undefined);
    const request = {
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      url: "http://localhost:3000/path?query=value#section",
    };
    const stopListening = listenForTerminalBrowserTabRequests(listener);

    try {
      requestTerminalBrowserTab(request);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(request);
      expect(listener.mock.calls[0]?.[0]).toBe(request);
    } finally {
      stopListening();
    }
  });

  test("stops delivering requests after unsubscribe", () => {
    const listener = mock((_request: TerminalBrowserTabRequest) => undefined);
    const request = {
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      url: "http://localhost:3000/",
    };
    const stopListening = listenForTerminalBrowserTabRequests(listener);

    requestTerminalBrowserTab(request);
    stopListening();
    requestTerminalBrowserTab(request);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
