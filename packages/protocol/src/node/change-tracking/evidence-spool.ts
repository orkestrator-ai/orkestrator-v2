/**
 * A bridge's bounded spool of canonical change evidence.
 *
 * Adapters append frames and observation reports synchronously from their
 * event handlers; nothing here awaits the backend, Git or a client. The
 * backend pulls entries (`GET /change-evidence`), fetches the bodies it needs,
 * commits them to its ledger and only then acknowledges. Entries and bodies
 * are released on that durable acknowledgment — an in-memory read is never
 * one.
 *
 * Every axis is bounded. When the spool is full a new frame is not silently
 * dropped: its identity is folded into one explicit stream-gap frame (whose
 * metadata has reserved capacity), so the backend records a coverage loss
 * instead of assuming nothing happened.
 *
 * With `directory` set, unacknowledged entries and bodies survive a bridge
 * restart: entries are appended to a JSONL file and bodies are written as
 * content-addressed files. Without it the spool is memory-only.
 */

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isProviderEvidenceFrame,
  PROVIDER_EVIDENCE_SCHEMA_VERSION,
  workspaceObservationReportIssues,
  type ChangeEvidenceAckRequest,
  type ChangeEvidenceEntry,
  type ChangeEvidenceReadResponse,
  type EvidenceBodyRef,
  type ProviderChangeCapabilities,
  type ProviderEvidenceFrame,
  type WorkspaceObservationReport,
} from "../../change-evidence.js";

export interface EvidenceSpoolLimits {
  maxEntries: number;
  maxEntryBytes: number;
  /** Total serialized entry bytes held. */
  maxQueuedBytes: number;
  /** Total retained body bytes. */
  maxBodyBytes: number;
  /** Bytes kept from one body; the rest is recorded as truncated. */
  maxSingleBodyBytes: number;
  /** Entries returned by one read. */
  maxReadEntries: number;
  maxReadBytes: number;
}

export const DEFAULT_EVIDENCE_SPOOL_LIMITS: EvidenceSpoolLimits = {
  maxEntries: 2_048,
  maxEntryBytes: 256 * 1024,
  maxQueuedBytes: 16 * 1024 * 1024,
  maxBodyBytes: 64 * 1024 * 1024,
  maxSingleBodyBytes: 8 * 1024 * 1024,
  maxReadEntries: 256,
  maxReadBytes: 4 * 1024 * 1024,
};

interface StoredEntry {
  entry: ChangeEvidenceEntry;
  bytes: number;
  bodyIds: string[];
}

interface StoredBody {
  bytes: Uint8Array;
  refs: number;
}

export interface EvidenceSpoolOptions {
  directory?: string;
  limits?: Partial<EvidenceSpoolLimits>;
  runtimeEpoch?: string;
}

const ENTRIES_FILE = "entries.jsonl";
const BODY_DIRECTORY = "bodies";

