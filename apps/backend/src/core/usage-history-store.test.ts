import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";
import { usageDayKey } from "@orkestrator/protocol/usage-history";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { UsageHistoryStore } from "./usage-history-store.js";
import { MAX_RECORDED_TURN_IDS } from "./usage-history-record.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-usage-history-"));
  directories.push(directory);
  return directory;
}

function connect(dataDir: string): StorageDatabase {
  const database = openBackendDatabase(dataDir);
  databases.push(database);
  return database;
}

interface Clock {
  value: Date;
}

async function storeWithClock(clock: Clock, dataDir?: string) {
  const directory = dataDir ?? (await dataDirectory());
  const database = connect(directory);
  return {
    directory,
    store: new UsageHistoryStore({ database: () => database, now: () => clock.value }),
  };
}

function turn(id: string, overrides: Partial<NativeAgentTurnUsage> = {}): NativeAgentTurnUsage {
  return {
    turnId: id,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 1_000,
    cacheWriteTokens: 10,
    costUsd: 0.25,
    modelId: "claude-opus-5-5",
    ...overrides,
  };
}

test("records a turn once, however often the provider republishes it", async () => {
  const clock: Clock = { value: new Date("2026-10-20T10:00:00Z") };
  const { store } = await storeWithClock(clock);
  const input = {
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude" as const,
    turns: [turn("t1"), turn("t2")],
  };
  expect(store.recordTurns(input)).toBe(2);
  expect(store.recordTurns(input)).toBe(0);
  expect(store.recordTurns({ ...input, turns: [turn("t2"), turn("t3")] })).toBe(1);

  const report = store.report({ days: 7 });
  expect(report.totals.turns).toBe(3);
  expect(report.sessions).toBe(1);
  // Processed is rebuilt from the parts, never from a provider's own total.
  expect(report.totals.totalTokens).toBe(3 * (100 + 50 + 1_000 + 10));
  expect(report.totals.costUsd).toBeCloseTo(0.75, 10);
  expect(report.totals.unpricedTokens).toBe(0);
  expect(report.platforms).toEqual([expect.objectContaining({ platform: "claude", sessions: 1 })]);
  expect(report.models[0]?.modelId).toBe("claude-opus-5-5");
});

test("a turn with no price counts its tokens as unpriced", async () => {
  const clock: Clock = { value: new Date("2026-10-20T10:00:00Z") };
  const { store } = await storeWithClock(clock);
  store.recordTurns({
    sessionKey: "env-1:codex:tab-1",
    environmentId: "env-1",
    platform: "codex",
    turns: [turn("t1", { costUsd: undefined, modelId: "gpt-6.1" })],
  });
  const report = store.report({ days: 7 });
  expect(report.totals.costUsd).toBe(0);
  expect(report.totals.unpricedTokens).toBe(1_160);
});

test("buckets by local day and fills every day of the range", async () => {
  const clock: Clock = { value: new Date(2026, 9, 18, 9, 0, 0) };
  const { store } = await storeWithClock(clock);
  store.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t1")],
  });
  clock.value = new Date(2026, 9, 20, 9, 0, 0);
  store.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t2")],
  });

  const report = store.report({ days: 3 });
  expect(report.days.map((day) => day.day)).toEqual(["2026-10-18", "2026-10-19", "2026-10-20"]);
  expect(report.days[0]?.totals.turns).toBe(1);
  expect(report.days[1]?.totals.turns).toBe(0);
  expect(report.days[1]?.platforms).toEqual([]);
  expect(report.days[2]?.totals.turns).toBe(1);
  // One session spanning two days is still one session.
  expect(report.sessions).toBe(1);
  expect(report.recordingSince).toBe("2026-10-18");

  // A range that ends before the older day excludes it.
  const today = store.report({ days: 1 });
  expect(today.totals.turns).toBe(1);
  expect(today.fromDay).toBe(usageDayKey(clock.value));
});

