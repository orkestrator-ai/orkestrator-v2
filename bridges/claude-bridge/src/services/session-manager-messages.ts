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
  QuestionInfo,
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
  SessionRateLimitWindow,
  StopBackgroundTaskResult,
} from "../types/index.js";
import { isSdkCompactBoundaryMessage, isSdkResultMessage } from "../types/index.js";
import { TaskRegistry, isTaskListTool } from "@orkestrator/protocol/task-list";
import { AGENT_INTERACTION_DEFAULT_TIMEOUT_MS } from "@orkestrator/protocol/agent-interactions";
import {
  isRootAssistantRecord,
  normalizeBackendModelId,
} from "@orkestrator/protocol/model-id";
import {
  structuredOutputFailure,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { eventEmitter } from "./event-emitter.js";
import {
  deleteSessionPreferences,
  MAX_DISPATCHED_REQUEST_IDS,
  readSessionPreferences,
  sessionPreferencesUnavailable,
  updateSessionPreferences,
  type SessionPreferences,
} from "./session-preferences.js";
import { runtimeEnvironmentForAgentQuery } from "./runtime-env.js";
import { debugLog, isDebugLoggingEnabled } from "./logger.js";
import { applyDiffBudget, applyToolResultBudget } from "./part-budget.js";
import { getMcpRuntimeConfig } from "./mcp-config.js";
import { getPluginsForSdk } from "./plugin-config.js";
import type { McpToolMetadata } from "../types/mcp.js";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import * as core from "./session-manager-core.js";
import {
  generateMessageId,
} from "./session-manager-core.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  boundBackgroundTaskHistory,
} from "./session-manager-background-tasks.js";
export class ToolTracker {
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
export interface OrderedPartEntry {
  type: "thinking" | "tool-ref" | "text";
  /** For thinking: the thinking content. For tool-ref: the tool use ID. For text: the text content */
  value: string;
  /**
   * Streamed deltas not yet folded into `value`.
   *
   * Deltas arrive once per token, and appending each one to `value` directly
   * rebuilt the block's whole string per token — O(n²) over a large block.
   * The streaming path buffers them here and `materializeEntryValue` joins
   * them once per coalesced flush; nothing reads `value` in between.
   */
  pendingChunks?: string[];
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
export function parseMcpToolName(
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
export function isTaskToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "task" || normalized === "agent";
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
export function parseMessageContent(
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
        parentTaskUseId: explicitParentTaskUseId,
        blockOffset,
      });
    } else if (block.type === "thinking") {
      const thinkingContent = block.thinking || "";
      thinkingParts.push({
        type: "thinking",
        content: thinkingContent,
        parentTaskUseId: explicitParentTaskUseId,
      });
      // Track order: add thinking entry
      orderedParts.push({
        type: "thinking",
        value: thinkingContent,
        messageUuid,
        parentTaskUseId: explicitParentTaskUseId,
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
export function buildMessageParts(
  orderedParts: OrderedPartEntry[],
  toolTracker: ToolTracker,
): NormalizedPart[] {
  const result: NormalizedPart[] = [];

  for (const entry of orderedParts) {
    if (entry.type === "thinking") {
      result.push({
        type: "thinking",
        content: entry.value,
        createdAt: entry.timestamp,
        sourcePartId: entry.messageUuid,
        parentTaskUseId: entry.parentTaskUseId,
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
        createdAt: entry.timestamp,
        sourcePartId: entry.messageUuid,
        parentTaskUseId: entry.parentTaskUseId,
      });
    }
  }

  return result;
}

export interface BackgroundTaskSystemMessage {
  subtype:
    | "task_started"
    | "task_progress"
    | "task_updated"
    | "task_notification";
  task_id: string;
  tool_use_id?: string;
  description?: string;
  summary?: string;
  status?: "completed" | "failed" | "stopped";
  patch?: {
    status?: BackgroundTaskSnapshot["status"];
    description?: string;
    end_time?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
}

export const MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH = 512;
export const MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH = 4_096;
export const MAX_PERSISTED_TIMESTAMP_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function persistedTaskIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH
  ) {
    return undefined;
  }
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH
    || /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

export function persistedTaskText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value
    .slice(0, MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH + 1)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH);
  // Do not expose a dangling UTF-16 high surrogate when the byte-unaware
  // bound cuts immediately between an emoji's two code units.
  if (/[\ud800-\udbff]$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export interface BackgroundTaskLaunch {
  id: string;
  toolUseId?: string;
  description?: string;
}

export const PROVISIONAL_BACKGROUND_TASK_PREFIX = "pending-bash:";
export const MAX_BACKGROUND_TASK_CANDIDATES = 128;

export function provisionalBackgroundTaskId(toolUseId: string): string {
  return `${PROVISIONAL_BACKGROUND_TASK_PREFIX}${toolUseId}`;
}

export const BACKGROUND_TASK_LABEL_BODY =
  "(?:Command running in background with ID:"
  + "|Command was manually backgrounded by user with ID:"
  + "|Command [^\\r\\n]{0,160}\\btimeout and was moved to the background \\(ID:"
  + "|Background task ID:)\\s*([A-Za-z0-9_-]+)";
/** Anchored to a line start; used only once provider-authored intent exists. */
export const LINE_LEADING_BACKGROUND_TASK_LABEL = new RegExp(
  `(?:^|\\n)[ \\t]*${BACKGROUND_TASK_LABEL_BODY}`,
  "i",
);
/** Anchored to the start of the whole result; used to *establish* intent. */
export const EXCLUSIVE_BACKGROUND_TASK_LABEL = new RegExp(
  `^${BACKGROUND_TASK_LABEL_BODY}`,
  "i",
);

export function backgroundTaskResultText(content: unknown): string {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
        .filter((block): block is { type: "text"; text: string } =>
          block !== null
          && typeof block === "object"
          && (block as { type?: unknown }).type === "text"
          && typeof (block as { text?: unknown }).text === "string")
        .map((block) => block.text)
        .join("\n")
      : "";
}

export function backgroundTaskIdFromToolResultContent(content: unknown): string | undefined {
  const match = backgroundTaskResultText(content).match(
    LINE_LEADING_BACKGROUND_TASK_LABEL,
  );
  return persistedTaskIdentifier(match?.[1]);
}

/**
 * The provider's backgrounding notice, and nothing else.
 *
 * A Bash `tool_result` is the command's own stdout whenever the command ran in
 * the foreground, so treating a label found *anywhere* in it as evidence lets
 * ordinary output (`cat` of a file, a build log, a help text) mint a background
 * task that no provider lifecycle frame will ever settle — which pins the CLI
 * process and the session's transcript for the lifetime of the bridge. When a
 * command really is backgrounded the notice replaces the output entirely
 * ("Output is being written."), so requiring it to be the complete, single-line
 * result is both the provider's actual shape and the only boundary available
 * once `tool_use_result` is missing.
 *
 * A command whose entire output is exactly this label can still spoof one task.
 * That residue is accepted: it needs a deliberate `echo`, not incidental output,
 * and the resulting task is visible and stoppable from the session UI.
 */
export function exclusiveBackgroundTaskLabelId(content: unknown): string | undefined {
  const text = backgroundTaskResultText(content).trim();
  if (text.length === 0 || /[\r\n]/.test(text)) return undefined;
  return persistedTaskIdentifier(text.match(EXCLUSIVE_BACKGROUND_TASK_LABEL)?.[1]);
}

export interface CorrelatedBashToolResult {
  toolUseId: string;
  content?: unknown;
  failed: boolean;
}

export function correlatedBashToolResults(
  message: SDKUserMessage,
  toolTracker: ToolTracker,
): CorrelatedBashToolResult[] {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const results: CorrelatedBashToolResult[] = [];
  for (const block of content) {
    if (
      !block
      || typeof block !== "object"
      || (block as { type?: unknown }).type !== "tool_result"
    ) {
      continue;
    }
    const result = block as {
      tool_use_id?: unknown;
      content?: unknown;
      is_error?: unknown;
    };
    const toolUseId = persistedTaskIdentifier(result.tool_use_id);
    if (!toolUseId || toolTracker.getTool(toolUseId)?.toolName !== "Bash") continue;
    results.push({
      toolUseId,
      content: result.content,
      failed: result.is_error === true,
    });
  }
  return results;
}

/**
 * The id of the single Bash `tool_result` that `tool_use_result` can describe.
 *
 * `tool_use_result` is one flat object per message and never names the block it
 * belongs to, so it may only be read when the message carries exactly one
 * tool result. Correlation is a security boundary here: MCP and dynamic tools
 * may return arbitrary objects whose field names collide with the built-in
 * Bash result. A failed or malformed block disqualifies the whole message
 * rather than being skipped, which would silently promote some other block.
 */
export function exclusiveBashToolResultId(
  message: SDKUserMessage,
  toolTracker: ToolTracker,
): string | undefined {
  const content = (
    message.message as { content?: unknown } | undefined
  )?.content;
  const toolUseIds: string[] = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: unknown }).type === "tool_result"
      ) {
        const resultBlock = block as {
          tool_use_id?: unknown;
          is_error?: unknown;
        };
        const toolUseId = persistedTaskIdentifier(resultBlock.tool_use_id);
        if (!toolUseId || resultBlock.is_error === true) return undefined;
        toolUseIds.push(toolUseId);
      }
    }
  }
  if (toolUseIds.length !== 1) return undefined;
  const only = toolUseIds[0]!;
  return toolTracker.getTool(only)?.toolName === "Bash" ? only : undefined;
}

