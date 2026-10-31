/**
 * Thread item → Orkestrator normalized part conversion.
 *
 * Extracted from `index.ts` unchanged so both engines share one renderer: the
 * app-server engine adapts its camelCase items into the SDK shape (see
 * `app-server/item-adapter.ts`) precisely so this file — and its tests — stay
 * engine-neutral. Two engines rendering the same conversation identically is the
 * parity requirement that makes rollback safe.
 */
import { readFile } from "node:fs/promises";
import type { FileUpdateChange, McpToolCallItem, PatchApplyStatus } from "../codex-item-types.js";
import { normalizeTranscriptToolArgs } from "../subagent-transcript.js";
import { mapTodoArgs, summarizeTodoList } from "../todo-helpers.js";
import type { EngineItem } from "../engine/types.js";
import { DEFAULT_MAX_COMMAND_OUTPUT_CHARS } from "../sessions/turn-accumulator.js";
import { applyDiffBudget, pruneDiffCache } from "./diff-budget.js";
import { rawApplyPatchParts } from "./apply-patch.js";
import { agentMessageDisplayText } from "./agent-message.js";
import { legacyUnifiedDiff, resolvedChangePath, suppliedFileChange } from "./file-change-diff.js";
import type { FileChangeDiffContext, NormalizedPart, ToolDiffMetadata } from "./types.js";

const COMMAND_OUTPUT_TRUNCATION_NOTICE = "\n… output truncated";
const INVISIBLE_TEXT_ONLY = /^(?:\p{White_Space}|\uFEFF|\p{Default_Ignorable_Code_Point})*$/u;

export function hasVisibleText(value: string): boolean {
  return !INVISIBLE_TEXT_ONLY.test(value);
}

export function capCommandOutput(
  output: string,
  maxChars: number = DEFAULT_MAX_COMMAND_OUTPUT_CHARS,
): string {
  if (output.length <= maxChars) return output;
  // A cap tighter than the notice would make the slice length negative, which
  // slices from the *end* and returns more than the cap instead of less.
  const keep = Math.max(0, maxChars - COMMAND_OUTPUT_TRUNCATION_NOTICE.length);
  return output.slice(0, keep) + COMMAND_OUTPUT_TRUNCATION_NOTICE;
}

/**
 * The provider-reported run time, only once the call has finished: a duration
 * on a running row would read as a final measurement.
 */
function finishedDuration(item: {
  status: string;
  duration_ms?: number;
}): { toolDurationMs: number } | Record<string, never> {
  return item.status !== "in_progress" && item.duration_ms !== undefined
    ? { toolDurationMs: item.duration_ms }
    : {};
}

export function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Media arrives as a URL, which for tool results is routinely an inline
 * `data:` payload. Emitting those verbatim would push megabytes of base64
 * through SSE and into a `<pre>`, so only referenceable URLs survive.
 */
function describeMediaUrl(url: string, kind: "image" | "audio"): string {
  return url.startsWith("data:") ? `[${kind}]` : url;
}

function stringifyDynamicToolContent(items: unknown[]): string | undefined {
  const content = items
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return stringifyUnknown(item);
      }
      const record = item as Record<string, unknown>;
      if (record.type === "inputText" && typeof record.text === "string") {
        return record.text;
      }
      if (record.type === "inputImage" && typeof record.imageUrl === "string") {
        return describeMediaUrl(record.imageUrl, "image");
      }
      if (record.type === "inputAudio" && typeof record.audioUrl === "string") {
        return describeMediaUrl(record.audioUrl, "audio");
      }
      return stringifyUnknown(item);
    })
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return content.length > 0 ? content.join("\n") : undefined;
}

export async function readTextFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }

    // Once inside a hunk, every leading + / - is a body marker. This is the
    // only reliable way to distinguish file headers from body content such as
    // `++ value`, whose encoded diff line is the identical `+++ value`.
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

/**
 * The legacy `toolDiff` for one file change, from app-server's own payload.
 *
 * Built only from what the item carries (`messages/file-change-diff.ts`),
 * never from the worktree or `git show HEAD:`: re-reading the disk shows the
 * file as it is *now*, so a row rendered again after later edits would claim
 * them, and a patch still in progress would be diffed before it applied. A
 * change with no supplied payload (older history) is shown by path alone and
 * its counts stay unknown.
 *
 * Only a settled change is cached: an in-progress one is re-sent as the model
 * writes the patch, under the same key.
 */
