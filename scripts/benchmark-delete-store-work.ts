/**
 * Delete-path store, session and reconcile benchmark
 * (docs/architecture/environment-deletion.md, "Watches and the event loop").
 *
 * Runs the real `delete_environment` command against a temporary data
 * directory, never a real one, with no project checkout, no bridges and no
 * directory watches, so what it times is the work a delete does on the
 * backend's own thread apart from watches and `git worktree remove`: the
 * environment and session store writes, the native-agent session, display-tail,
 * agent-mail, transcript-artifact and media-pin cleanup (those two stores are
 * empty here), and the cleanup-ledger records. It then times one cleanup-reconciler pass and the two snapshot reads
 * the two-second activity sweep makes.
 *
 * Every storage call is timed, store-row and lease writes are counted with
 * temporary triggers, and a 5 ms timer records the longest event-loop gap.
 * Results are local measurements, not guarantees.
 *
 * Workload `delete-store-work-v1`:
 * - 136 local environments, 6 of them deleted (one alone, then five at once);
 * - terminal sessions: 10 per environment;
 * - native sessions: 2,000, spread over every environment, each with 200
 *   dispatched request ids;
 * - display tails: 64 rows of 1 MiB;
 * - agent mail: 200 mailboxes of 50 messages with 2 KiB bodies (about 20 MiB
 *   of the store's 32 MiB limit), some sent by
 *   the deleted environments;
 * - each worktree: 2,000 files in 100 directories inside the workspaces root.
 *
 *   bun scripts/benchmark-delete-store-work.ts [--json]
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
// Nothing here may read the host's git configuration or credentials.
const home = realpathSync(mkdtempSync(path.join(tmpdir(), "ork-delete-store-home-")));
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const asJson = process.argv.includes("--json");

const core = path.join(import.meta.dir, "../apps/backend/src/core");
const { StorageService } = await import(path.join(core, "storage.ts"));
const { seedStore, storageDatabase } = await import(path.join(core, "storage-test-support.ts"));
const { openBackendDatabase } = await import(path.join(core, "storage-stores.ts"));
const { createCommandRegistry } = await import(path.join(core, "commands.ts"));
const { BackendRuntime } = await import(path.join(core, "backend-runtime.ts"));
const { EnvironmentLifecycleTaskTracker } = await import(
  path.join(core, "environment-lifecycle-tasks.ts")
);
const { closeEnvironmentCleanupStorage, environmentCleanupLedger } = await import(
  path.join(core, "environment-cleanup-ledger.ts")
);
const { reconcileEnvironmentCleanup } = await import(
  path.join(core, "environment-cleanup-reconciler.ts")
);
const { createTranscriptArtifactService } = await import(
  path.join(core, "transcript-artifacts/runtime-wiring.ts")
);
const { NATIVE_AGENT_DISPLAY_TAIL_STORE } = await import(
  path.join(core, "native-agent-display-tail-layout.ts")
);

const ENVIRONMENTS = 136;
const DELETED = 6;

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Event-loop gaps over 20 ms, from a 5 ms timer that runs for the whole benchmark. */
const gaps: Array<{ startMs: number; endMs: number }> = [];
let lastTick = performance.now();
const lagTimer = setInterval(() => {
  const now = performance.now();
  if (now - lastTick - 5 > 20) gaps.push({ startMs: lastTick, endMs: now });
  lastTick = now;
}, 5);

function longestGap(fromMs: number, toMs: number): number {
  let longest = 0;
  for (const gap of gaps) {
    if (gap.endMs < fromMs || gap.startMs > toMs) continue;
    longest = Math.max(longest, gap.endMs - gap.startMs - 5);
  }
  return longest;
}

/** Longest event-loop gap while `run` is in flight. */
async function withLagProbe<T>(
  run: () => Promise<T>,
): Promise<{ value: T; maxLagMs: number; gapsOver100Ms: number[] }> {
  // A gap still open from earlier work must not count against this phase.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const start = performance.now();
  const value = await run();
  // Let the timer observe a gap that ended with `run`.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const end = performance.now();
  return {
    value,
    maxLagMs: longestGap(start, end),
    gapsOver100Ms: gaps
      .filter((gap) => gap.endMs >= start && gap.startMs <= end)
      .map((gap) => round(gap.endMs - gap.startMs - 5))
      .filter((gap) => gap > 100),
  };
}

/**
 * Times every method call on the storage facade: wall time, time before it
 * returned its promise, and the longest event-loop gap inside its window
 * (attributable only where calls do not overlap, as in a lone delete).
 */
