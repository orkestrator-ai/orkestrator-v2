import { afterEach, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DISPATCH_JOURNAL_VERSION,
  DispatchJournal,
  reconcileFromThreadTurns,
  type PromptDispatchRecord,
} from "./dispatch-journal.js";
import { hashCwd } from "./persistence.js";

const temporaryDirs: string[] = [];

function journal(options: {
  persist?: boolean;
  now?: () => number;
  maxRecords?: number;
  maxBytes?: number;
  retentionMs?: number;
} = {}) {
  const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-"));
  temporaryDirs.push(codexHome);
  return new DispatchJournal({
    codexHome,
    cwd: "/workspace",
    persist: options.persist ?? false,
    now: options.now,
    maxRecords: options.maxRecords,
    maxBytes: options.maxBytes,
    retentionMs: options.retentionMs,
  });
}

/** A fresh CODEX_HOME plus the journal path a `/workspace` journal would use. */
function journalHome(prefix: string): { codexHome: string; path: string } {
  const codexHome = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(codexHome);
  return {
    codexHome,
    path: join(
      codexHome,
      "orkestrator-bridge",
      `dispatch-journal-${hashCwd("/workspace")}.json`,
    ),
  };
}

/** Writes a journal file byte-for-byte, so hand-rolled and legacy shapes can be loaded. */
function writeJournalFile(codexHome: string, contents: unknown): void {
  mkdirSync(join(codexHome, "orkestrator-bridge"), { recursive: true });
  writeFileSync(
    join(codexHome, "orkestrator-bridge", `dispatch-journal-${hashCwd("/workspace")}.json`),
    `${JSON.stringify(contents, null, 2)}\n`,
    "utf8",
  );
}

function readJournalFile(codexHome: string): { records: PromptDispatchRecord[] } {
  return JSON.parse(
    readFileSync(
      join(codexHome, "orkestrator-bridge", `dispatch-journal-${hashCwd("/workspace")}.json`),
      "utf8",
    ),
  ) as { records: PromptDispatchRecord[] };
}

async function captureWarnings(work: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await work();
  } finally {
    console.warn = original;
  }
  return lines;
}

afterEach(() => {
  while (temporaryDirs.length > 0) {
    rmSync(temporaryDirs.pop()!, { recursive: true, force: true });
  }
});

describe("duplicate classification", () => {
  test("an unseen request is dispatched", () => {
    expect(journal().classify("req-1")).toEqual({ duplicate: false, action: "dispatch" });
  });

  test("a duplicate of a running request attaches to the existing turn", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "req-1", bridgeSessionId: "s1", threadId: "t1" });
    await store.markAccepted("req-1", { threadId: "t1", turnId: "turn-1" });

    const decision = store.classify("req-1");
    expect(decision).toMatchObject({ duplicate: true, action: "attach" });
    expect(decision.record?.turnId).toBe("turn-1");
  });

  test("a duplicate of a finished request is not re-run", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "req-1", bridgeSessionId: "s1", threadId: "t1" });
    await store.markTerminal("req-1", "completed", { threadId: "t1", turnId: "turn-1" });

    expect(store.classify("req-1")).toMatchObject({
      duplicate: true,
      action: "already-done",
    });
  });

  test("a request stuck at prepared must be reconciled, never assumed", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "req-1", bridgeSessionId: "s1", threadId: "t1" });

    // This is the ambiguous window: we may or may not have written turn/start.
    // Guessing either way is a bug — assuming "ran" strands the prompt, assuming
    // "did not run" can duplicate commands and file edits.
    expect(store.classify("req-1")).toMatchObject({ duplicate: true, action: "reconcile" });
  });

  test("the same prompt text under a different request id is a new turn", () => {
    const store = journal();
    // Deduplicating on prompt text would silently swallow a legitimate retry of
    // the same instruction.
    expect(store.classify("req-1").action).toBe("dispatch");
    expect(store.classify("req-2").action).toBe("dispatch");
  });
});

