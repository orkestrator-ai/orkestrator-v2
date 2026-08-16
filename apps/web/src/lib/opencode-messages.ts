import { countTextLines } from "@orkestrator/protocol/tool-diff";
import { isEditTool } from "./tool-names";
import { createUuid } from "./uuid";

import {
  isRecord,
  type OpenCodeMessage,
  type OpenCodeMessagePart,
  type ToolDiffMetadata,
} from "./opencode-types";

interface FileDiffMetadata {
  file?: string;
  before?: string;
  after?: string;
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseOpenCodeCreatedAt(value: unknown): string {
  if (typeof value === "number") {
    return new Date(value).toISOString();
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  return new Date().toISOString();
}

function isOpenCodeTaskTool(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase();
  return normalized === "task" || normalized === "agent";
}

function stringRecordValue(
  value: unknown,
  ...keys: string[]
): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function parseTaskEnvelope(output: string | undefined): {
  sessionId?: string;
  state?: "running" | "completed" | "error";
} {
  if (!output) return {};
  const match = output.match(
    /<task\s+id=["']([^"']+)["'](?:\s+state=["'](running|completed|error)["'])?/i,
  );
  if (!match) return {};
  return {
    sessionId: match[1],
    state: match[2]?.toLowerCase() as "running" | "completed" | "error" | undefined,
  };
}

function countOpenCodeToolActions(parts: OpenCodeMessagePart[]): number {
  let count = 0;
  for (const part of parts) {
    if (part.type === "tool-invocation") count++;
    if (part.type === "subagent" && part.subagentActions) {
      count += countOpenCodeToolActions(part.subagentActions);
    }
  }
  return count;
}

function flattenOpenCodeSubagentActions(messages: OpenCodeMessage[]): OpenCodeMessagePart[] {
  return messages.flatMap((message) =>
    message.role === "assistant" ? message.parts : [],
  );
}

export function mapOpenCodeParts(
  parts: OpenCodeMessagePart[],
  mapper: (part: OpenCodeMessagePart) => OpenCodeMessagePart,
): { parts: OpenCodeMessagePart[]; changed: boolean } {
  let changed = false;
  const nextParts = parts.map((part) => {
    let nextPart = part;
    if (part.type === "subagent" && part.subagentActions?.length) {
      const nested = mapOpenCodeParts(part.subagentActions, mapper);
      if (nested.changed) {
        nextPart = { ...part, subagentActions: nested.parts };
      }
    }
    nextPart = mapper(nextPart);
    if (nextPart !== part) changed = true;
    return nextPart;
  });
  return { parts: changed ? nextParts : parts, changed };
}

/** Return true when a transcript contains an OpenCode Task backed by this child session. */
export function hasOpenCodeSubagentSession(
  messages: OpenCodeMessage[],
  childSessionId: string,
): boolean {
  return messages.some((message) => {
    let found = false;
    mapOpenCodeParts(message.parts, (part) => {
      if (part.type === "subagent" && part.subagentId === childSessionId) {
        found = true;
      }
      return part;
    });
    return found;
  });
}

/**
 * Attach an authoritative child-session transcript to every matching Task part.
 * Nested Tasks are traversed as well, so child SSE events can update their
 * corresponding yellow Agent row without rebuilding the parent transcript.
 */
export function mergeOpenCodeSubagentTranscript(
  messages: OpenCodeMessage[],
  childSessionId: string,
  childMessages: OpenCodeMessage[],
  state?: "success" | "failure" | "pending",
): OpenCodeMessage[] {
  const actions = flattenOpenCodeSubagentActions(childMessages);
  const actionCount = countOpenCodeToolActions(actions);
  let changed = false;

  const nextMessages = messages.map((message) => {
    const mapped = mapOpenCodeParts(message.parts, (part) => {
      if (part.type !== "subagent" || part.subagentId !== childSessionId) {
        return part;
      }
      const nextState =
        state === "failure" || part.toolState === "failure"
          ? "failure"
          : part.toolState === "success"
            ? "success"
            : state ?? part.toolState;
      return {
        ...part,
        toolState: nextState,
        subagentActions: actions,
        subagentActionCount: actionCount,
      };
    });
    if (!mapped.changed) return message;
    changed = true;
    return { ...message, parts: mapped.parts };
  });

  return changed ? nextMessages : messages;
}

/**
 * Per-message and per-transcript caches for {@link collectOpenCodeSubagentIds}.
 *
 * Messages and transcript arrays are replaced (never mutated) by the stores, so
 * a WeakMap keyed on the object reference is a correct cache: a streaming tick
 * replaces exactly one message object and the surrounding array, which means a
 * lookup re-scans only the message that actually changed instead of deep
 * traversing every part of every message of every session per SSE frame.
 */
const transcriptSubagentIdsCache = new WeakMap<
  readonly OpenCodeMessage[],
  ReadonlySet<string>
>();
const messageSubagentIdsCache = new WeakMap<OpenCodeMessage, readonly string[]>();

/**
 * Collect every child session id referenced by a Task part in this transcript.
 *
 * O(1) amortized per call thanks to reference-keyed caching — see the cache
 * comment above. Use this instead of {@link hasOpenCodeSubagentSession} on hot
 * paths such as per-event routing.
 */
export function collectOpenCodeSubagentIds(
  messages: OpenCodeMessage[],
): ReadonlySet<string> {
  const cached = transcriptSubagentIdsCache.get(messages);
  if (cached) return cached;

  const ids = new Set<string>();
  for (const message of messages) {
    let messageIds = messageSubagentIdsCache.get(message);
    if (!messageIds) {
      const collected: string[] = [];
      mapOpenCodeParts(message.parts, (part) => {
        if (part.type === "subagent" && part.subagentId) {
          collected.push(part.subagentId);
        }
        return part;
      });
      messageIds = collected;
      messageSubagentIdsCache.set(message, messageIds);
    }
    for (const id of messageIds) ids.add(id);
  }
  transcriptSubagentIdsCache.set(messages, ids);
  return ids;
}

/**
 * Apply a `message.updated` event payload (`properties.info`) to an existing
 * message without refetching the transcript.
 *
 * The event carries only message-level metadata — role, error flag, token
 * usage — never parts; those stream separately via `message.part.updated`.
 * Returns null when the payload has no usable identity, in which case the
 * caller must fall back to an authoritative refetch.
 */
export function mergeOpenCodeMessageInfo(
  existing: OpenCodeMessage | undefined,
  rawInfo: unknown,
): OpenCodeMessage | null {
  const info = rawInfo as { id?: unknown } | null | undefined;
  if (!info || typeof info !== "object" || typeof info.id !== "string" || !info.id) {
    return null;
  }
  const normalized = normalizeOpenCodeMessage({ info: rawInfo, parts: [] });
  if (!normalized) return null;
  if (!existing) return normalized;
  const merged: OpenCodeMessage = {
    ...existing,
    role: normalized.role,
    // `info` is the whole message record, not a patch, so its error field is
    // authoritative in both directions: a message the server no longer reports
    // as errored (a retried turn) must lose the badge, not keep it forever.
    ...(normalized.hasError ? { hasError: true } : {}),
    ...(normalized.errorName ? { errorName: normalized.errorName } : {}),
    // Model and usage are only present once the backend has resolved them.
    // An early streaming `info` legitimately omits them, so absence means
    // "not known yet" rather than "cleared" — blanking would drop the
    // backend-confirmed model badge for the whole streaming turn.
    ...(normalized.modelId ? { modelId: normalized.modelId } : {}),
    ...(normalized.providerUsage
      ? { providerUsage: normalized.providerUsage }
      : {}),
  };
  if (!normalized.hasError) delete merged.hasError;
  if (!normalized.errorName) delete merged.errorName;
  return merged;
}

/**
 * Preserve already-hydrated subagent transcripts when replacing a transcript
 * with one fetched via `includeSubagents: false`.
 *
 * Streaming-triggered refetches skip the recursive child-session hydration for
 * cost; without this carry-over they would blank every expanded Agent row until
 * the next final (`session.idle`) reconcile re-hydrated it.
 */
export function carryOverOpenCodeSubagentHydration(
  previous: OpenCodeMessage[],
  next: OpenCodeMessage[],
): OpenCodeMessage[] {
  const hydratedBySubagentId = new Map<string, OpenCodeMessagePart>();
  for (const message of previous) {
    mapOpenCodeParts(message.parts, (part) => {
      if (
        part.type === "subagent" &&
        part.subagentId &&
        part.subagentActions?.length
      ) {
        hydratedBySubagentId.set(part.subagentId, part);
      }
      return part;
    });
  }
  if (hydratedBySubagentId.size === 0) return next;

  let changed = false;
  const merged = next.map((message) => {
    const mapped = mapOpenCodeParts(message.parts, (part) => {
      if (part.type !== "subagent" || !part.subagentId) return part;
      if (part.subagentActions?.length) return part;
      const hydrated = hydratedBySubagentId.get(part.subagentId);
      if (!hydrated) return part;
      return {
        ...part,
        subagentActions: hydrated.subagentActions,
        subagentActionCount: hydrated.subagentActionCount,
        // A cheap parent-only refresh often reports a still-running Task part
        // even though the hydrated child snapshot already proved it terminal.
        // Do not regress a completed child to pending until the authoritative
        // final hydration replaces it.
        toolState:
          hydrated.toolState === "success" || hydrated.toolState === "failure"
            ? hydrated.toolState
            : part.toolState ?? hydrated.toolState,
      };
    });
    if (!mapped.changed) return message;
    changed = true;
    return { ...message, parts: mapped.parts };
  });
  return changed ? merged : next;
}

function isOpenCodeReasoningInProgress(part: Record<string, unknown>): boolean {
  if (!part.time || typeof part.time !== "object") return false;

  const time = part.time as Record<string, unknown>;
  if (typeof time.start === "number") return time.end === undefined;
  return false;
}

function stripOpenCodeReasoningBoldMarkers(
  content: string,
  allowStreamingOpeningMarker: boolean,
): string {
  if (!content.replace(/\*\*/g, "").trim()) return "";

  const leadingMarker = content.match(/^(\s*)\*\*/);
  if (!leadingMarker) return content;

  const markerCount = content.match(/\*\*/g)?.length ?? 0;
  const trailingMarker = content.match(/\*\*(\s*)$/);

  // OpenCode wraps completed reasoning in a balanced outer bold pair. Remove
  // both delimiters together so inline or trailing Markdown is not corrupted.
  if (trailingMarker && markerCount === 2) {
    return `${leadingMarker[1]}${content.slice(
      leadingMarker[0].length,
      content.length - trailingMarker[0].length,
    )}${trailingMarker[1]}`;
  }

  // During streaming, the first delimiter can arrive before its closing pair.
  return allowStreamingOpeningMarker && markerCount === 1
    ? `${leadingMarker[1]}${content.slice(leadingMarker[0].length)}`
    : content;
}

export function normalizeOpenCodePart(part: unknown): OpenCodeMessagePart | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = part as any;
  if (!p || typeof p !== "object") return null;

  const sourcePartId = typeof p.id === "string" ? p.id : undefined;
  const sourceMessageId = typeof p.messageID === "string" ? p.messageID : undefined;
  const partType = p.type;

  if (partType === "reasoning") {
    const reasoningContent = typeof p.text === "string" ? p.text : "";
    if (!reasoningContent) return null;
    const normalizedContent = stripOpenCodeReasoningBoldMarkers(
      reasoningContent,
      isOpenCodeReasoningInProgress(p),
    );
    if (!normalizedContent.trim()) return null;
    return {
      type: "thinking",
      content: normalizedContent,
      sourcePartId,
      sourceMessageId,
    };
  }

  if (partType === "text" && typeof p.text === "string") {
    return {
      type: "text",
      content: p.text,
      sourcePartId,
      sourceMessageId,
    };
  }

  if (partType === "tool") {
    const toolName = typeof p.tool === "string" ? p.tool : "Unknown tool";
    const toolStatus = p.state?.status;

    let mappedState: "success" | "failure" | "pending" | undefined;
    if (toolStatus === "completed") mappedState = "success";
    else if (toolStatus === "error") mappedState = "failure";
    else if (toolStatus === "pending" || toolStatus === "running") mappedState = "pending";

    const toolTitle = p.state?.title as string | undefined;
    const toolOutput = stringifyToolPayload(p.state?.output);
    const toolError = stringifyToolPayload(p.state?.error);

    if (isOpenCodeTaskTool(toolName)) {
      const input = p.state?.input;
      const metadata = p.state?.metadata ?? p.metadata;
      const taskEnvelope = parseTaskEnvelope(toolOutput);
      const subagentId =
        stringRecordValue(metadata, "sessionId", "sessionID", "jobId") ??
        taskEnvelope.sessionId;
      const description =
        stringRecordValue(input, "description") ?? toolTitle ?? toolName;
      const role = stringRecordValue(input, "subagent_type", "agent");
      const prompt = stringRecordValue(input, "prompt");

      if (taskEnvelope.state === "running") mappedState = "pending";
      else if (taskEnvelope.state === "completed") mappedState = "success";
      else if (taskEnvelope.state === "error") mappedState = "failure";

      return {
        type: "subagent",
        content: description,
        sourcePartId,
        sourceMessageId,
        toolName,
        toolArgs: input,
        toolState: mappedState,
        toolTitle,
        toolOutput,
        toolError,
        subagentId,
        subagentName: description,
        subagentRole: role,
        subagentPrompt: prompt,
        subagentActions: [],
        subagentActionCount: 0,
      };
    }

    let toolDiff: ToolDiffMetadata | undefined;
    if (isEditTool(toolName)) {
      const input = p.state?.input || {};
      const meta = p.state?.metadata || {};
      const filediff = meta.filediff as FileDiffMetadata | undefined;

      const filePath = (input.filePath || input.file_path || input.path || input.file ||
        meta.file || meta.filePath || meta.path || filediff?.file) as string | undefined;

      const oldString = typeof input.oldString === "string" ? input.oldString :
        typeof input.old_string === "string" ? input.old_string : undefined;
      const newString = typeof input.newString === "string" ? input.newString :
        typeof input.new_string === "string" ? input.new_string :
        typeof input.content === "string" ? input.content : undefined;
      const metaBefore = typeof filediff?.before === "string" ? filediff.before :
        typeof meta.before === "string" ? meta.before : undefined;
      const metaAfter = typeof filediff?.after === "string" ? filediff.after :
        typeof meta.after === "string" ? meta.after : undefined;

      const unifiedDiff = typeof meta.diff === "string" ? meta.diff :
        typeof input.patch === "string" ? input.patch :
        typeof input.diff === "string" ? input.diff : undefined;

      const beforeValue = oldString ?? metaBefore;
      const afterValue = newString ?? metaAfter;

      let additions: number | undefined;
      let deletions: number | undefined;

      if (typeof meta.additions === "number" && typeof meta.deletions === "number") {
        additions = meta.additions as number;
        deletions = meta.deletions as number;
      } else if (unifiedDiff) {
        let addCount = 0;
        let delCount = 0;
        const lines = unifiedDiff.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
          else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
        }
        additions = addCount;
        deletions = delCount;
      } else if (toolOutput && toolOutput.includes("@@") && (toolOutput.includes("\n+") || toolOutput.includes("\n-"))) {
        let addCount = 0;
        let delCount = 0;
        const lines = toolOutput.split("\n");
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
          else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
        }
        if (addCount > 0 || delCount > 0) {
          additions = addCount;
          deletions = delCount;
        }
      } else if (beforeValue !== undefined || afterValue !== undefined) {
        const oldLines = countTextLines(beforeValue);
        const newLines = countTextLines(afterValue);
        if (beforeValue && afterValue) {
          deletions = oldLines;
          additions = newLines;
        } else if (afterValue) {
          additions = newLines;
          deletions = 0;
        } else if (beforeValue) {
          additions = 0;
          deletions = oldLines;
        }
      }

      toolDiff = {
        filePath,
        additions,
        deletions,
        before: beforeValue,
        after: afterValue,
        diff: unifiedDiff,
      };
    }

    return {
      type: "tool-invocation",
      content: toolName,
      sourcePartId,
      sourceMessageId,
      toolName,
      toolArgs: p.state?.input,
      toolState: mappedState,
      toolDiff,
      toolTitle,
      toolOutput,
      toolError,
    };
  }

  if (partType === "file") {
    const filePath = p.filename || p.url || "";
    return {
      type: "file",
      content: filePath,
      sourcePartId,
      sourceMessageId,
      fileUrl: typeof p.url === "string" ? p.url : undefined,
    };
  }

  return null;
}

export function normalizeOpenCodeMessage(rawMessage: unknown): OpenCodeMessage | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = rawMessage as any;
  if (!msg || typeof msg !== "object") return null;

