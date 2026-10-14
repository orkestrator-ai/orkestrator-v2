/**
 * Display normalization for OpenCode transcripts the renderer receives outside
 * the interactive projection: build-pipeline transcript windows and the Multi
 * Review reviewer reads that bypass the provider's normalized snapshot.
 *
 * Persisted transcripts and provider reads stay raw on purpose. Structured
 * output recovery, result evidence and handoff detection all parse OpenCode's
 * `{ info, parts }` envelope, and pipelines persisted by older versions hold
 * exactly that shape. Normalizing on the way out, with the same normalizer the
 * interactive tab uses, lets every one of them render without the renderer
 * carrying a second copy of it.
 *
 * Strictly one entry in, one entry out. Build-pipeline transcript patches
 * address the client's copy by index and count, so this never adds, drops or
 * reorders entries. An entry that is not an OpenCode envelope — a flat bridge
 * message, or one this already normalized — passes through untouched, which
 * also makes the pass idempotent.
 *
 * Deterministic and total: a message with no id is named after its position,
 * a missing or out-of-range timestamp is omitted (the renderer anchors it to
 * the stage start) rather than stamped "now", and an entry the normalizer
 * cannot read becomes an empty row instead of failing the whole read.
 */
import { asRecord, nonEmptyString } from "./agent-provider-runtime.js";
import {
  OPEN_CODE_UNKNOWN_CREATED_AT,
  normalizeOpenCodeInlineError,
  normalizeOpenCodeInteractiveMessage,
  openCodeIsoTimestamp,
} from "./opencode-messages.js";

/** Same bound the normalizer puts on one message's parts. */
const MAX_PARTS_PER_MESSAGE = 2_048;

/** True for OpenCode's `{ info, parts }` envelope, the only shape normalized here. */
export function isOpenCodeTranscriptEnvelope(value: unknown): boolean {
  return asRecord(asRecord(value)?.info) !== null;
}

function hasVisibleContent(message: Record<string, unknown>): boolean {
  return (
    (Array.isArray(message.parts) && message.parts.length > 0) ||
    (typeof message.content === "string" && message.content.trim().length > 0)
  );
}

/**
 * Each part's own start time, by provider part id.
 *
 * The shared normalizer stamps only the message. A pipeline transcript splits
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
    normalized = normalizeOpenCodeInteractiveMessage(envelope, index);
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
