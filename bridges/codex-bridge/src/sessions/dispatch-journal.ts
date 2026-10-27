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
 *
 * Completeness, for `/dispatch` answering `absent`: a journal is *tracked* when
 * a bridge of this version has kept it since its file was created. A tracked
 * file carries a `completeness` block beside the records: the bridge sessions
 * created fresh since (at most 256), and a fixed 16 KiB Bloom filter of every
 * request id that left the journal (age, capacity, `forget`, admission) or was
 * steered. A file without the block (an older bridge wrote it last), a merged
 * legacy file, a record with no id, or a load failure leaves the journal
 * untracked for good, and an untracked journal never answers `absent`. The
 * file has no fsync, so this holds across a bridge restart, not an OS crash.
 */
import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codexBridgeStateDir, codexLoginBridgeDir } from "../bridge-state-dir.js";
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

/**
 * Version of the optional `completeness` block. The block is additive: an older
 * bridge reads only `version` and `records`, ignores it, and drops it the next
 * time it rewrites the file, which a newer bridge then reads as "not tracked".
 */
export const DISPATCH_COMPLETENESS_VERSION = 1;
/** Fresh-session markers kept, oldest evicted first. */
export const MAX_FRESH_SESSION_MARKERS = 256;
/** A longer session id is simply never marked, so it answers `unknown`. */
export const MAX_FRESH_SESSION_ID_LENGTH = 256;
/** Fixed size of the filter of ids that left the journal (16 KiB, ~22 KB as base64). */
export const UNTRACKED_FILTER_BITS = 1 << 17;
const UNTRACKED_FILTER_BYTES = UNTRACKED_FILTER_BITS / 8;
const UNTRACKED_FILTER_HASHES = 4;

interface PersistedCompleteness {
  version: number;
  /** Bridge sessions created fresh while this journal was tracked, oldest first. */
  freshSessions: string[];
  /** Base64 Bloom filter of every request id that may have reached Codex without a record. */
  untracked: string;
}

interface JournalFile {
  version: number;
  records: unknown[];
  completeness?: PersistedCompleteness;
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

const DISPATCH_STATES = new Set<DispatchState>(["prepared", "accepted", "retryable", "terminal"]);
const TERMINAL_STATUSES = new Set<DispatchTerminalStatus>(["completed", "interrupted", "failed"]);

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
    typeof record.requestId !== "string" ||
    record.requestId.length === 0 ||
    typeof record.bridgeSessionId !== "string" ||
    (record.threadId !== null && typeof record.threadId !== "string") ||
    !isOptionalString(record.turnId) ||
    !DISPATCH_STATES.has(record.state as DispatchState) ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt) ||
    (record.quarantined !== undefined && record.quarantined !== true)
  ) {
    return false;
  }
  if (record.state === "accepted") {
    return (
      typeof record.threadId === "string" &&
      record.threadId.length > 0 &&
      typeof record.turnId === "string" &&
      record.turnId.length > 0 &&
      record.terminalStatus === undefined
    );
  }
  if (record.state === "terminal") {
    return (
      TERMINAL_STATUSES.has(record.terminalStatus as DispatchTerminalStatus) &&
      (!record.quarantined || record.terminalStatus === "failed")
    );
  }
  return (
    (record.threadId === null || record.threadId.length > 0) &&
    record.turnId === undefined &&
    record.terminalStatus === undefined
  );
}

