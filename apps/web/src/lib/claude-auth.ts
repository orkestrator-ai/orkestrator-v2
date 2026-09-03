import type { NativeMessage } from "@/lib/chat/native-message-types";

/** Updates the host-owned Claude credential used by local environments. */
export const CLAUDE_AUTH_LOGIN_COMMAND = "claude auth login";
/** Starts Claude's interactive login inside an isolated container. */
export const CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND = "claude /login";

const NATIVE_TERMINAL_ERROR_MESSAGE_PREFIX = "native-terminal:error:";

const AUTH_ERROR_PATTERNS = [
  "failed to authenticate",
  "authentication_error",
  "invalid authentication credentials",
  "api error: 401",
] as const;

export function isClaudeAuthenticationError(message: string | null | undefined): boolean {
  if (!message) return false;

  const normalized = message.toLowerCase();
  return AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Authentication recovery is control state, so arbitrary assistant prose must
 * never activate it. The backend gives terminal failures a dedicated system
 * row; matching both that structured identity and its bounded error text keeps
 * ordinary explanations, tools, diffs and actions intact.
 */
export function isClaudeAuthenticationFailureMessage(
  message: Pick<NativeMessage, "id" | "role" | "content">,
): boolean {
  return (
    message.role === "system" &&
    message.id.startsWith(NATIVE_TERMINAL_ERROR_MESSAGE_PREFIX) &&
    isClaudeAuthenticationError(message.content)
  );
}