describe("journal state transitions", () => {
  test("prepare then accept records the turn id and preserves createdAt", async () => {
    let clock = 1_000;
    const store = journal({ now: () => (clock += 1_000) });

    const prepared = await store.markPrepared({
      requestId: "req-1",
      bridgeSessionId: "s1",
      threadId: null,
    });
    await store.markAccepted("req-1", { threadId: "t1", turnId: "turn-1" });

    const record = store.get("req-1")!;
    expect(record.state).toBe("accepted");
    expect(record.threadId).toBe("t1");
    expect(record.turnId).toBe("turn-1");
    expect(record.createdAt).toBe(prepared.createdAt);
    expect(record.updatedAt).not.toBe(prepared.updatedAt);
  });

  test("terminal records the outcome", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "req-1", bridgeSessionId: "s1", threadId: "t1" });
    await store.markTerminal("req-1", "interrupted");

    expect(store.get("req-1")).toMatchObject({
      state: "terminal",
      terminalStatus: "interrupted",
    });
  });

  test("retryable records can be dispatched again and are not unresolved", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "retry", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("retry");

    expect(store.classify("retry")).toMatchObject({
      duplicate: true,
      action: "dispatch",
      record: { state: "retryable" },
    });
    expect(store.unresolved()).toEqual([]);
  });

  test("missing record access and removal are harmless", async () => {
    const store = journal();
    expect(store.get("missing")).toBeUndefined();
    expect(store.latestForSession("missing")).toBeUndefined();
    await store.forget("missing");
    expect(store.allRecords()).toEqual([]);
  });

  test("markRetryable records a safe retry even if preparation is missing", async () => {
    const store = journal();
    await store.markRetryable("missing-preparation");

    expect(store.get("missing-preparation")).toMatchObject({
      requestId: "missing-preparation",
      bridgeSessionId: "",
      threadId: null,
      state: "retryable",
    });
  });

  test("latestForSession uses mutation order when timestamps tie", async () => {
    const store = journal({ now: () => 1_000 });
    await store.markPrepared({ requestId: "first", bridgeSessionId: "s1", threadId: "t1" });
    await store.markTerminal("first", "completed");
    await store.markPrepared({ requestId: "second", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("second");

    expect(store.latestForSession("s1")?.requestId).toBe("second");
  });

  test("unresolved lists exactly what recovery must reconcile", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "pending", bridgeSessionId: "s1", threadId: "t1" });
    await store.markPrepared({ requestId: "running", bridgeSessionId: "s1", threadId: "t1" });
    await store.markAccepted("running", { threadId: "t1", turnId: "turn-1" });
    await store.markPrepared({ requestId: "done", bridgeSessionId: "s1", threadId: "t1" });
    await store.markTerminal("done", "completed");

    expect(store.unresolved().map((entry) => entry.requestId).sort()).toEqual([
      "pending",
      "running",
    ]);
  });

  test("forget clears a prepared record once proven not to have run", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "req-1", bridgeSessionId: "s1", threadId: "t1" });
    await store.forget("req-1");

    expect(store.classify("req-1").action).toBe("dispatch");
  });
});

describe("persistence across a bridge restart", () => {
  test("an accepted dispatch survives a restart so it is not re-run", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-persist-"));
    temporaryDirs.push(codexHome);

    const first = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await first.load();
    await first.markPrepared({ requestId: "req-1", bridgeSessionId: "s1", threadId: "t1" });
    await first.markAccepted("req-1", { threadId: "t1", turnId: "turn-1" });

    // Fresh process, same CODEX_HOME.
    const second = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await second.load();

    expect(second.classify("req-1")).toMatchObject({ duplicate: true, action: "attach" });
    expect(second.get("req-1")?.turnId).toBe("turn-1");
  });

  test("a retryable dispatch marker survives restart and remains session-addressable", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-retryable-"));
    temporaryDirs.push(codexHome);
    const first = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await first.load();
    await first.markPrepared({ requestId: "req-retry", bridgeSessionId: "s1", threadId: null });
    await first.markRetryable("req-retry");

    const second = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await second.load();
    expect(second.classify("req-retry")).toMatchObject({
      duplicate: true,
      action: "dispatch",
      record: { state: "retryable" },
    });
    expect(second.latestForSession("s1")?.requestId).toBe("req-retry");
  });

  test("a journal for a different cwd is not read", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-cwd-"));
    temporaryDirs.push(codexHome);

    const first = new DispatchJournal({ codexHome, cwd: "/workspace-a", persist: true });
    await first.load();
    await first.markPrepared({ requestId: "req-1", bridgeSessionId: "s1", threadId: "t1" });

    const other = new DispatchJournal({ codexHome, cwd: "/workspace-b", persist: true });
    await other.load();
    expect(other.classify("req-1").action).toBe("dispatch");
  });

  test("a missing journal starts empty without blocking dispatch", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-corrupt-"));
    temporaryDirs.push(codexHome);
    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });

    await store.load();
    expect(store.allRecords()).toEqual([]);
    expect(store.classify("new").action).toBe("dispatch");
  });

  test("prepare fails closed when its safety record cannot be persisted", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-unwritable-"));
    temporaryDirs.push(codexHome);
    writeFileSync(join(codexHome, "orkestrator-bridge"), "blocks journal directory creation");
    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    await expect(
      store.markPrepared({
        requestId: "req-1",
        bridgeSessionId: "s1",
        threadId: "t1",
      }),
    ).rejects.toThrow();
  });
});