export function fileChangeDiffMetadata(
  cwd: string,
  change: FileUpdateChange,
  status: PatchApplyStatus,
  context?: FileChangeDiffContext,
  cacheKey?: string,
): ToolDiffMetadata {
  const cached = cacheKey ? context?.cache.get(cacheKey) : undefined;
  if (cached) return cached;

  const filePath = resolvedChangePath(cwd, change.path);
  const supplied = suppliedFileChange(change);
  let metadata: ToolDiffMetadata;
  if (!supplied) {
    metadata = { filePath };
  } else {
    const diff = legacyUnifiedDiff(cwd, change, supplied);
    // No diff text is still a known zero for an empty file or a pure rename;
    // a payload that is not a diff leaves the counts unknown.
    const counts = diff
      ? countDiffLines(diff)
      : supplied.kind !== "update" || supplied.unified
        ? { additions: 0, deletions: 0 }
        : {};
    // Oversized before/after are dropped here rather than stored and truncated
    // later. See messages/diff-budget.ts.
    metadata = applyDiffBudget({
      filePath,
      ...(supplied.kind === "delete" ? { before: supplied.content } : {}),
      ...(supplied.kind === "add" ? { after: supplied.content } : {}),
      diff,
      ...counts,
    });
  }

  if (cacheKey && context && status !== "in_progress") {
    context.cache.set(cacheKey, metadata);
    pruneDiffCache(context.cache);
  }
  return metadata;
}

/** Async alias kept for existing callers; nothing here awaits. */
export async function getFileChangeDiffMetadata(
  cwd: string,
  change: FileUpdateChange,
  context?: FileChangeDiffContext,
  cacheKey?: string,
  status: PatchApplyStatus = "completed",
): Promise<ToolDiffMetadata> {
  return fileChangeDiffMetadata(cwd, change, status, context, cacheKey);
}

function fileChangeToolState(status: PatchApplyStatus): "success" | "failure" | "pending" {
  return status === "completed" ? "success" : status === "in_progress" ? "pending" : "failure";
}

/**
 * An MCP tool call's part. Synchronous and exported so a history reload renders
 * a rollout's recorded call through exactly this code (`history/rollout.ts`).
 */
export function mcpToolCallParts(item: McpToolCallItem): NormalizedPart[] {
  return [
    {
      type: "tool-invocation",
      toolUseId: item.id,
      content: item.tool,
      toolName: item.tool,
      toolArgs: (item.arguments ?? {}) as Record<string, unknown>,
      toolState:
        item.status === "failed" ? "failure" : item.status === "completed" ? "success" : "pending",
      toolTitle: `${item.server}:${item.tool}`,
      toolOutput: stringifyUnknown(item.result),
      toolError: item.error?.message,
      ...finishedDuration(item),
    },
  ];
}

