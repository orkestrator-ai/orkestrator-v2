/**
 * The unread reason for a turn whose end no per-session edge saw: a bridge that
 * died under it, and a backend that restarted across it. A turn cut short rings
 * `agent_failed`; a stop someone asked for, and a turn nothing says was cut
 * short, keep `agent_finished`.
 *
 * The bridge platforms run against a real local HTTP server through the real
 * provider and the real no-bridge path, so "dies" means its port stops
 * answering and the peek stops finding it. OpenCode's provider reads an SDK
 * client, so it is a stub whose bridge is noted absent. A restart is a second
 * service over the same storage, which keeps only what is durable.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import {
  ProviderUnavailableError,
  TURN_STOPPED_BY_USER_MESSAGE,
} from "./agent-provider-contract.js";
import type { ProviderDispatchStatus } from "./agent-provider-contract.js";
import type { Environment } from "./models.js";
import { RUNTIME_STOP_REQUEST_WINDOW_MS } from "./native-agent-launch-activity-reconciler.js";
import type { NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import {
  captureWarnings,
  createProviderStub,
  withService,
} from "./native-agent-service-projection-test-support.js";
import { collaborators } from "./native-agent-service-test-collaborators.js";
import { NativeAgentService } from "./native-agent-service.js";
import type { StorageService } from "./storage.js";

const key = (agent: BuildPipelineAgent, tab = "tab-1") =>
  nativeAgentSessionStorageKey("env-1", agent, tab);

const HTTP_PLATFORMS = ["claude", "codex", "cursor", "grok", "pi"] as const;

async function adopt(
  storage: StorageService,
  agent: BuildPipelineAgent,
  { tab = "tab-1", requestId }: { tab?: string; requestId?: string } = {},
) {
  await storage.adoptNativeAgentSession({
    key: key(agent, tab),
    environmentId: "env-1",
    agent,
    logicalSessionKey: tab,
    providerSessionId: `provider-${tab}`,
  });
  if (requestId) {
    await storage.dispatchNativeAgentPromptOnce(key(agent, tab), requestId, async () => {});
  }
}

/** A bridge on a real port, answering only its no-touch routes. */
function fakeBridge(agent: BuildPipelineAgent) {
  let observation: Record<string, unknown> = { activity: "working" };
  let dispatch: ProviderDispatchStatus = "dispatched";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/sessions/activity") {
        const { sessionIds } = (await request.json()) as { sessionIds: string[] };
        return Response.json({
          version: 1,
          observations: Object.fromEntries(sessionIds.map((id) => [id, observation])),
        });
      }
      if (pathname.endsWith("/activity")) return Response.json(observation);
      if (pathname.endsWith("/dispatch")) return Response.json({ dispatch });
      return new Response("not found", { status: 404 });
    },
  });
  let alive = true;
  return {
    agent,
    answer: (next: Record<string, unknown>) => {
      observation = next;
    },
    answerDispatch: (next: ProviderDispatchStatus) => {
      dispatch = next;
    },
    die: async () => {
      alive = false;
      await server.stop(true);
    },
    /** `peek_local_agent_bridge`: finds a live bridge and never starts one. */
    invoke: async <T>(command: string): Promise<T> => {
      if (command !== "peek_local_agent_bridge") throw new Error(`Unexpected: ${command}`);
      return (alive ? { port: server.port, authToken: "token" } : null) as T;
    },
  };
}

/** Sweep past the group's back-off until it has been answered. */
async function sweepPastBackoff(
  service: NativeAgentService,
  agent: BuildPipelineAgent,
  advance: (toAtLeast: number) => void,
) {
  await service.reconcileAgentActivity();
  const retryAt = collaborators(service)
    .launches.forTesting()
    .activityRetryAt.get(`env-1\0${agent}`);
  if (retryAt !== undefined) {
    advance(retryAt);
    await service.reconcileAgentActivity();
  }
}

