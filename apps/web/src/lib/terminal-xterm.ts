import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openLinkExternally } from "@/lib/preview-link-external";
import { DEFAULT_TERMINAL_APPEARANCE, DEFAULT_TERMINAL_SCROLLBACK } from "@/constants/terminal";
import { createTerminalLinkActivator } from "@/lib/terminal-links";
import type { BackendId } from "@orkestrator/protocol/federation";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope } from "@/lib/node-scope-slots";

export type CreateXtermTerminal = (
  appearance: {
    fontFamily?: string;
    fontSize?: number;
    backgroundColor?: string;
  },
  scrollback: number | undefined,
  /** `nodeId` is the terminal's node (plan item 3013): its links act on that node's scope. */
  linkSource: { environmentId: string; tabId: string; nodeId?: BackendId },
) => {
  terminal: Terminal;
  fitAddon: FitAddon;
  serializeAddon: SerializeAddon;
  webLinksAddon: WebLinksAddon;
};

/**
 * Create xterm.js Terminal with all addons configured.
 */
export const createXtermTerminal: CreateXtermTerminal = (appearance, scrollback, linkSource) => {
  const {
    fontFamily = DEFAULT_TERMINAL_APPEARANCE.fontFamily,
    fontSize = DEFAULT_TERMINAL_APPEARANCE.fontSize,
    backgroundColor = DEFAULT_TERMINAL_APPEARANCE.backgroundColor,
  } = appearance;

  const scrollbackLines =
    typeof scrollback === "number" && scrollback > 0 ? scrollback : DEFAULT_TERMINAL_SCROLLBACK;

  // Resolved per click: the terminal outlives any one lookup, and a node
  // that is no longer open falls back to the window's own node.
  const linkScope = (): NodeScope =>
    (linkSource.nodeId ? getWindowScope().get(linkSource.nodeId) : null) ?? appCommandScope();
  const activateLink = createTerminalLinkActivator({
    environmentId: linkSource.environmentId,
    sourceTabId: linkSource.tabId,
    scope: linkScope,
    openExternal: (url) =>
      openLinkExternally({
        environmentId: linkSource.environmentId,
        sourceTabId: linkSource.tabId,
        url,
        scope: linkScope(),
      }),
  });

  const terminal = new Terminal({
    linkHandler: { activate: activateLink },
    cursorBlink: true,
    cursorStyle: "block",
    // A program with mouse reporting on (tmux `mouse on`, full-screen TUIs)
    // receives every drag. Elsewhere Shift+drag still selects; on macOS xterm
    // offers Option+drag only when this is set.
    macOptionClickForcesSelection: true,
    // Forced Option selection is linear (including in shells), not rectangular.
    // Disable Alt-click movement so short selection gestures never send arrow keys.
    altClickMovesCursor: false,
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
  const webLinksAddon = new WebLinksAddon(activateLink);

  terminal.loadAddon(fitAddon);
  terminal.loadAddon(serializeAddon);
  terminal.loadAddon(webLinksAddon);

  return { terminal, fitAddon, serializeAddon, webLinksAddon };
};
