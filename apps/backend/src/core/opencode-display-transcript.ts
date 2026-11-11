/**
 * Display normalization for OpenCode 1.x transcripts: the `{ info, parts }`
 * envelopes the retired 1.x provider returned, which build pipelines and
 * handoffs persisted by older versions still hold. Build-pipeline transcript
 * windows, Multi Review reviewer reads and agent handoffs pass every entry
 * through here on the way out, so those stored transcripts keep rendering
 * without the renderer carrying a normalizer of its own. This reads stored
 * data; nothing here talks to OpenCode.
 *
 * Strictly one entry in, one entry out. Build-pipeline transcript patches
 * address the client's copy by index and count, so this never adds, drops or
 * reorders entries. An entry that is not an OpenCode 1.x envelope — a flat
 * bridge message, an OpenCode 2.x row, or one this already normalized —
 * passes through untouched, which also makes the pass idempotent.
 *
 * Deterministic and total: a message with no id is named after its position,
 * a missing or out-of-range timestamp is omitted (the renderer anchors it to
 * the stage start) rather than stamped "now", and an entry the normalizer
 * cannot read becomes an empty row instead of failing the whole read.
 */
import { providerInlineErrorMessageId } from "@orkestrator/protocol/native-agent";
import { redactArtifactGrantArgs } from "@orkestrator/protocol/transcript-artifacts";
import { toolDiffFromOpenCodeToolState } from "@orkestrator/protocol/tool-diff";
import { TURN_STOPPED_BY_USER_MESSAGE } from "./agent-provider-contract.js";
import { asRecord, boundedText, nonEmptyString } from "./agent-provider-runtime.js";

/**
 * How long a settled OpenCode tool call ran, from the provider's own
 * `state.time` (epoch milliseconds). Only the `completed` and `error` states
 * carry an end; a running call, or a stamp that is missing or runs backwards,
 * has no duration.
 */
function openCodeToolDurationMs(state: Record<string, unknown> | null | undefined) {
  if (state?.status !== "completed" && state?.status !== "error") return undefined;
  const time = asRecord(state.time);
  const start = time?.start;
  const end = time?.end;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round(end - start);
}

/** A tool's input, output or error as display text; display keeps whole bodies. */
function stringifyOpenCodeToolValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable tool value]";
  }
}

function openCodeRecordString(value: unknown, ...keys: string[]): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = nonEmptyString(record[key]);
    if (candidate) return candidate.trim();
  }
  return undefined;
}

function openCodeTaskEnvelope(output: string | undefined): {
  sessionId?: string;
  state?: "running" | "completed" | "error";
} {
  if (!output) return {};
  const match = output.match(
    /<task\s+id=["']([^"']+)["'](?:\s+state=["'](running|completed|error)["'])?/i,
  );
  return match
    ? {
        sessionId: match[1],
        state: match[2]?.toLowerCase() as "running" | "completed" | "error" | undefined,
      }
    : {};
}

/** `createdAt` of a message whose provider timestamp is missing or unusable. */
const OPEN_CODE_UNKNOWN_CREATED_AT = "1970-01-01T00:00:00.000Z";

/**
 * An OpenCode epoch (or date string) as ISO text, or undefined when it is not
 * a usable date. Total: `new Date(x).toISOString()` throws a `RangeError` past
 * the ECMA-262 time clip (±8.64e15 ms), and one such value must not fail a
 * whole transcript read.
 */
function openCodeIsoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || value.length === 0)) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function isOpenCodeReasoningInProgress(part: Record<string, unknown>): boolean {
  const time = asRecord(part.time);
  return typeof time?.start === "number" && time.end === undefined;
}

/**
 * OpenCode wraps completed reasoning in one balanced outer bold pair. Remove
 * that pair together — stripping a leading and a trailing `**` independently
 * corrupts reasoning that merely starts or ends with bold Markdown
 * (`**Plan** then inspect`). While a part is still streaming, its opening
 * delimiter can arrive before the closing one.
 */
function stripOpenCodeReasoningBoldMarkers(
  content: string,
  allowStreamingOpeningMarker: boolean,
): string {
  if (!content.replace(/\*\*/g, "").trim()) return "";
  const leadingMarker = content.match(/^(\s*)\*\*/);
  if (!leadingMarker) return content;
  const markerCount = content.match(/\*\*/g)?.length ?? 0;
  const trailingMarker = content.match(/\*\*(\s*)$/);
  if (trailingMarker && markerCount === 2) {
    return `${leadingMarker[1]}${content.slice(
      leadingMarker[0].length,
      content.length - trailingMarker[0].length,
    )}${trailingMarker[1]}`;
  }
  return allowStreamingOpeningMarker && markerCount === 1
    ? `${leadingMarker[1]}${content.slice(leadingMarker[0].length)}`
    : content;
}

