/**
 * Terminal-state rows of a native-agent transcript.
 *
 * A provider that ends a turn on an error, or a stop, reports it in its
 * session state (`error`, an `error`/`stopped` notice), not as a transcript
 * row. The backend turns each into a system row with a `native-terminal:` id
 * so the tab shows why the turn ended. The full projection appends them to its
 * messages; the progressive state view carries them beside the transcript
 * (`terminalMessages`), because the progressive transcript read never sees the
 * session state. Both paths place them with {@link withNativeTerminalMessages},
 * so they agree on when a row is redundant.
 */
import { isNativeInlineErrorMessageId } from "./native-agent.js";

/** Whether this row reports a provider failure, including a reply's error status part. */
export function rowReportsProviderFailure(value: unknown): boolean {
  const row = record(value);
  if (!row || row.role === "user") return false;
  return (
    isNativeInlineErrorMessageId(row.id) ||
    (typeof row.id === "string" && row.id.startsWith(NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX)) ||
    (Array.isArray(row.parts) &&
      row.parts.some((candidate) => {
        const part = record(candidate);
        return part?.type === "status" && part.severity === "error";
      }))
  );
}

/** `native-terminal:<kind>:<hash>`, stable for one message. */
export const NATIVE_TERMINAL_MESSAGE_ID_PREFIX = "native-terminal:";
export const NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX = `${NATIVE_TERMINAL_MESSAGE_ID_PREFIX}error:`;

export function isNativeTerminalMessageId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(NATIVE_TERMINAL_MESSAGE_ID_PREFIX);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Find where the transcript's last row says why the turn failed.
 *
 * OpenCode ends a failed request with an inline error row (`error-…`) whose
 * text is the notice, possibly behind a prefix. Codex and Pi put an error
 * `status` part on the turn's last row instead, holding the provider's reason
 * trimmed, bounded with a trailing ellipsis, or (Codex) reduced from a JSON
 * body to its `error.message`, so a part whose text the error contains counts.
 */
function matchingFailure(row: Record<string, unknown>, message: string): "row" | number {
  if (isNativeInlineErrorMessageId(row.id) && typeof row.content === "string") {
    if (row.content === message || row.content.endsWith(`: ${message}`)) return "row";
  }
  if (!Array.isArray(row.parts)) return -1;
  let error = message.trim();
  // Compare the same decoded reason that providers render in a status part.
  // Keep the raw text for non-JSON errors and the existing bounded-text match.
  try {
    const body = record(JSON.parse(error));
    const nested = record(body?.error)?.message;
    const decoded = typeof nested === "string" ? nested : body?.message;
    if (typeof decoded === "string" && decoded.trim()) error = decoded.trim();
  } catch {
    // Plain provider error text.
  }
  return row.parts.findLastIndex((candidate) => {
    const part = record(candidate);
    if (part?.type !== "status" || part.severity !== "error") return false;
    if (typeof part.content !== "string") return false;
    const stated = part.content.trim().replace(/…$/, "").trimEnd();
    return stated.length > 0 && error.includes(stated);
  });
}

/**
 * `messages` followed by the terminal rows they do not already hold.
 *
 * A row is left out when its id is already present (a full projection carries
 * them in its messages) and, for an error, when the transcript's last row
 * already states it. A matching row or status part inherits the descriptor.
 * When there are no changes the caller keeps the original array and rows.
 */
export function withNativeTerminalMessages<T>(
  messages: T[],
  terminalMessages: readonly T[] | undefined,
): T[] {
  if (!terminalMessages?.length) return messages;
  const ids = new Set(messages.map((message) => record(message)?.id));
  const last = record(messages.at(-1));
  let enriched = last;
  const added = terminalMessages.filter((candidate) => {
    const row = record(candidate);
    const id = row?.id;
    if (!isNativeTerminalMessageId(id) || ids.has(id)) return false;
    if (
      last &&
      id.startsWith(NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX) &&
      typeof row?.content === "string"
    ) {
      const match = matchingFailure(last, row.content);
      if (match === "row" || match >= 0) {
        if (row.failure && enriched) {
          if (match === "row") {
            enriched = { ...enriched, failure: row.failure };
          } else if (Array.isArray(enriched.parts)) {
            enriched = {
              ...enriched,
              parts: enriched.parts.map((part, index) =>
                index === match ? { ...record(part), failure: row.failure } : part,
              ),
            };
          }
        }
        return false;
      }
    }
    ids.add(id);
    return true;
  });
  if (enriched !== last) return [...messages.slice(0, -1), enriched as T, ...added];
  return added.length === 0 ? messages : [...messages, ...added];
}
