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
 * Whether the transcript's last row already says why the turn failed.
 *
 * OpenCode ends a failed request with an inline error row (`error-…`) whose
 * text is the notice, possibly behind a prefix. Codex and Pi put an error
 * `status` part on the turn's last row instead, holding the provider's reason
 * trimmed, bounded with a trailing ellipsis, or (Codex) reduced from a JSON
 * body to its `error.message`, so a part whose text the error contains counts.
 */
function lastRowStatesFailure(last: unknown, message: string): boolean {
  const row = record(last);
  if (!row) return false;
  if (isNativeInlineErrorMessageId(row.id) && typeof row.content === "string") {
    if (row.content === message || row.content.endsWith(`: ${message}`)) return true;
  }
  if (!Array.isArray(row.parts)) return false;
  const error = message.trim();
  return row.parts.some((candidate) => {
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
 * already states it. Returns `messages` itself when nothing is added, so a
 * memoised caller keeps its identity.
 */
export function withNativeTerminalMessages<T>(
  messages: T[],
  terminalMessages: readonly T[] | undefined,
): T[] {
  if (!terminalMessages?.length) return messages;
  const ids = new Set(messages.map((message) => record(message)?.id));
  const last = messages.at(-1);
  const added = terminalMessages.filter((candidate) => {
    const row = record(candidate);
    const id = row?.id;
    if (!isNativeTerminalMessageId(id) || ids.has(id)) return false;
    if (
      id.startsWith(NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX) &&
      typeof row!.content === "string" &&
      lastRowStatesFailure(last, row!.content)
    ) {
      return false;
    }
    ids.add(id);
    return true;
  });
  return added.length === 0 ? messages : [...messages, ...added];
}
