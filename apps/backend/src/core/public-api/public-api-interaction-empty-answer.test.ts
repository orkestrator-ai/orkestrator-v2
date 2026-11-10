import { afterEach, describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { cleanupSessionHarnesses, setup } from "./test-provider.js";

/**
 * `session.interaction.resolve` with `action: "answer"` and no answers (7202
 * task 1). The CLI sends exactly this to approve a command approval, so the
 * backend is the one place that decides whether an empty answer is valid: it
 * approves an interaction with no questions and refuses one with a required
 * question before anything reaches the provider.
 */

afterEach(cleanupSessionHarnesses);

function pending(
  sessionId: string,
  overrides: Partial<AgentInteractionRequest>,
): AgentInteractionRequest {
  return {
    version: 1,
    id: "interaction-1",
    provider: "claude",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId,
    state: "pending",
    revision: 2,
    presentation: { title: "Run touch marker", questions: [] },
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    ...overrides,
  } as AgentInteractionRequest;
}

async function started() {
  const context = await setup();
  const response = await context.harness.call<{ sessionId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt: "do the thing" },
    { requestId: "empty-answer-start" },
  );
  if (!response.ok) throw new Error(`session.start failed: ${response.error.code}`);
  return {
    ...context,
    sessionId: response.result.sessionId,
    providerSessionId: context.stub.sends[0]!.sessionId,
  };
}

describe("an answer with no answers", () => {
  test("approves a command approval, which has no questions", async () => {
    const { harness, stub, sessionId, providerSessionId } = await started();
    stub.pending.push(pending(providerSessionId, {}));
    const listed = await harness.call<{ items: Array<{ actions: string[] }> }>(
      "session.interactions",
      { sessionId },
    );
    expect(listed.ok && listed.result.items[0]?.actions).toContain("answer");

    const approved = await harness.call(
      "session.interaction.resolve",
      { sessionId, interactionId: "interaction-1", expectedRevision: 2, action: "answer" },
      { requestId: "approve-1" },
    );
    expect(approved.ok).toBe(true);
    expect(stub.resolutions).toEqual([
      expect.objectContaining({
        action: "answer",
        answer: expect.objectContaining({ answers: [] }),
      }),
    ]);
  });

  test("is refused for a required question and never reaches the provider", async () => {
    const { harness, stub, sessionId, providerSessionId } = await started();
    stub.pending.push(
      pending(providerSessionId, {
        kind: "question",
        presentation: {
          title: "Which database?",
          questions: [
            {
              id: "db",
              prompt: "Pick one",
              required: true,
              multiple: false,
              secret: false,
              allowFreeText: false,
              options: [{ id: "pg", label: "Postgres", providerValue: "pg" }],
            },
          ],
        },
      } as Partial<AgentInteractionRequest>),
    );
    const refused = await harness.call(
      "session.interaction.resolve",
      { sessionId, interactionId: "interaction-1", expectedRevision: 2, action: "answer" },
      { requestId: "empty-question" },
    );
    expect(!refused.ok && refused.error).toMatchObject({ code: "invalid-input", exitCode: 2 });
    expect(stub.resolutions).toHaveLength(0);
  });
});
