// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
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
} from "../types/index.js";
import { isSdkCompactBoundaryMessage, isSdkResultMessage } from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import { getMcpServersForSdk, getMcpServerNames } from "./mcp-config.js";
import { getPluginsForSdk } from "./plugin-config.js";
import type { McpToolMetadata } from "../types/mcp.js";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Store for active sessions
const sessions = new Map<string, SessionState>();

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

// Timeout for plan approval (5 minutes)
const PLAN_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Generate a unique session ID using crypto.randomUUID for guaranteed uniqueness
 */
function generateSessionId(): string {
  return `session-${crypto.randomUUID()}`;
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
    const child = spawn(cliPath!, args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
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
    }
  }
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
    // Clean up pending plan approvals
    cleanupPendingPlanApprovals(sessionId);
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

    // Clean up pending plan approvals
    cleanupPendingPlanApprovals(sessionId);

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
  updateToolResult(toolUseId: string, result: { output?: string; error?: string; state: "success" | "failure" }): void {
    const existing = this.tools.get(toolUseId);
    if (existing) {
      this.tools.set(toolUseId, {
        ...existing,
        toolState: result.state,
        toolOutput: result.output,
        toolError: result.error,
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
  /** Message UUID this part belongs to (for streaming updates) */
  messageUuid?: string;
  /** Parent Task tool use ID - used to group child tools under their parent Task */
  parentTaskUseId?: string;
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
 */
function parseMessageContent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  message: any,
  toolTracker?: ToolTracker,
  mcpServerNames?: Set<string>,
  activeTaskIds?: Set<string>
): {
  content: string;
  thinkingParts: NormalizedPart[];
  /** Ordered sequence of thinking blocks and tool references as they appeared */
  orderedParts: OrderedPartEntry[];
  /** IDs of Task tools seen in this message (to add to active tasks) */
  newTaskIds: string[];
  /** IDs of Task tools that completed in this message (to remove from active tasks) */
  completedTaskIds: string[];
} {
  const thinkingParts: NormalizedPart[] = [];
  const orderedParts: OrderedPartEntry[] = [];
  const newTaskIds: string[] = [];
  const completedTaskIds: string[] = [];
  let textContent = "";

  const messageUuid = message.uuid as string | undefined;

  // Handle message.message.content array (from Anthropic SDK format)
  const contentBlocks = message.message?.content || [];

  // Track the most recent Task tool use ID within this message
  // This is used for the positional heuristic: tools following a Task belong to it
  let currentTaskUseId: string | undefined;

  for (const block of contentBlocks) {
    if (block.type === "text") {
      textContent += block.text || "";
      // Track text in ordered parts so it maintains position relative to thinking/tools
      orderedParts.push({
        type: "text",
        value: block.text || "",
        messageUuid,
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
      });
    } else if (block.type === "tool_use" && toolTracker) {
      const toolName = block.name || "Unknown tool";
      const isEditTool =
        toolName === "Edit" ||
        toolName === "Write" ||
        toolName === "edit" ||
        toolName === "write";
      const isTask = isTaskToolName(toolName);

      let toolDiff: ToolDiffMetadata | undefined;
      if (isEditTool && block.input) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const input = block.input as any;
        toolDiff = {
          filePath: input.file_path || input.filePath,
          before: input.old_string || input.oldString,
          after: input.new_string || input.newString,
        };
      }

      // Check if this is an MCP tool
      const { isMcpTool, mcpServerName } = parseMcpToolName(toolName, mcpServerNames);

      // Determine parent Task ID:
      // - Task tools have no parent (they ARE the parent)
      // - Other tools belong to the most recent Task in this message
      // - If no Task in this message, check activeTaskIds for a single active Task
      let parentTaskUseId: string | undefined;
      if (!isTask) {
        if (currentTaskUseId) {
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
      if (block.id) {
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
        });

        // If this is a Task tool, update tracking
        if (isTask) {
          currentTaskUseId = block.id;
          newTaskIds.push(block.id);
        }
      }
    } else if (block.type === "tool_result" && toolTracker) {
      // Update tool tracker with result
      if (block.tool_use_id) {
        const resultContent = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        toolTracker.updateToolResult(block.tool_use_id, {
          output: block.is_error ? undefined : resultContent,
          error: block.is_error ? resultContent : undefined,
          state: block.is_error ? "failure" : "success",
        });

        // Check if this is a Task tool completing
        const tool = toolTracker.getTool(block.tool_use_id);
        if (tool && isTaskToolName(tool.toolName || "")) {
          completedTaskIds.push(block.tool_use_id);
        }
      }
    }
  }

  return { content: textContent, thinkingParts, orderedParts, newTaskIds, completedTaskIds };
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
      });
    }
  }

  return result;
}

