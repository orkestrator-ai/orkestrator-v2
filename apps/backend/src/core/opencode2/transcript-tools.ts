/**
 * One OpenCode 2.x tool call (`Session.Message.Assistant.Tool`) as a shared
 * transcript part: a tool card, an edit card with its diff, or a sub-agent
 * card (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 4).
 *
 * The 2.x state machine is `streaming` (input still arriving, as a partial
 * JSON string) → `running` → `completed` | `error`. A settled call carries
 * `content` (`Tool.Content`: text and file references) and `metadata`, where
 * edit tools put `{ files: [FileDiff] }` and the `subagent` tool its child
 * `{ sessionID, status }`.
 *
 * Every tool, including one a project plugin or MCP server adds, degrades to
 * a plain card: an unknown name or shape never throws (these rows render
 * mid-turn). Bodies are bounded like the 1.x display read (200 kB per value);
 * the projection moves them behind detail references.
 */
import { redactArtifactGrantArgs } from "@orkestrator/protocol/transcript-artifacts";
import { toolDiffFromOpenCodeToolState } from "@orkestrator/protocol/tool-diff";
import { asRecord, nonEmptyString } from "../agent-provider-runtime.js";

/** Longest tool output or error kept on a part, as on 1.x. */
export const OPENCODE2_TOOL_VALUE_LIMIT = 200_000;
/** Longest tool input kept inline on a card. */
const MAX_TOOL_ARGS_BYTES = 64 * 1024;
/** Longest diff side or patch kept on an edit card. */
const MAX_DIFF_SIDE = 200_000;

function bounded(value: string, limit = OPENCODE2_TOOL_VALUE_LIMIT): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… (output cut)`;
}

function boundedArgs(input: unknown): Record<string, unknown> | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  try {
    return JSON.stringify(record).length <= MAX_TOOL_ARGS_BYTES ? record : undefined;
  } catch {
    return undefined;
  }
}

/** Partial JSON while the model is still writing the call; parsed when it already is whole. */
function streamingArgs(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "string" || input.length > MAX_TOOL_ARGS_BYTES) return undefined;
  try {
    return asRecord(JSON.parse(input)) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The text a settled call returned, with file results named rather than inlined. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const lines: string[] = [];
  let length = 0;
  for (const entry of content.slice(0, 256)) {
    const item = asRecord(entry);
    let line: string | undefined;
    if (item?.type === "text" && typeof item.text === "string") line = item.text;
    else if (item?.type === "file") {
      const name = nonEmptyString(item.name) ?? nonEmptyString(item.uri) ?? "file";
      // A `data:` URI is the file itself; only its name and type are shown.
      line = `[${nonEmptyString(item.mime) ?? "file"}: ${name.startsWith("data:") ? "inline data" : name}]`;
    }
    if (line === undefined) continue;
    lines.push(line);
    length += line.length;
    if (length > OPENCODE2_TOOL_VALUE_LIMIT) break;
  }
  return lines.length > 0 ? bounded(lines.join("\n")) : undefined;
}

function durationMs(time: Record<string, unknown> | null): number | undefined {
  const start = typeof time?.ran === "number" ? time.ran : time?.created;
  const end = time?.completed;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round(end - start);
}

function boundedDiff<T extends Record<string, unknown>>(diff: T | undefined): T | undefined {
  if (!diff) return undefined;
  const sides = ["before", "after", "diff"] as const;
  if (
    sides.every(
      (side) => typeof diff[side] !== "string" || (diff[side] as string).length <= MAX_DIFF_SIDE,
    )
  ) {
    return diff;
  }
  // Too large to carry: keep the path and counts the card needs.
  const { before: _before, after: _after, diff: _diff, ...rest } = diff;
  return rest as T;
}

/** `<subagent sessionID="…" state="…">` in a completed subagent call's output. */
function subagentEnvelope(output: string | undefined): { sessionId?: string; state?: string } {
  const match = output?.match(
    /<subagent\s+sessionID=["']([^"']+)["'](?:\s+state=["']([a-z]+)["'])?/i,
  );
  return match ? { sessionId: match[1], ...(match[2] ? { state: match[2] } : {}) } : {};
}

/** One tool call as a transcript part; null for a value that is not a tool call at all. */
export function openCode2ToolPart(raw: unknown): Record<string, unknown> | null {
  const part = asRecord(raw);
  if (!part) return null;
  const toolName = nonEmptyString(part.name) ?? "Unknown tool";
  const state = asRecord(part.state);
  const status = state?.status;
  const toolState =
    status === "completed"
      ? "success"
      : status === "error"
        ? "failure"
        : status === "running" || status === "streaming"
          ? "pending"
          : undefined;
  const input =
    status === "streaming" ? streamingArgs(state?.input) : (asRecord(state?.input) ?? undefined);
  const args = boundedArgs(input);
  const metadata = asRecord(state?.metadata);
  const toolOutput = contentText(state?.content);
  const error = asRecord(state?.error);
  const toolError =
    status === "error"
      ? bounded(nonEmptyString(error?.message) ?? nonEmptyString(error?.type) ?? "The tool failed")
      : undefined;
  const settled = toolState === "success" || toolState === "failure";
  const toolDurationMs = settled ? durationMs(asRecord(part.time)) : undefined;
  const callId = nonEmptyString(part.id);
  const common = {
    toolName,
    ...(callId ? { toolUseId: callId, sourcePartId: callId } : {}),
    ...(args ? { toolArgs: redactArtifactGrantArgs(toolName, args) ?? args } : {}),
    ...(toolState ? { toolState } : {}),
    ...(toolDurationMs === undefined ? {} : { toolDurationMs }),
    ...(toolOutput === undefined ? {} : { toolOutput }),
    ...(toolError === undefined ? {} : { toolError }),
  };
  if (toolName === "subagent") {
    const envelope = subagentEnvelope(toolOutput);
    const subagentId = nonEmptyString(metadata?.sessionID) ?? envelope.sessionId;
    // A background child returns at once: the call succeeds while the child runs.
    const childStatus = nonEmptyString(metadata?.status) ?? envelope.state;
    const agentState =
      toolState === "failure"
        ? "failed"
        : toolState === "pending" || childStatus === "running"
          ? "active"
          : toolState === "success"
            ? "finished"
            : undefined;
    const name = nonEmptyString(input?.description);
    const role = nonEmptyString(input?.agent);
    const prompt = nonEmptyString(input?.prompt);
    const model = nonEmptyString(input?.model);
    return {
      type: "subagent",
      content: name ?? role ?? "Sub-agent",
      ...common,
      ...(agentState ? { agentState } : {}),
      subagentSource: "tool",
      ...(subagentId ? { subagentId } : {}),
      ...(name ? { subagentName: name } : {}),
      ...(role ? { subagentRole: role } : {}),
      ...(prompt ? { subagentPrompt: bounded(prompt, 16_384) } : {}),
      ...(model ? { subagentModelId: model.split("#")[0] } : {}),
      subagentActions: [],
      subagentActionCount: 0,
    };
  }
  const files = Array.isArray(metadata?.files) ? metadata.files : [];
  const toolDiff = boundedDiff(
    toolDiffFromOpenCodeToolState({
      toolName,
      input: input ?? {},
      // 2.x's FileDiff (`file`, `patch`, `additions`, `deletions`) is 1.x's `filediff`.
      metadata: files.length > 0 ? { filediff: files[0] } : metadata,
      output: toolOutput,
    }) as Record<string, unknown> | undefined,
  );
  return {
    type: "tool-invocation",
    content: toolName,
    ...common,
    ...(toolDiff ? { toolDiff } : {}),
  };
}
