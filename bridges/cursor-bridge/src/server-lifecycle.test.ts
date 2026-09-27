import { afterAll, describe, expect, test } from "bun:test";
import { FakeIntervals } from "@orkestrator/protocol/fake-intervals";

// `config.ts` reads its environment once, at import, so everything below is
// loaded after this suite's environment is in place.
process.env.HOSTNAME = "127.0.0.1";
process.env.CURSOR_BRIDGE_TOKEN = "test-token";
delete process.env.CURSOR_BRIDGE_STATE_DIR;

const { server, start, shutdown } = await import("./server.js");
const { newSessionState } = await import("./agent-session.js");
const { settleIdleDetaches } = await import("./idle-detach.js");
const { attachFake } = await import("./testing/fake-agent.js");
const { sessions } = await import("./state.js");

/**
 * One lifecycle per module: the bridge's registries are module-global and
 * shutdown is terminal, so this file drives a single start → parent death
 * sequence and asserts each stage along the way.
 */
const timers = new FakeIntervals();
let parentAlive = true;
const exits: number[] = [];

afterAll(async () => {
  await shutdown();
});

function seedSession(lastAccessed: number) {
  const state = newSessionState();
  attachFake(state);
  state.lastAccessed = lastAccessed;
  sessions.set(state.id, state);
  return state;
}

describe("Cursor bridge server lifecycle", () => {
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

  test("the armed sweep detaches an idle session and keeps one with a background child", async () => {
    const idle = seedSession(0);
    const background = seedSession(0);
    background.activeSubagentDescriptors.set("child-1", { description: "still writing" });

    timers.tick(60_000);
    expect(idle.agent).toBeNull();
    await settleIdleDetaches();

    expect(background.agent).not.toBeNull();
  });

  test("parent death runs one shutdown, releases every agent, then exits once", async () => {
    const attached = seedSession(Date.now());

    parentAlive = false;
    timers.tick(5_000);
    timers.tick(60_000);
    await shutdown();
    await Promise.resolve();

    expect(attached.agent).toBeNull();
    expect(exits).toEqual([0]);
    expect(server.listening).toBe(false);
    // Nothing the lifecycle armed survives the shutdown.
    expect(timers.armed.size).toBe(0);
  });

  test("late callbacks and a second explicit shutdown do nothing", async () => {
    const late = seedSession(0);
    timers.tick(10 * 60_000);
    await shutdown();

    expect(late.agent).not.toBeNull();
    expect(exits).toEqual([0]);
  });
});
