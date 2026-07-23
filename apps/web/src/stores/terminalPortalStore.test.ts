import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { invoke } from "@/lib/native/backend";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  DEFAULT_TERMINAL_SCROLLBACK,
} from "@/constants/terminal";
import {
  TERMINAL_BROWSER_TAB_REQUEST_EVENT,
  type TerminalBrowserTabRequest,
} from "@/lib/terminal-links";
import {
  createTerminalKey,
  useTerminalPortalStore,
  type PersistentTerminalData,
} from "./terminalPortalStore";

type WebLinkHandler = (event: MouseEvent, uri: string) => void;

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const originalGateway = window.orkestratorGateway;

function webLinkHandler(terminalData: PersistentTerminalData): WebLinkHandler {
  return (terminalData.webLinksAddon as unknown as { _handler: WebLinkHandler })._handler;
}

function linkEvent(
  modifiers: Partial<Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">>,
): MouseEvent {
  return new MouseEvent("click", modifiers);
}

function createTerminal(
  tabId = "tab-1",
  environmentId = "env-1",
  options: {
    containerId?: string | null;
    appearance?: {
      fontFamily?: string;
      fontSize?: number;
      backgroundColor?: string;
    };
    scrollback?: number;
  } = {},
): PersistentTerminalData {
  return useTerminalPortalStore.getState().createTerminal({
    tabId,
    environmentId,
    containerId:
      options.containerId === undefined ? "container-1" : options.containerId,
    appearance: options.appearance,
    scrollback: options.scrollback,
  });
}

beforeEach(() => {
  useTerminalPortalStore.setState({
    paneHosts: new Map(),
    terminals: new Map(),
  });
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  window.orkestratorGateway = originalGateway;
});

afterEach(() => {
  useTerminalPortalStore.getState().clearAllTerminals();
  useTerminalPortalStore.setState({
    paneHosts: new Map(),
    terminals: new Map(),
  });
  window.orkestratorGateway = originalGateway;
});

