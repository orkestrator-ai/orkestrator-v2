import { createHash } from "node:crypto";
import { controlOnlyQuery } from "./control-only-query.js";
import type { McpServerStatus, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  NativeAgentAccountUsageWindow,
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
  NativeAgentSteerRejectedOutcome,
} from "@orkestrator/protocol/native-agent";
import { claudePlanWindowFromLabel } from "@orkestrator/protocol/plan-usage";
import { idleSteerPromptReply } from "@orkestrator/protocol/agent-slash-commands";
import { redactSecrets } from "@orkestrator/protocol/secret-redaction";
import { mcpScope } from "./mcp-runtime-status.js";
import {
  claudeExecutableOptions,
  generateMessageId,
  getStructuredUsageWithTimeout,
  PLAN_USAGE_PROBE_TIMEOUT_MS,
  persistSessionMetadata,
  rateLimitsFromStructuredUsage,
  sdkSessionIdFromBridgeId,
  sessionOperationError,
  sessions,
} from "./session-manager-core.js";
import { resetClaudeSignInForTesting } from "./claude-sign-in.js";
import { claudePermissionMode, claudeTurnPolicy } from "./claude-query-config.js";
import { eventEmitter } from "./event-emitter.js";
import { markTranscriptChanged } from "./transcript-revision.js";
import { MAX_STEER_JOURNAL_ENTRIES, updateSessionPreferences } from "./session-preferences.js";
import { idleSteerUserMessageId, recordPromptDispatch } from "./session-manager-lifecycle.js";
import { ultracodeFlagSetting } from "./ultracode.js";
import type {
  ClaudeSteerJournalEntry,
  ClaudeQueryControl,
  PermissionMode,
  SessionState,
} from "../types/index.js";

export { readClaudeAuthStatus } from "./claude-sign-in.js";

export function resetClaudeCatalogCachesForTesting(): void {
  resetClaudeSignInForTesting();
}

/**
 * The foreground or warm query, unless it is shutting down.
 *
 * A control whose stdin is closed still answers `supportedCommands` and friends
 * on paper, but the CLI is on its way out and the SDK rejects the pending
 * request the moment stdout ends. Read-only callers are better served by a
 * cached answer than by a request that cannot land.
 */
export function readableControl(session: SessionState | undefined): SessionState["queryControl"] {
  if (!session) return undefined;
  const runtime = session.claudeRuntime;
  const control =
    session.queryControl ??
    (runtime?.state === "open" && !runtime.abortController.signal.aborted
      ? runtime.control
      : undefined);
  return control === session.queryControlDraining ? undefined : control;
}

/**
 * A control request that lost a race with its own CLI exiting.
 *
 * The SDK rejects every in-flight control request with this message when the
 * transport closes. It is not a fault: the answer is simply unavailable from
 * that query, and the caller should fall back rather than surface an error.
 */
export function isClosedTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("Query closed before response received") ||
    message.includes("Query is closed") ||
    message.includes("Query has been closed")
  );
}

function rethrowUnlessClosedTransport(error: unknown): void {
  if (!isClosedTransportError(error)) throw error;
}

export type ClaudeSteerTestHooks = {
  beforePersistPrepared?: () => Promise<void>;
  afterPersistPrepared?: () => Promise<void>;
  beforePushInput?: () => Promise<void>;
  afterPushInput?: () => Promise<void>;
  beforePersistDispatched?: () => Promise<void>;
  failPersistPrepared?: boolean;
  failPersistDispatched?: boolean;
};

let steerTestHooks: ClaudeSteerTestHooks | undefined;

export function setClaudeSteerTestHooks(hooks?: ClaudeSteerTestHooks): void {
  steerTestHooks = hooks;
}

function rememberSteer(session: SessionState, entry: ClaudeSteerJournalEntry): void {
  const journal = session.steerJournal ?? new Map<string, ClaudeSteerJournalEntry>();
  journal.delete(entry.requestId);
  journal.set(entry.requestId, entry);
  while (journal.size > MAX_STEER_JOURNAL_ENTRIES) {
    const oldest = journal.keys().next().value;
    if (oldest === undefined) break;
    journal.delete(oldest);
  }
  session.steerJournal = journal;
}

