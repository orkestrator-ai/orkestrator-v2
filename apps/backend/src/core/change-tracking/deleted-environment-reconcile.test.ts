/**
 * The startup reconcile of environments deleted before purges were recorded
 * (to-do 5821 task 5). It deletes history on an inference, so most of these
 * tests are about what it must not purge: a live environment, a coordinator
 * or bug-report runtime, an environment created while the store was being
 * read, and everything when the store read fails. The rest are about what it
 * must reach: every page of the ledger, however many ids come before.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { configureLogger, resetLogger } from "@orkestrator/protocol/logger";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import { reconcileDeletedEnvironments } from "./deleted-environment-reconcile.js";
import { ChangeTrackingService } from "./service.js";
import { createHarness, type Harness } from "./service-test-support.js";
import { turnIdFor } from "./turn-boundaries.js";

const HOUR = 60 * 60_000;
const SESSION = "tab";
const COORDINATOR = "coordinator:c1:conversation";
const BUG_REPORT = "bug-report:r1";

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
  resetLogger();
});

function setup() {
  const h = createHarness({
    aliases: ["env-2", "env-3", "env-4", "env-5", COORDINATOR, BUG_REPORT],
  });
  harnesses.push(h);
  return h;
}

const count = (h: Harness, table: string, where = "1 = 1", ...params: string[]): number =>
  (
    h
      .database()
      .db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
      .get(...params) as { n: number }
  ).n;

const rowsOf = (h: Harness, environmentId: string) => ({
  boundaries: count(h, "change_turn_boundaries", "environment_id = ?", environmentId),
  segments: count(h, "change_thread_segments", "environment_id = ?", environmentId),
});

async function runTurn(h: Harness, environmentId: string, requestId: string) {
  await h.service.prepareTurnStart({
    environmentId,
    logicalSessionKey: SESSION,
    requestId,
    provider: "claude",
  });
  h.service.markTurnDispatched(environmentId, SESSION, requestId, "accepted");
  writeFileSync(join(h.repo, "a.txt"), `${environmentId} ${requestId}\n`);
  await h.service.finalizeTurn({ environmentId, logicalSessionKey: SESSION, requestId });
  return turnIdFor(environmentId, SESSION, requestId);
}

async function scanEnvironment(h: Harness, environmentId: string) {
  const target: DiffStatsTarget = {
    environmentId,
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  const at = new Date().toISOString();
  h.service.onDiffScanEvent({
    kind: "scanned",
    target,
    result: {
      stats: { additions: 1, deletions: 0, filesChanged: 1, truncated: false },
      changes: [
        {
          path: "a.txt",
          filename: "a.txt",
          directory: "",
          additions: 1,
          deletions: 0,
          status: "M",
        },
      ],
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
  });
  await h.service.environments.idle();
}

/** Every id, one page at a time, as the reconcile reads them. */
function allPages(h: Harness, limit: number): string[][] {
  const pages: string[][] = [];
  let after: string | null = "";
  while (after !== null) {
    const page = h.service.retention.purges.ledgerEnvironmentIdPage(after, limit);
    pages.push(page.ids);
    after = page.next;
  }
  return pages;
}

const pending = (h: Harness) =>
  h.service.retention.purges
    .pendingPurges()
    .map((purge) => purge.environmentId)
    .sort();

