import { describe, expect, test } from "bun:test";
import type { PersistedPromptQueue } from "./models.js";
import {
  NativeQueueScheduling,
  discoverNativeQueues,
  nativeQueueObligation,
} from "./native-agent-queue-scheduling.js";
import { ManualTime, deferred, type Deferred } from "./recurring-test-support.js";

function queue(queueKey: string, fields: Partial<PersistedPromptQueue> = {}): PersistedPromptQueue {
  return { queueKey, environmentId: "env-1", messages: [], ...fields } as PersistedPromptQueue;
}

/**
 * A fake storage + drain. `drain` models the service's drain: it reads the
 * queue, notes it, and dispatches the head only when the session is idle —
 * each message exactly once, whatever the number of concurrent wakes.
 */
class Host {
  readonly queues = new Map<string, PersistedPromptQueue>();
  readonly dispatched: string[] = [];
  readonly drains: string[] = [];
  busy = new Set<string>();
  retryAt = new Map<string, number>();
  pendingLaunches = 0;
  launchScans = 0;
  listCalls = 0;
  inFlight = 0;
  peakPerKey = 0;
  gate: Deferred<void> | null = null;
  scheduling!: NativeQueueScheduling;
  private readonly running = new Map<string, number>();

  constructor(private readonly time: ManualTime) {}

  async launchScan() {
    this.launchScans += 1;
    return this.pendingLaunches;
  }

  async listQueues() {
    this.listCalls += 1;
    return [...this.queues.values()];
  }

  async drainQueue(queueKey: string) {
    this.drains.push(queueKey);
    const running = (this.running.get(queueKey) ?? 0) + 1;
    this.running.set(queueKey, running);
    this.peakPerKey = Math.max(this.peakPerKey, running);
    try {
      if (this.gate) await this.gate.promise;
      const current = this.queues.get(queueKey) ?? null;
      this.scheduling.note(current, queueKey);
      if (!current || current.dispatchError || this.busy.has(queueKey)) return;
      const [head, ...rest] = current.messages as string[];
      if (head === undefined) return;
      this.dispatched.push(head);
      this.queues.set(queueKey, { ...current, messages: rest });
      this.busy.add(queueKey);
      this.scheduling.note(this.queues.get(queueKey)!, queueKey);
    } finally {
      this.running.set(queueKey, (this.running.get(queueKey) ?? 1) - 1);
    }
  }

  queueRetryDelayMs(queueKey: string) {
    return Math.max(0, (this.retryAt.get(queueKey) ?? 0) - this.time.now());
  }
}

function setup(discoveryIntervalMs = 30_000) {
  const time = new ManualTime(0);
  const host = new Host(time);
  host.scheduling = new NativeQueueScheduling(host, {
    progressIntervalMs: 2_000,
    discoveryIntervalMs,
    now: time.now,
    timers: time.timerFactory,
  });
  return { time, host, scheduling: host.scheduling };
}

describe("native queue obligations", () => {
  test("pending and reserved native queues owe work; parked, empty and tmux queues do not", () => {
    expect(nativeQueueObligation(queue("codex\0tab", { messages: ["a"] }))).toBe("pending");
    expect(
      nativeQueueObligation(
        queue("codex\0tab", {
          inFlight: { message: "a", requestId: "r", reservedAt: new Date(0).toISOString() },
        }),
      ),
    ).toBe("in-flight");
    expect(
      nativeQueueObligation(
        queue("codex\0tab", { messages: ["a"], dispatchError: "parked" } as never),
      ),
    ).toBeNull();
    expect(nativeQueueObligation(queue("codex\0tab"))).toBeNull();
    expect(nativeQueueObligation(queue("claude-tmux\0tab", { messages: ["a"] }))).toBeNull();
    expect(
      discoverNativeQueues([queue("codex\0a", { messages: ["x"] }), queue("pi\0b")]).entries,
    ).toEqual([{ key: "codex\0a", obligation: "pending", target: "env-1" }]);
  });
});

