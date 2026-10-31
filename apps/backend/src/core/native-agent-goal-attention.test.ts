/**
 * A goal rings once. Every iteration ends in a turn-end edge, and that edge
 * usually means "the agent finished": while a goal will follow it up, it must
 * not. The bridge platforms run through the real HTTP provider against a stubbed
 * bridge, so each one's activity answer is parsed as in production.
 */
import { describe, expect, test } from "bun:test";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import { sessionGoal, type NativeAgentGoal } from "@orkestrator/protocol/native-agent-goal";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  grokConnection,
  httpProvider,
  piConnection,
} from "./agent-provider-test-support.js";
import type { BridgeConnection, NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const key = (agent: BuildPipelineAgent) => nativeAgentSessionStorageKey("env-1", agent, "tab-1");

function goal(overrides: Partial<NativeAgentGoal> = {}): NativeAgentGoal {
  return {
    goalId: "g1",
    objective: "Make the tests pass",
    status: "active",
    providerSessionId: "provider-1",
    iterations: 1,
    maxIterations: 20,
    noProgressStreak: 0,
    setAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function bridge(connection: BridgeConnection, ended: { turnFailed?: boolean }) {
  let observation: Record<string, unknown> = { activity: "working" };
  const { provider } = httpProvider(async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === "/session/provider-1/activity") return Response.json(observation);
    if (pathname === "/sessions/activity") {
      const { sessionIds } = JSON.parse(String(init.body)) as { sessionIds: string[] };
      return Response.json({
        version: 1,
        observations: Object.fromEntries(sessionIds.map((id) => [id, observation])),
      });
    }
    if (pathname === "/session/provider-1/dispatch") {
      return Response.json({ dispatch: "dispatched" });
    }
    return new Response("not found", { status: 404 });
  }, connection);
  return {
    provider,
    finish: () => {
      observation = { activity: "idle", ...ended };
    },
  };
}

async function endTurn(
  agent: BuildPipelineAgent,
  provider: NativeAgentRuntimeProvider,
  finish: () => void,
  withGoal: NativeAgentGoal | undefined,
) {
  let reason: unknown;
  let unread: unknown;
  await withService(
    { prefix: `orkestrator-goal-attention-${agent}-`, provider: async () => provider },
    async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: key(agent),
        environmentId: "env-1",
        agent,
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      if (withGoal) {
        // The goal's own turn is the session's latest, already acted on, so the
        // loop has nothing to send. Only the edge's reading is under test.
        await storage.dispatchNativeAgentPromptOnce(key(agent), "goal:g1:0", async () => {});
        await storage.updateNativeAgentGoal(key(agent), () => ({
          ...withGoal,
          evaluatedRequestId: "goal:g1:0",
        }));
        await service.goals.init();
        await service.goals.settled();
      }
      await service.reconcileAgentActivity();
      finish();
      await service.reconcileAgentActivity();
      const environment = await storage.getEnvironment("env-1");
      unread = environment?.hasUnreadWork;
      reason = environment?.unreadReason;
    },
  );
  return { reason, unread };
}

const PLATFORMS = [
  claudeConnection,
  codexConnection,
  cursorConnection,
  grokConnection,
  piConnection,
] as const;

