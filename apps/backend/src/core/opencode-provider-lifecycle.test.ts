import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { ARTIFACT_TOOL_NAMES } from "@orkestrator/protocol/transcript-artifacts";
import { describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_LIMITS,
  UNATTENDED_AGENT_INTERACTION_POLICY,
} from "@orkestrator/protocol/agent-interactions";
import { createNativeAgentProvider, ProviderUnavailableError } from "./native-agent-provider.js";
import {
  waitUntil,
  openCodeFake,
  openCodeProvider,
  openCodeActivityProvider,
} from "./agent-provider-test-support.js";

describe("OpenCode provider", () => {
  test("synchronizes coordinator policy once per change and again after provider restart", async () => {
    const fake = openCodeFake();
    const policy = {
      id: "coordinator-read-only" as const,
      sandbox: "provider" as const,
      approvals: "deny" as const,
      projectResources: false,
      capabilityPolicy: { deny: ["network" as const] },
      networkAccess: "restricted" as const,
    };
    let provider = openCodeActivityProvider(fake);
    try {
      await provider.synchronizeSessionPolicy?.("owned-session", policy);
      expect(fake.updateCalls).toHaveLength(1);
      await provider.synchronizeSessionPolicy?.("owned-session", structuredClone(policy));
      expect(fake.updateCalls).toHaveLength(1);
      const research = {
        ...policy,
        capabilityPolicy: { ...policy.capabilityPolicy, allow: ["web.search" as const] },
      };
      await provider.synchronizeSessionPolicy?.("owned-session", research);
      expect(fake.updateCalls).toHaveLength(2);
      await provider.dispose?.();
      provider = openCodeActivityProvider(fake);
      await provider.synchronizeSessionPolicy?.("owned-session", research);
      expect(fake.updateCalls).toHaveLength(3);
    } finally {
      await provider.dispose?.();
    }
  });

  test("applies the backend policy before adopting a resumed session", async () => {
    const fake = openCodeFake();
    const provider = openCodeActivityProvider(fake);
    try {
      await expect(
        provider.resumeSession?.("owned-session", undefined, {
          id: "interactive-host",
          sandbox: "provider",
          approvals: "deny",
          projectResources: true,
          toolPolicy: { allow: ["read"], deny: ["shell"] },
          networkAccess: "restricted",
        }),
      ).resolves.toBe("owned-session");
      expect(fake.updateCalls).toEqual([
        {
          sessionID: "owned-session",
          permission: [
            { permission: "*", pattern: "*", action: "deny" },
            // A worker's mail tools are allowed whatever the default.
            ...[...AGENT_MAIL_TOOL_NAMES, ...ARTIFACT_TOOL_NAMES].map((name) => ({
              permission: `orkestrator_${name}`,
              pattern: "*",
              action: "allow",
            })),
            { permission: "read", pattern: "*", action: "allow" },
            { permission: "shell", pattern: "*", action: "deny" },
          ],
        },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

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
      expect(fake.sessionGetCalls).toEqual([
        {
          sessionID: "omitted-session",
          directory: "/workspace",
        },
      ]);
      expect(fake.statusOptions[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(fake.sessionGetOptions[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(fake.updateCalls).toHaveLength(0);
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
      await expect(
        provider.activityBatch?.(["existing-session", "deleted-session", "existing-session"]),
      ).resolves.toEqual(
        new Map([
          ["existing-session", "idle"],
          ["deleted-session", "missing"],
        ]),
      );
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
    for (const failure of [{ error: { message: "failed" } }, new Error("connection reset")]) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: {} });
      if (failure instanceof Error) fake.setSessionListError(failure);
      else fake.setSessionListResponse(failure);
      fake.setSessionGetError(new Error("exact read failed"));
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.status("omitted-session")).rejects.toBeInstanceOf(
          ProviderUnavailableError,
        );
        await expect(provider.activityBatch?.(["omitted-session"])).resolves.toEqual(
          new Map([["omitted-session", "idle"]]),
        );
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
        data: [
          {
            id: "foreign-session",
            title: "x".repeat(4 * 1024 * 1024 + 1),
          },
        ],
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
        await expect(provider.activityBatch?.(["omitted-session"])).resolves.toEqual(
          new Map([["omitted-session", "idle"]]),
        );
        expect(fake.sessionGetCalls).toEqual([
          {
            sessionID: "omitted-session",
            directory: "/workspace",
          },
        ]);
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
      await expect(provider.activity?.("omitted-session")).resolves.toBe("idle");
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
      await expect(provider.activity?.("deleted-session")).resolves.toBe("missing");
      expect(fake.sessionGetCalls).toEqual([
        {
          sessionID: "deleted-session",
          directory: "/workspace",
        },
      ]);
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
      openCodeStatusReconcileIntervalMs: 100,
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
      await expect(provider.activity?.("session-that-deletes")).resolves.toBe("idle");
      await expect(provider.status("session-that-deletes")).resolves.toBe("missing");
      await expect(provider.activity?.("session-that-deletes")).resolves.toBe("missing");
      // The strong status read publishes the missing transition into the SSE
      // lifecycle cache, so the following activity read needs no second probe.
      expect(fake.sessionGetCallCount).toBe(1);
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
      // Status reads probe existence, never reconcile permissions.
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
      await expect(provider.status("target")).rejects.toBeInstanceOf(ProviderUnavailableError);
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
      await expect(provider.activityBatch?.(["busy", "unresolved"])).resolves.toEqual(
        new Map([
          ["unresolved", "idle"],
          ["busy", "working"],
        ]),
      );
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

      await expect(provider.status("target")).rejects.toBeInstanceOf(ProviderUnavailableError);
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
    const sessionIds = Array.from({ length: 20 }, (_, index) => `missing-${index}`);
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
    const sessionIds = Array.from({ length: 1_025 }, (_, index) => `session-${index}`);
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
      await expect(provider.status("tracked")).rejects.toMatchObject({
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

    for (const sessionId of ["", "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1)]) {
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
      Object.fromEntries(
        Array.from({ length: 4_097 }, (_, index) => [`foreign-${index}`, { type: "idle" }]),
      ),
      {
        foreign: {
          type: "idle",
          padding: "x".repeat(AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes + 1),
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
      fake.setPending([{ id: "permission-other", sessionID: "other-session" }], []);
      await expect(provider.activity?.("owned-session")).resolves.toBe("working");
      fake.setPending([{ id: "permission-owned", sessionID: "owned-session" }], []);
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

      expect(activity).toEqual(
        new Map([
          ["idle-session", "idle"],
          ["missing-session", "missing"],
          ["busy-session", "waiting"],
          ["retry-session", "waiting"],
        ]),
      );
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

      expect(activity).toEqual(
        new Map([
          ["idle-session", "idle"],
          ["error-session", "idle"],
          ["missing-session", "missing"],
        ]),
      );
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

  test("leaves OpenCode permissions and questions pending for the journaled path", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
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
      fake.subscriptions[0]!.push({
        type: "question.rejected",
        properties: { id: "question-0", sessionID: "owned-session" },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Even an unattended registration is answered by its owner through
      // `agentInteractionPolicyAction`, never by the provider's event loop.
      expect(fake.permissionReplies).toEqual([]);
      expect(fake.questionRejections).toEqual([]);
      await expect(provider.status("owned-session")).resolves.not.toBe("blocked");
      await expect(provider.status("owned-session")).resolves.not.toBe("error");
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
      await expect(provider.activity?.("owned-session")).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    } finally {
      await provider.dispose?.();
    }
  });

  test.each([
    ["question", "envelope"],
    ["permission", "envelope"],
    ["question", "throw"],
    ["permission", "throw"],
  ] as const)(
    "wraps OpenCode %s list %s failures as unavailable",
    async (requestType, failureType) => {
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
        await expect(provider.activity?.("owned-session")).rejects.toBeInstanceOf(
          ProviderUnavailableError,
        );
        expect(fake.statusCallCount).toBe(1);
        expect(fake.questionListCallCount).toBe(1);
        expect(fake.permissionListCallCount).toBe(1);
      } finally {
        await provider.dispose?.();
      }
    },
  );

  test("bounds OpenCode activity snapshots and accepts a maximum-length identity", async () => {
    const invalidQuestionResponses: Array<Record<string, unknown>> = [
      {
        data: Array.from({ length: 4_097 }, (_, index) => ({
          id: `question-${index}`,
          sessionID: "owned-session",
        })),
      },
      {
        data: [
          {
            id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength + 1),
            sessionID: "owned-session",
          },
        ],
      },
    ];
    for (const questions of invalidQuestionResponses) {
      const fake = openCodeFake();
      fake.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
      fake.setPendingReadResponses({ data: [] }, questions);
      const provider = openCodeActivityProvider(fake);
      try {
        await expect(provider.activity?.("owned-session")).rejects.toBeInstanceOf(
          ProviderUnavailableError,
        );
      } finally {
        await provider.dispose?.();
      }
    }

    const boundary = openCodeFake();
    boundary.setStatusResponse({ data: { "owned-session": { type: "busy" } } });
    boundary.setPendingReadResponses(
      { data: [] },
      {
        data: [
          {
            id: "x".repeat(AGENT_INTERACTION_LIMITS.maxIdLength),
            sessionID: "owned-session",
          },
        ],
      },
    );
    const boundaryProvider = openCodeActivityProvider(boundary);
    try {
      await expect(boundaryProvider.activity?.("owned-session")).resolves.toBe("waiting");
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
      },
    );

    try {
      expect(factoryCalls).toEqual([
        {
          baseUrl: "http://opencode.test",
          directory: "/workspace/project",
          headers: {
            Authorization: `Basic ${Buffer.from("opencode:factory-token").toString("base64")}`,
            "X-Orkestrator-OpenCode-Token": "factory-token",
          },
        },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("wraps empty and failed OpenCode session creation responses as unavailable", async () => {
    for (const response of [{ data: {} }, { error: { message: "failed" } }]) {
      const fake = openCodeFake();
      fake.setCreateResponse(response);
      const provider = openCodeProvider(fake);
      try {
        await expect(provider.createSession("build", "Build task")).rejects.toBeInstanceOf(
          ProviderUnavailableError,
        );
      } finally {
        await provider.dispose?.();
      }
    }
  });

  test("scopes OpenCode session creation to the requested title", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await expect(provider.createSession("build", "Build task")).resolves.toBe("owned-session");
      expect(fake.createCalls).toEqual([{ title: "Build task" }]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("creates an OpenCode session with the selected model", async () => {
    const fake = openCodeFake();
    const provider = openCodeProvider(fake);
    try {
      await expect(
        provider.createSession("build", "Build task", {
          model: "opencode-go/deepseek-v4-flash",
          effort: "default",
        }),
      ).resolves.toBe("owned-session");
      expect(fake.createCalls).toEqual([
        {
          title: "Build task",
          model: { providerID: "opencode-go", id: "deepseek-v4-flash" },
        },
      ]);
    } finally {
      await provider.dispose?.();
    }
  });

  test("rejects session.create when OpenCode does not know the provider or model", async () => {
    const fake = openCodeFake();
    fake.setCreateResponse({ error: { message: "Unknown provider or model" } });
    const provider = openCodeProvider(fake);
    try {
      await expect(
        provider.createSession("build", "Build task", {
          model: "unknown-provider/missing-model",
        }),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(fake.createCalls).toEqual([
        {
          title: "Build task",
          model: { providerID: "unknown-provider", id: "missing-model" },
        },
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
});