describe("NativeQueueScheduling", () => {
  test("a busy queue is rechecked every 2 s; idle history is listed only by discovery", async () => {
    const { time, host, scheduling } = setup();
    for (let index = 0; index < 100; index += 1)
      host.queues.set(`codex\0old-${index}`, queue(`codex\0old-${index}`));
    host.queues.set("codex\0tab", queue("codex\0tab", { messages: ["first", "second"] }));
    host.busy.add("codex\0tab");
    scheduling.start();
    await time.advance(60_000);
    // Discovery at start, 30 s, 60 s — instead of thirty whole-store scans.
    expect(host.listCalls).toBe(3);
    expect(host.drains.filter((key) => key === "codex\0tab").length).toBeGreaterThanOrEqual(29);
    expect(host.drains.every((key) => key === "codex\0tab")).toBe(true);
    expect(host.dispatched).toEqual([]);
    // The turn ends with the edge lost: the 2 s fallback still dispatches.
    host.busy.delete("codex\0tab");
    await time.advance(2_000);
    expect(host.dispatched).toEqual(["first"]);
    scheduling.stop();
  });

  test("simultaneous enqueue wakes coalesce and each message dispatches once", async () => {
    const { time, host, scheduling } = setup();
    scheduling.start();
    await time.advance(0);
    host.queues.set("codex\0tab", queue("codex\0tab", { messages: ["only"] }));
    host.gate = deferred();
    for (let index = 0; index < 5; index += 1) scheduling.wakeQueue("codex\0tab", "enqueue");
    await time.advance(0);
    scheduling.queueChanged("env-1");
    scheduling.wakeQueue("codex\0tab", "enqueue");
    host.gate.resolve();
    host.gate = null;
    await time.advance(10_000);
    expect(host.peakPerKey).toBe(1);
    expect(host.dispatched).toEqual(["only"]);
    scheduling.stop();
  });

  test("a queue backing off waits for its backoff, then is retried", async () => {
    const { time, host, scheduling } = setup();
    host.queues.set("codex\0tab", queue("codex\0tab", { messages: ["m"] }));
    host.retryAt.set("codex\0tab", 9_000);
    scheduling.start();
    await time.advance(8_000);
    expect(host.dispatched).toEqual([]);
    await time.advance(2_000);
    expect(host.dispatched).toEqual(["m"]);
    scheduling.stop();
  });

  test("a parked (ambiguous) dispatch stays parked until an explicit change", async () => {
    const { time, host, scheduling } = setup();
    host.queues.set(
      "codex\0tab",
      queue("codex\0tab", { messages: ["m"], dispatchError: "ambiguous" } as never),
    );
    scheduling.start();
    await time.advance(60_000);
    expect(host.drains).toEqual([]);
    // The user retries: a queue mutation, announced for its environment.
    host.queues.set("codex\0tab", queue("codex\0tab", { messages: ["m"] }));
    scheduling.queueChanged("env-1");
    await time.advance(0);
    expect(host.dispatched).toEqual(["m"]);
    scheduling.stop();
  });

  test("an enqueue by another writer is found by the discovery it brings forward", async () => {
    const { time, host, scheduling } = setup();
    scheduling.start();
    await time.advance(0);
    host.queues.set("codex\0other", queue("codex\0other", { messages: ["m"] }));
    scheduling.queueChanged("env-1");
    await time.advance(0);
    expect(host.dispatched).toEqual(["m"]);
    scheduling.stop();
  });

  test("launch intent is progressed every 2 s while pending and woken by environment changes", async () => {
    const { time, host, scheduling } = setup();
    host.pendingLaunches = 1;
    scheduling.start();
    await time.advance(10_000);
    expect(host.launchScans).toBe(5);
    host.pendingLaunches = 0;
    await time.advance(40_000);
    // One more pass saw nothing pending; then the safety cadence applies.
    expect(host.launchScans).toBe(7);
    scheduling.wakeEnvironment("env-1");
    await time.advance(0);
    expect(host.launchScans).toBe(8);
    scheduling.stop();
  });
});
