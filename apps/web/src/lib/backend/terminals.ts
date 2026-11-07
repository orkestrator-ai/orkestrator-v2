import { incompatibility } from "@orkestrator/protocol/contract/errors";
import {
  isTerminalHistoryPage,
  isTerminalStateSnapshot,
  type TerminalHistoryPage,
  type TerminalStateSnapshot,
} from "@orkestrator/protocol/terminal-history";
import type { TabTeardownInput } from "@orkestrator/protocol/tab-teardown";
import {
  LOCAL_TERMINAL_INPUT_RESUME_COMMAND,
  TERMINAL_INPUT_RESUME_COMMAND,
  type TerminalInputResumeResult,
} from "@orkestrator/protocol/terminal-input-sequencer";
import type { EnvironmentSetupSession } from "@/types";
import {
  parseTerminalSessionCreateResult,
  terminalWriteWasDelivered,
  type TerminalSessionCreateResult,
} from "./shared";
import { InvalidCommandResultError } from "@orkestrator/protocol/contract/command";
import { environmentsClient } from "@orkestrator/protocol/contract/domains/environments";
import { clientInvoke, commandBackendClient, type BackendClient } from "./client";
import { terminals } from "@/lib/node-scope/domains/terminals";
import type { ResultOf } from "@orkestrator/protocol/contract/command";
import type {
  bootstrapTerminalSessionCommand,
  getTerminalSessionCommand,
  launchTerminalJobCommand,
} from "@orkestrator/protocol/contract/domains/terminals";
import { domainApi } from "@/lib/node-scope/domains/domain-api";
export type { TerminalSessionCreateResult } from "./shared";
/** PR detection result containing URL, state, and merge conflict status */

export interface ClaudeTerminalStateSnapshot {
  state: string;
  occurredAt: string;
}

// The `terminals` domain's result types (plan item 7002), inferred from the
// protocol definitions rather than restated here.
export type TerminalSessionStatus = ResultOf<typeof getTerminalSessionCommand>;
export type BootstrapTerminalResult = ResultOf<typeof bootstrapTerminalSessionCommand>;
export type TerminalJobLaunchResult = ResultOf<typeof launchTerminalJobCommand>;

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

