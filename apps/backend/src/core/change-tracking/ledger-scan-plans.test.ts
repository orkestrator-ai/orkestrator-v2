/**
 * The ledger's periodic work must not scan its large tables (to-do 0741 task
 * 6). `bun:sqlite` runs on the event loop, and at arktech-mini's size (2.8M
 * rows, 1.26 GB) one statement over a whole table took 1 to 24 s with a cold
 * page cache: the hourly pass's superseded-measurement query, the provider
 * turn diffs past the window, the open tool windows, and a purged binding's
 * provider turns. Every statement a publication, an evidence pull, a retention
 * pass and a purge issue is planned here against a fresh ledger, and none may
 * read a large table end to end.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { environmentChangeResourceKey } from "@orkestrator/protocol/change-resources";
import type { DiffStatsTarget } from "../diff-stats-service.js";
import { ChangeLedger, type MeasurementFileRecord } from "./change-ledger.js";
import { LedgerRetirement } from "./ledger-retirement.js";
import { openChangeLedgerDatabase } from "./ledger-schema.js";
import { MEASUREMENTS_KEPT_PER_OWNER } from "./measurement-service.js";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";

const DAY = 86_400_000;
const PAST_WINDOW = 91 * DAY;
const CONVERSATION = "conversation";

/** Tables that grow with every turn: a plan may seek them, never walk them. */
const LARGE_TABLES = [
  "change_measurements",
  "change_measurement_files",
  "change_evidence",
  "change_operations",
  "change_tool_windows",
  "change_selections",
  "change_diff_identities",
];

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.cleanup();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const h = createHarness();
  harnesses.push(h);
  return h;
}

function recorder(spool: ChangeEvidenceSpool) {
  return new ChangeEvidenceRecorder({
    spool,
    provider: "codex",
    capabilities: {
      resolution: "resolved",
      beforeTurn: "controlled-dispatch",
      afterTurn: "terminal-observed",
      beforeTool: "awaited",
      afterTool: "awaited",
      historicalCallIdentity: "stable",
      fileEvidence: { resolution: "confirmed", kinds: ["replacement"] },
      turnDiff: "reported",
      captureExecutor: "host-worker",
      captureAvailability: "ready",
      backgroundCompletion: "launch-only",
    },
  });
}

/** An edit and two revisions of a provider turn diff, through the real spool and pull. */
async function recordTurn(h: Harness, turnId: string) {
  const spool = new ChangeEvidenceSpool();
  const rec = recorder(spool);
  const source = { conversationId: CONVERSATION, turnId };
  rec.tool(
    { ...source, callId: `${turnId}-edit` },
    {
      toolKind: "file-edit",
      phase: "succeeded",
      executionOccurrence: "started",
      evidence: [
        {
          kind: "replacement",
          path: "a.ts",
          before: "one\n",
          after: "two\n",
          extent: "fragment",
          origin: "input",
          claim: "proposal",
        },
      ],
    },
  );
  for (const value of ["A", "B"])
    rec.turnDiff(source, `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+${value}\n`);
  await h.service.pullEvidence({
    ...spoolSource(spool, "codex"),
    sourceKey: `env-1\0codex\0${turnId}`,
  });
}

async function scan(h: Harness, files: number, round: number) {
  const target: DiffStatsTarget = {
    environmentId: "env-1",
    comparisonRef: "main",
    kind: "local",
    worktreePath: h.repo,
  };
  const at = new Date().toISOString();
  h.service.onDiffScanEvent({
    kind: "scanned",
    target,
    result: {
      stats: { additions: files, deletions: 0, filesChanged: files, truncated: false },
      changes: Array.from({ length: files }, (_, index) => {
        const path = index === files - 1 ? `round-${round}.ts` : `file-${index}.ts`;
        return { path, filename: path, directory: "", additions: 1, deletions: 0, status: "M" };
      }),
      baseOid: "a".repeat(40),
    },
    changed: true,
    at,
    startedAt: at,
  });
  await h.service.environments.idle();
}

