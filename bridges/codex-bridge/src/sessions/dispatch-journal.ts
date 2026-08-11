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
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashCwd } from "./persistence.js";

export type DispatchState = "prepared" | "accepted" | "retryable" | "terminal";
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
  /** Monotonic journal-local ordering for mutations sharing a millisecond. */
  sequence?: number;
  terminalStatus?: DispatchTerminalStatus;
  /** Malformed persisted state: permanently spent and never GC-eligible. */
  quarantined?: true;
}

export const DISPATCH_JOURNAL_VERSION = 1;

interface JournalFile {
  version: number;
  records: unknown[];
}

export interface DispatchJournalOptions {
  codexHome: string;
  cwd: string;
  /** Records older than this are garbage-collected. */
  retentionMs?: number;
  /** Hard cap so a long-lived environment cannot grow the file without bound. */
  maxRecords?: number;
  /** Hard serialized-byte cap for the complete journal file. */
  maxBytes?: number;
  now?: () => number;
  /** Disables disk persistence (tests, ephemeral sessions). */
  persist?: boolean;
}

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_MAX_BYTES = 1024 * 1024;

export interface DuplicateDecision {
  /** True when this request id has been seen before. */
  duplicate: boolean;
  /**
   * What the caller should do:
   *  - `dispatch`    — never seen; send it
   *  - `attach`      — already running; return the existing turn
   *  - `already-done`— already finished; do not re-run
   *  - `reconcile`   — ambiguous; check thread/read before deciding
   *  - `blocked`     — journal integrity was lost; fail closed
   */
  action: "dispatch" | "attach" | "already-done" | "reconcile" | "blocked";
  record?: PromptDispatchRecord;
  reason?: string;
}

export function compareDispatchRecordsNewestFirst(
  left: PromptDispatchRecord,
  right: PromptDispatchRecord,
): number {
  const sequenceDelta = (right.sequence ?? 0) - (left.sequence ?? 0);
  if (sequenceDelta !== 0) return sequenceDelta;
  const timestampDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (Number.isFinite(timestampDelta) && timestampDelta !== 0) return timestampDelta;
  return right.requestId.localeCompare(left.requestId);
}

export class DispatchJournalAdmissionError extends Error {}

export class DispatchJournalCapacityError extends DispatchJournalAdmissionError {
  constructor(message: string) {
    super(message);
    this.name = "DispatchJournalCapacityError";
  }
}

export class DispatchJournalIntegrityError extends DispatchJournalAdmissionError {
  constructor(message: string) {
    super(message);
    this.name = "DispatchJournalIntegrityError";
  }
}

const DISPATCH_STATES = new Set<DispatchState>([
  "prepared",
  "accepted",
  "retryable",
  "terminal",
]);
const TERMINAL_STATUSES = new Set<DispatchTerminalStatus>([
  "completed",
  "interrupted",
  "failed",
]);

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isPersistedRecord(value: unknown): value is PromptDispatchRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PromptDispatchRecord>;
  if (
    typeof record.requestId !== "string"
    || record.requestId.length === 0
    || typeof record.bridgeSessionId !== "string"
    || (record.threadId !== null && typeof record.threadId !== "string")
    || !isOptionalString(record.turnId)
    || !DISPATCH_STATES.has(record.state as DispatchState)
    || !isTimestamp(record.createdAt)
    || !isTimestamp(record.updatedAt)
    || (record.quarantined !== undefined && record.quarantined !== true)
  ) {
    return false;
  }
  if (record.state === "accepted") {
    return typeof record.threadId === "string"
      && record.threadId.length > 0
      && typeof record.turnId === "string"
      && record.turnId.length > 0
      && record.terminalStatus === undefined;
  }
  if (record.state === "terminal") {
    return TERMINAL_STATUSES.has(record.terminalStatus as DispatchTerminalStatus)
      && (!record.quarantined || record.terminalStatus === "failed");
  }
  return (record.threadId === null || record.threadId.length > 0)
    && record.turnId === undefined
    && record.terminalStatus === undefined;
}