function durableClaudeSessionId(session: SessionState): string | null {
  return session.sdkSessionId ?? sdkSessionIdFromBridgeId(session.id);
}

async function persistSteerJournal(session: SessionState): Promise<boolean> {
  const sdkSessionId = durableClaudeSessionId(session);
  if (!sdkSessionId || !session.steerJournal) return false;
  try {
    await updateSessionPreferences(sdkSessionId, {
      steerJournal: Array.from(session.steerJournal.values()),
    });
    return true;
  } catch {
    return false;
  }
}

export function readClaudeSteerDispatch(
  sessionId: string,
  requestId: string,
): "dispatched" | "absent" | "unknown" {
  if (requestId === "orkestrator-steer-qualification") return "unknown";
  const entry = sessions.get(sessionId)?.steerJournal?.get(requestId);
  if (entry?.state === "dispatched") return "dispatched";
  if (entry?.state === "absent" || entry?.state === "capacity-exceeded") return "absent";
  return "unknown";
}

function appendSteerUserMessage(session: SessionState, text: string, requestId: string): void {
  const existingId = `steer:${requestId}`;
  if (session.messages.some((message) => message.id === existingId)) return;
  session.splitAssistantAfterSteer?.();
  const message = {
    id: existingId,
    role: "user" as const,
    content: text,
    parts: [{ type: "text" as const, content: text }],
    createdAt: new Date().toISOString(),
  };
  session.messages.push(message);
  markTranscriptChanged(session);
  session.lastActivity = new Date();
  eventEmitter.emit({
    type: "message.updated",
    sessionId: session.id,
    data: { message },
  });
}

function idleSteerMessageIds(requestId?: string): { userId: string; assistantId: string } {
  if (!requestId) {
    return { userId: generateMessageId(), assistantId: generateMessageId() };
  }
  return {
    userId: idleSteerUserMessageId(requestId),
    assistantId: `idle-steer-reply:${requestId}`,
  };
}

export async function answerIdleSteerPrompt(
  session: SessionState,
  prompt: string,
  requestId?: string,
): Promise<string | null> {
  const reply = idleSteerPromptReply(prompt, "Claude");
  if (!reply) return null;
  const { userId, assistantId } = idleSteerMessageIds(requestId);
  if (!session.messages.some((message) => message.id === userId)) {
    const userMessage = {
      id: userId,
      role: "user" as const,
      content: prompt,
      parts: [{ type: "text" as const, content: prompt }],
      createdAt: new Date().toISOString(),
    };
    const assistantMessage = {
      id: assistantId,
      role: "assistant" as const,
      content: reply,
      parts: [{ type: "text" as const, content: reply }],
      createdAt: new Date().toISOString(),
    };
    session.messages.push(userMessage, assistantMessage);
    markTranscriptChanged(session);
    session.localTranscript = [...(session.localTranscript ?? []), userMessage, assistantMessage];
    session.lastActivity = new Date();
    eventEmitter.emit({
      type: "message.updated",
      sessionId: session.id,
      data: { message: userMessage },
    });
    eventEmitter.emit({
      type: "message.updated",
      sessionId: session.id,
      data: { message: assistantMessage },
    });
  }
  if (requestId) {
    session.dispatchedRequestIds ??= new Set();
    session.dispatchedRequestIds.add(requestId);
    recordPromptDispatch(session.id, requestId, "already-processed");
  }
  try {
    await persistSessionMetadata(session);
  } catch {
    // The in-memory pair is still visible; the next durable write retries.
  }
  return reply;
}

function createProbe(): Query {
  return controlOnlyQuery({
    cwd: process.env.CWD || process.cwd(),
    env: { ...process.env },
    ...claudeExecutableOptions(),
  });
}

function mcpTransport(status: McpServerStatus): NativeAgentMcpServer["transport"] | undefined {
  const type = (status.config as { type?: unknown } | undefined)?.type;
  if (type === "stdio" || type === "sse" || type === "http") return type;
  if ((status.config as { command?: unknown } | undefined)?.command) return "stdio";
  if ((status.config as { url?: unknown } | undefined)?.url) return "http";
  return undefined;
}

