/**
 * At-most-once prompt dispatch.
 *
 * This is the single most important correctness requirement in the migration. A
 * turn can execute shell commands and edit files, so running one twice is
 * destructive — and the window is real: the connection can die *after* we wrote
 * `turn/start` but *before* we read its response, leaving us genuinely unable to
 * tell whether it ran.
 *
 * The journal records intent on both sides of that ambiguity boundary:
 *
 *      journal("prepared")          ← we are about to write turn/start
 *          write turn/start          ← ambiguity begins here
 *      journal("accepted", turnId)   ← ambiguity ends here
 *
 * On recovery, a `prepared` record means "unknown, go reconcile"; `accepted`
 * means "attach to this turn"; `terminal` means "already finished, do not re-run".
 *
 * Reconciliation itself uses `clientUserMessageId`: the browser's request id is
 * passed to `turn/start` and echoed back on the persisted `userMessage` item as
 * `clientId`, so `thread/read` can answer "did this exact request run?" without
 * guessing. Matching on prompt *text* would be wrong — the same text sent twice
 * is two legitimate turns.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashCwd } from "./persistence.js";

export type DispatchState = "prepared" | "accepted" | "terminal";
export type DispatchTerminalStatus = "completed" | "interrupted" | "failed";

export interface PromptDispatchRecord {
  /** The browser's stable per-prompt id, used as `clientUserMessageId`. */
  requestId: string;
  bridgeSessionId: string;
  /** Null when the thread had not been created yet at prepare time. */
  threadId: string | null;
  turnId?: string;
  state: DispatchState;
  createdAt: string;
  updatedAt: string;
  terminalStatus?: DispatchTerminalStatus;
}

export const DISPATCH_JOURNAL_VERSION = 1;

interface JournalFile {
  version: number;
  records: PromptDispatchRecord[];
}

export interface DispatchJournalOptions {
  codexHome: string;
  cwd: string;
  /** Records older than this are garbage-collected. */
  retentionMs?: number;
  /** Hard cap so a long-lived environment cannot grow the file without bound. */
  maxRecords?: number;
  now?: () => number;
  /** Disables disk persistence (tests, ephemeral sessions). */
  persist?: boolean;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 500;

export interface DuplicateDecision {
  /** True when this request id has been seen before. */
  duplicate: boolean;
  /**
   * What the caller should do:
   *  - `dispatch`    — never seen; send it
   *  - `attach`      — already running; return the existing turn
   *  - `already-done`— already finished; do not re-run
   *  - `reconcile`   — ambiguous; check thread/read before deciding
   */
  action: "dispatch" | "attach" | "already-done" | "reconcile";
  record?: PromptDispatchRecord;
}

export class DispatchJournal {
  private readonly records = new Map<string, PromptDispatchRecord>();
  private readonly codexHome: string;
  private readonly cwdHash: string;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;
  private readonly persist: boolean;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(options: DispatchJournalOptions) {
    this.codexHome = options.codexHome;
    this.cwdHash = hashCwd(options.cwd);
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.now = options.now ?? Date.now;
    this.persist = options.persist !== false;
  }

  private path(): string {
    return join(this.codexHome, "orkestrator-bridge", `dispatch-journal-${this.cwdHash}.json`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persist) return;

    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as JournalFile;
      if (parsed.version !== DISPATCH_JOURNAL_VERSION || !Array.isArray(parsed.records)) return;
      const cutoff = this.now() - this.retentionMs;
      for (const record of parsed.records) {
        if (typeof record?.requestId !== "string") continue;
        const updatedAt = Date.parse(record.updatedAt ?? "");
        if (Number.isFinite(updatedAt) && updatedAt < cutoff) continue;
        this.records.set(record.requestId, record);
      }
    } catch {
      // No journal, or an unreadable one. Starting empty is safe: it only means
      // recovery falls back to reconciling against thread/read.
    }
  }

  /**
   * Decides what to do with an incoming request id.
   *
   * Note the asymmetry between `prepared` and `accepted`. `accepted` is
   * unambiguous — we saw the response. `prepared` is exactly the dangerous case:
   * we may or may not have dispatched, so the caller must reconcile rather than
   * assume either way.
   */
  classify(requestId: string): DuplicateDecision {
    const record = this.records.get(requestId);
    if (!record) return { duplicate: false, action: "dispatch" };

    switch (record.state) {
      case "accepted":
        return { duplicate: true, action: "attach", record };
      case "terminal":
        return { duplicate: true, action: "already-done", record };
      case "prepared":
        return { duplicate: true, action: "reconcile", record };
    }
  }

  get(requestId: string): PromptDispatchRecord | undefined {
    return this.records.get(requestId);
  }

