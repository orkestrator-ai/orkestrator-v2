/**
 * The provider lifecycle a projection read sits on top of: interaction
 * routing, cache invalidation, failure isolation, and retirement.
 */
import { describe, expect, mock, test } from "bun:test";

import { promises as fs } from "node:fs";

import { tmpdir } from "node:os";

import path from "node:path";

import { AGENT_INTERACTION_CONTRACT_VERSION } from "@orkestrator/protocol/agent-interactions";

import { ProviderUnavailableError, type AgentSessionProvider } from "./native-agent-provider.js";

import { NativeAgentService, nativeAgentSessionStorageKey } from "./native-agent-service.js";

import {
  addEnvironment,
  captureWarnings,
  createProviderStub,
  createStorage,
  pendingInteractionSnapshot,
  waitForCondition,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { answerResolution, codexConnection, httpProvider } from "./agent-provider-test-support.js";
import { describeInteraction } from "../../../../bridges/codex-bridge/src/app-server/interactions.js";
import { collaborators } from "./native-agent-service-test-collaborators.js";

describe("NativeAgentService projection lifecycle", () => {
  const defaultModeQuestion = describeInteraction({
    interactionId: "default-question",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      isBlocking: false,
      questions: [{ id: "q", question: "Which?", options: [{ label: "A" }] }],
    },
    generation: 1,
    requestedAt: Date.now(),
    defaultExpiresAt: Date.now() + 60_000,
  })!;

  test.each([
    ["the current bridge", defaultModeQuestion],
    // Bridges before todo 0161 passed Codex's `isBlocking: false` through.
    ["an older bridge", { ...defaultModeQuestion, isBlocking: false }],
  ])(
    "a Default-mode Codex RPC question from %s publishes waiting and resumes after an answer",
    async (_bridge, question) => {
      expect(defaultModeQuestion.isBlocking).toBe(true);
      let pending = true;
      const { provider } = httpProvider((url) => {
        if (url.endsWith("/approvals")) return Response.json({ approvals: [] });
        if (url.endsWith("/interactions"))
          return Response.json({ interactions: pending ? [question] : [] });
        if (url.endsWith("/interactions/default-question")) {
          pending = false;
          return Response.json({ status: "applied" });
        }
        return new Response(null, { status: 404 });
      }, codexConnection);
      const stub = createProviderStub("codex", {
        interactiveSnapshot: async () => ({ status: "running", messages: [] }),
        interactions: provider.interactions,
      });
      await withService(
        { prefix: "orkestrator-codex-default-question-", provider: async () => stub.provider },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent: "codex" as const,
            logicalSessionKey: "env-env-1:default-question",
          };
          await service.ensureSession(identity);
          // No mounted renderer or event subscription: authoritative reads alone.
          const waiting = await service.getProjection(identity);
          expect(waiting?.turn.phase).toBe("blocked");
          expect(waiting?.interactions[0]?.blocking).toBe(true);
          const request = waiting!.interactions[0]!;
          expect(
            await provider.interactions!.resolveInteraction(
              "provider-session",
              request.id,
              answerResolution(request),
            ),
          ).toMatchObject({ result: "applied" });
          const resumed = await service.getProjection(identity);
          expect(resumed?.turn.phase).toBe("running");
          expect(resumed?.interactions).toEqual([]);
        },
      );
    },
  );

  test("keeps non-blocking questions visible without blocking the active turn", async () => {
    const interactions = pendingInteractionSnapshot(10_000, ["question"]);
    interactions.requests[0]!.blocking = false;
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "running", messages: [] }),
      interactions: {
        listPendingInteractions: async () => interactions,
        resolveInteraction: async () => ({
          result: "applied",
          interactionId: "interaction-0",
          sessionId: "provider-session",
          revision: 2,
        }),
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-nonblocking-question-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-nonblocking",
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.turn.phase).toBe("running");
        expect(projection?.interactions).toHaveLength(1);
      },
    );
  });

  test("projects pending interactions and routes neutral stop, controls, and resolution", async () => {
    const resolveInteraction = mock(async () => ({
      result: "applied" as const,
      interactionId: "interaction-0",
      sessionId: "provider-session",
      revision: 2,
    }));
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({
        status: "running",
        messages: [],
        composer: {
          models: [{ platform: "codex", id: "gpt-5", label: "GPT-5" }],
          selectedModelId: "gpt-5",
          fastModeEnabled: false,
          fastModeAvailable: true,
          selectedModeId: "build",
          modes: [{ id: "build", label: "Build" }],
        },
      }),
      interactions: {
        listPendingInteractions: async () => pendingInteractionSnapshot(10_000, ["permission"]),
        resolveInteraction,
      },
      updateInteractiveControls: async () => undefined,
    });
    await withService(
      {
        prefix: "orkestrator-native-projection-intents-",
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        await service.ensureSession({
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "env-env-1:tab-1",
        });
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-1",
        };
        const blocked = await service.getProjection(identity);
        expect(blocked).toMatchObject({
          turn: { phase: "blocked" },
          interactions: [{ id: "interaction-0", kind: "permission" }],
        });

        await service.updateProjectionControls({
          ...identity,
          update: { modelId: "gpt-5", fastMode: true },
        });
        expect(stub.updateInteractiveControls).toHaveBeenCalledWith("provider-session", {
          modelId: "gpt-5",
          fastMode: true,
        });

        const resolution = {
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          interactionId: "interaction-0",
          sessionId: "provider-session",
          action: "decline" as const,
          resolvedAt: 10_001,
        };
        await service.resolveProjectionInteraction({
          ...identity,
          interactionId: "interaction-0",
          resolution,
        });
        expect(resolveInteraction).toHaveBeenCalledWith(
          "provider-session",
          "interaction-0",
          resolution,
        );

        await service.stopProjectionSession(identity);
        expect(stub.abort).toHaveBeenCalledWith("provider-session");
      },
    );
  });

  test.each([
    { name: "only non-blocking requests", blocking: [false], phase: "running" },
    { name: "mixed blocking requests", blocking: [false, true], phase: "blocked" },
  ] as const)("derives session activity from $name", async ({ blocking, phase }) => {
    const snapshot = pendingInteractionSnapshot(
      10_000,
      blocking.map(() => "question" as const),
    );
    snapshot.requests.forEach((request, index) => {
      request.blocking = blocking[index];
    });
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => ({ status: "running", messages: [] }),
      interactions: {
        listPendingInteractions: async () => snapshot,
        resolveInteraction: async () => ({
          result: "applied",
          interactionId: "unused",
          sessionId: "provider-session",
          revision: 2,
        }),
      },
    });
    await withService(
      {
        prefix: `orkestrator-native-projection-${phase}-`,
        provider: async () => stub.provider,
      },
      async ({ service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: `tab-${phase}`,
        };
        await service.ensureSession(identity);
        const projection = await service.getProjection(identity);
        expect(projection?.turn.phase).toBe(phase);
        expect(projection?.interactions).toHaveLength(blocking.length);
      },
    );
  });

  test("withdraws a stopped environment's dead requests in a new announced revision", async () => {
    // C11: the bridge died with the container, but a failed read keeps the
    // last projection, so the public CLI and coordinator saw `pending`.
    let bridge: "up" | "down" | "restarted" = "up";
    const gone = () => {
      throw new ProviderUnavailableError("bridge is not running");
    };
    const stub = createProviderStub("codex", {
      interactiveSnapshot: async () => {
        if (bridge === "down") gone();
        return { status: "running", messages: [] };
      },
      interactions: {
        listPendingInteractions: async () => {
          if (bridge === "down") gone();
          // Parked requests do not survive a bridge restart.
          return bridge === "up"
            ? pendingInteractionSnapshot(10_000, ["permission"])
            : { version: AGENT_INTERACTION_CONTRACT_VERSION, revision: 0, requests: [] };
        },
        resolveInteraction: async () => ({
          result: "stale",
          interactionId: "interaction-0",
          sessionId: "provider-session",
          revision: 1,
        }),
      },
    });
    await withService(
      { prefix: "orkestrator-native-stop-withdraw-", provider: async () => stub.provider },
      async ({ storage, service }) => {
        await addEnvironment(storage, { id: "env-2", worktreePath: "/tmp/env-2" });
        const stopped = {
          environmentId: "env-1",
          agent: "codex" as const,
          logicalSessionKey: "env-env-1:tab-1",
        };
        const other = {
          environmentId: "env-2",
          agent: "codex" as const,
          logicalSessionKey: "env-env-2:tab-1",
        };
        await service.ensureSession(stopped);
        await service.ensureSession(other);
        expect((await service.getProjection(stopped))?.interactions).toHaveLength(1);
        expect((await service.getProjection(other))?.interactions).toHaveLength(1);

        bridge = "down";
        const stale = await service.getProjection(stopped);
        expect(stale?.connection).toBe("error");
        expect(stale?.interactions.map((request) => request.state)).toEqual(["pending"]);
        expect(await service.sessionPendingInteractions(stopped)).toHaveLength(1);

        const announced: Array<{ resource: string; id: string }> = [];
        const unsubscribe = storage.addResourceChangeListener((change) => {
          announced.push({ resource: change.resource, id: change.id });
        });
        try {
          service.withdrawEnvironmentInteractions("env-1");
        } finally {
          unsubscribe();
        }

        const withdrawn = service.cachedProjectionSnapshot("env-1", "codex", "env-env-1:tab-1");
        expect(withdrawn?.interactions).toEqual([]);
        expect(withdrawn!.revision).toBeGreaterThan(stale!.revision);
        expect(withdrawn?.connection).toBe("error");
        expect(announced).toContainEqual({ resource: "native-agent-session", id: "env-1" });
        expect(announced.some((change) => change.id === "env-2")).toBe(false);
        // Another environment's request is still live and still listed.
        expect(
          service.cachedProjectionSnapshot("env-2", "codex", "env-env-2:tab-1")?.interactions,
        ).toHaveLength(1);

        // Nothing read while stopped brings it back.
        expect((await service.getProjection(stopped))?.interactions).toEqual([]);
        expect(await service.sessionPendingInteractions(stopped)).toEqual([]);

        // Nor does the session reattaching on the next start.
        bridge = "restarted";
        const reattached = await service.getProjection(stopped);
        expect(reattached?.connection).toBe("connected");
        expect(reattached?.interactions).toEqual([]);
      },
    );
  });

  for (const initial of ["pending", "empty", "absent"] as const) {
    for (const representation of [undefined, "sync-v1"] as const) {
      test(`stop fences a refresh with ${initial} projection (${representation ?? "legacy"})`, async () => {
        let pending = initial === "pending";
        let interactionsRead = false;
        let hold: Promise<void> | null = null;
        let release!: () => void;
        let snapshotHeld = false;
        const stub = createProviderStub("codex", {
          interactiveSnapshot: async () => {
            if (hold) {
              snapshotHeld = true;
              await hold;
            }
            return { status: "running", messages: [] };
          },
          interactions: {
            listPendingInteractions: async () => {
              interactionsRead = true;
              return pendingInteractionSnapshot(10_000, pending ? ["permission"] : []);
            },
            resolveInteraction: async () => ({
              result: "stale",
              interactionId: "interaction-0",
              sessionId: "provider-session",
              revision: 1,
            }),
          },
        });
        await withService(
          {
            prefix: "orkestrator-native-stop-withdraw-fence-",
            provider: async () => stub.provider,
          },
          async ({ service }) => {
            const identity = {
              representation,
              environmentId: "env-1",
              agent: "codex" as const,
              logicalSessionKey: "env-env-1:tab-1",
            };
            await service.ensureSession(identity);
            if (initial !== "absent") {
              expect((await service.getProjection(identity))?.interactions).toHaveLength(
                initial === "pending" ? 1 : 0,
              );
            }
            pending = true;
            interactionsRead = false;

            hold = new Promise<void>((resolve) => {
              release = resolve;
            });
            const inFlight = service.getProjection(identity);
            await waitForCondition(() => snapshotHeld && interactionsRead);
            service.withdrawEnvironmentInteractions("env-1");
            release();

            const refreshed = await inFlight;
            if (initial !== "absent") expect(refreshed?.interactions).toEqual([]);
            expect(
              service.cachedProjectionSnapshot("env-1", "codex", "env-env-1:tab-1")?.interactions ??
                [],
            ).toEqual([]);
          },
        );
      });
    }
  }

  for (const overlapping of [false, true]) {
    test(`stop evicts pending reads without a projection (overlapping=${overlapping})`, async () => {
      let offline = false;
      let readEntered = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stub = createProviderStub("codex", {
        interactions: {
          listPendingInteractions: async () => {
            if (offline) throw new ProviderUnavailableError("stopped");
            readEntered = true;
            if (overlapping) await held;
            return pendingInteractionSnapshot(10_000, ["permission"]);
          },
          resolveInteraction: async () => ({
            result: "stale",
            interactionId: "interaction-0",
            sessionId: "provider-session",
            revision: 1,
          }),
        },
      });
      await withService(
        { prefix: "orkestrator-stop-pending-only-", provider: async () => stub.provider },
        async ({ service }) => {
          const identity = {
            environmentId: "env-1",
            agent: "codex" as const,
            logicalSessionKey: "tab-1",
          };
          await service.ensureSession(identity);
          const reading = service.sessionPendingInteractions(identity);
          if (overlapping) await waitForCondition(() => readEntered);
          else expect(await reading).toHaveLength(1);
          expect(service.cachedProjectionSnapshot("env-1", "codex", "tab-1")).toBeNull();
          service.withdrawEnvironmentInteractions("env-1");
          offline = true;
          release();
          if (overlapping) expect(await reading).toBeNull();
          expect(await service.sessionPendingInteractions(identity)).toBeNull();
        },
      );
    });
  }

  test("invalidates a missing session through the status fallback", async () => {
    const { provider, status } = createProviderStub("codex", {
      status: async () => "missing",
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-status-fallback-",
        provider: async () => provider,
      },
      async ({ storage, service }) => {
        const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-missing",
        });

        await service.reconcileAgentActivity();

        expect(status).toHaveBeenCalledWith("provider-missing");
        expect(await storage.getNativeAgentSession(key)).toBeNull();
      },
    );
  });

  test("recreates a cached provider after an activity read failure", async () => {
    const stale = createProviderStub("codex", {
      activity: async () => {
        throw new ProviderUnavailableError("bridge stopped");
      },
    });
    const recovered = createProviderStub("codex", {
      activity: async () => "working",
    });
    const providerFactory = mock(async () =>
      providerFactory.mock.calls.length === 1 ? stale.provider : recovered.provider,
    );
    let clock = 1_000;
    await withService(
      {
        prefix: "orkestrator-native-activity-recover-",
        provider: providerFactory,
        now: () => clock,
      },
      async ({ storage, service }) => {
        const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });
        const originalWarn = console.warn;
        console.warn = () => undefined;
        try {
          await service.reconcileAgentActivity();
          // Evicted, but deliberately not disposed: this provider may still be
          // carrying a prompt the user is waiting on, and disposing it aborts
          // every request it has in flight.
          expect(stale.dispose).not.toHaveBeenCalled();
          expect(collaborators(service).providerRegistry.stateForTesting().providers.size).toBe(0);

          clock += 2_000;
          await service.reconcileAgentActivity();
        } finally {
          console.warn = originalWarn;
        }

        expect(providerFactory).toHaveBeenCalledTimes(2);
        expect(recovered.activity).toHaveBeenCalledWith("provider-1");
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          agentActivitySources: { "native-agent": { state: "working" } },
        });
      },
    );
  });

  test("isolates a failed agent group and leaves its previous projection intact", async () => {
    const codex = createProviderStub("codex", { activity: async () => "working" });
    const claude = createProviderStub("claude", {
      activity: async () => {
        throw new ProviderUnavailableError("offline");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-partial-",
        provider: async (input) => (input.agent === "codex" ? codex.provider : claude.provider),
      },
      async ({ storage, service }) => {
        for (const agent of ["codex", "claude"] as const) {
          const key = nativeAgentSessionStorageKey("env-1", agent, `${agent}-tab`);
          await storage.adoptNativeAgentSession({
            key,
            environmentId: "env-1",
            agent,
            logicalSessionKey: `${agent}-tab`,
            providerSessionId: `${agent}-provider`,
          });
        }
        await storage.setEnvironmentAgentActivity(
          "env-1",
          "waiting",
          new Date().toISOString(),
          "native-agent",
        );
        const before = (await storage.getEnvironment("env-1"))!.agentActivitySources?.[
          "native-agent"
        ];
        const originalWarn = console.warn;
        console.warn = () => undefined;
        try {
          await service.reconcileAgentActivity();
        } finally {
          console.warn = originalWarn;
        }

        expect(codex.activity).toHaveBeenCalledTimes(1);
        expect(claude.activity).toHaveBeenCalledTimes(1);
        expect(
          (await storage.getEnvironment("env-1"))!.agentActivitySources?.["native-agent"],
        ).toEqual(before);
      },
    );
  });

  test("leaves a provider installed by concurrent work in the cache after a failed read", async () => {
    let serviceRef: NativeAgentService | undefined;
    const replacement = createProviderStub("codex", {
      activity: async () => "idle",
    });
    const failing = createProviderStub("codex", {
      activity: async () => {
        // Stand in for a tab that resolved a fresh provider while this
        // read-only sweep was in flight.
        collaborators(serviceRef!)
          .providerRegistry.stateForTesting()
          .providers.set("env-1\u0000codex", replacement.provider);
        throw new ProviderUnavailableError("bridge stopped");
      },
    });
    await withService(
      {
        prefix: "orkestrator-native-activity-evict-identity-",
        provider: async () => failing.provider,
      },
      async ({ storage, service }) => {
        serviceRef = service;
        const key = nativeAgentSessionStorageKey("env-1", "codex", "tab-1");
        await storage.adoptNativeAgentSession({
          key,
          environmentId: "env-1",
          agent: "codex",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });

        await captureWarnings(async () => {
          await service.reconcileAgentActivity();
        });

        expect(collaborators(service).providerRegistry.cached("env-1\u0000codex")).toBe(
          replacement.provider,
        );
        expect(replacement.dispose).not.toHaveBeenCalled();
        expect(failing.dispose).not.toHaveBeenCalled();
      },
    );
  });

  test("retires a stale projection once the last native session is gone", async () => {
    const providerFactory = mock(async () => createProviderStub("codex").provider);
    await withService(
      {
        prefix: "orkestrator-native-activity-last-session-",
        provider: providerFactory,
      },
      async ({ storage, service }) => {
        await storage.setEnvironmentAgentActivity(
          "env-1",
          "working",
          new Date().toISOString(),
          "native-agent",
        );

        await service.reconcileAgentActivity();

        // The tab that owned the only session was closed; without this the
        // sidebar spins forever on an agent that no longer exists.
        expect(providerFactory).not.toHaveBeenCalled();
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          agentActivitySources: { "native-agent": { state: "idle" } },
        });
      },
    );
  });

  test("retains startup model and effort while launch is starting and after failure", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-startup-meta-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage, {
      defaultAgent: "codex",
      codexMode: "native",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-startup",
      initialReasoningEffort: "high",
      initialPrompt: "Start",
    });
    let signalCreateEntered: (() => void) | undefined;
    const createEntered = new Promise<void>((resolve) => {
      signalCreateEntered = resolve;
    });
    let rejectCreate: ((error: Error) => void) | undefined;
    const createSession = mock(async () => {
      signalCreateEntered?.();
      return new Promise<string>((_resolve, reject) => {
        rejectCreate = reject;
      });
    });
    const provider = {
      agent: "codex",
      createSession,
      registerSession: () => undefined,
      send: async () => undefined,
      status: async () => "idle",
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    try {
      const initializing = service.init();
      await createEntered;
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        startupAgentSession: {
          status: "starting",
          model: "gpt-startup",
          reasoningEffort: "high",
        },
      });

      rejectCreate?.(new Error("provider unavailable"));
      await initializing;
      expect(await storage.getEnvironment("env-1")).toMatchObject({
        pendingAgentLaunch: true,
        initialAgentModel: "gpt-startup",
        initialReasoningEffort: "high",
        startupAgentSession: {
          status: "error",
          model: "gpt-startup",
          reasoningEffort: "high",
        },
      });
    } finally {
      rejectCreate?.(new Error("test cleanup"));
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("fences cached provider status and send when deletion starts", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-native-delete-"));
    const storage = await createStorage(dataDir);
    await addEnvironment(storage);
    let deleteDuringStatus = false;
    const status = mock(async () => {
      if (deleteDuringStatus) {
        deleteDuringStatus = false;
        await storage.updateEnvironment("env-1", {
          deletionRequestedAt: new Date().toISOString(),
        });
      }
      return "idle" as const;
    });
    const send = mock(async () => undefined);
    const provider = {
      agent: "codex",
      createSession: async () => "provider-session",
      registerSession: () => undefined,
      send,
      status,
      messages: async () => [],
      structured: async () => null,
      abort: async () => undefined,
    } as AgentSessionProvider;
    const service = new NativeAgentService(
      storage,
      async <T>(): Promise<T> => {
        throw new Error("unused");
      },
      { provider: async () => provider },
    );
    const input = {
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "env-env-1:tab-1",
    };
    try {
      await service.ensureSession(input);
      deleteDuringStatus = true;
      await expect(service.ensureSession(input)).rejects.toThrow("unavailable");
      await expect(
        service.dispatchPrompt({
          ...input,
          prompt: "must not run",
          requestId: "request-1",
        }),
      ).rejects.toThrow("unavailable");
      expect(send).not.toHaveBeenCalled();
    } finally {
      await service.shutdown();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
