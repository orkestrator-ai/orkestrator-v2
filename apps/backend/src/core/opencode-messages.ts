import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { asRecord, boundedText, nonEmptyString } from "./agent-provider-runtime.js";

export function openCodeStructuredPrompt(prompt: string, schema: JsonSchema): string {
  return `${prompt}\n\n## Required OpenCode output\n\nReturn only one JSON value matching this JSON Schema. Do not wrap it in Markdown or add commentary.\n\n${JSON.stringify(schema)}`;
}

// Bounds for the prose-wrapped JSON recovery scan. The scan is a last-resort
// tolerance for models that wrap the required JSON value in a sentence; the
// bounds keep pathological output from becoming unbounded work.
const OPEN_CODE_STRUCTURED_RECOVERY_CHARS = 16 * 1024;
const OPEN_CODE_STRUCTURED_RECOVERY_CANDIDATES = 16;

/**
 * Try to parse `candidate` as a JSON value. `undefined` is the sentinel for
 * "not JSON" because `JSON.parse` never produces `undefined`.
 */
function tryParseJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Extract the well-formed JSON document that begins at `start` in `text`, if
 * one exists, by tracking bracket balance outside of string literals.
 */
function parseJsonDocumentAt(
  text: string,
  start: number,
): { value: unknown; end: number } | undefined {
  const open = text[start];
  if (open !== "{" && open !== "[") return undefined;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        const value = tryParseJson(text.slice(start, i + 1));
        return value === undefined ? undefined : { value, end: i };
      }
    }
  }
  return undefined;
}

/**
 * Last-resort recovery for a model that wrapped the required JSON document in
 * prose (a lead-in sentence or a trailing summary). Successful outer documents
 * are skipped as whole spans so their nested objects and arrays cannot replace
 * them. The last well-formed outer document wins, and arbitrary prose is never
 * interpreted as JSON.
 */
function lastWellFormedJson(text: string): unknown {
  const scanned = text.slice(0, OPEN_CODE_STRUCTURED_RECOVERY_CHARS);
  let failedCandidates = 0;
  let recovered: unknown;
  for (let i = 0; i < scanned.length; i++) {
    const ch = scanned[i];
    if (ch !== "{" && ch !== "[") continue;
    const parsed = parseJsonDocumentAt(scanned, i);
    if (parsed !== undefined) {
      recovered = parsed.value;
      i = parsed.end;
      continue;
    }
    failedCandidates += 1;
    if (failedCandidates >= OPEN_CODE_STRUCTURED_RECOVERY_CANDIDATES) break;
  }
  return recovered;
}

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

  // The prompt asks for a bare JSON value; accept it verbatim.
  const exact = tryParseJson(text);
  if (exact !== undefined) return exact;

  // One exact JSON fence is harmless presentation formatting. Arbitrary prose
  // is not searched for JSON here — the bounded recovery below accepts only
  // balanced JSON documents, never prose.
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)?.[1]?.trim();
  if (fenced !== undefined) {
    const fencedValue = tryParseJson(fenced);
    if (fencedValue !== undefined) return fencedValue;
  }

  // Models occasionally wrap the value in a sentence or append a summary.
  // Recover the last well-formed JSON document before giving up.
  const recovered = lastWellFormedJson(text);
  if (recovered !== undefined) return recovered;

  throw new Error("OpenCode returned malformed structured text");
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

