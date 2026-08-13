export const TAB_TEARDOWN_KINDS = [
  "terminal",
  "claude-tmux",
  "claude-native",
  "opencode-native",
  "codex-native",
  "cursor-native",
  "grok-native",
] as const;

export type TabTeardownKind = (typeof TAB_TEARDOWN_KINDS)[number];

export interface TabTeardownInput {
  environmentId: string;
  tabId: string;
  kind: TabTeardownKind;
  sessionId?: string;
  persistentSessionId?: string;
}

export function isTabTeardownKind(value: unknown): value is TabTeardownKind {
  return typeof value === "string"
    && (TAB_TEARDOWN_KINDS as readonly string[]).includes(value);
}
