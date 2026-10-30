/**
 * The unread reason a turn's end records, per platform: a turn that ended on
 * the provider's terminal error rings `agent_failed`, never "the agent
 * completed its work"; a turn the user stopped, or one that finished, rings
 * `agent_finished`.
 *
 * The bridge platforms run through the real HTTP provider against a stubbed
 * bridge, so each one's activity answer is parsed the way it is in
 * production; each bridge's own suite covers the field it sends. OpenCode's provider reads an SDK client, so it is a stub with
 * the same contract: idle lifecycle, failure kept on the request's answer.
 */
import { describe, expect, test } from "bun:test";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import {
  claudeConnection,
  codexConnection,
  cursorConnection,
  grokConnection,
  httpProvider,
  piConnection,
} from "./agent-provider-test-support.js";
import { TURN_STOPPED_BY_USER_MESSAGE } from "./agent-provider-contract.js";
import type { BridgeConnection, NativeAgentRuntimeProvider } from "./native-agent-provider.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createProviderStub, withService } from "./native-agent-service-projection-test-support.js";

const key = (agent: BuildPipelineAgent) => nativeAgentSessionStorageKey("env-1", agent, "tab-1");

/** One turn: `working`, then `idle` with the given session snapshot. */
async function endTurn(
  agent: BuildPipelineAgent,
  provider: NativeAgentRuntimeProvider,
  finish: () => void,
  options: { requestId?: string } = {},
) {
  let reason: unknown;
  await withService(
    { prefix: `orkestrator-failed-turn-${agent}-`, provider: async () => provider },
    async ({ storage, service }) => {
      await storage.adoptNativeAgentSession({
        key: key(agent),
        environmentId: "env-1",
        agent,
        logicalSessionKey: "tab-1",
        providerSessionId: "provider-1",
      });
      if (options.requestId) {
        await storage.dispatchNativeAgentPromptOnce(key(agent), options.requestId, async () => {});
      }
      await service.reconcileAgentActivity();
      expect((await storage.getEnvironment("env-1"))?.hasUnreadWork).not.toBe(true);
      finish();
      await service.reconcileAgentActivity();
      const environment = await storage.getEnvironment("env-1");
      expect(environment?.hasUnreadWork).toBe(true);
      reason = environment?.unreadReason;
    },
  );
  return reason;
}

/**
 * A bridge that answers its no-touch activity route (single and batch) and the
 * dispatch journal, nothing else: the turn-end edge must not read the session.
 */
function bridge(
  connection: BridgeConnection,
  ended: { turnFailed?: boolean },
  journal?: { status: number; turn?: Record<string, unknown> },
) {
  let observation: Record<string, unknown> = { activity: "working" };
  const { provider, requests } = httpProvider(async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === "/session/provider-1/activity") return Response.json(observation);
    if (pathname === "/sessions/activity") {
      const { sessionIds } = JSON.parse(String(init.body)) as { sessionIds: string[] };
      return Response.json({
        version: 1,
        observations: Object.fromEntries(sessionIds.map((id) => [id, observation])),
      });
    }
    if (pathname === "/session/provider-1/dispatch" && journal) {
      return Response.json(
        { dispatch: "dispatched", ...(journal.turn ? { turn: journal.turn } : {}) },
        { status: journal.status },
      );
    }
    return new Response("not found", { status: 404 });
  }, connection);
  return {
    provider,
    paths: () => requests.map(({ url }) => new URL(url).pathname),
    finish: () => {
      observation = { activity: "idle", ...ended };
    },
  };
}

const BRIDGE_PLATFORMS = [
  claudeConnection,
  codexConnection,
  cursorConnection,
  grokConnection,
  piConnection,
] as const;

const NO_TOUCH_PATHS = new Set([
  "/session/provider-1/activity",
  "/sessions/activity",
  "/session/provider-1/dispatch",
  "/event/subscribe",
]);

describe("failed turn unread reason", () => {
  for (const connection of BRIDGE_PLATFORMS) {
    test(`${connection.agent}: a turn that ended on an error rings agent_failed`, async () => {
      const { provider, finish, paths } = bridge(connection, { turnFailed: true });
      expect(await endTurn(connection.agent, provider, finish)).toBe("agent_failed");
      // Read from the no-touch observation: no status, session or transcript.
      expect(paths().every((path) => NO_TOUCH_PATHS.has(path))).toBe(true);
    });

    test(`${connection.agent}: a finished or user-stopped turn rings agent_finished`, async () => {
      // Every bridge settles a stop the user asked for to idle with no error.
      const { provider, finish } = bridge(connection, {});
      expect(await endTurn(connection.agent, provider, finish)).toBe("agent_finished");
    });
  }

  test("grok: a turn the bridge cut short reads idle and still rings agent_failed", async () => {
    const { provider, finish } = bridge(
      grokConnection,
      {},
      { status: 200, turn: { state: "failed", error: "grok cancelled the turn" } },
    );
    expect(await endTurn("grok", provider, finish, { requestId: "req-1" })).toBe("agent_failed");
  });

  test("grok: an unreadable journal falls back to agent_finished", async () => {
    const { provider, finish } = bridge(grokConnection, {}, { status: 503 });
    expect(await endTurn("grok", provider, finish, { requestId: "req-1" })).toBe("agent_finished");
  });

  describe("opencode", () => {
    function openCode(terminalError: string | null) {
      let activity: "working" | "idle" = "working";
      const { provider } = createProviderStub("opencode", {
        activity: async () => activity,
        status: async () => (activity === "working" ? "running" : "idle"),
      });
      Object.assign(provider, { turnTerminalError: async () => terminalError });
      return {
        provider,
        finish: () => {
          activity = "idle";
        },
      };
    }

    test("a failure kept on the request's answer rings agent_failed", async () => {
      const { provider, finish } = openCode("Provider returned 401");
      expect(await endTurn("opencode", provider, finish, { requestId: "req-1" })).toBe(
        "agent_failed",
      );
    });

    test("a turn the user stopped rings agent_finished", async () => {
      const { provider, finish } = openCode(TURN_STOPPED_BY_USER_MESSAGE);
      expect(await endTurn("opencode", provider, finish, { requestId: "req-1" })).toBe(
        "agent_finished",
      );
    });

    test("a turn that answered rings agent_finished", async () => {
      const { provider, finish } = openCode(null);
      expect(await endTurn("opencode", provider, finish, { requestId: "req-1" })).toBe(
        "agent_finished",
      );
    });
  });
});
