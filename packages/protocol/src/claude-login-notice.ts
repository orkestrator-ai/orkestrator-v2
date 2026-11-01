/**
 * The notice Claude Code itself writes as a reply when no login is available.
 * Matched in full, never as a substring, so assistant prose that merely
 * mentions logging in cannot activate sign-in recovery. Shared by the renderer's
 * sign-in card and the backend, which holds the refused prompt to send again.
 */
const NOT_LOGGED_IN_NOTICE = /^not logged in\s*[·•\-–—]\s*please run \/login\.?$/i;

export function isClaudeNotLoggedInText(text: string): boolean {
  return NOT_LOGGED_IN_NOTICE.test(text.trim());
}