export async function itemToParts(
  item: EngineItem,
  cwd: string,
  fileChangeContext?: FileChangeDiffContext,
): Promise<NormalizedPart[]> {
  switch (item.type) {
    case "agent_message":
      if (item.delivery === "async" && item.questions?.length) {
        return [
          {
            type: "async-question",
            content: item.text,
            asyncQuestion: {
              itemId: item.id,
              questions: item.questions.map((question, index) => ({
                id: `${item.id}:${index}`,
                title: question.title,
                options: question.options ?? [],
              })),
            },
          },
        ];
      }
      return [{ type: "text", content: agentMessageDisplayText(item) }];
    case "reasoning":
      return hasVisibleText(item.text) ? [{ type: "thinking", content: item.text }] : [];
    case "command_execution": {
      const output = capCommandOutput(item.aggregated_output);
      const failed = item.status === "failed";
      return [
        {
          type: "tool-invocation",
          toolUseId: item.id,
          content: item.command,
          toolName: "bash",
          toolArgs: { command: item.command },
          toolState:
            item.status === "failed"
              ? "failure"
              : item.status === "completed"
                ? "success"
                : "pending",
          toolTitle: item.command,
          // A failed command used to duplicate the same potentially 256 KiB
          // string into both fields. The renderer already gives `toolError` its
          // error treatment, so keep the payload exactly once.
          toolOutput: failed ? undefined : output || undefined,
          toolError: failed ? output || "Command failed" : undefined,
          ...finishedDuration(item),
        },
      ];
    }
    case "file_change":
      return item.changes.map((change, index) => ({
        type: "tool-invocation" as const,
        toolUseId: item.id,
        content: change.path,
        toolName: "apply_patch",
        toolState: fileChangeToolState(item.status),
        toolTitle: `${change.kind}: ${change.path}`,
        toolOutput: `${change.kind}: ${change.path}`,
        toolDiff: fileChangeDiffMetadata(
          cwd,
          change,
          item.status,
          fileChangeContext,
          `${item.id}:${index}:${change.kind}:${change.path}`,
        ),
      }));
    case "mcp_tool_call":
      return mcpToolCallParts(item);
    case "dynamic_tool_call": {
      const output =
        capCommandOutput(stringifyDynamicToolContent(item.content_items) ?? "") || undefined;
      const toolState =
        item.status === "failed" ? "failure" : item.status === "completed" ? "success" : "pending";
      if (item.tool.trim().toLowerCase() === "apply_patch") {
        const patchParts = rawApplyPatchParts(item.arguments, cwd, toolState);
        if (patchParts.length > 0) {
          return patchParts.map((part) => ({
            ...part,
            toolUseId: item.id,
            toolOutput: item.status === "failed" ? undefined : output,
            toolError: item.status === "failed" ? (output ?? "Tool failed") : undefined,
            ...finishedDuration(item),
          }));
        }
      }
      return [
        {
          type: "tool-invocation",
          toolUseId: item.id,
          content: item.tool,
          toolName: item.tool,
          toolArgs: normalizeTranscriptToolArgs(item.tool, item.arguments),
          toolState,
          // Dynamic tools are namespaced by the protocol, so two same-named tools
          // are only distinguishable by it. Mirrors the `mcp_tool_call` title.
          toolTitle: item.namespace ? `${item.namespace}:${item.tool}` : item.tool,
          toolOutput: item.status === "failed" ? undefined : output,
          toolError: item.status === "failed" ? (output ?? "Tool failed") : undefined,
          ...finishedDuration(item),
        },
      ];
    }
    case "web_search":
      return [
        {
          type: "tool-invocation",
          toolUseId: item.id,
          content: item.query,
          toolName: "web_search",
          toolArgs: { query: item.query },
          toolState: "success",
          toolTitle: item.query,
        },
      ];
    case "todo_list":
      return [
        {
          type: "tool-invocation",
          toolUseId: item.id,
          content: summarizeTodoList(item.items),
          toolName: "todo_list",
          toolState: "success",
          toolTitle: "Todo List",
          toolArgs: mapTodoArgs(item.items),
          toolOutput: summarizeTodoList(item.items),
        },
      ];
    case "error":
      return [
        {
          type: "tool-result",
          content: item.message,
          toolName: "error",
          toolState: "failure",
          toolError: item.message,
        },
      ];
    /**
     * app-server only: free-text plan the agent drafts mid-turn.
     *
     * Rendered as a labelled tool invocation rather than plain text so it cannot
     * be mistaken for the assistant's final answer, matching how `todo_list` is
     * grouped.
     */
    case "plan":
      return [
        {
          type: "tool-invocation",
          toolUseId: item.id,
          content: item.text,
          toolName: "plan",
          toolState: "success",
          toolTitle: "Plan",
          toolOutput: item.text,
        },
      ];
    /**
     * app-server only: sub-agent lifecycle beat. Intentionally renders nothing —
     * the visible sub-agent timeline is assembled from `collab_tool_call` items
     * plus rollout transcripts, which is the same source both engines use.
     */
    case "subagent_activity":
    // The sub-agent timeline is assembled from these plus rollout transcripts,
    // in `subagentParts`. Rendering the raw call here would duplicate every
    // child row beside the card that already presents it.
    case "collab_tool_call":
      return [];
    case "image":
      return [
        // A generation's inputs are images Codex read for it, so each shows
        // as a read image before the result, through the same path reference.
        ...(item.input_paths ?? []).map((path): NormalizedPart => ({
          type: "image",
          content: path.split(/[\\/]/).pop() || "Image",
          fileUrl: `file://${path}`,
          filename: path,
          imageSource: "viewed",
        })),
        {
          type: "image",
          content: item.text,
          ...(item.path ? { fileUrl: `file://${item.path}`, filename: item.path } : {}),
          imageSource: item.source,
        },
      ];
    case "compaction":
      return [{ type: "compaction", content: item.text }];
    case "status":
      return [
        {
          type: "status",
          content: item.text,
          ...(item.severity ? { severity: item.severity } : {}),
        },
      ];
    case "retry":
      return [{ type: "retry", content: item.text, toolState: item.state }];
    default: {
      // A generic card rather than silence. `item` is `never` here, so an item
      // kind added upstream fails this file's typecheck first; this branch is
      // for a payload that reached the runtime without matching any of them.
      const unknown = item as { type?: unknown; id?: unknown };
      const name = typeof unknown.type === "string" ? unknown.type : "unknown";
      return [
        {
          type: "tool-invocation",
          toolUseId: typeof unknown.id === "string" ? unknown.id : undefined,
          // Names only. An item's own fields carry prompts, file contents and
          // command output.
          content: `Codex reported a ${name} item this bridge cannot render`,
          toolName: name,
          toolState: "success",
          toolTitle: `Unrendered ${name}`,
        },
      ];
    }
  }
}
