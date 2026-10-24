/**
 * The tab's `auth` notice for a Codex thread, from app-server's
 * `modelProvider/authRecovery{Started,Completed}` notifications.
 *
 * Codex renews a provider login on its own when a request is refused for
 * authentication. Started means the login stopped working mid-turn. Completed
 * carries no outcome field: codex 0.162 settles a renewal as succeeded,
 * failed-permanent or failed-transient and says which only in its text. So a
 * completion clears the notice unless its own words say the renewal failed, in
 * which case it stays as a sign-in prompt. A confirmed sign-out still locks the
 * composer through readiness (`account/read`), independently of this.
 */
import type { ThreadAuthNotice } from "./thread-registry.js";

const RENEWAL_FAILED =
  /\b(fail(?:ed|ure)?|could ?n[o']t|unable|unrecoverable|log ?(?:in|out) again|sign ?(?:in|out) again)\b/i;

export const CODEX_LOGIN_RENEWING_MESSAGE =
  "Codex's login stopped working during this turn, and Codex is renewing it.";
export const CODEX_LOGIN_RENEWAL_FAILED_SUFFIX = "Sign in to Codex again to keep working.";

export function nextThreadAuthNotice(
  current: ThreadAuthNotice | undefined,
  event: { phase: "started" | "completed"; message?: string },
  newOccurrenceId: () => string,
): ThreadAuthNotice | undefined {
  if (event.phase === "started") {
    // One renewal can be retried several times; keep the occurrence the user
    // may already have dismissed.
    if (current?.state === "expired") return current;
    return {
      state: "expired",
      message: event.message ?? CODEX_LOGIN_RENEWING_MESSAGE,
      occurrenceId: newOccurrenceId(),
    };
  }
  if (event.message && RENEWAL_FAILED.test(event.message)) {
    return {
      state: "needs-auth",
      message: `${event.message.replace(/[.\s]*$/, "")}. ${CODEX_LOGIN_RENEWAL_FAILED_SUFFIX}`,
      occurrenceId: current?.state === "needs-auth" ? current.occurrenceId : newOccurrenceId(),
    };
  }
  return undefined;
}
