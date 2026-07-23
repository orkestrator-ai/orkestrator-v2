import { describe, expect, mock, test } from "bun:test";
import {
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
