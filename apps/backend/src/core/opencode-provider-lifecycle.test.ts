import { describe, expect, test } from "bun:test";
import { AGENT_INTERACTION_LIMITS, INTERACTIVE_AGENT_INTERACTION_POLICY, UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import { createNativeAgentProvider, ProviderUnavailableError, type ProviderSessionRegistration } from "./native-agent-provider.js";
import { waitUntil, openCodeFake, openCodeProvider, openCodeActivityProvider } from "./agent-provider-test-support.js";

describe("OpenCode provider", () => {
  test("treats a status-map omission as idle when the session still exists", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionGetResponse("omitted-session", {
      data: { id: "omitted-session", directory: "/workspace" },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("omitted-session")).resolves.toBe("idle");
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(0);
      expect(fake.sessionGetCalls).toEqual([{
        sessionID: "omitted-session",
        directory: "/workspace",
      }]);
      expect(fake.statusOptions[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(fake.sessionGetOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await provider.dispose?.();
    }
  });

  test("batches omitted idle and genuinely deleted OpenCode sessions", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({ data: [{ id: "existing-session" }] });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activityBatch?.([
        "existing-session",
        "deleted-session",
        "existing-session",
      ])).resolves.toEqual(new Map([
        ["existing-session", "idle"],
        ["deleted-session", "missing"],
      ]));
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(0);
      expect(fake.permissionListCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("reports provider unavailability when OpenCode existence cannot be read", async () => {
    for (const failure of [
      { error: { message: "failed" } },
      new Error("connection reset"),
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: {} });
      if (failure instanceof Error) fake.setSessionListError(failure);
      else fake.setSessionListResponse(failure);
      fake.setSessionGetError(new Error("exact read failed"));
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status("omitted-session"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
        await expect(provider.activityBatch?.(["omitted-session"]))
          .resolves.toEqual(new Map([["omitted-session", "idle"]]));
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("falls back to exact reads for malformed or oversized session lists", async () => {
    for (const response of [
      { data: {} },
      { data: [{}] },
      { data: [{ id: "" }] },
      { data: [{ id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1) }] },
      {
        data: Array.from({ length: 1_026 }, (_, index) => ({
          id: `session-${index}`,
        })),
      },
      {
        data: [{
          id: "foreign-session",
          title: "x".repeat(4 * 1024 * 1024 + 1),
        }],
      },
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: {} });
      fake.setSessionListResponse(response);
      fake.setSessionGetResponse("omitted-session", {
        data: { id: "omitted-session", directory: "/workspace" },
      });
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.activityBatch?.(["omitted-session"]))
          .resolves.toEqual(new Map([["omitted-session", "idle"]]));
        expect(fake.sessionGetCalls).toEqual([{
          sessionID: "omitted-session",
          directory: "/workspace",
        }]);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("does not infer deletion from a truncated OpenCode session list", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({
      data: Array.from({ length: 1_025 }, (_, index) => ({
        id: `other-session-${index}`,
      })),
    });
    fake.setSessionGetResponse("omitted-session", {
      data: { id: "omitted-session", directory: "/workspace" },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("omitted-session"))
        .resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);
      expect(fake.sessionGetCalls[0]).toEqual({
        sessionID: "omitted-session",
        directory: "/workspace",
      });
      expect(fake.sessionGetOptions[0]?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      await provider.dispose?.();
    }
  });

  test("uses exact 404s for deletion even when the bounded list page is full", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({
      data: Array.from({ length: 1_025 }, (_, index) => ({
        id: `other-session-${index}`,
      })),
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("deleted-session"))
        .resolves.toBe("missing");
      expect(fake.sessionGetCalls).toEqual([{
        sessionID: "deleted-session",
        directory: "/workspace",
      }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("reuses positive existence snapshots within the TTL and refreshes after expiry", async () => {
    let now = 1_000;
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({
      data: [{}, { id: "idle-session" }, { id: "" }],
    });
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      openCodeExistenceCacheTtlMs: 100,
    });
    try {
      await expect(provider.activity?.("idle-session")).resolves.toBe("idle");
      await expect(provider.activity?.("idle-session")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(0);
      expect(fake.sessionListCalls[0]).toEqual({
        directory: "/workspace",
        limit: 1_025,
      });
      expect(fake.sessionListOptions[0]?.signal).toBeInstanceOf(AbortSignal);

      now += 101;
      await expect(provider.activity?.("idle-session")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(2);
    } finally {
      await provider.dispose?.();
    }
  });

  test("strong status bypasses positive activity caches and sees later deletion", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({ data: [{ id: "session-that-deletes" }] });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("session-that-deletes"))
        .resolves.toBe("idle");
      await expect(provider.status("session-that-deletes"))
        .resolves.toBe("missing");
      await expect(provider.activity?.("session-that-deletes"))
        .resolves.toBe("missing");
      expect(fake.sessionGetCallCount).toBe(2);
    } finally {
      await provider.dispose?.();
    }
  });

  test("does not cache negative existence across strong status reads", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("recreated-session")).resolves.toBe("missing");
      fake.setSessionGetResponse("recreated-session", {
        data: { id: "recreated-session", directory: "/workspace" },
      });
      await expect(provider.status("recreated-session")).resolves.toBe("idle");
      expect(fake.sessionGetCallCount).toBe(2);
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps non-404 and malformed exact existence reads unavailable", async () => {
    const oversized = {
      data: {
        id: "target",
        directory: "/workspace",
        title: "x".repeat(4 * 1024 * 1024 + 1),
      },
    };
    for (const response of [
      { error: { name: "BadRequest" }, response: { status: 400 } },
      { error: { name: "ServerError" }, response: { status: 500 } },
      { data: {} },
      { data: { id: "target" } },
      { data: { id: "target", directory: "/another-worktree" } },
      { data: { id: "different-session", directory: "/workspace" } },
      oversized,
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: {} });
      fake.setSessionGetResponse("target", response);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status("target")).rejects.toMatchObject({
          name: "ProviderUnavailableError",
          message: "OpenCode status is unavailable",
          cause: {
            name: "ProviderUnavailableError",
            message: "OpenCode session existence is unavailable for target",
          },
        });
      } finally {
        await provider.dispose?.();
      }
    }

    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionGetError(new Error("connection reset"));
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("target"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps resolved busy activity when omitted-session probes fail", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: { busy: { type: "busy" } } });
    fake.setSessionListError(new Error("list unavailable"));
    fake.setSessionGetError(new Error("get unavailable"));
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activityBatch?.(["busy", "unresolved"]))
        .resolves.toEqual(new Map([
          ["unresolved", "idle"],
          ["busy", "working"],
        ]));
      expect(fake.questionListCallCount).toBe(1);
      expect(fake.permissionListCallCount).toBe(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("falls back from a failed list to an exact successful existence read", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListError(new Error("list unavailable"));
    fake.setSessionGetResponse("target", {
      data: { id: "target", directory: "/workspace" },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("backs off failed activity existence probes without weakening strong status", async () => {
    let now = 1_000;
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListError(new Error("list unavailable"));
    fake.setSessionGetError(new Error("get unavailable"));
    const provider = openCodeActivityProvider(fake, {
      now: () => now,
      openCodeExistenceCacheTtlMs: 100,
    });
    try {
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(1);

      await expect(provider.status("target"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(fake.sessionGetCallCount).toBe(2);

      now += 101;
      await expect(provider.activity?.("target")).resolves.toBe("idle");
      expect(fake.sessionListCallCount).toBe(2);
      expect(fake.sessionGetCallCount).toBe(3);
    } finally {
      await provider.dispose?.();
    }
  });

  test("caps exact activity probes to one rotating concurrency wave", async () => {
    const sessionIds = Array.from(
      { length: 20 },
      (_, index) => `missing-${index}`,
    );
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListError(new Error("list unavailable"));
    const provider = openCodeActivityProvider(fake);
    try {
      const first = await provider.activityBatch?.(sessionIds);
      expect(fake.sessionGetCallCount).toBe(8);
      expect(first?.get("missing-0")).toBe("missing");
      expect(first?.get("missing-8")).toBe("idle");

      const second = await provider.activityBatch?.(sessionIds);
      expect(fake.sessionGetCallCount).toBe(16);
      expect(second?.get("missing-0")).toBe("idle");
      expect(second?.get("missing-8")).toBe("missing");
    } finally {
      await provider.dispose?.();
    }
  });

  test("handles more than 1024 tracked sessions in one bounded activity read", async () => {
    const sessionIds = Array.from(
      { length: 1_025 },
      (_, index) => `session-${index}`,
    );
    const fake = openCodeFake();
    fake.setStatusResponse({ data: {} });
    fake.setSessionListResponse({ data: sessionIds.map((id) => ({ id })) });
    const provider = openCodeActivityProvider(fake);
    try {
      const activity = await provider.activityBatch?.(sessionIds);
      expect(activity?.size).toBe(1_025);
      expect(activity?.get("session-0")).toBe("idle");
      expect(activity?.get("session-1024")).toBe("idle");
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.sessionGetCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("ignores malformed foreign status entries but validates requested entries", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: {
        tracked: { type: "busy" },
        foreign: { type: 3 },
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.status("tracked")).resolves.toBe("running");
      fake.setStatusResponse({ data: { tracked: { type: 3 } } });
      await expect(provider.status("tracked"))
        .rejects.toMatchObject({
          name: "ProviderUnavailableError",
          message: "OpenCode status is unavailable",
          cause: {
            message: "OpenCode status read contains a malformed entry",
          },
        });
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds OpenCode lifecycle identities and status payload count and bytes", async () => {
    const maximumId = "m".repeat(AGENT_INTERACTION_LIMITS.maxIdLength);
    const boundaryFake = openCodeFake();
    boundaryFake.setStatusResponse({
      data: { [maximumId]: { type: "busy" } },
    });
    const boundaryProvider = openCodeActivityProvider(boundaryFake);
    try {
      await expect(boundaryProvider.status(maximumId)).resolves.toBe("running");
    } finally {
      await boundaryProvider.dispose?.();
    }

    for (const sessionId of [
      "",
      "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1),
    ]) {
      const fake = openCodeFake();
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status(sessionId)).rejects.toMatchObject({
          name: "ProviderUnavailableError",
          message: "OpenCode status is unavailable",
          cause: { message: "OpenCode lifecycle read contains a malformed identity" },
        });
      } finally {
        await provider.dispose?.();
      }
    }

    for (const data of [
      Object.fromEntries(Array.from(
        { length: 4_097 },
        (_, index) => [`foreign-${index}`, { type: "idle" }],
      )),
      {
        foreign: {
          type: "idle",
          padding: "x".repeat(
            AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes + 1,
          ),
        },
      },
    ]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data });
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status("tracked")).rejects.toMatchObject({
          name: "ProviderUnavailableError",
          cause: { message: "OpenCode status read is oversized" },
        });
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("reports busy OpenCode sessions with pending input as waiting", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: { "owned-session": { type: "busy" } },
    });
    fake.setPending(
      [{ id: "permission-other", sessionID: "other-session" }],
      [{ id: "question-owned", sessionID: "owned-session" }],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("owned-session")).resolves.toBe("waiting");
      fake.setPending(
        [{ id: "permission-other", sessionID: "other-session" }],
        [],
      );
      await expect(provider.activity?.("owned-session")).resolves.toBe("working");
      fake.setPending(
        [{ id: "permission-owned", sessionID: "owned-session" }],
        [],
      );
      await expect(provider.activity?.("owned-session")).resolves.toBe("waiting");
    } finally {
      await provider.dispose?.();
    }
  });

  test("batches multiple OpenCode sessions from one global snapshot", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: {
        "busy-session": { type: "busy" },
        "retry-session": { type: "retry" },
        "idle-session": { type: "idle" },
      },
    });
    fake.setPending(
      [
        { id: "permission-owned", sessionID: "retry-session" },
        { id: "permission-other", sessionID: "other-session" },
      ],
      [{ id: "question-owned", sessionID: "busy-session" }],
    );
    const provider = openCodeActivityProvider(fake);
    try {
      const activity = await provider.activityBatch?.([
        "busy-session",
        "retry-session",
        "idle-session",
        "missing-session",
        "busy-session",
      ]);

      expect(activity).toEqual(new Map([
        ["idle-session", "idle"],
        ["missing-session", "missing"],
        ["busy-session", "waiting"],
        ["retry-session", "waiting"],
      ]));
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(1);
      expect(fake.permissionListCallCount).toBe(1);
      expect(fake.statusCalls).toEqual([{ directory: "/workspace" }]);
      expect(fake.questionListCalls).toEqual([{ directory: "/workspace" }]);
      expect(fake.permissionListCalls).toEqual([{ directory: "/workspace" }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("short-circuits OpenCode pending reads when every session is non-running", async () => {
    const fake = openCodeFake();
    fake.setStatusResponse({
      data: {
        "idle-session": { type: "idle" },
        "error-session": { type: "unexpected" },
      },
    });
    const provider = openCodeActivityProvider(fake);
    try {
      const activity = await provider.activityBatch?.([
        "idle-session",
        "error-session",
        "missing-session",
      ]);

      expect(activity).toEqual(new Map([
        ["idle-session", "idle"],
        ["error-session", "idle"],
        ["missing-session", "missing"],
      ]));
      expect(fake.statusCallCount).toBe(1);
      expect(fake.sessionListCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(0);
      expect(fake.permissionListCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("returns an empty OpenCode activity batch without upstream reads", async () => {
    const fake = openCodeFake();
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activityBatch?.([])).resolves.toEqual(new Map());
      expect(fake.statusCallCount).toBe(0);
      expect(fake.sessionListCallCount).toBe(0);
      expect(fake.questionListCallCount).toBe(0);
      expect(fake.permissionListCallCount).toBe(0);
    } finally {
      await provider.dispose?.();
    }
  });

  test("makes a successfully auto-rejected OpenCode question terminal instead of blocked", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "owned-q", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.questionRejections.length === 1);

      // The reject removed the provider request. Keeping a local `blocked`
      // marker here would park the pipeline forever on a card nobody can answer.
      await expect(provider.activityBatch?.(["owned-session"])).resolves.toEqual(
        new Map([["owned-session", "idle"]]),
      );
      await expect(provider.activity?.("owned-session")).resolves.toBe("idle");
      await expect(provider.status("owned-session")).resolves.toBe("error");
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds and disposes terminal OpenCode question latches", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    const internal = provider as unknown as {
      failedQuestionSessions: Set<string>;
      lifecycle: { ownedSessions: Set<string> };
      handleRequest(raw: unknown): Promise<void>;
    };
    for (let index = 0; index < 1_025; index += 1) {
      const sessionId = `failed-session-${index}`;
      internal.lifecycle.ownedSessions.add(sessionId);
      await internal.handleRequest({
        type: "question.rejected",
        properties: { sessionID: sessionId },
      });
    }
    expect(internal.failedQuestionSessions.size).toBe(1_024);
    expect(internal.failedQuestionSessions.has("failed-session-0")).toBe(false);
    expect(internal.failedQuestionSessions.has("failed-session-1024")).toBe(true);

    await provider.dispose?.();
    expect(internal.failedQuestionSessions.size).toBe(0);
  });

  test("records OpenCode auto-responses before applying them and isolates diagnostic failures", async () => {
    const fake = openCodeFake();
    const events: Array<{ state: string; kind: string }> = [];
    let releaseDurableDetection!: () => void;
    const durableDetection = new Promise<void>((resolve) => {
      releaseDurableDetection = resolve;
    });
    const provider = createNativeAgentProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: async (event) => {
        events.push({ state: event.state, kind: event.kind });
        if (event.kind === "permission") throw new Error("diagnostics unavailable");
        if (event.kind === "question" && event.state === "detected") {
          await durableDetection;
        }
      },
    });
    try {
      await provider.createSession("build", "Build task", {
        interaction: {
          origin: "build-pipeline",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "build",
        },
      });
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "owned-session" },
      });
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "owned-session" },
      });
      await waitUntil(() => events.some((event) =>
        event.kind === "question" && event.state === "detected"
      ));
      expect(fake.questionRejections).toEqual([]);
      await waitUntil(() => fake.permissionReplies.length === 1);
      await expect(provider.status("owned-session")).resolves.toBe("blocked");
      releaseDurableDetection();
      await waitUntil(() => fake.questionRejections.length === 1);
      expect(fake.permissionReplies).toHaveLength(1);
      expect(events).toHaveLength(4);
      for (const kind of ["permission", "question"] as const) {
        expect(events.findIndex((event) =>
          event.kind === kind && event.state === "detected"
        )).toBeLessThan(events.findIndex((event) =>
          event.kind === kind && event.state === "withdrawn"
        ));
      }
    } finally {
      await provider.dispose?.();
    }
  });

  test("reports a withdrawn OpenCode auto-response as an error provider state", async () => {
    const fake = openCodeFake();
    const events: Array<{
      kind: string;
      state: string;
      providerState?: string;
    }> = [];
    const provider = createNativeAgentProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        events.push({
          kind: event.kind,
          state: event.state,
          providerState: event.providerState,
        });
      },
    });
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.permissionReplies.length === 1);
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.questionRejections.length === 1);
      await waitUntil(() => events.length === 4);

      // `native-agent-service` projects this field straight onto the session
      // (`event.providerState ?? "running"`). A provider-owned rejection is
      // terminal, so `running` would leave the card spinning on a request the
      // provider has already refused and nobody else will answer.
      expect(events).toEqual([
        { kind: "permission", state: "detected", providerState: undefined },
        { kind: "permission", state: "withdrawn", providerState: "error" },
        { kind: "question", state: "detected", providerState: undefined },
        { kind: "question", state: "withdrawn", providerState: "error" },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("carries the full workflow registration on every OpenCode observation", async () => {
    const fake = openCodeFake();
    const registration: ProviderSessionRegistration = {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "pipeline-1",
      provider: "opencode",
      fence: "pipeline-1:build:3:abc",
    };
    const observed: ProviderSessionRegistration[] = [];
    const provider = createNativeAgentProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        observed.push(event.registration);
      },
    });
    try {
      await provider.createSession("build", "Build task", {
        interaction: registration,
      });
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "owned-session" },
      });
      await waitUntil(() => observed.length === 2);

      // The observer decides adoption from the workflow ownership fence, so the
      // fence and its owning workflow have to survive the round trip alongside
      // the origin/policy pair.
      expect(observed).toEqual([registration, registration]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("keeps the original workflow fence when an OpenCode session is registered again", async () => {
    const fake = openCodeFake();
    const original: ProviderSessionRegistration = {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "build",
      workflowId: "pipeline-1",
      provider: "opencode",
      fence: "pipeline-1:build:3:abc",
    };
    const observed: ProviderSessionRegistration[] = [];
    const provider = createNativeAgentProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        observed.push(event.registration);
      },
    });
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      provider.registerSession?.("restored-session", original);
      // A cached or restored provider re-asserts its metadata on every pass. It
      // must not move a live session onto a newer generation, and above all not
      // switch it from unattended to interactive.
      provider.registerSession?.("restored-session", {
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        phase: "chat",
        workflowId: "pipeline-2",
        provider: "opencode",
        fence: "pipeline-2:build:4:def",
      });
      fake.subscriptions[0]!.push({
        type: "permission.asked",
        properties: { id: "permission-1", sessionID: "restored-session" },
      });
      await waitUntil(() => observed.length >= 1);

      expect(observed[0]).toEqual(original);
    } finally {
      await provider.dispose?.();
    }
  });

  test("leaves an OpenCode question pending when durable detection fails", async () => {
    const fake = openCodeFake();
    const provider = createNativeAgentProvider({
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    }, {
      openCodeClient: fake.client,
      monitorRetryMs: 1,
      autoAnswerRequests: true,
      onInteractionObservation: (event) => {
        if (event.kind === "question" && event.state === "detected") {
          throw new Error("durable failure write failed");
        }
      },
    });
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({
        type: "question.asked",
        properties: { id: "question-1", sessionID: "owned-session" },
      });
      await waitUntil(() => fake.subscribeCallCount >= 2);
      expect(fake.questionRejections).toEqual([]);
      await expect(provider.status("owned-session")).resolves.toBe("blocked");
    } finally {
      await provider.dispose?.();
    }
  });

  test("rejects an OpenCode activity snapshot that omits the requested session", async () => {
    const fake = openCodeFake();
    const provider = openCodeActivityProvider(fake);
    try {
      // `activityBatch` answers for every id it is given, so a gap is a broken
      // provider rather than a missing session. Defaulting to `missing` would
      // turn that bug into a deleted session mapping.
      provider.activityBatch = async () => new Map();
      await expect(provider.activity?.("owned-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    ["question", "envelope"],
    ["permission", "envelope"],
    ["question", "throw"],
    ["permission", "throw"],
  ] as const)("wraps OpenCode %s list %s failures as unavailable", async (
    requestType,
    failureType,
  ) => {
    const fake = openCodeFake();
    fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
    if (failureType === "envelope") {
      fake.setPendingReadResponses(
        requestType === "permission" ? { error: { message: "failed" } } : null,
        requestType === "question" ? { error: { message: "failed" } } : null,
      );
    } else {
      fake.setPendingReadErrors(
        requestType === "permission" ? new Error("failed") : null,
        requestType === "question" ? new Error("failed") : null,
      );
    }
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(provider.activity?.("owned-session"))
        .rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(fake.statusCallCount).toBe(1);
      expect(fake.questionListCallCount).toBe(1);
      expect(fake.permissionListCallCount).toBe(1);
    } finally {
      await provider.dispose?.();
    }
  });

  test("bounds OpenCode activity snapshots and accepts a maximum-length identity", async () => {
    const invalidQuestionResponses: Array<Record<string, unknown>> = [
      {
        data: Array.from({ length: 4_097 }, (_, index) => ({
          id: `question-${index}`,
          sessionID: "owned-session",
        })),
      },
      {
        data: [{
          id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1),
          sessionID: "owned-session",
        }],
      },
    ];
    for (const questions of invalidQuestionResponses) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
      fake.setPendingReadResponses({ data: [] }, questions);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.activity?.("owned-session"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }

    const boundary = openCodeFake();
    boundary.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
    boundary.setPendingReadResponses({ data: [] }, {
      data: [{
        id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength),
        sessionID: "owned-session",
      }],
    });
    const boundaryProvider = openCodeActivityProvider(boundary);
    try {
      await expect(boundaryProvider.activity?.("owned-session"))
        .resolves.toBe("waiting");
    } finally {
      await boundaryProvider.dispose?.();
    }
  });

  test("constructs the OpenCode SDK client with bridge auth and directory", async () => {
    const fake = openCodeFake();
    const factoryCalls: unknown[] = [];
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "factory-token",
        directory: "/workspace/project",
      },
      {
        openCodeClientFactory: ((options: unknown) => {
          factoryCalls.push(options);
          return fake.client;
        }) as never,
        autoAnswerRequests: false,
      },
    );

    try {
      expect(factoryCalls).toEqual([{
        baseUrl: "http://opencode.test",
        directory: "/workspace/project",
        headers: {
          Authorization: `Basic ${
            Buffer.from("opencode:factory-token").toString("base64")
          }`,
          "X-Orkestrator-OpenCode-Token": "factory-token",
        },
      }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("wraps empty and failed OpenCode session creation responses as unavailable", async () => {
    for (const response of [
      { data: {} },
      { error: { message: "failed" } },
    ]) {
      const fake = openCodeFake();
      fake.setCreateResponse(response);
      const provider = openCodeProvider(fake);
      try {
        await expect(provider.createSession("build", "Build task"))
          .rejects.toBeInstanceOf(ProviderUnavailableError);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("scopes OpenCode session creation to the requested title", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await expect(provider.createSession("build", "Build task")).resolves.toBe(
        "owned-session",
      );
      expect(fake.createCalls).toEqual([{ title: "Build task" }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("answers only owned-session events and denies unexpected permissions", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "permission.asked",
        properties: { id: "unrelated-p", sessionID: "other", always: ["*"] },
      });
      stream.push({
        type: "permission.asked",
        properties: { id: "owned-p", sessionID: "owned-session", always: ["*"] },
      });
      stream.push({
        type: "question.asked",
        properties: { id: "unrelated-q", sessionID: "other" },
      });
      stream.push({
        type: "question.asked",
        properties: { id: "owned-q", sessionID: "owned-session" },
      });

      await waitUntil(() => fake.questionRejections.length === 1);
      expect(fake.permissionReplies).toEqual([{
        requestID: "owned-p",
        directory: "/workspace",
        reply: "reject",
      }]);
      expect(fake.questionRejections).toEqual([{
        requestID: "owned-q",
        directory: "/workspace",
      }]);
      await expect(provider.status("owned-session")).resolves.toBe("error");
    } finally {
      await provider.dispose?.();
    }
  });

  test("reconciles pending requests for a restored owned session", async () => {
    const fake = openCodeFake();
    fake.setPending(
      [
        { id: "owned-p", sessionID: "restored", always: ["*"] },
        { id: "other-p", sessionID: "other", always: ["*"] },
      ],
      [
        { id: "owned-q", sessionID: "restored" },
        { id: "other-q", sessionID: "other" },
      ],
    );
    const provider = openCodeProvider(fake);
    try {
      provider.registerSession?.("restored");
      await waitUntil(() => fake.questionRejections.length === 1);
      expect(fake.permissionReplies.map((call) => call.requestID)).toEqual([
        "owned-p",
      ]);
      expect(fake.questionRejections.map((call) => call.requestID)).toEqual([
        "owned-q",
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([["throw"], ["missing-stream"]] as const)(
    "reconnects after an OpenCode subscribe %s failure",
    async (failure) => {
      const fake = openCodeFake();
      fake.setSubscribeFailures([failure]);
      const provider = openCodeProvider(fake);
      try {
        await waitUntil(() => fake.subscribeCallCount >= 2);
        expect(fake.subscriptions).toHaveLength(1);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test.each([["permission"], ["question"]] as const)(
    "recovers after an OpenCode pending %s list failure",
    async (requestType) => {
      const fake = openCodeFake();
      fake.setPending(
        requestType === "permission"
          ? [{ id: "pending-request", sessionID: "restored" }]
          : [],
        requestType === "question"
          ? [{ id: "pending-request", sessionID: "restored" }]
          : [],
      );
      fake.setPendingReadResponses(
        requestType === "permission" ? { error: { message: "failed" } } : null,
        requestType === "question" ? { error: { message: "failed" } } : null,
      );
      const provider = openCodeProvider(fake);
      try {
        await waitUntil(() => fake.subscriptions.length === 1);
        provider.registerSession?.("restored");
        await waitUntil(() =>
          fake.permissionListCallCount >= 1 && fake.questionListCallCount >= 1
        );

        fake.setPendingReadResponses(null, null);
        fake.subscriptions[0]!.close();
        if (requestType === "permission") {
          await waitUntil(() => fake.permissionReplies.length === 1);
        } else {
          await waitUntil(() => fake.questionRejections.length === 1);
        }
        expect(fake.subscriptions.length).toBeGreaterThanOrEqual(2);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("legacy reconciliation fails closed on malformed and oversized collections, then recovers", async () => {
    const invalidPermissionResponses: Array<Record<string, unknown>> = [
      { data: null },
      {
        data: Array.from({ length: 4_097 }, (_, index) => ({
          id: `permission-${index}`,
          sessionID: "restored",
        })),
      },
    ];
    for (const invalidPermissions of invalidPermissionResponses) {
      const fake = openCodeFake();
      fake.setPending([{
        id: "pending-request",
        sessionID: "restored",
      }], []);
      fake.setPendingReadResponses(invalidPermissions, { data: [] });
      const provider = openCodeProvider(fake);
      try {
        await waitUntil(() => fake.subscriptions.length === 1);
        provider.registerSession?.("restored");
        await waitUntil(() => fake.permissionListCallCount >= 1);
        expect(fake.permissionReplies).toEqual([]);

        fake.setPendingReadResponses(null, null);
        fake.subscriptions[0]!.close();
        await waitUntil(() => fake.permissionReplies.length === 1);
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("legacy reconciliation accepts a maximum-length request identity", async () => {
    const fake = openCodeFake();
    const requestId = "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength);
    fake.setPending([{ id: requestId, sessionID: "restored" }], []);
    const provider = openCodeProvider(fake);
    try {
      provider.registerSession?.("restored");
      await waitUntil(() => fake.permissionReplies.length === 1);
      expect(fake.permissionReplies[0]!.requestID).toBe(requestId);
    } finally {
      await provider.dispose?.();
    }
  });

});