/**
 * A server's error as served to the live panel: credential-shaped text (a
 * token in a URL or header an MCP server echoed) redacted, then bounded.
 * Redacted first so a cut never leaves part of a token behind.
 */
function mcpError(error: string): string {
  return redactSecrets(error).slice(0, 2_000);
}

function normalizeMcp(status: McpServerStatus): NativeAgentMcpServer {
  const mappedStatus = status.status === "pending" ? "connecting" : status.status;
  const tools = (status.tools ?? [])
    .map((tool) => tool.name)
    .filter(Boolean)
    .slice(0, 256);
  const actions: NativeAgentMcpServerAction[] =
    status.status === "disabled"
      ? ["enable"]
      : status.status === "needs-auth"
        ? ["sign-in", "reconnect", "disable"]
        : ["reconnect", "disable"];
  const transport = mcpTransport(status);
  return {
    id: status.name,
    name: status.serverInfo?.name || status.name,
    status: mappedStatus,
    scope: mcpScope(status.scope, status.name, status.source),
    ...(transport ? { transport } : {}),
    toolCount: tools.length,
    ...(tools.length ? { tools } : {}),
    ...(status.error ? { error: mcpError(status.error) } : {}),
    actions,
  };
}

export async function readSessionMcpServers(sessionId: string): Promise<NativeAgentMcpServer[]> {
  const session = sessions.get(sessionId);
  if (!session) return [];
  const control = readableControl(session);
  if (control?.mcpServerStatus) {
    try {
      session.mcpInventory = (await control.mcpServerStatus()).slice(0, 128).map(normalizeMcp);
    } catch (error) {
      // Keep the last inventory rather than failing the read; the turn query
      // exited before it could answer.
      rethrowUnlessClosedTransport(error);
    }
  } else if (!session.mcpInventory && session.initData?.mcpServers) {
    session.mcpInventory = session.initData.mcpServers.slice(0, 128).map((server) => ({
      id: server.name,
      name: server.name,
      status: server.status,
      actions:
        server.status === "disabled"
          ? ["enable"]
          : server.status === "needs-auth"
            ? ["sign-in", "reconnect", "disable"]
            : ["reconnect", "disable"],
      ...(server.scope ? { scope: server.scope } : {}),
      ...(server.transport ? { transport: server.transport } : {}),
      ...(server.tools
        ? { tools: server.tools.slice(0, 256), toolCount: server.tools.length }
        : {}),
      ...(server.error ? { error: mcpError(server.error) } : {}),
    }));
  }
  return session.mcpInventory ?? [];
}

export async function performSessionMcpAction(
  sessionId: string,
  serverId: string,
  action: NativeAgentMcpServerAction,
): Promise<{ url?: string }> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Session not found");
  const live = readableControl(session);
  // The sign-in link arrives through `onElicitation` as a parked `mcp-url`
  // card, which only a live CLI has. A probe has no `onElicitation` and is
  // closed straight after, so reconnecting there would send the link nowhere.
  if (!live && action !== "reconnect" && action !== "enable" && action !== "disable") {
    throw new Error(
      "Claude can sign in to an MCP server only while this session's Claude is running. Send a message, then sign in again; the sign-in link appears as a card in the conversation.",
    );
  }
  let probe: Query | undefined;
  const control = live ?? (probe = createProbe());
  try {
    if (action === "reconnect") await control.reconnectMcpServer?.(serverId);
    else if (action === "enable") await control.toggleMcpServer?.(serverId, true);
    else if (action === "disable") await control.toggleMcpServer?.(serverId, false);
    else {
      // Claude's OAuth URL is delivered by onElicitation; reconnecting a
      // needs-auth server is what asks the server to emit that request.
      await control.reconnectMcpServer?.(serverId);
    }
    if (control.mcpServerStatus) {
      session.mcpInventory = (await control.mcpServerStatus()).slice(0, 128).map(normalizeMcp);
    }
    return {};
  } finally {
    await Promise.resolve(probe?.close()).catch(() => undefined);
  }
}

