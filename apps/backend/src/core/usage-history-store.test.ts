import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";
import { usageDayKey } from "@orkestrator/protocol/usage-history";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { USAGE_HISTORY_STORE } from "./usage-history-layout.js";
import {
  USAGE_HISTORY_PRUNE_BATCH_ROWS,
  USAGE_REPORT_CACHE_MAX_BYTES,
  USAGE_REPORT_CACHE_MAX_ENTRIES,
  UsageHistoryStore,
} from "./usage-history-store.js";
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
  expect((await store.prune()).prunedRows).toBe(1);
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
  expect(await store.prune()).toEqual({ prunedRows: 1, prunedDays: 0 });
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
  expect((await reader.prune()).prunedRows).toBe(1);
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

test("names stamped on an environment's rows survive later turns and name its report entry", async () => {
  const clock: Clock = { value: new Date("2026-10-20T10:00:00Z") };
  const { store } = await storeWithClock(clock);
  const base = { environmentId: "env-1", platform: "claude" as const };
  store.recordTurns({ ...base, sessionKey: "env-1:claude:tab-1", turns: [turn("t1")] });
  store.recordTurns({ ...base, sessionKey: "env-1:claude:tab-2", turns: [turn("t2")] });
  store.recordTurns({
    sessionKey: "env-2:claude:tab-1",
    environmentId: "env-2",
    platform: "claude",
    turns: [turn("t3")],
  });

  expect(store.report({ days: 7 }).environments.every((entry) => !entry.name)).toBe(true);
  const label = { environmentName: "Feature branch", projectName: "Orkestrator" };
  expect(store.labelEnvironment("env-1", label)).toBe(2);
  // The same label again writes nothing.
  expect(store.labelEnvironment("env-1", label)).toBe(0);
  // A turn recorded after the stamp keeps it: the row is re-parsed on write.
  store.recordTurns({ ...base, sessionKey: "env-1:claude:tab-1", turns: [turn("t4")] });

  const report = store.report({ days: 7 });
  expect(report.environments.find((entry) => entry.environmentId === "env-1")).toMatchObject({
    name: "Feature branch",
    projectName: "Orkestrator",
  });
  expect(report.environments.find((entry) => entry.environmentId === "env-2")?.name).toBe(
    undefined,
  );
  // A filtered read still names the environment.
  expect(store.report({ days: 7, environmentId: "env-1" }).environments[0]?.name).toBe(
    "Feature branch",
  );
});

test("a label bounds its names and leaves an omitted one as it was", async () => {
  const clock: Clock = { value: new Date("2026-10-20T10:00:00Z") };
  const { store } = await storeWithClock(clock);
  store.recordTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [turn("t1")],
  });
  store.labelEnvironment("env-1", { environmentName: "x".repeat(500), projectName: "Project" });
  store.labelEnvironment("env-1", { environmentName: "  Renamed  " });
  const [entry] = store.report({ days: 7 }).environments;
  expect(entry).toMatchObject({ name: "Renamed", projectName: "Project" });
  store.labelEnvironment("env-1", { environmentName: "y".repeat(500) });
  expect(store.report({ days: 7 }).environments[0]?.name?.length).toBe(200);
  expect(store.labelEnvironment("missing", { environmentName: "Nobody" })).toBe(0);
});

for (const label of [{ environmentName: "New environment" }, { projectName: "New project" }]) {
  test(`newest row's partial label wins as a whole: ${JSON.stringify(label)}`, async () => {
    const clock: Clock = { value: new Date("2026-10-20T10:00:00Z") };
    const { store } = await storeWithClock(clock);
    store.recordTurns({
      sessionKey: "env-1:claude:older",
      environmentId: "env-1",
      platform: "claude",
      turns: [turn("old")],
    });
    store.labelEnvironment("env-1", {
      environmentName: "Old environment",
      projectName: "Old project",
    });
    clock.value = new Date("2026-10-21T10:00:00Z");
    store.recordTurns({
      sessionKey: "env-1:codex:newer",
      environmentId: "env-1",
      platform: "codex",
      turns: [turn("new")],
    });
    // Stamp only the new partial name. The older row retains its other name.
    store.labelEnvironment("env-1", label);
    for (const platform of [undefined, "claude", "codex"] as const) {
      const [entry] = store.report({ days: 7, platform }).environments;
      expect(entry?.name).toBe(label.environmentName);
      expect(entry?.projectName).toBe(label.projectName);
      expect(entry?.totals.turns).toBe(platform ? 1 : 2);
    }
  });
}