/** One watched turn whose bridge dies; answers the reasons rung afterwards. */
async function bridgeDiesMidTurn(
  agent: BuildPipelineAgent,
  options: {
    prepare?: (storage: StorageService, service: NativeAgentService) => Promise<void>;
    before?: Record<string, unknown>;
  } = {},
) {
  const bridge = fakeBridge(agent);
  let now = Date.now();
  let reasons: unknown[] = [];
  let unread = null as Environment | null;
  await captureWarnings(() =>
    withService(
      {
        prefix: `ork-bridge-dies-${agent}-`,
        invoke: bridge.invoke,
        now: () => now,
      },
      async ({ storage, service }) => {
        await adopt(storage, agent, { requestId: "req-1" });
        if (options.before) bridge.answer(options.before);
        await service.reconcileAgentActivity();
        const completions = spyOn(storage, "recordEnvironmentSessionCompletion");
        await options.prepare?.(storage, service);
        await bridge.die();
        await sweepPastBackoff(service, agent, (to) => {
          now = Math.max(now, to);
        });
        await service.reconcileAgentActivity();
        reasons = completions.mock.calls.map((call) => call[2]);
        unread = await storage.getEnvironment("env-1");
      },
    ),
  );
  return { reasons, unread };
}

describe("a bridge that dies mid-turn", () => {
  for (const agent of HTTP_PLATFORMS) {
    test(`${agent}: rings agent_failed, once`, async () => {
      const { reasons, unread } = await bridgeDiesMidTurn(agent);
      expect(reasons).toEqual(["agent_failed"]);
      expect(unread).toMatchObject({ hasUnreadWork: true, unreadReason: "agent_failed" });
    });
  }

  test("opencode: a bridge known absent rings agent_failed", async () => {
    const { provider } = createProviderStub("opencode", { activity: async () => "working" });
    await withService(
      { prefix: "ork-bridge-dies-opencode-", provider: async () => provider },
      async ({ storage, service }) => {
        await adopt(storage, "opencode", { requestId: "req-1" });
        await service.reconcileAgentActivity();
        collaborators(service).providerRegistry.markBridgeAbsent(`env-1\0opencode`);
        await service.reconcileAgentActivity();
        expect(await storage.getEnvironment("env-1")).toMatchObject({
          agentActivityState: "idle",
          unreadReason: "agent_failed",
        });
      },
    );
  });

  test("a turn the user had already stopped keeps agent_finished", async () => {
    const { reasons } = await bridgeDiesMidTurn("codex", {
      prepare: async (storage) => {
        await storage.recordNativeAgentTurnInterrupt(key("codex"), "provider-tab-1", "req-1");
      },
    });
    expect(reasons).toEqual(["agent_finished"]);
  });

  test("a stop the backend was asked for keeps agent_finished", async () => {
    const { reasons } = await bridgeDiesMidTurn("codex", {
      prepare: async (_storage, service) => service.runtimeStopRequested("env-1"),
    });
    expect(reasons).toEqual(["agent_finished"]);
  });

  test("a stop request does not excuse a crash after its window", async () => {
    const bridge = fakeBridge("codex");
    let now = Date.now();
    await captureWarnings(() =>
      withService(
        { prefix: "ork-stop-window-", invoke: bridge.invoke, now: () => now },
        async ({ storage, service }) => {
          await adopt(storage, "codex", { requestId: "req-1" });
          await service.reconcileAgentActivity();
          await service.runtimeStopRequested("env-1");
          now += RUNTIME_STOP_REQUEST_WINDOW_MS;
          await bridge.die();
          await sweepPastBackoff(service, "codex", (to) => {
            now = Math.max(now, to);
          });
          expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_failed");
        },
      ),
    );
  });

  test("a turn already released to background work is not announced again", async () => {
    const { reasons } = await bridgeDiesMidTurn("claude", {
      before: { activity: "working", readyForInput: true, completionPending: false },
    });
    expect(reasons).toEqual([]);
  });

  test("a session that was idle when its bridge died rings nothing", async () => {
    const { reasons, unread } = await bridgeDiesMidTurn("codex", {
      before: { activity: "idle" },
    });
    expect(reasons).toEqual([]);
    expect(unread?.hasUnreadWork).not.toBe(true);
  });
});