describe("garbage collection", () => {
  test("old terminal records are dropped", async () => {
    let clock = 0;
    const store = new DispatchJournal({
      codexHome: mkdtempSync(join(tmpdir(), "ork-journal-gc-")),
      cwd: "/workspace",
      persist: false,
      retentionMs: 1_000,
      now: () => clock,
    });

    await store.markPrepared({ requestId: "old", bridgeSessionId: "s1", threadId: "t1" });
    await store.markTerminal("old", "completed");
    clock += 10_000;
    await store.markPrepared({ requestId: "new", bridgeSessionId: "s1", threadId: "t1" });

    expect(store.allRecords().map((entry) => entry.requestId)).toEqual(["new"]);
  });

  test("unresolved capacity exhaustion rejects before replacing safety state", async () => {
    const store = journal({ maxRecords: 2 });
    for (const requestId of ["a", "b"]) {
      await store.markPrepared({ requestId, bridgeSessionId: "s1", threadId: "t1" });
    }

    await expect(store.markPrepared({
      requestId: "c",
      bridgeSessionId: "s1",
      threadId: "t1",
    })).rejects.toThrow("safety-record limit (2) is exhausted");

    expect(store.unresolved().map((record) => record.requestId)).toEqual(["a", "b"]);
    expect(store.classify("c").action).toBe("dispatch");
  });

  test("serialized-byte exhaustion rejects without dropping unresolved records", async () => {
    const store = journal({ maxRecords: 10, maxBytes: 600 });
    await store.markPrepared({ requestId: "a", bridgeSessionId: "s1", threadId: "t1" });

    await expect(store.markPrepared({
      requestId: "b".repeat(200),
      bridgeSessionId: "s2",
      threadId: "t2",
    })).rejects.toThrow("byte limit (600) is exhausted");

    expect(store.unresolved().map((record) => record.requestId)).toEqual(["a"]);
  });

  test("old retryable records expire without affecting unresolved records", async () => {
    let clock = 0;
    const store = journal({ now: () => clock, retentionMs: 1_000 });
    await store.markPrepared({ requestId: "retry", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("retry");
    await store.markPrepared({ requestId: "running", bridgeSessionId: "s2", threadId: "t2" });
    await store.markAccepted("running", { threadId: "t2", turnId: "turn-2" });

    clock = 10_000;
    await store.markPrepared({ requestId: "trigger", bridgeSessionId: "s3", threadId: "t3" });

    expect(store.get("retry")).toBeUndefined();
    expect(store.unresolved().map((record) => record.requestId).sort()).toEqual([
      "running",
      "trigger",
    ]);
  });

  test("only the newest retryable marker is retained for each session", async () => {
    let clock = 0;
    const store = journal({ now: () => clock });
    await store.markPrepared({ requestId: "old", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("old");
    clock += 1;
    await store.markPrepared({ requestId: "new", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("new");

    expect(store.get("old")).toBeUndefined();
    expect(store.latestForSession("s1")?.requestId).toBe("new");
  });

  test("a newer settled dispatch makes an older retryable marker obsolete", async () => {
    let clock = 0;
    const store = journal({ now: () => clock });
    await store.markPrepared({ requestId: "retry", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("retry");
    clock += 1;
    await store.markPrepared({ requestId: "done", bridgeSessionId: "s1", threadId: "t1" });
    await store.markTerminal("done", "completed");

    expect(store.get("retry")).toBeUndefined();
    expect(store.latestForSession("s1")?.requestId).toBe("done");
  });

  test("capacity sheds retryable and terminal records but preserves unresolved safety state", async () => {
    const store = journal({ maxRecords: 2 });
    await store.markPrepared({ requestId: "safe", bridgeSessionId: "s3", threadId: "t3" });
    await store.markRetryable("safe");
    await store.markPrepared({ requestId: "pending-a", bridgeSessionId: "s1", threadId: "t1" });
    await store.markPrepared({ requestId: "pending-b", bridgeSessionId: "s2", threadId: "t2" });

    expect(store.get("safe")).toBeUndefined();
    expect(store.unresolved().map((record) => record.requestId).sort()).toEqual([
      "pending-a",
      "pending-b",
    ]);
  });

  test("capacity sheds the oldest terminal record before newer safe records", async () => {
    let clock = 0;
    const store = journal({ maxRecords: 2, now: () => clock });
    await store.markPrepared({ requestId: "old-terminal", bridgeSessionId: "s1", threadId: "t1" });
    await store.markTerminal("old-terminal", "completed");
    clock += 1;
    await store.markPrepared({ requestId: "new-terminal", bridgeSessionId: "s2", threadId: "t2" });
    await store.markTerminal("new-terminal", "completed");
    clock += 1;
    await store.markPrepared({ requestId: "retry", bridgeSessionId: "s3", threadId: "t3" });
    await store.markRetryable("retry");

    expect(store.get("old-terminal")).toBeUndefined();
    expect(store.allRecords().map((record) => record.requestId).sort()).toEqual([
      "new-terminal",
      "retry",
    ]);
  });

  test("retention on load never drops an unresolved dispatch", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-load-gc-"));
    temporaryDirs.push(codexHome);
    let clock = 0;
    const first = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      retentionMs: 1_000,
      now: () => clock,
    });
    await first.load();
    await first.markPrepared({ requestId: "prepared", bridgeSessionId: "s1", threadId: "t1" });
    await first.markPrepared({ requestId: "accepted", bridgeSessionId: "s2", threadId: "t2" });
    await first.markAccepted("accepted", { threadId: "t2", turnId: "turn-2" });

    clock = 10_000;
    const restored = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      retentionMs: 1_000,
      now: () => clock,
    });
    await restored.load();

    expect(restored.unresolved().map((record) => record.requestId).sort()).toEqual([
      "accepted",
      "prepared",
    ]);
  });
});

describe("sequence assignment", () => {
  /**
   * Same instant on every record, so only the sequence can break the tie.
   */
  const SAME_INSTANT = new Date().toISOString();

  function legacyRecord(
    requestId: string,
    extra: Partial<PromptDispatchRecord> = {},
  ): Record<string, unknown> {
    return {
      requestId,
      bridgeSessionId: "s1",
      threadId: "t1",
      state: "prepared",
      createdAt: SAME_INSTANT,
      updatedAt: SAME_INSTANT,
      ...extra,
    };
  }

  test("a legacy file with no sequence field is numbered in file order", async () => {
    // Journals written before `sequence` existed still have to order their
    // records, and `latestForSession` is what a status snapshot reads.
    const { codexHome } = journalHome("ork-journal-legacy-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [legacyRecord("first"), legacyRecord("second"), legacyRecord("third")],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    expect(store.allRecords().map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(store.latestForSession("s1")?.requestId).toBe("third");
  });

  test("hostile sequence values are replaced with monotonic ones", async () => {
    const { codexHome } = journalHome("ork-journal-hostile-seq-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        legacyRecord("zero", { sequence: 0 }),
        legacyRecord("negative", { sequence: -5 }),
        legacyRecord("fractional", { sequence: 1.5 }),
        legacyRecord("beyond-safe", { sequence: Number.MAX_SAFE_INTEGER + 1 }),
        legacyRecord("valid", { sequence: 10 }),
      ],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    const sequences = store.allRecords().map((record) => record.sequence!);
    expect(sequences).toEqual([1, 2, 3, 4, 10]);
    expect(sequences.every((value) => Number.isSafeInteger(value) && value > 0)).toBe(true);
    expect(store.latestForSession("s1")?.requestId).toBe("valid");

    // A record written after the load must still sort newest, which only holds
    // if the counter resumed past the largest value it accepted.
    await store.markPrepared({ requestId: "fresh", bridgeSessionId: "s1", threadId: "t1" });
    expect(store.get("fresh")?.sequence).toBe(11);
  });

  test("an unparseable timestamp falls back to the sequence", async () => {
    const { codexHome } = journalHome("ork-journal-nan-time-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        legacyRecord("older", { updatedAt: "not-a-timestamp", sequence: 1 }),
        legacyRecord("newer", { updatedAt: "not-a-timestamp", sequence: 2 }),
      ],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    expect(store.latestForSession("s1")?.requestId).toBe("newer");
  });

  test("sequence remains authoritative when the wall clock moves backwards", async () => {
    const { codexHome } = journalHome("ork-journal-clock-rollback-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        legacyRecord("older", { updatedAt: "2026-08-05T12:00:00.000Z", sequence: 1 }),
        legacyRecord("newer", { updatedAt: "2026-08-05T11:00:00.000Z", sequence: 2 }),
      ],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    expect(store.latestForSession("s1")?.requestId).toBe("newer");
  });

  test("a full timestamp and sequence tie is broken by request id", async () => {
    const { codexHome } = journalHome("ork-journal-tie-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        legacyRecord("aaa", { sequence: 5 }),
        legacyRecord("bbb", { sequence: 5 }),
      ],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    // Arbitrary but total: two records that are indistinguishable on every
    // ordering field must still produce a stable answer rather than depending on
    // Map iteration order.
    expect(store.latestForSession("s1")?.requestId).toBe("bbb");
  });
});

describe("load rejects shapes it cannot trust", () => {
  test("a journal written by a different version blocks unknown dispatches", async () => {
    const { codexHome } = journalHome("ork-journal-version-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION + 1,
      records: [{
        requestId: "future",
        bridgeSessionId: "s1",
        threadId: "t1",
        state: "prepared",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    expect(store.allRecords()).toEqual([]);
    expect(store.classify("new")).toMatchObject({
      action: "blocked",
      reason: "Dispatch journal has an unsupported or malformed file shape",
    });
  });

  test("a records field that is not an array blocks unknown dispatches", async () => {
    const { codexHome } = journalHome("ork-journal-records-shape-");
    writeJournalFile(codexHome, { version: DISPATCH_JOURNAL_VERSION, records: "nope" });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    expect(store.allRecords()).toEqual([]);
    expect(store.classify("new").action).toBe("blocked");
  });

  test("invalid JSON blocks unknown dispatches", async () => {
    const { codexHome, path } = journalHome("ork-journal-invalid-json-");
    mkdirSync(join(codexHome, "orkestrator-bridge"), { recursive: true });
    writeFileSync(path, "{not-json", "utf8");

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    expect(store.classify("new")).toMatchObject({
      action: "blocked",
      reason: "Dispatch journal could not be safely decoded",
    });
    await expect(store.markPrepared({
      requestId: "new",
      bridgeSessionId: "s1",
      threadId: "t1",
    })).rejects.toThrow("could not be safely decoded");
    await expect(store.markTerminal("unknown", "failed"))
      .rejects.toThrow("could not be safely decoded");
    expect(store.classify("new").action).toBe("blocked");
  });

  test("an oversized journal is rejected before JSON decoding", async () => {
    const { codexHome, path } = journalHome("ork-journal-oversized-");
    mkdirSync(join(codexHome, "orkestrator-bridge"), { recursive: true });
    // Deliberately invalid JSON as well: the size guard must be the reported
    // failure, proving the decoder never received the oversized contents.
    writeFileSync(path, "x".repeat(257), "utf8");

    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      maxBytes: 256,
    });
    await store.load();

    expect(store.classify("new")).toMatchObject({
      action: "blocked",
      reason: "Dispatch journal exceeds its 256-byte read limit",
    });
  });

  test("loaded safety records over the count cap are retained but block unknown dispatches", async () => {
    const { codexHome } = journalHome("ork-journal-loaded-count-cap-");
    const timestamp = new Date().toISOString();
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        { requestId: "prepared-a", bridgeSessionId: "s1", threadId: "t1", state: "prepared", createdAt: timestamp, updatedAt: timestamp, sequence: 1 },
        { requestId: "prepared-b", bridgeSessionId: "s2", threadId: "t2", state: "prepared", createdAt: timestamp, updatedAt: timestamp, sequence: 2 },
        { requestId: "quarantined", bridgeSessionId: "s3", threadId: "t3", state: "unknown", createdAt: timestamp, updatedAt: timestamp, sequence: 3 },
      ],
    });

    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      maxRecords: 2,
    });
    await store.load();

    expect(store.allRecords()).toHaveLength(3);
    expect(store.classify("prepared-a").action).toBe("reconcile");
    expect(store.classify("quarantined")).toMatchObject({
      action: "already-done",
      record: { quarantined: true },
    });
    expect(store.classify("unknown")).toMatchObject({
      action: "blocked",
      reason: "Dispatch journal safety state exceeds its 2-record limit",
    });
  });

  test("settlement clears a recovered capacity block without a restart", async () => {
    const { codexHome } = journalHome("ork-journal-loaded-cap-recovery-");
    const timestamp = new Date().toISOString();
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: ["a", "b", "c"].map((requestId, index) => ({
        requestId,
        bridgeSessionId: `s${index}`,
        threadId: `t${index}`,
        state: "prepared",
        createdAt: timestamp,
        updatedAt: timestamp,
        sequence: index + 1,
      })),
    });
    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      maxRecords: 2,
    });
    await store.load();
    expect(store.classify("new").action).toBe("blocked");

    // The first settlement is collected to reach the cap; the second leaves a
    // safe terminal record that admission can shed for the next request.
    await store.markTerminal("a", "failed");
    await store.markTerminal("b", "failed");

    expect(store.allRecords()).toHaveLength(2);
    expect(store.classify("new").action).toBe("dispatch");
    await store.markPrepared({ requestId: "new", bridgeSessionId: "s-new", threadId: "t-new" });
    expect(store.unresolved().map((record) => record.requestId).sort()).toEqual(["c", "new"]);
  });

  test("compact input that inflates past the normalized byte cap blocks unknown dispatches", async () => {
    const { codexHome, path } = journalHome("ork-journal-normalized-byte-cap-");
    const timestamp = new Date().toISOString();
    const contents = JSON.stringify({
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        { requestId: "prepared-a", bridgeSessionId: "s1", threadId: "t1", state: "prepared", createdAt: timestamp, updatedAt: timestamp, sequence: 1 },
        { requestId: "prepared-b", bridgeSessionId: "s2", threadId: "t2", state: "prepared", createdAt: timestamp, updatedAt: timestamp, sequence: 2 },
      ],
    });
    mkdirSync(join(codexHome, "orkestrator-bridge"), { recursive: true });
    writeFileSync(path, contents, "utf8");
    const maxBytes = Buffer.byteLength(contents, "utf8");

    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      maxBytes,
    });
    await store.load();

    expect(store.unresolved()).toHaveLength(2);
    expect(store.classify("unknown")).toMatchObject({
      action: "blocked",
      reason: `Dispatch journal normalized safety state exceeds its ${maxBytes}-byte limit`,
    });
  });

  test("records without a string request id are skipped, not fatal", async () => {
    const { codexHome } = journalHome("ork-journal-bad-id-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        { requestId: 42, bridgeSessionId: "s1", state: "prepared" },
        null,
        {
          requestId: "good",
          bridgeSessionId: "s1",
          threadId: "t1",
          state: "prepared",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    expect(store.allRecords().map((record) => record.requestId)).toEqual(["good"]);
  });

  test("records with an addressable id but malformed state are quarantined fail-closed", async () => {
    const { codexHome } = journalHome("ork-journal-malformed-records-");
    const timestamp = new Date().toISOString();
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        { requestId: "unknown-state", bridgeSessionId: "s1", threadId: "t1", state: "surprise", createdAt: timestamp, updatedAt: timestamp },
        { requestId: "missing-session", threadId: "t1", state: "prepared", createdAt: timestamp, updatedAt: timestamp },
        { requestId: "bad-thread", bridgeSessionId: "s1", threadId: 42, state: "prepared", createdAt: timestamp, updatedAt: timestamp },
        { requestId: "accepted-no-turn", bridgeSessionId: "s1", threadId: "t1", state: "accepted", createdAt: timestamp, updatedAt: timestamp },
        { requestId: "bad-terminal", bridgeSessionId: "s1", threadId: "t1", state: "terminal", terminalStatus: "unknown", createdAt: timestamp, updatedAt: timestamp },
        { requestId: "retryable-with-turn", bridgeSessionId: "s1", threadId: "t1", turnId: "turn-1", state: "retryable", createdAt: timestamp, updatedAt: timestamp },
        { requestId: "bad-time", bridgeSessionId: "s1", threadId: "t1", state: "prepared", createdAt: "invalid", updatedAt: timestamp },
        { requestId: "good", bridgeSessionId: "s1", threadId: "t1", state: "prepared", createdAt: timestamp, updatedAt: timestamp },
      ],
    });

    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();

    for (const requestId of [
      "unknown-state",
      "missing-session",
      "bad-thread",
      "accepted-no-turn",
      "bad-terminal",
      "retryable-with-turn",
      "bad-time",
    ]) {
      expect(store.classify(requestId)).toMatchObject({
        duplicate: true,
        action: "already-done",
        record: { state: "terminal", terminalStatus: "failed" },
      });
    }
    expect(store.classify("good").action).toBe("reconcile");
  });

  test("quarantined ids never expire or yield to capacity collection", async () => {
    const { codexHome } = journalHome("ork-journal-quarantine-retention-");
    let clock = 0;
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [{
        requestId: "ambiguous",
        bridgeSessionId: "s1",
        threadId: "t1",
        state: "unknown",
        createdAt: "invalid",
        updatedAt: "invalid",
      }],
    });
    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      retentionMs: 1,
      maxRecords: 2,
      now: () => clock,
    });
    await store.load();
    clock = 10_000;
    await store.markPrepared({ requestId: "new", bridgeSessionId: "s2", threadId: "t2" });

    expect(store.classify("ambiguous")).toMatchObject({
      action: "already-done",
      record: { quarantined: true, terminalStatus: "failed" },
    });
    await store.markTerminal("ambiguous", "completed");
    expect(store.get("ambiguous")).toMatchObject({
      quarantined: true,
      terminalStatus: "failed",
    });
    await store.forget("ambiguous");
    expect(store.classify("ambiguous").action).toBe("already-done");

    const restored = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      retentionMs: 1,
      maxRecords: 2,
      now: () => clock,
    });
    await restored.load();
    expect(restored.classify("ambiguous")).toMatchObject({
      action: "already-done",
      record: { quarantined: true },
    });
    await expect(restored.markPrepared({
      requestId: "third",
      bridgeSessionId: "s3",
      threadId: "t3",
    })).rejects.toThrow("safety-record limit (2) is exhausted");
  });

  test("a second load does not re-read the file over live state", async () => {
    const { codexHome } = journalHome("ork-journal-reload-");
    writeJournalFile(codexHome, { version: DISPATCH_JOURNAL_VERSION, records: [] });
    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();
    await store.markPrepared({ requestId: "live", bridgeSessionId: "s1", threadId: "t1" });

    // Another process rewriting the file must not be adopted mid-flight: this
    // journal's in-memory records are the authority for its own dispatches.
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [{
        requestId: "from-disk",
        bridgeSessionId: "s1",
        threadId: "t1",
        state: "prepared",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    });
    await store.load();

    expect(store.allRecords().map((record) => record.requestId)).toEqual(["live"]);
  });
});