describe("the retention sweep's batches", () => {
  const NOW = new Date(2026, 9, 20, 9, 0, 0);
  const OLD_DAY = "2025-01-01";
  const LIVE_DAY = usageDayKey(NOW);
  const bucket = { models: { model: { inputTokens: 1, totalTokens: 1, turns: 1 } } };

  function seed(database: StorageDatabase, count: number, days: (index: number) => string[]) {
    const rows: Record<string, unknown> = {};
    for (let index = 0; index < count; index += 1) {
      rows[`row-${String(index).padStart(5, "0")}`] = {
        version: 1,
        environmentId: `env-${index % 3}`,
        platform: "claude",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
        days: Object.fromEntries(days(index).map((day) => [day, bucket])),
        turnIds: [],
      };
    }
    database.writeStore(USAGE_HISTORY_STORE, rows);
  }

  /** Counts outermost transactions, each one commit, and the rows each writes. */
  function countCommits(database: StorageDatabase): {
    commits: () => number;
    restore: () => void;
  } {
    const transaction = database.transaction.bind(database);
    let depth = 0;
    let commits = 0;
    const spy = spyOn(database, "transaction").mockImplementation((<T>(run: () => T): T => {
      if (depth === 0) commits += 1;
      depth += 1;
      try {
        return transaction(run);
      } finally {
        depth -= 1;
      }
    }) as typeof database.transaction);
    return { commits: () => commits, restore: () => spy.mockRestore() };
  }

  async function fixture(limits?: { maxRows?: number }) {
    const database = connect(await dataDirectory());
    const store = new UsageHistoryStore({ database: () => database, now: () => NOW, limits });
    return { database, store };
  }

  const stored = (database: StorageDatabase, key: string) =>
    JSON.parse(database.rows(USAGE_HISTORY_STORE).get(key) ?? "null") as {
      days: Record<string, unknown>;
      turnIds: string[];
      lastSeenAt: string;
    } | null;

  test("commits a bounded batch at a time and frees the event loop between them", async () => {
    const { database, store } = await fixture();
    const count = USAGE_HISTORY_PRUNE_BATCH_ROWS * 2 + 50;
    seed(database, count, (index) => (index % 2 === 0 ? [OLD_DAY] : [OLD_DAY, LIVE_DAY]));
    const { commits, restore } = countCommits(database);
    let turns = 0;
    const counting = setInterval(() => {
      turns += 1;
    }, 0);
    try {
      const pruned = await store.prune();
      expect(pruned).toEqual({
        prunedRows: Math.ceil(count / 2),
        prunedDays: Math.floor(count / 2),
      });
    } finally {
      clearInterval(counting);
      restore();
    }
    // One read-free commit per batch, not one per changed row.
    expect(commits()).toBe(3);
    expect(turns).toBeGreaterThan(0);
    expect(database.rows(USAGE_HISTORY_STORE).list({ values: false })).toHaveLength(
      Math.floor(count / 2),
    );
  });

  test("a turn recorded during the sweep is not lost", async () => {
    const { database, store } = await fixture();
    const count = USAGE_HISTORY_PRUNE_BATCH_ROWS + 10;
    seed(database, count, () => [OLD_DAY, LIVE_DAY]);
    const later = `row-${String(count - 1).padStart(5, "0")}`;

    // The first batch ran before `prune` first yields; `later` is in the second.
    const sweep = store.prune();
    store.recordTurns({
      sessionKey: later,
      environmentId: "env-1",
      platform: "claude",
      turns: [turn("recorded-during-sweep")],
    });
    await sweep;

    const row = stored(database, later)!;
    expect(row.turnIds).toEqual(["recorded-during-sweep"]);
    expect(Object.keys(row.days)).toEqual([LIVE_DAY]);
  });

  test("a row refreshed during the sweep is not dropped as least recently used", async () => {
    const { database, store } = await fixture({ maxRows: 5 });
    const count = USAGE_HISTORY_PRUNE_BATCH_ROWS + 10;
    seed(database, count, () => [LIVE_DAY]);
    // The oldest by `lastSeenAt`, and already visited by the first batch.
    const oldest = "row-00000";

    const original = stored(database, oldest)!;
    const clock = spyOn(store as unknown as { now: () => Date }, "now").mockReturnValue(
      new Date(original.lastSeenAt),
    );
    const sweep = store.prune();
    store.recordTurns({
      sessionKey: oldest,
      environmentId: "env-0",
      platform: "claude",
      turns: [turn("refreshing")],
    });
    clock.mockRestore();
    const { prunedRows } = await sweep;

    expect(stored(database, oldest)?.turnIds).toEqual(["refreshing"]);
    expect(prunedRows).toBe(count - 5 - 1);
  });

  test("an unreadable row is left alone and the rest are swept", async () => {
    const { database, store } = await fixture();
    seed(database, 3, () => [OLD_DAY]);
    database.db
      .query("UPDATE store_rows SET value = '{ not json' WHERE store = ? AND key = 'row-00001'")
      .run(USAGE_HISTORY_STORE);
    database.db
      .query("UPDATE store_rows SET value = '[1]' WHERE store = ? AND key = 'row-00002'")
      .run(USAGE_HISTORY_STORE);
    database.db
      .query("UPDATE stores SET revision = revision + 1 WHERE name = ?")
      .run(USAGE_HISTORY_STORE);

    expect(await store.prune()).toEqual({ prunedRows: 1, prunedDays: 0 });
    expect(
      database
        .rows(USAGE_HISTORY_STORE)
        .list({ values: false })
        .map((entry) => entry.key),
    ).toEqual(["row-00001", "row-00002"]);
  });

  test("a failure rolls back its batch, leaves the store readable and the next sweep finishes", async () => {
    const { database, store } = await fixture();
    const count = USAGE_HISTORY_PRUNE_BATCH_ROWS * 2;
    seed(database, count, () => [OLD_DAY]);
    const update = database.updateStoreRow.bind(database);
    let calls = 0;
    const failing = spyOn(database, "updateStoreRow").mockImplementation(((
      ...args: Parameters<typeof update>
    ) => {
      calls += 1;
      if (calls === USAGE_HISTORY_PRUNE_BATCH_ROWS + 5) throw new Error("disk full");
      return update(...args);
    }) as typeof update);
    try {
      await expect(store.prune()).rejects.toThrow("disk full");
    } finally {
      failing.mockRestore();
    }
    // The first batch stays committed; none of the second does.
    expect(database.rows(USAGE_HISTORY_STORE).list({ values: false })).toHaveLength(
      USAGE_HISTORY_PRUNE_BATCH_ROWS,
    );
    expect(database.readStore(USAGE_HISTORY_STORE)).not.toBeNull();
    expect((await store.prune()).prunedRows).toBe(USAGE_HISTORY_PRUNE_BATCH_ROWS);
  });

  test("the write path survives a sweep that fails", async () => {
    const { database, store } = await fixture();
    seed(database, 2, () => [OLD_DAY]);
    const failing = spyOn(database, "transaction");
    const update = database.updateStoreRow.bind(database);
    const row = spyOn(database, "updateStoreRow");
    let calls = 0;
    row.mockImplementation(((...args: Parameters<typeof update>) => {
      calls += 1;
      if (calls > 1) throw new Error("disk full");
      return update(...args);
    }) as typeof update);
    try {
      expect(
        store.recordTurns({
          sessionKey: "row-new",
          environmentId: "env-0",
          platform: "claude",
          turns: [turn("t1")],
        }),
      ).toBe(1);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      row.mockRestore();
      failing.mockRestore();
    }
    expect(stored(database, "row-new")?.turnIds).toEqual(["t1"]);
  });

  test("a connection closed between batches ends the sweep without reopening", async () => {
    const directory = await dataDirectory();
    const database = connect(directory);
    let opened = 0;
    const store = new UsageHistoryStore({
      database: () => {
        opened += 1;
        return database;
      },
      now: () => NOW,
    });
    seed(database, USAGE_HISTORY_PRUNE_BATCH_ROWS + 10, () => [OLD_DAY]);

    const sweep = store.prune();
    database.close();

    expect(await sweep).toEqual({ prunedRows: USAGE_HISTORY_PRUNE_BATCH_ROWS, prunedDays: 0 });
    expect(opened).toBe(1);
    const reopened = connect(directory);
    expect(reopened.rows(USAGE_HISTORY_STORE).list({ values: false })).toHaveLength(10);
  });
});

