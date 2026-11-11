import { describe, expect, test } from "bun:test";
import { BridgePolicyWideningRefusedError } from "./agent-provider-contract.js";
import {
  NativeAgentSessionOperations,
  type NativeAgentSessionOperationsHost,
} from "./native-agent-session-operations.js";
import {
  NativeAgentProviderSessionMissingError,
  nativeAgentSessionStorageKey,
  type NativeAgentRuntimeProvider,
  type NativeAgentServiceOptions,
  type NativeAgentSessionProjection,
  type PersistedNativeAgentSession,
  type StorageService,
} from "./native-agent-service-shared.js";
import { isReplacedSessionCloseKey } from "./provider-session-ownership.js";

const identity = {
  environmentId: "env-1",
  agent: "codex" as const,
  logicalSessionKey: "env-env-1:tab-1",
};
const sessionKey = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);
const projection = { title: "refreshed" } as unknown as NativeAgentSessionProjection;

function harness(
  input: {
    provider?: Record<string, unknown>;
    session?: Partial<PersistedNativeAgentSession> | null;
    storage?: Record<string, unknown>;
    options?: NativeAgentServiceOptions;
    composer?: Record<string, unknown>;
    host?: Partial<NativeAgentSessionOperationsHost>;
  } = {},
) {
  const events: string[] = [];
  const stopNotices: string[] = [];
  const session =
    input.session === null
      ? null
      : ({
          ...identity,
          key: sessionKey,
          providerSessionId: "provider-session",
          ...input.session,
        } as PersistedNativeAgentSession);
  const provider = {
    agent: identity.agent,
    status: async () => "idle",
    abort: async () => {
      events.push("abort");
    },
    ...input.provider,
  } as unknown as NativeAgentRuntimeProvider;
  const storage = {
    getNativeAgentSession: async (key: string) => (key === sessionKey ? session : null),
    getEnvironment: async () => null,
    listNativeAgentSessions: async () => [],
    listMultiReviewWorkflows: async () => [],
    recordNativeAgentTurnInterrupt: async () => {
      events.push("record-interrupt");
      return true;
    },
    ...input.storage,
  } as unknown as StorageService;
  const withComposer = input.composer
    ? ({ ...projection, composer: input.composer } as unknown as NativeAgentSessionProjection)
    : null;
  const projections = {
    refreshProjectionState: async () => {
      events.push("refresh-state");
      return withComposer ?? projection;
    },
    refreshProjection: async () => {
      events.push("refresh");
      return withComposer ?? projection;
    },
    invalidateProjection: (key: string) => {
      events.push(`invalidate:${key}`);
    },
    recordStopNotice: (_key: string, notice: string) => {
      stopNotices.push(notice);
    },
  } as unknown as NativeAgentSessionOperationsHost["projections"];
  const promptQueues = {
    withSessionMutationIntent: async <T>(_input: unknown, operation: () => Promise<T>) => {
      events.push("intent:enter");
      try {
        return await operation();
      } finally {
        events.push("intent:exit");
      }
    },
    withSessionWorkFence: async <T>(_input: unknown, operation: () => Promise<T>) => {
      events.push("work-fence:enter");
      try {
        return await operation();
      } finally {
        events.push("work-fence:exit");
      }
    },
    fenceTurnInterrupt: (_key: string, _providerSessionId: string, requestId: string) => {
      events.push(`fence:${requestId}`);
    },
    releaseTurnInterrupt: (_key: string, requestId: string) => {
      events.push(`release:${requestId}`);
    },
  } as unknown as NativeAgentSessionOperationsHost["promptQueues"];
  const interactions = {
    forgetPendingInteractions: (key: string) => {
      events.push(`forget:${key}`);
    },
  } as unknown as NativeAgentSessionOperationsHost["interactions"];
  const host: NativeAgentSessionOperationsHost = {
    storage,
    options: { abortGraceMs: 0, ...input.options },
    projections,
    promptQueues,
    interactions,
    now: () => 1_000,
    assertProjectionInput: () => undefined,
    resolveProjectionSession: async () =>
      session ? { key: sessionKey, session, provider, transient: false } : null,
    provider: async () => provider,
    replaceBridgeForWiderPolicy: async () => {
      events.push("replace-bridge");
    },
    observeProvider: async () => provider,
    trustedSessionInput: async (value) => value,
    adoptSession: async (value) => {
      events.push(`adopt:${value.providerSessionId}`);
      return session!;
    },
    getProjection: async () => withComposer,
    performProjectionSteer: async () => {
      events.push("steer");
      return { outcome: "applied", requestId: "steer-1" };
    },
    ...input.host,
  };
  return { operations: new NativeAgentSessionOperations(host), events, stopNotices };
}

