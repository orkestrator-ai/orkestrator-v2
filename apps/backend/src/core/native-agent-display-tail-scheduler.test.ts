import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  NativeAgentDisplayTailScheduler,
  type DisplayTailSchedulerOptions,
} from "./native-agent-display-tail-scheduler.js";
import { NativeAgentDisplayTailStore } from "./native-agent-display-tail-store.js";
import {
  createNativeAgentDisplayTail,
  type NativeAgentDisplayTail,
} from "./native-agent-display-tails.js";

/** Deterministic timers: `advance` fires due callbacks in order and drains microtasks. */
class FakeTimers {
  now = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  set = (callback: () => void, delayMs: number): unknown => {
    const id = (this.sequence += 1);
    this.timers.set(id, { due: this.now + delayMs, callback });
    return id;
  };

  clear = (timer: unknown): void => {
    this.timers.delete(timer as number);
  };

  get pending(): number {
    return this.timers.size;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    while (true) {
      const next = Array.from(this.timers.entries())
        .filter(([, timer]) => timer.due <= target)
        .sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].due);
      next[1].callback();
      await flushMicrotasks();
    }
    this.now = target;
    await flushMicrotasks();
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

/** Waits (real time, bounded) until every pending/in-flight checkpoint settled. */
async function idle(scheduler: NativeAgentDisplayTailScheduler): Promise<void> {
  for (let attempt = 0; attempt < 1_000 && scheduler.size > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(scheduler.size).toBe(0);
}

function tail(content: string, environmentId = "env-1", provider = "provider-1") {
  const created = createNativeAgentDisplayTail({
    environmentId,
    agent: "codex",
    logicalSessionKey: "tab-1",
    providerSessionId: provider,
    historyEpoch: "epoch-1",
    messages: [{ id: "m1", role: "assistant", content }],
    historyComplete: true,
    updatedAt: new Date(0).toISOString(),
  });
  if (!created) throw new Error("tail too large");
  return created;
}

interface Written {
  key: string;
  content: unknown;
  fence: number;
  at: number;
}

function harness(overrides: Partial<DisplayTailSchedulerOptions> = {}) {
  const timers = new FakeTimers();
  const written: Written[] = [];
  let builds = 0;
  let fence = 0;
  const scheduler = new NativeAgentDisplayTailScheduler({
    write: async (key, value, capturedFence) => {
      written.push({
        key,
        content: (value.messages[0] as { content: string }).content,
        fence: capturedFence,
        at: timers.now,
      });
      return true;
    },
    captureFence: () => fence,
    clock: () => timers.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...overrides,
  });
  const update = (key: string, content: string, environmentId = "env-1") =>
    scheduler.update(key, {
      environmentId,
      build: () => {
        builds += 1;
        return tail(content, environmentId);
      },
    });
  return {
    timers,
    written,
    scheduler,
    update,
    builds: () => builds,
    bumpFence: () => (fence += 1),
  };
}

describe("NativeAgentDisplayTailScheduler", () => {
  test("checkpoints after the quiet period with one pending latest value per key", async () => {
    const { timers, written, update, builds, scheduler } = harness();
    for (let index = 0; index < 50; index += 1) update("key", `v${index}`);
    await timers.advance(1_999);
    expect(written).toEqual([]);
    await timers.advance(1);
    expect(written.map((entry) => entry.content)).toEqual(["v49"]);
    // Stripping/serialization ran once for 50 updates.
    expect(builds()).toBe(1);
    expect(scheduler.stats()).toMatchObject({ updates: 50, coalesced: 49, writes: 1 });
    expect(scheduler.size).toBe(0);
    expect(timers.pending).toBe(0);
  });

  test("continuous streaming still checkpoints within the maximum age", async () => {
    const { timers, written, update } = harness();
    let dirtySince = 0;
    let lastCheckpointed = -1;
    const ages: number[] = [];
    for (let tick = 0; tick < 70; tick += 1) {
      update("key", `v${tick}`);
      const before = written.length;
      await timers.advance(500);
      if (written.length > before) {
        ages.push(written.at(-1)!.at - dirtySince);
        lastCheckpointed = tick;
        dirtySince = timers.now;
      }
    }
    // 35 seconds of updates every 500 ms never has a 2 s quiet period, yet
    // checkpoints land at the 10 s maximum age.
    expect(written.length).toBe(3);
    expect(Math.max(...ages)).toBeLessThanOrEqual(10_000);
    expect(lastCheckpointed).toBeGreaterThan(55);
    // After the stream stops, the newest value lands after the quiet period,
    // so a restart preview is at most quiet-period stale.
    await timers.advance(2_000);
    expect(written.at(-1)!.content).toBe("v69");
  });

  test("an update during a write produces exactly one trailing write", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contents: string[] = [];
    const { timers, update } = harness({
      write: async (_key, value) => {
        contents.push((value.messages[0] as { content: string }).content);
        if (contents.length === 1) await gate;
        return true;
      },
    });
    update("key", "first");
    await timers.advance(2_000);
    expect(contents).toEqual(["first"]);
    update("key", "second");
    update("key", "third");
    await timers.advance(5_000);
    expect(contents).toEqual(["first"]);
    release();
    await flushMicrotasks();
    // The deadline passed during the write, so the trailing write is immediate.
    expect(contents).toEqual(["first", "third"]);
    await timers.advance(20_000);
    expect(contents).toEqual(["first", "third"]);
  });

  test("shares a small write pool and bounds pending keys", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const { timers, update, scheduler } = harness({
      maxConcurrentWrites: 2,
      maxPendingKeys: 5,
      write: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return true;
      },
    });
    for (let index = 0; index < 6; index += 1) update(`key-${index}`, `v${index}`);
    expect(scheduler.stats().droppedAdmission).toBe(1);
    await timers.advance(2_000);
    expect(inFlight).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      await flushMicrotasks();
    }
    expect(peak).toBe(2);
    expect(scheduler.stats().writes).toBe(5);
  });

  test("deletion discards pending state so a late timer cannot write", async () => {
    let listener!: (
      event: { kind: "key"; key: string } | { kind: "environment"; environmentId: string },
    ) => void;
    const { timers, written, update, scheduler } = harness({
      subscribeDeletions: (callback) => {
        listener = callback;
        return () => undefined;
      },
    });
    update("key-a", "a", "env-1");
    update("key-b", "b", "env-2");
    update("key-c", "c", "env-2");
    listener({ kind: "key", key: "key-a" });
    listener({ kind: "environment", environmentId: "env-2" });
    await timers.advance(30_000);
    expect(written).toEqual([]);
    expect(scheduler.stats().discarded).toBe(3);
    expect(scheduler.size).toBe(0);
  });

  test("carries the fence captured at update time to the write", async () => {
    const { timers, written, update, bumpFence } = harness();
    update("key", "old");
    bumpFence();
    await timers.advance(2_000);
    expect(written[0]?.fence).toBe(0);
    update("key", "new");
    await timers.advance(2_000);
    expect(written[1]?.fence).toBe(1);
  });

  test("shutdown stops accepting, attempts each newest value once, and honours its deadline", async () => {
    const { update, written, scheduler } = harness();
    update("key-a", "a1");
    update("key-a", "a2");
    update("key-b", "b1");
    const report = await scheduler.shutdown(1_000);
    expect(report).toEqual({ attempted: 2, written: 2, skipped: 0 });
    expect(written.map((entry) => entry.content).sort()).toEqual(["a2", "b1"]);
    update("key-a", "after-stop");
    expect(scheduler.stats().droppedAfterStop).toBe(1);
    expect(scheduler.size).toBe(0);

    const stuck = harness({
      maxConcurrentWrites: 1,
      write: () => new Promise<boolean>(() => undefined),
    });
    stuck.update("key-1", "one");
    stuck.update("key-2", "two");
    const startedAt = Date.now();
    const stuckReport = await stuck.scheduler.shutdown(30);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(stuckReport).toEqual({ attempted: 2, written: 0, skipped: 2 });
  });
});