describe("the finished report cache", () => {
  async function seeded(clock: Clock) {
    const directory = await dataDirectory();
    const database = connect(directory);
    const store = new UsageHistoryStore({ database: () => database, now: () => clock.value });
    store.recordTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [turn("t1")],
    });
    const rows = spyOn(database, "rows");
    return { directory, database, store, rows };
  }

  function cacheOf(store: UsageHistoryStore) {
    return store as unknown as {
      reportCache: Map<string, unknown>;
      reportCacheBytes: number;
    };
  }

  test("a repeat query answers from the finished report without reading a row", async () => {
    const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
    const { store, rows } = await seeded(clock);
    const first = store.report({ days: 7 });
    expect(rows).toHaveBeenCalledTimes(1);
    clock.value = new Date(2026, 9, 20, 9, 5, 0);
    const second = store.report({ days: 7 });
    expect(rows).toHaveBeenCalledTimes(1);
    expect({ ...second, generatedAt: first.generatedAt }).toEqual(first);
    expect(second.generatedAt).toBe(clock.value.toISOString());
    // Each query keeps its own report; filters are part of the key.
    expect(store.report({ days: 7, environmentId: "env-2" }).sessions).toBe(0);
    expect(rows).toHaveBeenCalledTimes(2);
    expect(store.report({ days: 30 }).sessions).toBe(1);
    expect(rows).toHaveBeenCalledTimes(3);
  });

  test("a caller changing its copy cannot change the next answer", async () => {
    const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
    const { store } = await seeded(clock);
    const first = store.report({ days: 7 });
    first.totals.turns = 999;
    first.environments.length = 0;
    const second = store.report({ days: 7 });
    expect(second.totals.turns).toBe(1);
    expect(second.environments).toHaveLength(1);
    second.days.length = 0;
    expect(store.report({ days: 7 }).days).toHaveLength(7);
  });

  test("every write, from this connection or another, invalidates it", async () => {
    const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
    const { store, directory } = await seeded(clock);
    expect(store.report({ days: 7 }).totals.turns).toBe(1);

    store.recordTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [turn("t2")],
    });
    expect(store.report({ days: 7 }).totals.turns).toBe(2);

    store.labelEnvironment("env-1", { environmentName: "renamed" });
    expect(store.report({ days: 7 }).environments[0]?.name).toBe("renamed");

    const other = await storeWithClock(clock, directory);
    other.store.recordTurns({
      sessionKey: "env-3:codex:tab-1",
      environmentId: "env-3",
      platform: "codex",
      turns: [turn("t9")],
    });
    expect(store.report({ days: 7 }).sessions).toBe(2);

    store.deleteByEnvironment("env-3");
    expect(store.report({ days: 7 }).sessions).toBe(1);
  });

  test("a day rollover invalidates it with no write", async () => {
    const clock: Clock = { value: new Date(2026, 9, 20, 23, 59, 0) };
    const { store, rows } = await seeded(clock);
    const before = store.report({ days: 1 });
    expect(before.totals.turns).toBe(1);
    clock.value = new Date(2026, 9, 21, 0, 1, 0);
    const after = store.report({ days: 1 });
    expect(rows).toHaveBeenCalledTimes(2);
    expect(after.toDay).toBe(usageDayKey(clock.value));
    expect(after.totals.turns).toBe(0);
  });

  test("is bounded by entry count and bytes", async () => {
    const clock: Clock = { value: new Date(2026, 9, 20, 9, 0, 0) };
    const { store } = await seeded(clock);
    for (let index = 0; index < USAGE_REPORT_CACHE_MAX_ENTRIES + 8; index++) {
      store.report({ days: 7, environmentId: `env-${index}` });
    }
    const cache = cacheOf(store);
    expect(cache.reportCache.size).toBe(USAGE_REPORT_CACHE_MAX_ENTRIES);
    expect(cache.reportCacheBytes).toBeGreaterThan(0);
    expect(cache.reportCacheBytes).toBeLessThanOrEqual(USAGE_REPORT_CACHE_MAX_BYTES);
    // The oldest queries were evicted, the newest kept.
    expect(cache.reportCache.has(JSON.stringify([7, null, "env-0"]))).toBe(false);
    expect(
      cache.reportCache.has(JSON.stringify([7, null, `env-${USAGE_REPORT_CACHE_MAX_ENTRIES + 7}`])),
    ).toBe(true);
    store.clearReportCache();
    expect(cache.reportCache.size).toBe(0);
    expect(cache.reportCacheBytes).toBe(0);
  });
});