describe("transitions without a prior prepared record", () => {
  test("markAccepted records the turn even with no preparation on file", async () => {
    const store = journal({ now: () => 5_000 });
    await store.markAccepted("orphan", { threadId: "t1", turnId: "turn-1" });

    expect(store.get("orphan")).toMatchObject({
      requestId: "orphan",
      bridgeSessionId: "",
      threadId: "t1",
      turnId: "turn-1",
      state: "accepted",
    });
    expect(store.get("orphan")!.createdAt).toBe(store.get("orphan")!.updatedAt);
  });

  test("markTerminal settles an id with no preparation on file", async () => {
    const store = journal();
    await store.markTerminal("orphan", "failed");

    expect(store.get("orphan")).toMatchObject({
      requestId: "orphan",
      bridgeSessionId: "",
      threadId: null,
      state: "terminal",
      terminalStatus: "failed",
    });
    expect(store.get("orphan")!.turnId).toBeUndefined();
    // Still spent: the write may already have had side effects.
    expect(store.classify("orphan").action).toBe("already-done");
  });

  test("markTerminal prefers explicit ids and inherits the rest", async () => {
    const store = journal();
    await store.markPrepared({ requestId: "a", bridgeSessionId: "s1", threadId: "t-prepared" });
    await store.markAccepted("a", { threadId: "t-prepared", turnId: "turn-prepared" });
    await store.markTerminal("a", "completed");
    expect(store.get("a")).toMatchObject({
      threadId: "t-prepared",
      turnId: "turn-prepared",
    });

    await store.markPrepared({ requestId: "b", bridgeSessionId: "s1", threadId: "t-prepared" });
    await store.markAccepted("b", { threadId: "t-prepared", turnId: "turn-prepared" });
    await store.markTerminal("b", "completed", {
      threadId: "t-explicit",
      turnId: "turn-explicit",
    });
    expect(store.get("b")).toMatchObject({
      threadId: "t-explicit",
      turnId: "turn-explicit",
    });
  });
});

