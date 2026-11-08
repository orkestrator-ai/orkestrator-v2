import { describe, expect, test } from "bun:test";
import {
  CLAUDE_AUTH_LOGIN_COMMAND,
  CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND,
  isClaudeAuthenticationError,
  isClaudeAuthenticationFailureMessage,
  isClaudeLoginRefusalNotice,
} from "./claude-auth";

describe("claude-auth", () => {
  test("exports the expected login command", () => {
    expect(CLAUDE_AUTH_LOGIN_COMMAND).toBe("claude auth login");
    expect(CLAUDE_CONTAINER_AUTH_LOGIN_COMMAND).toBe("claude /login");
  });

  test("detects supported authentication error variants case-insensitively", () => {
    expect(isClaudeAuthenticationError("Failed to authenticate")).toBe(true);
    expect(isClaudeAuthenticationError("authentication_error")).toBe(true);
    expect(isClaudeAuthenticationError("Invalid Authentication Credentials")).toBe(true);
    expect(isClaudeAuthenticationError("API ERROR: 401 unauthorized")).toBe(true);
  });

  test("returns false for nullish and unrelated errors", () => {
    expect(isClaudeAuthenticationError(null)).toBe(false);
    expect(isClaudeAuthenticationError(undefined)).toBe(false);
    expect(isClaudeAuthenticationError("request timed out")).toBe(false);
  });

  test("recognises Claude's own login refusals, and only those", () => {
    const notice = (content: string) => ({ role: "assistant" as const, content });
    expect(isClaudeLoginRefusalNotice(notice("Not logged in · Please run /login"))).toBe(true);
    expect(isClaudeLoginRefusalNotice(notice("  Not logged in - Please run /login.\n"))).toBe(true);
    expect(
      isClaudeLoginRefusalNotice(notice("If you are not logged in, please run /login first.")),
    ).toBe(false);
    expect(
      isClaudeLoginRefusalNotice(notice("Not logged in · Please run /login\n\nThen retry.")),
    ).toBe(false);
    expect(
      isClaudeLoginRefusalNotice({ role: "user", content: "Not logged in · Please run /login" }),
    ).toBe(false);
    expect(isClaudeLoginRefusalNotice(null)).toBe(false);
    expect(
      isClaudeLoginRefusalNotice(
        notice(
          "Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login` to sign in again, or use `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for unattended jobs",
        ),
      ),
    ).toBe(true);
  });

  test("requires the backend's authoritative terminal-error row", () => {
    const content = "authentication_error: Invalid authentication credentials";
    expect(
      isClaudeAuthenticationFailureMessage({
        id: "native-terminal:error:auth",
        role: "system",
        content,
      }),
    ).toBe(true);
    expect(
      isClaudeAuthenticationFailureMessage({ id: "assistant-1", role: "assistant", content }),
    ).toBe(false);
    expect(
      isClaudeAuthenticationFailureMessage({ id: "error-client", role: "assistant", content }),
    ).toBe(false);
    expect(
      isClaudeAuthenticationFailureMessage({
        id: "native-terminal:stopped:auth",
        role: "system",
        content,
      }),
    ).toBe(false);
  });
});
