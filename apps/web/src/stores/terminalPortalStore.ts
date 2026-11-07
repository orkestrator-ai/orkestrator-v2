import { useLayoutEffect } from "react";
import { create } from "zustand";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_SCROLLBACK } from "@/constants/terminal";
import type { CreateXtermTerminal } from "@/lib/terminal-xterm";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";

/**
 * Data for a persistent terminal instance that survives tab moves.
 * The terminal is created once and rendered via portal to different panes.
 */
export interface PersistentTerminalData {
  /** The node whose terminal this is: tab and container ids are only unique per node. */
  nodeId: BackendId;
  /** Unique tab ID */
  tabId: string;
  /** Container ID for session scoping (null for local environments) */
  containerId: string | null;
  /** Environment ID */
  environmentId: string;
  /** xterm.js Terminal instance */
  terminal: Terminal;
  /** FitAddon for resizing */
  fitAddon: FitAddon;
  /** SerializeAddon for buffer serialization (still needed for persistence) */
  serializeAddon: SerializeAddon;
  /** WebLinksAddon for clickable links */
  webLinksAddon: WebLinksAddon;
  /** Stable portal target for rendering this terminal */
  portalElement: HTMLDivElement;
  /** Container div for the terminal (created on first render) */
  containerElement: HTMLDivElement | null;
  /** Current pane ID where terminal is rendered */
  currentPaneId: string | null;
  /** Whether the terminal has been opened (attached to DOM) */
  isOpened: boolean;
}

/**
 * Keys are `{ nodeId, key }` encoded as `${nodeId}\u0000${key}` (report §5.1:
 * the terminal DOM registry is window-owned, keyed by node-qualified terminal
 * key). Environment, pane and tab ids are node-local (the default pane is
 * `"default"` on every node), so the same key on two nodes names two terminals.
 */
function nodeQualifiedKey(nodeId: BackendId, key: string): string {
  return `${nodeId}\u0000${key}`;
}

export function createPortalTargetKey(
  nodeId: BackendId,
  environmentId: string,
  paneId: string,
): string {
  return nodeQualifiedKey(nodeId, `${environmentId}::${paneId}`);
}

/**
 * Create a unique key for a terminal instance.
 * Includes the node and environmentId to prevent conflicts across nodes and environments.
 */
export function createTerminalKey(nodeId: BackendId, environmentId: string, tabId: string): string {
  return nodeQualifiedKey(nodeId, `${environmentId}::${tabId}`);
}

/**
 * Create terminal options
 */
export interface CreateTerminalOptions {
  nodeId: BackendId;
  tabId: string;
  containerId: string | null;
  environmentId: string;
  appearance?: {
    fontFamily?: string;
    fontSize?: number;
    backgroundColor?: string;
  };
  scrollback?: number;
}

/**
 * Store for managing persistent terminal instances and portal targets.
 *
 * This store enables instant tab moves by keeping xterm.js Terminal instances
 * alive and using React portals to render them into different panes without
 * destroying and recreating them.
 *
 * It is window-owned (one per renderer, like the DOM it holds), not a
 * per-node scoped store; every key names its node instead. Producers pass
 * their node scope's id (`useTerminalPortalNodeId`), and disposing a node
 * scope releases that node's terminals and pane hosts
 * (`bindTerminalPortalsToScope`).
 */
export interface TerminalPortalState {
  /** Map of node-qualified environment+pane key -> DOM element (pane host) */
  paneHosts: Map<string, HTMLDivElement>;

  /** Map of node-qualified environmentId::tabId -> persistent terminal data */
  terminals: Map<string, PersistentTerminalData>;

  /** Register a pane host element for terminal targets */
  registerPaneHost: (
    nodeId: BackendId,
    environmentId: string,
    paneId: string,
    element: HTMLDivElement,
  ) => void;

  /** Unregister a pane host element */
  unregisterPaneHost: (nodeId: BackendId, environmentId: string, paneId: string) => void;

  /** Get a pane host element */
  getPaneHost: (
    nodeId: BackendId,
    environmentId: string,
    paneId: string,
  ) => HTMLDivElement | undefined;

  /**
   * Create a new persistent terminal instance. The caller passes the xterm
   * factory so that this store, which the pane layout loads at startup, does
   * not bring xterm.js with it.
   */
  createTerminal: (
    options: CreateTerminalOptions,
    createXterm: CreateXtermTerminal,
  ) => PersistentTerminalData;

  /** Get a terminal by environment and tab ID */
  getTerminal: (
    nodeId: BackendId,
    environmentId: string,
    tabId: string,
  ) => PersistentTerminalData | undefined;

  /** Check if a terminal exists for an environment and tab */
  hasTerminal: (nodeId: BackendId, environmentId: string, tabId: string) => boolean;

  /** Update which pane a terminal is rendered in */
  setTerminalPane: (
    nodeId: BackendId,
    environmentId: string,
    tabId: string,
    paneId: string,
  ) => void;

