/**
 * Store write benchmark (docs/architecture/storage.md).
 *
 * Generates the named workload in a temporary data directory, never a real one,
 * then times each write path and reports rows written, lease writes and, for the
 * usage prune, commits and the longest event-loop stall. Results are local
 * measurements, not guarantees.
 *
 * Workload `store-writes-v1`:
 * - native sessions: 2,000 records, each with 200 dispatched request ids;
 * - terminal sessions: 5,000 rows, 10 in each of 500 environments;
 * - projects: 500 rows;
 * - display tails: 64 rows of 1 MiB, the store's size limit;
 * - interaction journal: empty;
 * - agent mail: 500 mailboxes of 50 messages with 2 KiB bodies, nothing pending;
 * - usage history: 20,000 rows, a quarter wholly past retention and a quarter
 *   with one expired day.
 *
 * `--core` reads the storage code from another tree, so two versions can be
 * compared on one host:
 *
 *   git archive <commit> apps/backend/package.json apps/backend/src/core \
 *     | tar -x -C output/benchmarks/store-before
 *   bun scripts/benchmark-store-writes.ts --core=output/benchmarks/store-before/apps/backend/src/core
 *
 *   bun scripts/benchmark-store-writes.ts [--runs=50] [--core=<dir>] [--json]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function arg(name: string, fallback: string): string {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

process.env.NODE_ENV = "test";
const runs = Number(arg("runs", "50"));
const asJson = process.argv.includes("--json");
const core = path.resolve(arg("core", path.join(import.meta.dir, "../apps/backend/src/core")));

const { StorageService, createEnvironment } = await import(path.join(core, "storage.ts"));
const { seedStore, storageDatabase } = await import(path.join(core, "storage-test-support.ts"));
const { openBackendDatabase } = await import(path.join(core, "storage-stores.ts"));
const { UsageHistoryStore } = await import(path.join(core, "usage-history-store.ts"));
const { USAGE_HISTORY_STORE } = await import(path.join(core, "usage-history-layout.ts"));
const { NATIVE_AGENT_DISPLAY_TAIL_STORE } = await import(
  path.join(core, "native-agent-display-tail-layout.ts")
);

interface Result {
  path: string;
  p50Ms: number;
  p95Ms: number;
  rowsPerRun: number;
  leaseWritesPerRun: number;
  note?: string;
}

const results: Result[] = [];

function percentile(values: number[], quantile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function withStorage(
  name: string,
  run: (storage: InstanceType<typeof StorageService>, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = mkdtempSync(path.join(tmpdir(), `ork-store-writes-${name}-`));
  const storage = new StorageService(dataDir);
  try {
    await storage.init();
    await run(storage, dataDir);
  } finally {
    await storage.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** Counts this connection's row and lease writes with temporary triggers. */