export function evidenceBodyId(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Stable identity for semantic content (frame ids, revision keys). */
export function stableEvidenceId(
  ...parts: readonly (string | number | undefined | null)[]
): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part ?? ""}\0`);
  return hash.digest("hex").slice(0, 40);
}

export class ChangeEvidenceSpool {
  readonly runtimeEpoch: string;
  private readonly limits: EvidenceSpoolLimits;
  private readonly directory: string | undefined;
  private readonly entries: StoredEntry[] = [];
  private readonly bodies = new Map<string, StoredBody>();
  private readonly capabilities = new Map<string, ProviderChangeCapabilities>();
  private readonly seenFrameIds = new Set<string>();
  private nextSeq = 1;
  private queuedBytes = 0;
  private bodyBytes = 0;
  private readonly pendingBodies = new Set<string>();
  private droppedFrameIds: string[] = [];
  private droppedUnknown = false;
  private gapBindingId = "";
  private io: Promise<void> = Promise.resolve();
  private pendingLines: string[] = [];
  private flushScheduled = false;
  private restoring = false;

  constructor(options: EvidenceSpoolOptions = {}) {
    this.limits = { ...DEFAULT_EVIDENCE_SPOOL_LIMITS, ...options.limits };
    this.runtimeEpoch = options.runtimeEpoch ?? randomUUID();
    this.directory = options.directory;
    if (this.directory) {
      this.restoring = true;
      try {
        this.restore(this.directory);
      } finally {
        this.restoring = false;
      }
      this.compactPersisted();
    }
  }

  /** Declare the capabilities a binding's frames refer to. */
  declareCapabilities(capabilities: ProviderChangeCapabilities): void {
    this.capabilities.set(capabilities.capabilityRevision, capabilities);
  }

  /**
   * Retain body bytes and return their reference. Bodies are deduplicated by
   * content; a body above the single-body budget keeps a prefix and is marked
   * incomplete with its original size.
   */
  retainBody(content: Uint8Array | string): EvidenceBodyRef {
    const original = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const complete = original.length <= this.limits.maxSingleBodyBytes;
    const bytes = complete ? original : original.subarray(0, this.limits.maxSingleBodyBytes);
    const id = evidenceBodyId(bytes);
    if (!this.bodies.has(id) && this.bodyBytes + bytes.length > this.limits.maxBodyBytes) {
      return {
        id: `unretained:${stableEvidenceId(evidenceBodyId(original))}`,
        state: "unavailable",
        retainedBytes: 0,
        originalBytes: original.length,
        complete: false,
        unavailableReason: "bridge-spool-body-capacity",
      };
    }
    if (!this.bodies.has(id)) {
      this.bodies.set(id, { bytes, refs: 0 });
      this.pendingBodies.add(id);
      this.bodyBytes += bytes.length;
      this.persistBody(id, bytes);
    }
    return {
      id,
      state: "available",
      retainedBytes: bytes.length,
      ...(complete ? {} : { originalBytes: original.length }),
      complete,
    };
  }

  /** Append a canonical frame. Duplicate frame ids are idempotent. */
  appendFrame(frame: ProviderEvidenceFrame): boolean {
    if (this.seenFrameIds.has(frame.frameId)) {
      this.releasePendingBodies();
      return true;
    }
    this.gapBindingId ||= frame.bindingId;
    const frameId = frame.frameId;
    if (!isProviderEvidenceFrame(frame)) {
      this.recordDrop(frameId);
      this.releasePendingBodies();
      return false;
    }
    this.seenFrameIds.add(frame.frameId);
    if (this.seenFrameIds.size > this.limits.maxEntries * 4) {
      const oldest = this.seenFrameIds.values().next().value;
      if (oldest !== undefined) this.seenFrameIds.delete(oldest);
    }
    this.gapBindingId ||= frame.bindingId;
    const accepted = this.push(
      { seq: 0, type: "frame", frame },
      collectBodyIds(frame),
      frame.frameId,
    );
    this.releasePendingBodies();
    return accepted;
  }

  appendObservation(report: WorkspaceObservationReport): boolean {
    if (workspaceObservationReportIssues(report).length > 0) return false;
    this.gapBindingId ||= report.bindingId;
    return this.push({ seq: 0, type: "observation", report }, [], report.reportId);
  }

  private push(entry: ChangeEvidenceEntry, bodyIds: string[], identity: string): boolean {
    this.flushGap();
    const serialized = JSON.stringify(entry);
    const bytes = serialized.length;
    if (
      bytes > this.limits.maxEntryBytes ||
      this.entries.length >= this.limits.maxEntries - 1 ||
      this.queuedBytes + bytes > this.limits.maxQueuedBytes
    ) {
      this.recordDrop(identity);
      return false;
    }
    entry.seq = this.nextSeq++;
    for (const id of bodyIds) {
      const body = this.bodies.get(id);
      if (body) body.refs++;
    }
    this.entries.push({ entry, bytes, bodyIds });
    this.queuedBytes += bytes;
    this.persistEntry(entry);
    return true;
  }

  private recordDrop(identity: string): void {
    if (this.droppedFrameIds.length < 1_000) this.droppedFrameIds.push(identity);
    else this.droppedUnknown = true;
  }

  /** Emit one gap frame for dropped entries once there is room again. */
  private flushGap(): void {
    if (this.droppedFrameIds.length === 0 && !this.droppedUnknown) return;
    if (this.entries.length >= this.limits.maxEntries - 1) return;
    const gapId = randomUUID();
    const coverage = this.droppedUnknown
      ? {
          kind: "unknown-range" as const,
          bindingId: this.gapBindingId || "unknown",
          runtimeEpoch: this.runtimeEpoch,
        }
      : { kind: "frames" as const, frameIds: this.droppedFrameIds };
    const gap: ProviderEvidenceFrame = {
      schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
      bindingId: this.gapBindingId || "unknown",
      runtimeEpoch: this.runtimeEpoch,
      capabilityRevision: "spool",
      frameId: `gap:${gapId}`,
      source: { conversationId: "spool", mode: "live" },
      event: { kind: "stream-gap", gapId, coverage, reason: "bridge-spool-capacity" },
    };
    this.droppedFrameIds = [];
    this.droppedUnknown = false;
    const entry: ChangeEvidenceEntry = { seq: this.nextSeq++, type: "frame", frame: gap };
    const bytes = JSON.stringify(entry).length;
    this.entries.push({ entry, bytes, bodyIds: [] });
    this.queuedBytes += bytes;
    this.persistEntry(entry);
  }

  /** Entries after `cursor`, bounded by count and bytes. */
  read(cursor: number, maxEntries = this.limits.maxReadEntries): ChangeEvidenceReadResponse {
    this.flushGap();
    const limit = Math.max(1, Math.min(maxEntries, this.limits.maxReadEntries));
    const entries: ChangeEvidenceEntry[] = [];
    let bytes = 0;
    let nextCursor = cursor;
    for (const stored of this.entries) {
      if (stored.entry.seq <= cursor) continue;
      if (entries.length >= limit) break;
      if (entries.length > 0 && bytes + stored.bytes > this.limits.maxReadBytes) break;
      entries.push(stored.entry);
      bytes += stored.bytes;
      nextCursor = stored.entry.seq;
    }
    return {
      schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
      runtimeEpoch: this.runtimeEpoch,
      entries,
      nextCursor,
      pendingGap: this.droppedFrameIds.length > 0 || this.droppedUnknown,
      capabilities: [...this.capabilities.values()],
    };
  }

  readBody(id: string): Uint8Array | null {
    return this.bodies.get(id)?.bytes ?? null;
  }

  /**
   * Release entries the backend made durable. Bodies are released only when
   * the backend retained them or durably recorded them unavailable.
   */
  acknowledge(request: ChangeEvidenceAckRequest): { released: number } {
    if (request.runtimeEpoch !== this.runtimeEpoch) return { released: 0 };
    let released = 0;
    while (this.entries.length > 0 && this.entries[0]!.entry.seq <= request.upTo) {
      const stored = this.entries.shift()!;
      this.queuedBytes -= stored.bytes;
      released++;
      for (const id of stored.bodyIds) {
        const body = this.bodies.get(id);
        if (body) body.refs--;
      }
    }
    this.releaseUnreferencedBodies([...request.retainedBodyIds, ...request.unavailableBodyIds]);
    if (released > 0) this.compactPersisted();
    return { released };
  }

  private releasePendingBodies(): void {
    this.releaseUnreferencedBodies(this.pendingBodies);
    this.pendingBodies.clear();
  }

  private releaseUnreferencedBodies(ids: Iterable<string>): void {
    for (const id of Array.from(ids)) {
      const body = this.bodies.get(id);
      if (!body || body.refs > 0) continue;
      this.bodies.delete(id);
      this.bodyBytes -= body.bytes.length;
      this.removeBody(id);
    }
  }

  stats() {
    return {
      entries: this.entries.length,
      queuedBytes: this.queuedBytes,
      bodies: this.bodies.size,
      bodyBytes: this.bodyBytes,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /*
   * Persistence never blocks the caller: appends are batched and every disk
   * operation runs in order on one asynchronous chain, so a provider's event
   * reader only pays an in-memory push. A crash can lose the last unflushed
   * batch; the backend then records the missing frames as a gap on recovery.
   */

  private enqueueIo(operation: () => Promise<void>): void {
    this.io = this.io.then(operation).catch(() => {
      // Persistence is best effort; the in-memory spool remains authoritative
      // for this process and a lost file only costs restart recovery.
    });
  }

  private persistEntry(entry: ChangeEvidenceEntry): void {
    if (!this.directory || this.restoring) return;
    this.pendingLines.push(`${JSON.stringify({ epoch: this.runtimeEpoch, entry })}\n`);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const timer = setTimeout(() => {
      this.flushScheduled = false;
      this.flushLines();
    }, 0);
    timer.unref?.();
  }

  private flushLines(): void {
    const directory = this.directory;
    if (!directory || this.pendingLines.length === 0) return;
    const lines = this.pendingLines.splice(0).join("");
    this.enqueueIo(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(join(directory, ENTRIES_FILE), lines, { mode: 0o600 });
    });
  }

  private persistBody(id: string, bytes: Uint8Array): void {
    const directory = this.directory;
    if (!directory || this.restoring) return;
    this.enqueueIo(async () => {
      const bodies = join(directory, BODY_DIRECTORY);
      await mkdir(bodies, { recursive: true, mode: 0o700 });
      await writeFile(join(bodies, bodyFileName(id)), bytes, { mode: 0o600, flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
    });
  }

  private removeBody(id: string): void {
    const directory = this.directory;
    if (!directory) return;
    this.enqueueIo(() => rm(join(directory, BODY_DIRECTORY, bodyFileName(id)), { force: true }));
  }

  private compactPersisted(): void {
    const directory = this.directory;
    if (!directory) return;
    // The rewrite contains every retained entry, including unflushed ones.
    this.pendingLines.length = 0;
    const body = this.entries
      .map((stored) => JSON.stringify({ epoch: this.runtimeEpoch, entry: stored.entry }))
      .join("\n");
    this.enqueueIo(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, ENTRIES_FILE);
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, body ? `${body}\n` : "", { mode: 0o600 });
      await rename(temp, file);
    });
  }

  /** Settle pending persistence (shutdown and tests). */
  async flush(): Promise<void> {
    this.flushLines();
    await this.io;
  }

  /**
   * Reload entries an earlier process left unacknowledged. They are re-issued
   * under this process's epoch and sequence; their frame ids are unchanged,
   * so the backend deduplicates anything it had already committed.
   */
  private restore(directory: string): void {
    const bodyDirectory = join(directory, BODY_DIRECTORY);
    try {
      for (const name of readdirSync(bodyDirectory)) {
        const bytes = new Uint8Array(readFileSync(join(bodyDirectory, name)));
        const id = evidenceBodyId(bytes);
        if (bodyFileName(id) !== name) continue;
        if (this.bodyBytes + bytes.length > this.limits.maxBodyBytes) break;
        this.bodies.set(id, { bytes, refs: 0 });
        this.bodyBytes += bytes.length;
      }
    } catch {
      // No bodies yet.
    }
    let text = "";
    try {
      text = readFileSync(join(directory, ENTRIES_FILE), "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      let parsed: { entry?: ChangeEvidenceEntry };
      try {
        parsed = JSON.parse(line) as { entry?: ChangeEvidenceEntry };
      } catch {
        continue;
      }
      const entry = parsed.entry;
      if (!entry) continue;
      if (entry.type === "frame" && isProviderEvidenceFrame(entry.frame)) {
        if (this.seenFrameIds.has(entry.frame.frameId)) continue;
        this.seenFrameIds.add(entry.frame.frameId);
        this.push({ ...entry, seq: 0 }, collectBodyIds(entry.frame), entry.frame.frameId);
      } else if (
        entry.type === "observation" &&
        workspaceObservationReportIssues(entry.report).length === 0
      ) {
        this.push({ ...entry, seq: 0 }, [], entry.report.reportId);
      }
    }
    // Bodies no surviving entry references were already retained or released.
    for (const [id, body] of Array.from(this.bodies)) {
      if (body.refs > 0) continue;
      this.bodies.delete(id);
      this.bodyBytes -= body.bytes.length;
      this.removeBody(id);
    }
  }
}

function bodyFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "_");
}

/** Body ids an entry references (so they stay retained until acknowledged). */
export function collectBodyIds(frame: ProviderEvidenceFrame): string[] {
  const ids = new Set<string>();
  const add = (ref: EvidenceBodyRef | undefined) => {
    if (ref && ref.state === "available") ids.add(ref.id);
  };
  add(frame.raw);
  const event = frame.event;
  const updates =
    event.kind === "tool" || event.kind === "background-task" || event.kind === "turn-diff"
      ? event.evidence
      : [];
  for (const update of updates) {
    if (update.kind === "append") {
      add(update.chunk);
      continue;
    }
    const evidence = update.evidence;
    if (evidence.kind === "patch") add(evidence.body);
    if (evidence.kind === "replacement") {
      if (evidence.before.state === "present") add(evidence.before.body);
      if (evidence.after.state === "present") add(evidence.after.body);
    }
  }
  return [...ids];
}
