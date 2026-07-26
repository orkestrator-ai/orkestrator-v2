// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ImageBlockParam, TextBlockParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  ModelInfo,
  SessionState,
  NormalizedMessage,
  NormalizedPart,
  ToolDiffMetadata,
  QuestionRequest,
  PlanApprovalRequest,
  PromptOptions,
  SessionInitData,
  McpServerRuntimeStatus,
  PluginRuntimeStatus,
  SdkMessageBase,
  SdkCompactBoundaryMessage,
  SdkResultMessage,
  SdkSystemMessage,
  TaskListSnapshot,
  MessagePatchEventData,
  SessionUsageSnapshot,
  BackgroundTaskSnapshot,
} from "../types/index.js";
import { isSdkCompactBoundaryMessage, isSdkResultMessage } from "../types/index.js";
import { TaskRegistry, isTaskListTool } from "@orkestrator/protocol/task-list";
import {
  structuredOutputFailure,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { eventEmitter } from "./event-emitter.js";
import { debugLog, isDebugLoggingEnabled } from "./logger.js";
import { applyDiffBudget, applyToolResultBudget } from "./part-budget.js";
import { getMcpRuntimeConfig } from "./mcp-config.js";
import { getPluginsForSdk } from "./plugin-config.js";
import type { McpToolMetadata } from "../types/mcp.js";
import { execFileSync, spawn } from "node:child_process";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

// Store for active sessions
const sessions = new Map<string, SessionState>();

function claudeExecutableOptions(): { pathToClaudeCodeExecutable: string } | Record<string, never> {
  const executable = process.env.CLAUDE_CLI_PATH?.trim();
  return executable ? { pathToClaudeCodeExecutable: executable } : {};
}

// Pending questions waiting for answers
const pendingQuestions = new Map<string, QuestionRequest>();

// Question answer resolvers (for AskUserQuestion flow)
// Answers are Record<string, string> mapping question text to answer text
const questionResolvers = new Map<
  string,
  {
    resolve: (answers: Record<string, string>) => void;
    reject: (error: Error) => void;
  }
>();

// Pending plan approvals waiting for user decision (for ExitPlanMode flow)
const pendingPlanApprovals = new Map<string, PlanApprovalRequest>();

// Plan approval response type - includes both approval status and optional feedback
interface PlanApprovalResponse {
  approved: boolean;
  feedback?: string;
}

interface ContextUsagePayload {
  usedTokens: number;
  totalTokens: number;
  model?: string;
}

// Plan approval resolvers (for ExitPlanMode flow)
// Resolves with approval response including feedback
const planApprovalResolvers = new Map<
  string,
  {
    resolve: (response: PlanApprovalResponse) => void;
    reject: (error: Error) => void;
  }
>();

// Timeouts for user interactions (5 minutes)
const QUESTION_TIMEOUT_MS = 5 * 60 * 1000;
const PLAN_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

class ClaudeStructuredOutputError extends Error {
  constructor(readonly result: StructuredOutputResult<never>) {
    super(result.ok ? "Claude structured output failed" : result.error.message);
    this.name = "ClaudeStructuredOutputError";
  }
}

function recordStructuredOutput(
  session: SessionState,
  result: StructuredOutputResult,
): void {
  session.structuredOutput = result;
  session.structuredOutputRequestId = result.requestId;
  eventEmitter.emit({
    type: "session.structured-output",
    sessionId: session.id,
    data: { structuredOutput: result },
  });
}

/**
 * Generate a unique session ID using crypto.randomUUID for guaranteed uniqueness
 */
function generateSessionId(): string {
  return `session-${crypto.randomUUID()}`;
}

function sdkSessionIdFromBridgeId(sessionId: string): string | null {
  const value = sessionId.startsWith("session-")
    ? sessionId.slice("session-".length)
    : sessionId;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function bridgeSessionIdFromSdkId(sessionId: string): string {
  return sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
}

/**
 * Generate a unique message ID using crypto.randomUUID for guaranteed uniqueness
 */
function generateMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}

function parseTokenValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase().replace(/,/g, "");
    const match = normalized.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
    if (!match) return undefined;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return undefined;
    if (match[2] === "k") return Math.round(base * 1_000);
    if (match[2] === "m") return Math.round(base * 1_000_000);
    if (match[2] === "b") return Math.round(base * 1_000_000_000);
    return Math.round(base);
  }
  return undefined;
}

function extractContextUsageFromUnknown(payload: unknown, fallbackModel?: string): ContextUsagePayload | null {
  if (!payload || typeof payload !== "object") return null;

  const queue: Record<string, unknown>[] = [payload as Record<string, unknown>];
  const visited = new WeakSet<object>();

  while (queue.length > 0) {
    const node = queue.shift();
    if (!node) continue;
    if (visited.has(node)) continue;
    visited.add(node);

    const usage = node.usage;
    const usageObject = usage && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as Record<string, unknown>)
      : undefined;
    const source = usageObject ?? node;

    const usedTokens =
      parseTokenValue(source.usedTokens)
      ?? parseTokenValue(source.used_tokens)
      ?? parseTokenValue(source.totalTokens)
      ?? parseTokenValue(source.total_tokens)
      ?? (
        ((parseTokenValue(source.inputTokens) ?? parseTokenValue(source.input_tokens)) ?? 0)
        + ((parseTokenValue(source.outputTokens) ?? parseTokenValue(source.output_tokens)) ?? 0)
      );

    const totalTokens =
      parseTokenValue(source.totalContextTokens)
      ?? parseTokenValue(source.total_context_tokens)
      ?? parseTokenValue(source.maxContextTokens)
      ?? parseTokenValue(source.max_context_tokens)
      ?? parseTokenValue(source.contextWindowTokens)
      ?? parseTokenValue(source.context_window_tokens)
      ?? parseTokenValue(source.contextWindow)
      ?? parseTokenValue(source.context_window)
      ?? parseTokenValue(source.maxTokens)
      ?? parseTokenValue(source.max_tokens);

    if (usedTokens && totalTokens && usedTokens > 0 && totalTokens > 0 && usedTokens <= totalTokens) {
      const model =
        (typeof source.model === "string" ? source.model : undefined)
        ?? (typeof source.modelId === "string" ? source.modelId : undefined)
        ?? (typeof source.model_id === "string" ? source.model_id : undefined)
        ?? fallbackModel;

      return {
        usedTokens,
        totalTokens,
        model,
      };
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === "object") {
              queue.push(item as Record<string, unknown>);
            }
          }
        } else {
          queue.push(value as Record<string, unknown>);
        }
      }
    }
  }

  return null;
}

async function buildClaudeUsageSnapshot(
  session: SessionState,
  result: SdkResultMessage,
  queryControl: SessionState["queryControl"],
  fallbackModel?: string,
): Promise<SessionUsageSnapshot | undefined> {
  const modelEntries = Object.entries(result.modelUsage ?? {});
  const modelTotals = modelEntries.reduce(
    (sum, [, usage]) => ({
      input: sum.input + (usage.inputTokens ?? 0),
      output: sum.output + (usage.outputTokens ?? 0),
      cacheRead: sum.cacheRead + (usage.cacheReadInputTokens ?? 0),
      cacheWrite: sum.cacheWrite + (usage.cacheCreationInputTokens ?? 0),
      cost: sum.cost + (usage.costUSD ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  );
  const rawUsage = result.usage ?? {};
  const totals = modelEntries.length > 0
    ? modelTotals
    : {
        input:
          parseTokenValue(rawUsage.inputTokens)
          ?? parseTokenValue(rawUsage.input_tokens)
          ?? 0,
        output:
          parseTokenValue(rawUsage.outputTokens)
          ?? parseTokenValue(rawUsage.output_tokens)
          ?? 0,
        cacheRead:
          parseTokenValue(rawUsage.cacheReadInputTokens)
          ?? parseTokenValue(rawUsage.cache_read_input_tokens)
          ?? parseTokenValue(rawUsage.cacheReadTokens)
          ?? parseTokenValue(rawUsage.cache_read_tokens)
          ?? 0,
        cacheWrite:
          parseTokenValue(rawUsage.cacheCreationInputTokens)
          ?? parseTokenValue(rawUsage.cache_creation_input_tokens)
          ?? parseTokenValue(rawUsage.cacheWriteTokens)
          ?? parseTokenValue(rawUsage.cache_write_tokens)
          ?? 0,
        cost: 0,
      };

  let context:
    | {
        totalTokens?: number;
        maxTokens?: number;
        percentage?: number;
        model?: string;
        categories?: Array<{ name: string; tokens: number; color?: string }>;
      }
    | undefined;
  if (queryControl?.getContextUsage) {
    try {
      const raw = await queryControl.getContextUsage();
      if (raw && typeof raw === "object") {
        const value = raw as Record<string, unknown>;
        context = {
          totalTokens: parseTokenValue(value.totalTokens),
          maxTokens: parseTokenValue(value.maxTokens),
          percentage:
            typeof value.percentage === "number" ? value.percentage : undefined,
          model: typeof value.model === "string" ? value.model : undefined,
          categories: Array.isArray(value.categories)
            ? value.categories.flatMap((entry) => {
                if (!entry || typeof entry !== "object") return [];
                const item = entry as Record<string, unknown>;
                const name = typeof item.name === "string" ? item.name : undefined;
                const tokens = parseTokenValue(item.tokens);
                if (!name || tokens === undefined) return [];
                return [{
                  name,
                  tokens,
                  color: typeof item.color === "string" ? item.color : undefined,
                }];
              })
            : undefined,
        };
      }
    } catch (error) {
      console.debug("[session-manager] Context usage control request failed:", error);
    }
  }

  const heuristic = extractContextUsageFromUnknown(result, fallbackModel);
  const usedTokens =
    context?.totalTokens
    ?? heuristic?.usedTokens
    ?? totals.input + totals.output + totals.cacheRead;
  const contextWindow =
    context?.maxTokens
    ?? heuristic?.totalTokens
    ?? Math.max(...modelEntries.map(([, usage]) => usage.contextWindow ?? 0), 0);
  if (usedTokens <= 0 || contextWindow <= 0) return undefined;

  const previous = session.usage;
  const lastTurnTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return {
    usedTokens,
    totalTokens: contextWindow,
    percentUsed:
      context?.percentage
      ?? Math.max(0, Math.min(100, (usedTokens / contextWindow) * 100)),
    modelId: context?.model ?? modelEntries.at(-1)?.[0] ?? fallbackModel,
    inputTokens: (previous?.inputTokens ?? 0) + totals.input,
    outputTokens: (previous?.outputTokens ?? 0) + totals.output,
    cacheReadTokens: (previous?.cacheReadTokens ?? 0) + totals.cacheRead,
    cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + totals.cacheWrite,
    lastTurnTokens,
    sessionTokens: (previous?.sessionTokens ?? 0) + lastTurnTokens,
    costUsd:
      (previous?.costUsd ?? 0)
      + (result.total_cost_usd ?? totals.cost),
    durationMs: (previous?.durationMs ?? 0) + (result.duration_ms ?? 0),
    apiDurationMs: (previous?.apiDurationMs ?? 0) + (result.duration_api_ms ?? 0),
    permissionDenials:
      (previous?.permissionDenials ?? 0)
      + (result.permission_denials?.length ?? 0),
    contextCategories: context?.categories,
    estimated: context?.totalTokens === undefined,
    source: "claude",
    updatedAt: new Date().toISOString(),
    rateLimits: previous?.rateLimits,
  };
}

/**
 * Find the path to an executable by checking common locations and PATH.
 * Returns the path if found, null otherwise.
 */
function findCliExecutable(name: string): string | null {
  // Check common locations first
  const home = homedir();
  const commonPaths: string[] = [];

  if (name === "claude") {
    commonPaths.push(
      join(home, ".claude", "local", "claude"),
      "/usr/local/bin/claude",
    );
  } else if (name === "opencode") {
    commonPaths.push(
      join(home, ".local", "bin", "opencode"),
      "/usr/local/bin/opencode",
    );
  }

  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }

  // Fall back to PATH lookup
  try {
    const result = execFileSync("which", [name], { encoding: "utf-8", timeout: 5000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {
    // Not found in PATH
  }

  return null;
}

/**
 * Generate a session title by spawning the Claude CLI (or OpenCode CLI as fallback).
 * Uses the same approach as environment name generation on the Rust side.
 * Returns the generated title or null if generation fails.
 */
async function generateTitleViaCli(userMessage: string): Promise<string | null> {
  const systemPrompt =
    "Generate a concise title (max 6 words) summarizing the user's request. Return only the title text, no quotes, no punctuation at the end.";

  const truncatedMessage = userMessage.slice(0, 500);

  // Try Claude CLI first, then OpenCode CLI
  let cliPath: string | null = null;
  let args: string[] = [];

  const claudePath = findCliExecutable("claude");
  if (claudePath) {
    cliPath = claudePath;
    args = ["--print", "--model", "haiku", "--system-prompt", systemPrompt, truncatedMessage];
    console.debug("[session-manager] Using Claude CLI for title generation:", claudePath);
  } else {
    const opencodePath = findCliExecutable("opencode");
    if (opencodePath) {
      cliPath = opencodePath;
      args = ["--print", "--system-prompt", systemPrompt, truncatedMessage];
      console.debug("[session-manager] Using OpenCode CLI for title generation:", opencodePath);
    } else {
      console.debug("[session-manager] No AI CLI found for title generation");
      return null;
    }
  }

  return new Promise<string | null>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliPath!, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
    } catch (error) {
      console.debug(
        "[session-manager] CLI title generation spawn error:",
        error instanceof Error ? error.message : String(error),
      );
      resolve(null);
      return;
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error: Error) => {
      console.debug("[session-manager] CLI title generation spawn error:", error.message);
      resolve(null);
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        console.debug("[session-manager] CLI title generation failed:", { code, stderr: stderr.slice(0, 200) });
        resolve(null);
        return;
      }

      const title = stdout.trim();
      if (!title) {
        console.debug("[session-manager] CLI title generation returned empty output");
        resolve(null);
        return;
      }

      resolve(title);
    });
  });
}