/**
 * Send a prompt to a session and process the response
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  options?: PromptOptions
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  if (session.status === "running") {
    throw new Error("Session is already processing a prompt");
  }

  // Create abort controller for this query
  const abortController = new AbortController();
  session.abortController = abortController;
  session.status = "running";
  session.lastActivity = new Date();

  // Build the display prompt (what the user sees) - includes attachment references
  let displayPrompt = prompt;
  if (options?.attachments && options.attachments.length > 0) {
    const attachmentTags = options.attachments
      .map((att) => `<attachment type="${att.type}" path="${att.path}" filename="${att.filename || ""}" />`)
      .join("\n");
    displayPrompt = `${prompt}\n\n<attached-files>\n${attachmentTags}\n</attached-files>`;
  }

  // Build the final prompt for the SDK - includes planning mode instruction if enabled
  let finalPrompt = displayPrompt;

  // If plan mode is enabled, instruct Claude to use the EnterPlanMode tool
  // This uses Claude's native planning mode which allows read-only exploration
  if (options?.permissionMode === "plan") {
    const planModeInstruction = `<system-reminder>
IMPORTANT: The user has enabled PLANNING MODE via the UI. You are now in planning mode.

Your FIRST action MUST be to call the EnterPlanMode tool to formally enter planning mode. Do this immediately before any other action.

In planning mode:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Design a concrete implementation strategy
5. When ready, use ExitPlanMode to present your plan for approval

Remember: In planning mode, you can READ files but should NOT write or edit any files yet. This is a read-only exploration and planning phase.
</system-reminder>

`;
    finalPrompt = planModeInstruction + displayPrompt;
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

  try {
    // Create the query with Claude Agent SDK
    // Extended thinking is enabled by default (thinking !== false)
    const thinkingEnabled = options?.thinking !== false;
    // Use CWD env var if set (for local environments where bridge runs from its own dir)
    // This allows the Claude SDK to operate on the actual project directory
    const cwd = process.env.CWD || process.cwd();

    // Load MCP servers from config files
    const mcpServers = await getMcpServersForSdk(cwd);
    const mcpServerNames = await getMcpServerNames(cwd);

    // Load plugins from config files
    const plugins = await getPluginsForSdk(cwd);

    const mcpServerCount = Object.keys(mcpServers).length;
    const pluginCount = plugins.length;
    // Determine permission mode: use provided option or default to "bypassPermissions"
    // Note: When user requests "plan" mode, we use "bypassPermissions" for the SDK
    // because Claude's native EnterPlanMode tool handles the planning workflow
    // (the "plan" mode in SDK blocks ALL tools which prevents EnterPlanMode from working)
    const requestedPlanMode = options?.permissionMode === "plan";
    const permissionMode = requestedPlanMode ? "bypassPermissions" : (options?.permissionMode ?? "bypassPermissions");

    console.log("[session-manager] Starting query", {
      sessionId,
      cwd,
      model: options?.model,
      resume: session.sdkSessionId ?? null,
      thinkingEnabled,
      permissionMode,
      mcpServerCount,
      mcpServerNames: Array.from(mcpServerNames),
      pluginCount,
      pluginPaths: plugins.map((p) => p.path),
    });
    const envPath = process.env.PATH;
    console.log("[session-manager] SDK env PATH", { path: envPath });
    const queryIterator = query({
      prompt: finalPrompt,
      options: {
        cwd,
        model: options?.model,
        permissionMode,
        // Enable extended thinking with up to 16K tokens (if enabled)
        ...(thinkingEnabled && { maxThinkingTokens: 16000 }),
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
          "TodoWrite",
          // Allow all MCP tools
          "mcp:*",
        ],
        abortController,
        // Resume session if we have a previous SDK session ID
        resume: session.sdkSessionId,
        // Use Claude Code system prompt
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
        },
        // Load user settings (from ~/.claude.json including MCP servers) and project settings (CLAUDE.md files)
        // Using "user" lets the SDK handle MCP server loading natively, which supports all transport types
        settingSources: ["user", "project"],
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

            try {
              const answers = await answerPromise;
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
              // If rejected (e.g., dismissed), deny the tool use
              return { behavior: "deny" as const, message: "User dismissed the question" };
            } finally {
              // Cleanup
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

            // Store the approval request
            pendingPlanApprovals.set(approvalId, approvalRequest);

            // Emit event so frontend knows to show the approval UI
            eventEmitter.emit({
              type: "plan.approval-requested",
              sessionId,
              data: approvalRequest,
            });

            // Wait for user decision with a Promise that can be resolved externally
            // Include timeout to prevent hanging indefinitely if user disconnects
            const approvalPromise = new Promise<PlanApprovalResponse>((resolve, reject) => {
              planApprovalResolvers.set(approvalId, { resolve, reject });
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
                // User approved - emit exit event and allow the tool
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

    // Track accumulated ordered parts (text, thinking, and tools in chronological order)
    // Parts are tracked per message UUID to preserve content from previous messages
    // when a new assistant message starts streaming (prevents loss during think→tool→think sequences)
    let accumulatedOrderedParts: OrderedPartEntry[] = [];

    // Track active (pending) Task tool IDs for parent tracking
    // This allows us to associate child tools with their parent Task
    const activeTaskIds = new Set<string>();

    // Track the last message UUID to detect when we're receiving a new assistant message
    // vs streaming updates to the same message. This allows us to:
    // - Replace parts during streaming (same UUID)
    // - Accumulate parts across multiple assistant messages in a turn (different UUID)
    let lastAssistantMessageUuid: string | null = null;

    // Track plan rejection feedback so we can re-prompt Claude after the turn ends.
    // When ExitPlanMode is denied, the SDK may end the turn without Claude seeing
    // the feedback. We capture it here and re-send as a follow-up prompt.
    let pendingPlanRejectionFeedback: string | null = null;

    // Process the async generator
    for await (const message of queryIterator) {
      if (abortController.signal.aborted) {
        break;
      }

      sdkMessageCount += 1;
      lastSdkMessageAt = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subtype = (message as any)?.subtype;
      console.debug("[session-manager] SDK event received", {
        sessionId,
        type: message.type,
        subtype,
        sdkMessageCount,
      });

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
      } else if (message.type === "system") {
        // Handle other system messages (log for debugging)
        const sysMsg = message as SdkSystemMessage;
        console.log("[session-manager] System message received", {
          sessionId,
          subtype: sysMsg.subtype,
        });

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
        const { content, orderedParts, newTaskIds } = parseMessageContent(
          message,
          toolTracker,
          mcpServerNames,
          activeTaskIds
        );

        // Update active Task tracking - add new Tasks
        for (const taskId of newTaskIds) {
          activeTaskIds.add(taskId);
        }

        // Get the message UUID to detect new messages vs streaming updates
        const messageUuid = message.uuid as string | undefined;

        // For ordered parts (thinking, tools, and text): we need to handle two cases:
        // 1. Streaming update to same message (same UUID): replace parts from this message
        // 2. New assistant message (different UUID): accumulate parts
        // This preserves chronological order across think → tool → think sequences
        if (orderedParts.length > 0) {
          if (messageUuid && messageUuid === lastAssistantMessageUuid) {
            // Same message - replace (streaming update)
            // Keep parts from previous messages, replace parts from this message
            const previousParts = accumulatedOrderedParts.filter(
              (p) => p.messageUuid !== messageUuid
            );
            accumulatedOrderedParts = [...previousParts, ...orderedParts];
          } else {
            // New message - accumulate ordered parts
            accumulatedOrderedParts = [...accumulatedOrderedParts, ...orderedParts];
          }
        }

        // Update the last message UUID
        if (messageUuid) {
          lastAssistantMessageUuid = messageUuid;
        }

        // Build final parts maintaining chronological order
        const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker);

        if (!currentAssistantMessage) {
          currentAssistantMessage = {
            id: message.uuid || generateMessageId(),
            role: "assistant",
            content,
            parts: finalParts,
            timestamp: new Date().toISOString(),
          };
          session.messages.push(currentAssistantMessage);
          console.debug("[session-manager] Created assistant message", {
            sessionId,
            messageId: currentAssistantMessage.id,
          });
        } else {
          currentAssistantMessage.content = content;
          currentAssistantMessage.parts = finalParts;
          console.debug("[session-manager] Updated assistant message", {
            sessionId,
            messageId: currentAssistantMessage.id,
          });
        }

        eventEmitter.emit({
          type: "message.updated",
          sessionId,
          data: { message: currentAssistantMessage },
        });
      } else if (message.type === "user") {
        // User message with tool results - parse to update tool tracker
        const { completedTaskIds } = parseMessageContent(
          message,
          toolTracker,
          mcpServerNames,
          activeTaskIds
        );

        // Update active Task tracking - remove completed Tasks
        for (const taskId of completedTaskIds) {
          activeTaskIds.delete(taskId);
        }

        // Rebuild message parts with updated tool results
        if (currentAssistantMessage) {
          const finalParts = buildMessageParts(accumulatedOrderedParts, toolTracker);
          currentAssistantMessage.parts = finalParts;

          eventEmitter.emit({
            type: "message.updated",
            sessionId,
            data: { message: currentAssistantMessage },
          });
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

        const contextUsage = extractContextUsageFromUnknown(resultMsg, options?.model);
        if (contextUsage) {
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: {
              contextUsage,
            },
          });
        }

        if (resultMsg.subtype === "success") {
          console.log("[session-manager] Query completed successfully", { sessionId });
        } else {
          console.error("[session-manager] Query error:", resultMsg.subtype, { sessionId });
          if (resultMsg.errors) {
            session.error = resultMsg.errors.join("\n");
          }
        }
      } else if (message.type === "stream_event") {
        // Streaming partial message - could handle for real-time updates
        // For now, we rely on full assistant messages
      }
      // Note: AskUserQuestion tool handling is done in the canUseTool callback above
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
        thinking: options?.thinking,
        permissionMode: "plan",
        _isReprompt: true,
      };

      try {
        await sendPrompt(sessionId, feedbackPrompt, repromptOptions);
        // sendPrompt handles setting idle status and emitting events, so return early
        return;
      } catch (repromptError) {
        console.error("[session-manager] Failed to re-prompt with plan feedback:", repromptError);
        // Fall through to normal idle handling
      }
    }

    // Generate a session title from the first user message if title is still the default
    const isDefaultTitle = session.title?.startsWith("Session ");
    const firstUserMessage = session.messages.find((m) => m.role === "user");
    if (isDefaultTitle && firstUserMessage && !session.titleGenerationPending) {
      session.titleGenerationPending = true;
      generateAndSetSessionTitle(sessionId, firstUserMessage.content);
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
    console.error("[session-manager] Error processing prompt:", error);

    session.status = "error";
    session.error = error instanceof Error ? error.message : String(error);
    session.abortController = undefined;

    eventEmitter.emit({
      type: "session.error",
      sessionId,
      data: { error: session.error },
    });

    throw error;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (earlyWarningTimeout) {
      clearTimeout(earlyWarningTimeout);
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
export async function getAvailableModels(): Promise<Array<{
  id: string;
  name: string;
  description?: string;
  supportsFastMode?: boolean;
}>> {
  try {
    const cwd = process.env.CWD || process.cwd();
    console.log("[session-manager] Fetching supported models", { cwd });
    // Create a query object to access supportedModels()
    // We use maxTurns: 0 to prevent any actual processing
    const q = query({
      prompt: "",
      options: {
        maxTurns: 0,
        cwd,
      },
    });

    // Get supported models from the query object
    const models = await q.supportedModels();
    console.log("[session-manager] Supported models fetched", { count: models.length });

    // Clean up the query (don't consume the generator)
    if (q.return) {
      await q.return();
    }

    return models.map((model: { value: string; displayName: string; description?: string; supportsFastMode?: boolean }) => ({
      id: model.value,
      name: model.displayName,
      description: model.description,
      supportsFastMode: model.supportsFastMode,
    }));
  } catch (error) {
    console.error("[session-manager] Error fetching supported models:", error);
    // Return fallback models if SDK call fails
    return [
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        description: "Latest and most capable model",
        supportsFastMode: true,
      },
    ];
  }
}