describe("flush failure handling", () => {
  test("a non-fail-closed write failure warns instead of throwing", async () => {
    const { codexHome } = journalHome("ork-journal-soft-fail-");
    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();
    writeFileSync(join(codexHome, "orkestrator-bridge"), "blocks journal directory creation");

    const warnings = await captureWarnings(async () => {
      // Losing this marker only costs a retry opportunity, never correctness, so
      // it must not fail the caller the way markPrepared does.
      await store.markRetryable("soft");
    });

    expect(warnings.some((line) => line.includes("Failed to persist dispatch journal"))).toBe(true);
    expect(store.get("soft")).toMatchObject({ state: "retryable" });
  });

  test("a failed rename removes its temporary file", async () => {
    const { codexHome, path } = journalHome("ork-journal-rename-fail-");
    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });
    await store.load();
    mkdirSync(path, { recursive: true });

    await captureWarnings(async () => {
      await store.markRetryable("temp-cleanup");
    });

    // A leaked temp file per failed write would grow CODEX_HOME without bound.
    expect(
      readdirSync(join(codexHome, "orkestrator-bridge")).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});

describe("garbage collection edge cases", () => {
  test("session-less records do not evict each other through the empty sentinel", async () => {
    // Regression: every record that lost its session id shares `""`. Grouping
    // them made unrelated requests compete for one "latest" slot, so the newest
    // orphan deleted every other one in the journal.
    const store = journal();
    await store.markRetryable("orphan-a");
    await store.markRetryable("orphan-b");

    expect(store.allRecords().map((record) => record.requestId).sort()).toEqual([
      "orphan-a",
      "orphan-b",
    ]);
  });

  test("the empty sentinel does not shield a real session from its own sweep", async () => {
    let clock = 0;
    const store = journal({ now: () => clock });
    await store.markRetryable("orphan");
    await store.markPrepared({ requestId: "old", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("old");
    clock += 1;
    await store.markPrepared({ requestId: "new", bridgeSessionId: "s1", threadId: "t1" });
    await store.markRetryable("new");

    expect(store.allRecords().map((record) => record.requestId).sort()).toEqual([
      "new",
      "orphan",
    ]);
  });

  test("a record with an unparseable timestamp is quarantined instead of trusted", async () => {
    const { codexHome } = journalHome("ork-journal-bad-clock-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        {
          requestId: "terminal-garbage",
          bridgeSessionId: "s1",
          threadId: "t1",
          state: "terminal",
          terminalStatus: "completed",
          createdAt: "garbage",
          updatedAt: "garbage",
          sequence: 1,
        },
        {
          requestId: "prepared-garbage",
          bridgeSessionId: "s2",
          threadId: "t2",
          state: "prepared",
          createdAt: "garbage",
          updatedAt: "garbage",
          sequence: 2,
        },
      ],
    });

    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      retentionMs: 1_000,
      now: () => 10_000_000,
    });
    await store.load();

    // Both ids stay spent, but malformed data never reaches recovery as an
    // unknown state or an invalid clock value.
    expect(store.allRecords().map((record) => record.requestId).sort()).toEqual([
      "prepared-garbage",
      "terminal-garbage",
    ]);
    expect(store.allRecords().every(
      (record) => record.state === "terminal" && record.terminalStatus === "failed",
    )).toBe(true);
  });

  test("collection during load is not written back until the next mutation", async () => {
    const { codexHome } = journalHome("ork-journal-lazy-write-");
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [{
        requestId: "expired",
        bridgeSessionId: "s1",
        threadId: "t1",
        state: "terminal",
        terminalStatus: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sequence: 1,
      }],
    });
    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      retentionMs: 1_000,
      now: () => Date.parse("2026-01-02T00:00:00.000Z"),
    });
    await store.load();

    expect(store.get("expired")).toBeUndefined();
    // Load itself does not write. That keeps startup read-only, so an unwritable
    // CODEX_HOME cannot turn a restart into a warning storm.
    expect(readJournalFile(codexHome).records.map((record) => record.requestId))
      .toEqual(["expired"]);

    await store.markPrepared({ requestId: "next", bridgeSessionId: "s1", threadId: "t1" });
    expect(readJournalFile(codexHome).records.map((record) => record.requestId))
      .toEqual(["next"]);
  });

  test("old unresolved records remain spent until runtime reconciliation", async () => {
    const { codexHome } = journalHome("ork-journal-old-unresolved-");
    const old = "2020-01-01T00:00:00.000Z";
    writeJournalFile(codexHome, {
      version: DISPATCH_JOURNAL_VERSION,
      records: [
        { requestId: "prepared", bridgeSessionId: "s1", threadId: "t1", state: "prepared", createdAt: old, updatedAt: old, sequence: 1 },
        { requestId: "accepted", bridgeSessionId: "s2", threadId: "t2", turnId: "turn-2", state: "accepted", createdAt: old, updatedAt: old, sequence: 2 },
      ],
    });
    const store = new DispatchJournal({
      codexHome,
      cwd: "/workspace",
      persist: true,
      retentionMs: 1,
      maxRecords: 2,
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
    });
    await store.load();

    expect(store.unresolved().map((record) => record.requestId).sort()).toEqual([
      "accepted",
      "prepared",
    ]);
    await expect(store.markPrepared({
      requestId: "new",
      bridgeSessionId: "s3",
      threadId: "t3",
    })).rejects.toThrow("safety-record limit (2) is exhausted");
  });
});