  const info = msg.info;
  const createdAt = parseOpenCodeCreatedAt(info?.time?.created);
  const parsedParts: OpenCodeMessagePart[] = [];
  let textContent = "";
  let finishReason: string | undefined;
  const modelId =
    typeof info?.modelID === "string" && info.modelID.trim().length > 0
      ? typeof info?.providerID === "string" && info.providerID.trim().length > 0
        ? `${info.providerID.trim()}/${info.modelID.trim()}`
        : info.modelID.trim()
        : undefined;

  if (Array.isArray(msg.parts)) {
    for (const part of msg.parts) {
      if (
        part
        && typeof part === "object"
        && part.type === "step-finish"
        && typeof part.reason === "string"
        && part.reason.trim().length > 0
      ) {
        // A message can contain more than one step marker in malformed or
        // replayed data. The final marker is the terminal reason that matters.
        finishReason = part.reason.trim();
      }
      const parsedPart = normalizeOpenCodePart(part);
      if (!parsedPart) continue;
      parsedParts.push(parsedPart);
      if (parsedPart.type === "text") {
        textContent += parsedPart.content;
      }
    }
  }

  return {
    id: info?.id || createUuid(),
    role: (info?.role as "user" | "assistant") || "assistant",
    content: textContent,
    parts: parsedParts,
    createdAt,
    ...(info?.role === "assistant" && modelId ? { modelId } : {}),
    ...(info?.role === "assistant" && finishReason ? { finishReason } : {}),
    ...(info?.error !== undefined && info?.error !== null
      ? {
          hasError: true,
          // The discriminator only — enough to tell an intentional interrupt
          // from a real failure without retaining the error payload.
          ...(isRecord(info.error) && typeof info.error.name === "string"
            ? { errorName: info.error.name }
            : {}),
        }
      : {}),
    ...(info?.role === "assistant" && info?.tokens
      ? {
          providerUsage: {
            cost: typeof info.cost === "number" ? info.cost : 0,
            inputTokens: Number(info.tokens.input) || 0,
            outputTokens: Number(info.tokens.output) || 0,
            reasoningTokens: Number(info.tokens.reasoning) || 0,
            cacheReadTokens: Number(info.tokens.cache?.read) || 0,
            cacheWriteTokens: Number(info.tokens.cache?.write) || 0,
            totalTokens:
              typeof info.tokens.total === "number"
                ? info.tokens.total
                : undefined,
            // Keep usage parsing tolerant of older OpenCode payloads whose
            // model id was not typed as a string. The top-level `modelId`
            // displayed in the footer remains strict and backend-confirmed.
            modelId:
              typeof info.providerID === "string" && typeof info.modelID === "string"
                ? `${info.providerID}/${info.modelID}`
                : String(info.modelID ?? ""),
            agent: typeof info.agent === "string" ? info.agent : undefined,
            durationMs:
              typeof info.time?.completed === "number"
              && typeof info.time?.created === "number"
                ? Math.max(0, info.time.completed - info.time.created)
                : undefined,
          },
        }
      : {}),
  };
}