function writeCounter(storage: InstanceType<typeof StorageService>) {
  const { db } = storageDatabase(storage);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS bench_writes (kind TEXT NOT NULL)");
  for (const [table, kind] of [
    ["store_rows", "row"],
    ["leases", "lease"],
  ]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS bench_${table}_${event}
        AFTER ${event} ON main.${table}
        BEGIN INSERT INTO bench_writes VALUES ('${kind}'); END`);
    }
  }
  const count = (kind: string): number =>
    (
      db.query("SELECT count(*) AS count FROM bench_writes WHERE kind = ?").get(kind) as {
        count: number;
      }
    ).count;
  return { count, reset: () => db.exec("DELETE FROM bench_writes") };
}

async function measure(
  storage: InstanceType<typeof StorageService>,
  name: string,
  count: number,
  operation: (run: number) => unknown,
  note?: string,
): Promise<void> {
  const writes = writeCounter(storage);
  writes.reset();
  const times: number[] = [];
  for (let run = 0; run < count; run += 1) {
    const start = performance.now();
    await operation(run);
    times.push(performance.now() - start);
  }
  results.push({
    path: name,
    p50Ms: round(percentile(times, 0.5)),
    p95Ms: round(percentile(times, 0.95)),
    rowsPerRun: round(writes.count("row") / count),
    leaseWritesPerRun: round(writes.count("lease") / count),
    ...(note ? { note } : {}),
  });
}

async function nativeSessions(): Promise<void> {
  await withStorage("native", async (storage, dataDir) => {
    const environment = await storage.addEnvironment(createEnvironment("project-1"));
    const template = await storage.getOrCreateNativeAgentSession(
      {
        key: "template",
        environmentId: environment.id,
        agent: "claude",
        logicalSessionKey: "template",
      },
      async () => "provider-template",
    );
    const sessions: Record<string, unknown> = {};
    for (let index = 0; index < 2_000; index += 1) {
      const key = `native-${index}`;
      sessions[key] = {
        ...template,
        key,
        logicalSessionKey: `tab-${index}`,
        providerSessionId: `provider-${index}`,
        dispatchedRequestIds: Array.from(
          { length: 200 },
          (_, request) => `request-${index}-${request}`,
        ),
      };
    }
    seedStore(dataDir, "native-agent-sessions.json", sessions);
    const expected = await storage.getNativeAgentSession("native-0");
    if (!expected) throw new Error("The generated native session does not validate");
    await measure(storage, "native: activity checkpoint", runs, (run) =>
      storage.recordNativeAgentActivityTurn(expected, run % 2 === 0 ? "active" : "settled"),
    );
    await measure(storage, "native: activity checkpoint, no change", runs, () =>
      storage.recordNativeAgentActivityTurn(expected, "settled"),
    );
    await measure(storage, "native: dispatch journal", runs, (run) =>
      storage.dispatchNativeAgentPromptOnce("native-1", `new-${run}`, async () => undefined),
    );
  });
}

async function terminalSessions(): Promise<void> {
  await withStorage("sessions", async (storage, dataDir) => {
    const sessions = Array.from({ length: 5_000 }, (_, index) => ({
      id: `session-${index}`,
      environmentId: `environment-${Math.floor(index / 10)}`,
      containerId: `container-${Math.floor(index / 10)}`,
      tabId: `tab-${index}`,
      sessionType: "plain",
      status: "connected",
      createdAt: "2026-11-01T00:00:00.000Z",
      lastActivityAt: "2026-11-01T00:00:00.000Z",
      order: index % 10,
    }));
    seedStore(dataDir, "sessions.json", sessions);
    await measure(storage, "session: one field", runs, (run) =>
      storage.updateSession("session-0", { name: `name-${run}` }),
    );
    await measure(
      storage,
      "session: create",
      runs,
      async (run) => {
        await storage.createSession("environment-1", "container-1", `new-${run}`, "plain");
        for (const session of await storage.getSessionsByEnvironment("environment-1")) {
          if (session.tabId === `new-${run}`) await storage.removeSession(session.id);
        }
      },
      "create, read the environment's rows and remove",
    );
    await measure(storage, "session: disconnect environment", 100, (run) =>
      storage.disconnectEnvironmentSessions(`environment-${run + 100}`),
    );
    await measure(storage, "session: reorder environment", runs, (run) => {
      const ids = Array.from({ length: 10 }, (_, index) => `session-${20 + index}`);
      if (run % 2 === 0) ids.reverse();
      return storage.reorderSessions("environment-2", ids);
    });
  });
}

async function projects(): Promise<void> {
  await withStorage("projects", async (storage, dataDir) => {
    const value = Array.from({ length: 500 }, (_, index) => ({
      id: `project-${index}`,
      name: `project-${index}`,
      gitUrl: `https://example.com/project-${index}.git`,
      localPath: null,
      addedAt: "2026-11-01T00:00:00.000Z",
      order: index,
    }));
    seedStore(dataDir, "projects.json", value);
    await measure(storage, "project: one field", runs, (run) =>
      storage.updateProject("project-0", { name: `name-${run}` }),
    );
    await measure(storage, "project: remote URL", runs, (run) =>
      storage.updateProject("project-1", { gitUrl: `https://example.com/moved-${run}.git` }),
    );
    await measure(storage, "project: read one", runs, () => storage.getProject("project-2"));
    await measure(storage, "project: add and remove", runs, async (run) => {
      const id = `new-${run}`;
      await storage.addProject({
        id,
        name: id,
        gitUrl: `https://example.com/${id}.git`,
        localPath: null,
        addedAt: "2026-11-01T00:00:00.000Z",
        order: 0,
      });
      await storage.removeProject(id);
    });
    const ids = value.map((project) => project.id);
    await measure(storage, "project: move one to the end", 10, () => {
      ids.push(ids.shift()!);
      return storage.reorderProjects(ids);
    });
  });
}

async function displayTailSizes(): Promise<void> {
  await withStorage("tails", async (storage, dataDir) => {
    const database = openBackendDatabase(dataDir);
    try {
      database.transaction(() => {
        const rows = database.rows(NATIVE_AGENT_DISPLAY_TAIL_STORE);
        for (let index = 0; index < 64; index += 1) {
          rows.put(`tail-${index}`, JSON.stringify({ text: "x".repeat(1024 * 1024) }));
        }
      });
    } finally {
      database.close();
    }
    const rows = storageDatabase(storage).rows(NATIVE_AGENT_DISPLAY_TAIL_STORE);
    await measure(storage, "listing: 64 rows of 1 MiB, sizes only", runs, () =>
      rows.list({ values: false }),
    );
  });
}