  /** Written immediately *before* `turn/start`. */
  async markPrepared(options: {
    requestId: string;
    bridgeSessionId: string;
    threadId: string | null;
  }): Promise<PromptDispatchRecord> {
    const timestamp = new Date(this.now()).toISOString();
    const existing = this.records.get(options.requestId);
    const record: PromptDispatchRecord = {
      requestId: options.requestId,
      bridgeSessionId: options.bridgeSessionId,
      threadId: options.threadId,
      state: "prepared",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.records.set(record.requestId, record);
    // This write is the safety boundary for at-most-once dispatch. If it did not
    // reach disk, the caller must not proceed to turn/start.
    await this.flush({ failClosed: true });
    return record;
  }

  /** Written immediately *after* a successful `turn/start` response. */
  async markAccepted(
    requestId: string,
    options: { threadId: string; turnId: string },
  ): Promise<void> {
    const existing = this.records.get(requestId);
    const timestamp = new Date(this.now()).toISOString();
    this.records.set(requestId, {
      requestId,
      bridgeSessionId: existing?.bridgeSessionId ?? "",
      threadId: options.threadId,
      turnId: options.turnId,
      state: "accepted",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await this.flush();
  }

  async markTerminal(
    requestId: string,
    status: DispatchTerminalStatus,
    options: { threadId?: string; turnId?: string } = {},
  ): Promise<void> {
    const existing = this.records.get(requestId);
    const timestamp = new Date(this.now()).toISOString();
    this.records.set(requestId, {
      requestId,
      bridgeSessionId: existing?.bridgeSessionId ?? "",
      threadId: options.threadId ?? existing?.threadId ?? null,
      turnId: options.turnId ?? existing?.turnId,
      state: "terminal",
      terminalStatus: status,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await this.flush();
  }

  /**
   * Drops a `prepared` record once reconciliation proved the turn never ran, so
   * the request can be dispatched cleanly.
   */
  async forget(requestId: string): Promise<void> {
    if (this.records.delete(requestId)) await this.flush();
  }

  /** Records still in flight, i.e. what recovery has to reconcile. */
  unresolved(): PromptDispatchRecord[] {
    return [...this.records.values()].filter((record) => record.state !== "terminal");
  }

  allRecords(): PromptDispatchRecord[] {
    return [...this.records.values()];
  }

  /** Drops old and excess records; terminal ones go first. */
  private collectGarbage(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [requestId, record] of this.records) {
      const updatedAt = Date.parse(record.updatedAt);
      if (record.state === "terminal" && Number.isFinite(updatedAt) && updatedAt < cutoff) {
        this.records.delete(requestId);
      }
    }
    if (this.records.size <= this.maxRecords) return;

    // Over the cap: shed the oldest terminal records, never an unresolved one.
    const terminal = [...this.records.values()]
      .filter((record) => record.state === "terminal")
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    for (const record of terminal) {
      if (this.records.size <= this.maxRecords) break;
      this.records.delete(record.requestId);
    }
  }

  private flush(options: { failClosed?: boolean } = {}): Promise<void> {
    this.collectGarbage();
    if (!this.persist) return Promise.resolve();

    const snapshot: JournalFile = {
      version: DISPATCH_JOURNAL_VERSION,
      records: [...this.records.values()],
    };
    const attempt = this.writeChain.then(async () => {
      try {
        const path = this.path();
        await mkdir(join(this.codexHome, "orkestrator-bridge"), { recursive: true });
        const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
        await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
        await rename(temporary, path).catch(async (error: unknown) => {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        });
      } catch (error) {
        console.warn(
          "[codex-bridge] Failed to persist dispatch journal:",
          error instanceof Error ? error.message : error,
        );
        if (options.failClosed) throw error;
      }
    });
    this.writeChain = attempt.catch(() => undefined);
    return attempt;
  }
}

/** A `userMessage` item as returned inside `thread/read` turns. */
interface UserMessageLike {
  type?: string;
  clientId?: string | null;
}

interface TurnLike {
  id?: string;
  status?: string;
  items?: UserMessageLike[];
}

export interface ReconciliationOutcome {
  /**
   * - `attach`   — the turn exists and is still running
   * - `terminal` — the turn ran and finished
   * - `absent`   — no user message with this id was ever persisted
   */
  result: "attach" | "terminal" | "absent";
  turnId?: string;
  status?: DispatchTerminalStatus;
}

/**
 * Searches persisted turns for the request id, which is the only reliable way to
 * answer "did my dispatch execute?" after an ambiguous failure.
 */
export function reconcileFromThreadTurns(
  turns: readonly TurnLike[] | undefined,
  requestId: string,
): ReconciliationOutcome {
  for (const turn of turns ?? []) {
    const matches = (turn.items ?? []).some(
      (item) => item?.type === "userMessage" && item.clientId === requestId,
    );
    if (!matches) continue;

    if (turn.status === "inProgress") return { result: "attach", turnId: turn.id };
    return {
      result: "terminal",
      turnId: turn.id,
      status:
        turn.status === "interrupted"
          ? "interrupted"
          : turn.status === "failed"
            ? "failed"
            : "completed",
    };
  }
  return { result: "absent" };
}
