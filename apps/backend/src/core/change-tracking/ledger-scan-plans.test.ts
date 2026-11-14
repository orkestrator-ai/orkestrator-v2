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
import { ChangeLedger, type EvidenceRow, type MeasurementFileRecord } from "./change-ledger.js";
import { LedgerRetirement } from "./ledger-retirement.js";
import { openChangeLedgerDatabase } from "./ledger-schema.js";
import { MEASUREMENTS_KEPT_PER_OWNER } from "./measurement-service.js";
import { createHarness, spoolSource, type Harness } from "./service-test-support.js";

const DAY = 86_400_000;
const PAST_WINDOW = 31 * DAY;
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
function walks(sql: string, plan: readonly string[]): string[] {
  // SQLite reports a table alias instead of its physical name. Keep every
  // protected alias, including aliases inside subqueries.
  const protectedNames = new Set(LARGE_TABLES);
  const keywords = new Set([
    "where",
    "set",
    "join",
    "on",
    "order",
    "group",
    "limit",
    "using",
    "indexed",
    "not",
  ]);
  for (const match of sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+(\w+)(?=\s+(?:AS\s+)?(\w+))/gi)) {
    if (LARGE_TABLES.includes(match[1]!) && !keywords.has(match[2]!.toLowerCase()))
      protectedNames.add(match[2]!);
  }
  return plan.filter((detail) => {
    const scan = /^SCAN (\w+)(?: USING (?:COVERING )?INDEX (\w+))?/.exec(detail);
    if (scan && protectedNames.has(scan[1]!) && !PARTIAL_INDEXES.includes(scan[2] ?? ""))
      return true;
    // A seek on the owner kind alone reads every row of that kind.
    return /USING (COVERING )?INDEX change_evidence_owner \(owner_kind=\?\)$/.test(detail);
  });
}

