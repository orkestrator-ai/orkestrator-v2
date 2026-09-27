import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ensureSession, newSessionState, setAgentSessionTestHooks } from "./agent-session.js";
import { IDLE_DETACH_MS, settleIdleDetaches, sweepIdleSessions } from "./idle-detach.js";
import { refreshModels } from "./models.js";
import { setModelRuntimeFactoryForTests } from "./runtime.js";
import { clientSessionKeys, type PendingApproval, type SessionState, sessions } from "./state.js";

const NOW = 50 * IDLE_DETACH_MS;
let sessionDirectory: string;
let previousSessionDirectory: string | undefined;

interface FakeSession {
  session: AgentSession;
  disposed: () => number;
  unsubscribed: () => number;
}

function fakeSession(id: string): FakeSession {
  let disposed = 0;
  let unsubscribed = 0;
  const session = {
    sessionId: id,
    sessionFile: join(sessionDirectory, "conversation.jsonl"),
    model: undefined,
    thinkingLevel: "medium",
    promptTemplates: [],
    subscribe: () => () => {
      unsubscribed += 1;
    },
    dispose: () => {
      disposed += 1;
    },
    setModel: async () => undefined,
    setThinkingLevel: () => undefined,
    getAvailableThinkingLevels: () => ["medium"],
    getContextUsage: () => undefined,
    getSessionStats: () => ({ cost: 0 }),
    bindExtensions: async () => undefined,
  } as unknown as AgentSession;
  return { session, disposed: () => disposed, unsubscribed: () => unsubscribed };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A registered bridge session, attached and untouched for longer than the limit. */
function idleSession(fake: FakeSession = fakeSession("pi-idle")): SessionState {
  const state = newSessionState();
  state.session = fake.session;
  state.sessionFile = join(sessionDirectory, "conversation.jsonl");
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

function parkedApproval(): PendingApproval {
  return {
    id: "approval-1",
    toolCallId: "tool-1",
    toolName: "bash",
    input: {},
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    settle: () => undefined,
  };
}

beforeEach(async () => {
  sessionDirectory = await mkdtemp(join(tmpdir(), "pi-bridge-idle-detach-"));
  previousSessionDirectory = process.env.PI_SESSION_DIR;
  process.env.PI_SESSION_DIR = sessionDirectory;
  sessions.clear();
  clientSessionKeys.clear();
  setAgentSessionTestHooks({ hydrateComposer: async (composer) => composer });
});

afterEach(async () => {
  await settleIdleDetaches();
  setAgentSessionTestHooks(undefined);
  setModelRuntimeFactoryForTests();
  refreshModels();
  sessions.clear();
  clientSessionKeys.clear();
  if (previousSessionDirectory === undefined) delete process.env.PI_SESSION_DIR;
  else process.env.PI_SESSION_DIR = previousSessionDirectory;
  await rm(sessionDirectory, { recursive: true, force: true });
});

describe("sweepIdleSessions", () => {
  test("detaches an idle session, which later reattaches to the same conversation", async () => {
    const first = fakeSession("pi-first");
    const state = idleSession(first);

    expect(sweepIdleSessions(NOW)).toBe(1);
    expect(state.session).toBeNull();
    await settleIdleDetaches();
    expect(first.disposed()).toBe(1);
    // The bridge session, its history and its Pi file pointer all survive.
    expect(sessions.get(state.id)).toBe(state);
    expect(state.messages.map((message) => message.id)).toEqual(["user-1"]);
    expect(state.sessionFile).toBe(join(sessionDirectory, "conversation.jsonl"));

    const second = fakeSession("pi-second");
    const attachedFrom: Array<string | undefined> = [];
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async (target) => {
        attachedFrom.push(target.sessionFile);
        return second.session;
      },
    });
    expect(await ensureSession(state)).toBe(second.session);
    expect(attachedFrom).toEqual([join(sessionDirectory, "conversation.jsonl")]);
    expect(state.messages.map((message) => message.id)).toEqual(["user-1"]);
  });

  test("never detaches work in flight, a parked approval or a recently touched session", () => {
    const running = idleSession();
    running.status = "running";
    const compacting = idleSession();
    compacting.compacting = true;
    const dispatching = idleSession();
    dispatching.dispatching = true;
    const blocked = idleSession();
    blocked.approvals.set("approval-1", parkedApproval());
    const recent = idleSession();
    recent.lastAccessed = NOW - IDLE_DETACH_MS + 1;
    const detached = newSessionState();
    detached.lastAccessed = 0;
    sessions.set(detached.id, detached);

    expect(sweepIdleSessions(NOW)).toBe(0);
    for (const state of [running, compacting, dispatching, blocked, recent]) {
      expect(state.session).not.toBeNull();
    }
  });

  test("a sweep during a pending detach does not start a second one for that session", async () => {
    const state = idleSession();
    const disposal = deferred();
    let detaches = 0;
    // The injected detach leaves `session` in place, so only coalescing can
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
    expect(state.session).not.toBeNull();
  });

  test("a failed disposal is contained and does not block the next sweep", async () => {
    idleSession();
    const detach = async () => {
      throw new Error("dispose failed");
    };

    expect(sweepIdleSessions(NOW, detach)).toBe(1);
    await settleIdleDetaches();
    expect(sweepIdleSessions(NOW, detach)).toBe(1);
  });

  test("a prompt that attaches while the old disposal is pending keeps its new session", async () => {
    const old = fakeSession("pi-old");
    const state = idleSession(old);
    const disposal = deferred();
    let runtimeDisposals = 0;
    state.runtime = {
      dispose: async () => {
        runtimeDisposals += 1;
        await disposal.promise;
      },
    } as unknown as AgentSessionRuntime;

    expect(sweepIdleSessions(NOW)).toBe(1);
    expect(state.session).toBeNull();

    // A new turn claims the session and attaches a fresh generation while the
    // idle detach is still disposing the old one.
    const fresh = fakeSession("pi-fresh");
    setAgentSessionTestHooks({
      hydrateComposer: async (composer) => composer,
      createAgentSession: async () => fresh.session,
    });
    state.dispatching = true;
    state.lastAccessed = NOW;
    expect(await ensureSession(state)).toBe(fresh.session);

    disposal.resolve();
    await settleIdleDetaches();

    expect(runtimeDisposals).toBe(1);
    expect(state.session).toBe(fresh.session);
    expect(fresh.disposed()).toBe(0);
    expect(fresh.unsubscribed()).toBe(0);
    // And the new generation is protected while its turn is being dispatched.
    expect(sweepIdleSessions(NOW + 2 * IDLE_DETACH_MS)).toBe(0);
  });
});