/** What one correlated Bash tool result says about background work. */
export interface BashToolResultOutcome {
  toolUseId: string;
  failed: boolean;
  /** A background launch that can be published now. */
  launch?: BackgroundTaskLaunch;
  /**
   * Background evidence arrived without a usable task id. The invocation must
   * stay an unresolved candidate so this query's stdin is held open until a
   * lifecycle frame supplies the id.
   */
  retainCandidate: boolean;
}

/**
 * Recover the synchronous launch edge carried by a turn's tool results.
 *
 * Bash returns `backgroundTaskId` in `SDKUserMessage.tool_use_result` before
 * the provider publishes `task_started` / `background_tasks_changed`. Waiting
 * for only those system messages leaves a race where the turn result sees an
 * empty task set, closes streaming input, and the CLI then terminates the
 * background process it owns.
 *
 * Every block is judged on its own evidence, because the API delivers parallel
 * tool calls as several `tool_result` blocks inside one user message. Reading
 * only the single-block case discarded a real background handoff whenever
 * Claude ran two commands at once, releasing the candidate and closing stdin —
 * exactly the race this mechanism exists to prevent.
 */
export function bashToolResultOutcomes(
  message: SDKUserMessage,
  toolTracker: ToolTracker,
): BashToolResultOutcome[] {
  const results = correlatedBashToolResults(message, toolTracker);
  if (results.length === 0) return [];

  const exclusiveToolUseId = exclusiveBashToolResultId(message, toolTracker);
  const structuredResult = message.tool_use_result;
  const structuredRecord =
    structuredResult !== null
    && typeof structuredResult === "object"
    && !Array.isArray(structuredResult)
      ? structuredResult as Record<string, unknown>
      : undefined;

  const outcomes: BashToolResultOutcome[] = [];
  for (const result of results) {
    if (result.failed) {
      outcomes.push({
        toolUseId: result.toolUseId,
        failed: true,
        retainCandidate: false,
      });
      continue;
    }
    // Structured evidence in a batched message cannot be pinned to a block, so
    // only the per-block label speaks for it there.
    const structured = exclusiveToolUseId === result.toolUseId
      ? structuredRecord
      : undefined;
    const tool = toolTracker.getTool(result.toolUseId);
    const toolArgs =
      tool?.toolArgs
      && typeof tool.toolArgs === "object"
      && !Array.isArray(tool.toolArgs)
        ? tool.toolArgs as Record<string, unknown>
        : undefined;
    const providerIntent =
      toolArgs?.run_in_background === true
      || structured?.backgroundedByUser === true
      || (
        typeof structured?.timedOutAfterMs === "number"
        && Number.isFinite(structured.timedOutAfterMs)
        && structured.timedOutAfterMs >= 0
      );
    // Provider-authored intent already exists, so the label only has to supply
    // an id and a line anchor is enough. Without it the label is the *only*
    // claim that this happened at all, and it must be the whole result.
    const labelId = providerIntent
      ? backgroundTaskIdFromToolResultContent(result.content)
      : exclusiveBackgroundTaskLabelId(result.content);
    if (!providerIntent && labelId === undefined) {
      outcomes.push({
        toolUseId: result.toolUseId,
        failed: false,
        retainCandidate: false,
      });
      continue;
    }
    const id = persistedTaskIdentifier(structured?.backgroundTaskId) ?? labelId;
    if (!id) {
      outcomes.push({
        toolUseId: result.toolUseId,
        failed: false,
        retainCandidate: true,
      });
      continue;
    }
    const description = persistedTaskText(toolArgs?.description)
      ?? persistedTaskText(toolArgs?.command)
      // `content` is the provider tool label ("Bash") and is the only title
      // the Claude parsing path currently retains on a normalized invocation.
      ?? persistedTaskText(tool?.content);
    outcomes.push({
      toolUseId: result.toolUseId,
      failed: false,
      retainCandidate: false,
      launch: {
        id,
        toolUseId: result.toolUseId,
        ...(description ? { description } : {}),
      },
    });
  }
  return outcomes;
}