/** The id the backend's OAuth read gives the same window, so the two merge. */
function claudeWindowId(label: string): string {
  const known = claudePlanWindowFromLabel(label);
  if (known) return known.id;
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "window";
}

/**
 * Read Claude's plan-allocation windows without a session.
 *
 * The settings pane is global, so there is no live turn to borrow a control
 * from. `createProbe()` spawns a whole Claude CLI, exactly as the auth and
 * slash-command reads do, and `refreshStructuredRateLimits`' parser turns the
 * experimental `/usage` payload into the same windows a session would report.
 */
export async function readClaudePlanUsage(): Promise<NativeAgentAccountUsageWindow[]> {
  let probe: Query | undefined;
  try {
    probe = createProbe();
    const control = probe as unknown as ClaudeQueryControl;
    const getStructuredUsage = control.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (!getStructuredUsage) {
      // A missing experimental accessor is not evidence that the account is
      // unmetered. Throw so the backend reports unavailable rather than an
      // authoritative empty plan.
      throw new Error("Claude's plan usage API is unavailable in this CLI version");
    }
    const structuredUsage = await getStructuredUsageWithTimeout(
      getStructuredUsage,
      control,
      PLAN_USAGE_PROBE_TIMEOUT_MS,
    );
    const rateLimits = rateLimitsFromStructuredUsage(structuredUsage);
    if (rateLimits === undefined) {
      throw new Error("Claude did not report plan usage");
    }
    return rateLimits.map((window) => ({
      window: claudeWindowId(window.label),
      label: window.label,
      ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
      ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
    }));
  } finally {
    await Promise.resolve(probe?.close()).catch(() => undefined);
  }
}

export async function steerClaudeSession(
  sessionId: string,
  text: string,
  requestId: string,
  expectedRunId: string,
): Promise<"applied" | "idle" | "mismatch" | "unknown" | NativeAgentSteerRejectedOutcome> {
  const capacityRefusal: NativeAgentSteerRejectedOutcome = {
    outcome: "rejected",
    reason: "steer-capacity-exceeded",
    requestId,
  };
  const session = sessions.get(sessionId);
  const inputDigest = createHash("sha256").update(text).digest("hex");
  const previous = session?.steerJournal?.get(requestId);
  if (previous) {
    if (previous.inputDigest !== inputDigest || previous.expectedRunId !== expectedRunId) {
      return "unknown";
    }
    if (previous.state === "dispatched") return "applied";
    if (previous.state === "absent") return "idle";
    if (previous.state === "capacity-exceeded") return capacityRefusal;
    return "unknown";
  }
  if (!session || session.status !== "running" || !session.queryControl?.pushInput) {
    if (session) {
      rememberSteer(session, {
        requestId,
        inputDigest,
        expectedRunId,
        state: "absent",
        createdAt: Date.now(),
      });
      await persistSteerJournal(session);
    }
    return "idle";
  }
  if (String(session.latestTurnGeneration ?? "") !== expectedRunId) return "mismatch";
  if (!durableClaudeSessionId(session)) return "unknown";

  rememberSteer(session, {
    requestId,
    inputDigest,
    expectedRunId,
    state: "prepared",
    createdAt: Date.now(),
  });
  await steerTestHooks?.beforePersistPrepared?.();
  const preparedOk = steerTestHooks?.failPersistPrepared
    ? false
    : await persistSteerJournal(session);
  await steerTestHooks?.afterPersistPrepared?.();
  if (!preparedOk) return "unknown";

  const message: SDKUserMessage = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    priority: "now",
    uuid: requestId as SDKUserMessage["uuid"],
    session_id: session.sdkSessionId,
  };
  await steerTestHooks?.beforePushInput?.();
  const pushed = session.queryControl.pushInput(message);
  await steerTestHooks?.afterPushInput?.();
  if (pushed !== true) {
    rememberSteer(session, {
      requestId,
      inputDigest,
      expectedRunId,
      state: pushed === "capacity-exceeded" ? "capacity-exceeded" : "unknown",
      createdAt: Date.now(),
    });
    await persistSteerJournal(session);
    return pushed === "capacity-exceeded" ? capacityRefusal : "unknown";
  }

  rememberSteer(session, {
    requestId,
    inputDigest,
    expectedRunId,
    state: "dispatched",
    createdAt: Date.now(),
  });
  await steerTestHooks?.beforePersistDispatched?.();
  const dispatchedOk = steerTestHooks?.failPersistDispatched
    ? false
    : await persistSteerJournal(session);
  if (!dispatchedOk) {
    rememberSteer(session, {
      requestId,
      inputDigest,
      expectedRunId,
      state: "prepared",
      createdAt: Date.now(),
    });
    return "unknown";
  }
  appendSteerUserMessage(session, text, requestId);
  return "applied";
}

