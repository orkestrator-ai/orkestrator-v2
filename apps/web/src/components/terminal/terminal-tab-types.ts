import type { TerminalTabType } from "@/contexts";
import type { TabInfo } from "@/types/paneLayout";

// Terminal tab types that need PersistentTerminal instances.
// Using an allowlist ensures new non-terminal TabType variants don't accidentally spawn PTY sessions.
const TERMINAL_TAB_TYPES: ReadonlySet<string> = new Set<TerminalTabType>([
  "plain",
  "claude",
  "opencode",
  "codex",
  "cursor",
  "grok",
  "pi",
  "root",
]);

export function isTerminalTab(tab: Pick<TabInfo, "type">): boolean {
  return TERMINAL_TAB_TYPES.has(tab.type);
}
