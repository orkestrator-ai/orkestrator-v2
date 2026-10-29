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
 *
 * A login the API refuses outright sends no recovery at all: app-server treats
 * an invalid API key as signed in, retries the request and fails the turn with
 * a 401 (`refusedLoginNotice`). The notice names the login `account/read`
 * reports, because the turn's error does not say which kind was refused.
 */
import type { CodexLoginKind, EngineError } from "../engine/types.js";
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

export const CODEX_LOGIN_REFUSED_MESSAGE =
  "Codex's login was refused. Sign in to Codex again to keep working.";
export const CODEX_CHATGPT_LOGIN_REFUSED_MESSAGE =
  "Codex's ChatGPT login was refused. Sign in to Codex again to keep working.";
/**
 * An API-key user is told where the key is replaced as well as offered the
 * in-tab sign-in, which would switch them to a ChatGPT login. A key stored with
 * `codex login --with-api-key` clears the notice once the bridge next reads the
 * account (`requestAccountReloadFromStoredLogin`).
 */
export const CODEX_API_KEY_REFUSED_MESSAGE =
  "Codex's API key was refused. Replace it with codex login --with-api-key, or sign in to Codex with ChatGPT instead.";

const REFUSED_LOGIN_MESSAGES: Record<CodexLoginKind | "unknown", string> = {
  unknown: CODEX_LOGIN_REFUSED_MESSAGE,
  chatgpt: CODEX_CHATGPT_LOGIN_REFUSED_MESSAGE,
  apiKey: CODEX_API_KEY_REFUSED_MESSAGE,
};

function isRefusedLoginNotice(notice: ThreadAuthNotice | undefined): notice is ThreadAuthNotice {
  return (
    notice?.state === "needs-auth" && Object.values(REFUSED_LOGIN_MESSAGES).includes(notice.message)
  );
}

/**
 * Whether a failed turn's error is the API refusing the login: app-server's
 * `unauthorized`, or a 401 on a variant that forwards the upstream status
 * (`httpConnectionFailed`, `responseStreamConnectionFailed`,
 * `responseStreamDisconnected`, `responseTooManyFailedAttempts`). Only a 401:
 * the notice locks the composer, so a failure with no status or a 5xx, which
 * signing in would not fix, never raises it.
 */
export function isRefusedLoginError(error: EngineError | undefined): boolean {
  if (!error) return false;
  return error.code === "unauthorized" || error.httpStatusCode === 401;
}

/**
 * The notice for a turn whose login was refused, naming the login when
 * `account/read` has said which it is. A refusal already shown keeps its
 * occurrence, so a notice the user dismissed stays dismissed when the next
 * turn is refused the same way, or when the login kind arrives after it.
 */
export function refusedLoginNotice(
  current: ThreadAuthNotice | undefined,
  login: CodexLoginKind | undefined,
  newOccurrenceId: () => string,
): ThreadAuthNotice {
  if (isRefusedLoginNotice(current)) {
    // An unknown kind never overwrites a notice that already names the login.
    const message = login ? REFUSED_LOGIN_MESSAGES[login] : current.message;
    return current.message === message ? current : { ...current, message };
  }
  return {
    state: "needs-auth",
    message: REFUSED_LOGIN_MESSAGES[login ?? "unknown"],
    occurrenceId: newOccurrenceId(),
  };
}

/**
 * A refused-login notice reworded for the login `account/read` reported after
 * it was raised; any other notice is returned as it is.
 */
export function withRefusedLoginKind(
  current: ThreadAuthNotice | undefined,
  login: CodexLoginKind,
): ThreadAuthNotice | undefined {
  return isRefusedLoginNotice(current) ? refusedLoginNotice(current, login, () => "") : current;
}