describe("display-tail scheduler with keyed storage", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  async function wired() {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-display-tail-scheduler-"));
    directories.push(dataDir);
    const store = new NativeAgentDisplayTailStore({
      directory: path.join(dataDir, "records"),
      legacyFile: path.join(dataDir, "native-agent-display-tails.json"),
    });
    const timers = new FakeTimers();
    let gate: Promise<void> | null = null;
    const scheduler = new NativeAgentDisplayTailScheduler({
      write: async (key, value, fence) => {
        if (gate) await gate;
        return store.put(key, value, { fence });
      },
      captureFence: () => store.captureFence(),
      subscribeDeletions: (listener) => store.onDeleted(listener),
      clock: () => timers.now,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    const update = (key: string, value: NativeAgentDisplayTail) =>
      scheduler.update(key, { environmentId: value.environmentId, build: () => value });
    return {
      store,
      timers,
      scheduler,
      update,
      hold: () => {
        let release!: () => void;
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        return () => {
          gate = null;
          release();
        };
      },
    };
  }

  test("deletion during an in-flight write wins and no later checkpoint resurrects it", async () => {
    const { store, timers, scheduler, update, hold } = await wired();
    const release = hold();
    update("key", tail("streaming"));
    await timers.advance(2_000);
    update("key", tail("newer"));
    await store.delete("key");
    release();
    await flushMicrotasks();
    await idle(scheduler);
    await timers.advance(30_000);
    expect(await store.get("key")).toBeNull();
    expect(scheduler.size).toBe(0);
  });

  test("session replacement persists only the new provider generation", async () => {
    const { store, timers, update, scheduler } = await wired();
    update("key", tail("old generation", "env-1", "provider-old"));
    // The old session is invalidated (its tail deleted) and a new provider
    // session takes the same logical key before the timer fires.
    await store.delete("key");
    update("key", tail("new generation", "env-1", "provider-new"));
    await timers.advance(2_000);
    await idle(scheduler);
    const persisted = await store.get("key");
    expect(persisted?.providerSessionId).toBe("provider-new");
    expect(persisted?.messages).toEqual([
      { id: "m1", role: "assistant", content: "new generation" },
    ]);
  });

  test("environment deletion racing a due write and eviction leaves nothing behind", async () => {
    const { store, timers, update, scheduler } = await wired();
    for (let index = 0; index < 4; index += 1) {
      update(`key-${index}`, tail(`v${index}`, index % 2 === 0 ? "env-a" : "env-b"));
    }
    await timers.advance(2_000);
    await store.deleteByEnvironment("env-a");
    update("key-0", tail("late", "env-a"));
    await store.deleteByEnvironment("env-a");
    await timers.advance(2_000);
    await idle(scheduler);
    expect(await store.get("key-0")).toBeNull();
    expect(await store.get("key-2")).toBeNull();
    expect((await store.get("key-1"))?.environmentId).toBe("env-b");
  });
});
