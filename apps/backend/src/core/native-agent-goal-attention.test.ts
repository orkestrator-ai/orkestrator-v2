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
import { withService } from "./native-agent-service-projection-test-support.js";

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

  test("the goal field reaches a session's stored record for readers", async () => {
    const { provider, finish } = bridge(claudeConnection, {});
    await withService(
      { prefix: "orkestrator-goal-read-", provider: async () => provider },
      async ({ storage }) => {
        await storage.adoptNativeAgentSession({
          key: key("claude"),
          environmentId: "env-1",
          agent: "claude",
          logicalSessionKey: "tab-1",
          providerSessionId: "provider-1",
        });
        await storage.updateNativeAgentGoal(key("claude"), () => goal());
        const session = await storage.getNativeAgentSession(key("claude"));
        expect(sessionGoal(session!)?.goalId).toBe("g1");
      },
    );
    finish();
  });
});