function sameDispatchIdentity(left: PromptDispatchRecord, right: PromptDispatchRecord): boolean {
  return (
    left.bridgeSessionId === right.bridgeSessionId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.state === right.state &&
    left.terminalStatus === right.terminalStatus &&
    left.quarantined === right.quarantined
  );
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
  /** `load()` sets `loaded` before its first await; this is set once it has finished. */
  private loadSettled = false;
  /**
   * True only while this journal has accounted for every request id since its
   * file was created: no record was ever removed without being added to
   * `untracked`, and no older bridge has rewritten the file since. Only a
   * tracked journal can prove that an id never reached Codex.
   */
  private tracked = false;
  private readonly freshSessions = new Set<string>();
  private readonly untracked = new Uint8Array(UNTRACKED_FILTER_BYTES);
  private untrackedBase64: string | null = null;
  /** The block restored by the last non-merging `loadPath`, if it was valid. */
  private restoredCompleteness = false;
  /** A persisted record had no usable request id, so its id is unknowable. */
  private unnamedRecordSkipped = false;

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
    return join(codexBridgeStateDir(this.codexHome), `dispatch-journal-${this.cwdHash}.json`);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.persist) {
      // Nothing survives this process, so nothing can be proved after a restart.
      this.loadSettled = true;
      return;
    }

    const legacy = join(
      codexLoginBridgeDir(this.codexHome),
      `dispatch-journal-${this.cwdHash}.json`,
    );
    try {
      const hadCurrent = await this.loadPath(this.path());
      const mergedLegacy = legacy !== this.path() && (await this.loadPath(legacy, true));
      // A missing file is a new journal: the file is created by the first
      // `prepared` write and never deleted, so no prompt was ever handed over
      // here. A file without a valid completeness block was written (or last
      // rewritten) by an older bridge, whose removals went unrecorded. A merged
      // legacy journal has the same gap.
      this.tracked =
        !mergedLegacy &&
        !this.unnamedRecordSkipped &&
        (hadCurrent ? this.restoredCompleteness : true);
      if (!this.tracked) this.resetCompleteness();
      if (mergedLegacy) {
        // Publish the union before retiring the source. A crash between these
        // operations safely merges it again on restart.
        this.collectGarbage();
        this.refreshCapacityError();
        if (this.capacityError) throw new DispatchJournalCapacityError(this.capacityError);
        await this.flush({ failClosed: true });
        await rm(legacy);
      }
      this.collectGarbage();
      this.refreshCapacityError();
    } catch (error) {
      this.integrityError =
        error instanceof DispatchJournalIntegrityError
          ? error.message
          : "Dispatch journal could not be safely decoded";
      this.tracked = false;
      this.resetCompleteness();
    } finally {
      this.loadSettled = true;
    }
  }

  private async loadPath(path: string, merging = false): Promise<boolean> {
    let contents: string;
    try {
      contents = await this.readBounded(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw error;
    }
    const parsed = JSON.parse(contents) as JournalFile;
    if (parsed.version !== DISPATCH_JOURNAL_VERSION || !Array.isArray(parsed.records)) {
      throw new DispatchJournalIntegrityError(
        "Dispatch journal has an unsupported or malformed file shape",
      );
    }
    if (!merging) this.restoredCompleteness = this.restoreCompleteness(parsed.completeness);
    for (const persisted of parsed.records) {
      const candidate =
        persisted && typeof persisted === "object"
          ? (persisted as Record<string, unknown>)
          : undefined;
      const requestId = typeof candidate?.requestId === "string" ? candidate.requestId : "";
      if (!requestId) {
        this.unnamedRecordSkipped = true;
        continue;
      }
      const sequence =
        Number.isSafeInteger(candidate?.sequence) && Number(candidate?.sequence) > 0
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
      if (merging && existing && !sameDispatchIdentity(existing, record)) {
        // Independent journals have no common sequence clock. Never guess
        // which conflicting outcome is newer, especially retryable vs spent.
        this.records.set(requestId, {
          ...existing,
          state: "terminal",
          terminalStatus: "failed",
          quarantined: true,
        });
      } else if (
        !existing ||
        (!merging && compareDispatchRecordsNewestFirst(record, existing) < 0)
      ) {
        this.records.set(requestId, record);
      }
    }
    return true;
  }

  private async readBounded(path: string): Promise<string> {
    const handle = await open(path, "r");
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
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
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
    if (this.integrityError) {
      return { duplicate: Boolean(record), action: "blocked", reason: this.integrityError, record };
    }
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
   * The request that started `turnId`, while the journal still holds it. Lets a
   * restart notice, which is keyed by turn, name the request it cut short.
   */
  requestIdForTurn(turnId: string): string | undefined {
    for (const record of this.records.values()) {
      if (record.turnId === turnId && !record.quarantined) return record.requestId;
    }
    return undefined;
  }

  /**
   * Drops a `prepared` record once reconciliation proved the turn never ran, so
   * the request can be dispatched cleanly.
   */
  async forget(requestId: string): Promise<void> {
    if (this.integrityError) throw new DispatchJournalIntegrityError(this.integrityError);
    if (this.records.get(requestId)?.quarantined) return;
    if (this.records.delete(requestId)) {
      this.noteRemoved(requestId);
      await this.flush();
    }
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
   * True only when this journal proves `requestId` was never handed to Codex
   * for `bridgeSessionId` (or any other session): the journal finished loading
   * cleanly and is tracked, the session was created fresh while it was
   * tracked, no record of the id exists under any session, and the id is not
   * in the filter of ids that left the journal or were steered. Every
   * `turn/start` is preceded by an awaited `prepared` write and every
   * `turn/steer` by an awaited filter write, so an id with no trace was never
   * written to app-server. A filter false positive answers `false`.
   */
  provesNeverJournaled(requestId: string, bridgeSessionId: string): boolean {
    return (
      this.loadSettled &&
      this.persist &&
      this.tracked &&
      this.integrityError === null &&
      this.capacityError === null &&
      this.freshSessions.has(bridgeSessionId) &&
      !this.records.has(requestId) &&
      !this.filterHas(requestId)
    );
  }

  /**
   * Records a bridge session this bridge has just created with no Codex
   * thread, so every id it is ever sent passes through this journal. Never
   * call it for a resumed, forked or restored session. Persisted with the next
   * write; a marker lost to a restart only makes the session answer `unknown`.
   */
  noteFreshSession(bridgeSessionId: string): void {
    if (!this.loadSettled || !this.tracked || this.integrityError !== null) return;
    if (!bridgeSessionId || bridgeSessionId.length > MAX_FRESH_SESSION_ID_LENGTH) return;
    if (this.freshSessions.has(bridgeSessionId)) return;
    this.freshSessions.add(bridgeSessionId);
    while (this.freshSessions.size > MAX_FRESH_SESSION_MARKERS) {
      const oldest = this.freshSessions.values().next().value;
      if (oldest === undefined) break;
      this.freshSessions.delete(oldest);
    }
  }

  /**
   * Durably records that `requestId` may reach Codex without a journal record
   * (a `turn/steer` carries it as `clientUserMessageId`). Awaited before the
   * write; a failure throws so the caller does not send.
   */
  async noteUntracked(requestId: string): Promise<void> {
    // An unpersisted journal never answers `absent`, so there is nothing to keep.
    if (!this.persist) return;
    if (!this.loadSettled)
      throw new DispatchJournalIntegrityError("Dispatch journal is not loaded");
    if (!this.tracked) return;
    this.filterAdd(requestId);
    // Always written, even when the bit is already set: an earlier attempt's
    // write may have failed, leaving the bit in memory only.
    await this.flush({ failClosed: true });
  }

  private restoreCompleteness(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const block = value as Partial<PersistedCompleteness>;
    if (
      block.version !== DISPATCH_COMPLETENESS_VERSION ||
      !Array.isArray(block.freshSessions) ||
      block.freshSessions.length > MAX_FRESH_SESSION_MARKERS ||
      block.freshSessions.some(
        (id) =>
          typeof id !== "string" || id.length === 0 || id.length > MAX_FRESH_SESSION_ID_LENGTH,
      ) ||
      typeof block.untracked !== "string"
    ) {
      return false;
    }
    const filter = Buffer.from(block.untracked, "base64");
    if (filter.length !== UNTRACKED_FILTER_BYTES || filter.toString("base64") !== block.untracked) {
      return false;
    }
    this.freshSessions.clear();
    for (const id of block.freshSessions) this.freshSessions.add(id);
    this.untracked.set(filter);
    this.untrackedBase64 = block.untracked;
    return true;
  }

  private resetCompleteness(): void {
    this.freshSessions.clear();
    this.untracked.fill(0);
    this.untrackedBase64 = null;
  }

  /** Every removal of a record, whatever its state, lands here. */
  private noteRemoved(requestId: string): void {
    if (this.tracked) this.filterAdd(requestId);
  }

  private filterPositions(requestId: string): number[] {
    const digest = createHash("sha256").update(requestId, "utf8").digest();
    const positions: number[] = [];
    for (let index = 0; index < UNTRACKED_FILTER_HASHES; index += 1) {
      positions.push(digest.readUInt32BE(index * 4) % UNTRACKED_FILTER_BITS);
    }
    return positions;
  }

  private filterAdd(requestId: string): void {
    for (const bit of this.filterPositions(requestId)) {
      const byte = bit >>> 3;
      this.untracked[byte] = (this.untracked[byte] ?? 0) | (1 << (bit & 7));
    }
    this.untrackedBase64 = null;
  }

  private filterHas(requestId: string): boolean {
    return this.filterPositions(requestId).every(
      (bit) => ((this.untracked[bit >>> 3] ?? 0) & (1 << (bit & 7))) !== 0,
    );
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
      if (record.state === "retryable" && latestBySession.get(record.bridgeSessionId) !== record) {
        this.records.delete(requestId);
        this.noteRemoved(requestId);
      }
    }

    const cutoff = this.now() - this.retentionMs;
    for (const [requestId, record] of this.records) {
      const updatedAt = Date.parse(record.updatedAt);
      if (
        ((record.state === "terminal" && !record.quarantined) || record.state === "retryable") &&
        Number.isFinite(updatedAt) &&
        updatedAt < cutoff
      ) {
        this.records.delete(requestId);
        this.noteRemoved(requestId);
      }
    }

    // Over either cap: shed the oldest safe records, never an unresolved one.
    const safeToForget = [...this.records.values()]
      .filter(
        (record) =>
          (record.state === "terminal" && !record.quarantined) || record.state === "retryable",
      )
      .sort((left, right) => compareDispatchRecordsNewestFirst(right, left));
    for (const record of safeToForget) {
      if (
        this.records.size <= this.maxRecords &&
        this.serializedBytes(this.records) <= this.maxBytes
      )
        break;
      this.records.delete(record.requestId);
      this.noteRemoved(record.requestId);
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
      .filter(
        (entry) =>
          (entry.state === "terminal" && !entry.quarantined) || entry.state === "retryable",
      )
      .sort((left, right) => compareDispatchRecordsNewestFirst(right, left));
    for (const safe of safeOldestFirst) {
      if (candidate.size <= this.maxRecords && this.serializedBytes(candidate) <= this.maxBytes)
        break;
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

    for (const requestId of this.records.keys()) {
      if (!candidate.has(requestId)) this.noteRemoved(requestId);
    }
    this.records.clear();
    for (const [requestId, entry] of candidate) this.records.set(requestId, entry);
  }

  private serializedBytes(records: ReadonlyMap<string, PromptDispatchRecord>): number {
    return Buffer.byteLength(`${JSON.stringify(this.fileSnapshot(records), null, 2)}\n`, "utf8");
  }

  /** The exact file contents, so the byte caps count the completeness block too. */
  private fileSnapshot(records: ReadonlyMap<string, PromptDispatchRecord>): JournalFile {
    return {
      version: DISPATCH_JOURNAL_VERSION,
      records: [...records.values()],
      ...(this.tracked
        ? {
            completeness: {
              version: DISPATCH_COMPLETENESS_VERSION,
              freshSessions: [...this.freshSessions],
              untracked: (this.untrackedBase64 ??= Buffer.from(this.untracked).toString("base64")),
            },
          }
        : {}),
    };
  }

  /** Capacity is recoverable: startup reconciliation may settle enough safety state. */
  private refreshCapacityError(): void {
    if (this.records.size > this.maxRecords) {
      this.capacityError = `Dispatch journal safety state exceeds its ${this.maxRecords}-record limit`;
      return;
    }
    if (this.serializedBytes(this.records) > this.maxBytes) {
      this.capacityError = `Dispatch journal normalized safety state exceeds its ${this.maxBytes}-byte limit`;
      return;
    }
    this.capacityError = null;
  }

  private flush(options: { failClosed?: boolean } = {}): Promise<void> {
    this.collectGarbage();
    this.refreshCapacityError();
    if (!this.persist) return Promise.resolve();

    const snapshot = this.fileSnapshot(this.records);
    const attempt = this.writeChain.then(async () => {
      try {
        const path = this.path();
        await mkdir(codexBridgeStateDir(this.codexHome), { recursive: true });
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
  /**
   * Renderable item ids which app-server ordered *after* the matched user
   * message.
   *
   * This is the side callers must key on. `items` is a projection of what
   * app-server has persisted, so an id being absent from `precedingItemIds`
   * proves nothing: an item still streaming, or one elided by a partial
   * `itemsView`, is simply not there yet. An id appearing *after* the match is
   * positive evidence, and stays true however truncated the projection is.
   */
  followingItemIds?: string[];
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
    const renderableIds = (from: number, to?: number) =>
      items
        .slice(from, to)
        .filter((item) => item?.type !== "userMessage" && typeof item?.id === "string")
        .map((item) => item.id!);
    const precedingItemIds = renderableIds(0, matchIndex);
    const followingItemIds = renderableIds(matchIndex + 1);

    if (turn.status === "inProgress") {
      return { result: "attach", turnId: turn.id, precedingItemIds, followingItemIds };
    }
    return {
      result: "terminal",
      turnId: turn.id,
      precedingItemIds,
      followingItemIds,
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
