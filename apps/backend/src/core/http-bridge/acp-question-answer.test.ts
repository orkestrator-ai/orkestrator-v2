import { describe, expect, test } from "bun:test";
import type {
  AgentInteractionRequest,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { acpQuestionAnswerRequest } from "./acp-question-answer.js";

const request = {
  presentation: {
    questions: [
      {
        id: "answer",
        options: [
          { id: "o0", providerValue: "opt-pg" },
          { id: "o1", providerValue: "opt-sqlite" },
        ],
      },
    ],
  },
} as unknown as AgentInteractionRequest;

describe("acpQuestionAnswerRequest", () => {
  test("sends the chosen option's provider value", () => {
    const answered = acpQuestionAnswerRequest("/session/s 1", "interaction_db", request, {
      action: "answer",
      answer: { answers: [{ questionId: "answer", optionIds: ["o1"] }] },
    } as unknown as AgentInteractionResolution);
    expect(answered).toEqual({
      path: "/session/s 1/interactions/interaction_db",
      method: "POST",
      body: JSON.stringify({ action: "accept", answers: { answer: ["opt-sqlite"] } }),
    });
  });

  test("a cancel sends no answers", () => {
    const cancelled = acpQuestionAnswerRequest("/session/s", "q/1", request, {
      action: "cancel",
    } as unknown as AgentInteractionResolution);
    expect(cancelled.path).toBe("/session/s/interactions/q%2F1");
    expect(JSON.parse(cancelled.body)).toEqual({ action: "cancel" });
  });
});
