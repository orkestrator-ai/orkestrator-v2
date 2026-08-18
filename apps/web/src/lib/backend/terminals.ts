import { invoke } from "@/lib/native/backend";
import type { TabTeardownInput } from "@orkestrator/protocol/tab-teardown";
import type { EnvironmentSetupSession } from "@/types";
import { parseTerminalSessionCreateResult, type TerminalSessionCreateResult } from "./shared";
export type { TerminalSessionCreateResult } from "./shared";
/** PR detection result containing URL, state, and merge conflict status */

export async function attachTerminal(
  containerId: string,
  cols: number,
  rows: number,
): Promise<string> {
  return invoke<string>("attach_terminal", { containerId, cols, rows });
}

export async function createTerminalSession(
  containerId: string,
  cols: number,
  rows: number,
  user?: string,
  trackEnvironmentActivity = false,
  environmentId?: string,
  terminalKey?: string,
): Promise<TerminalSessionCreateResult> {
  const result = await invoke<unknown>("create_terminal_session", {
    containerId,
    cols,
    rows,
    user,
    trackEnvironmentActivity,
    environmentId,
    terminalKey,
  });
  return parseTerminalSessionCreateResult(result);
}

export async function startTerminalSession(sessionId: string): Promise<void> {
  return invoke("start_terminal_session", { sessionId });
}

export interface TerminalSessionStatus {
  id: string;
  running: boolean;
  bootstrapped?: boolean;
}

export interface BootstrapTerminalResult {
  bootstrapped: boolean;
  delivered: boolean;
  duplicate: boolean;
}

export async function bootstrapTerminalSession(
  sessionId: string,
  data: string,
): Promise<BootstrapTerminalResult> {
  return invoke<BootstrapTerminalResult>("bootstrap_terminal_session", {
    sessionId,
    data,
  });
}

export async function getTerminalSession(sessionId: string): Promise<TerminalSessionStatus> {
  return invoke<TerminalSessionStatus>("get_terminal_session", { sessionId });
}

export async function getTerminalOutputBuffer(sessionId: string): Promise<string> {
  return invoke<string>("get_terminal_output_buffer", { sessionId });
}

export interface TerminalOutputSnapshot {
  mode?: "full" | "delta";
  reason?: "expired" | "generation-changed";
  output: string;
  revision: number;
  generation: number;
  truncated: boolean;
}

export interface TerminalOutputEvent {
  text: string;
  revision: number;
  generation: number;
}

export async function getTerminalOutputSnapshot(
  sessionId: string,
  cursor?: { revision: number; generation: number },
): Promise<TerminalOutputSnapshot> {
  const value = await invoke<unknown>("get_terminal_output_snapshot", {
    sessionId,
    ...(cursor ? { sinceRevision: cursor.revision, sinceGeneration: cursor.generation } : {}),
  });
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { output?: unknown }).output !== "string" ||
    !Number.isSafeInteger((value as { revision?: unknown }).revision) ||
    (value as { revision: number }).revision < 0 ||
    !Number.isSafeInteger((value as { generation?: unknown }).generation) ||
    (value as { generation: number }).generation < 0 ||
    ((value as { truncated?: unknown }).truncated !== undefined &&
      typeof (value as { truncated?: unknown }).truncated !== "boolean")
  ) {
    throw new Error("Backend returned an invalid terminal output snapshot");
  }
  return {
    mode: (value as { mode?: "full" | "delta" }).mode,
    reason: (value as { reason?: "expired" | "generation-changed" }).reason,
    output: (value as { output: string }).output,
    revision: (value as { revision: number }).revision,
    generation: (value as { generation: number }).generation,
    // Accept older desktop backends during rolling upgrades.
    truncated: (value as { truncated?: boolean }).truncated ?? false,
  };
}

export async function awaitEnvironmentSetupSession(
  environmentId: string,
  timeoutMs = 15_000,
): Promise<EnvironmentSetupSession | null> {
  return invoke<EnvironmentSetupSession | null>("await_environment_setup_session", {
    environmentId,
    timeoutMs,
  });
}

export async function detachTerminal(sessionId: string): Promise<void> {
  return invoke("detach_terminal", { sessionId });
}

export async function teardownTab(input: TabTeardownInput): Promise<{ completed: boolean }> {
  return invoke("teardown_tab", { ...input });
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  return invoke("terminal_write", { sessionId, data });
}

export async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke("terminal_resize", { sessionId, cols, rows });
}

// --- Configuration Commands ---