export function provisionalBackgroundTaskLaunchesFromAssistantMessage(
  message: unknown,
): BackgroundTaskLaunch[] {
  const content = (
    message as { message?: { content?: unknown } } | undefined
  )?.message?.content;
  if (!Array.isArray(content)) return [];

  const launches: BackgroundTaskLaunch[] = [];
  for (const block of content) {
    if (
      !block
      || typeof block !== "object"
      || (block as { type?: unknown }).type !== "tool_use"
      || (block as { name?: unknown }).name !== "Bash"
    ) {
      continue;
    }
    const toolUseId = persistedTaskIdentifier((block as { id?: unknown }).id);
    const input = (block as { input?: unknown }).input;
    if (
      !toolUseId
      || !input
      || typeof input !== "object"
      || Array.isArray(input)
      || (input as { run_in_background?: unknown }).run_in_background !== true
    ) {
      continue;
    }
    const args = input as Record<string, unknown>;
    launches.push({
      id: provisionalBackgroundTaskId(toolUseId),
      toolUseId,
      description: persistedTaskText(args.description)
        ?? persistedTaskText(args.command),
    });
  }
  return launches;
}

export function bashToolUseIdsFromAssistantMessage(message: unknown): string[] {
  const content = (
    message as { message?: { content?: unknown } } | undefined
  )?.message?.content;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (
      !block
      || typeof block !== "object"
      || (block as { type?: unknown }).type !== "tool_use"
      || (block as { name?: unknown }).name !== "Bash"
    ) {
      continue;
    }
    const id = persistedTaskIdentifier((block as { id?: unknown }).id);
    if (id) ids.push(id);
  }
  return ids;
}