describe("terminal creation and lookup", () => {
  test("registers, replaces, gets, and unregisters environment-scoped pane hosts", () => {
    const first = document.createElement("div");
    const replacement = document.createElement("div");
    const otherEnvironment = document.createElement("div");

    useTerminalPortalStore.getState().registerPaneHost("env-a", "pane-1", first);
    useTerminalPortalStore.getState().registerPaneHost(
      "env-b",
      "pane-1",
      otherEnvironment,
    );
    useTerminalPortalStore.getState().registerPaneHost(
      "env-a",
      "pane-1",
      replacement,
    );

    expect(useTerminalPortalStore.getState().getPaneHost("env-a", "pane-1")).toBe(
      replacement,
    );
    expect(useTerminalPortalStore.getState().getPaneHost("env-b", "pane-1")).toBe(
      otherEnvironment,
    );
    expect(useTerminalPortalStore.getState().getPaneHost("env-a", "missing")).toBeUndefined();

    useTerminalPortalStore.getState().unregisterPaneHost("env-a", "missing");
    useTerminalPortalStore.getState().unregisterPaneHost("env-a", "pane-1");
    expect(useTerminalPortalStore.getState().getPaneHost("env-a", "pane-1")).toBeUndefined();
    expect(useTerminalPortalStore.getState().getPaneHost("env-b", "pane-1")).toBe(
      otherEnvironment,
    );
  });

  test("creates a terminal with default settings and all addons", () => {
    const data = createTerminal();

    expect(data).toMatchObject({
      tabId: "tab-1",
      environmentId: "env-1",
      containerId: "container-1",
      containerElement: null,
      currentPaneId: null,
      isOpened: false,
    });
    expect(data.terminal.options.fontFamily).toStartWith(
      `"${DEFAULT_TERMINAL_APPEARANCE.fontFamily}"`,
    );
    expect(data.terminal.options.fontSize).toBe(DEFAULT_TERMINAL_APPEARANCE.fontSize);
    expect(data.terminal.options.theme?.background).toBe(
      DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
    );
    expect(data.terminal.options.scrollback).toBe(DEFAULT_TERMINAL_SCROLLBACK);
    expect(data.fitAddon).toBeDefined();
    expect(data.serializeAddon).toBeDefined();
    expect(data.webLinksAddon).toBeDefined();
    expect(data.portalElement.className).toBe(
      "absolute inset-0 pointer-events-auto",
    );
  });

  test("preserves custom settings, falls back for invalid scrollback, and deduplicates keys", () => {
    const custom = createTerminal("custom", "env-1", {
      containerId: null,
      appearance: {
        fontFamily: "Commit Mono",
        fontSize: 17,
        backgroundColor: "#123456",
      },
      scrollback: 4321,
    });
    const invalidScrollback = createTerminal("fallback", "env-1", {
      scrollback: 0,
    });
    const duplicate = useTerminalPortalStore.getState().createTerminal({
      tabId: "custom",
      environmentId: "env-1",
      containerId: "different-container",
    });

    expect(custom.terminal.options.fontFamily).toStartWith('"Commit Mono"');
    expect(custom.terminal.options.fontSize).toBe(17);
    expect(custom.terminal.options.theme?.background).toBe("#123456");
    expect(custom.terminal.options.scrollback).toBe(4321);
    expect(custom.containerId).toBeNull();
    expect(invalidScrollback.terminal.options.scrollback).toBe(
      DEFAULT_TERMINAL_SCROLLBACK,
    );
    expect(duplicate).toBe(custom);
    expect(useTerminalPortalStore.getState().terminals.size).toBe(2);
  });

  test("gets and detects terminals by their environment-scoped key", () => {
    const data = createTerminal("same-tab", "env-a");
    createTerminal("same-tab", "env-b");

    expect(useTerminalPortalStore.getState().getTerminal("env-a", "same-tab")).toBe(data);
    expect(useTerminalPortalStore.getState().hasTerminal("env-a", "same-tab")).toBe(true);
    expect(useTerminalPortalStore.getState().hasTerminal("env-a", "missing")).toBe(false);
    expect(useTerminalPortalStore.getState().getTerminal("missing", "same-tab")).toBeUndefined();
  });
});