describe("the ledger's environment ids", () => {
  test("come from bindings, turns, segments and environment-net measurements", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    // Only an environment scan: no turn, no segment, just measurements.
    await scanEnvironment(h, "env-2");
    expect(count(h, "change_turn_boundaries", "environment_id = 'env-2'")).toBe(0);
    expect(h.service.retention.purges.ledgerEnvironmentIdPage()).toEqual({
      ids: ["env-1", "env-2"],
      next: null,
    });
  });

  test("an empty ledger names none", () => {
    const h = setup();
    expect(h.service.retention.purges.ledgerEnvironmentIdPage()).toEqual({ ids: [], next: null });
  });

  test("pages reach every id, in order, whichever table names it", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await runTurn(h, "env-3", "r1");
    await runTurn(h, "env-5", "r1");
    // Named only by measurements, between ids every table names.
    await scanEnvironment(h, "env-2");
    await scanEnvironment(h, "env-4");
    expect(allPages(h, 2)).toEqual([["env-1", "env-2"], ["env-3", "env-4"], ["env-5"]]);
    expect(allPages(h, 1).flat()).toEqual(["env-1", "env-2", "env-3", "env-4", "env-5"]);
  });

  test("a page every table fills says there may be more", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await runTurn(h, "env-2", "r1");
    // Each table returns its full share, so the union is exactly one page.
    expect(h.service.retention.purges.ledgerEnvironmentIdPage("", 2)).toEqual({
      ids: ["env-1", "env-2"],
      next: "env-2",
    });
    expect(h.service.retention.purges.ledgerEnvironmentIdPage("env-2", 2)).toEqual({
      ids: [],
      next: null,
    });
  });
});

