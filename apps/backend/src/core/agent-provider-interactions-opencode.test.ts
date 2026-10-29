import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { ProviderUnavailableError } from "./native-agent-provider.js";
import {
  waitUntil,
  deferred,
  declineResolution,
  answerResolution,
  openCodeFake,
  openCodeActivityProvider,
} from "./agent-provider-test-support.js";

describe("OpenCode interaction adapter", () => {
  test("OpenCode lists input and authorization without auto-answering and preserves values", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        {
          id: "permission-1",
          sessionID: "owned-session",
          permission: "edit",
          patterns: [],
          metadata: {},
          always: [],
        },
      ],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [
            {
              question: "Choose",
              header: "Choice",
              options: [{ label: "comma,value", description: "kept intact" }],
              multiple: false,
              custom: true,
            },
          ],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    provider.registerSession?.("owned-session", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "review",
    });
    const snapshot = await provider.interactions!.listPendingInteractions("owned-session");
    expect(snapshot.requests.map((request) => request.kind)).toEqual(["question", "permission"]);
    expect(fake.permissionReplies).toEqual([]);
    expect(fake.questionRejections).toEqual([]);

    const question = snapshot.requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction(
        "owned-session",
        question.id,
        answerResolution(question),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(fake.questionReplies[0]).toMatchObject({
      requestID: "question-1",
      answers: [["comma,value"]],
    });
    const permission = (await provider.interactions!.listPendingInteractions("owned-session"))
      .requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction(
        "owned-session",
        permission.id,
        declineResolution(permission),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(fake.permissionReplies[0]).toMatchObject({
      requestID: "permission-1",
      reply: "reject",
    });
    await provider.dispose?.();
  });

  test("OpenCode preserves multi-select and free text, presents permission scope, and resolves once", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        {
          id: "permission-1",
          sessionID: "owned-session",
          permission: "edit",
          patterns: ["src/**", "package.json"],
          metadata: {},
          always: ["src/**"],
        },
      ],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [
            {
              question: "Choose targets",
              header: "Targets",
              options: [{ label: "one" }, { label: "two" }],
              multiple: true,
              custom: true,
            },
          ],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const first = await provider.interactions!.listPendingInteractions("owned-session");
      const question = first.requests.find(({ kind }) => kind === "question")!;
      const q = question.presentation.questions[0]!;
      const answer: AgentInteractionResolution = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: question.id,
        sessionId: question.sessionId,
        action: "answer",
        resolvedAt: Math.max(Date.now(), question.createdAt),
        answer: {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: question.id,
          sessionId: question.sessionId,
          answers: [
            {
              questionId: q.id,
              optionIds: q.options.map(({ id }) => id),
              freeText: "custom, value",
            },
          ],
        },
      };
      await expect(
        provider.interactions!.resolveInteraction("owned-session", question.id, answer),
      ).resolves.toMatchObject({ result: "applied" });
      await expect(
        provider.interactions!.resolveInteraction("owned-session", question.id, answer),
      ).resolves.toMatchObject({ result: "stale" });
      expect(fake.questionReplies).toHaveLength(1);
      expect(fake.questionReplies[0]).toMatchObject({
        requestID: "question-1",
        answers: [["one", "two", "custom, value"]],
      });

      const permission = (await provider.interactions!.listPendingInteractions("owned-session"))
        .requests[0]!;
      expect(permission.presentation.body).toContain("Permission: edit");
      expect(permission.presentation.body).toContain("Resource: src/**");
      expect(permission.presentation.body).toContain("Resource: package.json");
      expect(permission.presentation.approveForSessionLabel).toBe("Always allow");
      await expect(
        provider.interactions!.resolveInteraction("owned-session", permission.id, {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: permission.id,
          sessionId: permission.sessionId,
          action: "approve-for-session",
          resolvedAt: Math.max(Date.now(), permission.createdAt),
        }),
      ).resolves.toMatchObject({ result: "applied" });
      expect(fake.permissionReplies[0]).toMatchObject({
        requestID: "permission-1",
        reply: "always",
      });
    } finally {
      await provider.dispose?.();
    }
  });

  test("OpenCode serializes concurrent resolution of the same interaction", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [{ question: "Choose", options: [] }],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    const gate = deferred();
    fake.setQuestionReplyGate(gate.promise);
    try {
      const request = (await provider.interactions!.listPendingInteractions("owned-session"))
        .requests[0]!;
      const first = provider.interactions!.resolveInteraction(
        "owned-session",
        request.id,
        answerResolution(request),
      );
      await waitUntil(() => fake.questionReplies.length === 1);
      await expect(
        provider.interactions!.resolveInteraction(
          "owned-session",
          request.id,
          answerResolution(request),
        ),
      ).resolves.toMatchObject({ result: "already-resolved" });
      gate.resolve();
      await expect(first).resolves.toMatchObject({ result: "applied" });
      expect(fake.questionReplies).toHaveLength(1);
    } finally {
      gate.resolve();
      await provider.dispose?.();
    }
  });

  test("OpenCode reconciles ambiguous interaction writes without guessing", async () => {
    for (const [applied, expected] of [
      [true, "applied"],
      [false, "provider-unavailable"],
    ] as const) {
      const fake = openCodeFake();
      fake.setPending(
        [],
        [
          {
            id: "question-1",
            sessionID: "owned-session",
            questions: [{ question: "Choose", options: [] }],
          },
        ],
      );
      const provider = openCodeActivityProvider(fake);
      try {
        const request = (await provider.interactions!.listPendingInteractions("owned-session"))
          .requests[0]!;
        fake.setQuestionReplyFailure(new TypeError("connection reset"), applied);
        await expect(
          provider.interactions!.resolveInteraction(
            "owned-session",
            request.id,
            answerResolution(request),
          ),
        ).resolves.toMatchObject({ result: expected });
        expect(fake.questionReplies).toHaveLength(1);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("OpenCode rejects unscoped positive permissions and maps question cancel to reject", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        {
          id: "permission-1",
          sessionID: "owned-session",
          permission: "edit",
          patterns: [],
          metadata: {},
          always: [],
        },
      ],
      [
        {
          id: "question-1",
          sessionID: "owned-session",
          questions: [{ question: "Continue?", options: [], custom: true }],
        },
      ],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const snapshot = await provider.interactions!.listPendingInteractions("owned-session");
      const permission = snapshot.requests.find(({ kind }) => kind === "permission")!;
      await expect(
        provider.interactions!.resolveInteraction(
          "owned-session",
          permission.id,
          answerResolution(permission),
        ),
      ).resolves.toMatchObject({ result: "rejected" });
      expect(fake.permissionReplies).toHaveLength(0);

      const question = snapshot.requests.find(({ kind }) => kind === "question")!;
      await expect(
        provider.interactions!.resolveInteraction("owned-session", question.id, {
          ...declineResolution(question),
          action: "cancel",
        }),
      ).resolves.toMatchObject({ result: "applied" });
      expect(fake.questionRejections).toHaveLength(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("OpenCode fails closed on malformed, globally oversized, and overlong-id list payloads", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ data: {} }, { data: [] }],
      [
        {
          data: [
            {
              id: "permission-1",
              sessionID: "owned-session",
              permission: "edit",
              patterns: [123],
              metadata: {},
              always: [],
            },
          ],
        },
        { data: [] },
      ],
      [
        {
          data: [
            {
              id: "permission-1",
              sessionID: "owned-session",
              permission: "edit",
              patterns: ["x".repeat(300_000)],
              metadata: {},
              always: [],
            },
          ],
        },
        { data: [] },
      ],
      [
        { data: [] },
        {
          data: [
            {
              id: "x".repeat(513),
              sessionID: "owned-session",
              questions: [{ question: "Choose", options: [] }],
            },
          ],
        },
      ],
    ];
    for (const [permissions, questions] of cases) {
      const fake = openCodeFake();
      fake.setPendingReadResponses(permissions, questions);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(
          provider.interactions!.listPendingInteractions("owned-session"),
        ).rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("OpenCode ignores malformed foreign entries and tolerates an absent list payload", async () => {
    const fake = openCodeFake();
    fake.setPendingReadResponses(
      {
        data: [
          {
            id: "permission-foreign",
            sessionID: "x".repeat(513),
            permission: "edit",
            patterns: ["x".repeat(300_000)],
          },
        ],
      },
      { data: null },
    );
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(
        provider.interactions!.listPendingInteractions("owned-session"),
      ).resolves.toMatchObject({ requests: [] });
      fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
      await expect(provider.activity?.("owned-session")).resolves.toBe("working");
    } finally {
      await provider.dispose?.();
    }
  });
});