function timedStorage(storage: InstanceType<typeof StorageService>) {
  const calls = new Map<
    string,
    { count: number; wallMs: number; syncMs: number; windows: Array<[number, number]> }
  >();
  const note = (name: string, start: number, sync: number) => {
    const end = performance.now();
    const entry = calls.get(name) ?? { count: 0, wallMs: 0, syncMs: 0, windows: [] };
    entry.count += 1;
    entry.wallMs += end - start;
    entry.syncMs = Math.max(entry.syncMs, sync);
    entry.windows.push([start, end]);
    calls.set(name, entry);
  };
  const proxy = new Proxy(storage, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        const start = performance.now();
        const result = value.apply(target, args);
        const sync = performance.now() - start;
        if (result instanceof Promise) return result.finally(() => note(property, start, sync));
        note(property, start, sync);
        return result;
      };
    },
  });
  return { proxy, calls };
}

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

function environmentRecord(index: number, worktreeDir: string) {
  const id = `env-${index}`;
  return {
    id,
    projectId: "project-1",
    name: `Environment ${index}`,
    branch: `branch-${index}`,
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: index,
    environmentType: "local",
    worktreePath: path.join(worktreeDir, `project-${id}`),
  };
}

function seedWorktree(worktreePath: string): void {
  for (let directory = 0; directory < 100; directory += 1) {
    const target = path.join(worktreePath, "node_modules", `pkg-${directory}`);
    mkdirSync(target, { recursive: true });
    for (let file = 0; file < 20; file += 1) {
      writeFileSync(path.join(target, `file-${file}.js`), "module.exports = 1;\n");
    }
  }
}