describe("reconciling deleted environments", () => {
  test("purges an environment the store no longer holds, open segment and boundaries included", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await runTurn(h, "env-2", "r1");
    await scanEnvironment(h, "env-2");
    expect(rowsOf(h, "env-2")).toEqual({ boundaries: 1, segments: 1 });
    expect(
      count(h, "change_thread_segments", "environment_id = 'env-2' AND closed_at IS NULL"),
    ).toBe(1);

    const result = await h.service.reconcileDeletedEnvironments(async () => new Set(["env-1"]));
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 2, requested: ["env-2"] });
    expect(pending(h)).toEqual(["env-2"]);
    // Late events for the environment are refused until its purge ends, as after a delete.
    expect(
      await h.service.prepareTurnStart({
        environmentId: "env-2",
        logicalSessionKey: SESSION,
        requestId: "r2",
        provider: "claude",
      }),
    ).toEqual({ kind: "untracked", reason: "environment-deleted" });

    await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(rowsOf(h, "env-2")).toEqual({ boundaries: 0, segments: 0 });
    expect(
      count(h, "change_measurements", "owner_kind = 'environment' AND owner_id = 'env-2'"),
    ).toBe(0);
    // The live environment keeps everything.
    expect(rowsOf(h, "env-1")).toEqual({ boundaries: 1, segments: 1 });
    expect(pending(h)).toEqual([]);
  });

  test("a store read that fails purges nothing and is logged", async () => {
    const records: string[] = [];
    configureLogger({ level: "warn", sink: (output) => records.push(output.line) });
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await runTurn(h, "env-2", "r1");

    const result = await h.service.reconcileDeletedEnvironments(async () => {
      throw new Error("Environment store is missing or invalid; cleanup refused");
    });

    expect(result).toBeNull();
    expect(pending(h)).toEqual([]);
    await h.service.retention.run(Date.now() + 2 * HOUR);
    expect(rowsOf(h, "env-1")).toEqual({ boundaries: 1, segments: 1 });
    expect(rowsOf(h, "env-2")).toEqual({ boundaries: 1, segments: 1 });
    expect(records.some((line) => line.includes("deleted-environments.reconcile-failed"))).toBe(
      true,
    );
    // The error's message is not logged.
    expect(records.some((line) => line.includes("cleanup refused"))).toBe(false);
  });

  test("every environment in the store keeps its rows", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await runTurn(h, "env-2", "r1");
    const result = await h.service.reconcileDeletedEnvironments(
      async () => new Set(["env-1", "env-2", "env-unrelated"]),
    );
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 2, requested: [] });
    expect(pending(h)).toEqual([]);
  });

  test("a coordinator runtime is never taken for a deleted environment", async () => {
    const h = setup();
    await runTurn(h, COORDINATOR, "r1");
    expect(h.service.retention.purges.ledgerEnvironmentIdPage().ids).toEqual([COORDINATOR]);
    const live = spyOn({ read: async () => new Set<string>() }, "read");
    const result = await h.service.reconcileDeletedEnvironments(live);
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 0, requested: [] });
    // With no candidate the store is not read at all.
    expect(live).not.toHaveBeenCalled();
    expect(pending(h)).toEqual([]);
    expect(rowsOf(h, COORDINATOR)).toEqual({ boundaries: 1, segments: 1 });
  });

  test("a bug-report runtime is never taken for a deleted environment", async () => {
    const h = setup();
    await runTurn(h, BUG_REPORT, "r1");
    expect(h.service.retention.purges.ledgerEnvironmentIdPage().ids).toEqual([BUG_REPORT]);
    const live = spyOn({ read: async () => new Set<string>() }, "read");
    const result = await h.service.reconcileDeletedEnvironments(live);
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 0, requested: [] });
    expect(live).not.toHaveBeenCalled();
    expect(pending(h)).toEqual([]);
    expect(rowsOf(h, BUG_REPORT)).toEqual({ boundaries: 1, segments: 1 });
  });

  test("an orphan after a full page of live and excluded ids is still reached", async () => {
    const h = setup();
    // Live, coordinator and bug-report ids fill the first pages; the orphan,
    // named only by measurements, sorts last.
    await runTurn(h, BUG_REPORT, "r1");
    await runTurn(h, COORDINATOR, "r1");
    await runTurn(h, "env-1", "r1");
    await scanEnvironment(h, "env-5");
    const reads: number[] = [];
    const requested: string[] = [];
    const result = await reconcileDeletedEnvironments({
      ledgerEnvironmentIds: (after) => h.service.retention.purges.ledgerEnvironmentIdPage(after, 1),
      liveEnvironmentIds: async () => {
        reads.push(reads.length);
        return new Set(["env-1"]);
      },
      purgePending: () => false,
      requestPurge: (id) => requested.push(id),
      stopped: () => false,
    });
    expect(requested).toEqual(["env-5"]);
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 2, requested: ["env-5"] });
    // One store read per page that had a candidate, each after its page.
    expect(reads).toHaveLength(2);
  });

  test("a backlog larger than one page is purged in one pass", async () => {
    const h = setup();
    for (const id of ["env-1", "env-2", "env-3", "env-4", "env-5"]) await runTurn(h, id, "r1");
    const result = await reconcileDeletedEnvironments({
      ledgerEnvironmentIds: (after) => h.service.retention.purges.ledgerEnvironmentIdPage(after, 2),
      liveEnvironmentIds: async () => new Set(["env-3"]),
      purgePending: (id) =>
        h.service.retention.purges.pendingPurges().some((p) => p.environmentId === id),
      requestPurge: (id) => h.service.environmentDeleted(id),
      stopped: () => false,
    });
    expect(result).toEqual({
      kind: "reconciled",
      ledgerEnvironments: 5,
      requested: ["env-1", "env-2", "env-4", "env-5"],
    });
    expect(pending(h)).toEqual(["env-1", "env-2", "env-4", "env-5"]);
  });

  test("every page is compared with a store read taken after it", async () => {
    const order: string[] = [];
    const pages: Record<string, { ids: string[]; next: string | null }> = {
      "": { ids: ["a", "b"], next: "b" },
      b: { ids: ["c", "d"], next: "d" },
      d: { ids: ["e"], next: null },
    };
    const requested: string[] = [];
    const result = await reconcileDeletedEnvironments({
      ledgerEnvironmentIds: (after) => {
        order.push(`ledger:${after}`);
        return pages[after]!;
      },
      liveEnvironmentIds: async () => {
        order.push("store");
        // "d" was created between the first and second store reads.
        return new Set(order.filter((step) => step === "store").length > 1 ? ["a", "d"] : ["a"]);
      },
      purgePending: () => false,
      requestPurge: (id) => requested.push(id),
      stopped: () => false,
    });
    expect(order).toEqual(["ledger:", "store", "ledger:b", "store", "ledger:d", "store"]);
    expect(requested).toEqual(["b", "c", "e"]);
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 5, requested });
  });

  test("an environment created while the store is read is not purged", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    const result = await h.service.reconcileDeletedEnvironments(async () => {
      // Created and already writing turns after the ledger was read; the
      // snapshot of the store was taken before it existed.
      await runTurn(h, "env-3", "r1");
      return new Set(["env-1"]);
    });
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 1, requested: [] });
    expect(pending(h)).toEqual([]);
    expect(rowsOf(h, "env-3")).toEqual({ boundaries: 1, segments: 1 });
  });

  test("an environment already being purged is not requested again", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await runTurn(h, "env-2", "r1");
    h.service.environmentDeleted("env-2");
    const before = h.service.retention.purges.pendingPurges();
    const result = await h.service.reconcileDeletedEnvironments(async () => new Set(["env-1"]));
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 1, requested: [] });
    expect(h.service.retention.purges.pendingPurges()).toEqual(before);
  });

  test("a service shut down during the store read requests nothing", async () => {
    const h = setup();
    await runTurn(h, "env-1", "r1");
    const result = await h.service.reconcileDeletedEnvironments(async () => {
      h.service.shutdown();
      return new Set<string>();
    });
    expect(result).toEqual({ kind: "stopped" });
    expect(pending(h)).toEqual([]);
  });

  test("the pure reconcile reads the ledger before the store", async () => {
    const order: string[] = [];
    const requested: string[] = [];
    const result = await reconcileDeletedEnvironments({
      ledgerEnvironmentIds: () => {
        order.push("ledger");
        return { ids: ["a", "b", "bug-report:x", "c", "coordinator:x"], next: null };
      },
      liveEnvironmentIds: async () => {
        order.push("store");
        return new Set(["a"]);
      },
      purgePending: (id) => id === "c",
      requestPurge: (id) => requested.push(id),
      stopped: () => false,
    });
    expect(order).toEqual(["ledger", "store"]);
    expect(requested).toEqual(["b"]);
    expect(result).toEqual({ kind: "reconciled", ledgerEnvironments: 2, requested: ["b"] });
  });
});

