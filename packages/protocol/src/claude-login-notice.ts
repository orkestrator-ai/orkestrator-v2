/**
 * The replies Claude Code itself writes when a turn cannot run for want of a
 * usable login: none at all ("Not logged in · Please run /login"), or one that
 * expired, reached its time limit, or was revoked. The CLI sends each as an
 * ordinary assistant reply carrying `error: "authentication_failed"`, which the
 * transcript does not keep, so the text is all that survives a reload.
 *
 * Each is matched in full (the 401 form by its fixed prefix, on one line),
 * never as a substring, so assistant prose that merely mentions logging in
 * cannot activate sign-in recovery. Shared by the renderer's sign-in card and
 * the backend, which holds the refused prompt to send again.
 *
 * Only refusals a new sign-in repairs are listed. An invalid API key, a
 * gateway refusal or a transient network failure is not one of them.
 * Strings taken from Claude Code 2.1.319; recheck them on a Claude bump.
 */
const SEP = String.raw`\s*[·•\-–—]\s*`;
const CODE = (command: string) => String.raw`\x60?${command}\x60?`;

const LOGIN_REFUSAL_NOTICES: readonly RegExp[] = [
  new RegExp(
    String.raw`^(?:not logged in|login expired|login reached its time limit|oauth token revoked)${SEP}please run /login\.?$`,
    "i",
  ),
  new RegExp(
    String.raw`^(?:authentication required|failed to authenticate: this login reached its time limit)${SEP}sign in again to continue\.?$`,
    "i",
  ),
  new RegExp(
    String.raw`^failed to authenticate: this login reached its time limit and cannot be renewed\. run ${CODE("claude auth login")} to sign in again, or use ${CODE("claude setup-token")} and set ${CODE("claude_code_oauth_token")} for unattended jobs\.?$`,
    "i",
  ),
  /^failed to authenticate: oauth session expired and could not be refreshed\.?$/i,
  /^failed to authenticate: oauth token revoked\. please log in again or contact your administrator\.?$/i,
  /^failed to authenticate\. api error: 401\b[^\n]{0,400}$/i,
];

/** Whether `text` is, in full, Claude's reply to a turn its login cannot run. */
export function isClaudeLoginRefusalText(text: string): boolean {
  const trimmed = text.trim();
  return LOGIN_REFUSAL_NOTICES.some((notice) => notice.test(trimmed));
}
