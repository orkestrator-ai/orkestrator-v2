import { describe, expect, test } from "bun:test";
import { isClaudeLoginRefusalText } from "./claude-login-notice.js";

describe("isClaudeLoginRefusalText", () => {
  test.each([
    "Not logged in · Please run /login",
    "Not logged in - please run /login.",
    "  not logged in • PLEASE RUN /login  ",
    "Login expired · Please run /login",
    "Login reached its time limit · Please run /login",
    "OAuth token revoked · Please run /login",
    "Authentication required · Sign in again to continue",
    "Failed to authenticate: this login reached its time limit · Sign in again to continue",
    "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs",
    "Failed to authenticate: OAuth session expired and could not be refreshed",
    "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.",
    "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
  ])("matches Claude's refusal: %s", (text) => {
    expect(isClaudeLoginRefusalText(text)).toBe(true);
  });

  test.each([
    "The tool said: Not logged in · Please run /login",
    "Not logged in",
    "You are not logged in, so please run /login.",
    "Login expired · Please run /login\n\nThen retry.",
    "The integration test failed to authenticate against the mock IdP, so I updated the header.",
    "Failed to authenticate. API Error: 401\n\nHere is what I changed instead.",
    "Invalid API key · Fix external API key",
    "Authentication error · This may be a temporary network issue, please try again",
    "",
  ])("does not match prose or refusals a sign-in cannot fix: %s", (text) => {
    expect(isClaudeLoginRefusalText(text)).toBe(false);
  });
});
