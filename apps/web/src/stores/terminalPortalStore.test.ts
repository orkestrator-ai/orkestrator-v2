import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { invoke } from "@/lib/native/backend";
import { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_SCROLLBACK } from "@/constants/terminal";
import {
  TERMINAL_BROWSER_TAB_REQUEST_EVENT,
  type TerminalBrowserTabRequest,
} from "@/lib/terminal-links";
import { createXtermTerminal } from "@/lib/terminal-xterm";
import type { BackendId } from "@orkestrator/protocol/federation";
import { createElement, useLayoutEffect } from "react";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import {
  bindTerminalPortalsToScope,
  createPortalTargetKey,
  createTerminalKey,
  useTerminalPortalNodeId,
  useTerminalPortalStore,
  type PersistentTerminalData,
} from "./terminalPortalStore";

const NODE = "bk_node-a" as BackendId;

type WebLinkHandler = (event: MouseEvent, uri: string) => void;

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const originalGateway = window.orkestratorGateway;

function webLinkHandler(terminalData: PersistentTerminalData): WebLinkHandler {
  return (terminalData.webLinksAddon as unknown as { _handler: WebLinkHandler })._handler;
}

function linkEvent(
  modifiers: Partial<Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">>,
): MouseEvent {
  return new MouseEvent("click", { button: 0, ...modifiers });
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
  return useTerminalPortalStore.getState().createTerminal(
    {
      nodeId: NODE,
      tabId,
      environmentId,
      containerId: options.containerId === undefined ? "container-1" : options.containerId,
      appearance: options.appearance,
      scrollback: options.scrollback,
    },
    createXtermTerminal,
  );
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
  cleanupNodeScopes();
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

    useTerminalPortalStore.getState().registerPaneHost(NODE, "env-a", "pane-1", first);
    useTerminalPortalStore.getState().registerPaneHost(NODE, "env-b", "pane-1", otherEnvironment);
    useTerminalPortalStore.getState().registerPaneHost(NODE, "env-a", "pane-1", replacement);

    expect(useTerminalPortalStore.getState().getPaneHost(NODE, "env-a", "pane-1")).toBe(
      replacement,
    );
    expect(useTerminalPortalStore.getState().getPaneHost(NODE, "env-b", "pane-1")).toBe(
      otherEnvironment,
    );
    expect(useTerminalPortalStore.getState().getPaneHost(NODE, "env-a", "missing")).toBeUndefined();

    useTerminalPortalStore.getState().unregisterPaneHost(NODE, "env-a", "missing");
    useTerminalPortalStore.getState().unregisterPaneHost(NODE, "env-a", "pane-1");
    expect(useTerminalPortalStore.getState().getPaneHost(NODE, "env-a", "pane-1")).toBeUndefined();
    expect(useTerminalPortalStore.getState().getPaneHost(NODE, "env-b", "pane-1")).toBe(
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
    // Without it, macOS has no way to select text under tmux `mouse on`.
    expect(data.terminal.options.macOptionClickForcesSelection).toBe(true);
    expect(data.terminal.options.altClickMovesCursor).toBe(false);
    expect(data.fitAddon).toBeDefined();
    expect(data.serializeAddon).toBeDefined();
    expect(data.webLinksAddon).toBeDefined();
    expect(data.portalElement.className).toBe("absolute inset-0 pointer-events-auto");
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
    const duplicate = useTerminalPortalStore.getState().createTerminal(
      {
        nodeId: NODE,
        tabId: "custom",
        environmentId: "env-1",
        containerId: "different-container",
      },
      createXtermTerminal,
    );

    expect(custom.terminal.options.fontFamily).toStartWith('"Commit Mono"');
    expect(custom.terminal.options.fontSize).toBe(17);
    expect(custom.terminal.options.theme?.background).toBe("#123456");
    expect(custom.terminal.options.scrollback).toBe(4321);
    expect(custom.containerId).toBeNull();
    expect(invalidScrollback.terminal.options.scrollback).toBe(DEFAULT_TERMINAL_SCROLLBACK);
    expect(duplicate).toBe(custom);
    expect(useTerminalPortalStore.getState().terminals.size).toBe(2);
  });

  test("gets and detects terminals by their environment-scoped key", () => {
    const data = createTerminal("same-tab", "env-a");
    createTerminal("same-tab", "env-b");

    expect(useTerminalPortalStore.getState().getTerminal(NODE, "env-a", "same-tab")).toBe(data);
    expect(useTerminalPortalStore.getState().hasTerminal(NODE, "env-a", "same-tab")).toBe(true);
    expect(useTerminalPortalStore.getState().hasTerminal(NODE, "env-a", "missing")).toBe(false);
    expect(
      useTerminalPortalStore.getState().getTerminal(NODE, "missing", "same-tab"),
    ).toBeUndefined();
  });
});