export class DispatchJournal {
  private readonly records = new Map<string, PromptDispatchRecord>();
  private readonly codexHome: string;
  private readonly cwdHash: string;
  private readonly retentionMs: number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly persist: boolean;
  private writeChain: Promise<void> = Promise.resolve();
  private loaded = false;
  private nextSequence = 0;
  private integrityError: string | null = null;
  private capacityError: string | null = null;

  constructor(options: DispatchJournalOptions) {
    this.codexHome = options.codexHome;
    this.cwdHash = hashCwd(options.cwd);
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
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
      const parsed = JSON.parse(await this.readBounded()) as JournalFile;
      if (parsed.version !== DISPATCH_JOURNAL_VERSION || !Array.isArray(parsed.records)) {
        this.integrityError = "Dispatch journal has an unsupported or malformed file shape";
        return;
      }
      for (const persisted of parsed.records) {
        const candidate = persisted && typeof persisted === "object"
          ? persisted as Record<string, unknown>
          : undefined;
        const requestId = typeof candidate?.requestId === "string"
          ? candidate.requestId
          : "";
        if (!requestId) continue;
        const sequence = Number.isSafeInteger(candidate?.sequence) && Number(candidate?.sequence) > 0
          ? Number(candidate!.sequence)
          : this.nextSequence + 1;
        this.nextSequence = Math.max(this.nextSequence, sequence);
        const timestamp = new Date(this.now()).toISOString();
        const record: PromptDispatchRecord = isPersistedRecord(persisted)
          ? { ...persisted, sequence }
          : {
              requestId,
              bridgeSessionId:
                typeof candidate?.bridgeSessionId === "string" ? candidate.bridgeSessionId : "",
              threadId:
                typeof candidate?.threadId === "string" || candidate?.threadId === null
                  ? candidate.threadId
                  : null,
              state: "terminal",
              terminalStatus: "failed",
              quarantined: true,
              createdAt: timestamp,
              updatedAt: timestamp,
              sequence,
            };
        const existing = this.records.get(requestId);
        if (!existing || compareDispatchRecordsNewestFirst(record, existing) < 0) {
          this.records.set(requestId, record);
        }
      }
      this.collectGarbage();
      this.refreshCapacityError();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      this.integrityError = error instanceof DispatchJournalIntegrityError
        ? error.message
        : "Dispatch journal could not be safely decoded";
    }
  }

  private async readBounded(): Promise<string> {
    const handle = await open(this.path(), "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > this.maxBytes) {
        throw new DispatchJournalIntegrityError(
          `Dispatch journal exceeds its ${this.maxBytes}-byte read limit`,
        );
      }
      const buffer = Buffer.alloc(this.maxBytes + 1);
      let total = 0;
      while (total <= this.maxBytes) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          buffer.length - total,
          total,
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > this.maxBytes) {
        throw new DispatchJournalIntegrityError(
          `Dispatch journal exceeds its ${this.maxBytes}-byte read limit`,
        );
      }
      return buffer.subarray(0, total).toString("utf8");
    } finally {
      await handle.close();
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
    if (!record) {
      const blockedReason = this.integrityError ?? this.capacityError;
      if (blockedReason) {
        return {
          duplicate: false,
          action: "blocked",
          reason: blockedReason,
        };
      }
      return { duplicate: false, action: "dispatch" };
    }

    switch (record.state) {
      case "accepted":
        return { duplicate: true, action: "attach", record };
      case "terminal":
        return { duplicate: true, action: "already-done", record };
      case "prepared":
        return { duplicate: true, action: "reconcile", record };
      case "retryable":
        return { duplicate: true, action: "dispatch", record };
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
    if (this.integrityError) throw new DispatchJournalIntegrityError(this.integrityError);
    if (this.capacityError) throw new DispatchJournalCapacityError(this.capacityError);
    const timestamp = new Date(this.now()).toISOString();
    const existing = this.records.get(options.requestId);
    if (existing?.quarantined) {
      throw new DispatchJournalIntegrityError(
        `Dispatch ${options.requestId} is quarantined and cannot be reused`,
      );
    }
    const record: PromptDispatchRecord = {
      requestId: options.requestId,
      bridgeSessionId: options.bridgeSessionId,
      threadId: options.threadId,
      state: "prepared",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      sequence: this.nextSequence + 1,
    };
    this.admitPrepared(record);
    this.nextSequence = record.sequence!;
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
    if (this.integrityError) throw new DispatchJournalIntegrityError(this.integrityError);
    const existing = this.records.get(requestId);
    if (existing?.quarantined) {
      throw new DispatchJournalIntegrityError(`Dispatch ${requestId} is quarantined`);
    }
    const timestamp = new Date(this.now()).toISOString();
    this.records.set(requestId, {
      requestId,
      bridgeSessionId: existing?.bridgeSessionId ?? "",
      threadId: options.threadId,
      turnId: options.turnId,
      state: "accepted",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      sequence: ++this.nextSequence,
    });
    await this.flush();
  }

  async markTerminal(
    requestId: string,
    status: DispatchTerminalStatus,
    options: { threadId?: string; turnId?: string } = {},
  ): Promise<void> {
    if (this.integrityError) throw new DispatchJournalIntegrityError(this.integrityError);
    const existing = this.records.get(requestId);
    if (existing?.quarantined) return;
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
      sequence: ++this.nextSequence,
    });
    await this.flush();
  }

  /** Proven not to have run; the same idempotency key may be dispatched again. */
  async markRetryable(requestId: string): Promise<void> {
    if (this.integrityError) throw new DispatchJournalIntegrityError(this.integrityError);
    const existing = this.records.get(requestId);
    if (existing?.quarantined) {
      throw new DispatchJournalIntegrityError(`Dispatch ${requestId} is quarantined`);
    }
    const timestamp = new Date(this.now()).toISOString();
    this.records.set(requestId, {
      requestId,
      bridgeSessionId: existing?.bridgeSessionId ?? "",
      threadId: existing?.threadId ?? null,
      state: "retryable",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      sequence: ++this.nextSequence,
    });
    await this.flush();
  }

  latestForSession(bridgeSessionId: string): PromptDispatchRecord | undefined {
    return [...this.records.values()]
      .filter((record) => record.bridgeSessionId === bridgeSessionId)
      .sort(compareDispatchRecordsNewestFirst)[0];
  }

  /**
   * Drops a `prepared` record once reconciliation proved the turn never ran, so
   * the request can be dispatched cleanly.
   */
  async forget(requestId: string): Promise<void> {
    if (this.integrityError) throw new DispatchJournalIntegrityError(this.integrityError);
    if (this.records.get(requestId)?.quarantined) return;
    if (this.records.delete(requestId)) await this.flush();
  }

  /** Records still in flight, i.e. what recovery has to reconcile. */
  unresolved(): PromptDispatchRecord[] {
    return [...this.records.values()].filter(
      (record) => record.state === "prepared" || record.state === "accepted",
    );
  }

  allRecords(): PromptDispatchRecord[] {
    return [...this.records.values()];
  }

  /**
   * Drops old and excess records that are safe to forget.
   *
   * `prepared` and `accepted` records are ambiguity/safety state and are never
   * removed by age or capacity collection. Runtime recovery must reconcile or
   * fail-close them. A retryable record proves that its turn did not run, so it
   * is safe to expire or shed; only the newest such marker is useful to a session
   * status snapshot.
   */
  private collectGarbage(): void {
    const latestBySession = new Map<string, PromptDispatchRecord>();
    for (const record of this.records.values()) {
      // Records whose session id was lost share the `""` sentinel. Grouping them
      // would put unrelated requests in one bucket, so the sweep below would keep
      // a single "latest" marker across the whole journal instead of one per
      // session.
      if (!record.bridgeSessionId) continue;
      const latest = latestBySession.get(record.bridgeSessionId);
      if (!latest || compareDispatchRecordsNewestFirst(record, latest) < 0) {
        latestBySession.set(record.bridgeSessionId, record);
      }
    }
    for (const [requestId, record] of this.records) {
      if (!record.bridgeSessionId) continue;
      if (
        record.state === "retryable"
        && latestBySession.get(record.bridgeSessionId) !== record
      ) {
        this.records.delete(requestId);
      }
    }

    const cutoff = this.now() - this.retentionMs;
    for (const [requestId, record] of this.records) {
      const updatedAt = Date.parse(record.updatedAt);
      if (
        ((record.state === "terminal" && !record.quarantined) || record.state === "retryable")
        && Number.isFinite(updatedAt)
        && updatedAt < cutoff
      ) {
        this.records.delete(requestId);
      }
    }

    // Over either cap: shed the oldest safe records, never an unresolved one.
    const safeToForget = [...this.records.values()]
      .filter((record) =>
        (record.state === "terminal" && !record.quarantined) || record.state === "retryable"
      )
      .sort((left, right) => compareDispatchRecordsNewestFirst(right, left));
    for (const record of safeToForget) {
      if (
        this.records.size <= this.maxRecords
        && this.serializedBytes(this.records) <= this.maxBytes
      ) break;
      this.records.delete(record.requestId);
    }
  }

  /**
   * Reserves bounded durable safety state before the caller may write
   * `turn/start`. Existing unresolved records are never sacrificed to admit a
   * new request; exhaustion therefore fails closed before any provider action.
   */
  private admitPrepared(record: PromptDispatchRecord): void {
    const candidate = new Map(this.records);
    candidate.set(record.requestId, record);

    const safeOldestFirst = [...candidate.values()]
      .filter((entry) =>
        (entry.state === "terminal" && !entry.quarantined) || entry.state === "retryable"
      )
      .sort((left, right) => compareDispatchRecordsNewestFirst(right, left));
    for (const safe of safeOldestFirst) {
      if (
        candidate.size <= this.maxRecords
        && this.serializedBytes(candidate) <= this.maxBytes
      ) break;
      candidate.delete(safe.requestId);
    }

    if (candidate.size > this.maxRecords) {
      throw new DispatchJournalCapacityError(
        `Dispatch journal safety-record limit (${this.maxRecords}) is exhausted`,
      );
    }
    const bytes = this.serializedBytes(candidate);
    if (bytes > this.maxBytes) {
      throw new DispatchJournalCapacityError(
        `Dispatch journal byte limit (${this.maxBytes}) is exhausted`,
      );
    }

    this.records.clear();
    for (const [requestId, entry] of candidate) this.records.set(requestId, entry);
  }

  private serializedBytes(records: ReadonlyMap<string, PromptDispatchRecord>): number {
    return Buffer.byteLength(`${JSON.stringify({
      version: DISPATCH_JOURNAL_VERSION,
      records: [...records.values()],
    }, null, 2)}\n`, "utf8");
  }

  /** Capacity is recoverable: startup reconciliation may settle enough safety state. */
  private refreshCapacityError(): void {
    if (this.records.size > this.maxRecords) {
      this.capacityError =
        `Dispatch journal safety state exceeds its ${this.maxRecords}-record limit`;
      return;
    }
    if (this.serializedBytes(this.records) > this.maxBytes) {
      this.capacityError =
        `Dispatch journal normalized safety state exceeds its ${this.maxBytes}-byte limit`;
      return;
    }
    this.capacityError = null;
  }

  private flush(options: { failClosed?: boolean } = {}): Promise<void> {
    this.collectGarbage();
    this.refreshCapacityError();
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
  id?: string;
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
  /** Renderable item ids which app-server ordered before the matched user message. */
  precedingItemIds?: string[];
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
    const items = turn.items ?? [];
    const matchIndex = items.findIndex(
      (item) => item?.type === "userMessage" && item.clientId === requestId,
    );
    if (matchIndex < 0) continue;
    const precedingItemIds = items
      .slice(0, matchIndex)
      .filter((item) => item?.type !== "userMessage" && typeof item?.id === "string")
      .map((item) => item.id!);

    if (turn.status === "inProgress") {
      return { result: "attach", turnId: turn.id, precedingItemIds };
    }
    return {
      result: "terminal",
      turnId: turn.id,
      precedingItemIds,
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