describe("production scheduling", () => {
  test("the first pass after start reconciles once, then retains", async () => {
    const timeout = spyOn(globalThis, "setTimeout");
    const h = setup();
    await runTurn(h, "env-1", "r1");
    await runTurn(h, "env-2", "r1");
    const reads: number[] = [];
    const service = new ChangeTrackingService({
      dataDir: h.dataDir,
      database: () => h.database(),
      emit: () => undefined,
      environmentTarget: async () => ({ kind: "local", worktreePath: h.repo }),
      liveEnvironmentIds: async () => {
        reads.push(Date.now());
        return new Set(["env-1"]);
      },
      durable: false,
      manualScheduling: false,
    });
    const run = spyOn(service.retention, "run");
    try {
      service.start();
      const first = timeout.mock.calls.find((call) => call[1] === 120_000);
      expect(first).toBeDefined();
      // Nothing is read or requested before the first pass is due.
      expect(reads).toEqual([]);
      (first![0] as () => void)();
      for (let i = 0; i < 200 && run.mock.calls.length === 0; i++) await Bun.sleep(5);
      expect(run).toHaveBeenCalledTimes(1);
      await run.mock.results[0]!.value;
      expect(reads).toHaveLength(1);
      expect(service.retention.purges.pendingPurges().map((p) => p.environmentId)).toEqual([
        "env-2",
      ]);
    } finally {
      service.shutdown();
      run.mockRestore();
      timeout.mockRestore();
    }
  });
});