describe.each([
  ["plain URL addon", webLinkHandler],
  [
    "OSC 8 constructor option",
    (data: PersistentTerminalData): WebLinkHandler => {
      const handler = data.terminal.options.linkHandler;
      expect(handler).toBeDefined();
      return (event, uri) =>
        handler!.activate(event, uri, {
          start: { x: 1, y: 1 },
          end: { x: 10, y: 1 },
        });
    },
  ],
] as const)("terminal %s link routing", (_, handler) => {
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
      handler(data)(linkEvent(modifiers), "http://localhost:5173/internal?q=1");
    } finally {
      window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, listener);
    }

    expect(requests).toEqual([
      {
        environmentId: "source-env",
        sourceTabId: "source-tab",
        url: "http://localhost:5173/internal?q=1",
      },
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test.each([
    ["Control", { ctrlKey: true }],
    ["Command", { metaKey: true }],
  ] as const)("opens ordinary %s-clicks externally", async (_, modifiers) => {
    const data = createTerminal();

    handler(data)(linkEvent(modifiers), "https://example.com/external");
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
      handler(data)(linkEvent({}), "https://example.com/ignored");
      await Promise.resolve();
    } finally {
      window.removeEventListener(TERMINAL_BROWSER_TAB_REQUEST_EVENT, listener);
    }

    expect(requests).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("logs rejected external open requests", async () => {
    const error = new Error("native open failed");
    const logs = captureLogs();
    invokeMock.mockRejectedValueOnce(error);

    try {
      handler(createTerminal())(linkEvent({ ctrlKey: true }), "https://example.com/failure");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "error",
          area: "terminal",
          event: "link.open-failed",
          fields: expect.objectContaining({
            error: expect.objectContaining({ message: "native open failed" }),
          }),
        }),
      );
    } finally {
      logs.restore();
    }
  });
});

