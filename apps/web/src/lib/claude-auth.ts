export const CLAUDE_AUTH_LOGIN_COMMAND = "claude auth login";

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