/**
 * A provider 400/422 that refused a tool's input JSON Schema, for example
 * "Recursive JSON schemas are not currently supported" or an unknown `$ref`.
 * The request is rejected before the model runs, so a retry fails the same way.
 */
function isOpenCodeToolSchemaRejection(error: unknown): boolean {
  const record = asRecord(error);
  const data = asRecord(record?.data);
  if (record?.name !== "APIError" || !data) return false;
  const { statusCode, message } = data;
  if (statusCode !== 400 && statusCode !== 422) return false;
  if (typeof message !== "string") return false;
  return (
    /schema|\$ref|\$defs/i.test(message) &&
    /tool|function|parameters|recursive|\$ref|\$defs/i.test(message)
  );
}

/**
 * One `{ info, parts }` envelope as a renderer row, or null when it is not
 * one. Text, reasoning, files, compaction, retries, sub-agents (the
 * first-class `subtask` part, and task-shaped tool calls as the fallback)
 * and tool calls are rendered; every other part kind is dropped.
 */
export function normalizeOpenCodeEnvelope(
  value: unknown,
  index: number,
): Record<string, unknown> | null {
  const envelope = asRecord(value);
  const info = asRecord(envelope?.info);
  if (!envelope || !info) return null;
  const role =
    info.role === "user" || info.role === "assistant" || info.role === "system"
      ? info.role
      : "assistant";
  const messageId = nonEmptyString(info.id) ?? `opencode-message-${index}`;
  const createdAt =
    openCodeIsoTimestamp(asRecord(info.time)?.created) ?? OPEN_CODE_UNKNOWN_CREATED_AT;
  const parts: Record<string, unknown>[] = [];
  /**
   * Child sessions already represented by a first-class `subtask` part.
   *
   * OpenCode reports the same child twice — once as `subtask`, once as the
   * task-shaped tool call that launched it — so without this the transcript
   * carries two cards for one sub-agent. The `subtask` record wins because it
   * is the provider's own, and the heuristic is the fallback for servers that
   * do not emit one.
   */
  const subtaskSessionIds = new Set<string>();
  // Pre-scanned rather than filled as the loop goes: OpenCode does not
  // guarantee the `subtask` part precedes the tool call that launched the same
  // child, and a dedupe that depends on ordering silently stops deduping.
  for (const candidate of Array.isArray(envelope.parts) ? envelope.parts.slice(0, 2_048) : []) {
    const part = asRecord(candidate);
    if (part?.type !== "subtask") continue;
    const childSessionId = nonEmptyString(part.sessionID) ?? nonEmptyString(part.sessionId);
    if (childSessionId) subtaskSessionIds.add(childSessionId);
  }
  let content = "";
  for (const candidate of Array.isArray(envelope.parts) ? envelope.parts.slice(0, 2_048) : []) {
    const part = asRecord(candidate);
    if (!part) continue;
    const source = {
      ...(typeof part.id === "string" ? { sourcePartId: part.id } : {}),
      ...(typeof part.messageID === "string" ? { sourceMessageId: part.messageID } : {}),
    };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", content: part.text, ...source });
      content += part.text;
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      const reasoning = stripOpenCodeReasoningBoldMarkers(
        part.text,
        isOpenCodeReasoningInProgress(part),
      );
      if (reasoning.trim()) parts.push({ type: "thinking", content: reasoning, ...source });
      continue;
    }
    if (part.type === "file") {
      const path = nonEmptyString(part.filename) ?? nonEmptyString(part.url) ?? "Attached file";
      const mime = nonEmptyString(part.mime);
      parts.push({
        // An image attachment is something to look at, not a file row to open.
        // `mime` is what says which; a file row for a screenshot buries it.
        type: mime?.startsWith("image/") ? "image" : "file",
        content: path,
        ...(mime?.startsWith("image/") ? { imageSource: "attachment" } : {}),
        ...(mime ? { mime } : {}),
        ...(nonEmptyString(part.source) ? { fileSource: part.source } : {}),
        ...(typeof part.url === "string" ? { fileUrl: part.url } : {}),
        ...source,
      });
      continue;
    }
    if (part.type === "compaction") {
      parts.push({
        type: "compaction",
        // OpenCode reports the boundary; the summary, when it has one, lives
        // on the message that follows it rather than on the part.
        content: nonEmptyString(part.summary) ?? "",
        ...(typeof part.tokens === "number" ? { compactedTokensBefore: part.tokens } : {}),
        ...source,
      });
      continue;
    }
    if (part.type === "retry") {
      parts.push({
        type: "retry",
        content: nonEmptyString(part.error) ?? nonEmptyString(part.reason) ?? "The request failed",
        // A `retry` part in a persisted message is a retry that already
        // happened: the message it belongs to exists, so the request it
        // describes resolved one way or another.
        toolState: "success",
        ...(typeof part.attempt === "number" ? { retryAttempt: part.attempt } : {}),
        ...source,
      });
      continue;
    }
    if (part.type === "subtask") {
      const childSessionId = nonEmptyString(part.sessionID) ?? nonEmptyString(part.sessionId);
      const model = asRecord(part.model);
      const providerId = nonEmptyString(model?.providerID);
      const modelId = nonEmptyString(model?.modelID);
      parts.push({
        type: "subagent",
        content: nonEmptyString(part.description) ?? nonEmptyString(part.agent) ?? "Sub-agent",
        // Which of the two sources produced this row, so the dedupe below is
        // legible rather than implicit.
        subagentSource: "part",
        ...(childSessionId ? { subagentId: childSessionId } : {}),
        ...(nonEmptyString(part.description) ? { subagentName: part.description } : {}),
        ...(nonEmptyString(part.agent) ? { subagentRole: part.agent } : {}),
        ...(nonEmptyString(part.prompt) ? { subagentPrompt: part.prompt } : {}),
        ...(providerId && modelId ? { subagentModelId: `${providerId}/${modelId}` } : {}),
        subagentActions: [],
        subagentActionCount: 0,
        ...source,
      });
      continue;
    }
    // Step markers, snapshots, patches and agent parts carry nothing to show.
    if (part.type !== "tool") continue;
    const state = asRecord(part.state);
    const toolName = nonEmptyString(part.tool) ?? "Unknown tool";
    const rawStatus = state?.status;
    const toolState =
      rawStatus === "completed"
        ? "success"
        : rawStatus === "error"
          ? "failure"
          : rawStatus === "pending" || rawStatus === "running"
            ? "pending"
            : undefined;
    const isSubagent = toolName.toLowerCase() === "task" || toolName.toLowerCase() === "agent";
    const input = asRecord(state?.input) ?? undefined;
    const toolOutput = stringifyOpenCodeToolValue(state?.output);
    const taskEnvelope = isSubagent ? openCodeTaskEnvelope(toolOutput) : {};
    const metadata = asRecord(state?.metadata) ?? asRecord(part.metadata);
    const subagentId = isSubagent
      ? (openCodeRecordString(metadata, "sessionId", "sessionID", "jobId") ??
        taskEnvelope.sessionId)
      : undefined;
    const subagentName = isSubagent
      ? (openCodeRecordString(input, "description") ??
        (typeof state?.title === "string" ? state.title : toolName))
      : undefined;
    const subagentRole = isSubagent
      ? openCodeRecordString(input, "subagent_type", "agent")
      : undefined;
    const subagentPrompt = isSubagent ? openCodeRecordString(input, "prompt") : undefined;
    // The child's resolved model, which only its task tool's metadata carries.
    const subagentModel = isSubagent ? asRecord(metadata?.model) : undefined;
    const subagentModelId =
      nonEmptyString(subagentModel?.providerID) && nonEmptyString(subagentModel?.modelID)
        ? `${subagentModel!.providerID}/${subagentModel!.modelID}`
        : undefined;
    const normalizedToolState =
      taskEnvelope.state === "running"
        ? "pending"
        : taskEnvelope.state === "completed"
          ? "success"
          : taskEnvelope.state === "error"
            ? "failure"
            : toolState;
    const toolDurationMs =
      normalizedToolState === "pending" ? undefined : openCodeToolDurationMs(state);
    // The provider's own `subtask` record for this child already produced a
    // row. Keeping the heuristic one too would show one sub-agent twice.
    if (isSubagent && subagentId && subtaskSessionIds.has(subagentId)) continue;
    const toolDiff = isSubagent
      ? undefined
      : toolDiffFromOpenCodeToolState({
          toolName,
          input,
          metadata,
          title: typeof state?.title === "string" ? state.title : undefined,
          output: toolOutput,
        });
    parts.push({
      type: isSubagent ? "subagent" : "tool-invocation",
      content: typeof state?.title === "string" ? state.title : toolName,
      toolName,
      // A shared registration's artifact grant never leaves the provider
      // record: every consumer of this normalization sees it redacted.
      ...(input
        ? {
            toolArgs:
              redactArtifactGrantArgs(toolName, input, { toolTitle: state?.title }) ?? input,
          }
        : {}),
      ...(normalizedToolState ? { toolState: normalizedToolState } : {}),
      ...(toolDurationMs === undefined ? {} : { toolDurationMs }),
      ...(typeof state?.title === "string" ? { toolTitle: state.title } : {}),
      ...(toolOutput === undefined ? {} : { toolOutput }),
      ...(state?.error === undefined ? {} : { toolError: stringifyOpenCodeToolValue(state.error) }),
      ...(toolDiff ? { toolDiff } : {}),
      ...(isSubagent
        ? {
            // The fallback path: recognised from the tool call's shape rather
            // than reported as a sub-agent by the server.
            subagentSource: "tool" as const,
            ...(subagentId ? { subagentId } : {}),
            ...(subagentName ? { subagentName } : {}),
            ...(subagentRole ? { subagentRole } : {}),
            ...(subagentPrompt ? { subagentPrompt } : {}),
            ...(subagentModelId ? { subagentModelId } : {}),
            subagentActions: [],
            subagentActionCount: 0,
          }
        : {}),
      ...source,
    });
  }
  const providerId = nonEmptyString(info.providerID);
  const modelId = nonEmptyString(info.modelID);
  return {
    id: messageId,
    role,
    content,
    parts,
    createdAt,
    ...(role === "assistant" && modelId
      ? { modelId: providerId ? `${providerId}/${modelId}` : modelId }
      : {}),
  };
}