export async function configureClaudeSession(
  session: SessionState,
  input: {
    model?: string;
    effort?: string;
    fastMode?: boolean;
    permissionMode?: PermissionMode;
    parameterValues?: Record<string, string | boolean>;
  },
): Promise<void> {
  const control = session.queryControl ?? readableControl(session);
  if (!control) return;
  try {
    if (input.model !== undefined) await control.setModel?.(input.model);
    // Capped like a turn's mode: leaving plan mode must not lift an `ask` or
    // `deny` session into `bypassPermissions`.
    if (input.permissionMode !== undefined) {
      await control.setPermissionMode?.(
        claudePermissionMode(
          claudeTurnPolicy(session.executionPolicy, undefined),
          input.permissionMode,
        ),
      );
    }
    const settings: Record<string, unknown> = {
      ...ultracodeFlagSetting({
        parameterValues: input.parameterValues,
        effortChanged: input.effort !== undefined,
        fastModeChanged: input.fastMode !== undefined,
        modelChanged: input.model !== undefined,
        live: session.ultracodeApplied,
      }),
    };
    if (input.effort !== undefined) settings.effortLevel = input.effort;
    if (input.fastMode !== undefined) settings.fastMode = input.fastMode;
    if (Object.keys(settings).length > 0 && control.applyFlagSettings) {
      await control.applyFlagSettings(settings);
      if (typeof settings.ultracode === "boolean") {
        session.ultracode = settings.ultracode;
        session.ultracodeApplied = settings.ultracode;
      }
    }
    const thinking = input.parameterValues?.thinking;
    if (thinking === "disabled") await control.setMaxThinkingTokens?.(0, "omitted");
    else if (thinking === "adaptive") await control.setMaxThinkingTokens?.(null, "summarized");
    else if (typeof thinking === "string" && thinking.startsWith("budget-")) {
      const tokens = Number(thinking.slice("budget-".length));
      if (Number.isSafeInteger(tokens) && tokens > 0) {
        await control.setMaxThinkingTokens?.(tokens, "summarized");
      }
    }
  } catch (error) {
    // Unlike the read paths, a settings change that did not reach the CLI must
    // not look like it succeeded. A conflict is the honest answer: the turn
    // this control belonged to is over, and the next one will start from the
    // session's stored preferences.
    rethrowUnlessClosedTransport(error);
    throw sessionOperationError(
      "conflict",
      "The Claude turn ended before the settings change was applied",
    );
  }
}

export async function gracefulInterruptClaudeSession(
  sessionId: string,
): Promise<{ interrupted: boolean; stillQueued: string[] }> {
  const session = sessions.get(sessionId);
  const control = session?.queryControl;
  if (!session || !control?.interrupt) return { interrupted: false, stillQueued: [] };
  // Before the request: the CLI can answer it with the turn's result first.
  session.interruptRequestedGeneration = session.latestTurnGeneration;
  try {
    const receipt = await control.interrupt();
    return { interrupted: true, stillQueued: receipt?.still_queued ?? [] };
  } catch (error) {
    // The turn ended on its own before the interrupt landed. That is the
    // outcome the caller wanted, so report it as done with nothing queued
    // rather than as a bridge fault.
    rethrowUnlessClosedTransport(error);
    return { interrupted: true, stillQueued: [] };
  }
}