describe("request-scoped runtime stops", () => {
  for (const replacement of ["new-request", "new-bridge"] as const) {
    test(`a ${replacement} crash within the stop window is a failure`, async () => {
      let state: "working" | "idle" = "working";
      const { provider } = createProviderStub("codex", { activity: async () => state });
      await withService(
        { prefix: "ork-stop-replacement-", provider: async () => provider },
        async ({ storage, service }) => {
          await adopt(storage, "codex", { requestId: "req-1" });
          await service.reconcileAgentActivity();
          await service.runtimeStopRequested("env-1");
          if (replacement === "new-request") {
            state = "idle";
            await service.reconcileAgentActivity();
            await storage.dispatchNativeAgentPromptOnce(key("codex"), "req-2", async () => {});
            state = "working";
            await service.reconcileAgentActivity();
          } else {
            collaborators(service).providerRegistry.cache(
              `env-1\0codex`,
              provider,
              "replacement-connection",
            );
          }
          collaborators(service).providerRegistry.markBridgeAbsent(`env-1\0codex`);
          await service.reconcileAgentActivity();
          expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_failed");
        },
      );
    });
  }

  test("stopping one provider does not exempt a sibling provider crash", async () => {
    const { provider: claude } = createProviderStub("claude", { activity: async () => "working" });
    const { provider: codex } = createProviderStub("codex", { activity: async () => "working" });
    await withService(
      {
        prefix: "ork-stop-sibling-",
        provider: async (input) => (input.agent === "claude" ? claude : codex),
      },
      async ({ storage, service }) => {
        await adopt(storage, "claude", { requestId: "req-claude" });
        await adopt(storage, "codex", { requestId: "req-codex" });
        await service.reconcileAgentActivity();
        await service.runtimeStopRequested("env-1", "claude");
        collaborators(service).providerRegistry.markBridgeAbsent(`env-1\0codex`);
        await service.reconcileAgentActivity();
        expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_failed");
      },
    );
  });
});

describe("a bridge replaced under a watched turn", () => {
  for (const [dispatch, reason] of [
    ["lost", "agent_failed"],
    ["dispatched", "agent_finished"],
    ["unknown", "agent_finished"],
  ] as const) {
    test(`a replacement answering ${dispatch} rings ${reason}`, async () => {
      const bridge = fakeBridge("pi");
      await withService(
        { prefix: "ork-bridge-replaced-", invoke: bridge.invoke },
        async ({ storage, service }) => {
          await adopt(storage, "pi", { requestId: "req-1" });
          await service.reconcileAgentActivity();
          bridge.answer({ activity: "idle" });
          bridge.answerDispatch(dispatch);
          await service.reconcileAgentActivity();
          expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe(reason);
          await bridge.die();
        },
      );
    });
  }

  for (const persistedOutcome of [false, true]) {
    test(`claude: a successful restored claim stays finished (outcome=${persistedOutcome})`, async () => {
      const bridge = fakeBridge("claude");
      try {
        await withService(
          { prefix: "ork-claude-restored-success-", invoke: bridge.invoke },
          async ({ storage, service }) => {
            await adopt(storage, "claude", { requestId: "req-1" });
            await service.reconcileAgentActivity();
            if (persistedOutcome)
              await storage.recordNativeAgentTurnOutcome(key("claude"), "provider-tab-1", {
                requestId: "req-1",
                outcome: "completed",
                observedAt: new Date().toISOString(),
              });
            bridge.answer({ activity: "idle" });
            bridge.answerDispatch("lost");
            await service.reconcileAgentActivity();
            expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_finished");
          },
        );
      } finally {
        await bridge.die();
      }
    });
  }

  test("opencode: a turn end does not read the transcript for a lost request", async () => {
    let activity: "working" | "idle" = "working";
    const dispatchStatus = mock(async () => "lost" as const);
    const { provider } = createProviderStub("opencode", {
      activity: async () => activity,
      dispatchStatus,
    });
    provider.turnTerminalError = async () => null;
    await withService(
      { prefix: "ork-opencode-no-lost-read-", provider: async () => provider },
      async ({ storage, service }) => {
        await adopt(storage, "opencode", { requestId: "req-1" });
        await service.reconcileAgentActivity();
        activity = "idle";
        await service.reconcileAgentActivity();
        expect(dispatchStatus).not.toHaveBeenCalled();
        expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_finished");
      },
    );
  });

  test("a failed dispatch read keeps the idle edge and rings agent_finished", async () => {
    let activity: "working" | "idle" = "working";
    const { provider } = createProviderStub("pi", {
      activity: async () => activity,
      dispatchStatus: async () => {
        throw new Error("journal unreadable");
      },
    });
    await withService(
      { prefix: "ork-dispatch-read-fails-", provider: async () => provider },
      async ({ storage, service }) => {
        await adopt(storage, "pi", { requestId: "req-1" });
        await service.reconcileAgentActivity();
        activity = "idle";
        await service.reconcileAgentActivity();
        expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_finished");
      },
    );
  });
});