/**
 * Compute a stable identity key for a message part so incremental streaming
 * updates (`message.part.updated`) can replace the matching part in place.
 *
 * Prefers the SDK source part id; falls back to a composite key derived from
 * the source message id and the part's distinguishing fields. Returns null
 * when the part has no source identity (in which case it cannot be matched).
 */
export function getOpenCodePartKey(part: OpenCodeMessagePart): string | null {
  if (part.sourcePartId) return part.sourcePartId;
  if (part.sourceMessageId) {
    return [
      part.sourceMessageId,
      part.type,
      part.toolName,
      part.fileUrl,
      part.content,
    ].filter(Boolean).join(":");
  }
  return null;
}

/**
 * Build (or update) an OpenCode message from a single streamed part.
 *
 * If the part matches an existing part (by {@link getOpenCodePartKey}) it is
 * replaced in place; otherwise it is appended. When the incoming part carries
 * no content but a text `delta`, the delta is appended to the existing part's
 * content (incremental text streaming). The aggregate `content` is recomputed
 * from all text parts. Role/createdAt are preserved from the existing message,
 * defaulting to an assistant message created now. `existing` is partial so a
 * caller that only knows the echo's role/createdAt (e.g. a streamed part that
 * arrived before its `message.updated`) can seed the message without supplying
 * the parts it will be built from.
 */
export function buildOpenCodeMessageFromPart(
  existing: Partial<OpenCodeMessage> | undefined,
  messageId: string,
  part: OpenCodeMessagePart,
  delta?: string,
): OpenCodeMessage {
  const nextParts = [...(existing?.parts ?? [])];
  const incomingKey = getOpenCodePartKey(part);
  const existingIndex = incomingKey
    ? nextParts.findIndex((existingPart) => getOpenCodePartKey(existingPart) === incomingKey)
    : -1;
  const existingPart = existingIndex >= 0 ? nextParts[existingIndex] : undefined;
  const nextPart =
    part.content === "" && delta && existingPart?.type === part.type
      ? { ...part, content: `${existingPart.content}${delta}` }
      : part;

  if (existingIndex >= 0) {
    nextParts[existingIndex] = nextPart;
  } else {
    nextParts.push(nextPart);
  }

  const content = nextParts
    .filter((candidate) => candidate.type === "text")
    .map((candidate) => candidate.content)
    .join("");

  return {
    ...existing,
    id: messageId,
    role: existing?.role ?? "assistant",
    content,
    parts: nextParts,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Create an OpenCode SDK client connected to a server
 */
