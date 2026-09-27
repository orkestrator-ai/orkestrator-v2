export const TAB_TEARDOWN_KINDS = [
  "terminal",
  "claude-tmux",
  "claude-native",
  "opencode-native",
  "codex-native",
  "cursor-native",
  "grok-native",
  "pi-native",
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
  return typeof value === "string" && (TAB_TEARDOWN_KINDS as readonly string[]).includes(value);
}

/** Native tab kinds whose teardown closes an agent session rather than a terminal. */
export function isNativeTabTeardownKind(kind: TabTeardownKind): boolean {
  return kind.endsWith("-native");
}

/**
 * Marker on a native teardown intent written with retain-history close
 * semantics (backend ≥ the release that introduced `POST /session/:id/close`).
 *
 * It is carried inside `sessionId` on purpose, as a downgrade fence. A backend
 * that predates retain-history close replays intents with a destructive
 * `DELETE /session/:id`, and for Claude that deletes the conversation. Every
 * such backend first checks the intent's `sessionId` against the tab's
 * persisted provider mapping and refuses the intent when they differ; with no
 * mapping, it looks for a mapping claiming that id, finds none, and clears the
 * intent without calling the provider. A fenced id therefore never matches, so
 * an older backend either leaves the intent pending (which also keeps its
 * orphan reaper away from that tab) or drops it — it never deletes history.
 */
export const RETAINING_CLOSE_SESSION_ID_PREFIX = "retain-history-close:";

/** Encode a native teardown intent's provider session id behind the downgrade fence. */
export function fenceRetainingCloseSessionId(sessionId: string | undefined): string {
  return `${RETAINING_CLOSE_SESSION_ID_PREFIX}${sessionId ?? ""}`;
}

/**
 * Decode a native teardown intent's session id. Unfenced ids come from intents
 * written before retain-history close existed; they are replayed with the same
 * non-destructive close, never with the DELETE their writer would have used.
 */
export function unfenceTabTeardownSessionId(value: string | undefined): {
  sessionId?: string;
  retainingClose: boolean;
} {
  if (value === undefined) return { retainingClose: false };
  if (!value.startsWith(RETAINING_CLOSE_SESSION_ID_PREFIX)) {
    return { sessionId: value, retainingClose: false };
  }
  const sessionId = value.slice(RETAINING_CLOSE_SESSION_ID_PREFIX.length);
  return { ...(sessionId ? { sessionId } : {}), retainingClose: true };
}

/**
 * Stable marker on a tab teardown failure caused by a bridge that predates
 * `POST /session/:id/close` and whose legacy DELETE would delete history
 * (Claude). The close stays pending until the environment runs a current
 * bridge; the renderer shows a bounded, non-destructive notice for it.
 *
 * Carried in the error message because command failures reach the renderer
 * as text (the gateway forwards `error.message`, Electron may prefix it).
 */
export const TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER =
  "TabTeardownError:bridge-upgrade-required:";

export type TabTeardownFailureKind = "bridge-upgrade-required";

/** Classify a rejected `teardown_tab` call; `null` for every other failure. */
export function tabTeardownFailureKind(error: unknown): TabTeardownFailureKind | null {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (!message) return null;
  return message.includes(TAB_TEARDOWN_BRIDGE_UPGRADE_REQUIRED_MARKER)
    ? "bridge-upgrade-required"
    : null;
}