async function seed(
  storage: InstanceType<typeof StorageService>,
  dataDir: string,
  worktreeDir: string,
) {
  for (let index = 0; index < ENVIRONMENTS; index += 1) {
    await storage.addEnvironment(environmentRecord(index, worktreeDir));
  }
  for (let index = 0; index < DELETED; index += 1) {
    seedWorktree(environmentRecord(index, worktreeDir).worktreePath);
  }
  seedStore(
    dataDir,
    "sessions.json",
    Array.from({ length: ENVIRONMENTS * 10 }, (_, index) => ({
      id: `session-${index}`,
      environmentId: `env-${Math.floor(index / 10)}`,
      containerId: null,
      tabId: `tab-${index}`,
      sessionType: "plain",
      status: "disconnected",
      createdAt: "2026-11-01T00:00:00.000Z",
      lastActivityAt: "2026-11-01T00:00:00.000Z",
      order: index % 10,
    })),
  );
  const template = await storage.getOrCreateNativeAgentSession(
    { key: "template", environmentId: "env-0", agent: "claude", logicalSessionKey: "template" },
    async () => "provider-template",
  );
  const sessions: Record<string, unknown> = {};
  for (let index = 0; index < 2_000; index += 1) {
    const key = `native-${index}`;
    sessions[key] = {
      ...template,
      key,
      environmentId: `env-${index % ENVIRONMENTS}`,
      logicalSessionKey: `tab-${index}`,
      providerSessionId: `provider-${index}`,
      dispatchedRequestIds: Array.from(
        { length: 200 },
        (_, request) => `request-${index}-${request}`,
      ),
    };
  }
  seedStore(dataDir, "native-agent-sessions.json", sessions);
  const database = openBackendDatabase(dataDir);
  try {
    database.transaction(() => {
      const rows = database.rows(NATIVE_AGENT_DISPLAY_TAIL_STORE);
      for (let index = 0; index < 64; index += 1) {
        rows.put(`native-${index}`, JSON.stringify({ text: "x".repeat(1024 * 1024) }));
      }
    });
  } finally {
    database.close();
  }
  const mailboxes: Record<string, unknown> = {};
  for (let index = 0; index < 200; index += 1) {
    mailboxes[`mailbox-${index}`] = {
      mailboxId: `mailbox-${index}`,
      environmentId: `env-${(index + DELETED) % ENVIRONMENTS}`,
      projectId: "project-1",
      revision: 1,
      messages: Array.from({ length: 50 }, (_, message) => ({
        id: `message-${index}-${message}`,
        from: { kind: "tab", environmentId: `env-${message % ENVIRONMENTS}`, tabId: "tab" },
        placement: "delivered",
        revision: 1,
        body: "x".repeat(2048),
        bodyBytes: 2048,
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
}

const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ork-delete-store-")));
const worktreeDir = path.join(dataDir, "workspaces");
const storage = new StorageService(dataDir);
const runtime = new BackendRuntime({ emit: () => undefined });
const report: Record<string, unknown> = {};
try {
  await storage.init();
  await seed(storage, dataDir, worktreeDir);
  const writes = writeCounter(storage);
  const timed = timedStorage(storage);
  // The cleanup ledger has its own connection; time its writes too.
  const ledger = environmentCleanupLedger(dataDir);
  const ledgerCalls = new Map<string, { count: number; totalMs: number; longestMs: number }>();
  for (const method of ["record", "complete", "fail", "get"] as const) {
    const original = ledger[method].bind(ledger) as (...args: unknown[]) => Promise<unknown>;
    (ledger as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      const start = performance.now();
      try {
        return await original(...args);
      } finally {
        const elapsed = performance.now() - start;
        const entry = ledgerCalls.get(method) ?? { count: 0, totalMs: 0, longestMs: 0 };
        entry.count += 1;
        entry.totalMs += elapsed;
        entry.longestMs = Math.max(entry.longestMs, elapsed);
        ledgerCalls.set(method, entry);
      }
    };
  }
  const ledgerSummary = () =>
    Object.fromEntries(
      [...ledgerCalls.entries()].map(([method, entry]) => [
        method,
        { count: entry.count, totalMs: round(entry.totalMs), longestMs: round(entry.longestMs) },
      ]),
    );
  const commands = createCommandRegistry();
  const context = {
    storage: timed.proxy,
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    worktreeDir,
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime,
    emit: () => undefined,
    // Wired as the backend wires it, minus the preview runtime.
    transcriptArtifacts: createTranscriptArtifactService(storage, {
      dataDir,
      announce: () => undefined,
      assetResolver: async () => null,
    }),
  };
  const remove = async (environmentId: string) => {
    const start = performance.now();
    await commands.get("delete_environment")!({ environmentId }, context);
    return performance.now() - start;
  };
  const slowestCalls = () =>
    [...timed.calls.entries()]
      .map(([name, entry]) => ({ name, ...entry }))
      .toSorted((left, right) => right.wallMs - left.wallMs)
      .slice(0, 8)
      .map((entry) => ({
        call: entry.name,
        count: entry.count,
        totalMs: round(entry.wallMs),
        longestSyncMs: round(entry.syncMs),
        // Gaps are recorded when the timer next runs, so read them now.
        longestLoopGapMs: round(
          Math.max(0, ...entry.windows.map(([from, to]) => longestGap(from, to))),
        ),
      }));

  writes.reset();
  timed.calls.clear();
  const single = await withLagProbe(() => remove("env-0"));
  report.oneDelete = {
    totalMs: round(single.value),
    maxLagMs: round(single.maxLagMs),
    gapsOver100Ms: single.gapsOver100Ms,
    rowWrites: writes.count("row"),
    leaseWrites: writes.count("lease"),
    slowestStorageCalls: slowestCalls(),
    cleanupLedgerCalls: ledgerSummary(),
  };

  writes.reset();
  timed.calls.clear();
  ledgerCalls.clear();
  const concurrent = await withLagProbe(() =>
    Promise.all(Array.from({ length: DELETED - 1 }, (_, index) => remove(`env-${index + 1}`))),
  );
  report.fiveDeletesAtOnce = {
    eachMs: concurrent.value.map(round),
    maxLagMs: round(concurrent.maxLagMs),
    gapsOver100Ms: concurrent.gapsOver100Ms,
    rowWrites: writes.count("row"),
    leaseWrites: writes.count("lease"),
    slowestStorageCalls: slowestCalls(),
    cleanupLedgerCalls: ledgerSummary(),
  };

  const reconcile = await withLagProbe(async () => {
    const start = performance.now();
    await reconcileEnvironmentCleanup(context);
    return performance.now() - start;
  });
  report.cleanupReconcilePass = {
    totalMs: round(reconcile.value),
    maxLagMs: round(reconcile.maxLagMs),
  };

  const sweepReads: number[] = [];
  const sweep = await withLagProbe(async () => {
    for (let run = 0; run < 20; run += 1) {
      const start = performance.now();
      await Promise.all([
        storage.readEnvironmentsSnapshot(),
        storage.readNativeAgentSessionsSnapshot(),
      ]);
      sweepReads.push(performance.now() - start);
    }
  });
  report.activitySweepSnapshotReads = {
    runs: sweepReads.length,
    longestMs: round(Math.max(...sweepReads)),
    maxLagMs: round(sweep.maxLagMs),
  };
} finally {
  clearInterval(lagTimer);
  runtime.shutdown();
  await runtime.diffStats.settled();
  closeEnvironmentCleanupStorage();
  await storage.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const [name, value] of Object.entries(report)) {
    console.log(`${name}: ${JSON.stringify(value, null, 2)}`);
  }
}