function openCodeRecordString(
  value: unknown,
  ...keys: string[]
): string | undefined {
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
      const id = openCodeRecordString(metadata, "sessionId", "sessionID", "jobId")
        ?? openCodeTaskEnvelope(stringifyOpenCodeToolValue(state?.output)).sessionId;
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
    parts.reduce((count, part) =>
      count
      + (part.type === "tool-invocation" ? 1 : 0)
      + (Array.isArray(part.subagentActions)
        ? countTools(part.subagentActions.flatMap((entry) => {
            const record = asRecord(entry);
            return record ? [record] : [];
          }))
        : 0), 0);
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
        message.role === "assistant"
          ? hydrateParts(message.parts, nextAncestry)
          : [],
      );
      return [{
        ...part,
        subagentActions: actions,
        subagentActionCount: countTools(actions),
      }];
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
): Record<string, unknown> | null {
  const envelope = asRecord(value);
  const info = asRecord(envelope?.info);
  if (!envelope || !info) return null;
  const role = info.role === "user" || info.role === "assistant" || info.role === "system"
    ? info.role
    : "assistant";
  const messageId = nonEmptyString(info.id) ?? `opencode-message-${index}`;
  const rawCreatedAt = asRecord(info.time)?.created;
  const createdAt = typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt)
    ? new Date(rawCreatedAt).toISOString()
    : typeof rawCreatedAt === "string" && Number.isFinite(Date.parse(rawCreatedAt))
      ? new Date(rawCreatedAt).toISOString()
      : "1970-01-01T00:00:00.000Z";
  const parts: Record<string, unknown>[] = [];
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
      parts.push({
        type: "file",
        content: path,
        ...(typeof part.url === "string" ? { fileUrl: part.url } : {}),
        ...source,
      });
      continue;
    }
    if (part.type !== "tool") continue;
    const state = asRecord(part.state);
    const toolName = nonEmptyString(part.tool) ?? "Unknown tool";
    const rawStatus = state?.status;
    const toolState = rawStatus === "completed"
      ? "success"
      : rawStatus === "error"
        ? "failure"
        : rawStatus === "pending" || rawStatus === "running"
          ? "pending"
          : undefined;
    const isSubagent = toolName.toLowerCase() === "task"
      || toolName.toLowerCase() === "agent";
    const input = asRecord(state?.input) ?? undefined;
    const toolOutput = stringifyOpenCodeToolValue(state?.output);
    const taskEnvelope = isSubagent ? openCodeTaskEnvelope(toolOutput) : {};
    const metadata = asRecord(state?.metadata) ?? asRecord(part.metadata);
    const subagentId = isSubagent
      ? openCodeRecordString(metadata, "sessionId", "sessionID", "jobId")
        ?? taskEnvelope.sessionId
      : undefined;
    const subagentName = isSubagent
      ? openCodeRecordString(input, "description")
        ?? (typeof state?.title === "string" ? state.title : toolName)
      : undefined;
    const subagentRole = isSubagent
      ? openCodeRecordString(input, "subagent_type", "agent")
      : undefined;
    const subagentPrompt = isSubagent
      ? openCodeRecordString(input, "prompt")
      : undefined;
    const normalizedToolState = taskEnvelope.state === "running"
      ? "pending"
      : taskEnvelope.state === "completed"
        ? "success"
        : taskEnvelope.state === "error" ? "failure" : toolState;
    parts.push({
      type: isSubagent ? "subagent" : "tool-invocation",
      content: typeof state?.title === "string" ? state.title : toolName,
      toolName,
      ...(input ? { toolArgs: input } : {}),
      ...(normalizedToolState ? { toolState: normalizedToolState } : {}),
      ...(typeof state?.title === "string" ? { toolTitle: state.title } : {}),
      ...(toolOutput === undefined ? {} : { toolOutput }),
      ...(state?.error === undefined
        ? {} : { toolError: stringifyOpenCodeToolValue(state.error) }),
      ...(isSubagent ? {
        ...(subagentId ? { subagentId } : {}),
        ...(subagentName ? { subagentName } : {}),
        ...(subagentRole ? { subagentRole } : {}),
        ...(subagentPrompt ? { subagentPrompt } : {}),
        subagentActions: [],
        subagentActionCount: 0,
      } : {}),
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
  const detail = typeof info.error === "string"
    ? info.error
    : nonEmptyString(data?.message)
      ?? nonEmptyString(error?.message)
      ?? name
      ?? "OpenCode session failed";
  return {
    kind: "error",
    message: boundedText(detail, "OpenCode session failed"),
  };
}
