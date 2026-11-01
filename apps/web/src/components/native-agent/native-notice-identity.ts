import type { NativeAgentNotice } from "@orkestrator/protocol/native-agent";

/** Longest notice text used as its own identity; the backend stores ids bounded. */
const MAX_TEXT_IDENTITY_CHARS = 512;

function fingerprint(text: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

/**
 * A notice's identity for dismissal: its occurrence, or its text when it has
 * none. A long text is cut and fingerprinted so its dismissal can be stored.
 */
export function nativeNoticeDismissalId(notice: NativeAgentNotice): string {
  const severity = notice.kind === "advisory" ? notice.severity : notice.kind;
  const identity = notice.occurrenceId ?? notice.message;
  const bounded =
    identity.length > MAX_TEXT_IDENTITY_CHARS
      ? `${identity.slice(0, MAX_TEXT_IDENTITY_CHARS)}#${fingerprint(identity)}`
      : identity;
  return `${notice.kind}\u0000${severity}\u0000${bounded}`;
}

export function nativeNoticeToastId(sessionIdentity: string, noticeId: string): string {
  return `native-agent-notice:${sessionIdentity}:${noticeId}`;
}

export function nativeNoticeToastType(
  notice: NativeAgentNotice,
): "error" | "info" | "loading" | "warning" {
  if (notice.kind === "recovery") return "loading";
  if (notice.kind === "error" || (notice.kind === "advisory" && notice.severity === "error")) {
    return "error";
  }
  if (
    notice.kind === "warning" ||
    notice.kind === "auth" ||
    notice.kind === "incomplete-turn" ||
    (notice.kind === "advisory" && notice.severity === "warning")
  ) {
    return "warning";
  }
  return "info";
}
