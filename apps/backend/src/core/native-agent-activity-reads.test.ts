import { describe, expect, test } from "bun:test";
import type {
  NativeAgentRuntimeProvider,
  ProviderActivityBatchEntry,
  ProviderActivityObservation,
} from "./agent-provider-contract.js";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import { type ActivityGroupRead, readActivityGroup } from "./native-agent-activity-reads.js";
import { deferred } from "./recurring-test-support.js";

interface Session {
  key: string;
  providerSessionId: string;
}

function sessions(count: number, prefix = "s"): Session[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `key-${prefix}-${index}`,
    providerSessionId: `${prefix}-${index}`,
  }));
}

function provider(overrides: Partial<NativeAgentRuntimeProvider>): NativeAgentRuntimeProvider {
  return overrides as NativeAgentRuntimeProvider;
}

/** Collect applied reads, asserting `apply` is never re-entered. */
function collector() {
  const applied = new Map<string, ActivityGroupRead>();
  const order: string[] = [];
  let active = 0;
  const apply = async (session: Session, read: ActivityGroupRead) => {
    active += 1;
    expect(active).toBe(1);
    await Promise.resolve();
    applied.set(session.key, read);
    order.push(session.providerSessionId);
    active -= 1;
  };
  return { applied, order, apply };
}

function batchProvider(
  answer: (ids: readonly string[]) => Map<string, ProviderActivityBatchEntry> | "unsupported",
  single?: (id: string) => Promise<ProviderActivityObservation>,
) {
  const batchCalls: string[][] = [];
  const singleCalls: string[] = [];
  return {
    batchCalls,
    singleCalls,
    provider: provider({
      observeActivityBatch: async (ids) => {
        batchCalls.push([...ids]);
        return answer(ids);
      },
      observeActivity: async (id) => {
        singleCalls.push(id);
        return single ? single(id) : { state: "idle" };
      },
    }),
  };
}

const allIdle = (ids: readonly string[]) =>
  new Map<string, ProviderActivityBatchEntry>(ids.map((id) => [id, { state: "idle" }]));

