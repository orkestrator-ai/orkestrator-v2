import type { Part as OpenCodePart } from "@opencode-ai/sdk/v2/types";
import {
  tryParseStructuredOutputText,
  type JsonSchema,
} from "@orkestrator/protocol/structured-output";
import { asRecord, boundedText, nonEmptyString } from "./agent-provider-runtime.js";

/**
 * Which OpenCode part kinds this normalizer accounts for.
 *
 * A `Record` over the SDK's own `Part` union rather than a list, so an OpenCode
 * release that adds a part kind **fails this typecheck** instead of the part
 * disappearing from transcripts with nothing to show for it. `true` means a
 * branch below renders it; `false` means known and deliberately dropped —
 * documented one by one because "we chose not to show this" and "we never
 * heard of this" must not look the same in the drift counter.
 */
export const KNOWN_OPEN_CODE_PART_TYPES: Record<OpenCodePart["type"], boolean> = {
  text: true,
  reasoning: true,
  file: true,
  tool: true,
  // OpenCode's first-class sub-agent record. Preferred over the `tool`
  // heuristic, and deduplicated against it by child session id.
  subtask: true,
  // Context compaction and provider retry, each its own transcript row.
  compaction: true,
  retry: true,
  // Per-step accounting carriers. No user-facing content of their own; their
  // cost/token fields feed the usage meter in plan 11.
  "step-start": false,
  "step-finish": false,
  // Internal bookkeeping with nothing a reader could act on: a workspace
  // snapshot id, a raw patch already represented by the tool row that made it,
  // and the agent identity already carried on the message.
  snapshot: false,
  patch: false,
  agent: false,
};

export function isKnownOpenCodePartType(type: unknown): boolean {
  return typeof type === "string" && type in KNOWN_OPEN_CODE_PART_TYPES;
}

/**
 * The schema constrains the *final* message, not the whole turn.
 *
 * `parseOpenCodeStructuredText` joins the turn's text parts and recovers the
 * last well-formed document, so prose before that document has always been
 * safe. Forbidding commentary outright left a long structured turn looking
 * silent to anyone watching the tab.
 */
export function openCodeStructuredPrompt(prompt: string, schema: JsonSchema): string {
  return `${prompt}\n\n## Required OpenCode output\n\nEnd your turn with exactly one JSON value matching this JSON Schema. That final message must be the JSON value alone, not wrapped in Markdown and with no commentary around it.\n\nBefore that final message you may send ordinary prose progress updates. Keep them plain sentences: never send a JSON object or array as a progress update, and never draft or preview the final value.\n\n${JSON.stringify(schema)}`;
}

/**
 * Join OpenCode text parts and recover the structured JSON value. Reasoning
 * parts are ignored so a thinking trace cannot be parsed as the contract
 * payload.
 */
