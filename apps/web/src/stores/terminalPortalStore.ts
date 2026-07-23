import { create } from "zustand";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openInBrowser } from "@/lib/backend";
import { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_SCROLLBACK } from "@/constants/terminal";
import {
  getTerminalLinkTarget,
  requestTerminalBrowserTab,
} from "@/lib/terminal-links";

/**
 * Data for a persistent terminal instance that survives tab moves.
 * The terminal is created once and rendered via portal to different panes.
 */
export interface PersistentTerminalData {
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

export function createPortalTargetKey(environmentId: string, paneId: string): string {
  return `${environmentId}::${paneId}`;
}

/**
 * Create a unique key for a terminal instance.
 * Includes environmentId to prevent conflicts when switching environments.
 */
export function createTerminalKey(environmentId: string, tabId: string): string {
  return `${environmentId}::${tabId}`;
}

/**
 * Create terminal options
 */
export interface CreateTerminalOptions {
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
 */
interface TerminalPortalState {
  /** Map of environment+pane key -> DOM element (pane host) */
  paneHosts: Map<string, HTMLDivElement>;

  /** Map of environmentId::tabId -> persistent terminal data */
  terminals: Map<string, PersistentTerminalData>;

  /** Register a pane host element for terminal targets */
  registerPaneHost: (environmentId: string, paneId: string, element: HTMLDivElement) => void;

  /** Unregister a pane host element */
  unregisterPaneHost: (environmentId: string, paneId: string) => void;

  /** Get a pane host element */
  getPaneHost: (environmentId: string, paneId: string) => HTMLDivElement | undefined;

  /** Create a new persistent terminal instance */
  createTerminal: (options: CreateTerminalOptions) => PersistentTerminalData;

  /** Get a terminal by environment and tab ID */
  getTerminal: (environmentId: string, tabId: string) => PersistentTerminalData | undefined;

  /** Check if a terminal exists for an environment and tab */
  hasTerminal: (environmentId: string, tabId: string) => boolean;

  /** Update which pane a terminal is rendered in */
  setTerminalPane: (environmentId: string, tabId: string, paneId: string) => void;

  /** Dispose a terminal when tab is closed */
  disposeTerminal: (environmentId: string, tabId: string) => void;

  /** Clear all terminals for an environment (e.g., when container stops) */
  clearTerminalsForEnvironment: (environmentId: string) => void;

  /** Clear all terminals (e.g., on app shutdown) */
  clearAllTerminals: () => void;

  /** Mark a terminal as opened (attached to DOM) */
  markTerminalOpened: (environmentId: string, tabId: string) => void;

  /** Set the container element for a terminal */
  setTerminalContainer: (environmentId: string, tabId: string, element: HTMLDivElement) => void;

  /** Recreate a terminal when its DOM structure is lost (e.g., after being detached too long) */
  recreateTerminal: (environmentId: string, tabId: string) => PersistentTerminalData | null;
}

/**
 * Create xterm.js Terminal with all addons configured.
 */
function createXtermTerminal(
  appearance: {
    fontFamily?: string;
    fontSize?: number;
    backgroundColor?: string;
  },
  scrollback: number | undefined,
  linkSource: Pick<CreateTerminalOptions, "environmentId" | "tabId">,
): { terminal: Terminal; fitAddon: FitAddon; serializeAddon: SerializeAddon; webLinksAddon: WebLinksAddon } {
  const {
    fontFamily = DEFAULT_TERMINAL_APPEARANCE.fontFamily,
    fontSize = DEFAULT_TERMINAL_APPEARANCE.fontSize,
    backgroundColor = DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
  } = appearance;

  const scrollbackLines =
    typeof scrollback === "number" && scrollback > 0
      ? scrollback
      : DEFAULT_TERMINAL_SCROLLBACK;

  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: "block",
    fontFamily: `"${fontFamily}", "Fira Code", "Menlo", "DejaVu Sans Mono", "Courier New", monospace`,
    fontSize,
    lineHeight: 1.2,
    scrollback: scrollbackLines,
    theme: {
      background: backgroundColor,
      foreground: "#e4e4e7",
      cursor: "#e4e4e7",
      cursorAccent: backgroundColor,
      selectionBackground: "#4b4b4b",
      black: "#1e1e1e",
      red: "#f87171",
      green: "#4ade80",
      yellow: "#facc15",
      blue: "#60a5fa",
      magenta: "#c084fc",
      cyan: "#22d3ee",
      white: "#e4e4e7",
      brightBlack: "#71717a",
      brightRed: "#fca5a5",
      brightGreen: "#86efac",
      brightYellow: "#fde047",
      brightBlue: "#93c5fd",
      brightMagenta: "#d8b4fe",
      brightCyan: "#67e8f9",
      brightWhite: "#f4f4f5",
    },
  });

  const fitAddon = new FitAddon();
  const serializeAddon = new SerializeAddon();
  const webLinksAddon = new WebLinksAddon((event: MouseEvent, uri: string) => {
    const target = getTerminalLinkTarget(event);
    if (target === "browser-tab") {
      requestTerminalBrowserTab({
        environmentId: linkSource.environmentId,
        sourceTabId: linkSource.tabId,
        url: uri,
      });
      return;
    }
    if (target === "external") {
      void openInBrowser(uri).catch((err) => {
        console.error("[terminalPortalStore] Failed to open URL:", err);
      });
    }
  });

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(webLinksAddon);

  return { terminal, fitAddon, serializeAddon, webLinksAddon };
}