/**
 * Generate a concise session title using available AI CLI tools.
 * Tries Claude CLI first, then OpenCode CLI, then falls back to extracting
 * a title from the user message text.
 * Called asynchronously after the first prompt completes - failures are silently ignored.
 */
async function generateAndSetSessionTitle(
  sessionId: string,
  userMessage: string
): Promise<void> {
  try {
    // Try generating via CLI (Claude CLI → OpenCode CLI)
    let title = await generateTitleViaCli(userMessage);

    // Fallback: extract a simple title from the user message
    if (!title) {
      console.debug("[session-manager] CLI title generation unavailable, using text extraction fallback");
      const cleaned = userMessage
        .replace(/```[\s\S]*?```/g, "")
        .replace(/`[^`]+`/g, "")
        .replace(/\n+/g, " ")
        .trim();
      const firstSentence = cleaned.split(/[.!?\n]/)[0]?.trim() || cleaned;
      const words = firstSentence.split(/\s+/).slice(0, 6);
      title = words.join(" ");
      // Capitalize first letter
      if (title.length > 0) {
        title = title.charAt(0).toUpperCase() + title.slice(1);
      }
    }

    if (!title) {
      console.debug("[session-manager] Title generation returned empty result");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) return;

    session.title = title;
    console.debug("[session-manager] Generated session title:", { sessionId, title });

    eventEmitter.emit({
      type: "session.title-updated",
      sessionId,
      data: { title },
    });
  } catch (error) {
    console.debug("[session-manager] Title generation failed:", error);
  } finally {
    const session = sessions.get(sessionId);
    if (session) {
      session.titleGenerationPending = false;
    }
  }
}

/**
 * Create a new session
 */
export function createSession(title?: string): SessionState {
  const id = generateSessionId();
  const now = new Date();

  const session: SessionState = {
    id,
    title: title || `Session ${id.slice(-6)}`,
    messages: [],
    status: "idle",
    createdAt: now,
    lastActivity: now,
  };

  sessions.set(id, session);

  eventEmitter.emit({
    type: "session.updated",
    sessionId: id,
    data: { status: "idle" },
  });

  return session;
}

/**
 * Get a session by ID
 */
export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

export function getStructuredPromptDispatchState(
  sessionId: string,
  requestId: string,
): "new" | "processing" | "already-processed" | "not-found" {
  const session = sessions.get(sessionId);
  if (!session) return "not-found";
  if (session.structuredOutputRequestId !== requestId) return "new";
  if (session.structuredOutput) return "already-processed";
  return session.status === "running" ? "processing" : "new";
}

/**
 * List all sessions
 */
export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

/**
 * Clean up pending plan approvals for a session
 * Rejects any waiting promises so they don't hang
 */
function cleanupPendingPlanApprovals(sessionId: string): void {
  for (const [approvalId, approval] of pendingPlanApprovals) {
    if (approval.sessionId === sessionId) {
      const resolver = planApprovalResolvers.get(approvalId);
      if (resolver) {
        resolver.reject(new Error("Session terminated"));
        planApprovalResolvers.delete(approvalId);
      }
      pendingPlanApprovals.delete(approvalId);
      eventEmitter.emit({
        type: "plan.approval-responded",
        sessionId,
        data: { requestId: approvalId, approved: false, cancelled: true },
      });
    }
  }
}

/**
 * Clean up pending questions for a session.
 * Rejects any waiting promises so SDK callbacks cannot remain suspended.
 */
function cleanupPendingQuestions(sessionId: string): void {
  for (const [questionId, question] of pendingQuestions) {
    if (question.sessionId === sessionId) {
      const resolver = questionResolvers.get(questionId);
      if (resolver) {
        resolver.reject(new Error("Session terminated"));
        questionResolvers.delete(questionId);
      }
      pendingQuestions.delete(questionId);
      eventEmitter.emit({
        type: "question.answered",
        sessionId,
        data: { requestId: questionId, cancelled: true },
      });
    }
  }
}

function cleanupPendingInteractions(sessionId: string): void {
  cleanupPendingQuestions(sessionId);
  cleanupPendingPlanApprovals(sessionId);
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session) {
    // Abort any running query
    if (session.abortController) {
      session.abortController.abort();
    }
    cleanupPendingInteractions(sessionId);
    sessions.delete(sessionId);
    return true;
  }
  return false;
}

/**
 * Get messages for a session
 */
export function getSessionMessages(sessionId: string): NormalizedMessage[] {
  const session = sessions.get(sessionId);
  return session?.messages || [];
}

/**
 * Abort a running session
 */
export function abortSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session && session.abortController) {
    session.abortController.abort();
    session.status = "idle";
    session.abortController = undefined;

    cleanupPendingInteractions(sessionId);

    eventEmitter.emit({
      type: "session.idle",
      sessionId,
      data: { aborted: true },
    });

    return true;
  }
  return false;
}

/**
 * Tool tracker for managing tool invocations across a conversation turn.
 * Tools are tracked by their ID and their results are merged in when received.
 * Also tracks parent Task relationships for proper tool grouping.
 */
class ToolTracker {
  private tools = new Map<string, NormalizedPart>();

  /** Add or update a tool invocation */
  addTool(toolUseId: string, part: NormalizedPart, parentTaskUseId?: string): void {
    // Only add if we don't have this tool yet, or update state if we do
    const existing = this.tools.get(toolUseId);
    if (!existing) {
      this.tools.set(toolUseId, { ...part, toolUseId, parentTaskUseId });
    }
  }

  /** Update a tool with its result */
  updateToolResult(
    toolUseId: string,
    result: {
      output?: string;
      error?: string;
      state: "success" | "failure";
      taskSnapshot?: TaskListSnapshot;
    },
  ): void {
    const existing = this.tools.get(toolUseId);
    if (existing) {
      this.tools.set(toolUseId, {
        ...existing,
        toolState: result.state,
        toolOutput: result.output,
        toolError: result.error,
        taskSnapshot: result.taskSnapshot ?? existing.taskSnapshot,
      });
    }
  }

  /** Get all tracked tools as an array, preserving insertion order */
  getTools(): NormalizedPart[] {
    return Array.from(this.tools.values());
  }

  /** Get a specific tool by its ID */
  getTool(toolUseId: string): NormalizedPart | undefined {
    return this.tools.get(toolUseId);
  }
}

/** Entry in the ordered parts sequence - a thinking block, tool reference, or text block */
interface OrderedPartEntry {
  type: "thinking" | "tool-ref" | "text";
  /** For thinking: the thinking content. For tool-ref: the tool use ID. For text: the text content */
  value: string;
  /** When this content block first arrived from the SDK. */
  timestamp?: string;
  /** Message UUID this part belongs to (for streaming updates) */
  messageUuid?: string;
  /** Parent Task tool use ID - used to group child tools under their parent Task */
  parentTaskUseId?: string;
  /** Position of this part within its SDK message's content array */
  blockOffset?: number;
}

/**
 * Check if a tool name is from an MCP server and extract server name
 * MCP tool names have format: mcp_servername_toolname
 *
 * @param toolName - The tool name to parse
 * @param knownServerNames - Set of known MCP server names for accurate matching
 *                           when server names contain underscores
 */
function parseMcpToolName(
  toolName: string,
  knownServerNames?: Set<string>
): McpToolMetadata {
  if (!toolName.startsWith("mcp_")) {
    return { isMcpTool: false };
  }

  // Remove the "mcp_" prefix
  const remainder = toolName.slice(4);

  // If we have known server names, find the longest matching prefix
  // This handles server names with underscores (e.g., "my_server")
  if (knownServerNames && knownServerNames.size > 0) {
    let matchedServer: string | undefined;
    let maxLength = 0;

    for (const serverName of knownServerNames) {
      // Check if remainder starts with "servername_"
      if (
        remainder.startsWith(serverName + "_") &&
        serverName.length > maxLength
      ) {
        matchedServer = serverName;
        maxLength = serverName.length;
      }
    }

    if (matchedServer) {
      return { isMcpTool: true, mcpServerName: matchedServer };
    }
  }

  // Fallback: assume server name is the first segment (no underscores in name)
  const parts = remainder.split("_");
  if (parts.length >= 2) {
    return { isMcpTool: true, mcpServerName: parts[0] };
  }

  return { isMcpTool: true };
}

/** Check if a tool name is a Task tool (subagent) */
function isTaskToolName(toolName: string): boolean {
  return toolName.toLowerCase() === "task";
}

/**
 * Parse SDK message content, extracting text/thinking parts, registering tools,
 * and tracking the order of non-text parts for chronological display.
 * Also tracks parent Task relationships for proper tool grouping.
 *
 * @param message - The SDK message to parse
 * @param toolTracker - Tool tracker for managing tool invocations
 * @param mcpServerNames - Set of known MCP server names for accurate tool parsing
 * @param activeTaskIds - Set of currently active (pending) Task IDs for parent tracking
 * @param taskRegistry - Session task list state, stamped onto Task tool results
 */
function parseMessageContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  toolTracker?: ToolTracker,
  mcpServerNames?: Set<string>,
  activeTaskIds?: Set<string>,
  taskRegistry?: Pick<TaskRegistry, "apply">
): {
  content: string;
  thinkingParts: NormalizedPart[];
  /** Ordered sequence of thinking blocks and tool references as they appeared */
  orderedParts: OrderedPartEntry[];
  /** IDs of Task tools seen in this message (to add to active tasks) */
  newTaskIds: string[];
  /** IDs of Task tools that completed in this message (to remove from active tasks) */
  completedTaskIds: string[];
  /** Number of content blocks in this message (including ones that produced no part) */
  contentBlockCount: number;
} {
  const thinkingParts: NormalizedPart[] = [];
  const orderedParts: OrderedPartEntry[] = [];
  const newTaskIds: string[] = [];
  const completedTaskIds: string[] = [];
  let textContent = "";

  const messageUuid = typeof message.uuid === "string" ? message.uuid : undefined;
  const explicitParentTaskUseId =
    typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0
      ? message.parent_tool_use_id
      : undefined;

  // Handle message.message.content array (from Anthropic SDK format)
  const contentBlocks = message.message?.content || [];

  // Track the most recent Task tool use ID within this message
  // This is used for the positional heuristic: tools following a Task belong to it
  let currentTaskUseId: string | undefined;

  for (let blockOffset = 0; blockOffset < contentBlocks.length; blockOffset += 1) {
    const block = contentBlocks[blockOffset];
    if (block.type === "text") {
      textContent += block.text || "";
      // Track text in ordered parts so it maintains position relative to thinking/tools
      orderedParts.push({
        type: "text",
        value: block.text || "",
        messageUuid,
        blockOffset,
      });
    } else if (block.type === "thinking") {
      const thinkingContent = block.thinking || "";
      thinkingParts.push({
        type: "thinking",
        content: thinkingContent,
      });
      // Track order: add thinking entry
      orderedParts.push({
        type: "thinking",
        value: thinkingContent,
        messageUuid,
        blockOffset,
      });
    } else if (block.type === "tool_use" && toolTracker) {
      const toolName = block.name || "Unknown tool";
      const normalizedToolName = toolName.toLowerCase();
      const isEditTool = normalizedToolName === "edit";
      const isWriteTool = normalizedToolName === "write";
      const isTask = isTaskToolName(toolName);

      let toolDiff: ToolDiffMetadata | undefined;
      if ((isEditTool || isWriteTool) && block.input) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const input = block.input as any;
        // `after` is the whole file for a Write, so this is bounded before it
        // is retained for the life of the session.
        toolDiff = applyDiffBudget({
          filePath: input.file_path || input.filePath,
          before: isWriteTool ? "" : input.old_string || input.oldString,
          after: isWriteTool ? input.content : input.new_string || input.newString,
        });
      }

      // Check if this is an MCP tool
      const { isMcpTool, mcpServerName } = parseMcpToolName(toolName, mcpServerNames);

      // Determine parent Task ID:
      // - Task tools have no parent (they ARE the parent)
      // - Other tools belong to the most recent Task in this message
      // - If no Task in this message, check activeTaskIds for a single active Task
      let parentTaskUseId: string | undefined;
      if (!isTask) {
        if (explicitParentTaskUseId) {
          parentTaskUseId = explicitParentTaskUseId;
        } else if (currentTaskUseId) {
          // Use the most recent Task from this message
          parentTaskUseId = currentTaskUseId;
        } else if (activeTaskIds && activeTaskIds.size === 1) {
          // Only one active Task globally - use it
          parentTaskUseId = Array.from(activeTaskIds)[0];
        }
        // If multiple active Tasks and none in this message, we can't determine parent.
        // In this case, parentTaskUseId remains undefined and the tool will render as
        // standalone in the frontend (positional fallback only works within a single message)
      }

      // Register tool with tracker
      if (typeof block.id === "string" && block.id.length > 0) {
        toolTracker.addTool(block.id, {
          type: "tool-invocation",
          content: toolName,
          toolName,
          toolArgs: block.input,
          toolState: "pending",
          toolDiff,
          toolUseId: block.id,
          // MCP tool metadata
          isMcpTool,
          mcpServerName,
        }, parentTaskUseId);

        // Track order: add tool reference with parent info
        orderedParts.push({
          type: "tool-ref",
          value: block.id,
          messageUuid,
          parentTaskUseId,
          blockOffset,
        });

        // If this is a Task tool, update tracking
        if (isTask) {
          currentTaskUseId = block.id;
          newTaskIds.push(block.id);
        }
      }
    } else if (block.type === "tool_result" && toolTracker) {
      // Update tool tracker with result
      if (typeof block.tool_use_id === "string" && block.tool_use_id.length > 0) {
        const resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);

        // Replay successful task tool calls into the session task list so this
        // part can carry the resulting list state. A failed call changed
        // nothing, so it must not mutate the registry, and a call whose output
        // the registry cannot parse yields no snapshot at all — the renderer
        // then shows the raw call instead of a list nothing vouches for.
        const pendingTool = toolTracker.getTool(block.tool_use_id);
        const taskSnapshot =
          block.is_error || !isTaskListTool(pendingTool?.toolName)
            ? undefined
            : taskRegistry?.apply(pendingTool?.toolName, pendingTool?.toolArgs, resultContent);

        // The task registry above parses the *full* result; only what the
        // session goes on to retain is capped.
        toolTracker.updateToolResult(block.tool_use_id, {
          ...applyToolResultBudget({
            output: block.is_error ? undefined : resultContent,
            error: block.is_error ? resultContent : undefined,
          }),
          state: block.is_error ? "failure" : "success",
          taskSnapshot,
        });

        // Check if this is a Task tool completing
        const tool = toolTracker.getTool(block.tool_use_id);
        if (tool && isTaskToolName(tool.toolName || "")) {
          completedTaskIds.push(block.tool_use_id);
        }
      }
    }
  }

  return {
    content: textContent,
    thinkingParts,
    orderedParts,
    newTaskIds,
    completedTaskIds,
    contentBlockCount: contentBlocks.length,
  };
}

/**
 * Build message parts from ordered sequence.
 * Maintains chronological order of all parts (thinking, tools, and text).
 */
function buildMessageParts(
  orderedParts: OrderedPartEntry[],
  toolTracker: ToolTracker,
): NormalizedPart[] {
  const result: NormalizedPart[] = [];

  for (const entry of orderedParts) {
    if (entry.type === "thinking") {
      result.push({
        type: "thinking",
        content: entry.value,
        timestamp: entry.timestamp,
        _messageUuid: entry.messageUuid,
      });
    } else if (entry.type === "tool-ref") {
      const tool = toolTracker.getTool(entry.value);
      if (tool) {
        result.push(tool);
      }
    } else if (entry.type === "text") {
      result.push({
        type: "text",
        content: entry.value,
        timestamp: entry.timestamp,
        _messageUuid: entry.messageUuid,
      });
    }
  }

  return result;
}

function normalizePersistedSessionMessages(
  persisted: Array<{
    type: "user" | "assistant" | "system";
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: string | null;
  }>,
): { messages: NormalizedMessage[]; taskRegistry: TaskRegistry } {
  const toolTracker = new ToolTracker();
  const taskRegistry = new TaskRegistry();
  const activeTaskIds = new Set<string>();
  const parsed: Array<{
    raw: (typeof persisted)[number];
    content: string;
    orderedParts: OrderedPartEntry[];
  }> = [];

  for (const raw of persisted) {
    if (raw.type === "system") continue;
    const result = parseMessageContent(
      raw,
      toolTracker,
      undefined,
      activeTaskIds,
      taskRegistry,
    );
    for (const taskId of result.newTaskIds) activeTaskIds.add(taskId);
    for (const taskId of result.completedTaskIds) activeTaskIds.delete(taskId);
    parsed.push({
      raw,
      content: result.content,
      orderedParts: result.orderedParts,
    });
  }

  const now = Date.now();
  const messages: NormalizedMessage[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const entry = parsed[index]!;
    const parts = buildMessageParts(entry.orderedParts, toolTracker);
    if (entry.raw.type === "user" && !entry.content.trim()) continue;
    if (entry.raw.type === "assistant" && parts.length === 0 && !entry.content.trim()) {
      continue;
    }
    const rawTimestamp = (entry.raw as unknown as { timestamp?: unknown }).timestamp;
    const timestamp =
      typeof rawTimestamp === "string"
        ? rawTimestamp
        : new Date(now + index).toISOString();
    messages.push({
      id: entry.raw.uuid || generateMessageId(),
      role: entry.raw.type,
      content: entry.content,
      parts,
      timestamp,
    });
  }
  return { messages, taskRegistry };
}

async function claudeSdk() {
  return import("@anthropic-ai/claude-agent-sdk");
}

function currentWorkingDirectory(): string {
  return process.env.CWD || process.cwd();
}

/**
 * Reconcile lightweight SDK session metadata into the bridge registry.
 *
 * Transcript bodies are deliberately loaded only when one session is opened.
 * Listing must stay bounded even for a large Claude home.
 */
export async function reconcilePersistedSessions(): Promise<void> {
  const sdk = await claudeSdk();
  if (typeof sdk.listSessions !== "function") return;
  const infos = await sdk.listSessions({
    dir: currentWorkingDirectory(),
    includeProgrammatic: true,
  });
  for (const info of infos) {
    const id = bridgeSessionIdFromSdkId(info.sessionId);
    const existing = sessions.get(id);
    if (existing) {
      existing.title = info.customTitle || info.summary || existing.title;
      existing.lastActivity = new Date(info.lastModified);
      existing.sdkSessionId = info.sessionId;
      continue;
    }
    sessions.set(id, {
      id,
      title: info.customTitle || info.summary || `Session ${info.sessionId.slice(-6)}`,
      messages: [],
      status: "idle",
      createdAt: new Date(info.createdAt ?? info.lastModified),
      lastActivity: new Date(info.lastModified),
      sdkSessionId: info.sessionId,
      persistedMessagesLoaded: false,
    });
  }
}

export async function ensurePersistedSession(
  sessionId: string,
): Promise<SessionState | undefined> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const sdkId = sdkSessionIdFromBridgeId(sessionId);
  if (!sdkId) return undefined;
  const sdk = await claudeSdk();
  if (typeof sdk.getSessionInfo !== "function") return undefined;
  const info = await sdk.getSessionInfo(sdkId, {
    dir: currentWorkingDirectory(),
  });
  if (!info) return undefined;
  const state: SessionState = {
    id: sessionId,
    title: info.customTitle || info.summary || `Session ${sdkId.slice(-6)}`,
    messages: [],
    status: "idle",
    createdAt: new Date(info.createdAt ?? info.lastModified),
    lastActivity: new Date(info.lastModified),
    sdkSessionId: sdkId,
    persistedMessagesLoaded: false,
  };
  sessions.set(sessionId, state);
  return state;
}

export async function hydratePersistedSessionMessages(
  sessionId: string,
): Promise<NormalizedMessage[]> {
  const session = await ensurePersistedSession(sessionId);
  if (!session) return [];
  if (session.persistedMessagesLoaded !== false) return session.messages;
  if (!session.sdkSessionId) return session.messages;

  const sdk = await claudeSdk();
  if (typeof sdk.getSessionMessages !== "function") return session.messages;
  const persisted = await sdk.getSessionMessages(session.sdkSessionId, {
    dir: currentWorkingDirectory(),
    includeSystemMessages: true,
  });
  const hydrated = normalizePersistedSessionMessages(persisted);
  session.messages = hydrated.messages;
  session.taskRegistry = hydrated.taskRegistry;
  session.persistedMessagesLoaded = true;
  return session.messages;
}

export async function deleteSessionDurably(sessionId: string): Promise<boolean> {
  const session = await ensurePersistedSession(sessionId);
  if (!session) return false;
  if (session.sdkSessionId) {
    const sdk = await claudeSdk();
    if (typeof sdk.deleteSession === "function") {
      await sdk.deleteSession(session.sdkSessionId, {
        dir: currentWorkingDirectory(),
      });
    }
  }
  return deleteSession(sessionId);
}

export async function renameSessionDurably(
  sessionId: string,
  title: string,
): Promise<boolean> {
  const session = await ensurePersistedSession(sessionId);
  if (!session) return false;
  if (session.sdkSessionId) {
    const sdk = await claudeSdk();
    if (typeof sdk.renameSession === "function") {
      await sdk.renameSession(session.sdkSessionId, title, {
        dir: currentWorkingDirectory(),
      });
    }
  }
  session.title = title;
  session.lastActivity = new Date();
  eventEmitter.emit({
    type: "session.title-updated",
    sessionId,
    data: { title },
  });
  return true;
}

export async function forkPersistedSession(
  sessionId: string,
  options: { upToMessageId?: string; title?: string } = {},
): Promise<SessionState> {
  const source = await ensurePersistedSession(sessionId);
  if (!source?.sdkSessionId) throw new Error("Session has not been materialized");
  if (source.status === "running") throw new Error("Cannot fork a running session");
  const sdk = await claudeSdk();
  if (typeof sdk.forkSession !== "function") {
    throw new Error("Installed Claude Agent SDK does not support session forking");
  }
  const boundaryId = options.upToMessageId
    ? await resolvePersistedMessageId(source, options.upToMessageId)
    : undefined;
  if (options.upToMessageId && !boundaryId) {
    throw new Error("The selected Claude message is not a persisted fork boundary");
  }
  const result = await sdk.forkSession(source.sdkSessionId, {
    dir: currentWorkingDirectory(),
    upToMessageId: boundaryId,
    title: options.title,
  });
  const id = bridgeSessionIdFromSdkId(result.sessionId);
  const now = new Date();
  const forked: SessionState = {
    id,
    title: options.title || `${source.title || "Session"} (fork)`,
    messages: [],
    status: "idle",
    createdAt: now,
    lastActivity: now,
    sdkSessionId: result.sessionId,
    persistedMessagesLoaded: false,
  };
  sessions.set(id, forked);
  return forked;
}

async function resolvePersistedMessageId(
  session: SessionState,
  normalizedMessageId: string,
): Promise<string | undefined> {
  if (!session.sdkSessionId) return undefined;
  const sdk = await claudeSdk();
  if (typeof sdk.getSessionMessages !== "function") return normalizedMessageId;
  const persisted = await sdk.getSessionMessages(session.sdkSessionId, {
    dir: currentWorkingDirectory(),
    includeSystemMessages: false,
  });
  const conversational = persisted.filter(
    (message) => message.type === "user" || message.type === "assistant",
  );
  const direct = conversational.find((message) => message.uuid === normalizedMessageId);
  if (direct) return direct.uuid;
  const normalized = session.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const ordinal = normalized.findIndex((message) => message.id === normalizedMessageId);
  if (ordinal < 0) return undefined;
  const role = normalized[ordinal]?.role;
  const candidate = conversational[ordinal];
  return candidate?.type === role ? candidate.uuid : undefined;
}

export async function rewindSessionFiles(
  sessionId: string,
  userMessageId: string,
  dryRun = false,
): Promise<unknown> {
  const session = await ensurePersistedSession(sessionId);
  if (!session?.sdkSessionId) throw new Error("Session has not been materialized");
  if (session.status === "running") throw new Error("Cannot rewind a running session");
  const persistedMessageId = await resolvePersistedMessageId(session, userMessageId);
  if (!persistedMessageId) {
    throw new Error("The selected Claude message is not a persisted checkpoint");
  }
  const iterator = query({
    prompt: "",
    options: {
      cwd: currentWorkingDirectory(),
      ...claudeExecutableOptions(),
      resume: session.sdkSessionId,
      enableFileCheckpointing: true,
    },
  });
  for await (const _message of iterator) {
    if (typeof iterator.rewindFiles !== "function") {
      throw new Error("Installed Claude Agent SDK does not support file rewind");
    }
    const result = await iterator.rewindFiles(persistedMessageId, { dryRun });
    await iterator.return?.();
    return result;
  }
  throw new Error("Claude session could not be opened for file rewind");
}

export async function stopBackgroundTask(
  sessionId: string,
  taskId: string,
): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session?.queryControl?.stopTask) return false;
  await session.queryControl.stopTask(taskId);
  return true;
}

/**
 * Whether a rebuilt part is indistinguishable from the one already published
 * at that index, and so can be left out of a patch frame.
 *
 * Tool parts are compared by identity, which is exact: `ToolTracker` hands out
 * the same object until a result arrives and replaces it. Text and thinking
 * parts are rebuilt from the accumulated deltas on every pass, so they never
 * match by identity and are compared on the one field they carry.
 */
function isSamePublishedPart(
  published: NormalizedPart | undefined,
  next: NormalizedPart,
): boolean {
  if (published === next) return true;
  if (!published || published.type !== next.type) return false;
  if (next.type === "text" || next.type === "thinking") {
    return published.content === next.content;
  }
  return false;
}

function getMessageTextFromParts(parts: NormalizedPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.content || "")
    .join("");
}

/**
 * Detect image media type from file extension.
 */
function getImageMediaType(filePath: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Matches the renderer's final image-attachment policy. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

type ClaudeAttachmentErrorCode =
  | "attachment_changed"
  | "attachment_invalid_data"
  | "attachment_not_regular_file"
  | "attachment_outside_workspace"
  | "attachment_read_failed"
  | "attachment_symlink_not_allowed"
  | "attachment_too_large";

/** Stable error shape surfaced through the authoritative session error event. */
class ClaudeAttachmentError extends Error {
  readonly name = "ClaudeAttachmentError";

  constructor(
    readonly code: ClaudeAttachmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function parseBase64ImageData(
  value: string,
): { data: string; mediaType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null {
  let data = value;
  let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined;

  if (value.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
    if (!match || !SUPPORTED_IMAGE_MEDIA_TYPES.has(match[1])) {
      return null;
    }
    mediaType = match[1] as typeof mediaType;
    data = match[2];
  }

  const normalized = data.replace(/\s+/g, "");
  if (
    normalized.length === 0
    || normalized.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
    || decodedBase64ByteLength(normalized) > MAX_IMAGE_ATTACHMENT_BYTES
  ) {
    return null;
  }

  return { data: normalized, mediaType };
}

function isPathWithin(rootPath: string, targetPath: string): boolean {
  const childPath = relative(rootPath, targetPath);
  return (
    childPath === ""
    || (
      childPath !== ".."
      && !childPath.startsWith(`..${sep}`)
      && !isAbsolute(childPath)
    )
  );
}

function attachmentErrorForFsFailure(error: unknown): ClaudeAttachmentError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ELOOP") {
    return new ClaudeAttachmentError(
      "attachment_symlink_not_allowed",
      "Image attachments must be regular workspace files, not symbolic links.",
    );
  }
  if (code === "EFBIG") {
    return new ClaudeAttachmentError(
      "attachment_too_large",
      "Image attachment exceeds the 8MB limit.",
    );
  }
  return new ClaudeAttachmentError(
    "attachment_read_failed",
    "Image attachment could not be read safely from the workspace.",
  );
}

async function assertNoSymlinkComponents(
  lexicalRoot: string,
  targetPath: string,
): Promise<void> {
  const childPath = relative(lexicalRoot, targetPath);
  let currentPath = lexicalRoot;
  for (const segment of childPath.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    const stats = await lstat(currentPath).catch((error: unknown) => {
      throw attachmentErrorForFsFailure(error);
    });
    if (stats.isSymbolicLink()) {
      throw new ClaudeAttachmentError(
        "attachment_symlink_not_allowed",
        "Image attachments must be regular workspace files, not symbolic links.",
      );
    }
  }
}

async function assertOpenedWorkspaceFile(
  targetPath: string,
  canonicalRoot: string,
  openedStats: Stats,
): Promise<void> {
  const [pathStats, canonicalTarget] = await Promise.all([
    lstat(targetPath),
    realpath(targetPath),
  ]).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });

  if (pathStats.isSymbolicLink()) {
    throw new ClaudeAttachmentError(
      "attachment_symlink_not_allowed",
      "Image attachments must be regular workspace files, not symbolic links.",
    );
  }
  if (
    !pathStats.isFile()
    || !openedStats.isFile()
    || pathStats.dev !== openedStats.dev
    || pathStats.ino !== openedStats.ino
  ) {
    throw new ClaudeAttachmentError(
      "attachment_not_regular_file",
      "Image attachment is not a stable regular workspace file.",
    );
  }
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new ClaudeAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace.",
    );
  }
}

async function readWorkspaceImageAttachment(
  filePath: string,
  cwd: string,
  afterInitialValidation?: (filePath: string) => void | Promise<void>,
): Promise<Buffer> {
  const lexicalRoot = resolve(cwd);
  const targetPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(lexicalRoot, filePath);
  if (!isPathWithin(lexicalRoot, targetPath)) {
    throw new ClaudeAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace.",
    );
  }

  const canonicalRoot = await realpath(lexicalRoot).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  await assertNoSymlinkComponents(lexicalRoot, targetPath);

  const canonicalTarget = await realpath(targetPath).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new ClaudeAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace.",
    );
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(targetPath, constants.O_RDONLY | noFollow).catch(
    (error: unknown) => {
      throw attachmentErrorForFsFailure(error);
    },
  );

  try {
    const initialStats = await handle.stat();
    await assertOpenedWorkspaceFile(targetPath, canonicalRoot, initialStats);
    if (initialStats.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new ClaudeAttachmentError(
        "attachment_too_large",
        "Image attachment exceeds the 8MB limit.",
      );
    }
    await afterInitialValidation?.(targetPath);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_IMAGE_ATTACHMENT_BYTES) {
      const remaining = (MAX_IMAGE_ATTACHMENT_BYTES + 1) - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new ClaudeAttachmentError(
        "attachment_too_large",
        "Image attachment exceeds the 8MB limit.",
      );
    }
    if (totalBytes === 0) {
      throw new ClaudeAttachmentError(
        "attachment_invalid_data",
        "Image attachment file is empty.",
      );
    }

    const finalStats = await handle.stat();
    await assertOpenedWorkspaceFile(targetPath, canonicalRoot, finalStats);
    if (
      finalStats.dev !== initialStats.dev
      || finalStats.ino !== initialStats.ino
      || finalStats.size !== initialStats.size
      || finalStats.size !== totalBytes
      || finalStats.mtimeMs !== initialStats.mtimeMs
      || finalStats.ctimeMs !== initialStats.ctimeMs
    ) {
      throw new ClaudeAttachmentError(
        "attachment_changed",
        "Image attachment changed while it was being read; please attach it again.",
      );
    }

    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof ClaudeAttachmentError) throw error;
    throw attachmentErrorForFsFailure(error);
  } finally {
    await handle.close();
  }
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function attachmentTag(attachment: NonNullable<PromptOptions["attachments"]>[number]): string {
  return `<attachment type="${escapeXmlAttribute(attachment.type)}" path="${escapeXmlAttribute(attachment.path)}" filename="${escapeXmlAttribute(attachment.filename || "")}" />`;
}

/**
 * Build the SDK prompt. When image attachments are present, returns an
 * AsyncIterable<SDKUserMessage> with inline base64 image content blocks so
 * the API receives them natively (up to 8000x8000) instead of relying on the
 * Read tool (which has a 2000x2000 limit).
 *
 * For text-only prompts (or prompts with only file attachments), returns a
 * plain string as before.
 */
async function buildSdkPrompt(
  finalPrompt: string,
  attachments: PromptOptions["attachments"] | undefined,
  cwd: string,
  afterAttachmentInitialValidation?: (filePath: string) => void | Promise<void>,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  const imageAttachments = attachments?.filter((att) => att.type === "image") ?? [];
  if (imageAttachments.length === 0) {
    return finalPrompt;
  }

  const contentBlocks: ContentBlockParam[] = [];
  if (finalPrompt) {
    contentBlocks.push({ type: "text", text: finalPrompt } as TextBlockParam);
  }
  let imageBlockCount = 0;

  for (const att of imageAttachments) {
    let base64Data: string | null = null;
    let mediaType = getImageMediaType(att.path || att.filename || "image.png");

    // Prefer dataUrl from the frontend (already base64-encoded).
    if (att.dataUrl !== undefined) {
      const parsedData = parseBase64ImageData(att.dataUrl);
      if (!parsedData) {
        throw new ClaudeAttachmentError(
          "attachment_invalid_data",
          "Image attachment data must be valid base64 and no larger than 8MB.",
        );
      }
      base64Data = parsedData.data;
      mediaType = parsedData.mediaType ?? mediaType;
    } else if (att.path) {
      const buffer = await readWorkspaceImageAttachment(
        att.path,
        cwd,
        afterAttachmentInitialValidation,
      );
      base64Data = buffer.toString("base64");
    } else {
      throw new ClaudeAttachmentError(
        "attachment_read_failed",
        "Image attachment does not contain readable image data.",
      );
    }

    if (base64Data) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: base64Data,
        },
      } as ImageBlockParam);
      imageBlockCount += 1;
    }
  }

  if (imageBlockCount === 0) {
    if (finalPrompt.trim().length === 0) {
      throw new Error("No valid image attachment was provided");
    }
    return finalPrompt;
  }

  // Wrap in an async iterable yielding a single SDKUserMessage
  const userMessage: SDKUserMessage = {
    type: "user",
    message: {
      role: "user",
      content: contentBlocks,
    },
    parent_tool_use_id: null,
  };

  async function* singleMessage(): AsyncIterable<SDKUserMessage> {
    yield userMessage;
  }

  return singleMessage();
}

/**
 * How often streamed deltas are folded into a published message snapshot.
 *
 * Rebuilding every ordered part, every message part, and a full-message SSE
 * frame per subscriber on **every token** made streaming O(turn size) per
 * token — the dominant allocation source in a long turn. Deltas still
 * accumulate immediately; only the rebuild + emit is deferred. Anything that
 * is not a delta flushes synchronously first, so event ordering is unchanged.
 */
const STREAM_EVENT_COALESCE_MS = 100;

/**
 * Send a prompt to a session and process the response
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  options?: PromptOptions,
  testHooks?: {
    afterAttachmentInitialValidation?: (filePath: string) => void | Promise<void>;
  },
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const structuredRequestId = options?.outputSchema
    ? (options.requestId?.trim() || crypto.randomUUID())
    : undefined;
  if (
    structuredRequestId
    && session.structuredOutputRequestId === structuredRequestId
    && (session.status === "running" || session.structuredOutput !== undefined)
  ) {
    // The HTTP response may have been lost. Reusing a structured request id
    // attaches to the original turn/result; it never launches another SDK query.
    return;
  }

  if (session.status === "running") {
    throw new Error("Session is already processing a prompt");
  }

  if (structuredRequestId) {
    session.structuredOutput = undefined;
    session.structuredOutputRequestId = structuredRequestId;
  }

  // Create abort controller for this query
  const abortController = new AbortController();
  session.abortController = abortController;
  session.status = "running";
  session.error = undefined;
  session.lastActivity = new Date();

  // Build the display prompt (what the user sees) - includes all attachment references
  let displayPrompt = prompt;
  if (options?.attachments && options.attachments.length > 0) {
    const attachmentTags = options.attachments
      .map(attachmentTag)
      .join("\n");
    displayPrompt = `${prompt}\n\n<attached-files>\n${attachmentTags}\n</attached-files>`;
  }

  // Build the SDK text prompt - excludes image attachments since those are sent as
  // inline base64 content blocks (bypassing the Read tool's 2000x2000 pixel limit).
  // File attachments are still included as XML tags so Claude can read them.
  let sdkTextPrompt = prompt;
  const fileAttachments = options?.attachments?.filter((att) => att.type !== "image") ?? [];
  if (fileAttachments.length > 0) {
    const fileTags = fileAttachments
      .map(attachmentTag)
      .join("\n");
    sdkTextPrompt = `${prompt}\n\n<attached-files>\n${fileTags}\n</attached-files>`;
  }

  // Build the final prompt for the SDK - includes planning mode instruction if enabled
  let finalPrompt = sdkTextPrompt;

  // If plan mode is enabled, instruct Claude to use the EnterPlanMode tool
  // This uses Claude's native planning mode which allows read-only exploration
  if (options?.permissionMode === "plan") {
    // The SDK injects its own read-only enforcement preamble + ExitPlanMode protocol
    // when permissionMode === "plan". We append guidance on *how* to plan well.
    const planModeInstruction = `<system-reminder>
The user has enabled PLANNING MODE via the UI. You are in plan mode.

Use this phase to:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Design a concrete implementation strategy
5. When ready, call ExitPlanMode with your plan to present it for approval

Plan mode is read-only: do not write or edit files until the user approves your plan via ExitPlanMode.
</system-reminder>

`;
    finalPrompt = planModeInstruction + sdkTextPrompt;
  }

  // Add user message with displayPrompt (what the user sees, without planning mode instruction).
  // Re-prompts (e.g. after plan rejection) use role "system" so they don't appear as user-typed.
  const messageRole = options?._isReprompt ? "system" : "user";
  const userMessage: NormalizedMessage = {
    id: generateMessageId(),
    role: messageRole,
    content: displayPrompt,
    parts: [{ type: "text", content: displayPrompt }],
    timestamp: new Date().toISOString(),
  };
  session.messages.push(userMessage);

  eventEmitter.emit({
    type: "message.updated",
    sessionId,
    data: { message: userMessage },
  });

  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: { status: "running" },
  });

  const startedAt = Date.now();
  let lastSdkMessageAt = Date.now();
  let sdkMessageCount = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let earlyWarningTimeout: ReturnType<typeof setTimeout> | null = null;
  let streamEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let queryIteratorControl: SessionState["queryControl"];
  // Hoisted out of the `try` so the error path can still publish whatever the
  // coalescing window was holding. Null until the streaming state it closes
  // over exists, which is everything before the SDK query is created.
  let flushPendingStreamedDeltas: (() => void) | null = null;

  try {
    // Create the query with Claude Agent SDK
    // Determine effort level: default to "high" if not specified
    const effortLevel = options?.effort ?? "high";
    // Use CWD env var if set (for local environments where bridge runs from its own dir)
    // This allows the Claude SDK to operate on the actual project directory
    const cwd = process.env.CWD || process.cwd();

    // Load MCP servers and plugins from config files. Both resolutions read
    // the same on-disk config, so they run concurrently and each merges once.
    const [{ servers: mcpServers, names: mcpServerNames }, plugins] = await Promise.all([
      getMcpRuntimeConfig(cwd),
      getPluginsForSdk(cwd),
    ]);

    const mcpServerCount = Object.keys(mcpServers).length;
    const pluginCount = plugins.length;
    // Determine permission mode: use provided option or default to "bypassPermissions".
    // Why: when the user requests "plan" mode we forward it as the SDK's actual
    // `"plan"` permissionMode. The SDK enforces read-only and runs its built-in
    // ExitPlanMode tool natively — without this, ExitPlanMode fails because the
    // CLI has no plan-mode state to exit.
    const permissionMode = options?.permissionMode ?? "bypassPermissions";

    const fastMode = options?.fastMode === true;

    console.log("[session-manager] Starting query", {
      sessionId,
      cwd,
      model: options?.model,
      resume: session.sdkSessionId ?? null,
      effortLevel,
      permissionMode,
      fastMode,
      mcpServerCount,
      mcpServerNames: Array.from(mcpServerNames),
      pluginCount,
      pluginPaths: plugins.map((p) => p.path),
    });
    const envPath = process.env.PATH;
    console.log("[session-manager] SDK env PATH", { path: envPath });
    const sdkPrompt = await buildSdkPrompt(
      finalPrompt,
      options?.attachments,
      cwd,
      testHooks?.afterAttachmentInitialValidation,
    );
    const queryIterator = query({
      prompt: sdkPrompt,
      options: {
        cwd,
        ...claudeExecutableOptions(),
        model: options?.model,
        agent: options?.agent,
        ...(options?.outputSchema
          ? {
              outputFormat: {
                type: "json_schema" as const,
                schema: options.outputSchema,
              },
            }
          : {}),
        permissionMode,
        // Required when using bypassPermissions mode
        ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
        // Use effort level to control thinking depth (replaces maxThinkingTokens)
        ...(effortLevel && { effort: effortLevel }),
        // Opus 4.7 defaults adaptive thinking display to "omitted" (signature only,
        // redacted text). Opt back into "summarized" so thinking content renders in the UI.
        thinking: { type: "adaptive", display: "summarized" },
        includePartialMessages: true,
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "Bash",
          "Glob",
          "Grep",
          "WebSearch",
          "WebFetch",
          "AskUserQuestion",
          "Task",
          // Allow all MCP tools
          "mcp:*",
        ],
        abortController,
        // A deterministic UUID makes the bridge id recoverable from the SDK's
        // persisted session store after a bridge restart.
        ...(session.sdkSessionId
          ? { resume: session.sdkSessionId }
          : {
              sessionId:
                sdkSessionIdFromBridgeId(session.id) ?? crypto.randomUUID(),
            }),
        enableFileCheckpointing: true,
        promptSuggestions: options?.promptSuggestions === true,
        agentProgressSummaries: true,
        // Use Claude Code system prompt with additional instructions
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "IMPORTANT: You MUST read a file before editing or writing to it. The Edit and Write tools will fail if you have not first used the Read tool to read the file in this conversation. Always read files before attempting to modify them.",
        },
        // Load user settings (from ~/.claude.json including MCP servers) and project settings (CLAUDE.md files)
        // Using "user" lets the SDK handle MCP server loading natively, which supports all transport types
        settingSources: options?.includeLocalSettings
          ? ["user", "project", "local"]
          : ["user", "project"],
        // Fast mode is a Claude Code setting (Opus 4.6 priority service tier).
        // Pass it through the flag-layer settings so the user can opt in per prompt.
        ...(fastMode && { settings: { fastMode: true } }),
        // Also pass MCP servers explicitly for any project-local .mcp.json overrides
        mcpServers: mcpServerCount > 0 ? mcpServers : undefined,
        // Load plugins from user config
        plugins: pluginCount > 0 ? plugins : undefined,
        // Handle AskUserQuestion tool to get user input
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        canUseTool: async (toolName: string, input: any) => {
          if (toolName === "AskUserQuestion") {
            // Create a question request and wait for user answer
            const questionId = generateMessageId();
            const questionRequest: QuestionRequest = {
              id: questionId,
              sessionId,
              questions: input.questions || [],
              toolUseId: questionId,
            };

            // Store the question
            pendingQuestions.set(questionId, questionRequest);

            // Emit event so frontend knows to show the question
            eventEmitter.emit({
              type: "question.asked",
              sessionId,
              data: questionRequest,
            });

            // Wait for answer with a Promise that can be resolved externally
            const answerPromise = new Promise<Record<string, string>>((resolve, reject) => {
              questionResolvers.set(questionId, { resolve, reject });
            });

            let questionTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              questionTimeoutId = setTimeout(() => {
                reject(new Error("Question timed out after 5 minutes"));
              }, QUESTION_TIMEOUT_MS);
            });

            try {
              const answers = await Promise.race([answerPromise, timeoutPromise]);
              console.log("[session-manager] Received answers for question:", questionId, answers);

              // Return the answers to the SDK
              return {
                behavior: "allow" as const,
                updatedInput: {
                  questions: input.questions,
                  answers,
                },
              };
            } catch (error) {
              console.error("[session-manager] Error waiting for answer:", error);
              const message = error instanceof Error
                ? error.message
                : "Question was cancelled";
              if (pendingQuestions.has(questionId)) {
                eventEmitter.emit({
                  type: "question.answered",
                  sessionId,
                  data: { requestId: questionId, cancelled: true },
                });
              }
              return { behavior: "deny" as const, message };
            } finally {
              // Cleanup
              if (questionTimeoutId) clearTimeout(questionTimeoutId);
              pendingQuestions.delete(questionId);
              questionResolvers.delete(questionId);
            }
          }

          // Handle EnterPlanMode - emit event so frontend can update plan mode state
          if (toolName === "EnterPlanMode") {
            console.log("[session-manager] EnterPlanMode requested", { sessionId });

            // Emit event so frontend knows to enter plan mode
            eventEmitter.emit({
              type: "plan.enter-requested",
              sessionId,
              data: { sessionId },
            });

            // Allow the tool to proceed
            return {
              behavior: "allow" as const,
              updatedInput: input,
            };
          }

          // Handle ExitPlanMode - wait for user approval before allowing
          if (toolName === "ExitPlanMode") {
            console.log("[session-manager] ExitPlanMode requested, waiting for user approval", { sessionId });

            // Create a plan approval request and wait for user decision
            const approvalId = generateMessageId();
            const approvalRequest: PlanApprovalRequest = {
              id: approvalId,
              sessionId,
              toolUseId: approvalId,
            };

            // Store the approval request and set up the resolver BEFORE emitting,
            // so an instant response from the UI can never find a missing resolver.
            pendingPlanApprovals.set(approvalId, approvalRequest);

            const approvalPromise = new Promise<PlanApprovalResponse>((resolve, reject) => {
              planApprovalResolvers.set(approvalId, { resolve, reject });
            });

            // Emit event so frontend knows to show the approval UI
            eventEmitter.emit({
              type: "plan.approval-requested",
              sessionId,
              data: approvalRequest,
            });

            let approvalTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              approvalTimeoutId = setTimeout(() => {
                reject(new Error("Plan approval timed out after 5 minutes"));
              }, PLAN_APPROVAL_TIMEOUT_MS);
            });

            try {
              const response = await Promise.race([approvalPromise, timeoutPromise]);
              console.log("[session-manager] Plan approval result:", approvalId, response);

              if (response.approved) {
                // User approved - emit exit event and allow the tool.
                // Mark `planApprovedThisTurn` so the fallback below can detect
                // the case where the SDK still fails the ExitPlanMode tool
                // (override the failure + re-prompt Claude to continue).
                planApprovedThisTurn = true;
                eventEmitter.emit({
                  type: "plan.exit-requested",
                  sessionId,
                  data: { sessionId },
                });

                return {
                  behavior: "allow" as const,
                  updatedInput: input,
                };
              } else {
                // User rejected - deny the tool and include feedback if provided.
                // Also capture the feedback so we can re-prompt Claude if the SDK
                // ends the turn after the denial (ExitPlanMode denial may terminate
                // the agent loop without Claude generating a revision).
                const feedbackMessage = response.feedback
                  ? `User feedback: "${response.feedback}"`
                  : "No specific feedback was provided.";
                const denyMessage = `User rejected the plan. ${feedbackMessage} Please revise your approach based on this feedback.`;

                // Store the raw feedback for potential re-prompt
                pendingPlanRejectionFeedback = response.feedback
                  ? `I've reviewed the plan and I'd like changes: ${response.feedback}\n\nPlease revise the plan based on this feedback.`
                  : `I've reviewed the plan and I don't approve it as-is. Please revise your approach.`;

                return {
                  behavior: "deny" as const,
                  message: denyMessage,
                };
              }
            } catch (error) {
              console.error("[session-manager] Error waiting for plan approval:", error);
              const errorMessage = error instanceof Error ? error.message : "Plan approval was cancelled";
              if (pendingPlanApprovals.has(approvalId)) {
                eventEmitter.emit({
                  type: "plan.approval-responded",
                  sessionId,
                  data: {
                    requestId: approvalId,
                    approved: false,
                    cancelled: true,
                  },
                });
              }
              // If error (e.g., timeout or dismissed), deny the tool use
              return { behavior: "deny" as const, message: errorMessage };
            } finally {
              // Cleanup
              if (approvalTimeoutId) clearTimeout(approvalTimeoutId);
              pendingPlanApprovals.delete(approvalId);
              planApprovalResolvers.delete(approvalId);
            }
          }

          // Allow all other tools - pass input through unchanged
          return { behavior: "allow" as const, updatedInput: input };
        },
      },
    });
    session.queryControl = queryIterator;
    queryIteratorControl = queryIterator;
    let supportedAgents: NonNullable<SessionInitData["agents"]> = [];
    if (typeof queryIterator.supportedAgents === "function") {
      try {
        supportedAgents = (await queryIterator.supportedAgents()).map((agent) => ({
          name: agent.name,
          description: agent.description,
          model: agent.model,
        }));
      } catch (error) {
        console.debug("[session-manager] Agent discovery unavailable:", error);
      }
    }

    // Log an early warning if SDK doesn't respond within 5 seconds
    earlyWarningTimeout = setTimeout(() => {
      if (sdkMessageCount === 0) {
        console.warn("[session-manager] SDK has not responded after 5 seconds", {
          sessionId,
          cwd,
          model: options?.model,
          status: session.status,
        });
      }
    }, 5000);

    heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastSdkMessageAt;
      if (idleMs > 15000) {
        console.warn("[session-manager] No SDK messages yet", {
          sessionId,
          idleMs,
          sdkMessageCount,
          status: session.status,
        });
      }
    }, 15000);

    // Track current assistant message for updates
    let currentAssistantMessage: NormalizedMessage | null = null;

    // Tool tracker persists across all messages in this turn
    const toolTracker = new ToolTracker();

    // The task list, unlike the tool tracker, persists across turns — Claude's
    // tasks survive from one prompt to the next, so the registry hangs off the
    // session and is created once.
    const taskRegistry = (session.taskRegistry ??= new TaskRegistry());

    // Track accumulated ordered parts (text, thinking, and tools in chronological order).
    //
    // Parts are grouped by API message id (`msg_…`) and, within a message, by
    // content-block index. This is the only identity that is stable across the
    // SDK events that describe one block:
    //   - every `stream_event` carries its own random `uuid`, so grouping deltas
    //     by `uuid` produces one part per delta (a "Thinking" row per token);
    //   - the SDK emits one non-streaming `assistant` message per content block,
    //     each with a fresh `uuid` but the same `message.id`, so grouping those
    //     by `uuid` appends a duplicate copy of already-streamed content.
    // Grouping by (api message id, block index) makes deltas collapse onto the
    // block they belong to and makes the final block overwrite what it streamed.
    const blocksByApiMessage = new Map<string, Map<number, OrderedPartEntry>>();
    // Blocks of each API message already reconciled from non-streaming `assistant`
    // messages. Those messages don't carry the stream's block index, but they
    // arrive in block order, so the running count is the index of the next block.
    const finalizedBlockCountByApiMessage = new Map<string, number>();
    // API message id of the stream currently being received (set by `message_start`).
    let currentStreamApiMessageId: string | null = null;
    // Fallback keys for messages that carry neither an API message id nor a uuid.
    let syntheticMessageKeyCounter = 0;

    // Flattened view of `blocksByApiMessage`, in message order then block order.
    let accumulatedOrderedParts: OrderedPartEntry[] = [];

    const getBlocksForMessage = (messageKey: string): Map<number, OrderedPartEntry> => {
      let blocks = blocksByApiMessage.get(messageKey);
      if (!blocks) {
        blocks = new Map<number, OrderedPartEntry>();
        blocksByApiMessage.set(messageKey, blocks);
      }
      return blocks;
    };

    const rebuildAccumulatedOrderedParts = () => {
      const parts: OrderedPartEntry[] = [];
      // Map iteration is insertion-ordered, which is API message arrival order.
      for (const blocks of blocksByApiMessage.values()) {
        for (const [, entry] of Array.from(blocks.entries()).sort(([a], [b]) => a - b)) {
          parts.push(entry);
        }
      }
      accumulatedOrderedParts = parts;
    };

    // Track active (pending) Task tool IDs for parent tracking
    // This allows us to associate child tools with their parent Task
    const activeTaskIds = new Set<string>();

    // Track plan rejection feedback so we can re-prompt Claude after the turn ends.
    // When ExitPlanMode is denied, the SDK may end the turn without Claude seeing
    // the feedback. We capture it here and re-send as a follow-up prompt.
    let pendingPlanRejectionFeedback: string | null = null;

    // ---------------------------------------------------------------------
    // Defensive fallback for the ExitPlanMode "approved but failed" case.
    //
    // Primary fix lives at the permissionMode site above: we now forward
    // `permissionMode: "plan"` to the SDK, so the SDK is genuinely in plan
    // mode and its native ExitPlanMode tool runs to success.
    //
    // The fallback below covers the case where the SDK's plan-mode handling
    // misbehaves (older SDK builds, future regressions, or unforeseen edge
    // cases): if the user explicitly approved the plan but the SDK still
    // marked the ExitPlanMode tool as `is_error`, we don't want to surface a
    // red "failure" to the user, and we don't want Claude to abandon the
    // turn. So we:
    //   1) Remember that the user approved this turn (`planApprovedThisTurn`).
    //   2) After every tool_result is parsed, scan the tool tracker for any
    //      ExitPlanMode tool that landed in "failure" state and rewrite it
    //      to "success" with an explanatory output. The UI then renders the
    //      tool the way the user expects.
    //   3) Set `pendingPlanApprovalContinuation` so that when the SDK ends
    //      the turn (which it usually does after a failed ExitPlanMode), we
    //      re-prompt Claude with a non-plan-mode follow-up telling them to
    //      continue with implementation.
    //
    // If the SDK behaves correctly (the expected case post-fix), the
    // ExitPlanMode tool is already in "success" state and none of the
    // override / re-prompt logic fires. The fallback is silent and free.
    // ---------------------------------------------------------------------
    let planApprovedThisTurn = false;
    let pendingPlanApprovalContinuation: string | null = null;

    // Parts exactly as last published to subscribers. Compared against the
    // freshly built parts to decide what a frame actually needs to carry.
    // Snapshotting the array is enough because parts are never mutated in
    // place: `ToolTracker` replaces a tool's object when its result lands, and
    // text/thinking parts are rebuilt from scratch each time.
    let publishedParts: NormalizedPart[] = [];
    let publishedMessageId: string | null = null;

    const emitCurrentAssistantMessage = () => {
      if (!currentAssistantMessage) return;
      const parts = currentAssistantMessage.parts;

      // A subscriber cannot patch a message it has never seen, so the first
      // frame for each message is always the whole thing.
      if (publishedMessageId !== currentAssistantMessage.id) {
        publishedMessageId = currentAssistantMessage.id;
        publishedParts = parts.slice();
        // Stamped on the message itself, before it is serialized, so both this
        // frame and any REST read of the transcript agree on the revision.
        currentAssistantMessage.revision = (currentAssistantMessage.revision ?? 0) + 1;
        eventEmitter.emit({
          type: "message.updated",
          sessionId,
          data: { message: currentAssistantMessage },
        });
        return;
      }

      const changedParts: { index: number; part: NormalizedPart }[] = [];
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part && !isSamePublishedPart(publishedParts[index], part)) {
          changedParts.push({ index, part });
        }
      }

      // Nothing moved and nothing was dropped: a frame here would only cost
      // the client a re-render of identical content. The revision must not
      // advance either — no frame was published, so nobody fell behind.
      if (changedParts.length === 0 && parts.length === publishedParts.length) {
        return;
      }

      publishedParts = parts.slice();
      currentAssistantMessage.revision = (currentAssistantMessage.revision ?? 0) + 1;
      eventEmitter.emit({
        type: "message.patched",
        sessionId,
        data: {
          messageId: currentAssistantMessage.id,
          partCount: parts.length,
          changedParts,
          timestamp: currentAssistantMessage.timestamp,
          revision: currentAssistantMessage.revision,
        } satisfies MessagePatchEventData,
      });
    };

    // Streamed-delta coalescing state. Deltas land in `blocksByApiMessage`
    // immediately; the expensive snapshot (ordered-part rebuild, part build,
    // full-message emit) happens at most once per STREAM_EVENT_COALESCE_MS.
    let streamEventsDirty = false;
    let lastStreamMessageKey: string | null = null;

    const flushStreamedAssistantMessage = () => {
      if (streamEventFlushTimer) {
        clearTimeout(streamEventFlushTimer);
        streamEventFlushTimer = null;
      }
      if (!streamEventsDirty) return;
      streamEventsDirty = false;

      rebuildAccumulatedOrderedParts();
      const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker);
      const content = getMessageTextFromParts(finalParts);

      if (!currentAssistantMessage) {
        if (!lastStreamMessageKey) return;
        currentAssistantMessage = {
          id: lastStreamMessageKey,
          role: "assistant",
          content,
          parts: finalParts,
          timestamp: new Date().toISOString(),
        };
        session.messages.push(currentAssistantMessage);
      } else {
        currentAssistantMessage.content = content;
        currentAssistantMessage.parts = finalParts;
      }

      emitCurrentAssistantMessage();
    };

    flushPendingStreamedDeltas = flushStreamedAssistantMessage;

    const scheduleStreamedAssistantMessageFlush = () => {
      streamEventsDirty = true;
      streamEventFlushTimer ??= setTimeout(() => {
        streamEventFlushTimer = null;
        flushStreamedAssistantMessage();
      }, STREAM_EVENT_COALESCE_MS);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyPartialAssistantMessage = (partialMessage: any): boolean => {
      const streamEvent = partialMessage.event;
      const eventType = streamEvent?.type;

      // `message_start` is the only stream event carrying the API message id;
      // every later event for the same message must inherit it.
      if (eventType === "message_start") {
        const apiMessageId = typeof streamEvent.message?.id === "string"
          ? streamEvent.message.id
          : undefined;
        currentStreamApiMessageId = apiMessageId ?? null;
        if (apiMessageId) {
          getBlocksForMessage(apiMessageId);
        }
        return false;
      }

      if (eventType === "message_stop") {
        currentStreamApiMessageId = null;
        return false;
      }

      const blockIndex = Number.isInteger(streamEvent?.index) && streamEvent.index >= 0
        ? streamEvent.index
        : undefined;
      if (blockIndex === undefined) {
        return false;
      }

      // Only fall back to the event uuid when no `message_start` was seen, which
      // real SDK streams always send before any block event.
      const messageKey = currentStreamApiMessageId
        ?? (typeof partialMessage.uuid === "string" ? partialMessage.uuid : undefined);
      if (!messageKey) {
        return false;
      }

      const entriesForMessage = getBlocksForMessage(messageKey);
      let entry = entriesForMessage.get(blockIndex);

      if (eventType === "content_block_start") {
        const contentBlock = streamEvent.content_block;
        if (contentBlock?.type === "text") {
          entry = {
            type: "text",
            value: typeof contentBlock.text === "string" ? contentBlock.text : "",
            timestamp: entry?.timestamp ?? new Date().toISOString(),
            messageUuid: messageKey,
          };
        } else if (contentBlock?.type === "thinking") {
          entry = {
            type: "thinking",
            value: typeof contentBlock.thinking === "string" ? contentBlock.thinking : "",
            timestamp: entry?.timestamp ?? new Date().toISOString(),
            messageUuid: messageKey,
          };
        } else {
          return false;
        }
      } else if (eventType === "content_block_delta") {
        const delta = streamEvent.delta;
        if (delta?.type === "text_delta") {
          entry = {
            type: "text",
            value: `${entry?.value ?? ""}${typeof delta.text === "string" ? delta.text : ""}`,
            timestamp: entry?.timestamp ?? new Date().toISOString(),
            messageUuid: messageKey,
          };
        } else if (delta?.type === "thinking_delta") {
          entry = {
            type: "thinking",
            value: `${entry?.value ?? ""}${typeof delta.thinking === "string" ? delta.thinking : ""}`,
            timestamp: entry?.timestamp ?? new Date().toISOString(),
            messageUuid: messageKey,
          };
        } else {
          return false;
        }
      } else {
        return false;
      }

      entriesForMessage.set(blockIndex, entry);
      lastStreamMessageKey = messageKey;
      scheduleStreamedAssistantMessageFlush();
      return true;
    };

    // Process the async generator
    for await (const message of queryIterator) {
      if (abortController.signal.aborted) {
        break;
      }

      sdkMessageCount += 1;
      lastSdkMessageAt = Date.now();
      // Fires once per streamed delta — i.e. per token. Both the object
      // literal and the write are guarded, not just the write.
      if (isDebugLoggingEnabled) {
        debugLog("[session-manager] SDK event received", {
          sessionId,
          type: message.type,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          subtype: (message as any)?.subtype,
          sdkMessageCount,
        });
      }

      // Deltas are coalesced; everything else must observe them in order, so
      // settle the pending snapshot before handling a non-delta message.
      if (message.type !== "stream_event") flushStreamedAssistantMessage();

      // Handle different message types from SDK
      if (message.type === "system" && message.subtype === "init") {
        // Store the SDK session ID for resume functionality
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const initMsg = message as any;
        const sdkSessionId = initMsg.session_id;
        if (sdkSessionId) {
          session.sdkSessionId = sdkSessionId;
          console.log("[session-manager] Session initialized, stored SDK session ID:", sdkSessionId);
        }

        // Capture MCP servers and plugins from init message
        // Note: Claude SDK sends MCP-provided plugins as MCP servers with "plugin:" prefix
        const allMcpServers = initMsg.mcp_servers || [];

        // Separate regular MCP servers from plugin-type MCP servers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const regularMcpServers = allMcpServers.filter((s: any) => !s.name?.startsWith("plugin:"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pluginMcpServers = allMcpServers.filter((s: any) => s.name?.startsWith("plugin:"));

        const mcpServerStatuses: McpServerRuntimeStatus[] = regularMcpServers.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) => ({
            name: s.name,
            status: s.status === "connected" ? "connected" : "failed",
            error: s.error,
            tools: s.tools,
          })
        );

        // Convert plugin-type MCP servers to plugin statuses
        // Also include any traditional plugins from initMsg.plugins
        const pluginStatuses: PluginRuntimeStatus[] = [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...pluginMcpServers.map((s: any) => ({
            name: s.name,
            path: undefined,
            status: (s.status === "connected" ? "loaded" : "failed") as "loaded" | "failed",
            error: s.error,
          })),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(initMsg.plugins || []).map((p: any) => ({
            name: p.name,
            path: p.path,
            status: (p.status === "loaded" ? "loaded" : "failed") as "loaded" | "failed",
            error: p.error,
          })),
        ];

        // Store init data in session
        session.initData = {
          mcpServers: mcpServerStatuses,
          plugins: pluginStatuses,
          slashCommands: initMsg.slash_commands,
          agents: supportedAgents,
        };

        console.log("[session-manager] Session init data captured", {
          sessionId,
          mcpServerCount: mcpServerStatuses.length,
          pluginCount: pluginStatuses.length,
          slashCommandCount: initMsg.slash_commands?.length ?? 0,
        });

        // Emit session.init event so frontend can update UI
        eventEmitter.emit({
          type: "session.init",
          sessionId,
          data: session.initData,
        });
      } else if (isSdkCompactBoundaryMessage(message as SdkMessageBase)) {
        // Handle /compact command result
        const compactMsg = message as SdkCompactBoundaryMessage;
        const compactMetadata = compactMsg.compact_metadata || {};

        console.log("[session-manager] Compact boundary received", {
          sessionId,
          preTokens: compactMetadata.pre_tokens,
          trigger: compactMetadata.trigger,
        });

        // Emit event so frontend can show feedback
        eventEmitter.emit({
          type: "system.compact",
          sessionId,
          data: {
            preTokens: compactMetadata.pre_tokens,
            postTokens: compactMetadata.post_tokens,
            trigger: compactMetadata.trigger,
          },
        });
      } else if (message.type === "prompt_suggestion") {
        const suggestion =
          typeof (message as { suggestion?: unknown }).suggestion === "string"
            ? (message as { suggestion: string }).suggestion.trim()
            : "";
        if (suggestion) {
          session.promptSuggestion = suggestion;
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: { promptSuggestion: suggestion },
          });
        }
      } else if (message.type === "rate_limit_event") {
        const info = (message as {
          rate_limit_info?: {
            rateLimitType?: string;
            utilization?: number;
            resetsAt?: number;
          };
        }).rate_limit_info;
        if (info) {
          const label = (info.rateLimitType ?? "usage")
            .replaceAll("_", " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
          const nextWindow = {
            label,
            usedPercent: info.utilization,
            resetsAt:
              typeof info.resetsAt === "number"
                ? new Date(info.resetsAt).toISOString()
                : undefined,
          };
          const existing = session.usage?.rateLimits ?? [];
          if (session.usage) {
            session.usage = {
              ...session.usage,
              rateLimits: [
                ...existing.filter((window) => window.label !== label),
                nextWindow,
              ],
              updatedAt: new Date().toISOString(),
            };
            eventEmitter.emit({
              type: "session.updated",
              sessionId,
              data: { contextUsage: session.usage },
            });
          }
        }
      } else if (message.type === "system") {
        // Handle other system messages (log for debugging)
        const sysMsg = message as SdkSystemMessage;
        console.log("[session-manager] System message received", {
          sessionId,
          subtype: sysMsg.subtype,
        });

        const taskMessage = message as {
          subtype?: string;
          task_id?: string;
          description?: string;
          patch?: {
            status?: BackgroundTaskSnapshot["status"];
            description?: string;
            end_time?: number;
            error?: string;
            is_backgrounded?: boolean;
          };
        };
        if (
          (taskMessage.subtype === "task_started"
            || taskMessage.subtype === "task_progress"
            || taskMessage.subtype === "task_updated")
          && taskMessage.task_id
        ) {
          const previous = session.backgroundTasks?.[taskMessage.task_id];
          const task: BackgroundTaskSnapshot = {
            id: taskMessage.task_id,
            description:
              taskMessage.patch?.description
              ?? taskMessage.description
              ?? previous?.description,
            status:
              taskMessage.patch?.status
              ?? previous?.status
              ?? "running",
            isBackgrounded:
              taskMessage.patch?.is_backgrounded
              ?? previous?.isBackgrounded,
            startedAt: previous?.startedAt ?? Date.now(),
            endedAt: taskMessage.patch?.end_time ?? previous?.endedAt,
            error: taskMessage.patch?.error ?? previous?.error,
          };
          session.backgroundTasks = {
            ...(session.backgroundTasks ?? {}),
            [task.id]: task,
          };
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: { backgroundTasks: session.backgroundTasks },
          });
        }

        // Emit generic system event for other subtypes
        if (sysMsg.subtype && sysMsg.subtype !== "init") {
          eventEmitter.emit({
            type: "system.message",
            sessionId,
            data: {
              subtype: sysMsg.subtype,
              message: sysMsg,
            },
          });
        }
      } else if (message.type === "assistant") {
        // If we receive a new assistant message after a plan denial, it means
        // the SDK continued the agent loop and Claude did see the feedback.
        // Clear the pending feedback so we don't re-prompt unnecessarily.
        if (pendingPlanRejectionFeedback) {
          console.log("[session-manager] Claude responded after plan denial, clearing re-prompt feedback", { sessionId });
          pendingPlanRejectionFeedback = null;
        }

        // Assistant message - parse content and register tools with tracker
        const { orderedParts, newTaskIds, contentBlockCount } = parseMessageContent(
          message,
          toolTracker,
          mcpServerNames,
          activeTaskIds,
          taskRegistry
        );

        // Update active Task tracking - add new Tasks
        for (const taskId of newTaskIds) {
          activeTaskIds.add(taskId);
        }

        // Group by API message id so these blocks land on top of the partial
        // events that streamed them (see `blocksByApiMessage`). The SDK sends one
        // assistant message per content block, all sharing `message.id`, so the
        // running finalized-block count gives each block its stream index.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const apiMessageId = (message as any).message?.id as string | undefined;
        const messageKey = apiMessageId
          ?? (message.uuid as string | undefined)
          ?? `assistant-${(syntheticMessageKeyCounter += 1)}`;

        const blocks = getBlocksForMessage(messageKey);
        const blockIndexBase = finalizedBlockCountByApiMessage.get(messageKey) ?? 0;
        for (const part of orderedParts) {
          const blockIndex = blockIndexBase + (part.blockOffset ?? 0);
          const streamedPart = blocks.get(blockIndex);
          blocks.set(blockIndex, {
            ...part,
            timestamp: streamedPart?.timestamp ?? new Date().toISOString(),
            messageUuid: messageKey,
          });
        }
        finalizedBlockCountByApiMessage.set(messageKey, blockIndexBase + contentBlockCount);
        rebuildAccumulatedOrderedParts();

        // Build final parts maintaining chronological order
        const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker);
        // Derive content from the accumulated parts rather than this SDK message
        // alone. The SDK splits one API message into one `assistant` message per
        // content block, so `content` here only holds the current block's text and
        // would blank out the turn's text whenever the block is thinking/tool_use.
        const accumulatedContent = getMessageTextFromParts(finalParts);

        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: messageKey,
            role: "assistant",
            content: accumulatedContent,
            parts: finalParts,
            timestamp: new Date().toISOString(),
          };
          session.messages.push(currentAssistantMessage);
          debugLog("[session-manager] Created assistant message", {
            sessionId,
            messageId: currentAssistantMessage.id,
          });
        } else {
          currentAssistantMessage.content = accumulatedContent;
          currentAssistantMessage.parts = finalParts;
          debugLog("[session-manager] Updated assistant message", {
            sessionId,
            messageId: currentAssistantMessage.id,
          });
        }

        emitCurrentAssistantMessage();
      } else if (message.type === "user") {
        // User message with tool results - parse to update tool tracker
        const { completedTaskIds } = parseMessageContent(
          message,
          toolTracker,
          mcpServerNames,
          activeTaskIds,
          taskRegistry
        );

        // Update active Task tracking - remove completed Tasks
        for (const taskId of completedTaskIds) {
          activeTaskIds.delete(taskId);
        }

        // Defensive fallback: if the user approved the plan this turn but the
        // SDK still reported the ExitPlanMode tool as a failure, rewrite the
        // tracked tool to "success" so the UI doesn't show a red failure for
        // something the user explicitly approved. Capture a continuation
        // re-prompt so Claude doesn't just abandon the turn. See the comment
        // block where `planApprovedThisTurn` is declared for full context.
        if (planApprovedThisTurn) {
          for (const tool of toolTracker.getTools()) {
            if (
              tool.toolName === "ExitPlanMode" &&
              tool.toolState === "failure" &&
              tool.toolUseId
            ) {
              console.warn(
                "[session-manager] ExitPlanMode reported failure despite user approval — overriding to success and scheduling continuation re-prompt",
                { sessionId, toolUseId: tool.toolUseId, sdkError: tool.toolError }
              );
              toolTracker.updateToolResult(tool.toolUseId, {
                state: "success",
                output:
                  "Plan approved by the user. Proceeding with implementation.",
                error: undefined,
              });
              if (!pendingPlanApprovalContinuation) {
                pendingPlanApprovalContinuation =
                  "The user has approved your plan. Please proceed with implementing it now. You are no longer in plan mode and may write, edit, and run commands as needed.";
              }
            }
          }
        }

        // Rebuild message parts with updated tool results
        if (currentAssistantMessage) {
          const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker);
          currentAssistantMessage.parts = finalParts;

          emitCurrentAssistantMessage();
        }
        // Skip adding user message replay as we already added it
      } else if (isSdkResultMessage(message as SdkMessageBase)) {
        // Query completed - log full result for debugging
        const resultMsg = message as SdkResultMessage;
        console.log("[session-manager] Query result", {
          sessionId,
          subtype: resultMsg.subtype,
          result: resultMsg.result,
          costUSD: resultMsg.total_cost_usd,
          durationMs: resultMsg.duration_ms,
        });

        const exactUsage = await buildClaudeUsageSnapshot(
          session,
          resultMsg,
          session.queryControl,
          options?.model,
        );
        if (exactUsage) {
          session.usage = exactUsage;
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: {
              contextUsage: exactUsage,
            },
          });
        }

        if (resultMsg.subtype === "success") {
          if (options?.outputSchema) {
            if (resultMsg.structured_output === undefined) {
              const failure = structuredOutputFailure(
                "claude",
                "malformed_output",
                "Claude completed the turn without a structured result.",
                { requestId: structuredRequestId },
              );
              recordStructuredOutput(session, failure);
              throw new ClaudeStructuredOutputError(failure);
            }
            recordStructuredOutput(session, {
              ok: true,
              provider: "claude",
              requestId: structuredRequestId,
              value: resultMsg.structured_output,
            });
          }
          console.log("[session-manager] Query completed successfully", { sessionId });
        } else {
          console.error("[session-manager] Query error:", resultMsg.subtype, { sessionId });
          const resultError = resultMsg.errors?.filter(Boolean).join("\n")
            || `Claude query failed: ${resultMsg.subtype}`;
          if (options?.outputSchema) {
            const failure = structuredOutputFailure(
              "claude",
              resultMsg.subtype === "error_max_structured_output_retries"
                ? "schema_retry_exhausted"
                : "provider_error",
              resultError,
              {
                requestId: structuredRequestId,
                details: { subtype: resultMsg.subtype ?? "unknown" },
              },
            );
            recordStructuredOutput(session, failure);
            throw new ClaudeStructuredOutputError(failure);
          }
          throw new Error(resultError);
        }
      } else if (message.type === "stream_event") {
        applyPartialAssistantMessage(message);
      }
      // Note: AskUserQuestion tool handling is done in the canUseTool callback above
    }

    // The stream can end on a delta (abort, SDK hang-up) with a snapshot still
    // pending; publish it so the transcript holds everything that streamed.
    flushStreamedAssistantMessage();

    if (abortController.signal.aborted) {
      if (options?.outputSchema && structuredRequestId) {
        recordStructuredOutput(
          session,
          structuredOutputFailure(
            "claude",
            "interrupted",
            "Claude structured-output turn was interrupted.",
            { requestId: structuredRequestId, retryable: true },
          ),
        );
      }
      return;
    }

    // If a plan was rejected with feedback but the SDK ended the turn without
    // Claude revising, re-send the feedback as a follow-up prompt so Claude
    // actually sees it and generates a revised plan.
    // Guard: only re-prompt once (skip if this call is itself a re-prompt).
    if (pendingPlanRejectionFeedback && !abortController.signal.aborted && !options?._isReprompt) {
      const feedbackPrompt = pendingPlanRejectionFeedback;
      pendingPlanRejectionFeedback = null;

      console.log("[session-manager] Re-prompting with plan rejection feedback", { sessionId });

      // Reset status to idle temporarily so sendPrompt can be called
      session.status = "idle";
      session.abortController = undefined;

      // Re-prompt with plan mode preserved, attachments stripped, and _isReprompt
      // set to prevent infinite recursion if this re-prompt also gets rejected.
      const repromptOptions: PromptOptions = {
        model: options?.model,
        effort: options?.effort,
        fastMode: options?.fastMode,
        permissionMode: "plan",
        _isReprompt: true,
      };

      try {
        await sendPrompt(sessionId, feedbackPrompt, repromptOptions);
        // sendPrompt handles setting idle status and emitting events, so return early
        return;
      } catch (repromptError) {
        console.error("[session-manager] Failed to re-prompt with plan feedback:", repromptError);
        return Promise.reject(repromptError);
      }
    }

    // Defensive fallback continuation: see the comment block on
    // `planApprovedThisTurn` above. If the SDK failed the ExitPlanMode tool
    // despite an approval (we already overrode the tool state to success in
    // the message loop), re-prompt Claude WITHOUT plan mode so it actually
    // implements the approved plan instead of ending the turn.
    // Guard: skip if this call is itself a re-prompt to avoid recursion.
    if (
      pendingPlanApprovalContinuation &&
      !abortController.signal.aborted &&
      !options?._isReprompt
    ) {
      const continuationPrompt = pendingPlanApprovalContinuation;
      pendingPlanApprovalContinuation = null;

      console.log("[session-manager] Re-prompting after approved-plan ExitPlanMode failure", {
        sessionId,
      });

      session.status = "idle";
      session.abortController = undefined;

      // Drop plan mode for the continuation re-prompt — the user has approved,
      // so Claude needs the full toolset (Write/Edit/Bash) to implement.
      // Attachments are intentionally not forwarded: the SDK has already seen
      // them in the conversation history, and re-sending them on a synthetic
      // system-role continuation could double-count their content. Matches
      // the pendingPlanRejectionFeedback re-prompt path above.
      const repromptOptions: PromptOptions = {
        model: options?.model,
        effort: options?.effort,
        fastMode: options?.fastMode,
        _isReprompt: true,
      };

      try {
        await sendPrompt(sessionId, continuationPrompt, repromptOptions);
        return;
      } catch (repromptError) {
        console.error(
          "[session-manager] Failed to re-prompt after plan approval:",
          repromptError
        );
        return Promise.reject(repromptError);
      }
    }

    // Generate a session title from the first user message if title is still the default
    const isDefaultTitle = session.title === `Session ${session.id.slice(-6)}`;
    if (isDefaultTitle && !options?._isReprompt && !session.titleGenerationPending) {
      session.titleGenerationPending = true;
      void generateAndSetSessionTitle(sessionId, prompt);
    }

    session.status = "idle";
    session.abortController = undefined;

    eventEmitter.emit({
      type: "session.idle",
      sessionId,
      data: { success: true },
    });

    console.debug("[session-manager] Prompt completed", {
      sessionId,
      sdkMessageCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // The turn died mid-stream with deltas still coalescing. Publish them
    // before anything else here: the alternative is that the last window of
    // streamed text is silently dropped from the transcript, and the `finally`
    // below discards the pending timer, so this is the last chance to emit it.
    // Ordered before the failure is recorded so the client sees the completed
    // message first and `session.error` stays terminal.
    flushPendingStreamedDeltas?.();

    if (abortController.signal.aborted) {
      if (options?.outputSchema && structuredRequestId && !session.structuredOutput) {
        recordStructuredOutput(
          session,
          structuredOutputFailure(
            "claude",
            "interrupted",
            "Claude structured-output turn was interrupted.",
            { requestId: structuredRequestId, retryable: true },
          ),
        );
      }
      return;
    }
    console.error("[session-manager] Error processing prompt:", error);

    if (session.abortController === abortController) {
      if (
        options?.outputSchema
        && structuredRequestId
        && !session.structuredOutput
      ) {
        recordStructuredOutput(
          session,
          structuredOutputFailure(
            "claude",
            "provider_error",
            error instanceof Error ? error.message : String(error),
            { requestId: structuredRequestId },
          ),
        );
      }
      session.status = "error";
      session.error = error instanceof Error ? error.message : String(error);
      session.abortController = undefined;
      cleanupPendingInteractions(sessionId);

      eventEmitter.emit({
        type: "session.error",
        sessionId,
        data: {
          error: session.error,
          ...(error instanceof ClaudeAttachmentError
            ? { code: error.code }
            : {}),
        },
      });
    }
    throw error;
  } finally {
    if (session.queryControl === queryIteratorControl) {
      session.queryControl = undefined;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (earlyWarningTimeout) {
      clearTimeout(earlyWarningTimeout);
    }
    if (streamEventFlushTimer) {
      // Every exit path has already flushed synchronously (after the loop, or
      // at the top of the catch), so anything still armed here is a timer with
      // nothing left to publish. Clearing it stops a late callback emitting a
      // duplicate snapshot after session.idle/session.error.
      clearTimeout(streamEventFlushTimer);
      streamEventFlushTimer = null;
    }
  }
}

/**
 * Answer a pending question
 * @param requestId - The question request ID
 * @param answers - Record mapping question text to selected answer text
 */
export function answerQuestion(
  requestId: string,
  answers: Record<string, string>
): boolean {
  const question = pendingQuestions.get(requestId);
  if (!question) {
    console.log("[session-manager] Question not found for requestId:", requestId);
    return false;
  }

  console.log("[session-manager] Answering question:", requestId, "with answers:", answers);

  const resolver = questionResolvers.get(requestId);
  if (resolver) {
    console.log("[session-manager] Resolving promise for question:", requestId);
    resolver.resolve(answers);
    questionResolvers.delete(requestId);
  } else {
    console.log("[session-manager] No resolver found for question:", requestId);
  }

  pendingQuestions.delete(requestId);

  eventEmitter.emit({
    type: "question.answered",
    sessionId: question.sessionId,
    data: { requestId, answers },
  });

  return true;
}

/**
 * Dismiss a pending question and release the SDK callback waiting for it.
 */
export function dismissQuestion(requestId: string): boolean {
  const question = pendingQuestions.get(requestId);
  if (!question) {
    return false;
  }

  const resolver = questionResolvers.get(requestId);
  if (resolver) {
    resolver.reject(new Error("User dismissed the question"));
    questionResolvers.delete(requestId);
  }
  pendingQuestions.delete(requestId);

  eventEmitter.emit({
    type: "question.answered",
    sessionId: question.sessionId,
    data: { requestId, dismissed: true },
  });

  return true;
}

/**
 * Get pending questions for a session
 */
export function getPendingQuestions(
  sessionId?: string
): QuestionRequest[] {
  const questions = Array.from(pendingQuestions.values());
  if (sessionId) {
    return questions.filter((q) => q.sessionId === sessionId);
  }
  return questions;
}

/**
 * Respond to a pending plan approval request
 * @param requestId - The plan approval request ID
 * @param approved - Whether the user approved the plan
 * @param feedback - Optional feedback message from the user (used when rejecting)
 */
export function respondToPlanApproval(
  requestId: string,
  approved: boolean,
  feedback?: string
): boolean {
  const approval = pendingPlanApprovals.get(requestId);
  if (!approval) {
    console.log("[session-manager] Plan approval not found for requestId:", requestId);
    return false;
  }

  console.log("[session-manager] Responding to plan approval:", requestId, "approved:", approved, "feedback:", feedback);

  const resolver = planApprovalResolvers.get(requestId);
  if (resolver) {
    console.log("[session-manager] Resolving promise for plan approval:", requestId);
    resolver.resolve({ approved, feedback });
    planApprovalResolvers.delete(requestId);
  } else {
    console.log("[session-manager] No resolver found for plan approval:", requestId);
  }

  pendingPlanApprovals.delete(requestId);

  eventEmitter.emit({
    type: "plan.approval-responded",
    sessionId: approval.sessionId,
    data: { requestId, approved, feedback },
  });

  return true;
}

/**
 * Get pending plan approvals for a session
 */
export function getPendingPlanApprovals(
  sessionId?: string
): PlanApprovalRequest[] {
  const approvals = Array.from(pendingPlanApprovals.values());
  if (sessionId) {
    return approvals.filter((a) => a.sessionId === sessionId);
  }
  return approvals;
}

/**
 * Get session initialization data (MCP servers, plugins, slash commands)
 */
export function getSessionInitData(sessionId: string): SessionInitData | undefined {
  const session = sessions.get(sessionId);
  return session?.initData;
}

/**
 * Get available models from the Claude Agent SDK
 * The supportedModels() method is available on the Query object returned by query()
 */
export async function getAvailableModelCatalog(): Promise<{
  models: ModelInfo[];
  source: "sdk" | "fallback";
}> {
  let q: ReturnType<typeof query> | undefined;
  try {
    const cwd = process.env.CWD || process.cwd();
    console.log("[session-manager] Fetching supported models", { cwd });
    // Create a query object to access supportedModels()
    // We use maxTurns: 0 to prevent any actual processing
    q = query({
      prompt: "",
      options: {
        maxTurns: 0,
        cwd,
        ...claudeExecutableOptions(),
      },
    });

    // Get supported models from the query object
    const models = await q.supportedModels();
    console.log("[session-manager] Supported models fetched", { count: models.length });

    return {
      source: "sdk",
      models: models.map((model) => ({
        id: model.value,
        resolvedModel: model.resolvedModel,
        name: model.displayName,
        description: model.description,
        supportsFastMode: model.supportsFastMode,
        supportsEffort: model.supportsEffort,
        supportedEffortLevels: model.supportedEffortLevels,
        supportsAdaptiveThinking: model.supportsAdaptiveThinking,
        supportsAutoMode: model.supportsAutoMode,
      })),
    };
  } catch (error) {
    console.error("[session-manager] Error fetching supported models:", error);
    // Return fallback models if SDK call fails
    return {
      source: "fallback",
      models: [
      {
        id: "default",
        resolvedModel: "claude-opus-5[1m]",
        name: "Default (recommended)",
        description: "Opus 5 with 1M context · Best for everyday, complex tasks",
        supportsFastMode: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "opus[1m]",
        resolvedModel: "claude-opus-5[1m]",
        name: "Opus (1M context)",
        description: "Opus 5 with 1M context · Best for everyday, complex tasks",
        supportsFastMode: true,
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "claude-fable-5[1m]",
        resolvedModel: "claude-fable-5",
        name: "Fable",
        description: "Fable 5 · Most capable for your hardest and longest-running tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "sonnet",
        resolvedModel: "claude-sonnet-5",
        name: "Sonnet",
        description: "Sonnet 5 · Efficient for routine tasks",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        name: "Haiku",
        description: "Haiku 4.5 · Fastest for quick answers",
      },
      ],
    };
  } finally {
    if (q?.return) {
      try {
        await q.return();
      } catch (error) {
        console.debug("[session-manager] Failed to clean up model query:", error);
      }
    }
  }
}

export async function getAvailableModels(): Promise<ModelInfo[]> {
  return (await getAvailableModelCatalog()).models;
}

export async function getClaudeRuntimeVersions(): Promise<{
  sdkVersion?: string;
  cliVersion?: string;
}> {
  let sdkVersion: string | undefined;
  let bundledCliVersion: string | undefined;
  try {
    const sdkEntryUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    const manifest = JSON.parse(
      await readFile(new URL("./package.json", sdkEntryUrl), "utf8"),
    ) as { version?: string; claudeCodeVersion?: string };
    sdkVersion = manifest.version;
    bundledCliVersion = manifest.claudeCodeVersion;
  } catch (error) {
    console.debug("[session-manager] Failed to read Claude SDK version:", error);
  }

  const executable = process.env.CLAUDE_CLI_PATH?.trim();
  if (!executable) {
    return { sdkVersion, cliVersion: bundledCliVersion };
  }

  try {
    const output = execFileSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return {
      sdkVersion,
      cliVersion: output.match(/\d+\.\d+\.\d+/)?.[0] ?? bundledCliVersion,
    };
  } catch (error) {
    console.debug("[session-manager] Failed to read Claude CLI version:", error);
    return { sdkVersion, cliVersion: bundledCliVersion };
  }
}
