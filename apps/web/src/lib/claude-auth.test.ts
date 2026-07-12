import { describe, expect, test } from "bun:test";
import {
  CLAUDE_AUTH_LOGIN_COMMAND,
  isClaudeAuthenticationError,
} from "./claude-auth";

describe("claude-auth", () => {
  test("exports the expected login command", () => {
    expect(CLAUDE_AUTH_LOGIN_COMMAND).toBe("claude auth login");
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
});
