import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CodexChangeEvidence,
  codexChangeEvidenceDir,
  createCodexChangeEvidence,
} from "./change-evidence.js";
import { collectBodyIds } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { migrateCodexChangeEvidence } from "./change-evidence-migration.js";
import { DispatchJournal, type PromptDispatchRecord } from "./sessions/dispatch-journal.js";
import { BridgeSessionStore, hashCwd } from "./sessions/persistence.js";

let root: string;
let previous: string | undefined;
let account: string;
let host: string;
const cwd = "/workspace";
beforeEach(() => {
  previous = process.env.CODEX_BRIDGE_STATE_DIR;
  delete process.env.CODEX_BRIDGE_STATE_DIR;
  root = mkdtempSync(join(tmpdir(), "codex-state-upgrade-"));
  account = join(root, "account");
  host = join(root, "host");
});
afterEach(() => {
  if (previous === undefined) delete process.env.CODEX_BRIDGE_STATE_DIR;
  else process.env.CODEX_BRIDGE_STATE_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const journalPath = (home: string) =>
  join(home, "orkestrator-bridge", `dispatch-journal-${hashCwd(cwd)}.json`);
const journal = (home = account) => new DispatchJournal({ codexHome: home, cwd });
function seed(home: string, records: unknown[]): void {
  mkdirSync(dirname(journalPath(home)), { recursive: true });
  writeFileSync(journalPath(home), JSON.stringify({ version: 1, records }));
}
function record(
  requestId: string,
  state: PromptDispatchRecord["state"],
  extra = {},
): PromptDispatchRecord {
  return {
    requestId,
    state,
    bridgeSessionId: "session-1",
    threadId: "thread-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(state === "accepted" ? { turnId: "turn-1" } : {}),
    ...(state === "terminal" ? { terminalStatus: "completed" as const } : {}),
    ...extra,
  };
}
function useShared(): void {
  process.env.CODEX_BRIDGE_STATE_DIR = join(host, "orkestrator-bridge");
}
function patch(evidence: CodexChangeEvidence, call: string): void {
  evidence.turnDiff(
    { sessionIds: ["session-1"], turnId: call },
    `diff --git a/${call} b/${call}\n+${call}\n`,
  );
}

describe("shared Codex state upgrade", () => {
  test.each([false, true])(
    "migrates dispatch safety state and the session (shared exists: %s)",
    async (sharedExists) => {
      seed(account, [
        record("prepared", "prepared"),
        record("accepted", "accepted"),
        record("terminal", "terminal"),
        record("retryable", "retryable", { bridgeSessionId: "retry-session" }),
        { requestId: "quarantined", state: "invalid" },
      ]);
      const sessions = new BridgeSessionStore({ codexHome: account, cwd });
      await sessions.upsert({
        bridgeSessionId: "session-1",
        threadId: "thread-1",
        cwdHash: hashCwd(cwd),
        config: { mode: "build" },
        lastAccessed: new Date().toISOString(),
      });
      if (sharedExists) seed(host, [record("host", "terminal")]);
      useShared();
      expect(await new BridgeSessionStore({ codexHome: account, cwd }).load()).toMatchObject([
        { bridgeSessionId: "session-1" },
      ]);
      const store = journal();
      await store.load();
      expect(store.classify("prepared").action).toBe("reconcile");
      expect(store.classify("accepted").action).toBe("attach");
      expect(store.classify("terminal").action).toBe("already-done");
      expect(store.classify("quarantined")).toMatchObject({
        action: "already-done",
        record: { quarantined: true },
      });
      expect(store.classify("retryable").action).toBe("dispatch");
      expect(existsSync(journalPath(account))).toBe(false);
      if (sharedExists) expect(store.classify("host").action).toBe("already-done");
      // Reconciliation and new work survive another restart without resurrecting
      // the retired source's prepared state.
      await store.markTerminal("prepared", "completed");
      const restarted = journal();
      await restarted.load();
      expect(restarted.classify("prepared").action).toBe("already-done");
      expect(restarted.classify("accepted").action).toBe("attach");
      expect(restarted.classify("quarantined").record?.quarantined).toBe(true);
    },
  );

  test("quarantines conflicting outcomes instead of guessing by independent sequences", async () => {
    seed(account, [record("conflict", "retryable", { sequence: 999 })]);
    seed(host, [record("conflict", "accepted", { sequence: 1 })]);
    useShared();
    for (let restart = 0; restart < 2; restart++) {
      const store = journal();
      await store.load();
      expect(store.classify("conflict")).toMatchObject({
        action: "already-done",
        record: { quarantined: true },
      });
      await expect(
        store.markPrepared({
          requestId: "conflict",
          bridgeSessionId: "session-1",
          threadId: "thread-1",
        }),
      ).rejects.toThrow();
    }
  });

  test("a corrupt legacy journal fences even a shared retryable identity", async () => {
    seed(account, []);
    writeFileSync(journalPath(account), "broken");
    seed(host, [record("retry", "retryable")]);
    useShared();
    const store = journal();
    await store.load();
    expect(store.classify("retry").action).toBe("blocked");
    expect(store.classify("unknown").action).toBe("blocked");
    expect(existsSync(journalPath(account))).toBe(true);
  });

  test.each([false, true])(
    "imports unacknowledged frames and bodies once (shared exists: %s)",
    async (sharedExists) => {
      const legacyDir = codexChangeEvidenceDir(account, cwd);
      const old = createCodexChangeEvidence({ codexHome: account, cwd });
      patch(old, "legacy");
      await old.spool.flush();
      const original = old.spool.read(0).entries;
      const legacyContents = readFileSync(join(legacyDir, "entries.jsonl"), "utf8");
      if (sharedExists) {
        const existing = createCodexChangeEvidence({ codexHome: host, cwd });
        patch(existing, "host");
        await existing.spool.flush();
      }
      useShared();
      // Reproduce a crash after publication but before the old entry file was
      // retired. Re-import must deduplicate frames and keep their body ids.
      migrateCodexChangeEvidence(legacyDir, codexChangeEvidenceDir(account, cwd));
      writeFileSync(join(legacyDir, "entries.jsonl"), legacyContents);
      const imported = createCodexChangeEvidence({ codexHome: account, cwd });
      const response = imported.spool.read(0);
      expect(response.entries).toHaveLength(sharedExists ? 2 : 1);
      for (const entry of original) {
        expect(response.entries).toContainEqual({
          ...entry,
          seq: response.entries.find(
            (e) =>
              e.type === "frame" &&
              entry.type === "frame" &&
              e.frame.frameId === entry.frame.frameId,
          )!.seq,
        });
      }
      const bodyIds = response.entries.flatMap((e) =>
        e.type === "frame" ? collectBodyIds(e.frame) : [],
      );
      for (const id of bodyIds) expect(imported.spool.readBody(id)).not.toBeNull();
      expect(existsSync(join(legacyDir, "entries.jsonl"))).toBe(false);
      await imported.spool.flush();
      const restarted = createCodexChangeEvidence({ codexHome: account, cwd });
      expect(restarted.spool.read(0).entries).toHaveLength(response.entries.length);
      const replay = restarted.spool.read(0);
      expect(
        restarted.spool.acknowledge({
          runtimeEpoch: replay.runtimeEpoch,
          upTo: replay.nextCursor,
          retainedBodyIds: bodyIds,
          unavailableBodyIds: [],
        }).released,
      ).toBe(response.entries.length);
      for (const id of bodyIds) expect(restarted.spool.readBody(id)).toBeNull();
      await restarted.spool.flush();
      const afterAck = createCodexChangeEvidence({ codexHome: account, cwd });
      expect(afterAck.spool.read(0).entries).toEqual([]);
      await afterAck.spool.flush();
    },
  );

  test("evidence identity conflicts retain both source files for recovery", async () => {
    const old = createCodexChangeEvidence({ codexHome: account, cwd });
    patch(old, "legacy");
    await old.spool.flush();
    const source = join(codexChangeEvidenceDir(account, cwd), "entries.jsonl");
    const sharedDir = codexChangeEvidenceDir(host, cwd);
    mkdirSync(sharedDir, { recursive: true });
    const line = JSON.parse(readFileSync(source, "utf8").trim());
    line.entry.frame.source.conversationId = "conflict";
    const target = join(sharedDir, "entries.jsonl");
    writeFileSync(target, `${JSON.stringify(line)}\n`);
    expect(() => migrateCodexChangeEvidence(dirname(source), sharedDir)).toThrow(
      "conflicting identities",
    );
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("conflict");
  });

  test("fresh stores stay in the host home across account switches without legacy files", async () => {
    useShared();
    const first = journal();
    await first.load();
    await first.markPrepared({
      requestId: "cross-account",
      bridgeSessionId: "session-1",
      threadId: "thread-1",
    });
    const evidence = createCodexChangeEvidence({ codexHome: account, cwd });
    patch(evidence, "cross-account");
    await evidence.spool.flush();
    const other = join(root, "other-account");
    const second = journal(other);
    await second.load();
    expect(second.classify("cross-account").action).toBe("reconcile");
    const recovered = createCodexChangeEvidence({ codexHome: other, cwd });
    expect(recovered.spool.read(0).entries).toHaveLength(1);
    await recovered.spool.flush();
    expect(existsSync(join(account, "orkestrator-bridge"))).toBe(false);
    expect(existsSync(join(other, "orkestrator-bridge"))).toBe(false);
    expect(existsSync(journalPath(host))).toBe(true);
  });
});
