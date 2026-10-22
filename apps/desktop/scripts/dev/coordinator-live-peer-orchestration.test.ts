import { expect, test } from "bun:test";
import { DEFAULT_AGENT_MESSAGING_SETTINGS } from "@orkestrator/protocol/agent-mail";
import { runPeerScenario } from "./coordinator-live-peer-orchestration.js";
import {
  PEER_DONE_MARKER,
  PEER_MESSAGE_COUNT,
  PEER_TAB_ID,
  peerBody,
} from "./coordinator-live-peer.js";

const probe = { platform: "codex" as const, token: "fixture" };
class Skipped extends Error {}

function fixture(failure?: { command: string; occurrence?: number; message: string }) {
  const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
  const cleanup: Array<() => Promise<unknown>> = [];
  const previous = { ...DEFAULT_AGENT_MESSAGING_SETTINGS };
  let settings = { ...previous };
  const environments = ["existing"];
  let responderReads = 0;
  let matchingCalls = 0;
  const mail = Array.from({ length: PEER_MESSAGE_COUNT }, (_, offset) => ({
    id: `message-${offset + 1}`,
    ...(offset > 0 ? { replyToMessageId: `message-${offset}` } : {}),
    createdAt: new Date(1_000 + offset * 1_000).toISOString(),
    injectedAt: new Date(1_100 + offset * 1_000).toISOString(),
    from: {
      kind: "tab",
      environmentId: offset % 2 === 0 ? "opener" : "responder",
      tabId: PEER_TAB_ID,
    },
    toEnvironmentId: offset % 2 === 0 ? "responder" : "opener",
    toTabId: PEER_TAB_ID,
    placement: "injected",
    route: "peer",
    body: peerBody(probe, offset + 1),
  }));
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    commands.push({ command, args });
    if (command === failure?.command && ++matchingCalls === (failure.occurrence ?? 1)) {
      throw new Error(failure.message);
    }
    const environmentId = String(args.environmentId);
    switch (command) {
      case "get_config":
        return { global: { enabledAgentPlatforms: ["codex"] } } as T;
      case "get_agent_messaging_settings":
        return { ...settings } as T;
      case "update_agent_messaging_settings":
        settings = { ...(args.settings as typeof settings) };
        return settings as T;
      case "get_environments":
        return environments.map((id) => ({ id })) as T;
      case "create_environment": {
        const id = String(args.name).includes("responder") ? "responder" : "opener";
        if (id === "opener") expect(responderReads).toBe(4);
        expect(settings).toEqual({ ...previous, wakePeers: true });
        environments.push(id);
        return { id } as T;
      }
      case "get_native_agent_auth_status":
        return { state: "signed-in" } as T;
      case "get_native_agent_projection": {
        if (environmentId === "responder") responderReads += 1;
        // A stale idle snapshot without a startup row must not launch the opener.
        const starting = environmentId === "responder" && responderReads <= 2;
        return {
          turn: { phase: responderReads === 2 && starting ? "running" : "idle" },
          messages: starting
            ? []
            : [
                {
                  role: "assistant",
                  content: environmentId === "opener" ? PEER_DONE_MARKER : "ready",
                },
              ],
          interactions: [],
        } as T;
      }
      case "get_agent_mail_mailbox":
        return {
          messages: environments.includes("opener")
            ? mail.filter((message) => message.toEnvironmentId === environmentId)
            : [],
        } as T;
      case "get_agent_mail_message":
        return mail.find((message) => message.id === args.messageId) as T;
      default:
        return null as T;
    }
  };
  return {
    commands,
    previous,
    environments,
    cleanup,
    settings: () => settings,
    run: () =>
      runPeerScenario({
        invoke,
        projectId: "project",
        probe,
        cleanup,
        skip: (reason) => {
          throw new Skipped(reason);
        },
        pollIntervalMs: 1,
        startupTimeoutMs: 1_000,
      }),
    async restore() {
      for (const step of cleanup.toReversed()) await step();
    },
  };
}

test("peer orchestration waits for responder startup and two idle reads, enables and restores Wake peers", async () => {
  const state = fixture();
  try {
    const result = await state.run();
    expect(result.checks.filter((check) => !check.passed)).toEqual([]);
    expect(result.observations.length).toBe(6);
    expect(state.settings()).toEqual({ ...state.previous, wakePeers: true });
    expect(
      state.commands
        .filter(({ command }) => command === "start_environment")
        .map(({ args }) => args.environmentId),
    ).toEqual(["responder", "opener"]);
    expect(state.commands.some(({ command }) => command === "dispatch_native_agent_intent")).toBe(
      false,
    );
  } finally {
    await state.restore();
  }
  expect(state.settings()).toEqual(state.previous);
  expect(
    state.commands
      .filter(({ command }) => command === "delete_environment")
      .map(({ args }) => args.environmentId),
  ).toEqual(["responder", "opener"]);
});

for (const command of ["create_environment", "start_environment", "get_native_agent_auth_status"]) {
  for (const occurrence of [1, 2]) {
    test(`${command} sign-in failure ${occurrence} maps to a skip and restores settings`, async () => {
      const state = fixture({ command, occurrence, message: "sign-in required" });
      try {
        await expect(state.run()).rejects.toThrow(Skipped);
      } finally {
        await state.restore();
      }
      expect(state.settings()).toEqual(state.previous);
    });
  }
}

test("an unavailable auth read fails visibly instead of skipping or timing out", async () => {
  const state = fixture({ command: "get_native_agent_auth_status", message: "transport closed" });
  try {
    const result = await state.run();
    expect(result.checks.find((check) => check.name === "finished")).toMatchObject({
      passed: false,
      detail: "codex: peer authentication status unavailable",
    });
  } finally {
    await state.restore();
  }
  expect(state.settings()).toEqual(state.previous);
});

test("a non-authentication startup failure remains a failure and cleans up the created peer", async () => {
  const state = fixture({ command: "start_environment", message: "worktree unavailable" });
  try {
    const result = await state.run();
    expect(result.checks.find((check) => check.name === "finished")).toMatchObject({
      passed: false,
      detail: "worktree unavailable",
    });
  } finally {
    await state.restore();
  }
  expect(state.settings()).toEqual(state.previous);
  expect(
    state.commands
      .filter(({ command }) => command === "delete_environment")
      .map(({ args }) => args.environmentId),
  ).toEqual(["responder"]);
});
