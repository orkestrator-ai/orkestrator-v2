import type { TabType } from "@/contexts";
import { createUuid } from "@/lib/uuid";

/** Tab types `launch_terminal_job` accepts for a PTY-backed tab. */
const LAUNCHABLE_TAB_TYPES = new Set(["plain", "claude", "codex", "grok", "opencode", "pi"]);
type LaunchableTabType = "plain" | "claude" | "codex" | "grok" | "opencode" | "pi";

export function isLaunchableTerminalTabType(tabType: TabType): tabType is LaunchableTabType {
  return LAUNCHABLE_TAB_TYPES.has(tabType);
}

type RestartBackend = {
  getTerminalSession(sessionId: string): Promise<{ running: boolean }>;
  launchTerminalJob(input: {
    requestId: string;
    environmentId: string;
    tabId: string;
    tabType: LaunchableTabType;
  }): Promise<{ sessionId?: string }>;
};

export type RestartLaunchedTerminalOutcome =
  /** The old shell is still there (or its state is unknown): attach to it. */
  | { kind: "attach" }
  /** A shell was started; reattach only when it kept the same session id. */
  | { kind: "restarted"; sessionId: string | null }
  | { kind: "failed"; message: string };

/**
 * Reconnect for a tab the backend launched (Run Commands, an agent CLI tab).
 *
 * The renderer may only attach to these tabs' shells, never create one, so
 * once the backend that owned the shell has restarted (and cleared the tab's
 * session id) or the shell has exited, plain reattaching can never succeed.
 * Ask the backend for a new shell in the same tab instead. It runs no command:
 * repeating the original one is not what Reconnect means. The backend restores
 * the tab's saved output into the new session from its terminal history.
 *
 * A failed status read is not evidence that the shell is gone, so it falls back
 * to attaching rather than replacing a shell that may still be running.
 */
export async function restartLaunchedTerminal(input: {
  backend: RestartBackend;
  environmentId: string;
  tabId: string;
  tabType: TabType;
  existingSessionId: string | null | undefined;
}): Promise<RestartLaunchedTerminalOutcome> {
  const { backend, environmentId, tabId, tabType, existingSessionId } = input;
  if (!isLaunchableTerminalTabType(tabType)) return { kind: "attach" };
  if (existingSessionId) {
    const status = await backend.getTerminalSession(existingSessionId).catch(() => null);
    if (!status || status.running) return { kind: "attach" };
  }
  try {
    const result = await backend.launchTerminalJob({
      requestId: `restart-shell-${createUuid()}`,
      environmentId,
      tabId,
      tabType,
    });
    return { kind: "restarted", sessionId: result.sessionId ?? null };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