describe("goal attention", () => {
  for (const connection of PLATFORMS) {
    test(`${connection.agent}: a turn the goal will follow up rings nothing`, async () => {
      const { provider, finish } = bridge(connection, {});
      const { unread } = await endTurn(connection.agent, provider, finish, goal());
      expect(unread).not.toBe(true);
    });

    test(`${connection.agent}: a failed turn still rings during a goal`, async () => {
      const { provider, finish } = bridge(connection, { turnFailed: true });
      const { reason } = await endTurn(connection.agent, provider, finish, goal());
      expect(reason).toBe("agent_failed");
    });

    test(`${connection.agent}: with no goal, a turn end rings as before`, async () => {
      const { provider, finish } = bridge(connection, {});
      const { reason } = await endTurn(connection.agent, provider, finish, undefined);
      expect(reason).toBe("agent_finished");
    });

    test(`${connection.agent}: a goal that already stopped does not hold the edge`, async () => {
      const { provider, finish } = bridge(connection, {});
      const { reason } = await endTurn(
        connection.agent,
        provider,
        finish,
        goal({ status: "paused", statusReason: "user-paused" }),
      );
      expect(reason).toBe("agent_finished");
    });
  }

  test("a typed /goal in the queue sets the goal, journals nothing and empties the queue", async () => {
    const stub = createProviderStub("claude");
    await withService(
      { prefix: "orkestrator-goal-queue-", provider: async () => stub.provider },
      async ({ storage, service }) => {
        await service.ensureSession({
          environmentId: "env-1",
          agent: "claude",
          logicalSessionKey: "env-env-1:tab-1",
        });
        const queueKey = "claude\u0000env-env-1:tab-1";
        await storage.savePromptQueue(queueKey, "env-1", [
          { id: "typed-1", requestId: "typed-1", text: "/goal Make it pass --max-iterations 2" },
        ]);
        await service.drainPromptQueueForSession({
          environmentId: "env-1",
          agent: "claude",
          logicalSessionKey: "env-env-1:tab-1",
        });
        const stored = await storage.getNativeAgentSession(
          nativeAgentSessionStorageKey("env-1", "claude", "env-env-1:tab-1"),
        );
        expect(sessionGoal(stored!)?.objective).toBe("Make it pass");
        expect(stored?.dispatchedRequestIds ?? []).not.toContain("typed-1");
        expect(
          (await storage.getPromptQueue(queueKey))?.messages.map((m) => (m as { id: string }).id),
        ).not.toContain("typed-1");
        await service.goals.perform(stored!, { kind: "clear" }, { busy: false });
      },
    );
  });

  test("a projection shows the goal, without its check output", async () => {
    const stub = createProviderStub("claude");
    await withService(
      { prefix: "orkestrator-goal-projection-", provider: async () => stub.provider },
      async ({ storage, service }) => {
        const identity = {
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "env-env-1:tab-1",
        };
        await service.ensureSession(identity);
        const sessionKey = nativeAgentSessionStorageKey("env-1", "claude", "env-env-1:tab-1");
        expect((await service.getProjection(identity))?.goal).toBeUndefined();
        await storage.updateNativeAgentGoal(sessionKey, () =>
          goal({
            status: "paused",
            statusReason: "user-paused",
            lastCheck: {
              passed: false,
              exitCode: 1,
              durationMs: 1,
              outputTail: "private output",
              at: new Date(0).toISOString(),
            },
          }),
        );
        const view = await service.getProjection(identity);
        expect(view?.goal?.status).toBe("paused");
        expect(JSON.stringify(view?.goal)).not.toContain("private output");
        const detail = await service.readGoalDetail(identity);
        expect(detail.goal?.lastCheck?.outputTail).toBe("private output");
      },
    );
  });

  test("a resumed conversation keeps the goal on the same key, bound to the old id", async () => {
    const stub = createProviderStub("claude");
    await withService(
      { prefix: "orkestrator-goal-replaced-", provider: async () => stub.provider },
      async ({ storage }) => {
        const sessionKey = key("claude");
        const common = {
          key: sessionKey,
          environmentId: "env-1",
          agent: "claude" as const,
          logicalSessionKey: "tab-1",
        };
        await storage.adoptNativeAgentSession({ ...common, providerSessionId: "provider-1" });
        await storage.updateNativeAgentGoal(sessionKey, () => goal());
        // Another key, as a fork gets, starts with no goal.
        const otherKey = nativeAgentSessionStorageKey("env-1", "claude", "tab-2");
        await storage.adoptNativeAgentSession({
          ...common,
          key: otherKey,
          logicalSessionKey: "tab-2",
          providerSessionId: "provider-2",
        });
        expect(sessionGoal((await storage.getNativeAgentSession(otherKey))!)).toBeUndefined();
        const stored = await storage.getNativeAgentSession(sessionKey);
        expect(sessionGoal(stored!)?.providerSessionId).toBe("provider-1");
      },
    );
  });
});