test("filters by platform and by environment", async () => {
  const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
  const { store } = await storeWithClock(clock);
  store.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t1")],
  });
  store.recordTurns({
    sessionKey: "env-2:codex:tab-1",
    environmentId: "env-2",
    platform: "codex",
    turns: [turn("t2", { modelId: "gpt-6.1" })],
  });

  expect(store.report({ days: 7 }).sessions).toBe(2);
  expect(store.report({ days: 7 }).recordedPlatforms).toEqual(["claude", "codex"]);
  const claudeOnly = store.report({ days: 7, platform: "claude" });
  expect(claudeOnly.sessions).toBe(1);
  expect(claudeOnly.environments.map((entry) => entry.environmentId)).toEqual(["env-1"]);
  const envTwo = store.report({ days: 7, environmentId: "env-2" });
  expect(envTwo.sessions).toBe(1);
  expect(envTwo.platforms.map((entry) => entry.platform)).toEqual(["codex"]);
});

test("a second connection reads what the first recorded", async () => {
  const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
  const { store, directory } = await storeWithClock(clock);
  store.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t1")],
  });
  const other = await storeWithClock(clock, directory);
  expect(other.store.report({ days: 7 }).totals.turns).toBe(1);
  // The durable turn ids de-duplicate across processes, not only in memory.
  expect(
    other.store.recordTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [turn("t1")],
    }),
  ).toBe(0);
});

test("prunes day buckets past retention and drops rows left empty", async () => {
  const clock: Clock = { value: new Date(2026, 0, 1, 9, 0, 0) };
  const directory = await dataDirectory();
  const database = connect(directory);
  const store = new UsageHistoryStore({
    database: () => database,
    now: () => clock.value,
    limits: { retentionDays: 2 },
  });
  store.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t1")],
  });
  clock.value = new Date(2026, 0, 10, 9, 0, 0);
  expect(store.prune().prunedRows).toBe(1);
  expect(store.report({ days: 30 }).sessions).toBe(0);
});

test("keeps the turn-id window bounded", async () => {
  const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
  const { store } = await storeWithClock(clock);
  for (let index = 0; index < MAX_RECORDED_TURN_IDS + 10; index += 1) {
    store.recordTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [turn(`t${index}`)],
    });
  }
  const report = store.report({ days: 7 });
  expect(report.totals.turns).toBe(MAX_RECORDED_TURN_IDS + 10);
  // The oldest ids have left the window, so that turn would be counted twice;
  // the newest are still refused.
  expect(
    store.recordTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [turn(`t${MAX_RECORDED_TURN_IDS + 9}`)],
    }),
  ).toBe(0);
});

test("deletes one environment's rows on request only", async () => {
  const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
  const { store } = await storeWithClock(clock);
  store.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t1")],
  });
  store.recordTurns({
    sessionKey: "env-2:claude:tab-1",
    environmentId: "env-2",
    platform: "claude",
    turns: [turn("t2")],
  });
  expect(store.deleteByEnvironment("env-1")).toBe(1);
  const report = store.report({ days: 7 });
  expect(report.sessions).toBe(1);
  expect(report.environments.map((entry) => entry.environmentId)).toEqual(["env-2"]);
});

test("drops the least recently used rows above the row limit", async () => {
  const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
  const directory = await dataDirectory();
  const database = connect(directory);
  const store = new UsageHistoryStore({
    database: () => database,
    now: () => clock.value,
    limits: { maxRows: 2 },
  });
  for (const [index, tab] of ["tab-1", "tab-2", "tab-3"].entries()) {
    clock.value = new Date(2026, 9, 20, 9, index, 0);
    store.recordTurns({
      sessionKey: `env-1:claude:${tab}`,
      environmentId: "env-1",
      platform: "claude",
      turns: [turn(`t-${tab}`)],
    });
  }
  // The oldest row by `lastSeenAt` goes; the two newest survive intact.
  expect(store.prune()).toEqual({ prunedRows: 1, prunedDays: 0 });
  expect(store.report({ days: 7 }).sessions).toBe(2);
  expect(store.report({ days: 7 }).totals.turns).toBe(2);
});