function normalizeOpenCodeTerminalState(value: unknown): {
  kind: "error" | "stopped";
  message: string;
} | null {
  const info = asRecord(asRecord(value)?.info);
  if (!info || info.error === undefined || info.error === null) return null;
  const error = asRecord(info.error);
  const name = nonEmptyString(error?.name);
  if (name === "MessageAbortedError") {
    return { kind: "stopped", message: TURN_STOPPED_BY_USER_MESSAGE };
  }
  const data = asRecord(error?.data);
  const detail =
    typeof info.error === "string"
      ? info.error
      : (nonEmptyString(data?.message) ??
        nonEmptyString(error?.message) ??
        name ??
        "OpenCode session failed");
  return {
    kind: "error",
    message: boundedText(detail, "OpenCode session failed"),
  };
}

/**
 * Appended when the provider refused a tool definition, which otherwise reads
 * like a fault in the conversation rather than in the tools sent with it.
 */
export const OPEN_CODE_TOOL_SCHEMA_REJECTION_HINT =
  " — the model provider rejected the JSON Schema of a tool offered to the model, so the model never ran. Retrying with this model will fail the same way; choose another model or fix the tool definition.";

/**
 * A durable transcript row for an assistant message that failed.
 *
 * OpenCode persists the failure on the message itself, which often has no
 * parts of its own. Without this row the failure is only visible while the
 * failed message is the latest one; once the conversation moves on, the
 * transcript reads as if the agent simply stopped. User stops are excluded —
 * they already render as a stop marker and are not failures.
 */