describe("terminal lifecycle mutations", () => {
  test("updates pane, opened, and container fields and ignores missing terminals", () => {
    const data = createTerminal();
    const container = document.createElement("div");
    const initialMap = useTerminalPortalStore.getState().terminals;

    useTerminalPortalStore.getState().setTerminalPane(NODE, "missing", "tab-1", "pane-x");
    useTerminalPortalStore.getState().markTerminalOpened(NODE, "missing", "tab-1");
    useTerminalPortalStore.getState().setTerminalContainer(NODE, "missing", "tab-1", container);
    expect(useTerminalPortalStore.getState().terminals).toBe(initialMap);

    useTerminalPortalStore.getState().setTerminalPane(NODE, "env-1", "tab-1", "pane-2");
    useTerminalPortalStore.getState().markTerminalOpened(NODE, "env-1", "tab-1");
    useTerminalPortalStore.getState().setTerminalContainer(NODE, "env-1", "tab-1", container);

    expect(useTerminalPortalStore.getState().getTerminal(NODE, "env-1", "tab-1")).toMatchObject({
      currentPaneId: "pane-2",
      isOpened: true,
      containerElement: container,
    });
    expect(useTerminalPortalStore.getState().getTerminal(NODE, "env-1", "tab-1")).not.toBe(data);
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

    useTerminalPortalStore.getState().disposeTerminal(NODE, "missing", "missing");
    useTerminalPortalStore.getState().disposeTerminal(NODE, "env-1", "attached");
    useTerminalPortalStore.getState().disposeTerminal(NODE, "env-1", "detached");

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

    useTerminalPortalStore.getState().clearTerminalsForEnvironment(NODE, "missing");
    useTerminalPortalStore.getState().clearTerminalsForEnvironment(NODE, "env-a");

    expect(attachedDispose).toHaveBeenCalledTimes(1);
    expect(detachedDispose).toHaveBeenCalledTimes(1);
    expect(retainedDispose).not.toHaveBeenCalled();
    expect(parent.childElementCount).toBe(0);
    expect(useTerminalPortalStore.getState().terminals).toEqual(
      new Map([[createTerminalKey(NODE, "env-b", "retained"), retained]]),
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
      useTerminalPortalStore
        .getState()
        .recreateTerminal(NODE, "missing", "missing", createXtermTerminal),
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
    useTerminalPortalStore
      .getState()
      .setTerminalPane(NODE, "env-custom", "tab-custom", "pane-custom");
    useTerminalPortalStore.getState().markTerminalOpened(NODE, "env-custom", "tab-custom");
    useTerminalPortalStore
      .getState()
      .setTerminalContainer(NODE, "env-custom", "tab-custom", document.createElement("div"));
    const oldDispose = mock(() => undefined);
    old.terminal.dispose = oldDispose;
    const parent = document.createElement("div");
    parent.appendChild(old.portalElement);

    const recreated = useTerminalPortalStore
      .getState()
      .recreateTerminal(NODE, "env-custom", "tab-custom", createXtermTerminal);

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
    expect(recreated.portalElement.className).toBe("absolute inset-0 pointer-events-auto");
    expect(useTerminalPortalStore.getState().getTerminal(NODE, "env-custom", "tab-custom")).toBe(
      recreated,
    );
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

    const recreated = useTerminalPortalStore
      .getState()
      .recreateTerminal(NODE, "env-error", "tab-error", createXtermTerminal);

    expect(recreated).not.toBeNull();
    expect(recreated?.containerId).toBeNull();
    expect(recreated?.terminal.options.fontFamily).toStartWith(
      `"${DEFAULT_TERMINAL_APPEARANCE.fontFamily}"`,
    );
    expect(recreated?.terminal.options.fontSize).toBe(DEFAULT_TERMINAL_APPEARANCE.fontSize);
    expect(recreated?.terminal.options.theme?.background).toBe(
      DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
    );
    expect(recreated?.terminal.options.scrollback).toBe(DEFAULT_TERMINAL_SCROLLBACK);
  });
});

describe("node-qualified keys", () => {
  const NODE_A = "bk_node-a" as BackendId;
  const NODE_B = "bk_node-b" as BackendId;
  let windowScope: WindowScope | null = null;

  afterEach(() => {
    windowScope?.dispose();
    windowScope = null;
  });

  function openTwoNodes() {
    windowScope = new WindowScope();
    const a = windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) });
    const b = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });
    return { a, b };
  }

  function terminalOn(nodeId: BackendId): PersistentTerminalData {
    // Same environment, tab and container on both nodes: the ids are node-local.
    return useTerminalPortalStore
      .getState()
      .createTerminal(
        { nodeId, tabId: "default", environmentId: "env-1", containerId: "container-1" },
        createXtermTerminal,
      );
  }

  test("two nodes with the same container-derived key get two portals", () => {
    const { a, b } = openTwoNodes();
    const onA = terminalOn(bindTerminalPortalsToScope(a));
    const onB = terminalOn(bindTerminalPortalsToScope(b));
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    useTerminalPortalStore.getState().registerPaneHost(NODE_A, "env-1", "default", hostA);
    useTerminalPortalStore.getState().registerPaneHost(NODE_B, "env-1", "default", hostB);

    expect(onA).not.toBe(onB);
    expect(onA.portalElement).not.toBe(onB.portalElement);
    expect(onA.nodeId).toBe(NODE_A);
    expect(onB.nodeId).toBe(NODE_B);
    expect(useTerminalPortalStore.getState().terminals.size).toBe(2);
    expect(useTerminalPortalStore.getState().getTerminal(NODE_A, "env-1", "default")).toBe(onA);
    expect(useTerminalPortalStore.getState().getTerminal(NODE_B, "env-1", "default")).toBe(onB);
    expect(useTerminalPortalStore.getState().getPaneHost(NODE_A, "env-1", "default")).toBe(hostA);
    expect(useTerminalPortalStore.getState().getPaneHost(NODE_B, "env-1", "default")).toBe(hostB);
    expect(createTerminalKey(NODE_A, "env-1", "default")).toBe("bk_node-a\u0000env-1::default");
    expect(createPortalTargetKey(NODE_B, "env-1", "default")).toBe("bk_node-b\u0000env-1::default");
  });

  test("disposing one node's scope releases only its own terminals and pane hosts", () => {
    const { a, b } = openTwoNodes();
    const onA = terminalOn(bindTerminalPortalsToScope(a));
    const onB = terminalOn(bindTerminalPortalsToScope(b));
    // Binding twice registers one release.
    bindTerminalPortalsToScope(b);
    const disposeA = mock(() => undefined);
    const disposeB = mock(() => undefined);
    onA.terminal.dispose = disposeA;
    onB.terminal.dispose = disposeB;
    const parent = document.createElement("div");
    parent.appendChild(onB.portalElement);
    useTerminalPortalStore
      .getState()
      .registerPaneHost(NODE_A, "env-1", "default", document.createElement("div"));
    useTerminalPortalStore
      .getState()
      .registerPaneHost(NODE_B, "env-1", "default", document.createElement("div"));

    b.dispose();

    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(disposeA).not.toHaveBeenCalled();
    expect(parent.childElementCount).toBe(0);
    expect(useTerminalPortalStore.getState().hasTerminal(NODE_B, "env-1", "default")).toBe(false);
    expect(useTerminalPortalStore.getState().getTerminal(NODE_A, "env-1", "default")).toBe(onA);
    expect(
      useTerminalPortalStore.getState().getPaneHost(NODE_B, "env-1", "default"),
    ).toBeUndefined();
    expect(useTerminalPortalStore.getState().getPaneHost(NODE_A, "env-1", "default")).toBeDefined();
  });

  test("clearing one node's environment leaves the same environment id on another node", () => {
    terminalOn(NODE_A);
    const onB = terminalOn(NODE_B);

    useTerminalPortalStore.getState().clearTerminalsForEnvironment(NODE_A, "env-1");

    expect(useTerminalPortalStore.getState().terminals).toEqual(
      new Map([[createTerminalKey(NODE_B, "env-1", "default"), onB]]),
    );
  });

  test("a producer keys by its node scope and is released when that scope is disposed", () => {
    const host = document.createElement("div");
    const seen: BackendId[] = [];
    function PaneHostProbe() {
      const nodeId = useTerminalPortalNodeId();
      useLayoutEffect(() => {
        seen.push(nodeId);
        useTerminalPortalStore.getState().registerPaneHost(nodeId, "env-1", "default", host);
      }, [nodeId]);
      return null;
    }

    const { scope } = renderInNodeScope(createElement(PaneHostProbe), {
      nodeId: NODE_B,
      role: "leaf",
    });

    expect(seen).toEqual([NODE_B]);
    expect(useTerminalPortalStore.getState().getPaneHost(NODE_B, "env-1", "default")).toBe(host);
    scope.dispose();
    expect(
      useTerminalPortalStore.getState().getPaneHost(NODE_B, "env-1", "default"),
    ).toBeUndefined();
  });
});