/** Every statement `work` prepares on the ledger's connection. */
async function statementsOf(h: Harness, work: () => Promise<void>): Promise<string[]> {
  const db = h.database().db;
  const query = spyOn(db, "query");
  const prepare = spyOn(db, "prepare");
  try {
    await work();
    // Read before restoring: restoring clears the recorded calls.
    return Array.from(
      new Set([...query.mock.calls, ...prepare.mock.calls].map((call) => String(call[0]))),
    );
  } finally {
    query.mockRestore();
    prepare.mockRestore();
  }
}

/**
 * Plans on a fresh ledger with the retention indexes and no statistics, so the
 * planner assumes large tables, as it should for these.
 */
function planner() {
  const directory = mkdtempSync(join(tmpdir(), "ork-ct-plans-"));
  directories.push(directory);
  const database = openChangeLedgerDatabase(directory);
  new LedgerRetirement(new ChangeLedger(() => database)).ensureIndexes();
  return {
    plan(sql: string): string[] {
      return (
        database.db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
      ).map((row) => row.detail);
    },
    close: () => database.close(),
  };
}

/** Partial indexes hold only the rows their queries ask for, so reading one whole is fine. */
const PARTIAL_INDEXES = ["change_tool_windows_open_only", "change_evidence_provider_turn_frames"];

/** Plan lines that read a large table end to end, or all of one owner kind's rows. */
function walks(plan: readonly string[]): string[] {
  return plan.filter((detail) => {
    const scan = /^SCAN (\w+)(?: USING (?:COVERING )?INDEX (\w+))?/.exec(detail);
    if (scan && LARGE_TABLES.includes(scan[1]!) && !PARTIAL_INDEXES.includes(scan[2] ?? ""))
      return true;
    // A seek on the owner kind alone reads every row of that kind.
    return /USING (COVERING )?INDEX change_evidence_owner \(owner_kind=\?\)$/.test(detail);
  });
}

describe("ledger statements at scale", () => {
  test("publications, pulls, retention passes and purges never walk a large table", async () => {
    const h = setup();
    h.service.rememberConversation("env-1", "codex", CONVERSATION, "tab");
    const statements = await statementsOf(h, async () => {
      await recordTurn(h, "t1");
      for (let round = 0; round < 4; round++) await scan(h, 300, round);
      await h.service.retention.idle();
      await h.service.retention.run();
      await h.service.retention.run(Date.now() + PAST_WINDOW);
      await recordTurn(h, "t2");
      h.service.environmentDeleted("env-1");
      await h.service.retention.run(Date.now() + PAST_WINDOW);
    });
    const plans = planner();
    try {
      const found = statements
        .filter((sql) => /^\s*(SELECT|UPDATE|DELETE|INSERT|WITH)/i.test(sql))
        .map((sql) => ({ sql: sql.replace(/\s+/g, " ").trim(), walks: walks(plans.plan(sql)) }))
        .filter((entry) => entry.walks.length > 0);
      expect(found).toEqual([]);
    } finally {
      plans.close();
    }
    // The paths the scans in to-do 0741 task 6 came from all ran.
    const ran = (fragment: string) => statements.some((sql) => sql.includes(fragment));
    expect(ran("GROUP BY owner_kind, owner_id, scope")).toBe(true);
    expect(ran("FROM change_tool_windows WHERE lifecycle = 'open'")).toBe(true);
    expect(ran("owner_kind = 'provider-turn' AND frame_key >= ?")).toBe(true);
    expect(ran("MAX(ingested_seq) AS seq FROM change_evidence")).toBe(true);
  });
});

function fileRecord(pathId: string): MeasurementFileRecord {
  return {
    pathId,
    oldPath: null,
    newPath: null,
    oldBlob: null,
    newBlob: null,
    oldMode: null,
    newMode: null,
    status: "modified",
    fileKind: "text",
    additions: 1,
    additionsQuality: "exact",
    deletions: 0,
    deletionsQuality: "exact",
    bodyState: "not-retained",
    reason: null,
  };
}

