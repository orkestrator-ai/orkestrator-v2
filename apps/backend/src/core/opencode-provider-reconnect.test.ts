import { describe, expect, test } from "bun:test";
import { createNativeAgentProvider } from "./native-agent-provider.js";
import { openCodeFake, waitUntil, type OpenCodeFake } from "./agent-provider-test-support.js";

/**
 * The OpenCode event monitor's reconnect policy: consecutive failures back off
 * with capped jitter, only a stream that stayed up resets the ladder, and
 * there is never more than one pending retry.
 */
function monitoredProvider(fake: OpenCodeFake) {
  let offset = 0;
  const waits: number[] = [];
  let pendingWaits = 0;
  let maxPendingWaits = 0;
  let release: (() => void) | undefined;
  const provider = createNativeAgentProvider(
    {
      agent: "opencode",
      baseUrl: "http://opencode.test",
      authToken: "test-token",
      directory: "/workspace",
    },
    {
      openCodeClient: fake.client,
      monitorRetryMs: 100,
      monitorRetryMaxMs: 800,
      // The top of each jitter range, so the ladder itself is visible.
      monitorRetryRandom: () => 0.999_999,
      now: () => Date.now() + offset,
      waitForMonitorRetry: (ms, signal) => {
        // Mirrors the production wait: a monitor already disposed never waits.
        if (signal.aborted) return Promise.reject(signal.reason);
        waits.push(ms);
        pendingWaits += 1;
        maxPendingWaits = Math.max(maxPendingWaits, pendingWaits);
        return new Promise<void>((resolve, reject) => {
          const settle = () => {
            pendingWaits -= 1;
            release = undefined;
          };
          release = () => {
            settle();
            resolve();
          };
          signal.addEventListener(
            "abort",
            () => {
              settle();
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    },
  );
  return {
    provider,
    waits,
    maxPendingWaits: () => maxPendingWaits,
    advance: (ms: number) => {
      offset += ms;
    },
    /** Let the monitor's one pending retry run. */
    releaseRetry: () => release!(),
    /** End the live stream and let the monitor's one pending retry run. */
    async dropAndRetry() {
      const subscriptions = fake.subscriptions.length;
      const recorded = waits.length;
      fake.subscriptions.at(-1)!.close();
      await waitUntil(() => waits.length === recorded + 1);
      release!();
      await waitUntil(() => fake.subscriptions.length === subscriptions + 1);
    },
  };
}

describe("OpenCode monitor reconnect backoff", () => {
  test("streams that close immediately back off exponentially to the cap", async () => {
    const fake = openCodeFake();
    const monitor = monitoredProvider(fake);
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      for (let index = 0; index < 5; index += 1) await monitor.dropAndRetry();

      expect(monitor.waits).toEqual([100, 200, 400, 800, 800]);
      expect(monitor.maxPendingWaits()).toBe(1);
    } finally {
      await monitor.provider.dispose?.();
    }
  });

  test("failed subscriptions climb the same ladder", async () => {
    const fake = openCodeFake();
    fake.setSubscribeFailures(["throw", "missing-stream", "throw"]);
    const monitor = monitoredProvider(fake);
    try {
      for (const recorded of [1, 2, 3]) {
        await waitUntil(() => monitor.waits.length === recorded);
        monitor.releaseRetry();
      }
      await waitUntil(() => fake.subscriptions.length === 1);

      expect(fake.subscribeCallCount).toBe(4);
      expect(monitor.waits).toEqual([100, 200, 400]);
      expect(monitor.maxPendingWaits()).toBe(1);
    } finally {
      await monitor.provider.dispose?.();
    }
  });

  test("a stream that stayed up resets the ladder, so the next retry is fast again", async () => {
    const fake = openCodeFake();
    const monitor = monitoredProvider(fake);
    try {
      await waitUntil(() => fake.subscriptions.length === 1);
      await monitor.dropAndRetry();
      await monitor.dropAndRetry();
      await monitor.dropAndRetry();

      // This connection stays healthy long enough to count as recovered.
      fake.subscriptions.at(-1)!.push({ type: "server.connected", properties: {} });
      await waitUntil(() => monitor.provider.observationStreamLive?.() === true);
      monitor.advance(30_000);
      await monitor.dropAndRetry();
      await monitor.dropAndRetry();

      expect(monitor.waits).toEqual([100, 200, 400, 100, 200]);
    } finally {
      await monitor.provider.dispose?.();
    }
  });

  test("each outage still marks a gap and reconciles from a snapshot", async () => {
    const fake = openCodeFake();
    const monitor = monitoredProvider(fake);
    try {
      await monitor.provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      const reconciledBefore = fake.statusCallCount;
      const promptsBefore = fake.promptCalls.length;

      await monitor.dropAndRetry();

      // The replacement stream reconciles authoritative status; nothing is
      // resubmitted and nothing is answered on the monitor's behalf.
      await waitUntil(() => fake.statusCallCount > reconciledBefore);
      expect(fake.promptCalls).toHaveLength(promptsBefore);
      expect(fake.permissionReplies).toHaveLength(0);
    } finally {
      await monitor.provider.dispose?.();
    }
  });

  test("dispose cancels the pending retry and nothing reconnects afterwards", async () => {
    const fake = openCodeFake();
    const monitor = monitoredProvider(fake);
    await waitUntil(() => fake.subscriptions.length === 1);
    fake.subscriptions[0]!.close();
    await waitUntil(() => monitor.waits.length === 1);

    await monitor.provider.dispose?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fake.subscriptions).toHaveLength(1);
    expect(monitor.maxPendingWaits()).toBe(1);
  });
});

describe("OpenCode observation wakeups (step 07)", () => {
  test("a mid-stream failure marks a gap and reconciles after reconnect", async () => {
    const fake = openCodeFake();
    const monitor = monitoredProvider(fake);
    try {
      await monitor.provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      fake.subscriptions[0]!.push({ type: "server.connected", properties: {} });
      await waitUntil(() => monitor.provider.observationStreamLive?.() === true);
      const reads = fake.statusCallCount;
      fake.subscriptions[0]!.fail(new Error("stream dropped"));
      await waitUntil(() => monitor.waits.length === 1);
      expect(monitor.provider.observationStreamLive?.()).toBe(false);
      monitor.releaseRetry();
      await waitUntil(() => fake.subscriptions.length === 2);
      await waitUntil(() => fake.statusCallCount > reads);
      expect(monitor.provider.observationStreamLive?.()).toBe(false);
    } finally {
      await monitor.provider.dispose?.();
    }
  });
  test("reports its stream live only while connected and hints every owned-session change", async () => {
    const fake = openCodeFake();
    const hints: Array<string | undefined> = [];
    let release: (() => void) | undefined;
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: fake.client,
        monitorRetryMs: 1,
        onObservationHint: (sessionId) => hints.push(sessionId),
        waitForMonitorRetry: (_ms, signal) =>
          // Mirrors the production wait: a monitor already disposed never waits.
          signal.aborted
            ? Promise.reject(signal.reason)
            : new Promise<void>((resolve, reject) => {
                release = resolve;
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
      },
    );
    try {
      const owned = await provider.createSession("build", "Build task");
      await waitUntil(() => fake.subscriptions.length === 1);
      expect(provider.observationStreamLive?.()).toBe(false);
      expect(fake.subscriptionOptions[0]?.sseMaxRetryAttempts).toBe(1);
      fake.subscriptions[0]!.push({ type: "server.connected", properties: {} });
      await waitUntil(() => provider.observationStreamLive?.() === true);
      // A (re)connect may follow missed events: wake every owned session.
      expect(hints).toContain(undefined);

      hints.length = 0;
      const stream = fake.subscriptions[0]!;
      stream.push({
        type: "session.status",
        properties: { sessionID: owned, status: { type: "busy" } },
      });
      await waitUntil(() => hints.includes(owned));
      stream.push({
        type: "question.asked",
        properties: { id: "question-1", sessionID: owned, questions: [] },
      });
      await waitUntil(() => hints.filter((hint) => hint === owned).length >= 2);
      // Someone else's session is never hinted.
      stream.push({
        type: "session.status",
        properties: { sessionID: "foreign-session", status: { type: "busy" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(hints.every((hint) => hint === owned)).toBe(true);

      // Losing the stream: not live, and every owned session is woken.
      hints.length = 0;
      stream.close();
      await waitUntil(() => release !== undefined);
      expect(provider.observationStreamLive?.()).toBe(false);
      expect(hints).toEqual([undefined]);
      release!();
      await waitUntil(() => fake.subscriptions.length === 2);
      expect(provider.observationStreamLive?.()).toBe(false);
      fake.subscriptions[1]!.push({ type: "server.connected", properties: {} });
      await waitUntil(() => provider.observationStreamLive?.() === true);
    } finally {
      await provider.dispose?.();
    }
    expect(provider.observationStreamLive?.()).toBe(false);
  });

  test("is not live before its first connection", async () => {
    const fake = openCodeFake();
    fake.setSubscribeFailures(["throw"]);
    let release: (() => void) | undefined;
    const provider = createNativeAgentProvider(
      {
        agent: "opencode",
        baseUrl: "http://opencode.test",
        authToken: "test-token",
        directory: "/workspace",
      },
      {
        openCodeClient: fake.client,
        monitorRetryMs: 1,
        waitForMonitorRetry: (_ms, signal) =>
          // Mirrors the production wait: a monitor already disposed never waits.
          signal.aborted
            ? Promise.reject(signal.reason)
            : new Promise<void>((resolve, reject) => {
                release = resolve;
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
      },
    );
    try {
      await waitUntil(() => release !== undefined);
      expect(provider.observationStreamLive?.()).toBe(false);
    } finally {
      await provider.dispose?.();
    }
  });
});