describe("readActivityGroup with a batch-capable provider", () => {
  for (const [count, chunks] of [
    [1, [1]],
    [10, [10]],
    [64, [64]],
    [65, [64, 1]],
    [100, [64, 36]],
  ] as const) {
    test(`${count} sessions are read in chunks of ${chunks.join("+")} with no single reads`, async () => {
      const { provider: p, batchCalls, singleCalls } = batchProvider(allIdle);
      const { applied, apply } = collector();
      const group = sessions(count);

      await readActivityGroup({ provider: p, sessions: group, apply });

      expect(batchCalls.map((ids) => ids.length)).toEqual([...chunks]);
      expect(new Set(batchCalls.flat())).toEqual(new Set(group.map((s) => s.providerSessionId)));
      expect(singleCalls).toEqual([]);
      expect(applied.size).toBe(count);
    });
  }

  test("carries the whole observation, and missing, through to apply", async () => {
    const observation: ProviderActivityObservation = {
      state: "working",
      readyForInput: true,
      asyncQuestionItemIds: ["q-1"],
    };
    const { provider: p } = batchProvider(
      () =>
        new Map<string, ProviderActivityBatchEntry>([
          ["s-0", observation],
          ["s-1", { state: "missing" }],
        ]),
    );
    const { applied, apply } = collector();

    await readActivityGroup({ provider: p, sessions: sessions(2), apply });

    expect(applied.get("key-s-0")).toEqual({ state: "working", observation });
    expect(applied.get("key-s-1")).toEqual({
      state: "missing",
      observation: { state: "missing" },
    });
  });

  test("an old bridge falls back to individual reads", async () => {
    const { provider: p, batchCalls, singleCalls } = batchProvider(() => "unsupported");
    const { applied, apply } = collector();

    await readActivityGroup({ provider: p, sessions: sessions(70), apply });

    expect(batchCalls.length).toBe(2);
    expect(singleCalls.length).toBe(70);
    expect(applied.size).toBe(70);
  });

  test("a rejected chunk is read individually for this sweep; the others stay batched", async () => {
    let call = 0;
    const batchCalls: number[] = [];
    const singleCalls: string[] = [];
    const p = provider({
      observeActivityBatch: async (ids) => {
        batchCalls.push(ids.length);
        call += 1;
        if (call === 1) throw new ProviderUnavailableError("bridge timed out");
        return allIdle(ids);
      },
      observeActivity: async (id) => {
        singleCalls.push(id);
        return { state: "working" };
      },
    });
    const { applied, apply } = collector();

    await readActivityGroup({ provider: p, sessions: sessions(100), apply, concurrency: 1 });

    expect(batchCalls).toEqual([64, 36]);
    // Only the chunk that failed, and never inferring anything from it.
    expect(singleCalls.length).toBe(64);
    expect(applied.size).toBe(100);
    expect(applied.get("key-s-0")?.state).toBe("working");
    expect(applied.get("key-s-99")?.state).toBe("idle");
  });

  test("an unavailable id fails the group but its peers are still applied", async () => {
    const { provider: p, singleCalls } = batchProvider(
      (ids) =>
        new Map<string, ProviderActivityBatchEntry>(
          ids.map((id) => [id, id === "s-1" ? "unavailable" : { state: "working" }]),
        ),
    );
    const { applied, apply } = collector();

    await expect(readActivityGroup({ provider: p, sessions: sessions(3), apply })).rejects.toThrow(
      ProviderUnavailableError,
    );

    // Uncertain, never read as idle or missing, and not retried individually.
    expect(applied.has("key-s-1")).toBe(false);
    expect([...applied.keys()].sort()).toEqual(["key-s-0", "key-s-2"]);
    expect(singleCalls).toEqual([]);
  });

  test("a deferred id is read through the single route", async () => {
    const { provider: p, singleCalls } = batchProvider(
      (ids) =>
        new Map<string, ProviderActivityBatchEntry>(
          ids.map((id) => [id, id === "s-1" ? "deferred" : { state: "idle" }]),
        ),
      async () => ({ state: "waiting", asyncQuestionItemIds: ["q-1"] }),
    );
    const { applied, apply } = collector();

    await readActivityGroup({ provider: p, sessions: sessions(2), apply });

    expect(singleCalls).toEqual(["s-1"]);
    expect(applied.get("key-s-1")?.observation?.asyncQuestionItemIds).toEqual(["q-1"]);
  });

  test("ids the protocol cannot carry use the single route; shared ids are asked once", async () => {
    const long = "x".repeat(2_000);
    const { provider: p, batchCalls, singleCalls } = batchProvider(allIdle);
    const { applied, apply } = collector();
    const group: Session[] = [
      { key: "a", providerSessionId: "shared" },
      { key: "b", providerSessionId: "shared" },
      { key: "c", providerSessionId: long },
    ];

    await readActivityGroup({ provider: p, sessions: group, apply });

    expect(batchCalls).toEqual([["shared"]]);
    expect(singleCalls).toEqual([long]);
    expect([...applied.keys()].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("readActivityGroup with individual reads", () => {
  test("a stalled session does not hold its peers back", async () => {
    const stall = deferred<ProviderActivityObservation>();
    const p = provider({
      observeActivity: (id) =>
        id === "s-0" ? stall.promise : Promise.resolve({ state: "working" as const }),
    });
    const { applied, apply } = collector();

    const reading = readActivityGroup({ provider: p, sessions: sessions(10), apply });
    const deadline = Date.now() + 1_000;
    while (applied.size < 9 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // Every peer is applied while the first session is still unanswered.
    expect(applied.size).toBe(9);
    expect(applied.has("key-s-0")).toBe(false);

    stall.resolve({ state: "idle" });
    await reading;
    expect(applied.get("key-s-0")?.state).toBe("idle");
  });

  test("bounds concurrent reads", async () => {
    let active = 0;
    let peak = 0;
    const p = provider({
      observeActivity: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { state: "idle" };
      },
    });
    const { apply } = collector();

    await readActivityGroup({ provider: p, sessions: sessions(20), apply });

    expect(peak).toBe(4);
  });

  test("stops starting reads after a failure and rethrows it", async () => {
    const reads: string[] = [];
    const p = provider({
      observeActivity: async (id) => {
        reads.push(id);
        if (id === "s-0") throw new ProviderUnavailableError("HTTP 503");
        return { state: "idle" };
      },
    });
    const { applied, apply } = collector();

    await expect(
      readActivityGroup({ provider: p, sessions: sessions(20), apply, concurrency: 2 }),
    ).rejects.toThrow("HTTP 503");

    // The failed read and the one already in flight beside it; no retry storm.
    expect(reads.length).toBeLessThanOrEqual(3);
    expect(applied.size).toBeLessThanOrEqual(2);
  });

  test("with onReadFailure, a failed read is reported alone and every other read runs", async () => {
    const reads: string[] = [];
    const p = provider({
      observeActivity: async (id) => {
        reads.push(id);
        if (id === "s-0") throw new ProviderUnavailableError("HTTP 503");
        return { state: "idle" };
      },
    });
    const { applied, apply } = collector();
    const failed: string[] = [];

    await readActivityGroup({
      provider: p,
      sessions: sessions(20),
      apply,
      concurrency: 2,
      onReadFailure: (session, error) => {
        expect(error).toBeInstanceOf(ProviderUnavailableError);
        failed.push(session.providerSessionId);
      },
    });

    expect(reads).toHaveLength(20);
    expect(failed).toEqual(["s-0"]);
    expect(applied.size).toBe(19);
  });

  test("falls back to the coarse status contract without observeActivity", async () => {
    const p = provider({
      status: async (id: string) =>
        id === "s-0" ? "blocked" : id === "s-1" ? "missing" : "running",
    });
    const { applied, apply } = collector();

    await readActivityGroup({ provider: p, sessions: sessions(3), apply });

    expect(applied.get("key-s-0")).toEqual({ state: "waiting" });
    expect(applied.get("key-s-1")).toEqual({ state: "missing" });
    expect(applied.get("key-s-2")).toEqual({ state: "working" });
  });
});

describe("readActivityGroup with a group-wide snapshot", () => {
  test("reads once and applies in group order, refusing an omitted session", async () => {
    const calls: string[][] = [];
    const p = provider({
      activityBatch: async (ids) => {
        calls.push([...ids]);
        return new Map([
          ["s-0", "working" as const],
          ["s-2", "idle" as const],
        ]);
      },
      observeActivity: async () => {
        throw new Error("must not be called");
      },
    });
    const { order, apply } = collector();

    await expect(readActivityGroup({ provider: p, sessions: sessions(3), apply })).rejects.toThrow(
      "omitted s-1",
    );
    expect(calls).toEqual([["s-0", "s-1", "s-2"]]);
    expect(order).toEqual(["s-0"]);
  });
});