  /** Dispose a terminal when tab is closed */
  disposeTerminal: (nodeId: BackendId, environmentId: string, tabId: string) => void;

  /** Clear all terminals for an environment of one node (e.g., when container stops) */
  clearTerminalsForEnvironment: (nodeId: BackendId, environmentId: string) => void;

  /** Dispose every terminal and forget every pane host of one node (its scope was disposed). */
  clearTerminalsForNode: (nodeId: BackendId) => void;

  /** Clear all terminals (e.g., on app shutdown) */
  clearAllTerminals: () => void;

  /** Mark a terminal as opened (attached to DOM) */
  markTerminalOpened: (nodeId: BackendId, environmentId: string, tabId: string) => void;

  /** Set the container element for a terminal */
  setTerminalContainer: (
    nodeId: BackendId,
    environmentId: string,
    tabId: string,
    element: HTMLDivElement,
  ) => void;

  /** Recreate a terminal when its DOM structure is lost (e.g., after being detached too long) */
  recreateTerminal: (
    nodeId: BackendId,
    environmentId: string,
    tabId: string,
    createXterm: CreateXtermTerminal,
  ) => PersistentTerminalData | null;
}

function releaseTerminalDom(terminalData: PersistentTerminalData): void {
  terminalData.terminal.dispose();
  if (terminalData.portalElement.parentNode) {
    terminalData.portalElement.parentNode.removeChild(terminalData.portalElement);
  }
}

export const useTerminalPortalStore = create<TerminalPortalState>((set, get) => ({
  paneHosts: new Map(),
  terminals: new Map(),

  registerPaneHost: (nodeId, environmentId, paneId, element) => {
    const key = createPortalTargetKey(nodeId, environmentId, paneId);
    set((state) => {
      const newHosts = new Map(state.paneHosts);
      newHosts.set(key, element);
      return { paneHosts: newHosts };
    });
  },

  unregisterPaneHost: (nodeId, environmentId, paneId) => {
    const key = createPortalTargetKey(nodeId, environmentId, paneId);
    set((state) => {
      const newHosts = new Map(state.paneHosts);
      newHosts.delete(key);
      return { paneHosts: newHosts };
    });
  },

  getPaneHost: (nodeId, environmentId, paneId) => {
    return get().paneHosts.get(createPortalTargetKey(nodeId, environmentId, paneId));
  },

  createTerminal: (options: CreateTerminalOptions, createXterm: CreateXtermTerminal) => {
    const { nodeId, tabId, containerId, environmentId, appearance = {} } = options;
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);

    // Check if terminal already exists
    const existing = get().terminals.get(terminalKey);
    if (existing) {
      return existing;
    }

    const { terminal, fitAddon, serializeAddon, webLinksAddon } = createXterm(
      appearance,
      options.scrollback,
      { environmentId, tabId, nodeId },
    );

    const portalElement = document.createElement("div");
    portalElement.className = "absolute inset-0 pointer-events-auto";

    const terminalData: PersistentTerminalData = {
      nodeId,
      tabId,
      containerId,
      environmentId,
      terminal,
      fitAddon,
      serializeAddon,
      webLinksAddon,
      portalElement,
      containerElement: null,
      currentPaneId: null,
      isOpened: false,
    };

    set((state) => {
      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, terminalData);
      return { terminals: newTerminals };
    });

    return terminalData;
  },

  getTerminal: (nodeId, environmentId, tabId) => {
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);
    return get().terminals.get(terminalKey);
  },

  hasTerminal: (nodeId, environmentId, tabId) => {
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);
    return get().terminals.has(terminalKey);
  },

  setTerminalPane: (nodeId, environmentId, tabId, paneId) => {
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);
    set((state) => {
      const existing = state.terminals.get(terminalKey);
      if (!existing) return state;

      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, { ...existing, currentPaneId: paneId });
      return { terminals: newTerminals };
    });
  },

  disposeTerminal: (nodeId, environmentId, tabId) => {
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);
    const terminalData = get().terminals.get(terminalKey);
    if (!terminalData) return;

    releaseTerminalDom(terminalData);

    set((state) => {
      const newTerminals = new Map(state.terminals);
      newTerminals.delete(terminalKey);
      return { terminals: newTerminals };
    });
  },

  clearTerminalsForEnvironment: (nodeId, environmentId) => {
    const terminals = get().terminals;
    const keysToDelete: string[] = [];

    for (const [key, terminalData] of terminals) {
      if (terminalData.nodeId === nodeId && terminalData.environmentId === environmentId) {
        releaseTerminalDom(terminalData);
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      set((state) => {
        const newTerminals = new Map(state.terminals);
        for (const key of keysToDelete) {
          newTerminals.delete(key);
        }
        return { terminals: newTerminals };
      });
    }
  },

  clearTerminalsForNode: (nodeId) => {
    const { terminals, paneHosts } = get();
    const terminalKeys: string[] = [];
    for (const [key, terminalData] of terminals) {
      if (terminalData.nodeId !== nodeId) continue;
      releaseTerminalDom(terminalData);
      terminalKeys.push(key);
    }
    const prefix = nodeQualifiedKey(nodeId, "");
    const hostKeys = Array.from(paneHosts.keys()).filter((key) => key.startsWith(prefix));
    if (terminalKeys.length === 0 && hostKeys.length === 0) return;
    set((state) => {
      const nextTerminals = new Map(state.terminals);
      for (const key of terminalKeys) nextTerminals.delete(key);
      const nextHosts = new Map(state.paneHosts);
      for (const key of hostKeys) nextHosts.delete(key);
      return { terminals: nextTerminals, paneHosts: nextHosts };
    });
  },

  clearAllTerminals: () => {
    const terminals = get().terminals;
    for (const [, terminalData] of terminals) {
      releaseTerminalDom(terminalData);
    }
    set({ terminals: new Map() });
  },

  markTerminalOpened: (nodeId, environmentId, tabId) => {
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);
    set((state) => {
      const existing = state.terminals.get(terminalKey);
      if (!existing) return state;

      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, { ...existing, isOpened: true });
      return { terminals: newTerminals };
    });
  },

  setTerminalContainer: (nodeId, environmentId, tabId, element) => {
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);
    set((state) => {
      const existing = state.terminals.get(terminalKey);
      if (!existing) return state;

      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, { ...existing, containerElement: element });
      return { terminals: newTerminals };
    });
  },

  recreateTerminal: (nodeId, environmentId, tabId, createXterm) => {
    const terminalKey = createTerminalKey(nodeId, environmentId, tabId);
    const existing = get().terminals.get(terminalKey);

    if (!existing) {
      return null;
    }

    // Dispose the old terminal
    try {
      existing.terminal.dispose();
    } catch {
      // Ignore disposal errors
    }

    // Remove old portal element from DOM if attached
    if (existing.portalElement.parentNode) {
      existing.portalElement.parentNode.removeChild(existing.portalElement);
    }

    // Preserve terminal settings from existing terminal
    // Extract primary font family (before fallbacks added by the xterm factory)
    const existingFontFamily = existing.terminal.options.fontFamily;
    const primaryFont = existingFontFamily
      ? existingFontFamily.split(",")[0]?.replace(/["']/g, "").trim() ||
        DEFAULT_TERMINAL_APPEARANCE.fontFamily
      : DEFAULT_TERMINAL_APPEARANCE.fontFamily;

    // Create new terminal preserving user's settings
    const { terminal, fitAddon, serializeAddon, webLinksAddon } = createXterm(
      {
        fontFamily: primaryFont,
        fontSize: existing.terminal.options.fontSize ?? DEFAULT_TERMINAL_APPEARANCE.fontSize,
        backgroundColor:
          existing.terminal.options.theme?.background ??
          DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
      },
      existing.terminal.options.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK,
      { environmentId, tabId, nodeId },
    );

    // Create new portal element
    const portalElement = document.createElement("div");
    portalElement.className = "absolute inset-0 pointer-events-auto";

    const newTerminalData: PersistentTerminalData = {
      nodeId,
      tabId,
      containerId: existing.containerId,
      environmentId,
      terminal,
      fitAddon,
      serializeAddon,
      webLinksAddon,
      portalElement,
      containerElement: null, // Will be set when terminal is opened
      currentPaneId: existing.currentPaneId,
      isOpened: false, // Reset to false so it will be opened fresh
    };

    set((state) => {
      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, newTerminalData);
      return { terminals: newTerminals };
    });

    return newTerminalData;
  },
}));