export function normalizeOpenCodeInlineError(value: unknown): Record<string, unknown> | null {
  const terminal = normalizeOpenCodeTerminalState(value);
  if (terminal?.kind !== "error") return null;
  const info = asRecord(asRecord(value)?.info)!;
  const messageId = nonEmptyString(info.id);
  if (!messageId) return null;
  const error = asRecord(info.error);
  const statusCode = asRecord(error?.data)?.statusCode;
  const content =
    nonEmptyString(error?.name) === "APIError"
      ? `Model request failed${typeof statusCode === "number" ? ` (HTTP ${statusCode})` : ""}: ${terminal.message}${
          isOpenCodeToolSchemaRejection(error) ? OPEN_CODE_TOOL_SCHEMA_REJECTION_HINT : ""
        }`
      : terminal.message;
  const time = asRecord(info.time);
  const createdAt =
    [time?.completed, time?.created]
      .filter((candidate): candidate is number => typeof candidate === "number")
      .map(openCodeIsoTimestamp)
      .find((candidate) => candidate !== undefined) ?? OPEN_CODE_UNKNOWN_CREATED_AT;
  const providerId = nonEmptyString(info.providerID);
  const modelId = nonEmptyString(info.modelID);
  return {
    // `error-opencode-<id>`: rendered as an error alert, not an assistant reply.
    id: providerInlineErrorMessageId("opencode", messageId),
    role: "assistant",
    content,
    parts: [{ type: "text", content }],
    createdAt,
    // Names the provider a credential failure came from, for the sign-in card.
    ...(modelId ? { modelId: providerId ? `${providerId}/${modelId}` : modelId } : {}),
  };
}