export type {
  TerminalHistoryPage,
  TerminalStateSnapshot,
} from "@orkestrator/protocol/terminal-history";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createTerminalsApi(client: BackendClient) {
  const invoke = clientInvoke(client);
  // The `terminals` domain client (plan item 7002): typed results, and the
  // envelope for a node that advertises the domain.
  const domain = () => terminals(client);
  // The `environments` domain's commands here (plan item 7003).
  const environments = () => domainApi(client, environmentsClient);

  /**
   * The persisted Claude tmux state for a container, or null when none has been
   * observed. Live `claude-state-*` events only fire on change, so this is what a
   * tab reads after the event stream reports it may have missed one.
   */
  async function getClaudeTerminalState(
    containerId: string,
  ): Promise<ClaudeTerminalStateSnapshot | null> {
    let snapshot: ClaudeTerminalStateSnapshot | null;
    try {
      snapshot = await environments().getClaudeTerminalState({ containerId });
    } catch (error) {
      // A malformed answer reads as "none observed": decoded (version 1) or not.
      if (error instanceof InvalidCommandResultError) return null;
      throw error;
    }
    return snapshot && typeof snapshot.state === "string" && typeof snapshot.occurredAt === "string"
      ? snapshot
      : null;
  }

  async function attachTerminal(containerId: string, cols: number, rows: number): Promise<string> {
    return domain().attach_terminal({ containerId, cols, rows });
  }

  async function createTerminalSession(
    containerId: string,
    cols: number,
    rows: number,
    user?: string,
    trackEnvironmentActivity = false,
    environmentId?: string,
    terminalKey?: string,
  ): Promise<TerminalSessionCreateResult> {
    const result = await domain().create_terminal_session({
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

  async function startTerminalSession(sessionId: string): Promise<void> {
    await domain().start_terminal_session({ sessionId });
  }

  async function launchTerminalJob(input: {
    requestId: string;
    environmentId: string;
    tabId?: string;
    tabType: "plain" | "claude" | "codex" | "grok" | "opencode" | "pi" | "claude-tmux";
    data?: string;
    initialPrompt?: string;
    title?: string;
    model?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    activateTab?: boolean;
  }): Promise<TerminalJobLaunchResult> {
    return domain().launch_terminal_job(input);
  }

  async function bootstrapTerminalSession(
    sessionId: string,
    data: string,
  ): Promise<BootstrapTerminalResult> {
    return domain().bootstrap_terminal_session({ sessionId, data });
  }

  async function getTerminalSession(sessionId: string): Promise<TerminalSessionStatus> {
    return domain().get_terminal_session({ sessionId });
  }

  async function getTerminalOutputBuffer(sessionId: string): Promise<string> {
    return domain().get_terminal_output_buffer({ sessionId });
  }

  async function getTerminalStateSnapshot(
    sessionId: string,
  ): Promise<TerminalStateSnapshot | null> {
    // The schema gives the shape; the guard keeps its byte and range bounds.
    const value: unknown = await domain().get_terminal_state_snapshot({ sessionId });
    if (value === null || isTerminalStateSnapshot(value)) return value;
    throw new Error("Backend returned an invalid terminal state snapshot");
  }

  async function getTerminalHistoryPage(
    sessionId: string,
    cursor?: string,
  ): Promise<TerminalHistoryPage | null> {
    const value: unknown = await domain().get_terminal_history_page({
      sessionId,
      ...(cursor ? { cursor } : {}),
    });
    if (value === null || isTerminalHistoryPage(value)) return value;
    throw new Error("Backend returned an invalid terminal history page");
  }

  async function acknowledgeTerminalSnapshot(
    sessionId: string,
    snapshot: { generation: number; revision: number },
  ): Promise<void> {
    await domain().terminal_snapshot_applied({ sessionId, ...snapshot });
  }

  async function rejectTerminalSnapshot(sessionId: string): Promise<void> {
    await domain().terminal_snapshot_failed({ sessionId });
  }

  async function getTerminalOutputSnapshot(
    sessionId: string,
    cursor?: { revision: number; generation: number },
  ): Promise<TerminalOutputSnapshot> {
    // Not decoded in production (hot path), so the checks below stay.
    const value: unknown = await domain().get_terminal_output_snapshot({
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

  async function awaitEnvironmentSetupSession(
    environmentId: string,
    timeoutMs = 15_000,
  ): Promise<EnvironmentSetupSession | null> {
    return environments().awaitEnvironmentSetupSession({ environmentId, timeoutMs });
  }

  async function detachTerminal(sessionId: string): Promise<void> {
    await domain().detach_terminal({ sessionId });
  }

  async function teardownTab(input: TabTeardownInput): Promise<{ completed: boolean }> {
    return environments().teardownTab({ ...input });
  }

  async function writeTerminal(sessionId: string, data: string): Promise<boolean> {
    return terminalWriteWasDelivered(await domain().terminal_write({ sessionId, data }));
  }

  /**
   * Re-arms one terminal's input after a failed write, keeping the shell and its
   * processes. The client transport answers this itself; one without it rejects
   * with "Unknown backend command", which reads as nothing resumed.
   */
  async function resumeTerminalInput(
    sessionId: string,
    { local = false }: { local?: boolean } = {},
  ): Promise<boolean> {
    const command = local ? LOCAL_TERMINAL_INPUT_RESUME_COMMAND : TERMINAL_INPUT_RESUME_COMMAND;
    try {
      const result = await invoke<TerminalInputResumeResult | null>(command, { sessionId });
      return result?.resumed === true;
    } catch (error) {
      if (incompatibility(error, command)?.code === "unknown-command") return false;
      throw error;
    }
  }

  async function resizeTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
    await domain().terminal_resize({ sessionId, cols, rows });
  }

  return {
    getClaudeTerminalState,
    attachTerminal,
    createTerminalSession,
    startTerminalSession,
    launchTerminalJob,
    bootstrapTerminalSession,
    getTerminalSession,
    getTerminalOutputBuffer,
    getTerminalStateSnapshot,
    getTerminalHistoryPage,
    acknowledgeTerminalSnapshot,
    rejectTerminalSnapshot,
    getTerminalOutputSnapshot,
    awaitEnvironmentSetupSession,
    detachTerminal,
    teardownTab,
    writeTerminal,
    resumeTerminalInput,
    resizeTerminal,
  };
}

export type TerminalsApi = ReturnType<typeof createTerminalsApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getClaudeTerminalState,
  attachTerminal,
  createTerminalSession,
  startTerminalSession,
  launchTerminalJob,
  bootstrapTerminalSession,
  getTerminalSession,
  getTerminalOutputBuffer,
  getTerminalStateSnapshot,
  getTerminalHistoryPage,
  acknowledgeTerminalSnapshot,
  rejectTerminalSnapshot,
  getTerminalOutputSnapshot,
  awaitEnvironmentSetupSession,
  detachTerminal,
  teardownTab,
  writeTerminal,
  resumeTerminalInput,
  resizeTerminal,
} = createTerminalsApi(commandBackendClient);
// --- Configuration Commands ---
