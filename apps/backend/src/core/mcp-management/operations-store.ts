/**
 * Durable record of configuration operations.
 *
 * A record is written *before* the native file is touched and updated after,
 * so a crash between the two leaves enough intent to find out what happened
 * without repeating the change. Records hold names, ids, revisions and states
 * only — never a value from a definition. The private recovery half also keeps
 * one unkeyed digest of the saved file (see `savedDigest`), which is the format
 * bridges report and so never leaves this file.
 */

import { createHmac, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { McpSourceStore } from "./source-store.js";

import {
  MCP_MANAGEMENT_LIMITS,
  isTerminalApplyState,
  mcpFailure,
  utf8ByteLength,
  type McpOperationSnapshot,
} from "@orkestrator/protocol/mcp-management";

/** Private recovery data. Never leaves the backend. */
export interface OperationRecovery {
  /** Keyed digest of the canonical mutation, for request-id idempotency. */
  fingerprint: string;
  expectedRevision: string | null;
  /** Native names before/after, to decide on restart whether the write landed. */
  name: string;
  newName?: string;
  /** Keyed digest of the native entry that was intended, for update/add. */
  entryDigest?: string;
  /**
   * Unkeyed `sha256:<base64url>` of the bytes the save left in the source file
   * — the format bridges report for the files a runtime loaded. Private: an
   * unkeyed digest of a file holding a low-entropy secret lets whoever holds it
   * confirm a guess, so it never leaves this record.
   */
  savedDigest?: string;
  /** When the write began. Runtime evidence observed earlier cannot reflect it. */
  writeStartedAt?: string;
  /** Which of a bridge's reported files the saved source is (see `EvidenceRole`). */
  evidenceRole?: "user" | "project" | "local";
  /** Runtimes that were chosen for apply, with the identity needed to act on them. */
  runtimes?: Array<{
    runtimeId: string;
    environmentId: string;
    agent: string;
    logicalSessionKey?: string;
    /** The scheduler polls this runtime's bridge for proof it loaded the save. */
    awaitsEvidence?: boolean;
    /** The provider bridge's process id when apply was planned (Grok restart proof). */
    bridgePid?: number;
  }>;
  applyQueuedAt?: string;
}

export interface StoredOperation {
  snapshot: McpOperationSnapshot;
  recovery: OperationRecovery;
}

interface StoreFile {
  version: 1;
  operations: StoredOperation[];
}

/**
 * Whether a record may be dropped by retention: its save is settled and no
 * runtime is still waiting. Pending/reconciling saves are recovery evidence.
 */
export function isFinishedOperation(entry: StoredOperation): boolean {
  return (
    entry.snapshot.phase !== "pending" &&
    entry.snapshot.phase !== "reconciling" &&
    isTerminalApplyState(entry.snapshot.apply.state)
  );
}

export class McpOperationStore {
  private operations: StoredOperation[] = [];
  private loaded = false;
  /** Set when an unreadable file could not be moved aside; writes are refused. */
  private writeBlocked = false;
  private writeChain: Promise<void> = Promise.resolve();
  /** Last disk version seen for each id, so live service references can stay stable. */
  private readonly known = new Map<string, string>();
  private readonly lockStore: McpSourceStore;

  constructor(
    private readonly filePath: string,
    private readonly digestKey: () => Promise<Buffer>,
    private readonly now: () => number = Date.now,
  ) {
    this.lockStore = new McpSourceStore({ keyFile: `${filePath}.lock-key` });
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") await this.setAside("unreadable");
      this.loaded = true;
      return;
    }
    let parsed: Partial<StoreFile> | null = null;
    try {
      parsed = JSON.parse(text) as Partial<StoreFile>;
    } catch {
      parsed = null;
    }
    if (parsed && parsed.version === 1 && Array.isArray(parsed.operations)) {
      this.operations = parsed.operations.filter(
        (entry) =>
          entry &&
          typeof entry.snapshot?.operationId === "string" &&
          typeof entry.recovery?.fingerprint === "string",
      );
      for (const entry of this.operations)
        this.known.set(entry.snapshot.operationId, JSON.stringify(entry));
    } else {
      // A newer schema or a damaged file is moved aside, never overwritten in
      // place: an older build must not destroy history a newer one wrote.
      const newer = parsed && typeof parsed.version === "number" && (parsed.version as number) > 1;
      await this.setAside(newer ? `v${parsed!.version}` : "unreadable");
    }
    this.loaded = true;
  }

  /**
   * Move the current file aside. If that fails the store refuses to write, so
   * the only copy of what it could not read is never replaced.
   */
  private async setAside(label: string): Promise<void> {
    const aside = `${this.filePath}.${label}-${this.now()}`;
    try {
      await fs.rename(this.filePath, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.writeBlocked = true;
    }
  }

  async digest(value: unknown): Promise<string> {
    return createHmac("sha256", await this.digestKey())
      .update(JSON.stringify(value))
      .digest("base64url")
      .slice(0, 43);
  }

  async entryDigest(value: unknown): Promise<string> {
    return this.digest(canonical(value));
  }

  newOperationId(): string {
    return `mcpop-${randomUUID()}`;
  }

  list(): StoredOperation[] {
    return this.operations;
  }

  get(operationId: string): StoredOperation | undefined {
    return this.operations.find((entry) => entry.snapshot.operationId === operationId);
  }

  byRequest(targetId: string, requestId: string): StoredOperation | undefined {
    return this.operations.find(
      (entry) => entry.snapshot.requestId === requestId && entry.snapshot.targetId === targetId,
    );
  }

  /** Reconcile records written by another backend before an idempotency lookup. */
  async refresh(): Promise<void> {
    await this.writeChain;
    await this.lockStore.withLock(this.filePath, async () => {
      let latest: StoreFile;
      try {
        latest = JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoreFile;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw mcpFailure("internal", {
          message: "The configuration operation history cannot be read.",
        });
      }
      if (latest.version !== 1 || !Array.isArray(latest.operations))
        throw mcpFailure("internal", {
          message: "The configuration operation history cannot be read.",
        });
      this.mergeLatest(latest.operations);
      for (const current of latest.operations)
        this.known.set(current.snapshot.operationId, JSON.stringify(current));
    });
  }

  forTarget(targetId: string, limit = 20): McpOperationSnapshot[] {
    return this.operations
      .filter((entry) => entry.snapshot.targetId === targetId)
      .slice(-limit)
      .map((entry) => entry.snapshot)
      .reverse();
  }

  /** Insert or replace, then persist. Enforces retention before writing. */
  async put(entry: StoredOperation): Promise<void> {
    const write = this.writeChain.then(() => this.persist(entry));
    this.writeChain = write.catch(() => undefined);
    await write;
  }

  private prune(): void {
    const cutoff = this.now() - MCP_MANAGEMENT_LIMITS.operationRetentionMs;
    this.operations = this.operations.filter(
      (entry) => !isFinishedOperation(entry) || Date.parse(entry.snapshot.updatedAt) >= cutoff,
    );
    // Oldest finished records go first; unfinished work is never dropped.
    while (this.operations.length > MCP_MANAGEMENT_LIMITS.retainedOperations) {
      const index = this.operations.findIndex(isFinishedOperation);
      if (index < 0) break;
      this.operations.splice(index, 1);
    }
  }

  private async persist(entry: StoredOperation): Promise<void> {
    if (this.writeBlocked) {
      throw mcpFailure("internal", {
        message:
          "The configuration operation history could not be read or moved aside, so it is left untouched and changes are refused.",
      });
    }
    await this.lockStore.withLock(this.filePath, async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      let latest: StoreFile = { version: 1, operations: [] };
      try {
        latest = JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoreFile;
        if (latest.version !== 1 || !Array.isArray(latest.operations))
          throw new Error("Invalid operation history");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw mcpFailure("internal", {
            message:
              "The configuration operation history changed or cannot be read; changes are refused.",
          });
        }
      }
      this.mergeLatest(latest.operations, entry);
      const index = this.operations.findIndex(
        (candidate) => candidate.snapshot.operationId === entry.snapshot.operationId,
      );
      if (index >= 0) this.operations[index] = entry;
      else this.operations.push(entry);
      this.prune();
      let body = JSON.stringify({ version: 1, operations: this.operations } satisfies StoreFile);
      // Shed the oldest finished history until the file fits; never unfinished work.
      while (utf8ByteLength(body) > MCP_MANAGEMENT_LIMITS.operationStoreMaxBytes) {
        const finishedIndex = this.operations.findIndex(isFinishedOperation);
        if (finishedIndex < 0) break;
        this.operations.splice(finishedIndex, 1);
        body = JSON.stringify({ version: 1, operations: this.operations } satisfies StoreFile);
      }
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, body, { mode: 0o600 });
        await fs.rename(temporary, this.filePath);
        this.known.clear();
        for (const current of (JSON.parse(body) as StoreFile).operations)
          this.known.set(current.snapshot.operationId, JSON.stringify(current));
      } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
  }

  private mergeLatest(latest: StoredOperation[], writing?: StoredOperation): void {
    this.operations = latest.map((diskEntry) => {
      const id = diskEntry.snapshot.operationId;
      const local = this.operations.find((candidate) => candidate.snapshot.operationId === id);
      if (!local) return diskEntry;
      const diskVersion = JSON.stringify(diskEntry);
      if (this.known.has(id) && this.known.get(id) !== diskVersion && local !== writing) {
        local.snapshot = diskEntry.snapshot;
        local.recovery = diskEntry.recovery;
      }
      return local;
    });
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