describe("reconcileFromThreadTurns", () => {
  const runningTurn = {
    id: "turn-1",
    status: "inProgress",
    items: [{ type: "userMessage", clientId: "req-1" }],
  };
  const completedTurn = {
    id: "turn-2",
    status: "completed",
    items: [{ type: "userMessage", clientId: "req-2" }],
  };

  test("finds a still-running turn by client id and says attach", () => {
    expect(reconcileFromThreadTurns([runningTurn], "req-1")).toEqual({
      result: "attach",
      turnId: "turn-1",
      precedingItemIds: [],
    });
  });

  test("returns the authoritative item prefix before a steering message", () => {
    expect(reconcileFromThreadTurns([{
      id: "turn-1",
      status: "inProgress",
      items: [
        { type: "userMessage", clientId: "req-original" },
        { id: "before", type: "agentMessage" },
        { type: "userMessage", clientId: "req-steer" },
        { id: "after", type: "commandExecution" },
      ],
    }], "req-steer")).toEqual({
      result: "attach",
      turnId: "turn-1",
      precedingItemIds: ["before"],
    });
  });

  test("finds a finished turn and reports its status", () => {
    expect(reconcileFromThreadTurns([completedTurn], "req-2")).toEqual({
      result: "terminal",
      turnId: "turn-2",
      status: "completed",
      precedingItemIds: [],
    });
  });

  test("maps interrupted and failed through faithfully", () => {
    expect(
      reconcileFromThreadTurns(
        [{ id: "t", status: "interrupted", items: [{ type: "userMessage", clientId: "r" }] }],
        "r",
      ).status,
    ).toBe("interrupted");
    expect(
      reconcileFromThreadTurns(
        [{ id: "t", status: "failed", items: [{ type: "userMessage", clientId: "r" }] }],
        "r",
      ).status,
    ).toBe("failed");
  });

  test("reports absent when no turn carries the request id", () => {
    // Absent is what makes a single clean dispatch safe.
    expect(reconcileFromThreadTurns([runningTurn, completedTurn], "req-999")).toEqual({
      result: "absent",
    });
  });

  test("ignores a matching clientId on a non-userMessage item", () => {
    expect(
      reconcileFromThreadTurns(
        [{ id: "t", status: "completed", items: [{ type: "agentMessage", clientId: "req-1" }] }],
        "req-1",
      ),
    ).toEqual({ result: "absent" });
  });

  test("treats missing or empty turn history as absent", () => {
    expect(reconcileFromThreadTurns(undefined, "req-1")).toEqual({ result: "absent" });
    expect(reconcileFromThreadTurns([], "req-1")).toEqual({ result: "absent" });
    expect(reconcileFromThreadTurns([{ id: "t", status: "completed" }], "req-1")).toEqual({
      result: "absent",
    });
  });

  test("does not confuse two requests in the same thread", () => {
    const turns = [runningTurn, completedTurn];
    expect(reconcileFromThreadTurns(turns, "req-1").turnId).toBe("turn-1");
    expect(reconcileFromThreadTurns(turns, "req-2").turnId).toBe("turn-2");
  });
});
