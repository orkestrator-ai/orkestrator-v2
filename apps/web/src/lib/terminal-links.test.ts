import { describe, expect, mock, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { configStore } from "@/stores/configStore";
import {
  createTerminalLinkActivator,
  getTerminalLinkTarget,
  listenForTerminalBrowserTabRequests,
  requestTerminalBrowserTab,
  type TerminalBrowserTabRequest,
} from "./terminal-links";
import { appCommandStore } from "@/test/app-command-store";

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

describe("getTerminalLinkTarget with a preview-tab default", () => {
  test("swaps the two targets and keeps plain clicks inside the terminal", () => {
    const target = (modifiers: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) =>
      getTerminalLinkTarget(
        { metaKey: false, ctrlKey: false, shiftKey: false, ...modifiers },
        "browser-tab",
      );
    expect(target({})).toBe("none");
    expect(target({ shiftKey: true })).toBe("none");
    expect(target({ metaKey: true })).toBe("browser-tab");
    expect(target({ ctrlKey: true })).toBe("browser-tab");
    expect(target({ metaKey: true, shiftKey: true })).toBe("external");
    expect(target({ ctrlKey: true, shiftKey: true })).toBe("external");
  });
});

describe("createTerminalLinkActivator", () => {
  const click = (modifiers: MouseEventInit) => new MouseEvent("click", { button: 0, ...modifiers });

  test("reads the default target on each click, so a live terminal follows the setting", () => {
    const original = appCommandStore(configStore).getState().config;
    const setDefaultTarget = (terminalLinkDefaultTarget: "external" | "browser-tab" | undefined) =>
      appCommandStore(configStore).setState({
        config: { ...original, global: { ...original.global, terminalLinkDefaultTarget } },
      });
    const openExternal = mock((_url: string) => Promise.resolve());
    const listener = mock((_request: TerminalBrowserTabRequest) => undefined);
    const stopListening = listenForTerminalBrowserTabRequests(listener);
    const activate = createTerminalLinkActivator({
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      openExternal,
    });
    const request = {
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      url: "http://localhost:3000/",
    };

    try {
      setDefaultTarget("browser-tab");
      activate(click({ metaKey: true }), request.url);
      expect(listener).toHaveBeenCalledWith(request);
      expect(openExternal).not.toHaveBeenCalled();

      activate(click({ metaKey: true, shiftKey: true }), request.url);
      expect(openExternal).toHaveBeenCalledWith(request.url);
      expect(listener).toHaveBeenCalledTimes(1);

      setDefaultTarget(undefined);
      activate(click({ metaKey: true }), request.url);
      expect(openExternal).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      stopListening();
      appCommandStore(configStore).setState({ config: original });
    }
  });

  test.each(["https://example.com/", "mailto:hello@example.com", "ftp://localhost/file"])(
    "opens non-previewable %s externally for either preview gesture",
    (url) => {
      const original = appCommandStore(configStore).getState().config;
      const openExternal = mock((_url: string) => Promise.resolve());
      const listener = mock((_request: TerminalBrowserTabRequest) => undefined);
      const stopListening = listenForTerminalBrowserTabRequests(listener);
      const activate = createTerminalLinkActivator({
        environmentId: "environment-1",
        sourceTabId: "terminal-1",
        openExternal,
      });
      try {
        for (const terminalLinkDefaultTarget of ["external", "browser-tab"] as const) {
          appCommandStore(configStore).setState({
            config: { ...original, global: { ...original.global, terminalLinkDefaultTarget } },
          });
          for (const shiftKey of [false, true]) {
            activate(click({ metaKey: true, shiftKey }), url);
            activate(click({ ctrlKey: true, shiftKey }), url);
          }
          activate(click({}), url);
        }
        expect(openExternal).toHaveBeenCalledTimes(8);
        expect(openExternal).toHaveBeenCalledWith(url);
        expect(listener).not.toHaveBeenCalled();
      } finally {
        stopListening();
        appCommandStore(configStore).setState({ config: original });
      }
    },
  );

  test.each(["external", "browser-tab"] as const)(
    "opens a pull request link in the PR pane with the default gesture (default %s)",
    (terminalLinkDefaultTarget) => {
      const original = appCommandStore(configStore).getState().config;
      appCommandStore(configStore).setState({
        config: { ...original, global: { ...original.global, terminalLinkDefaultTarget } },
      });
      const openExternal = mock((_url: string) => Promise.resolve());
      const openPullRequest = mock(() => true);
      const activate = createTerminalLinkActivator({
        environmentId: "environment-1",
        sourceTabId: "terminal-1",
        openExternal,
        openPullRequest,
      });
      const url = "https://github.com/acme/repo/pull/12/files";
      try {
        activate(click({}), url);
        expect(openPullRequest).not.toHaveBeenCalled();

        activate(click({ metaKey: true }), url);
        activate(click({ ctrlKey: true }), url);
        expect(openPullRequest).toHaveBeenCalledTimes(2);
        expect(openPullRequest).toHaveBeenCalledWith(
          { owner: "acme", repo: "repo", number: 12, view: "code" },
          "code",
        );
        expect(openExternal).not.toHaveBeenCalled();

        // Shift asks for the other target, which for a pull request is GitHub.
        activate(click({ metaKey: true, shiftKey: true }), url);
        expect(openPullRequest).toHaveBeenCalledTimes(2);
        expect(openExternal).toHaveBeenCalledWith(url);
      } finally {
        appCommandStore(configStore).setState({ config: original });
      }
    },
  );

  test("opens a pull request externally when the PR pane cannot host it", () => {
    const openExternal = mock((_url: string) => Promise.resolve());
    const openPullRequest = mock(() => false);
    const activate = createTerminalLinkActivator({
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      openExternal,
      openPullRequest,
    });
    activate(click({ metaKey: true }), "https://github.com/acme/repo/pull/12");
    expect(openPullRequest).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/acme/repo/pull/12");
  });

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
    const logs = captureLogs();
    const activate = createTerminalLinkActivator({
      environmentId: "environment-1",
      sourceTabId: "terminal-1",
      openExternal,
    });
    try {
      activate(click({ ctrlKey: true }), "https://example.com/failure");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(openExternal).toHaveBeenCalledWith("https://example.com/failure");
      expect(logs.records()).toEqual([
        expect.objectContaining({
          level: "error",
          area: "terminal",
          event: "link.open-failed",
          fields: expect.objectContaining({
            environmentId: "environment-1",
            error: expect.objectContaining({ message: "external open failed" }),
          }),
        }),
      ]);
      // The URL can carry tokens: it never reaches a log line.
      expect(logs.lines.join("\n")).not.toContain("example.com");
    } finally {
      logs.restore();
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
      activate(click({ metaKey: true, shiftKey: true }), "http://localhost:3000/");
      expect(openExternal).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith({
        environmentId: "environment-1",
        sourceTabId: "terminal-1",
        url: "http://localhost:3000/",
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
