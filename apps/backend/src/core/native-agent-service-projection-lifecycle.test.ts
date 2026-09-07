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
  internals,
  pendingInteractionSnapshot,
  withService,
} from "./native-agent-service-projection-test-support.js";

describe("NativeAgentService projection lifecycle", () => {
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
          expect(internals(service).providers.size).toBe(0);

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
        internals(serviceRef!).providers.set("env-1\u0000codex", replacement.provider);
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

        expect(internals(service).providers.get("env-1\u0000codex")).toBe(replacement.provider);
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