export function persistedTaskStatus(
  value: unknown,
): BackgroundTaskSnapshot["status"] | undefined {
  return value === "pending"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "killed"
    || value === "paused"
    ? value
    : undefined;
}

export function persistedNotificationStatus(
  value: unknown,
): "completed" | "failed" | "stopped" | undefined {
  return value === "completed" || value === "failed" || value === "stopped"
    ? value
    : undefined;
}

export function persistedTimestamp(
  value: unknown,
  now: number,
): number | undefined {
  const timestamp =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(timestamp)
    && timestamp >= 0
    && timestamp <= now + MAX_PERSISTED_TIMESTAMP_FUTURE_SKEW_MS
    ? timestamp
    : undefined;
}

export function persistedBackgroundTaskMessage(raw: {
  message: unknown;
}): BackgroundTaskSystemMessage | undefined {
  // Current SDK session reads place the original transcript payload in
  // `message`. Accept the outer record too so older/custom SessionStore
  // adapters that return system fields directly remain readable.
  for (const candidate of [raw.message, raw]) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as Record<string, unknown>;
    if (
      message.subtype !== "task_started"
      && message.subtype !== "task_progress"
      && message.subtype !== "task_updated"
      && message.subtype !== "task_notification"
    ) {
      continue;
    }
    const taskId = persistedTaskIdentifier(message.task_id);
    if (!taskId) continue;
    const notificationStatus =
      message.subtype === "task_notification"
        ? persistedNotificationStatus(message.status)
        : undefined;
    // A malformed terminal record is not evidence of success. Ignore it and
    // let a preceding live edge reconcile to killed when hydration observes
    // that its owning process is gone.
    if (message.subtype === "task_notification" && !notificationStatus) {
      continue;
    }
    const rawPatch =
      message.patch && typeof message.patch === "object" && !Array.isArray(message.patch)
        ? message.patch as Record<string, unknown>
        : undefined;
    const patchStatus = persistedTaskStatus(rawPatch?.status);
    const patchDescription = persistedTaskText(rawPatch?.description);
    const patchEndTime = persistedTimestamp(rawPatch?.end_time, Date.now());
    const patchError = persistedTaskText(rawPatch?.error);
    const patchIsBackgrounded =
      typeof rawPatch?.is_backgrounded === "boolean"
        ? rawPatch.is_backgrounded
        : undefined;
    const hasPatch =
      patchStatus !== undefined
      || patchDescription !== undefined
      || patchEndTime !== undefined
      || patchError !== undefined
      || patchIsBackgrounded !== undefined;
    return {
      subtype: message.subtype,
      task_id: taskId,
      tool_use_id: persistedTaskIdentifier(message.tool_use_id),
      description: persistedTaskText(message.description),
      summary: persistedTaskText(message.summary),
      status: notificationStatus,
      ...(hasPatch
        ? {
            patch: {
              status: patchStatus,
              description: patchDescription,
              end_time: patchEndTime,
              error: patchError,
              is_backgrounded: patchIsBackgrounded,
            },
          }
        : {}),
    };
  }
  return undefined;
}

