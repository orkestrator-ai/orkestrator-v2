import { describe, expect, test } from "bun:test";
import type { PromptOptions, SessionState } from "../types/index.js";
import {
  TRANSCRIPT_READ_FAILED,
  installPromptTranscript,
  promptPlanModeChange,
} from "./session-manager-prompt-admission.js";

function bareSession(fields: Partial<SessionState> = {}): SessionState {
  return { id: "session-admission", messages: [], ...fields } as unknown as SessionState;
}

describe("prompt admission", () => {
  test.each([
    [undefined, "plan", true],
    [false, "plan", true],
    [true, "plan", undefined],
    [true, "bypassPermissions", false],
    [false, "bypassPermissions", undefined],
    [true, "default", undefined],
    [false, "acceptEdits", undefined],
    [true, undefined, undefined],
  ] as const)(
    "a session in plan mode %p sent %p records %p",
    (planMode, permissionMode, expected) => {
      const options: PromptOptions | undefined = permissionMode ? { permissionMode } : undefined;
      expect(promptPlanModeChange(bareSession({ planMode }), options)).toBe(expected);
    },
  );

  test("a failed transcript read installs nothing and is reported", () => {
    const session = bareSession();
    const before = session.messages;
    expect(installPromptTranscript(session, TRANSCRIPT_READ_FAILED)).toBe(true);
    expect(session.messages).toBe(before);
  });

  test("an absent transcript leaves the session as it was", () => {
    const session = bareSession();
    const before = session.messages;
    expect(installPromptTranscript(session, undefined)).toBe(false);
    expect(session.messages).toBe(before);
  });
});