async function readOnlyLeases(): Promise<void> {
  await withStorage("journal", async (storage) => {
    await measure(storage, "journal: read", runs, () =>
      storage.getAgentInteractionResolutionJournal(),
    );
  });
  await withStorage("mail", async (storage, dataDir) => {
    const mailboxes: Record<string, unknown> = {};
    for (let index = 0; index < 500; index += 1) {
      mailboxes[`mailbox-${index}`] = {
        mailboxId: `mailbox-${index}`,
        messages: Array.from({ length: 50 }, (_, message) => ({
          id: `message-${index}-${message}`,
          placement: "delivered",
          body: "x".repeat(2048),
        })),
      };
    }
    seedStore(dataDir, "agent-mail.json", {
      version: 1,
      revision: 0,
      mailboxes,
      idempotency: {},
      pendingInject: [],
      counterparts: {},
    });
    await measure(storage, "mail: backoff reset, nothing to reset", runs, () =>
      storage.resetAgentMailInjectBackoff("mailbox-0"),
    );
  });
}

async function usagePrune(): Promise<void> {
  const today = new Date();
  const dayKey = (daysAgo: number): string => {
    const day = new Date(today);
    day.setDate(day.getDate() - daysAgo);
    const month = String(day.getMonth() + 1).padStart(2, "0");
    return `${day.getFullYear()}-${month}-${String(day.getDate()).padStart(2, "0")}`;
  };
  const totals = { inputTokens: 10, outputTokens: 10, totalTokens: 20, turns: 1 };
  const durations: number[] = [];
  const stalls: number[] = [];
  const longestCommits: number[] = [];
  const commits: number[] = [];
  let pruned = { prunedRows: 0, prunedDays: 0 };
  for (let run = 0; run < 3; run += 1) {
    await withStorage("usage", async (storage) => {
      const database = storageDatabase(storage);
      const rows: Record<string, unknown> = {};
      for (let index = 0; index < 20_000; index += 1) {
        const kind = index % 4;
        const days =
          kind === 0
            ? { [dayKey(500)]: { models: { model: totals } } }
            : kind === 1
              ? {
                  [dayKey(500)]: { models: { model: totals } },
                  [dayKey(1)]: { models: { model: totals } },
                }
              : { [dayKey(1)]: { models: { model: totals } } };
        rows[`usage-${index}`] = {
          version: 1,
          environmentId: `environment-${index % 500}`,
          platform: "claude",
          firstSeenAt: "2026-11-01T00:00:00.000Z",
          lastSeenAt: "2026-11-01T00:00:00.000Z",
          days,
          turnIds: Array.from({ length: 20 }, (_, turn) => `turn-${turn}`),
        };
      }
      database.writeStore(USAGE_HISTORY_STORE, rows);
      const store = new UsageHistoryStore({ database: () => database });

      // Outermost transactions are commits; nesting is a savepoint.
      const transaction = database.transaction.bind(database);
      let depth = 0;
      let commitCount = 0;
      let longestCommit = 0;
      database.transaction = <T>(fn: () => T): T => {
        if (depth > 0) return transaction(fn);
        depth = 1;
        const start = performance.now();
        try {
          return transaction(fn);
        } finally {
          depth = 0;
          commitCount += 1;
          longestCommit = Math.max(longestCommit, performance.now() - start);
        }
      };
      let last = performance.now();
      let stall = 0;
      const watchdog = setInterval(() => {
        const now = performance.now();
        stall = Math.max(stall, now - last);
        last = now;
      }, 1);
      const start = performance.now();
      last = start;
      await new Promise((resolve) => setImmediate(resolve));
      pruned = await store.prune();
      const end = performance.now();
      stall = Math.max(stall, end - last);
      clearInterval(watchdog);
      durations.push(end - start);
      stalls.push(stall);
      commits.push(commitCount);
      longestCommits.push(longestCommit);
    });
  }
  results.push({
    path: "usage: prune",
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    rowsPerRun: pruned.prunedRows + pruned.prunedDays,
    leaseWritesPerRun: 0,
    note: `commits ${percentile(commits, 0.5)}, longest stall ${round(percentile(stalls, 0.5))} ms, longest commit ${round(percentile(longestCommits, 0.5))} ms`,
  });
}

const start = performance.now();
await nativeSessions();
await terminalSessions();
await projects();
await displayTailSizes();
await readOnlyLeases();
await usagePrune();

if (asJson) {
  console.log(JSON.stringify({ workload: "store-writes-v1", core, runs, results }, null, 2));
} else {
  console.log(`Workload store-writes-v1, ${runs} runs per path, code from ${core}`);
  console.log(`bun ${Bun.version}, ${process.platform} ${process.arch}, data in ${tmpdir()}`);
  console.log("path | p50 ms | p95 ms | rows written | lease writes | note");
  for (const result of results) {
    console.log(
      `${result.path} | ${result.p50Ms} | ${result.p95Ms} | ${result.rowsPerRun} | ${result.leaseWritesPerRun} | ${result.note ?? ""}`,
    );
  }
  console.log(`Total ${round((performance.now() - start) / 1000)} s`);
}