export function persistedRecordTime(raw: { message: unknown }): number {
  const now = Date.now();
  const outerTimestamp = (raw as { timestamp?: unknown }).timestamp;
  const innerTimestamp =
    raw.message && typeof raw.message === "object"
      ? (raw.message as { timestamp?: unknown }).timestamp
      : undefined;
  for (const candidate of [innerTimestamp, outerTimestamp]) {
    const parsed = persistedTimestamp(candidate, now);
    if (parsed !== undefined) return parsed;
  }
  return now;
}

export function reducePersistedBackgroundTaskMessage(
  tasks: Record<string, BackgroundTaskSnapshot> | undefined,
  message: BackgroundTaskSystemMessage,
  timestamp: number,
): Record<string, BackgroundTaskSnapshot> {
  const previous = tasks?.[message.task_id];
  if (message.subtype === "task_notification") {
    if (!message.status) return tasks ?? {};
    const startedAt = previous?.startedAt ?? timestamp;
    const endedAt = timestamp >= startedAt ? timestamp : previous?.endedAt;
    const terminalStatus: BackgroundTaskSnapshot["status"] =
      message.status === "failed"
        ? "failed"
        : message.status === "stopped"
          ? "killed"
          : message.status === "completed"
            ? "completed"
            : "killed";
    return boundBackgroundTaskHistory({
      ...(tasks ?? {}),
      [message.task_id]: {
        id: message.task_id,
        toolUseId: message.tool_use_id ?? previous?.toolUseId,
        description:
          previous?.description
          ?? message.description
          ?? message.summary,
        status: terminalStatus,
        isBackgrounded: previous?.isBackgrounded,
        startedAt,
        endedAt,
        error:
          terminalStatus === "failed"
            ? (message.summary ?? previous?.error)
            : previous?.error,
      },
    });
  }

  const patchStatus = message.patch?.status;
  const nextStatus =
    previous && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)
      && (patchStatus === undefined || LIVE_BACKGROUND_TASK_STATUSES.has(patchStatus))
      ? previous.status
      : (patchStatus ?? previous?.status ?? "running");
  const startedAt = previous?.startedAt ?? timestamp;
  const patchedEndTime =
    message.patch?.end_time !== undefined
    && message.patch.end_time >= startedAt
      ? message.patch.end_time
      : undefined;
  return boundBackgroundTaskHistory({
    ...(tasks ?? {}),
    [message.task_id]: {
      id: message.task_id,
      toolUseId: message.tool_use_id ?? previous?.toolUseId,
      description:
        message.patch?.description
        ?? message.description
        ?? previous?.description,
      status: nextStatus,
      isBackgrounded:
        message.patch?.is_backgrounded
        ?? previous?.isBackgrounded
        ?? true,
      startedAt,
      endedAt: patchedEndTime ?? previous?.endedAt,
      error: message.patch?.error ?? previous?.error,
    },
  });
}