describe("ledger statements at scale", () => {
  test.each(["change_selections", "change_selections s", "change_selections AS s"])(
    "detects full scans of %s but permits indexed seeks",
    (table) => {
      const plans = planner();
      try {
        const name = table === "change_selections" ? table : "s";
        const scan = `SELECT * FROM ${table} NOT INDEXED`;
        expect(walks(scan, plans.plan(scan))).toHaveLength(1);
        const seek = `SELECT * FROM ${table} WHERE ${name}.selection_key = ?`;
        expect(walks(seek, plans.plan(seek))).toEqual([]);
      } finally {
        plans.close();
      }
    },
  );

  test.each([
    "SELECT s.* FROM change_bindings JOIN change_selections s NOT INDEXED ON s.selection_key = change_bindings.id",
    "SELECT * FROM change_bindings WHERE EXISTS (SELECT 1 FROM change_selections s NOT INDEXED)",
  ])("detects aliased scans in joins and subqueries: %s", (sql) => {
    const plans = planner();
    try {
      expect(walks(sql, plans.plan(sql))).toHaveLength(1);
    } finally {
      plans.close();
    }
  });

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
      // The startup reconcile of environments deleted before purges were recorded.
      await h.service.reconcileDeletedEnvironments(async () => new Set(["env-1"]));
      h.service.environmentDeleted("env-1");
      await h.service.retention.run(Date.now() + PAST_WINDOW);
    });
    const plans = planner();
    try {
      const found = statements
        .filter((sql) => /^\s*(SELECT|UPDATE|DELETE|INSERT|WITH)/i.test(sql))
        .map((sql) => ({
          sql: sql.replace(/\s+/g, " ").trim(),
          walks: walks(sql, plans.plan(sql)),
        }))
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
    expect(ran("SELECT MIN(owner_id) AS id FROM change_measurements")).toBe(true);
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
    await h.service.retention.run(Date.now() + 29 * DAY);
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

/** Synthetic revisions keep page and deletion budgets independent of ingestion. */
function evidence(h: Harness, owner: string, revision: number, seq = revision): void {
  const row: EvidenceRow = {
    evidence_id: `evidence-${owner}`,
    revision,
    owner_kind: "provider-turn",
    owner_id: owner,
    evidence_key: `key-${owner}`,
    revision_key: `${owner}-${revision}`,
    replaces_revision_key: null,
    kind: "patch",
    claim: "provider-reported",
    evidence_json: JSON.stringify({ evidence: { body: { id: `body-${owner}` } } }),
    selected: 1,
    frame_key: `frame-${owner}-${revision}`,
    ingested_seq: seq,
  };
  h.service.ledger.insertEvidence(row);
}

function evidenceCount(h: Harness, owner: string): number {
  return (
    h
      .database()
      .db.query("SELECT COUNT(*) AS n FROM change_evidence WHERE owner_id = ?")
      .get(owner) as { n: number }
  ).n;
}

function expire(h: Harness, seq: number): void {
  h.service.ledger.transaction(() =>
    h.service.ledger.setMeta("retention:expired-seq", String(seq)),
  );
}

function finishEvidenceWalk(h: Harness, budget: number, after = 0): number {
  let removed = 0;
  for (let pass = 0; pass < 100; pass++) {
    const batch = h.service.retention.purges.retireExpiredProviderTurns(
      new Date().toISOString(),
      after,
      budget,
    );
    expect(batch.rows).toBeLessThanOrEqual(budget);
    expect(batch.next).toBeGreaterThanOrEqual(after);
    removed += batch.rows;
    if (batch.done) return removed;
    after = batch.next;
  }
  throw new Error("evidence walk did not finish");
}

describe("provider evidence walk boundaries", () => {
  test("crosses the 256-row page past a held owner and eventually cleans it after release", async () => {
    const h = setup();
    await scan(h, 1, 0);
    const ledger = h.service.ledger;
    const template = h.service.projections.selectedMeasurement(
      environmentChangeResourceKey("env-1"),
    )!;
    ledger.transaction(() => {
      ledger.insertMeasurement(
        { ...template, measurementId: "held-measurement" },
        { kind: "provider-turn", id: "held" },
        [fileRecord("protected")],
        ledger.nextSequence(),
      );
      for (let i = 1; i <= 260; i++) evidence(h, "held", i);
      for (let i = 1; i <= 20; i++) evidence(h, `later-${i}`, 1, 260 + i);
    });
    expire(h, 280);
    const release = ledger.pinMeasurement("held-measurement");
    try {
      const first = h.service.retention.purges.retireExpiredProviderTurns(
        new Date().toISOString(),
        0,
        32,
      );
      expect(first).toEqual({ rows: 0, done: false, next: 256 });
      expect(finishEvidenceWalk(h, 32, first.next)).toBe(20);
      expect(evidenceCount(h, "held")).toBe(260);
      expect(ledger.measurement("held-measurement")).not.toBeNull();
      expect(
        ledger.db
          .query("SELECT path_id FROM change_measurement_files WHERE measurement_id = ?")
          .all("held-measurement"),
      ).toEqual([{ path_id: "protected" }]);
      expect(ledger.db.query("SELECT DISTINCT owner_id FROM change_evidence").all()).toEqual([
        { owner_id: "held" },
      ]);
    } finally {
      release();
    }
    expect(finishEvidenceWalk(h, 17)).toBe(262);
    expect(evidenceCount(h, "held")).toBe(0);
    expect(ledger.measurement("held-measurement")).toBeNull();
  });

  test("resumes an owner whose evidence exceeds the deletion budget", () => {
    const h = setup();
    h.service.ledger.transaction(() => {
      for (let i = 1; i <= 600; i++) evidence(h, "bulk", i);
      evidence(h, "later", 1, 601);
    });
    expire(h, 601);
    const first = h.service.retention.purges.retireExpiredProviderTurns(
      new Date().toISOString(),
      0,
      17,
    );
    expect(first).toEqual({ rows: 17, done: false, next: 0 });
    expect(evidenceCount(h, "bulk")).toBe(583);
    expect(finishEvidenceWalk(h, 17, first.next)).toBe(584);
    expect(evidenceCount(h, "bulk")).toBe(0);
    expect(evidenceCount(h, "later")).toBe(0);
  });

  test("a new revision between batches protects the remaining owner while later expired turns go", () => {
    const h = setup();
    h.service.ledger.transaction(() => {
      for (let i = 1; i <= 40; i++) evidence(h, "continued", i);
      evidence(h, "later", 1, 41);
    });
    expire(h, 41);
    const first = h.service.retention.purges.retireExpiredProviderTurns(
      new Date().toISOString(),
      0,
      10,
    );
    expect(first).toEqual({ rows: 10, done: false, next: 0 });
    evidence(h, "continued", 41, 42);
    expect(finishEvidenceWalk(h, 10, first.next)).toBe(1);
    expect(evidenceCount(h, "continued")).toBe(31);
    expect(evidenceCount(h, "later")).toBe(0);
    expect(h.service.retention.purges.evidenceBodiesPage(0).ids).toEqual(
      Array(31).fill("body-continued"),
    );
    expire(h, 42);
    expect(finishEvidenceWalk(h, 10)).toBe(31);
    expect(evidenceCount(h, "continued")).toBe(0);
  });

  test("a reader pin admitted between batches protects the remaining files and evidence", async () => {
    const h = setup();
    await scan(h, 1, 0);
    const ledger = h.service.ledger;
    const template = h.service.projections.selectedMeasurement(
      environmentChangeResourceKey("env-1"),
    )!;
    ledger.transaction(() => {
      ledger.insertMeasurement(
        { ...template, measurementId: "reading" },
        { kind: "provider-turn", id: "reader" },
        Array.from({ length: 40 }, (_, i) => fileRecord(`p-${i}`)),
        ledger.nextSequence(),
      );
      evidence(h, "reader", 1);
      evidence(h, "later", 1, 2);
    });
    expire(h, 2);
    const first = h.service.retention.purges.retireExpiredProviderTurns(
      new Date().toISOString(),
      0,
      10,
    );
    expect(first).toEqual({ rows: 10, done: false, next: 0 });
    const files = () =>
      ledger.db
        .query(
          "SELECT path_id FROM change_measurement_files WHERE measurement_id = ? ORDER BY path_id",
        )
        .all("reading");
    const protectedFiles = files();
    expect(protectedFiles).toHaveLength(30);
    const release = ledger.pinMeasurement("reading");
    try {
      expect(finishEvidenceWalk(h, 10, first.next)).toBe(1);
      expect(files()).toEqual(protectedFiles);
      expect(ledger.measurement("reading")).not.toBeNull();
      expect(evidenceCount(h, "reader")).toBe(1);
      expect(evidenceCount(h, "later")).toBe(0);
    } finally {
      release();
    }
    expect(finishEvidenceWalk(h, 10)).toBe(32);
    expect(files()).toEqual([]);
    expect(ledger.measurement("reading")).toBeNull();
    expect(evidenceCount(h, "reader")).toBe(0);
  });

  test("a pass with no expired evidence reads only the first frontier row", () => {
    const h = setup();
    h.service.ledger.transaction(() => {
      for (let i = 1; i <= 600; i++) evidence(h, `fresh-${i}`, 1, i);
    });
    expire(h, 0);
    const db = h.database().db;
    const original = db.query.bind(db);
    let rowsRead = 0;
    const restores: Array<() => void> = [];
    const query = spyOn(db, "query").mockImplementation(((sql: string) => {
      const statement = original(sql);
      if (/SELECT .* FROM change_evidence WHERE rowid >/.test(sql.replace(/\s+/g, " "))) {
        const get = statement.get.bind(statement);
        const all = statement.all.bind(statement);
        const getSpy = spyOn(statement, "get").mockImplementation((...args) => {
          const row = get(...args);
          if (row) rowsRead++;
          return row;
        });
        const allSpy = spyOn(statement, "all").mockImplementation((...args) => {
          const rows = all(...args);
          rowsRead += rows.length;
          return rows;
        });
        restores.push(() => {
          getSpy.mockRestore();
          allSpy.mockRestore();
        });
      }
      return statement;
    }) as typeof db.query);
    try {
      expect(
        h.service.retention.purges.retireExpiredProviderTurns(new Date().toISOString(), 0, 256),
      ).toEqual({ rows: 0, done: true, next: 0 });
      expect(rowsRead).toBe(1);
    } finally {
      query.mockRestore();
      for (const restore of restores) restore();
    }
    expect(evidenceCount(h, "fresh-600")).toBe(1);
  });
});

describe("retention scale regressions", () => {
  test("100k measurements are discovered in owner pages and pruned within one owner", () => {
    const h = setup();
    const ledger = h.service.ledger;
    ledger.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100000)
      INSERT INTO change_measurements
        (id, scope, owner_kind, owner_id, worktree_id, algorithm_id, representation_id, measurement_json, created_seq)
      SELECT 'm-' || i, 'net', 'environment', printf('%05d', (i - 1) / 100), 'w', 'a', 'r', '{}', i FROM n;
    `);
    let after = null;
    let owners = 0;
    do {
      const page = ledger.supersededOwnersPage(after, 2, 64);
      expect(page.owners.length).toBeLessThanOrEqual(64);
      owners += page.owners.length;
      after = page.next;
    } while (after);
    expect(owners).toBe(1000);
    expect(
      ledger.pruneSupersededMeasurements({
        owner: { kind: "environment", id: "00000", scope: "net" },
        keepLatest: 2,
        nowIso: new Date().toISOString(),
        maxMeasurements: 64,
      }),
    ).toEqual({ measurements: 64, files: 0 });
    expect(ledger.supersededOwnersPage(null, 2, 1).owners).toHaveLength(1);
  });

  test("130k evidence rows retain a quiet frontier and bound a backlog page", () => {
    const h = setup();
    const ledger = h.service.ledger;
    ledger.db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 130000)
      INSERT INTO change_evidence
        (evidence_id, revision, owner_kind, owner_id, evidence_key, revision_key, kind, claim, evidence_json, frame_key, ingested_seq)
      SELECT 'e-' || i, 1, 'provider-turn', 'owner-' || i, 'k', 'r', 'patch', 'provider-reported', '{}', 'f-' || i, i FROM n;
    `);
    const retirement = h.service.retention.purges;
    const at = new Date().toISOString();
    expect(retirement.retireExpiredProviderTurns(at, 0, 256)).toEqual({
      rows: 0,
      done: true,
      next: 0,
    });
    expire(h, 130000);
    const batch = retirement.retireExpiredProviderTurns(at, 0, 256);
    expect(batch.done).toBe(false);
    expect(batch.rows).toBe(256);
    expect(batch.next).toBeGreaterThan(0);
    expect(batch.next).toBeLessThanOrEqual(256);
    expect(evidenceCount(h, "owner-130000")).toBe(1);
  });
});
