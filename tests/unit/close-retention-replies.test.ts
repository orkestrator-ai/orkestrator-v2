import { expect, test } from "bun:test";
import { hasNewCompletedReply } from "../../e2e/agent-testing/close-retention-replies";

test("recall requires a new completed assistant response after the send boundary", () => {
  const historical = { id: "assistant-first", role: "assistant", content: "OK ORK123456" };
  const previousMessageIds = new Set([historical.id]);
  const matches = (reply: string) => reply.includes("ORK123456");
  const unrelated = { id: "assistant-resumed", role: "assistant", content: "I do not remember" };
  expect(
    hasNewCompletedReply(
      { turn: { phase: "idle" }, messages: [historical, unrelated] },
      previousMessageIds,
      matches,
    ),
  ).toBe(false);
  const remembered = { ...unrelated, content: "ORK123456" };
  expect(
    hasNewCompletedReply(
      { turn: { phase: "running" }, messages: [historical, remembered] },
      previousMessageIds,
      matches,
    ),
  ).toBe(false);
  expect(
    hasNewCompletedReply(
      { turn: { phase: "idle" }, messages: [historical, { ...remembered, role: "user" }] },
      previousMessageIds,
      matches,
    ),
  ).toBe(false);
  expect(
    hasNewCompletedReply(
      { turn: { phase: "idle" }, messages: [historical, remembered] },
      previousMessageIds,
      matches,
    ),
  ).toBe(true);
});
