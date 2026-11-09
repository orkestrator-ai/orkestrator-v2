import { expect, test } from "bun:test";
import { coordinatorActionMark, COORDINATOR_ACTION_GUIDANCE } from "./coordinator-actions";
test("marks have a bounded, JSON replayable contract", () => {
  const mark = coordinatorActionMark("topic", "  Improve\nsearch  ");
  expect(JSON.parse(JSON.stringify(mark))).toEqual({
    version: 1,
    kind: "topic",
    title: "Improve search",
  });
  expect(() => coordinatorActionMark("question", "")).toThrow();
  expect(() => coordinatorActionMark("topic", "x".repeat(121))).toThrow();
});
test("guidance calls out both tools and avoids follow-up topic spam", () => {
  expect(COORDINATOR_ACTION_GUIDANCE).toContain("mark_topic");
  expect(COORDINATOR_ACTION_GUIDANCE).toContain("mark_question");
  expect(COORDINATOR_ACTION_GUIDANCE).toContain("once per new user subject");
});