describe("terminal web link routing", () => {
  test.each([
    ["Control", { ctrlKey: true, shiftKey: true }],
    ["Command", { metaKey: true, shiftKey: true }],
  ] as const)("routes shifted %s-clicks to an internal browser request", (_, modifiers) => {
    const data = createTerminal("source-tab", "source-env");
    const requests: TerminalBrowserTabRequest[] = [];
    const listener = (event: Event) => {
      requests.push((event as CustomEvent<TerminalBrowserTabRequest>).detail);
    };
    window.addEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, listener);

    try {
      webLinkHandler(data)(linkEvent(modifiers), "https://example.com/internal?q=1");
    } finally {
      window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, listener);
    }

    expect(requests).toEqual([{
      environmentId: "source-env",
      sourceTabId: "source-tab",
      url: "https://example.com/internal?q=1",
    }]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test.each([
    ["Control", { ctrlKey: true }],
    ["Command", { metaKey: true }],
  ] as const)("opens ordinary %s-clicks externally", async (_, modifiers) => {
    const data = createTerminal();

    webLinkHandler(data)(linkEvent(modifiers), "https://example.com/external");
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("open_in_browser", {
      url: "https://example.com/external",
    });
  });

  test("does nothing when a link is clicked without a command modifier", async () => {
    const data = createTerminal();
    const requests: TerminalBrowserTabRequest[] = [];
    const listener = (event: Event) => {
      requests.push((event as CustomEvent<TerminalBrowserTabRequest>).detail);
    };
    window.addEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, listener);

    try {
      webLinkHandler(data)(linkEvent({}), "https://example.com/ignored");
      await Promise.resolve();
    } finally {
      window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, listener);
    }

    expect(requests).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("logs rejected external open requests", async () => {
    const error = new Error("native open failed");
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    invokeMock.mockRejectedValueOnce(error);

    try {
      webLinkHandler(createTerminal())(
        linkEvent({ ctrlKey: true }),
        "https://example.com/failure",
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(consoleError).toHaveBeenCalledWith(
        "[terminalPortalStore] Failed to open URL:",
        error,
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("terminal lifecycle mutations", () => {
  test("updates pane, opened, and container fields and ignores missing terminals", () => {
    const data = createTerminal();
    const container = document.createElement("div");
    const initialMap = useTerminalPortalStore.getState().terminals;

    useTerminalPortalStore.getState().setTerminalPane("missing", "tab-1", "pane-x");
    useTerminalPortalStore.getState().markTerminalOpened("missing", "tab-1");
    useTerminalPortalStore.getState().setTerminalContainer("missing", "tab-1", container);
    expect(useTerminalPortalStore.getState().terminals).toBe(initialMap);

    useTerminalPortalStore.getState().setTerminalPane("env-1", "tab-1", "pane-2");
    useTerminalPortalStore.getState().markTerminalOpened("env-1", "tab-1");
    useTerminalPortalStore.getState().setTerminalContainer("env-1", "tab-1", container);

    expect(useTerminalPortalStore.getState().getTerminal("env-1", "tab-1")).toMatchObject({
      currentPaneId: "pane-2",
      isOpened: true,
      containerElement: container,
    });
    expect(useTerminalPortalStore.getState().getTerminal("env-1", "tab-1")).not.toBe(data);
  });

  test("disposes attached and detached terminals and ignores missing keys", () => {
    const attached = createTerminal("attached");
    const detached = createTerminal("detached");
    const attachedDispose = mock(() => undefined);
    const detachedDispose = mock(() => undefined);
    attached.terminal.dispose = attachedDispose;
    detached.terminal.dispose = detachedDispose;
    const parent = document.createElement("div");
    parent.appendChild(attached.portalElement);

    useTerminalPortalStore.getState().disposeTerminal("missing", "missing");
    useTerminalPortalStore.getState().disposeTerminal("env-1", "attached");
    useTerminalPortalStore.getState().disposeTerminal("env-1", "detached");

    expect(attachedDispose).toHaveBeenCalledTimes(1);
    expect(detachedDispose).toHaveBeenCalledTimes(1);
    expect(parent.childElementCount).toBe(0);
    expect(useTerminalPortalStore.getState().terminals.size).toBe(0);
  });

  test("clears only the requested environment, including attached portals", () => {
    const attached = createTerminal("attached", "env-a");
    const detached = createTerminal("detached", "env-a");
    const retained = createTerminal("retained", "env-b");
    const attachedDispose = mock(() => undefined);
    const detachedDispose = mock(() => undefined);
    const retainedDispose = mock(() => undefined);
    attached.terminal.dispose = attachedDispose;
    detached.terminal.dispose = detachedDispose;
    retained.terminal.dispose = retainedDispose;
    const parent = document.createElement("div");
    parent.appendChild(attached.portalElement);

    useTerminalPortalStore.getState().clearTerminalsForEnvironment("missing");
    useTerminalPortalStore.getState().clearTerminalsForEnvironment("env-a");

    expect(attachedDispose).toHaveBeenCalledTimes(1);
    expect(detachedDispose).toHaveBeenCalledTimes(1);
    expect(retainedDispose).not.toHaveBeenCalled();
    expect(parent.childElementCount).toBe(0);
    expect(useTerminalPortalStore.getState().terminals).toEqual(
      new Map([[createTerminalKey("env-b", "retained"), retained]]),
    );
  });

  test("clears all attached and detached terminals", () => {
    const attached = createTerminal("attached", "env-a");
    const detached = createTerminal("detached", "env-b");
    const attachedDispose = mock(() => undefined);
    const detachedDispose = mock(() => undefined);
    attached.terminal.dispose = attachedDispose;
    detached.terminal.dispose = detachedDispose;
    const parent = document.createElement("div");
    parent.appendChild(attached.portalElement);

    useTerminalPortalStore.getState().clearAllTerminals();

    expect(attachedDispose).toHaveBeenCalledTimes(1);
    expect(detachedDispose).toHaveBeenCalledTimes(1);
    expect(parent.childElementCount).toBe(0);
    expect(useTerminalPortalStore.getState().terminals.size).toBe(0);
  });
});

describe("terminal recreation", () => {
  test("returns null when the terminal does not exist", () => {
    expect(
      useTerminalPortalStore.getState().recreateTerminal("missing", "missing"),
    ).toBeNull();
  });

  test("disposes the old terminal, removes its portal, and preserves settings and identity", () => {
    const old = createTerminal("tab-custom", "env-custom", {
      containerId: "container-custom",
      appearance: {
        fontFamily: "JetBrains Mono",
        fontSize: 19,
        backgroundColor: "#102030",
      },
      scrollback: 9876,
    });
    useTerminalPortalStore.getState().setTerminalPane(
      "env-custom",
      "tab-custom",
      "pane-custom",
    );
    useTerminalPortalStore.getState().markTerminalOpened("env-custom", "tab-custom");
    useTerminalPortalStore.getState().setTerminalContainer(
      "env-custom",
      "tab-custom",
      document.createElement("div"),
    );
    const oldDispose = mock(() => undefined);
    old.terminal.dispose = oldDispose;
    const parent = document.createElement("div");
    parent.appendChild(old.portalElement);

    const recreated = useTerminalPortalStore.getState().recreateTerminal(
      "env-custom",
      "tab-custom",
    );

    expect(recreated).not.toBeNull();
    if (!recreated) {
      throw new Error("Expected terminal recreation to succeed");
    }
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(parent.childElementCount).toBe(0);
    expect(recreated).not.toBe(old);
    expect(recreated.terminal).not.toBe(old.terminal);
    expect(recreated).toMatchObject({
      tabId: "tab-custom",
      environmentId: "env-custom",
      containerId: "container-custom",
      currentPaneId: "pane-custom",
      containerElement: null,
      isOpened: false,
    });
    expect(recreated.terminal.options.fontFamily).toStartWith('"JetBrains Mono"');
    expect(recreated.terminal.options.fontSize).toBe(19);
    expect(recreated.terminal.options.theme?.background).toBe("#102030");
    expect(recreated.terminal.options.scrollback).toBe(9876);
    expect(recreated.portalElement.className).toBe(
      "absolute inset-0 pointer-events-auto",
    );
    expect(
      useTerminalPortalStore.getState().getTerminal("env-custom", "tab-custom"),
    ).toBe(recreated);
  });

  test("continues recreation when disposal throws and restores default settings for missing options", () => {
    const old = createTerminal("tab-error", "env-error", {
      containerId: null,
    });
    old.terminal.dispose = () => {
      throw new Error("dispose failed");
    };
    old.terminal.options.fontFamily = "";
    old.terminal.options.fontSize = undefined;
    old.terminal.options.theme = undefined;
    old.terminal.options.scrollback = undefined;

    const recreated = useTerminalPortalStore.getState().recreateTerminal(
      "env-error",
      "tab-error",
    );

    expect(recreated).not.toBeNull();
    expect(recreated?.containerId).toBeNull();
    expect(recreated?.terminal.options.fontFamily).toStartWith(
      `"${DEFAULT_TERMINAL_APPEARANCE.fontFamily}"`,
    );
    expect(recreated?.terminal.options.fontSize).toBe(
      DEFAULT_TERMINAL_APPEARANCE.fontSize,
    );
    expect(recreated?.terminal.options.theme?.background).toBe(
      DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
    );
    expect(recreated?.terminal.options.scrollback).toBe(
      DEFAULT_TERMINAL_SCROLLBACK,
    );
  });
});
