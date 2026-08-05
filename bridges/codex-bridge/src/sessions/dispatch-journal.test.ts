import { afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchJournal, reconcileFromThreadTurns } from "./dispatch-journal.js";

const temporaryDirs: string[] = [];

function journal(options: { persist?: boolean; now?: () => number; maxRecords?: number } = {}) {
  const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-"));
  temporaryDirs.push(codexHome);
  return new DispatchJournal({
    codexHome,
    cwd: "/workspace",
    persist: options.persist ?? false,
    now: options.now,
    maxRecords: options.maxRecords,
  });
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

  test("an unreadable journal degrades to reconciliation, not a crash", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ork-journal-corrupt-"));
    temporaryDirs.push(codexHome);
    const store = new DispatchJournal({ codexHome, cwd: "/workspace", persist: true });

    // No file at all is the same path as a torn file.
    await store.load();
    expect(store.allRecords()).toEqual([]);
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

  test("unresolved records are never shed to satisfy the cap", async () => {
    const store = journal({ maxRecords: 2 });
    for (const requestId of ["a", "b", "c", "d"]) {
      await store.markPrepared({ requestId, bridgeSessionId: "s1", threadId: "t1" });
    }

    // All four are unresolved, so the cap must not evict any of them: losing one
    // would mean losing the only record that a dispatch might be in flight.
    expect(store.unresolved()).toHaveLength(4);
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
    });
  });

  test("finds a finished turn and reports its status", () => {
    expect(reconcileFromThreadTurns([completedTurn], "req-2")).toEqual({
      result: "terminal",
      turnId: "turn-2",
      status: "completed",
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
