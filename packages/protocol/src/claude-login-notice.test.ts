import { describe, expect, test } from "bun:test";
import { isClaudeNotLoggedInText } from "./claude-login-notice.js";

describe("isClaudeNotLoggedInText", () => {
  test.each([
    "Not logged in · Please run /login",
    "Not logged in - please run /login.",
    "  not logged in • PLEASE RUN /login  ",
  ])("matches the notice: %s", (text) => {
    expect(isClaudeNotLoggedInText(text)).toBe(true);
  });

  test.each([
    "The tool said: Not logged in · Please run /login",
    "Not logged in",
    "You are not logged in, so please run /login.",
    "",
  ])("does not match prose: %s", (text) => {
    expect(isClaudeNotLoggedInText(text)).toBe(false);
  });
});