/** Same bound the normalizer puts on one message's parts. */
const MAX_PARTS_PER_MESSAGE = 2_048;

function hasVisibleContent(message: Record<string, unknown>): boolean {
  return (
    (Array.isArray(message.parts) && message.parts.length > 0) ||
    (typeof message.content === "string" && message.content.trim().length > 0)
  );
}

/**
 * Each part's own start time, by provider part id.
 *
 * The envelope normalizer stamps only the message. A pipeline transcript splits
 * one long turn into text and tool sections and timestamps each from its
 * parts, so without these every section would claim the turn's start.
 */
function withPartTimestamps(parts: unknown, rawParts: unknown): unknown {
  if (!Array.isArray(parts) || !Array.isArray(rawParts)) return parts;
  const starts = new Map<string, string>();
  for (const candidate of rawParts.slice(0, MAX_PARTS_PER_MESSAGE)) {
    const part = asRecord(candidate);
    const id = nonEmptyString(part?.id);
    const start = asRecord(part?.time)?.start;
    if (!id || typeof start !== "number" || start < 0) continue;
    const createdAt = openCodeIsoTimestamp(start);
    if (createdAt) starts.set(id, createdAt);
  }
  if (starts.size === 0) return parts;
  return parts.map((candidate) => {
    const part = asRecord(candidate);
    const id = nonEmptyString(part?.sourcePartId);
    const createdAt = id ? starts.get(id) : undefined;
    return part && createdAt && part.createdAt === undefined ? { ...part, createdAt } : candidate;
  });
}

/** Drop the normalizer's "unknown" sentinel so the renderer's stage-start fallback applies. */
function withoutUnknownCreatedAt(message: Record<string, unknown>): Record<string, unknown> {
  if (message.createdAt !== OPEN_CODE_UNKNOWN_CREATED_AT) return message;
  const { createdAt: _unknown, ...rest } = message;
  return rest;
}

/**
 * One transcript entry for display. `index` is the entry's position in the
 * transcript it was read from; it names a message that carries no id of its
 * own, so pass the absolute position wherever it is known.
 */
export function normalizeOpenCodeDisplayEntry(value: unknown, index: number): unknown {
  const envelope = asRecord(value);
  const info = asRecord(envelope?.info);
  if (!envelope || !info) return value;

  let normalized: Record<string, unknown> | null = null;
  try {
    normalized = normalizeOpenCodeEnvelope(envelope, index);
  } catch {
    normalized = null;
  }
  if (!normalized) {
    // Unreadable, but still one row: the client's copy is addressed by index.
    return {
      id: nonEmptyString(info.id) ?? `opencode-message-${index}`,
      role: info.role === "user" || info.role === "system" ? info.role : "assistant",
      content: "",
      parts: [],
    };
  }

  const message = withoutUnknownCreatedAt({
    ...normalized,
    parts: withPartTimestamps(normalized.parts, envelope.parts),
  });
  if (hasVisibleContent(message)) return message;

  // A failed assistant message usually has no parts of its own. Its error is
  // the only thing worth showing in that row, styled as the error it is.
  let inlineError: Record<string, unknown> | null = null;
  try {
    inlineError = normalizeOpenCodeInlineError(envelope);
  } catch {
    inlineError = null;
  }
  return inlineError ? withoutUnknownCreatedAt(inlineError) : message;
}

/** {@link normalizeOpenCodeDisplayEntry} over a window starting at `firstIndex`. */
export function normalizeOpenCodeDisplayEntries(
  values: readonly unknown[],
  firstIndex = 0,
): unknown[] {
  return values.map((value, offset) => normalizeOpenCodeDisplayEntry(value, firstIndex + offset));
}