describe("a backend restart across a turn", () => {
  /**
   * Run `first` on a service, drop it, and sweep twice on a fresh one over the
   * same storage. Answers the reasons the fresh service rang, in order.
   */
  async function restartAcross(
    agent: BuildPipelineAgent,
    provider: NativeAgentRuntimeProvider,
    first: (storage: StorageService) => Promise<void>,
    options: {
      environment?: Record<string, unknown>;
      afterRestart?: (restarted: NativeAgentService) => void;
      duringRestart?: (storage: StorageService) => Promise<void>;
    } = {},
  ) {
    let reasons: unknown[] = [];
    let environment = null as Environment | null;
    await withService(
      {
        prefix: `ork-restart-${agent}-`,
        provider: async () => provider,
        ...(options.environment ? { environment: options.environment } : {}),
      },
      async ({ storage, service }) => {
        await first(storage);
        await service.reconcileAgentActivity();
        expect(
          (await storage.getEnvironment("env-1"))?.agentActivitySources?.["native-agent"],
        ).toMatchObject({ state: "working" });
        await service.shutdown();
        await options.duringRestart?.(storage);
        const restarted = new NativeAgentService(
          storage,
          async () => {
            throw new Error("Unexpected command");
          },
          { provider: async () => provider },
        );
        try {
          options.afterRestart?.(restarted);
          const completions = spyOn(storage, "recordEnvironmentSessionCompletion");
          await restarted.reconcileAgentActivity();
          await restarted.reconcileAgentActivity();
          reasons = completions.mock.calls.map((call) => call[2]);
          completions.mockRestore();
          environment = await storage.getEnvironment("env-1");
        } finally {
          await restarted.shutdown();
        }
      },
    );
    return { reasons, environment };
  }

  /** A provider whose one session reads `working` until `end` is called. */
  function endingProvider(agent: BuildPipelineAgent, ended: { turnFailed?: true }) {
    let observation: { state: "working" | "idle"; turnFailed?: true } = { state: "working" };
    const { provider } = createProviderStub(agent);
    provider.observeActivity = async () => observation;
    return {
      provider,
      end: () => {
        observation = { state: "idle", ...ended };
      },
    };
  }

  for (const agent of [...HTTP_PLATFORMS, "opencode"] as const) {
    test(`${agent}: a turn that failed across the restart rings agent_failed`, async () => {
      const { provider, end } = endingProvider(agent, { turnFailed: true });
      const { reasons, environment } = await restartAcross(
        agent,
        provider,
        (storage) => adopt(storage, agent),
        { duringRestart: async () => end() },
      );
      expect(reasons).toEqual(["agent_failed"]);
      // The aggregate settled too, and did not write over the failure.
      expect(environment).toMatchObject({
        agentActivityState: "idle",
        hasUnreadWork: true,
        unreadReason: "agent_failed",
      });
    });
  }

  test("the aggregate still announces a turn that finished across the restart", async () => {
    const { provider, end } = endingProvider("codex", {});
    const { reasons, environment } = await restartAcross(
      "codex",
      provider,
      (storage) => adopt(storage, "codex", { requestId: "req-1" }),
      { duringRestart: async () => end() },
    );
    expect(reasons).toEqual([]);
    expect(environment).toMatchObject({
      agentActivityState: "idle",
      hasUnreadWork: true,
      unreadReason: "agent_finished",
    });
  });

  for (const [terminal, expected] of [
    ["Provider returned 401", ["agent_failed"]],
    [TURN_STOPPED_BY_USER_MESSAGE, []],
    [null, []],
  ] as const) {
    test(`opencode: an outcome of ${JSON.stringify(terminal)} rings ${JSON.stringify(expected)}`, async () => {
      let activity: "working" | "idle" = "working";
      const { provider } = createProviderStub("opencode", { activity: async () => activity });
      provider.turnTerminalError = async () => terminal;
      const { reasons } = await restartAcross(
        "opencode",
        provider,
        (storage) => adopt(storage, "opencode", { requestId: "req-1" }),
        {
          duringRestart: async () => {
            activity = "idle";
          },
        },
      );
      expect(reasons).toEqual([...expected]);
    });
  }

  test("an unreadable outcome backs off, then rings agent_failed once", async () => {
    let now = Date.now();
    let activity: "working" | "idle" = "working";
    let readable = false;
    const { provider } = createProviderStub("opencode", { activity: async () => activity });
    provider.turnTerminalError = async () => {
      if (!readable) throw new ProviderUnavailableError("Outcome settling");
      return "Provider returned 401";
    };
    await captureWarnings(() =>
      withService(
        { prefix: "ork-restart-outcome-retry-", provider: async () => provider, now: () => now },
        async ({ storage, service }) => {
          await adopt(storage, "opencode", { requestId: "req-1" });
          await service.reconcileAgentActivity();
          await service.shutdown();
          activity = "idle";
          const restarted = new NativeAgentService(
            storage,
            async () => {
              throw new Error("Unexpected command");
            },
            { provider: async () => provider, now: () => now },
          );
          try {
            const completions = spyOn(storage, "recordEnvironmentSessionCompletion");
            await restarted.reconcileAgentActivity();
            expect(completions).not.toHaveBeenCalled();
            // Withheld, not announced as finished while the answer is unknown.
            expect((await storage.getEnvironment("env-1"))?.agentActivityState).toBe("working");
            const retryAt = collaborators(restarted)
              .launches.forTesting()
              .activityRetryAt.get(`env-1\0opencode`)!;
            expect(retryAt).toBeGreaterThan(now);
            readable = true;
            now = retryAt;
            await restarted.reconcileAgentActivity();
            await restarted.reconcileAgentActivity();
            expect(completions.mock.calls.map((call) => call[2])).toEqual(["agent_failed"]);
            expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_failed");
            completions.mockRestore();
          } finally {
            await restarted.shutdown();
          }
        },
      ),
    );
  });

  for (const agent of ["cursor", "grok", "pi"] as const) {
    test(`${agent}: a restarted bridge's lost request rings agent_failed`, async () => {
      const { provider, end } = endingProvider(agent, {});
      provider.dispatchStatus = async () => "lost";
      const { reasons } = await restartAcross(
        agent,
        provider,
        (storage) => adopt(storage, agent, { requestId: "req-1" }),
        { duringRestart: async () => end() },
      );
      expect(reasons).toEqual(["agent_failed"]);
    });
  }

  test("a stale failure in a durably idle environment rings nothing", async () => {
    // The bridge still reports yesterday's error; nothing was running.
    const { provider } = createProviderStub("codex");
    provider.observeActivity = async () => ({ state: "idle", turnFailed: true });
    await withService(
      { prefix: "ork-restart-stale-", provider: async () => provider },
      async ({ storage, service }) => {
        await adopt(storage, "codex", { requestId: "req-1" });
        await service.reconcileAgentActivity();
        await service.reconcileAgentActivity();
        expect((await storage.getEnvironment("env-1"))?.hasUnreadWork).not.toBe(true);
      },
    );
  });

  test("a sibling still working does not hide the failed session", async () => {
    let finished = false;
    const { provider } = createProviderStub("codex");
    provider.observeActivity = async (id) => {
      if (!finished) return { state: "working" };
      return id === "provider-tab-1" ? { state: "idle", turnFailed: true } : { state: "working" };
    };
    const { reasons } = await restartAcross(
      "codex",
      provider,
      async (storage) => {
        await adopt(storage, "codex", { tab: "tab-1", requestId: "req-1" });
        await adopt(storage, "codex", { tab: "tab-2", requestId: "req-2" });
      },
      {
        duringRestart: async () => {
          finished = true;
        },
      },
    );
    expect(reasons).toEqual(["agent_failed"]);
  });

  test("a tab opened after the restart settled inherits nothing", async () => {
    let activity: "working" | "idle" = "working";
    const { provider } = createProviderStub("codex");
    provider.observeActivity = async (id) =>
      id === "provider-tab-2" ? { state: "idle", turnFailed: true } : { state: activity };
    await withService(
      { prefix: "ork-restart-new-tab-", provider: async () => provider },
      async ({ storage, service }) => {
        await adopt(storage, "codex", { tab: "tab-1", requestId: "req-1" });
        await service.reconcileAgentActivity();
        await service.shutdown();
        const restarted = new NativeAgentService(
          storage,
          async () => {
            throw new Error("Unexpected command");
          },
          { provider: async () => provider },
        );
        try {
          await restarted.reconcileAgentActivity();
          const completions = spyOn(storage, "recordEnvironmentSessionCompletion");
          await adopt(storage, "codex", { tab: "tab-2", requestId: "req-2" });
          await restarted.reconcileAgentActivity();
          expect(completions).not.toHaveBeenCalled();
          completions.mockRestore();
        } finally {
          await restarted.shutdown();
        }
      },
    );
  });

  test("a session the bridge proves gone across the restart rings agent_failed", async () => {
    let missing = false;
    const { provider } = createProviderStub("codex");
    provider.observeActivity = async () => ({ state: missing ? "missing" : "working" });
    const { reasons } = await restartAcross(
      "codex",
      provider,
      (storage) => adopt(storage, "codex", { requestId: "req-1" }),
      {
        duringRestart: async () => {
          missing = true;
        },
      },
    );
    expect(reasons).toEqual(["agent_failed"]);
  });

  test("a dispatch without an active checkpoint is not proof of an unfinished turn", async () => {
    const { provider } = createProviderStub("codex");
    await withService(
      { prefix: "ork-restart-no-proof-", provider: async () => provider },
      async ({ storage, service }) => {
        await adopt(storage, "codex", { requestId: "req-1" });
        await storage.setEnvironmentAgentActivity(
          "env-1",
          "working",
          new Date().toISOString(),
          "native-agent",
        );
        await service.shutdown();
        const restarted = new NativeAgentService(
          storage,
          async () => {
            throw new Error("Unexpected command");
          },
          { provider: async () => provider },
        );
        try {
          collaborators(restarted).providerRegistry.markBridgeAbsent(`env-1\0codex`);
          await restarted.reconcileAgentActivity();
          expect((await storage.getEnvironment("env-1"))?.unreadReason).toBe("agent_finished");
        } finally {
          await restarted.shutdown();
        }
      },
    );
  });

  test("an acknowledged failure is not replayed while a sibling works, across repeated restarts", async () => {
    let failed = false;
    const { provider } = createProviderStub("codex");
    provider.observeActivity = async (id) =>
      failed && id === "provider-tab-1"
        ? { state: "idle", turnFailed: true }
        : { state: "working" };
    await withService(
      { prefix: "ork-stale-sibling-", provider: async () => provider },
      async ({ storage, service }) => {
        await adopt(storage, "codex", { requestId: "req-1" });
        await adopt(storage, "codex", { tab: "tab-2", requestId: "req-2" });
        await service.reconcileAgentActivity();
        failed = true;
        await service.reconcileAgentActivity();
        const token = (await storage.getEnvironment("env-1"))?.agentSessionCompletedAt;
        expect(token).toBeDefined();
        await storage.setEnvironmentUnread("env-1", false);
        await service.shutdown();
        for (let restart = 0; restart < 3; restart++) {
          const restarted = new NativeAgentService(
            storage,
            async () => {
              throw new Error("Unexpected command");
            },
            { provider: async () => provider },
          );
          try {
            await restarted.reconcileAgentActivity();
            await restarted.reconcileAgentActivity();
            expect(await storage.getEnvironment("env-1")).toMatchObject({
              agentActivityState: "working",
              hasUnreadWork: false,
              agentSessionCompletedAt: token,
            });
          } finally {
            await restarted.shutdown();
          }
        }
      },
    );
  });

  for (const missing of ["bridge", "session"] as const) {
    test(`a released root is settled across restart with a missing ${missing}`, async () => {
      let gone = false;
      const { provider } = createProviderStub("claude");
      provider.observeActivity = async () =>
        gone
          ? { state: "missing" }
          : {
              state: "working",
              readyForInput: true,
              completionPending: false,
            };
      await withService(
        { prefix: "ork-released-restart-", provider: async () => provider },
        async ({ storage, service }) => {
          await adopt(storage, "claude", { requestId: "req-1" });
          await service.reconcileAgentActivity();
          expect(
            (await storage.getNativeAgentSession(key("claude")))?.turnOutcomes,
          ).toBeUndefined();
          await storage.setEnvironmentUnread("env-1", false);
          const token = (await storage.getEnvironment("env-1"))?.agentSessionCompletedAt;
          await service.shutdown();
          gone = true;
          const restarted = new NativeAgentService(
            storage,
            async () => {
              throw new Error("Unexpected command");
            },
            { provider: async () => provider },
          );
          try {
            if (missing === "bridge")
              collaborators(restarted).providerRegistry.markBridgeAbsent(`env-1\0claude`);
            await restarted.reconcileAgentActivity();
            await restarted.reconcileAgentActivity();
            expect(await storage.getEnvironment("env-1")).toMatchObject({ hasUnreadWork: false });
            expect((await storage.getEnvironment("env-1"))?.agentSessionCompletedAt).toBe(token);
          } finally {
            await restarted.shutdown();
          }
        },
      );
    });
  }

  test("failure attention survives a sibling outcome retry before the aggregate commits", async () => {
    let now = Date.now();
    let ended = false;
    let readable = false;
    const { provider: failed } = createProviderStub("codex");
    failed.observeActivity = async () =>
      ended ? { state: "idle", turnFailed: true } : { state: "working" };
    const { provider: sibling } = createProviderStub("opencode", {
      activity: async () => (ended ? "idle" : "working"),
    });
    sibling.turnTerminalError = async () => {
      if (!readable) throw new ProviderUnavailableError("Outcome settling");
      return null;
    };
    const resolve = async (input: { agent: BuildPipelineAgent }) =>
      input.agent === "codex" ? failed : sibling;
    await captureWarnings(() =>
      withService(
        { prefix: "ork-sibling-retry-", provider: resolve, now: () => now },
        async ({ storage, service }) => {
          await adopt(storage, "codex", { requestId: "req-failed" });
          await adopt(storage, "opencode", { requestId: "req-sibling" });
          await service.reconcileAgentActivity();
          await service.shutdown();
          ended = true;
          const restarted = new NativeAgentService(
            storage,
            async () => {
              throw new Error("Unexpected command");
            },
            { provider: resolve, now: () => now },
          );
          try {
            await restarted.reconcileAgentActivity();
            expect(await storage.getEnvironment("env-1")).toMatchObject({
              agentActivityState: "working",
              unreadReason: "agent_failed",
            });
            now = collaborators(restarted)
              .launches.forTesting()
              .activityRetryAt.get(`env-1\0opencode`)!;
            readable = true;
            await restarted.reconcileAgentActivity();
            await restarted.reconcileAgentActivity();
            expect(await storage.getEnvironment("env-1")).toMatchObject({
              agentActivityState: "idle",
              unreadReason: "agent_failed",
            });
          } finally {
            await restarted.shutdown();
          }
        },
      ),
    );
  });

  describe("with its bridge gone", () => {
    /** The turn ran on the first service; the restarted one finds no bridge. */
    async function restartWithoutBridge(
      prepare: (storage: StorageService) => Promise<void>,
      options: { stopRequested?: boolean } = {},
    ) {
      const bridge = fakeBridge("codex");
      let reasons: unknown[] = [];
      let environment = null as Environment | null;
      await withService(
        { prefix: "ork-restart-no-bridge-", invoke: bridge.invoke },
        async ({ storage, service }) => {
          await adopt(storage, "codex", { requestId: "req-1" });
          await service.reconcileAgentActivity();
          await service.shutdown();
          await bridge.die();
          await prepare(storage);
          const restarted = new NativeAgentService(storage, bridge.invoke, {});
          try {
            if (options.stopRequested) await restarted.runtimeStopRequested("env-1");
            const completions = spyOn(storage, "recordEnvironmentSessionCompletion");
            await restarted.reconcileAgentActivity();
            await restarted.reconcileAgentActivity();
            reasons = completions.mock.calls.map((call) => call[2]);
            completions.mockRestore();
            environment = await storage.getEnvironment("env-1");
          } finally {
            await restarted.shutdown();
          }
        },
      );
      return { reasons, environment };
    }

    test("a dispatched turn with no recorded end rings agent_failed", async () => {
      const { reasons, environment } = await restartWithoutBridge(async () => {});
      expect(reasons).toEqual(["agent_failed"]);
      expect(environment).toMatchObject({
        agentActivityState: "idle",
        unreadReason: "agent_failed",
      });
    });

    test("a turn with a recorded outcome falls back to agent_finished", async () => {
      const { reasons, environment } = await restartWithoutBridge(async (storage) => {
        await storage.recordNativeAgentTurnOutcome(key("codex"), "provider-tab-1", {
          requestId: "req-1",
          outcome: "completed",
          observedAt: new Date().toISOString(),
        });
      });
      expect(reasons).toEqual([]);
      expect(environment).toMatchObject({
        hasUnreadWork: true,
        unreadReason: "agent_finished",
      });
    });

    test("a turn the user stopped falls back to agent_finished", async () => {
      const { reasons, environment } = await restartWithoutBridge(async (storage) => {
        await storage.recordNativeAgentTurnInterrupt(key("codex"), "provider-tab-1", "req-1");
      });
      expect(reasons).toEqual([]);
      expect(environment?.unreadReason).toBe("agent_finished");
    });

    test("a stop already requested falls back to agent_finished", async () => {
      const { reasons, environment } = await restartWithoutBridge(async () => {}, {
        stopRequested: true,
      });
      expect(reasons).toEqual([]);
      expect(environment?.unreadReason).toBe("agent_finished");
    });
  });

  test("a runtime stopped meanwhile rings nothing, and neither does its next start", async () => {
    // Storage clears an environment's activity when it records a stop, so no
    // durable `working` is left to say a turn was running.
    let activity: "working" | "idle" = "working";
    const { provider } = createProviderStub("codex", { activity: async () => activity });
    const { reasons, environment } = await restartAcross(
      "codex",
      provider,
      (storage) => adopt(storage, "codex", { requestId: "req-1" }),
      {
        environment: {
          environmentType: "containerized",
          containerId: "container-1",
          worktreePath: undefined,
        },
        duringRestart: async (storage) => {
          await storage.updateEnvironment("env-1", { status: "stopped" });
          activity = "idle";
        },
      },
    );
    expect(reasons).toEqual([]);
    expect(environment?.hasUnreadWork).not.toBe(true);
  });
});
