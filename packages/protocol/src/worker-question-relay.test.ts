import { describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "./agent-interactions.js";
import {
  parseWorkerQuestionAnswers,
  parseWorkerQuestionRelay,
  workerQuestionAnswerProblem,
  workerQuestionRefusal,
  workerQuestionViews,
} from "./worker-question-relay.js";

function request(overrides: Partial<AgentInteractionRequest> = {}): AgentInteractionRequest {
  return {
    version: 1,
    id: "q-1",
    provider: "claude",
    kind: "question",
    origin: "interactive-native",
    sessionId: "session-1",
    state: "pending",
    revision: 3,
    createdAt: 1,
    updatedAt: 1,
    presentation: {
      title: "Which database?",
      questions: [
        {
          id: "db",
          prompt: "Which database should the service use?",
          required: true,
          multiple: false,
          secret: false,
          allowFreeText: true,
          options: [
            { id: "pg", label: "Postgres", providerValue: "postgres", description: "Default" },
            { id: "sqlite", label: "SQLite", providerValue: "sqlite" },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("worker question relay", () => {
  test("only plain questions are relayed; approvals, forms and secrets are refused", () => {
    expect(workerQuestionRefusal(request())).toBeNull();
    for (const kind of ["command-approval", "file-approval", "permission", "plan-approval"]) {
      expect(
        workerQuestionRefusal(request({ kind: kind as AgentInteractionRequest["kind"] })),
      ).toContain("Only the user approves or denies it");
    }
    expect(workerQuestionRefusal(request({ kind: "mcp-form" }))).toContain("questions only");
    const secret = request();
    secret.presentation.questions[0]!.secret = true;
    expect(workerQuestionRefusal(secret)).toContain("secret");
  });

  test("the view drops provider values and keeps what the user reads", () => {
    const [view] = workerQuestionViews(request());
    expect(view).toEqual({
      id: "db",
      prompt: "Which database should the service use?",
      required: true,
      multiple: false,
      allowFreeText: true,
      options: [
        { id: "pg", label: "Postgres", description: "Default" },
        { id: "sqlite", label: "SQLite" },
      ],
    });
    expect(JSON.stringify(view)).not.toContain("providerValue");
  });

  test("answers are shape-checked, then checked against the question", () => {
    expect(() => parseWorkerQuestionAnswers([])).toThrow();
    expect(() => parseWorkerQuestionAnswers([{ questionId: "db", extra: 1 }])).toThrow("Unknown");
    expect(() =>
      parseWorkerQuestionAnswers([{ questionId: "db", freeText: "x".repeat(16_385) }]),
    ).toThrow();
    const views = workerQuestionViews(request());
    const check = (answers: unknown) =>
      workerQuestionAnswerProblem(views, parseWorkerQuestionAnswers(answers));
    expect(check([{ questionId: "db", optionIds: ["pg"] }])).toBeNull();
    expect(check([{ questionId: "db", freeText: "MySQL" }])).toBeNull();
    expect(check([{ questionId: "db", optionIds: ["pg", "sqlite"] }])).toContain("one option");
    expect(check([{ questionId: "db", optionIds: ["mongo"] }])).toContain("no option");
    expect(check([{ questionId: "db", freeText: "  " }])).toContain("needs an answer");
    expect(check([{ questionId: "other", optionIds: ["pg"] }])).toContain("no question");
  });

  test("a stored relay round-trips and a malformed one is dropped", () => {
    const relay = {
      tabId: "agent-1",
      tabName: "Claude 1",
      interactionId: "q-1",
      revision: 3,
      title: "Which database?",
      questions: workerQuestionViews(request()),
      proposed: [{ questionId: "db", optionIds: ["pg"] }],
    };
    expect(parseWorkerQuestionRelay(relay)).toEqual(relay);
    expect(parseWorkerQuestionRelay({ ...relay, revision: -1 })).toBeNull();
    expect(
      parseWorkerQuestionRelay({ ...relay, proposed: [{ questionId: "db", optionIds: ["x"] }] }),
    ).toBeNull();
    expect(parseWorkerQuestionRelay({ ...relay, questions: [] })).toBeNull();
  });
});