describe("NativeAgentSessionOperations", () => {
  describe("Stop", () => {
    test("returns null without touching a provider when the session is unknown", async () => {
      const { operations, events } = harness({ session: null });
      expect(await operations.stopProjectionSession(identity)).toBeNull();
      expect(events).toEqual(["intent:enter", "intent:exit"]);
    });

    test("fences a running turn before the abort and force-stops past the grace period", async () => {
      let hardAborted = false;
      const { operations, events, stopNotices } = harness({
        session: { dispatchedRequestIds: ["request-1"] },
        provider: {
          status: async () => (hardAborted ? "idle" : "running"),
          hardAbort: async () => {
            hardAborted = true;
            events.push("hard-abort");
          },
        },
      });
      expect(await operations.stopProjectionSession(identity)).toBe(projection);
      expect(events).toEqual([
        "intent:enter",
        "fence:request-1",
        "record-interrupt",
        "abort",
        "release:request-1",
        "hard-abort",
        "refresh",
        "intent:exit",
      ]);
      expect(stopNotices).toEqual([
        "The turn did not stop within the grace period and a force-stop was requested.",
      ]);
    });

    test("a turn that already released input is not fenced as interrupted", async () => {
      const { operations, events, stopNotices } = harness({
        session: { dispatchedRequestIds: ["request-1"] },
        provider: {
          status: async () => "running",
          observeActivity: async () => ({ readyForInput: true }),
        },
      });
      await operations.stopProjectionSession(identity);
      expect(events.some((event) => event.startsWith("fence:"))).toBe(false);
      expect(stopNotices).toEqual([
        "The turn did not stop within the grace period; this provider has no force-stop action.",
      ]);
    });

    test("surfaces an abort failure only after the stop finished and refreshed", async () => {
      const { operations, events, stopNotices } = harness({
        provider: {
          abort: async () => {
            throw new Error("abort failed");
          },
        },
      });
      await expect(operations.stopProjectionSession(identity)).rejects.toThrow("abort failed");
      expect(events).toEqual(["intent:enter", "refresh", "intent:exit"]);
      expect(stopNotices).toEqual(["The turn stopped after a graceful interrupt."]);
    });
  });

  describe("request-scoped Stop", () => {
    const running = { status: async () => "running" };

    test("stops the turn its request is running, under the work fence", async () => {
      const { operations, events } = harness({
        session: { dispatchedRequestIds: ["older", "drafting"] },
        provider: running,
      });
      expect(await operations.stopProjectionRequest(identity, "drafting")).toEqual({
        stopped: true,
      });
      expect(events.slice(0, 4)).toEqual([
        "work-fence:enter",
        "intent:enter",
        "fence:drafting",
        "record-interrupt",
      ]);
      expect(events).toContain("abort");
      expect(events.at(-1)).toBe("work-fence:exit");
    });

    test("stops a request the provider has not accepted yet", async () => {
      const { operations, events } = harness({
        session: {
          dispatchedRequestIds: ["older"],
          pendingDispatch: {
            requestId: "drafting",
          } as PersistedNativeAgentSession["pendingDispatch"],
        },
        provider: running,
      });
      expect((await operations.stopProjectionRequest(identity, "drafting")).stopped).toBe(true);
      expect(events).toContain("abort");
    });

    for (const [name, session] of [
      ["a newer user turn replaced it", { dispatchedRequestIds: ["drafting", "user-turn"] }],
      [
        "a newer user turn is being dispatched",
        {
          dispatchedRequestIds: ["drafting"],
          pendingDispatch: { requestId: "user-turn" },
        },
      ],
      [
        "its turn already ended",
        {
          dispatchedRequestIds: ["drafting"],
          turnOutcomes: [{ requestId: "drafting", outcome: "completed" }],
        },
      ],
      [
        "its turn was already interrupted",
        { dispatchedRequestIds: ["drafting"], interruptedRequestIds: ["drafting"] },
      ],
      ["it was never dispatched", { dispatchedRequestIds: ["user-turn"] }],
    ] as const) {
      test(`leaves the session alone when ${name}`, async () => {
        const { operations, events } = harness({
          session: session as unknown as Partial<PersistedNativeAgentSession>,
          provider: running,
        });
        expect(await operations.stopProjectionRequest(identity, "drafting")).toEqual({
          stopped: false,
        });
        expect(events).toEqual(["work-fence:enter", "work-fence:exit"]);
      });
    }

    test("an unknown session is not stopped", async () => {
      const { operations, events } = harness({ session: null });
      expect((await operations.stopProjectionRequest(identity, "drafting")).stopped).toBe(false);
      expect(events).toEqual(["work-fence:enter", "work-fence:exit"]);
    });
  });

  describe("resume", () => {
    test("adopts the resumed session and closes the one it replaced through the journal", async () => {
      const journal: string[] = [];
      const closed: string[] = [];
      const { operations, events } = harness({
        provider: {
          resumeSession: async (id: string) => `${id}-resumed`,
          closeSession: async (id: string) => {
            closed.push(id);
          },
        },
        storage: {
          setTabTeardownIntent: async (_environmentId: string, intent: { tabId: string }) => {
            journal.push(`set:${isReplacedSessionCloseKey(intent.tabId)}`);
          },
          clearTabTeardownIntent: async () => {
            journal.push("clear");
          },
        },
      });
      expect(
        await operations.resumeProjectionSession({ ...identity, providerSessionId: "older" }),
      ).toBe(projection);
      expect(events).toContain("adopt:older-resumed");
      expect(events).toContain(`invalidate:${sessionKey}`);
      expect(closed).toEqual(["provider-session"]);
      expect(journal).toEqual(["set:true", "clear"]);
    });

    test("reopens once when a last-owner close removed the session before adoption", async () => {
      let adoptions = 0;
      let reopened = 0;
      const { operations } = harness({
        provider: {
          resumeSession: async (id: string) => {
            reopened += 1;
            return id;
          },
        },
        host: {
          adoptSession: async () => {
            adoptions += 1;
            if (adoptions === 1) throw new NativeAgentProviderSessionMissingError();
            return {} as PersistedNativeAgentSession;
          },
        },
      });
      await operations.resumeProjectionSession({
        ...identity,
        providerSessionId: "provider-session",
      });
      expect(reopened).toBe(2);
      expect(adoptions).toBe(2);
    });

    test("a user's wider policy replaces the bridge, then resumes on the new one", async () => {
      const resumes: string[] = [];
      const refusing = {
        resumeSession: async () => {
          resumes.push("old-bridge");
          throw new BridgePolicyWideningRefusedError("refused");
        },
      };
      const fresh = {
        resumeSession: async (id: string) => {
          resumes.push("new-bridge");
          return id;
        },
      } as unknown as NativeAgentRuntimeProvider;
      let replaced = false;
      const { operations, events } = harness({
        provider: refusing,
        host: {
          provider: async () =>
            replaced ? fresh : (refusing as unknown as NativeAgentRuntimeProvider),
          replaceBridgeForWiderPolicy: async () => {
            replaced = true;
          },
        },
      });

      await operations.resumeProjectionSession({
        ...identity,
        providerSessionId: "provider-session",
      });

      expect(resumes).toEqual(["old-bridge", "new-bridge"]);
      expect(events).toContain("adopt:provider-session");
    });

    test("a bridge with live work keeps it and the resume says what to do", async () => {
      let resumes = 0;
      const { operations } = harness({
        provider: {
          resumeSession: async () => {
            resumes += 1;
            throw new BridgePolicyWideningRefusedError("refused");
          },
        },
        host: {
          replaceBridgeForWiderPolicy: async () => {
            throw new Error("a turn is running");
          },
        },
      });

      await expect(
        operations.resumeProjectionSession({ ...identity, providerSessionId: "provider-session" }),
      ).rejects.toThrow("a turn is running");
      expect(resumes).toBe(1);
    });

    test("a bridge that still refuses after the restart is not retried again", async () => {
      let resumes = 0;
      const { operations, events } = harness({
        provider: {
          resumeSession: async () => {
            resumes += 1;
            throw new BridgePolicyWideningRefusedError("refused");
          },
        },
      });

      await expect(
        operations.resumeProjectionSession({ ...identity, providerSessionId: "provider-session" }),
      ).rejects.toBeInstanceOf(BridgePolicyWideningRefusedError);
      expect(resumes).toBe(2);
      expect(events.filter((event) => event === "replace-bridge")).toHaveLength(1);
    });

    test("a refusal for another reason does not touch the bridge", async () => {
      const { operations, events } = harness({
        provider: {
          resumeSession: async () => {
            throw new Error("HTTP 403: forbidden");
          },
        },
      });

      await expect(
        operations.resumeProjectionSession({ ...identity, providerSessionId: "provider-session" }),
      ).rejects.toThrow("forbidden");
      expect(events).not.toContain("replace-bridge");
    });

    test("lists resumable sessions newest first without the tab's own conversation", async () => {
      const { operations } = harness({
        provider: {
          listResumableSessions: async () => [
            { sessionId: "old", updatedAt: "2026-01-01T00:00:00Z" },
            { sessionId: "provider-session", updatedAt: "2026-03-01T00:00:00Z" },
            { sessionId: "undated" },
            { sessionId: "new", updatedAt: "2026-02-01T00:00:00Z" },
          ],
        },
      });
      const entries = await operations.listProjectionResumableSessions(identity);
      expect(entries.map((entry) => entry.sessionId)).toEqual(["new", "old", "undated"]);
    });

    test.each([512, 513])(
      "reserves archived capacity alongside %s live entries",
      async (liveCount) => {
        const { operations } = harness({
          provider: {
            listResumableSessions: async () => [
              ...Array.from({ length: liveCount }, (_, index) => ({ sessionId: `live-${index}` })),
              ...Array.from({ length: 513 }, (_, index) => ({
                sessionId: `archived-${index}`,
                archived: true,
              })),
            ],
          },
        });
        const entries = await operations.listProjectionResumableSessions({
          ...identity,
          includeArchived: true,
        });
        expect(entries.filter((entry) => !entry.archived)).toHaveLength(512);
        expect(entries.filter((entry) => entry.archived)).toHaveLength(512);
        expect(entries[512]).toMatchObject({ sessionId: "archived-0", archived: true });
      },
    );

    test("asks for archived rows only where they exist, and lists them last", async () => {
      const asked: unknown[] = [];
      const listResumableSessions = async (options?: unknown) => {
        asked.push(options);
        return [
          { sessionId: "kept", archived: true, updatedAt: "2026-06-01T00:00:00Z" },
          { sessionId: "live", updatedAt: "2026-01-01T00:00:00Z" },
        ];
      };
      const { operations } = harness({ provider: { listResumableSessions } });
      const entries = await operations.listProjectionResumableSessions({
        ...identity,
        includeArchived: true,
      });
      expect(asked).toEqual([{ includeArchived: true }]);
      expect(entries.map((entry) => entry.sessionId)).toEqual(["live", "kept"]);

      await operations.listProjectionResumableSessions(identity);
      expect(asked.at(-1)).toBeUndefined();

      // Claude has no archive, so the option never reaches its bridge.
      const claude = harness({ provider: { listResumableSessions } });
      await claude.operations.listProjectionResumableSessions({
        ...identity,
        agent: "claude",
        includeArchived: true,
      });
      expect(asked.at(-1)).toBeUndefined();
    });

    test("OpenCode lists archived 2.x rows and keeps each row's archivable marker", async () => {
      const asked: unknown[] = [];
      const { operations } = harness({
        provider: {
          listResumableSessions: async (options?: unknown) => {
            asked.push(options);
            return [
              { sessionId: "ses_legacy", archivable: false },
              { sessionId: "opencode2:ses_a", archived: true },
            ];
          },
        },
      });
      const entries = await operations.listProjectionResumableSessions({
        ...identity,
        agent: "opencode",
        includeArchived: true,
      });
      expect(asked).toEqual([{ includeArchived: true }]);
      expect(entries).toEqual([
        { sessionId: "ses_legacy", archivable: false },
        { sessionId: "opencode2:ses_a", archived: true },
      ]);
    });

    test("OpenCode archive reaches the provider", async () => {
      const calls: unknown[] = [];
      const { operations } = harness({
        provider: {
          setResumableSessionArchived: async (id: string, archived: boolean) => {
            calls.push([id, archived]);
          },
        },
      });
      await operations.setProjectionResumableSessionArchived({
        ...identity,
        agent: "opencode",
        resumableSessionId: "opencode2:ses_a",
        archived: true,
      });
      expect(calls).toEqual([["opencode2:ses_a", true]]);
      await expect(
        operations.setProjectionResumableSessionArchived({
          ...identity,
          agent: "claude",
          resumableSessionId: "x",
          archived: true,
        }),
      ).rejects.toThrow("cannot archive");
    });
  });

  test("a fork carries the composer's selection into the child's controls", async () => {
    const lineage: unknown[] = [];
    const { operations } = harness({
      session: { controls: { modelId: "stored", reasoningId: "low" } },
      composer: { selectedModelId: "gpt-5", selectedReasoningId: "high" },
      options: {
        changeTracking: () => ({ noteFork: (fork: unknown) => lineage.push(fork) }) as never,
      },
      provider: { forkSession: async () => ({ sessionId: "child" }) },
    });
    const outcome = await operations.forkProjectionSession(identity);
    expect(outcome).toMatchObject({
      sessionId: "child",
      controls: { modelId: "gpt-5", reasoningId: "high" },
    });
    expect(lineage).toEqual([
      expect.objectContaining({ childProviderSessionId: "child", provider: "codex" }),
    ]);
  });

  describe("session actions", () => {
    test("a read-only coordinator cannot change files", async () => {
      const { operations } = harness({
        session: { executionPolicy: "coordinator-read-only" },
        provider: { performSessionAction: async () => ({ outcome: "applied" }) },
      });
      await expect(
        operations.performProjectionAction({ ...identity, action: { kind: "undo" } }),
      ).rejects.toThrow("Read-only coordinator sessions cannot change project files");
    });

    test("steer goes to the host's persisted-steer path; other actions invalidate", async () => {
      const { operations, events } = harness({
        provider: { performSessionAction: async () => ({ outcome: "applied" }) },
      });
      expect(
        await operations.performProjectionAction({
          ...identity,
          action: { kind: "steer", text: "look here" },
        }),
      ).toEqual({ outcome: "applied", requestId: "steer-1" });
      expect(events).toEqual(["steer"]);
      await operations.performProjectionAction({ ...identity, action: { kind: "compact" } });
      expect(events).toEqual(["steer", `invalidate:${sessionKey}`]);
    });

    test("compaction instructions reach only platforms that honour them", async () => {
      const actions: unknown[] = [];
      const { operations } = harness({
        provider: {
          performSessionAction: async (_session: string, action: unknown) => {
            actions.push(action);
            return { outcome: "applied" };
          },
        },
      });
      // The identity is Codex, whose `thread/compact/start` takes no instructions.
      await expect(
        operations.performProjectionAction({
          ...identity,
          action: { kind: "compact", instructions: "keep the plan" },
        }),
      ).rejects.toThrow("Codex cannot take compaction instructions");
      expect(actions).toEqual([]);

      const pi = { ...identity, agent: "pi" as const };
      await operations.performProjectionAction({
        ...pi,
        action: { kind: "compact", instructions: "keep the plan" },
      });
      expect(actions).toEqual([{ kind: "compact", instructions: "keep the plan" }]);
    });
  });

  describe("branches", () => {
    const list = { activeEntryId: "e-2", branches: [], truncated: false };

    test("Pi lists its branches through the provider, by provider session", async () => {
      const asked: string[] = [];
      const { operations } = harness({
        provider: {
          listSessionBranches: async (providerSessionId: string) => {
            asked.push(providerSessionId);
            return list;
          },
        },
      });
      expect(await operations.listProjectionBranches({ ...identity, agent: "pi" })).toEqual(list);
      expect(asked).toEqual(["provider-session"]);
    });

    test("a platform without branches is refused before the provider is asked", async () => {
      let asked = false;
      const { operations } = harness({
        provider: {
          listSessionBranches: async () => {
            asked = true;
            return list;
          },
        },
      });
      await expect(operations.listProjectionBranches(identity)).rejects.toThrow(
        "codex conversations have no branches",
      );
      expect(asked).toBe(false);
    });

    test("an unknown session is not found", async () => {
      const { operations } = harness({ session: null });
      await expect(operations.listProjectionBranches({ ...identity, agent: "pi" })).rejects.toThrow(
        "Native agent session was not found",
      );
    });
  });

  describe("sign-in", () => {
    test("a containerized environment always signs in by device code", async () => {
      const requests: unknown[] = [];
      const { operations, events } = harness({
        storage: { getEnvironment: async () => ({ environmentType: "containerized" }) },
        provider: {
          beginSignIn: async (request: unknown) => {
            requests.push(request);
            return { code: "ABCD" };
          },
        },
      });
      expect(await operations.beginProjectionSignIn(identity)).toEqual({ code: "ABCD" });
      expect(requests).toEqual([{ deviceCode: true }]);
      expect(events).toEqual([`invalidate:${sessionKey}`]);
    });

    test("cancel without a running provider releases nothing and still invalidates", async () => {
      const { operations, events } = harness({ host: { observeProvider: async () => undefined } });
      expect(await operations.cancelProjectionSignIn(identity)).toEqual({ cancelled: false });
      expect(events).toEqual([`invalidate:${sessionKey}`]);
    });
  });

  describe("controls", () => {
    test("rejects a model the composer does not offer before writing anything", async () => {
      const { operations } = harness({
        composer: { models: [{ id: "gpt-5" }], modes: [] },
        storage: {
          updateNativeAgentSessionControls: async () => {
            throw new Error("must not write");
          },
        },
      });
      await expect(
        operations.updateProjectionControls({ ...identity, update: { modelId: "unknown" } }),
      ).rejects.toThrow("Native agent model selection is invalid");
    });

    test("a valid update is stored and applied to the provider", async () => {
      const applied: unknown[] = [];
      const { operations } = harness({
        composer: { models: [{ id: "gpt-5" }], modes: [] },
        provider: {
          updateInteractiveControls: async (_id: string, update: unknown) => {
            applied.push(update);
          },
        },
        storage: {
          updateNativeAgentSessionControls: async (
            _key: string,
            _id: string,
            _update: unknown,
            apply: () => Promise<void>,
          ) => apply(),
        },
      });
      expect(
        await operations.updateProjectionControls({ ...identity, update: { modelId: "gpt-5" } }),
      ).toMatchObject({ title: "refreshed" });
      expect(applied).toEqual([{ modelId: "gpt-5" }]);
    });
  });

  describe("interactions", () => {
    test("an answer drops the cached pending reads and refreshes", async () => {
      const { operations, events } = harness({
        provider: {
          interactions: {
            resolveInteraction: async () => ({ result: "applied" }),
          },
        },
      });
      expect(
        await operations.resolveProjectionInteraction({
          ...identity,
          interactionId: "question-1",
          resolution: { kind: "dismiss" } as never,
        }),
      ).toEqual({ result: "applied" } as never);
      expect(events).toEqual([`forget:${sessionKey}`, "refresh-state"]);
    });

    test("a hold the provider cannot apply is rejected", async () => {
      const { operations } = harness({ provider: { interactions: {} } });
      expect(
        await operations.holdProjectionInteraction({
          ...identity,
          interactionId: "question-1",
          held: true,
        }),
      ).toEqual({
        result: "rejected",
        interactionId: "question-1",
        sessionId: "provider-session",
        revision: 0,
      });
    });

    test("approve-and-remember needs the permission rules", async () => {
      const { operations } = harness();
      await expect(
        operations.approveProjectionInteractionAndRemember({
          ...identity,
          interactionId: "approval-1",
          choice: { pattern: "npm test", scope: "project", anyProvider: false },
        }),
      ).rejects.toThrow("Permission rules are unavailable");
    });
  });
});