export function normalizePersistedSessionMessages(
  persisted: Array<{
    type: "user" | "assistant" | "system";
    uuid: string;
    session_id: string;
    message: unknown;
    parent_tool_use_id: string | null;
    isSidechain?: boolean;
  }>,
): {
  messages: NormalizedMessage[];
  taskRegistry: TaskRegistry;
  backgroundTasks?: Record<string, BackgroundTaskSnapshot>;
} {
  const toolTracker = new ToolTracker();
  const taskRegistry = new TaskRegistry();
  const activeTaskIds = new Set<string>();
  let backgroundTasks: Record<string, BackgroundTaskSnapshot> | undefined;
  const parsed: Array<{
    raw: (typeof persisted)[number];
    content: string;
    orderedParts: OrderedPartEntry[];
  }> = [];

  for (const raw of persisted) {
    if (raw.type === "system") {
      const taskMessage = persistedBackgroundTaskMessage(raw);
      if (taskMessage) {
        backgroundTasks = reducePersistedBackgroundTaskMessage(
          backgroundTasks,
          taskMessage,
          persistedRecordTime(raw),
        );
      }
      continue;
    }
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
    const isRootAssistant =
      entry.raw.type === "assistant"
      && isRootAssistantRecord(
        entry.raw.parent_tool_use_id,
        entry.raw.isSidechain,
      );
    const modelId = isRootAssistant
      && entry.raw.message
      && typeof entry.raw.message === "object"
      ? normalizeBackendModelId((entry.raw.message as { model?: unknown }).model)
      : undefined;
    messages.push({
      id: entry.raw.uuid || generateMessageId(),
      role: entry.raw.type,
      content: entry.content,
      parts,
      createdAt: timestamp,
      ...(modelId ? { modelId } : {}),
      // Recorded explicitly rather than inferred from `id`: a record with no
      // uuid falls back to a generated id, which must never be mistaken for a
      // transcript uuid by `resolvePersistedMessageId`.
      ...(entry.raw.uuid ? { sdkUuid: entry.raw.uuid } : {}),
    });
  }
  if (backgroundTasks) {
    const processEndedAt = Date.now();
    backgroundTasks = boundBackgroundTaskHistory(
      Object.fromEntries(
        Object.entries(backgroundTasks).map(([id, task]) => [
          id,
          LIVE_BACKGROUND_TASK_STATUSES.has(task.status)
            ? {
                ...task,
                status: "killed" as const,
                endedAt: task.endedAt ?? processEndedAt,
                error:
                  task.error
                  ?? "The Claude process that owned this task is no longer running",
              }
            : task,
        ]),
      ),
    );
  }
  return { messages, taskRegistry, backgroundTasks };
}

