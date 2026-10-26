/**
 * How a failed Codex turn explains itself in the transcript.
 *
 * app-server ends a turn the provider refused (a ChatGPT login refusing
 * `gpt-5.4`, say) with `status: "failed"` and the provider's response body as
 * the error message, before any item streams. Without a row the turn read as
 * idle with an empty reply, and the reason survived only in the session
 * status, which the next turn replaces. The rollout keeps the same error on
 * its `task_complete` record, so a reloaded transcript shows it too.
 */

/** Longest reason shown; a provider body can be large. */
export const MAX_TURN_FAILURE_CHARS = 2_000;

/** Same id live and on replay, so a turn holds one failure line. */
export function turnFailureItemId(turnId: string): string {
  return `turn-error:${turnId}`;
}

/**
 * The human sentence in a turn error. A JSON provider body
 * (`{"type":"error","status":400,"error":{"message":"…"}}`) gives its
 * `error.message`; anything else is shown as it came, trimmed and bounded.
 */
export function turnFailureText(message: string): string {
  const raw = message.trim();
  let text = raw;
  if (raw.startsWith("{")) {
    try {
      const body = JSON.parse(raw) as { error?: unknown; message?: unknown };
      const nested =
        body.error && typeof body.error === "object"
          ? (body.error as { message?: unknown }).message
          : undefined;
      const candidate = typeof nested === "string" ? nested : body.message;
      if (typeof candidate === "string" && candidate.trim()) text = candidate.trim();
    } catch {
      // Not JSON after all: show it as it came.
    }
  }
  if (!text) text = "Codex ended the turn on an error.";
  return text.length > MAX_TURN_FAILURE_CHARS
    ? `${text.slice(0, MAX_TURN_FAILURE_CHARS - 1)}…`
    : text;
}
