import { expect, test } from "bun:test";
import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import { RECORDER_TURN_MEMORY, UsageHistoryRecorder } from "./usage-history-recorder.js";

function usage(...turnIds: string[]): NativeAgentContextUsage {
  return {
    usedTokens: 0,
    turns: turnIds.map((turnId) => ({ turnId, inputTokens: 10, costUsd: 0.1 })),
  };
}

test("writes each turn once and never writes an unchanged read", async () => {
  const writes: string[][] = [];
  const recorder = new UsageHistoryRecorder({
    write: ({ turns }) => {
      writes.push((turns ?? []).map((turn) => turn.turnId));
      return turns?.length ?? 0;
    },
  });
  const input = { sessionKey: "s1", environmentId: "e1", platform: "claude" as const };
  recorder.observe({ ...input, usage: usage("t1", "t2") });
  recorder.observe({ ...input, usage: usage("t1", "t2") });
  recorder.observe({ ...input, usage: usage("t2", "t3") });
  await recorder.drain();
  expect(writes).toEqual([["t1", "t2"], ["t3"]]);
});

test("ignores a usage snapshot with no turns", async () => {
  let calls = 0;
  const recorder = new UsageHistoryRecorder({
    write: () => {
      calls += 1;
      return 0;
    },
  });
  const input = { sessionKey: "s1", environmentId: "e1", platform: "codex" as const };
  recorder.observe({ ...input, usage: undefined });
  recorder.observe({ ...input, usage: { usedTokens: 10 } });
  recorder.observe({ ...input, usage: { usedTokens: 10, turns: [] } });
  recorder.observe({ ...input, usage: usage("t1"), sessionKey: "" });
  await recorder.drain();
  expect(calls).toBe(0);
});

test("a failed write is logged, not thrown, and does not stop the next one", async () => {
  const seen: string[][] = [];
  let first = true;
  const recorder = new UsageHistoryRecorder({
    write: ({ turns }) => {
      if (first) {
        first = false;
        return Promise.reject(new Error("database busy"));
      }
      seen.push((turns ?? []).map((turn) => turn.turnId));
      return 1;
    },
  });
  const input = { sessionKey: "s1", environmentId: "e1", platform: "pi" as const };
  recorder.observe({ ...input, usage: usage("t1") });
  recorder.observe({ ...input, usage: usage("t2") });
  await recorder.drain();
  expect(seen).toEqual([["t2"]]);
});

test("bounds what it remembers per session", async () => {
  const writes: string[][] = [];
  const recorder = new UsageHistoryRecorder({
    write: ({ turns }) => {
      writes.push((turns ?? []).map((turn) => turn.turnId));
      return turns?.length ?? 0;
    },
  });
  const input = { sessionKey: "s1", environmentId: "e1", platform: "claude" as const };
  for (let index = 0; index <= RECORDER_TURN_MEMORY; index += 1) {
    recorder.observe({ ...input, usage: usage(`t${index}`) });
  }
  await recorder.drain();
  expect(writes).toHaveLength(RECORDER_TURN_MEMORY + 1);
  // The oldest id has left the memory, so the gate offers it again; the row's
  // own turn ids are what refuse it.
  recorder.observe({ ...input, usage: usage("t0") });
  await recorder.drain();
  expect(writes[writes.length - 1]).toEqual(["t0"]);
});

test("offers the turns again after a write that did not land", async () => {
  const writes: string[][] = [];
  let failing = true;
  const recorder = new UsageHistoryRecorder({
    write: ({ turns }) => {
      writes.push((turns ?? []).map((turn) => turn.turnId));
      if (failing) {
        failing = false;
        throw new Error("store busy");
      }
      return turns?.length ?? 0;
    },
  });
  const input = { sessionKey: "s1", environmentId: "e1", platform: "claude" as const };
  recorder.observe({ ...input, usage: usage("t1") });
  await recorder.drain();
  // Nothing reached the row, so the next read must offer the same turn again
  // rather than dropping it for the life of the process.
  recorder.observe({ ...input, usage: usage("t1") });
  await recorder.drain();
  expect(writes).toEqual([["t1"], ["t1"]]);
  // Once written, it is refused as before.
  recorder.observe({ ...input, usage: usage("t1") });
  await recorder.drain();
  expect(writes).toEqual([["t1"], ["t1"]]);
});

test("a failed write releases only its own turns", async () => {
  const writes: string[][] = [];
  const recorder = new UsageHistoryRecorder({
    write: ({ turns }) => {
      const ids = (turns ?? []).map((turn) => turn.turnId);
      writes.push(ids);
      if (ids.includes("t2")) throw new Error("store busy");
      return ids.length;
    },
  });
  const input = { sessionKey: "s1", environmentId: "e1", platform: "claude" as const };
  recorder.observe({ ...input, usage: usage("t1") });
  recorder.observe({ ...input, usage: usage("t1", "t2") });
  await recorder.drain();
  recorder.observe({ ...input, usage: usage("t1", "t2") });
  await recorder.drain();
  expect(writes).toEqual([["t1"], ["t2"], ["t2"]]);
});

test("scopes turn ids by conversation, so a reused number is still written", async () => {
  const writes: Array<{ conversation?: string; ids: string[] }> = [];
  const recorder = new UsageHistoryRecorder({
    write: ({ providerSessionId, turns }) => {
      writes.push({ conversation: providerSessionId, ids: (turns ?? []).map((t) => t.turnId) });
      return turns?.length ?? 0;
    },
  });
  const input = { sessionKey: "s1", environmentId: "e1", platform: "grok" as const };
  recorder.observe({ ...input, providerSessionId: "conv-a", usage: usage("turn-1") });
  recorder.observe({ ...input, providerSessionId: "conv-a", usage: usage("turn-1") });
  recorder.observe({ ...input, providerSessionId: "conv-b", usage: usage("turn-1") });
  await recorder.drain();
  expect(writes).toEqual([
    { conversation: "conv-a", ids: ["turn-1"] },
    { conversation: "conv-b", ids: ["turn-1"] },
  ]);
});
