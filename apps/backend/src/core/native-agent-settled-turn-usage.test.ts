import { describe, expect, mock, test } from "bun:test";
import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import {
  SETTLED_USAGE_MAX_ATTEMPTS,
  SETTLED_USAGE_MAX_IN_FLIGHT,
  SETTLED_USAGE_MAX_WAITING,
  SettledTurnUsage,
  type SettledTurnUsageSession,
} from "./native-agent-settled-turn-usage.js";

/**
 * The settle-time usage gate on its own: which read it picks, and that no
 * settled turn's request is lost to an overlapping read, the in-flight cap,
 * a full queue or a failed read.
 */

function session(id: string): SettledTurnUsageSession {
  return {
    key: `env-1\0claude\0${id}`,
    environmentId: "env-1",
    agent: "claude",
    logicalSessionKey: id,
    providerSessionId: `provider-${id}`,
  };
}

function usage(...turnIds: string[]): NativeAgentContextUsage {
  return {
    usedTokens: 1,
    turns: turnIds.map((turnId) => ({ turnId, inputTokens: 1, outputTokens: 1 })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every queued promise reaction run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function recorder() {
  const observed: { key: string; turnIds: string[] }[] = [];
  const helper = new SettledTurnUsage({
    observe: (s, u) => {
      observed.push({ key: s.key, turnIds: (u?.turns ?? []).map((turn) => turn.turnId ?? "") });
    },
  });
  return { helper, observed };
}

describe("SettledTurnUsage", () => {
  test("observed per-turn usage is recorded without a provider read", async () => {
    const { helper, observed } = recorder();
    const sessionStateSnapshot = mock(async () => ({ status: "idle" as const }));
    helper.record(session("a"), { sessionStateSnapshot }, usage("t-1"));
    await settle();
    expect(observed).toEqual([{ key: session("a").key, turnIds: ["t-1"] }]);
    expect(sessionStateSnapshot).not.toHaveBeenCalled();
  });

  test("a provider whose cheap reads carry only the newest response is read in full anyway", async () => {
    const { helper, observed } = recorder();
    const recentTurnUsage = mock(async () => usage("t-1", "t-2"));
    helper.record(session("a"), { recentTurnUsage }, usage("t-2"));
    await settle();
    expect(recentTurnUsage).toHaveBeenCalledTimes(1);
    expect(observed.map((entry) => entry.turnIds)).toEqual([["t-2"], ["t-1", "t-2"]]);
  });

  test("the read is picked as recentTurnUsage, then the state snapshot, then refreshUsage", async () => {
    const { helper, observed } = recorder();
    const recentTurnUsage = mock(async () => usage("recent"));
    const sessionStateSnapshot = mock(async () => ({
      status: "idle" as const,
      contextUsage: usage("snapshot"),
    }));
    const refreshUsage = mock(async () => usage("refresh"));
    helper.record(session("a"), { recentTurnUsage, sessionStateSnapshot, refreshUsage });
    helper.record(session("b"), { sessionStateSnapshot, refreshUsage });
    helper.record(session("c"), { refreshUsage });
    await settle();
    const read = (id: string) => observed.find((entry) => entry.key === session(id).key)?.turnIds;
    expect([read("a"), read("b"), read("c")]).toEqual([["recent"], ["snapshot"], ["refresh"]]);
    expect(recentTurnUsage).toHaveBeenCalledTimes(1);
    expect(sessionStateSnapshot).toHaveBeenCalledTimes(1);
    expect(refreshUsage).toHaveBeenCalledTimes(1);
  });

  test("nothing is read without a provider, a provider session or a usage read", async () => {
    const { helper, observed } = recorder();
    helper.record(session("a"), undefined);
    helper.record(
      { ...session("b"), providerSessionId: "" },
      { refreshUsage: async () => usage() },
    );
    helper.record(session("c"), {});
    await settle();
    expect(observed).toEqual([]);
  });

  test("a turn that settles during its session's read gets one fresh read afterwards", async () => {
    const { helper, observed } = recorder();
    const first = deferred<NativeAgentContextUsage>();
    let reads = 0;
    const refreshUsage = mock(() => {
      reads += 1;
      return reads === 1 ? first.promise : Promise.resolve(usage("t-1", "t-2"));
    });
    helper.record(session("a"), { refreshUsage });
    // Turn 2 settles while turn 1's read, which cannot see it, is in flight;
    // a third settle in the same window still costs only one rerun.
    helper.record(session("a"), { refreshUsage });
    helper.record(session("a"), { refreshUsage });
    expect(refreshUsage).toHaveBeenCalledTimes(1);
    first.resolve(usage("t-1"));
    await settle();
    expect(refreshUsage).toHaveBeenCalledTimes(2);
    expect(observed.map((entry) => entry.turnIds)).toEqual([["t-1"], ["t-1", "t-2"]]);
  });

  test("past the in-flight cap a request waits for a slot instead of being dropped", async () => {
    const { helper, observed } = recorder();
    const gates = Array.from({ length: SETTLED_USAGE_MAX_IN_FLIGHT }, () =>
      deferred<NativeAgentContextUsage>(),
    );
    for (const [index, gate] of gates.entries()) {
      helper.record(session(`busy-${index}`), { refreshUsage: () => gate.promise });
    }
    const late = mock(async () => usage("late"));
    helper.record(session("late"), { refreshUsage: late });
    await settle();
    expect(late).not.toHaveBeenCalled();
    gates[0]!.resolve(usage("busy"));
    await settle();
    expect(late).toHaveBeenCalledTimes(1);
    expect(observed.some((entry) => entry.key === session("late").key)).toBe(true);
    for (const gate of gates) gate.resolve(usage());
    await settle();
  });

  test("a request pushed out of a full queue is owed and retried by the next read", async () => {
    const { helper, observed } = recorder();
    const gates = Array.from({ length: SETTLED_USAGE_MAX_IN_FLIGHT }, () =>
      deferred<NativeAgentContextUsage>(),
    );
    for (const [index, gate] of gates.entries()) {
      helper.record(session(`busy-${index}`), { refreshUsage: () => gate.promise });
    }
    const never = () => new Promise<NativeAgentContextUsage>(() => undefined);
    helper.record(session("evicted"), { refreshUsage: never });
    for (let index = 0; index < SETTLED_USAGE_MAX_WAITING; index += 1) {
      helper.record(session(`waiting-${index}`), { refreshUsage: async () => usage() });
    }
    expect(helper.owes(session("evicted").key)).toBe(true);
    for (const gate of gates) gate.resolve(usage());
    await settle();
    const retry = mock(async () => usage("evicted"));
    helper.retryOwed(session("evicted"), { refreshUsage: retry });
    await settle();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(helper.owes(session("evicted").key)).toBe(false);
    expect(observed.some((entry) => entry.turnIds[0] === "evicted")).toBe(true);
  });

  test("a failed read never throws, is owed, and is retried until it succeeds", async () => {
    const { helper, observed } = recorder();
    const failing = mock(async (): Promise<NativeAgentContextUsage> => {
      throw new Error("bridge unavailable");
    });
    expect(() => helper.record(session("a"), { refreshUsage: failing })).not.toThrow();
    await settle();
    expect(helper.owes(session("a").key)).toBe(true);
    expect(observed).toEqual([]);

    // Nothing owed: a retry for another session reads nothing.
    const unrelated = mock(async () => usage("x"));
    helper.retryOwed(session("b"), { refreshUsage: unrelated });
    expect(unrelated).not.toHaveBeenCalled();

    helper.retryOwed(session("a"), { refreshUsage: async () => usage("t-1") });
    await settle();
    expect(helper.owes(session("a").key)).toBe(false);
    expect(observed).toEqual([{ key: session("a").key, turnIds: ["t-1"] }]);
  });

  test("a session whose reads keep failing is abandoned after a bounded number of attempts", async () => {
    const { helper } = recorder();
    const failing = mock(async (): Promise<NativeAgentContextUsage> => {
      throw new Error("bridge unavailable");
    });
    helper.record(session("a"), { refreshUsage: failing });
    await settle();
    for (let attempt = 1; attempt < SETTLED_USAGE_MAX_ATTEMPTS; attempt += 1) {
      expect(helper.owes(session("a").key)).toBe(true);
      helper.retryOwed(session("a"), { refreshUsage: failing });
      await settle();
    }
    expect(failing).toHaveBeenCalledTimes(SETTLED_USAGE_MAX_ATTEMPTS);
    expect(helper.owes(session("a").key)).toBe(false);
  });
});
