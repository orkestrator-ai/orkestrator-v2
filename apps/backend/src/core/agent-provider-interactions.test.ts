import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_LIMITS,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  type AgentInteractionRequest,
} from "@orkestrator/protocol/agent-interactions";
import {
  ProviderUnavailableError,
  type ProviderSessionRegistration,
} from "./native-agent-provider.js";
import {
  codexConnection,
  httpProvider,
  answerResolution,
  openCodeFake,
  openCodeActivityProvider,
} from "./agent-provider-test-support.js";

/** What a Claude bridge serves for a snapshot family a test leaves empty. */
function emptyClaudeFamily(url: string) {
  return url.endsWith("/interactions") ? { interactions: [] } : { approvals: [] };
}

describe("provider-neutral interaction adapters", () => {
  test("lets the first real registration replace an implicit placeholder", async () => {
    const expiresAt = Date.now() + 60_000;
    const { provider } = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: [
                {
                  id: "question-1",
                  expiresAt,
                  questions: [{ question: "Choose", options: [] }],
                },
              ],
            }
          : emptyClaudeFamily(url),
      ),
    );

    // Reading a snapshot for an unknown session registers it implicitly with
    // DEFAULT_SESSION_REGISTRATION. That placeholder is not a decision, so it
    // must not out-rank the authoritative registration that follows — first
    // -write-wins protects a real policy from being flipped, not a default from
    // being filled in. Locking here would silently leave an unattended build
    // session on the interactive policy, where it stops auto-resolving.
    const implicit = await provider.interactions!.listPendingInteractions("session-1");
    expect(implicit.requests[0]!.origin).toBe("interactive-native");

    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    const afterRegistration = await provider.interactions!.listPendingInteractions("session-1");
    expect(afterRegistration.requests[0]!.origin).toBe("build-pipeline");
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registration(sessionId: string): ProviderSessionRegistration;
        };
      };
    };
    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toEqual({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    // A second registration still cannot flip the live session back.
    provider.registerSession?.("session-1", {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
    });
    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toMatchObject({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
    });
  });

  test("fills in registration metadata a first caller did not know", async () => {
    const { provider } = httpProvider(() =>
      Response.json({
        questions: [],
        approvals: [],
      }),
    );
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registration(sessionId: string): ProviderSessionRegistration;
        };
      };
    };

    // The activity sweep registers without a phase; the interaction reconciler
    // registers with one. Whichever lands first must not cost the other its
    // fields, so long as origin and policy agree.
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-1",
    });
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toEqual({
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-1",
      phase: "build",
      provider: "claude",
      fence: "pipeline:build:1",
    });

    // A recorded fence is never replaced: it identifies the generation that
    // owns any request already in flight.
    provider.registerSession?.("session-1", {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      workflowId: "workflow-2",
      fence: "pipeline:build:2",
    });
    expect(internal.interactionAdapter.interactionTracker.registration("session-1")).toMatchObject({
      workflowId: "workflow-1",
      fence: "pipeline:build:1",
    });
  });

  test("all adapters fail closed on malformed or oversized authoritative snapshots", async () => {
    const oversized = "x".repeat(300_000);
    const claude = httpProvider(() => new Response(oversized));
    await expect(
      claude.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const codex = httpProvider(
      (url) =>
        url.endsWith("/approvals")
          ? Response.json({ approvals: [{ approvalId: "bad", kind: "future" }] })
          : Response.json({ interactions: [] }),
      codexConnection,
    );
    await expect(
      codex.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const fake = openCodeFake();
    fake.setPending([], [{ id: "bad", sessionID: "session-1", questions: [] }]);
    const opencode = openCodeActivityProvider(fake);
    await expect(
      opencode.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await opencode.dispose?.();

    const malformedClaudeQuestion = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: [
                {
                  id: "bad-question",
                  questions: [{ question: "Choose", options: [{}] }],
                },
              ],
            }
          : emptyClaudeFamily(url),
      ),
    );
    await expect(
      malformedClaudeQuestion.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const now = Date.now();
    const malformedCodexQuestion = httpProvider(
      (url) =>
        Response.json(
          url.endsWith("/approvals")
            ? { approvals: [] }
            : {
                interactions: [
                  {
                    interactionId: "bad-question",
                    kind: "question",
                    requestedAt: now,
                    expiresAt: now + 60_000,
                    questions: [{ id: "q1", options: [] }],
                  },
                ],
              },
        ),
      codexConnection,
    );
    await expect(
      malformedCodexQuestion.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const malformedOpenCodeQuestion = openCodeFake();
    malformedOpenCodeQuestion.setPending(
      [],
      [
        {
          id: "bad-option",
          sessionID: "session-1",
          questions: [{ question: "Choose", options: [{}] }],
        },
      ],
    );
    const malformedOpenCodeProvider = openCodeActivityProvider(malformedOpenCodeQuestion);
    await expect(
      malformedOpenCodeProvider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    await malformedOpenCodeProvider.dispose?.();

    for (const body of ["{", null] as const) {
      const malformed = httpProvider(() => new Response(body, { status: 200 }));
      await expect(
        malformed.provider.interactions!.listPendingInteractions("session-1"),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test("HTTP adapters bound the combined snapshot and scope opaque IDs to a session", async () => {
    const combinedOversized = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? { questions: [], padding: "x".repeat(140_000) }
          : { approvals: [], padding: "x".repeat(140_000) },
      ),
    );
    await expect(
      combinedOversized.provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const expiresAt = Date.now() + 60_000;
    const responses: string[] = [];
    const scoped = httpProvider((url) => {
      const sessionId = url.includes("session-a") ? "session-a" : "session-b";
      if (url.endsWith("/questions")) {
        return Response.json({
          questions: [
            {
              id: "same-provider-id",
              expiresAt,
              questions: [{ question: sessionId, options: [] }],
            },
          ],
        });
      }
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      responses.push(url);
      return Response.json({ status: "answered" });
    });
    const requestA = (await scoped.provider.interactions!.listPendingInteractions("session-a"))
      .requests[0]!;
    const requestB = (await scoped.provider.interactions!.listPendingInteractions("session-b"))
      .requests[0]!;
    expect(requestA.id).not.toBe(requestB.id);
    await expect(
      scoped.provider.interactions!.resolveInteraction(
        "session-a",
        requestB.id,
        answerResolution(requestB),
      ),
    ).resolves.toMatchObject({ result: "rejected" });
    expect(responses).toEqual([]);
  });

  test("HTTP interaction snapshots keep stable revisions and advance on every authoritative reset", async () => {
    const expiresAt = Date.now() + 60_000;
    let questions: Array<Record<string, unknown>> = [];
    const { provider } = httpProvider((url) =>
      Response.json(url.endsWith("/questions") ? { questions } : emptyClaudeFamily(url)),
    );
    const empty = await provider.interactions!.listPendingInteractions("session-1");
    const sameEmpty = await provider.interactions!.listPendingInteractions("session-1");
    expect(sameEmpty.revision).toBe(empty.revision);

    questions = [
      {
        id: "question-1",
        expiresAt,
        questions: [{ question: "Choose", options: [] }],
      },
    ];
    const pending = await provider.interactions!.listPendingInteractions("session-1");
    const samePending = await provider.interactions!.listPendingInteractions("session-1");
    expect(pending.revision).toBe(empty.revision + 1);
    expect(samePending.revision).toBe(pending.revision);
    expect(samePending.requests[0]!.revision).toBe(pending.revision);

    questions = [];
    const reset = await provider.interactions!.listPendingInteractions("session-1");
    expect(reset.revision).toBe(pending.revision + 1);
    expect(reset.requests).toEqual([]);
  });

  test("bounds tracker sessions, interaction identities, and pending snapshots", async () => {
    const expiresAt = Date.now() + 60_000;
    const { provider } = httpProvider(() =>
      Response.json({ questions: [], approvals: [], interactions: [] }),
    );
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registrations: Map<string, ProviderSessionRegistration>;
          firstSeenAt: Map<string, number>;
          interactionSessions: Map<string, string>;
          registration(sessionId: string): ProviderSessionRegistration;
          firstSeen(interactionId: string, fallback?: number): number;
          sessionFor(interactionId: string): string | undefined;
          snapshot(sessionId: string, requests: AgentInteractionRequest[]): unknown;
        };
        providerInteractionIds: Map<string, unknown>;
        mapClaudeQuestion(sessionId: string, raw: unknown): AgentInteractionRequest;
      };
    };
    const adapter = internal.interactionAdapter;
    for (let index = 0; index < 1_025; index += 1) {
      provider.registerSession?.(`session-${index}`, {
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: `phase-${index}`,
      });
    }
    expect(adapter.interactionTracker.registrations.size).toBe(1_024);
    expect(adapter.interactionTracker.registration("session-0").origin).toBe("interactive-native");
    expect(adapter.interactionTracker.registration("session-1024").phase).toBe("phase-1024");

    let oldestInteractionId = "";
    let newestInteractionId = "";
    let newestSessionId = "";
    for (let offset = 0; offset < 4_097; offset += 64) {
      const trackerSessionId = `tracker-session-${Math.floor(offset / 64)}`;
      const batch = Array.from({ length: Math.min(64, 4_097 - offset) }, (_, batchIndex) => {
        const index = offset + batchIndex;
        const mapped = adapter.mapClaudeQuestion(trackerSessionId, {
          id: `question-${index}`,
          expiresAt,
          questions: [{ question: `Question ${index}`, options: [] }],
        });
        adapter.interactionTracker.firstSeen(mapped.id, index);
        oldestInteractionId ||= mapped.id;
        newestInteractionId = mapped.id;
        newestSessionId = trackerSessionId;
        return mapped;
      });
      adapter.interactionTracker.snapshot(trackerSessionId, batch);
    }
    expect(adapter.providerInteractionIds.size).toBe(4_096);
    expect(adapter.interactionTracker.firstSeenAt.size).toBe(4_096);
    expect(adapter.interactionTracker.interactionSessions.size).toBe(4_096);
    expect(adapter.providerInteractionIds.has(oldestInteractionId)).toBe(false);
    expect(adapter.interactionTracker.firstSeenAt.has(oldestInteractionId)).toBe(false);
    expect(adapter.interactionTracker.sessionFor(oldestInteractionId)).toBeUndefined();
    expect(adapter.providerInteractionIds.has(newestInteractionId)).toBe(true);
    expect(adapter.interactionTracker.firstSeenAt.has(newestInteractionId)).toBe(true);
    expect(adapter.interactionTracker.sessionFor(newestInteractionId)).toBe(newestSessionId);

    const tooMany = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: Array.from({ length: 65 }, (_, index) => ({
                id: `question-${index}`,
                expiresAt,
                questions: [{ question: `Question ${index}`, options: [] }],
              })),
            }
          : emptyClaudeFamily(url),
      ),
    );
    await expect(
      tooMany.provider.interactions!.listPendingInteractions("session-1"),
    ).resolves.toMatchObject({ requests: expect.any(Array) });
  });

  test("accepts a new policy only after a tracked session is evicted", async () => {
    const { provider } = httpProvider(() =>
      Response.json({ questions: [], approvals: [], interactions: [] }),
    );
    const internal = provider as unknown as {
      interactionAdapter: {
        interactionTracker: {
          registrations: Map<string, ProviderSessionRegistration>;
          registration(sessionId: string): ProviderSessionRegistration;
        };
      };
    };
    const tracker = internal.interactionAdapter.interactionTracker;
    const unattended: ProviderSessionRegistration = {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "workflow-1",
      provider: "claude",
      fence: "pipeline:build:1",
    };
    provider.registerSession?.("session-0", unattended);
    // The whole registration round-trips, not just origin/policy: unattended
    // adoption is decided from the workflow ownership fence.
    expect(tracker.registration("session-0")).toEqual(unattended);

    // One insert past MAX_TRACKED_INTERACTION_SESSIONS drops the oldest entry,
    // which is the session registered first.
    for (let index = 1; index <= 1_024; index += 1) {
      provider.registerSession?.(`filler-${index}`, {
        origin: "looped-review",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      });
    }
    expect(tracker.registrations.size).toBe(1_024);
    expect(tracker.registrations.has("session-0")).toBe(false);

    // First-write-wins protects a *live* entry. Once evicted there is no policy
    // left to preserve, so the next registration is accepted outright.
    const interactive: ProviderSessionRegistration = {
      origin: "interactive-native",
      interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
      phase: "chat",
      workflowId: "workflow-2",
      provider: "claude",
      fence: 2,
    };
    provider.registerSession?.("session-0", interactive);
    expect(tracker.registration("session-0")).toEqual(interactive);
  });

  test("rejects oversized HTTP identities before retaining tracker state", async () => {
    const oversizedId = "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1);
    const { provider } = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions")
          ? {
              questions: [
                {
                  id: oversizedId,
                  questions: [{ question: "Choose", options: [] }],
                },
              ],
            }
          : emptyClaudeFamily(url),
      ),
    );
    const internal = provider as unknown as {
      interactionAdapter: {
        providerInteractionIds: Map<string, unknown>;
        interactionTracker: {
          fingerprints: Map<string, string>;
          revisions: Map<string, number>;
          interactionSessions: Map<string, string>;
        };
      };
    };
    const adapter = internal.interactionAdapter;

    await expect(
      provider.interactions!.listPendingInteractions("session-1"),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(adapter.providerInteractionIds.size).toBe(0);
    expect(adapter.interactionTracker.fingerprints.size).toBe(0);
    expect(adapter.interactionTracker.revisions.size).toBe(0);
    expect(adapter.interactionTracker.interactionSessions.size).toBe(0);
  });

  test.each([
    [404, "stale"],
    [409, "stale"],
    [503, "provider-unavailable"],
    [400, "rejected"],
    [204, "provider-unavailable"],
  ] as const)(
    "classifies an HTTP %s interaction response as %s",
    async (responseStatus, expected) => {
      const expiresAt = Date.now() + 60_000;
      const questions = [
        {
          id: "question-1",
          expiresAt,
          questions: [{ question: "Choose", options: [] }],
        },
      ];
      let writes = 0;
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/questions")) return Response.json({ questions });
        if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
        if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
        writes += 1;
        return new Response(null, { status: responseStatus });
      });
      const request = (await provider.interactions!.listPendingInteractions("session-1"))
        .requests[0]!;
      await expect(
        provider.interactions!.resolveInteraction(
          "session-1",
          request.id,
          answerResolution(request),
        ),
      ).resolves.toMatchObject({ result: expected });
      expect(writes).toBe(1);
    },
  );

  test("reconciles ambiguous HTTP interaction writes and rejects expired resolutions", async () => {
    const createdAt = Date.now() - 120_000;
    let questions: Array<Record<string, unknown>> = [
      {
        id: "question-1",
        expiresAt: Date.now() + 60_000,
        questions: [{ question: "Choose", options: [] }],
      },
    ];
    let writes = 0;
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/questions")) return Response.json({ questions });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      if (url.endsWith("/plan-approvals")) return Response.json({ approvals: [] });
      writes += 1;
      questions = [];
      throw new TypeError("connection reset");
    });
    const request = (await provider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    await expect(
      provider.interactions!.resolveInteraction("session-1", request.id, answerResolution(request)),
    ).resolves.toMatchObject({ result: "applied" });
    expect(writes).toBe(1);

    const expiredQuestions = [
      {
        id: "expired",
        expiresAt: createdAt + 1,
        questions: [{ question: "Too late", options: [] }],
      },
    ];
    const expiredProvider = httpProvider((url) =>
      Response.json(
        url.endsWith("/questions") ? { questions: expiredQuestions } : emptyClaudeFamily(url),
      ),
    ).provider;
    const expired = (await expiredProvider.interactions!.listPendingInteractions("session-1"))
      .requests[0]!;
    await expect(
      expiredProvider.interactions!.resolveInteraction(
        "session-1",
        expired.id,
        answerResolution(expired),
      ),
    ).resolves.toMatchObject({ result: "stale" });
  });

  test("fails closed when HTTP interaction write reconciliation cannot prove application", async () => {
    const expiresAt = Date.now() + 60_000;
    const question = {
      id: "question-1",
      expiresAt,
      questions: [{ question: "Choose", options: [] }],
    };
    for (const successfulWrite of [false, true]) {
      let wrote = false;
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/questions")) {
          if (wrote) throw new Error("reconciliation unavailable");
          return Response.json({ questions: [question] });
        }
        if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
        if (url.endsWith("/plan-approvals")) {
          if (wrote) throw new Error("reconciliation unavailable");
          return Response.json({ approvals: [] });
        }
        wrote = true;
        if (!successfulWrite) throw new TypeError("connection reset");
        return Response.json({ status: "answered" });
      });
      const request = (await provider.interactions!.listPendingInteractions("session-1"))
        .requests[0]!;
      await expect(
        provider.interactions!.resolveInteraction(
          "session-1",
          request.id,
          answerResolution(request),
        ),
      ).resolves.toMatchObject({ result: "provider-unavailable" });
    }
  });
});