export function parseOpenCodeStructuredText(parts: unknown): unknown {
  if (!Array.isArray(parts)) throw new Error("OpenCode returned no structured text");
  const text = parts
    .flatMap((part) => {
      const candidate = asRecord(part);
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("")
    .trim();
  if (!text) throw new Error("OpenCode returned no structured text");

  const value = tryParseStructuredOutputText(text);
  if (value === undefined) throw new Error("OpenCode returned malformed structured text");
  return value;
}

function stringifyOpenCodeToolValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.slice(0, 200_000);
  try {
    return JSON.stringify(value, null, 2).slice(0, 200_000);
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

export function collectNormalizedOpenCodeSubagentIds(
  messages: readonly Record<string, unknown>[],
): string[] {
  const ids = new Set<string>();
  const visit = (parts: unknown, depth: number) => {
    if (!Array.isArray(parts) || depth > 8) return;
    for (const candidate of parts) {
      const part = asRecord(candidate);
      if (!part) continue;
      const id = nonEmptyString(part.subagentId);
      if (part.type === "subagent" && id) ids.add(id);
      visit(part.subagentActions, depth + 1);
    }
  };
  for (const message of messages) visit(message.parts, 0);
  return [...ids];
}

export function collectRawOpenCodeSubagentIds(messages: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const candidate of messages) {
    const envelope = asRecord(candidate);
    if (!Array.isArray(envelope?.parts)) continue;
    for (const rawPart of envelope.parts) {
      const part = asRecord(rawPart);
      const state = asRecord(part?.state);
      const toolName = nonEmptyString(part?.tool)?.toLowerCase();
      if (toolName !== "task" && toolName !== "agent") continue;
      const metadata = asRecord(state?.metadata) ?? asRecord(part?.metadata);
      const id =
        openCodeRecordString(metadata, "sessionId", "sessionID", "jobId") ??
        openCodeTaskEnvelope(stringifyOpenCodeToolValue(state?.output)).sessionId;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function hydrateNormalizedOpenCodeSubagents(
  messages: readonly Record<string, unknown>[],
  childMessages: ReadonlyMap<string, readonly Record<string, unknown>[]>,
): Record<string, unknown>[] {
  const countTools = (parts: readonly Record<string, unknown>[]): number =>
    parts.reduce(
      (count, part) =>
        count +
        (part.type === "tool-invocation" ? 1 : 0) +
        (Array.isArray(part.subagentActions)
          ? countTools(
              part.subagentActions.flatMap((entry) => {
                const record = asRecord(entry);
                return record ? [record] : [];
              }),
            )
          : 0),
      0,
    );
  const hydrateParts = (
    rawParts: unknown,
    ancestry: ReadonlySet<string>,
  ): Record<string, unknown>[] => {
    if (!Array.isArray(rawParts)) return [];
    return rawParts.flatMap((candidate) => {
      const part = asRecord(candidate);
      if (!part) return [];
      const id = part.type === "subagent" ? nonEmptyString(part.subagentId) : null;
      if (!id || ancestry.has(id)) return [{ ...part }];
      const transcript = childMessages.get(id);
      if (!transcript) return [{ ...part }];
      const nextAncestry = new Set(ancestry);
      nextAncestry.add(id);
      const actions = transcript.flatMap((message) =>
        message.role === "assistant" ? hydrateParts(message.parts, nextAncestry) : [],
      );
      return [
        {
          ...part,
          subagentActions: actions,
          subagentActionCount: countTools(actions),
        },
      ];
    });
  };
  return messages.map((message) => ({
    ...message,
    parts: hydrateParts(message.parts, new Set()),
  }));
}

export function normalizeOpenCodeInteractiveMessage(
  value: unknown,
  index: number,
  /**
   * Called once per part kind this normalizer has no branch for.
   *
   * The *kind name* only. Optional so the pure normalizer stays callable from
   * tests and from the renderer's copy without threading a recorder through.
   */
  onUnknownPart?: (type: string) => void,
): Record<string, unknown> | null {
  const envelope = asRecord(value);
  const info = asRecord(envelope?.info);
  if (!envelope || !info) return null;
  const role =
    info.role === "user" || info.role === "assistant" || info.role === "system"
      ? info.role
      : "assistant";
  const messageId = nonEmptyString(info.id) ?? `opencode-message-${index}`;
  const rawCreatedAt = asRecord(info.time)?.created;
  const createdAt =
    typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt)
      ? new Date(rawCreatedAt).toISOString()
      : typeof rawCreatedAt === "string" && Number.isFinite(Date.parse(rawCreatedAt))
        ? new Date(rawCreatedAt).toISOString()
        : "1970-01-01T00:00:00.000Z";
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
      const reasoning = part.text.replace(/^\s*\*\*/, "").replace(/\*\*\s*$/, "");
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
    if (part.type !== "tool") {
      // A kind the table does not name is an SDK addition and is counted;
      // a kind it names as `false` is a documented drop and is not.
      if (!isKnownOpenCodePartType(part.type)) {
        onUnknownPart?.(typeof part.type === "string" ? part.type : "(untyped)");
      }
      continue;
    }
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
    const normalizedToolState =
      taskEnvelope.state === "running"
        ? "pending"
        : taskEnvelope.state === "completed"
          ? "success"
          : taskEnvelope.state === "error"
            ? "failure"
            : toolState;
    // The provider's own `subtask` record for this child already produced a
    // row. Keeping the heuristic one too would show one sub-agent twice.
    if (isSubagent && subagentId && subtaskSessionIds.has(subagentId)) continue;
    parts.push({
      type: isSubagent ? "subagent" : "tool-invocation",
      content: typeof state?.title === "string" ? state.title : toolName,
      toolName,
      ...(input ? { toolArgs: input } : {}),
      ...(normalizedToolState ? { toolState: normalizedToolState } : {}),
      ...(typeof state?.title === "string" ? { toolTitle: state.title } : {}),
      ...(toolOutput === undefined ? {} : { toolOutput }),
      ...(state?.error === undefined ? {} : { toolError: stringifyOpenCodeToolValue(state.error) }),
      ...(isSubagent
        ? {
            // The fallback path: recognised from the tool call's shape rather
            // than reported as a sub-agent by the server.
            subagentSource: "tool" as const,
            ...(subagentId ? { subagentId } : {}),
            ...(subagentName ? { subagentName } : {}),
            ...(subagentRole ? { subagentRole } : {}),
            ...(subagentPrompt ? { subagentPrompt } : {}),
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

export function normalizeOpenCodeTerminalState(value: unknown): {
  kind: "error" | "stopped";
  message: string;
} | null {
  const info = asRecord(asRecord(value)?.info);
  if (!info || info.error === undefined || info.error === null) return null;
  const error = asRecord(info.error);
  const name = nonEmptyString(error?.name);
  if (name === "MessageAbortedError") {
    return { kind: "stopped", message: "Query stopped by user." };
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
