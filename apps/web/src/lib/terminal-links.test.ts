import { describe, expect, mock, spyOn, test } from "bun:test";
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
  const click = (modifiers: MouseEventInit) => new MouseEvent("click", { button: 0, ...modifiers });

  test("opens modified clicks externally and ignores plain clicks", () => {
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

  test.each(
    [1, 2].flatMap((button) =>
      [false, true].flatMap((shiftKey) =>
        [{ ctrlKey: true }, { metaKey: true }].map((modifier) => ({
          button,
          shiftKey,
          ...modifier,
        })),
      ),
    ),
  )("ignores non-primary modifier clicks: %j", (event) => {
    const openExternal = mock((_url: string) => Promise.resolve());
    const listener = mock((_request: TerminalBrowserTabRequest) => undefined);
    const stopListening = listenForTerminalBrowserTabRequests(listener);
    const activate = createTerminalLinkActivator({
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      openExternal,
    });
    try {
      activate(click(event), "https://example.com/ignored");
      expect(openExternal).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      stopListening();
    }
  });

  test("handles rejected external opens without an unhandled rejection", async () => {
    const error = new Error("external open failed");
    const openExternal = mock((_url: string) => Promise.reject(error));
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const activate = createTerminalLinkActivator({
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      openExternal,
    });
    try {
      activate(click({ ctrlKey: true }), "https://example.com/failure");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(openExternal).toHaveBeenCalledWith("https://example.com/failure");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith("[terminal-links] Failed to open URL:", error);
    } finally {
      consoleError.mockRestore();
    }
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
