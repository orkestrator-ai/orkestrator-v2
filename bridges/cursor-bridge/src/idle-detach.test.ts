import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Agent, LocalAgentStore } from "@cursor/sdk";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bridgeStateRoot = join(tmpdir(), `cursor-bridge-idle-detach-${process.pid}`);
const previousEnv = {
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  CURSOR_BRIDGE_STATE_DIR: process.env.CURSOR_BRIDGE_STATE_DIR,
  CURSOR_BRIDGE_AUTH_FILE: process.env.CURSOR_BRIDGE_AUTH_FILE,
};
process.env.CURSOR_BRIDGE_STATE_DIR = bridgeStateRoot;
process.env.CURSOR_BRIDGE_AUTH_FILE = join(bridgeStateRoot, "missing-auth.json");

const {
  ensureAgent,
  newSessionState,
  setCursorMcpConfigHomeForTests,
  setCursorMcpFingerprintForTests,
  useCursorAgentForTests,
} = await import("./agent-session.js");
const { useCursorLocalAgentStoreForTests, useCursorSdkRuntimeForTests } =
  await import("./sdk-runtime.js");
const { useCursorCredentialRuntimeForTests } = await import("./credentials.js");
const { attachFake } = await import("./testing/fake-agent.js");
const { IDLE_DETACH_MS, settleIdleDetaches, sweepIdleSessions } = await import("./idle-detach.js");
const { clientSessionKeys, sessions } = await import("./state.js");

type SessionState = ReturnType<typeof newSessionState>;
const NOW = 50 * IDLE_DETACH_MS;
const resumed: string[] = [];

const testAgent = {
  create: async () => {
    throw new Error("an idle reattach must resume, never create");
  },
  resume: async (agentId: string) => {
    resumed.push(agentId);
    return {
      agentId,
      send: async () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    };
  },
  list: async () => ({ items: [] }),
  listRuns: async () => ({ items: [] }),
} as unknown as typeof Agent;

const testStore = {
  agents: { get: async () => undefined, update: async () => undefined },
  checkpoints: {},
  runs: { list: async () => ({ items: [], nextCursor: undefined }), delete: async () => undefined },
  runEvents: { delete: async () => undefined },
} as unknown as LocalAgentStore;

const restorers: Array<() => void> = [];
let previousStore: LocalAgentStore;

beforeAll(() => {
  restorers.push(useCursorAgentForTests(testAgent));
  restorers.push(
    useCursorSdkRuntimeForTests({
      configureStore: () => undefined,
      createPlatform: (async () => ({
        prewarmLocalWorkspace: async () => async () => undefined,
      })) as unknown as typeof import("@cursor/sdk").createAgentPlatform,
    }),
  );
  previousStore = useCursorLocalAgentStoreForTests(testStore);
  restorers.push(
    useCursorCredentialRuntimeForTests({
      store: {
        load: async () => undefined,
        save: async () => undefined,
        clear: async () => undefined,
      },
      auth: { login: async () => undefined, logout: async () => undefined } as never,
    }),
  );
});

afterAll(async () => {
  useCursorLocalAgentStoreForTests(previousStore);
  for (const restore of restorers.reverse()) restore();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(bridgeStateRoot, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CURSOR_API_KEY = "test-key";
  setCursorMcpConfigHomeForTests(join(bridgeStateRoot, "config-home"));
  setCursorMcpFingerprintForTests(async () => "config-unchanged");
  sessions.clear();
  clientSessionKeys.clear();
  resumed.length = 0;
});

afterEach(async () => {
  await settleIdleDetaches();
  setCursorMcpFingerprintForTests();
  sessions.clear();
  clientSessionKeys.clear();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A registered session, attached and untouched for longer than the limit. */
function idleSession(script: Parameters<typeof attachFake>[1] = {}): SessionState {
  const state = newSessionState();
  attachFake(state, script);
  state.lastAccessed = NOW - IDLE_DETACH_MS;
  state.messages.push({
    id: "user-1",
    role: "user",
    content: "earlier turn",
    parts: [],
    createdAt: new Date(0).toISOString(),
  });
  sessions.set(state.id, state);
  return state;
}

describe("sweepIdleSessions", () => {
  test("detaches an idle session, which later resumes the same SDK conversation", async () => {
    const state = idleSession();

    expect(sweepIdleSessions(NOW)).toBe(1);
    expect(state.agent).toBeNull();
    await settleIdleDetaches();
    expect(sessions.get(state.id)).toBe(state);
    expect(state.agentId).toBe("fake-agent");
    expect(state.messages.map((message) => message.id)).toEqual(["user-1"]);

    const reattached = await ensureAgent(state);
    expect(resumed).toEqual(["fake-agent"]);
    expect(state.agent).toBe(reattached);
    expect(state.messages.map((message) => message.id)).toEqual(["user-1"]);
  });

  test("never detaches a running turn, a background child, a dispatch or a recent session", () => {
    const running = idleSession();
    running.status = "running";
    const backgroundChild = idleSession();
    backgroundChild.activeSubagentDescriptors.set("child-1", { description: "still writing" });
    const dispatching = idleSession();
    dispatching.dispatching = true;
    const recent = idleSession();
    recent.lastAccessed = NOW - IDLE_DETACH_MS + 1;

    expect(sweepIdleSessions(NOW)).toBe(0);
    for (const state of [running, backgroundChild, dispatching, recent]) {
      expect(state.agent).not.toBeNull();
    }
  });

  test("a sweep during a pending detach does not start a second one for that session", async () => {
    const state = idleSession();
    const disposal = deferred();
    let detaches = 0;
    // The injected detach leaves `agent` in place, so only coalescing can
    // stop the second sweep from detaching again.
    const detach = async () => {
      detaches += 1;
      await disposal.promise;
    };

    expect(sweepIdleSessions(NOW, detach)).toBe(1);
    expect(sweepIdleSessions(NOW + 60_000, detach)).toBe(0);
    expect(detaches).toBe(1);

    disposal.resolve();
    await settleIdleDetaches();
    expect(sweepIdleSessions(NOW + 120_000, detach)).toBe(1);
    expect(state.agent).not.toBeNull();
  });

  test("a prompt that attaches while the old disposal is pending keeps its new agent", async () => {
    const disposal = deferred();
    const state = idleSession({ holdDispose: disposal.promise });

    expect(sweepIdleSessions(NOW)).toBe(1);
    expect(state.agent).toBeNull();

    // A new turn claims the session and resumes a fresh generation while the
    // idle detach is still disposing the old one.
    state.dispatching = true;
    state.lastAccessed = NOW;
    const fresh = await ensureAgent(state, { atTurnStart: true });

    disposal.resolve();
    await settleIdleDetaches();

    expect(state.agent).toBe(fresh);
    // And the new generation is protected while its turn is being dispatched.
    expect(sweepIdleSessions(NOW + 2 * IDLE_DETACH_MS)).toBe(0);
  });
});