describe("the hourly pass's walk for superseded measurements", () => {
  test("pages through every owner and names only those with more than they keep", async () => {
    const h = setup();
    await scan(h, 1, 0);
    const ledger = h.service.ledger;
    const latest = h.service.projections.selectedMeasurement(environmentChangeResourceKey("env-1"));
    if (!latest) throw new Error("measurement expected");
    const counts = { a: 1, b: 3, c: 2, d: 5, e: 4 };
    ledger.transaction(() => {
      for (const [owner, measurements] of Object.entries(counts))
        for (let index = 0; index < measurements; index++)
          ledger.insertMeasurement(
            { ...latest, measurementId: `walk-${owner}-${index}` },
            { kind: "environment", id: `walk-${owner}` },
            [fileRecord("p")],
            ledger.nextSequence(),
          );
    });
    const found: string[] = [];
    let pages = 0;
    let after: ReturnType<typeof ledger.supersededOwnersPage>["next"] = null;
    do {
      const page = ledger.supersededOwnersPage(after, MEASUREMENTS_KEPT_PER_OWNER, 2);
      pages++;
      for (const owner of page.owners) if (owner.id.startsWith("walk-")) found.push(owner.id);
      after = page.next;
    } while (after);
    expect(pages).toBeGreaterThan(2);
    expect(found).toEqual(["walk-b", "walk-d", "walk-e"]);

    const report = await h.service.retention.run();
    expect(report.prunedMeasurements).toBe(1 + 3 + 2);
    for (const owner of Object.keys(counts)) {
      const left = (
        h
          .database()
          .db.query("SELECT COUNT(*) AS n FROM change_measurements WHERE owner_id = ?")
          .get(`walk-${owner}`) as { n: number }
      ).n;
      expect(`${owner}: ${left}`).toBe(
        `${owner}: ${Math.min(counts[owner as keyof typeof counts], MEASUREMENTS_KEPT_PER_OWNER)}`,
      );
    }
  });
});

describe("provider turn diffs past the window", () => {
  const providerTurns = (h: Harness) =>
    (
      h
        .database()
        .db.query(
          "SELECT DISTINCT owner_id AS id FROM change_evidence WHERE owner_kind = 'provider-turn'",
        )
        .all() as Array<{ id: string }>
    ).length;

  test("go once their newest evidence is past it, found by walking evidence in age order", async () => {
    const h = setup();
    h.service.rememberConversation("env-1", "codex", CONVERSATION, "tab");
    await recordTurn(h, "old");
    expect(providerTurns(h)).toBe(1);
    // Inside the window nothing goes, and the walk stops at the first row.
    await h.service.retention.run(Date.now() + 80 * DAY);
    expect(providerTurns(h)).toBe(1);
    await h.service.retention.run(Date.now() + PAST_WINDOW);
    expect(providerTurns(h)).toBe(0);
    expect(
      (
        h
          .database()
          .db.query(
            "SELECT COUNT(*) AS n FROM change_measurements WHERE owner_kind = 'provider-turn'",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  test("one whose latest revision is still inside the window stays", async () => {
    const h = setup();
    h.service.rememberConversation("env-1", "codex", CONVERSATION, "tab");
    const spool = new ChangeEvidenceSpool();
    const rec = recorder(spool);
    const source = { ...spoolSource(spool, "codex"), sourceKey: "env-1\0codex\0diffs" };
    const diff = async (turnId: string, value: string) => {
      rec.turnDiff(
        { conversationId: CONVERSATION, turnId },
        `--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+${value}\n`,
      );
      await h.service.pullEvidence(source);
    };
    await diff("done", "A");
    await diff("done", "B");
    await diff("continued", "A");
    const ledger = h.service.ledger;
    // The window ends here: `continued` has a revision on each side of it.
    const expired = ledger.meta("seq")!;
    await diff("continued", "B");
    ledger.transaction(() => ledger.setMeta("retention:expired-seq", expired));
    const owners = () =>
      (
        h
          .database()
          .db.query(
            "SELECT DISTINCT owner_id AS id FROM change_evidence WHERE owner_kind = 'provider-turn'",
          )
          .all() as Array<{ id: string }>
      ).map((row) => row.id);
    const [done, continued] = [
      h.service.providerTurnId("env-1", "codex", CONVERSATION, "done"),
      h.service.providerTurnId("env-1", "codex", CONVERSATION, "continued"),
    ];
    expect(owners().sort()).toEqual([done, continued].sort());
    const batch = h.service.retention.purges.retireExpiredProviderTurns(
      new Date().toISOString(),
      0,
      256,
    );
    expect(batch.done).toBe(true);
    expect(batch.rows).toBeGreaterThan(0);
    expect(owners()).toEqual([continued]);
  });
});
