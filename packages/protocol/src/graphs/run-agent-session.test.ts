import { describe, expect, test } from "bun:test";
import {
  GRAPH_AGENT_QUESTION_BOUNDS,
  graphAgentAnswerProblem,
  isGraphAgentAnswerUndelivered,
  isGraphAgentQuestionOpen,
  type GraphAgentQuestion,
} from "./run-agent-session.js";
import { validateGraphRun } from "./run-guards.js";
import type { GraphActivationSession } from "./run-model.js";
import { POLICY_FIXTURE, activationFixture, graphRunFixture } from "./run-fixtures.test-support.js";

const QUESTION: GraphAgentQuestion = {
  id: "0f8fad5b-d9cb-469f-a165-70867728950e",
  text: "Should hidden columns be exported?\nThe ticket does not say.",
  choices: ["yes", "no"],
  askedAt: "2026-10-29T00:00:00.000Z",
  requestId: "request-1",
};

function runWithSession(session: Record<string, unknown>) {
  return graphRunFixture({
    activations: [
      activationFixture(
        { nodeId: "build" },
        {
          state: "running",
          policy: POLICY_FIXTURE,
          enforcement: "advisory",
          session: {
            agent: "claude",
            providerSessionId: "session-1",
            requestId: "request-1",
            dispatchState: "sent",
            resultTransport: "tool-v1",
            ...session,
          } as GraphActivationSession,
        },
      ),
    ],
  });
}

function errors(session: Record<string, unknown>): string[] {
  const result = validateGraphRun(runWithSession(session));
  return result.ok ? [] : result.errors.map((error) => `${error.path}:${error.code}`);
}

describe("agent session fields", () => {
  test("the branch runner's durable state and a question are valid session fields", () => {
    expect(
      errors({
        sessionKey: "graph:run-1:build#iter=1#attempt=1",
        turnMode: "read-only",
        startedAt: "2026-10-29T00:00:00.000Z",
        resultSubmission: "correcting",
        repairAttempts: 1,
        repairPrompt: "Your work was accepted.\nOnly the result was rejected.",
        continuationPrompt: "Orkestrator has not received your results.",
        reminderSent: true,
        restartContinuationSent: false,
        idlePolls: 2,
        usagePolls: 1,
        progressAt: "2026-10-29T00:00:01.000Z",
        progressDigest: "d".repeat(64),
        question: QUESTION,
        questionsAsked: 1,
        progress: [
          {
            id: "p1",
            port: "verdict",
            reportedAt: "2026-10-29T00:00:02.000Z",
            item: { id: "ac-1" },
          },
        ],
      }),
    ).toEqual([]);
  });

  test("unknown fields, control characters and overruns are refused", () => {
    expect(errors({ surprise: true })).toContain("activations[0].session.surprise:unknown_field");
    expect(errors({ sessionKey: "a\u0007b" })).toContain(
      "activations[0].session.sessionKey:control_character",
    );
    expect(errors({ turnMode: "sideways" })).toContain("activations[0].session.turnMode:enum");
    expect(errors({ questionsAsked: GRAPH_AGENT_QUESTION_BOUNDS.maxQuestions + 1 })).toEqual([
      "activations[0].session.questionsAsked:out_of_range",
    ]);
    expect(errors({ question: { ...QUESTION, id: "not-a-uuid" } })).toContain(
      "activations[0].session.question.id:pattern",
    );
    expect(
      errors({ question: { ...QUESTION, delivered: "tool" } }).some((error) =>
        error.endsWith("question.delivered:mismatch"),
      ),
    ).toBe(true);
    expect(
      errors({
        question: {
          ...QUESTION,
          answer: { kind: "answered", choice: "maybe", at: QUESTION.askedAt, by: "user" },
        },
      }),
    ).toContain("activations[0].session.question.answer.choice:mismatch");
  });
});

describe("answers", () => {
  test("an answer must name the open question, and be well formed", () => {
    const answer = {
      kind: "answered",
      text: "Only visible ones.",
      at: QUESTION.askedAt,
      by: "user",
    };
    expect(graphAgentAnswerProblem(QUESTION, QUESTION.id, answer)).toBeNull();
    expect(graphAgentAnswerProblem(undefined, QUESTION.id, answer)).toContain("no question");
    expect(graphAgentAnswerProblem(QUESTION, "other", answer)).toContain("another question");
    expect(
      graphAgentAnswerProblem({ ...QUESTION, answer: answer as never }, QUESTION.id, answer),
    ).toContain("already answered");
    expect(
      graphAgentAnswerProblem(QUESTION, QUESTION.id, { ...answer, text: undefined }),
    ).toContain("needs text or a choice");
    expect(
      graphAgentAnswerProblem(QUESTION, QUESTION.id, {
        kind: "declined",
        at: QUESTION.askedAt,
        by: "user",
      }),
    ).toBeNull();
    expect(
      graphAgentAnswerProblem(QUESTION, QUESTION.id, { ...answer, by: "agent" }),
    ).not.toBeNull();
  });

  test("open and undelivered questions", () => {
    expect(isGraphAgentQuestionOpen(QUESTION)).toBe(true);
    const answered = {
      ...QUESTION,
      answer: { kind: "declined" as const, at: QUESTION.askedAt, by: "user" as const },
    };
    expect(isGraphAgentQuestionOpen(answered)).toBe(false);
    expect(isGraphAgentAnswerUndelivered(answered)).toBe(true);
    expect(isGraphAgentAnswerUndelivered({ ...answered, delivered: "turn" })).toBe(false);
  });
});