test("reports where recording began and which platforms exist past every filter", async () => {
  const clock: Clock = { value: new Date(2026, 9, 1, 9, 0, 0) };
  const { store } = await storeWithClock(clock);
  store.recordTurns({
    sessionKey: "env-1:codex:tab-1",
    environmentId: "env-1",
    platform: "codex",
    turns: [turn("t1", { costUsd: 0 })],
  });
  clock.value = new Date(2026, 9, 20, 9, 0, 0);
  store.recordTurns({
    sessionKey: "env-2:claude:tab-1",
    environmentId: "env-2",
    platform: "claude",
    turns: [turn("t2")],
  });

  // Both describe the whole recording, so an environment filter must not
  // narrow them: the pane says history started earlier than the range it is
  // showing, and still offers a platform that ran somewhere else.
  const filtered = store.report({ days: 7, environmentId: "env-2" });
  expect(filtered.recordingSince).toBe("2026-10-01");
  expect(filtered.recordedPlatforms).toEqual(["claude", "codex"]);
  expect(filtered.environments.map((entry) => entry.environmentId)).toEqual(["env-2"]);
  expect(filtered.sessions).toBe(1);
  expect(store.report({ days: 7, platform: "claude" }).recordedPlatforms).toEqual([
    "claude",
    "codex",
  ]);
});

test("a report never prunes; retention is swept from the write path", async () => {
  const clock: Clock = { value: new Date(2026, 0, 1, 9, 0, 0) };
  const directory = await dataDirectory();
  const database = connect(directory);
  const limits = { retentionDays: 2 };
  const writer = new UsageHistoryStore({
    database: () => database,
    now: () => clock.value,
    limits,
  });
  writer.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t1")],
  });
  clock.value = new Date(2026, 0, 10, 9, 0, 0);
  // A store that has never swept — as a freshly started backend has not —
  // still only reads. A sweep here would cost the usage pane a second full
  // scan plus a write transaction per expired row before it could answer.
  const reader = new UsageHistoryStore({
    database: () => database,
    now: () => clock.value,
    limits,
  });
  expect(reader.report({ days: 30 }).recordingSince).toBe("2026-01-01");
  expect(reader.report({ days: 30 }).recordingSince).toBe("2026-01-01");
  // The sweep is what drops it.
  expect(reader.prune().prunedRows).toBe(1);
  expect(reader.report({ days: 30 }).recordingSince).toBeUndefined();
});

test("counts a turn number the next conversation in the same tab reuses", async () => {
  const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
  const { store } = await storeWithClock(clock);
  const session = {
    sessionKey: "env-1:grok:tab-1",
    environmentId: "env-1",
    platform: "grok" as const,
  };
  expect(
    store.recordTurns({ ...session, providerSessionId: "conv-a", turns: [turn("turn-1")] }),
  ).toBe(1);
  expect(
    store.recordTurns({ ...session, providerSessionId: "conv-a", turns: [turn("turn-1")] }),
  ).toBe(0);
  // A replaced conversation numbers its turns from one again.
  expect(
    store.recordTurns({ ...session, providerSessionId: "conv-b", turns: [turn("turn-1")] }),
  ).toBe(1);
  expect(store.report({ days: 1 }).totals.turns).toBe(2);
});

test("records a republished backlog on the days its turns actually ran", async () => {
  const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
  const { store } = await storeWithClock(clock);
  // The first projection of a conversation that already has history offers
  // every turn the provider still republishes. Each belongs to its own day.
  expect(
    store.recordTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [
        turn("t1", { at: new Date(2026, 9, 18, 11, 0, 0).toISOString() }),
        turn("t2", { at: new Date(2026, 9, 19, 11, 0, 0).toISOString() }),
        turn("t3", { at: new Date(2026, 9, 20, 8, 0, 0).toISOString() }),
      ],
    }),
  ).toBe(3);
  const report = store.report({ days: 7 });
  const busy = report.days.filter((point) => point.totals.turns > 0);
  expect(busy.map((point) => point.day)).toEqual(["2026-10-18", "2026-10-19", "2026-10-20"]);
  expect(report.totals.turns).toBe(3);
  expect(report.recordingSince).toBe("2026-10-18");
  // Only today's turn lands on today.
  expect(store.report({ days: 1 }).totals.turns).toBe(1);
});
