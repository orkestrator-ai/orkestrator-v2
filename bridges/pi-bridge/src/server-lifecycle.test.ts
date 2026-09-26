import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { FakeIntervals } from "@orkestrator/protocol/fake-intervals";

// `config.ts` reads its environment once, at import, so everything below is
// loaded after this suite's environment is in place.
process.env.HOSTNAME = "127.0.0.1";
process.env.PI_BRIDGE_TOKEN = "test-token";
process.env.PI_BRIDGE_LIBRARY_ONLY = "1";
delete process.env.PI_BRIDGE_STATE_DIR;
const sessionDirectory = await mkdtemp(join(tmpdir(), "pi-bridge-server-lifecycle-"));
process.env.PI_SESSION_DIR = sessionDirectory;

const { server, start, shutdown } = await import("./server.js");
const { newSessionState } = await import("./agent-session.js");
const { IDLE_DETACH_MS, settleIdleDetaches } = await import("./idle-detach.js");
const { sessions } = await import("./state.js");

/**
 * One lifecycle per module: the bridge's registries are module-global and
 * shutdown is terminal, so this file drives a single start → parent death
 * sequence and asserts each stage along the way.
 */
const timers = new FakeIntervals();
let parentAlive = true;
const exits: number[] = [];
let disposed = 0;
const approvalDecisions: string[] = [];

afterAll(async () => {
  await shutdown();
  await rm(sessionDirectory, { recursive: true, force: true });
});

function seedSession(lastAccessed: number) {
  const state = newSessionState();
  state.session = {
    subscribe: () => () => undefined,
    dispose: () => {
      disposed += 1;
    },
  } as unknown as AgentSession;
  state.lastAccessed = lastAccessed;
  sessions.set(state.id, state);
  return state;
}

describe("Pi bridge server lifecycle", () => {
  test("start arms one idle sweep and a five-second parent watch", async () => {
    await start(0, {
      timers,
      parentPid: 4213,
      isParentAlive: () => parentAlive,
      exit: (code) => exits.push(code),
      signals: null,
    });

    expect(server.listening).toBe(true);
    expect(timers.periods()).toEqual([5_000, 60_000]);
  });

  test("a repeated start rejects without arming or binding anything more", async () => {
    await expect(start(0, { timers, signals: null })).rejects.toThrow("already started");
    expect(timers.periods()).toEqual([5_000, 60_000]);
  });

  test("the armed sweep detaches an idle session and leaves an active one", async () => {
    const idle = seedSession(0);
    const active = seedSession(Date.now() + IDLE_DETACH_MS);
    active.status = "running";

    timers.tick(60_000);
    expect(idle.session).toBeNull();
    await settleIdleDetaches();

    expect(active.session).not.toBeNull();
    expect(disposed).toBe(1);
  });

  test("parent death runs one shutdown that denies approvals, then exits once", async () => {
    const waiting = seedSession(Date.now());
    waiting.approvals.set("approval-1", {
      id: "approval-1",
      toolCallId: "tool-1",
      toolName: "bash",
      input: {},
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      settle: (decision) => {
        approvalDecisions.push(decision);
        waiting.approvals.delete("approval-1");
      },
    });

    parentAlive = false;
    timers.tick(5_000);
    timers.tick(60_000);
    await shutdown();
    await Promise.resolve();

    expect(approvalDecisions).toEqual(["deny"]);
    expect(exits).toEqual([0]);
    expect(server.listening).toBe(false);
    // Nothing the lifecycle armed survives the shutdown.
    expect(timers.armed.size).toBe(0);
  });

  test("late callbacks and a second explicit shutdown do nothing", async () => {
    const late = seedSession(0);
    timers.tick(10 * 60_000);
    await shutdown();

    expect(late.session).not.toBeNull();
    expect(exits).toEqual([0]);
  });
});
