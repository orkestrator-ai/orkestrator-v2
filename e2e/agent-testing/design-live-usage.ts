/**
 * Counts `orkestrator-design` MCP calls in a native transcript, for the live
 * design cycle's usage evidence (e2e/agent-testing/design-live.spec.ts).
 *
 * Claude names an MCP tool `mcp__orkestrator-design__<tool>`; Codex keeps the
 * bare tool name and titles the call `orkestrator-design:<tool>`. Only the
 * tool name, its state and the size of its output are read, never the content.
 */

export interface TranscriptMessage {
  role?: unknown;
  content?: unknown;
  parts?: unknown;
}

interface ToolPart {
  type?: unknown;
  toolName?: unknown;
  content?: unknown;
  toolOutput?: unknown;
  toolArgs?: unknown;
  toolState?: unknown;
  toolTitle?: unknown;
  detailRef?: unknown;
}

export interface DesignToolUsage {
  /** Design tool names in call order, without the server prefix. */
  calls: string[];
  /** UTF-8 bytes of the tool outputs the transcript holds inline for those calls. */
  responseBytes: number;
  /**
   * Detail references of calls whose output is not inline. A transcript read
   * carries summaries; the output is fetched on demand
   * (`get_native_agent_tool_details`).
   */
  detailRefs: string[];
  /** Calls by tool name. */
  byTool: Record<string, number>;
  /** Names of the calls the transcript marks as failed, in call order. */
  failed: string[];
  /** Names of calls with an explicit successful terminal state. */
  succeeded: string[];
}

const CLAUDE_PREFIX = "mcp__orkestrator-design__";
const CODEX_TITLE_PREFIX = "orkestrator-design:";
const encoder = new TextEncoder();

function designToolName(part: ToolPart): string | null {
  const name = typeof part.toolName === "string" ? part.toolName : "";
  if (name.startsWith(CLAUDE_PREFIX)) return name.slice(CLAUDE_PREFIX.length);
  const title = typeof part.toolTitle === "string" ? part.toolTitle : "";
  return name && title === `${CODEX_TITLE_PREFIX}${name}` ? name : null;
}

function bytesOf(value: unknown): number {
  if (value === undefined || value === null) return 0;
  return encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

/**
 * Summarize the design tool calls, optionally only those after the
 * `afterUserMessage`-th user message (0-based count of user messages to skip).
 */
export function summarizeDesignToolCalls(
  messages: readonly TranscriptMessage[],
  options: { afterUserMessage?: number } = {},
): DesignToolUsage {
  const usage: DesignToolUsage = {
    calls: [],
    responseBytes: 0,
    detailRefs: [],
    byTool: {},
    failed: [],
    succeeded: [],
  };
  let users = 0;
  for (const message of messages) {
    if (message.role === "user") {
      users += 1;
      continue;
    }
    if (options.afterUserMessage !== undefined && users <= options.afterUserMessage) continue;
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts as ToolPart[]) {
      if (!part || typeof part !== "object" || part.type !== "tool-invocation") continue;
      const name = designToolName(part);
      if (!name) continue;
      usage.calls.push(name);
      usage.byTool[name] = (usage.byTool[name] ?? 0) + 1;
      usage.responseBytes += bytesOf(part.toolOutput);
      if (part.toolOutput === undefined && typeof part.detailRef === "string")
        usage.detailRefs.push(part.detailRef);
      if (part.toolState === "failure") usage.failed.push(name);
      if (part.toolState === "success") usage.succeeded.push(name);
    }
  }
  return usage;
}

/** UTF-8 bytes of a fetched tool detail: its output, error and inline image. */
export function detailBytes(detail: {
  toolOutput?: unknown;
  toolError?: unknown;
  fileDataUrl?: unknown;
}): number {
  return bytesOf(detail.toolOutput) + bytesOf(detail.toolError) + bytesOf(detail.fileDataUrl);
}