const boundScopes = new WeakSet<NodeScope>();

/**
 * Releases `scope`'s terminals and pane hosts when the scope is disposed.
 * Idempotent per scope; returns the scope's node id, the id its terminals are
 * keyed by.
 */
export function bindTerminalPortalsToScope(scope: NodeScope): BackendId {
  if (!scope.disposed && !boundScopes.has(scope)) {
    boundScopes.add(scope);
    const nodeId = scope.nodeId;
    scope.onDispose("terminal-portals", () =>
      useTerminalPortalStore.getState().clearTerminalsForNode(nodeId),
    );
  }
  return scope.nodeId;
}

/**
 * The node id a terminal producer (a pane host, the portal host) keys its
 * terminals by: the nearest node scope's, else the command scope's. Binds
 * that scope so disposing it releases what it registered.
 */
export function useTerminalPortalNodeId(): BackendId {
  const { scope } = useScopesWithCommandFallback();
  // Before the producer's own layout effects, which register into the store.
  useLayoutEffect(() => {
    bindTerminalPortalsToScope(scope);
  }, [scope]);
  return scope.nodeId;
}

/**
 * The node id of terminals owned by this window's command scope. For callers
 * that act on the command node's pane layout and have no scope of their own
 * yet (`paneLayoutStore` until plan item 3013).
 */
export function commandTerminalPortalNodeId(): BackendId {
  return getWindowScope().commandScope().nodeId;
}