export const useTerminalPortalStore = create<TerminalPortalState>((set, get) => ({
  paneHosts: new Map(),
  terminals: new Map(),

  registerPaneHost: (environmentId: string, paneId: string, element: HTMLDivElement) => {
    const key = createPortalTargetKey(environmentId, paneId);
    set((state) => {
      const newHosts = new Map(state.paneHosts);
      newHosts.set(key, element);
      return { paneHosts: newHosts };
    });
  },

  unregisterPaneHost: (environmentId: string, paneId: string) => {
    const key = createPortalTargetKey(environmentId, paneId);
    set((state) => {
      const newHosts = new Map(state.paneHosts);
      newHosts.delete(key);
      return { paneHosts: newHosts };
    });
  },

  getPaneHost: (environmentId: string, paneId: string) => {
    return get().paneHosts.get(createPortalTargetKey(environmentId, paneId));
  },

  createTerminal: (options: CreateTerminalOptions) => {
    const { tabId, containerId, environmentId, appearance = {} } = options;
    const terminalKey = createTerminalKey(environmentId, tabId);

    // Check if terminal already exists
    const existing = get().terminals.get(terminalKey);
    if (existing) {
      return existing;
    }

    const { terminal, fitAddon, serializeAddon, webLinksAddon } =
      createXtermTerminal(appearance, options.scrollback, {
        environmentId,
        tabId,
      });

    const portalElement = document.createElement("div");
    portalElement.className = "absolute inset-0 pointer-events-auto";

    const terminalData: PersistentTerminalData = {
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

  getTerminal: (environmentId: string, tabId: string) => {
    const terminalKey = createTerminalKey(environmentId, tabId);
    return get().terminals.get(terminalKey);
  },

  hasTerminal: (environmentId: string, tabId: string) => {
    const terminalKey = createTerminalKey(environmentId, tabId);
    return get().terminals.has(terminalKey);
  },

  setTerminalPane: (environmentId: string, tabId: string, paneId: string) => {
    const terminalKey = createTerminalKey(environmentId, tabId);
    set((state) => {
      const existing = state.terminals.get(terminalKey);
      if (!existing) return state;

      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, { ...existing, currentPaneId: paneId });
      return { terminals: newTerminals };
    });
  },

  disposeTerminal: (environmentId: string, tabId: string) => {
    const terminalKey = createTerminalKey(environmentId, tabId);
    const terminalData = get().terminals.get(terminalKey);
    if (!terminalData) return;

    // Dispose the terminal
    terminalData.terminal.dispose();
    if (terminalData.portalElement.parentNode) {
      terminalData.portalElement.parentNode.removeChild(terminalData.portalElement);
    }

    set((state) => {
      const newTerminals = new Map(state.terminals);
      newTerminals.delete(terminalKey);
      return { terminals: newTerminals };
    });
  },

  clearTerminalsForEnvironment: (environmentId: string) => {
    const terminals = get().terminals;
    const keysToDelete: string[] = [];

    for (const [key, terminalData] of terminals) {
      if (terminalData.environmentId === environmentId) {
        terminalData.terminal.dispose();
        if (terminalData.portalElement.parentNode) {
          terminalData.portalElement.parentNode.removeChild(terminalData.portalElement);
        }
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

  clearAllTerminals: () => {
    const terminals = get().terminals;
    for (const [, terminalData] of terminals) {
      terminalData.terminal.dispose();
      if (terminalData.portalElement.parentNode) {
        terminalData.portalElement.parentNode.removeChild(terminalData.portalElement);
      }
    }
    set({ terminals: new Map() });
  },

  markTerminalOpened: (environmentId: string, tabId: string) => {
    const terminalKey = createTerminalKey(environmentId, tabId);
    set((state) => {
      const existing = state.terminals.get(terminalKey);
      if (!existing) return state;

      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, { ...existing, isOpened: true });
      return { terminals: newTerminals };
    });
  },

  setTerminalContainer: (environmentId: string, tabId: string, element: HTMLDivElement) => {
    const terminalKey = createTerminalKey(environmentId, tabId);
    set((state) => {
      const existing = state.terminals.get(terminalKey);
      if (!existing) return state;

      const newTerminals = new Map(state.terminals);
      newTerminals.set(terminalKey, { ...existing, containerElement: element });
      return { terminals: newTerminals };
    });
  },

  recreateTerminal: (environmentId: string, tabId: string) => {
    const terminalKey = createTerminalKey(environmentId, tabId);
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
    // Extract primary font family (before fallbacks added by createXtermTerminal)
    const existingFontFamily = existing.terminal.options.fontFamily;
    const primaryFont = existingFontFamily
      ? (existingFontFamily.split(",")[0]?.replace(/["']/g, "").trim() || DEFAULT_TERMINAL_APPEARANCE.fontFamily)
      : DEFAULT_TERMINAL_APPEARANCE.fontFamily;

    // Create new terminal preserving user's settings
    const { terminal, fitAddon, serializeAddon, webLinksAddon } = createXtermTerminal(
      {
        fontFamily: primaryFont,
        fontSize: existing.terminal.options.fontSize ?? DEFAULT_TERMINAL_APPEARANCE.fontSize,
        backgroundColor: existing.terminal.options.theme?.background ?? DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
      },
      existing.terminal.options.scrollback ?? DEFAULT_TERMINAL_SCROLLBACK,
      { environmentId, tabId },
    );

    // Create new portal element
    const portalElement = document.createElement("div");
    portalElement.className = "absolute inset-0 pointer-events-auto";

    const newTerminalData: PersistentTerminalData = {
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
