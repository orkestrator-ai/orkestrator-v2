import { describe, expect, test } from "bun:test";
import { NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX } from "@orkestrator/protocol/native-terminal-rows";
import { withGoalTurnsAsPrompts } from "@/lib/chat/goal-messages";
import { isClaudeAuthenticationFailureMessage } from "@/lib/claude-auth";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { readTranscriptTail } from "./transcript-tail";

function row(id: string, role: NativeMessage["role"], extra: Partial<NativeMessage> = {}) {
  return { id, role, content: id, parts: [], ...extra } as NativeMessage;
}

const authFailure = row(`${NATIVE_TERMINAL_ERROR_MESSAGE_ID_PREFIX}1`, "system", {
  content: "Failed to authenticate. API Error: 401",
});

/** The controller's per-render expressions before they were memoised. */
function previousTail(messages: NativeMessage[], turnRows: NativeMessage[]) {
  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const lastUserIndex = turnRows.findLastIndex((message) => message.role === "user");
  return {
    latestAssistantMessage,
    latestAssistantIndex: latestAssistantMessage
      ? messages.lastIndexOf(latestAssistantMessage)
      : -1,
    lastUserTurnIndex: lastUserIndex,
    authFailureSinceLastUserTurn: messages
      .slice(lastUserIndex + 1)
      .some((message) => isClaudeAuthenticationFailureMessage(message)),
  };
}

const goalTurn = row("goal", "assistant", {
  goalTurn: { kind: "continuation" },
} as unknown as Partial<NativeMessage>);

const cases: Array<[string, NativeMessage[]]> = [
  ["empty", []],
  ["assistant only", [row("a1", "assistant")]],
  ["user only", [row("u1", "user")]],
  ["ordinary exchange", [row("u1", "user"), row("a1", "assistant"), row("s1", "system")]],
  ["prompt after the reply", [row("u1", "user"), row("a1", "assistant"), row("u2", "user")]],
  ["auth failure after the prompt", [row("u1", "user"), row("a1", "assistant"), authFailure]],
  ["auth failure before the prompt", [authFailure, row("u1", "user"), row("a1", "assistant")]],
  ["goal turn counts as a prompt", [row("u1", "user"), row("a1", "assistant"), goalTurn]],
  ["goal turn then a reply", [goalTurn, row("a2", "assistant"), authFailure]],
];

describe("readTranscriptTail", () => {
  test.each(cases)("matches the previous per-render reads: %s", (_name, messages) => {
    const turnRows = withGoalTurnsAsPrompts(messages);
    expect(readTranscriptTail(messages, turnRows)).toEqual(previousTail(messages, turnRows));
  });

  test("returns the row object itself, not a copy", () => {
    const reply = row("a1", "assistant");
    const messages = [row("u1", "user"), reply];
    expect(readTranscriptTail(messages, messages).latestAssistantMessage).toBe(reply);
  });
});
