/**
 * Where ⌘-click (Ctrl-click) on a terminal link opens: the user's own browser
 * or an Orkestrator preview tab. ⌘⇧-click (Ctrl+Shift-click) opens the other.
 */
export const TERMINAL_LINK_DEFAULT_TARGETS = ["external", "browser-tab"] as const;

export type TerminalLinkDefaultTarget = (typeof TERMINAL_LINK_DEFAULT_TARGETS)[number];

export const DEFAULT_TERMINAL_LINK_TARGET: TerminalLinkDefaultTarget = "external";

export function isTerminalLinkDefaultTarget(value: unknown): value is TerminalLinkDefaultTarget {
  return (TERMINAL_LINK_DEFAULT_TARGETS as readonly unknown[]).includes(value);
}

export function resolveTerminalLinkDefaultTarget(value: unknown): TerminalLinkDefaultTarget {
  return isTerminalLinkDefaultTarget(value) ? value : DEFAULT_TERMINAL_LINK_TARGET;
}
