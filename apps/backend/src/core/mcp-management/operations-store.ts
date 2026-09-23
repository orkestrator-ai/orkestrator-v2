/**
 * Durable record of configuration operations.
 *
 * A record is written *before* the native file is touched and updated after,
 * so a crash between the two leaves enough intent to find out what happened
 * without repeating the change. Records hold names, ids, revisions and states
 * only — never a value from a definition.
 */

import { createHmac, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  MCP_MANAGEMENT_LIMITS,
  isTerminalApplyState,
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
  /** Runtimes that were chosen for apply, with the identity needed to act on them. */
  runtimes?: Array<{
    runtimeId: string;
    environmentId: string;
    agent: string;
    logicalSessionKey?: string;
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

export class McpOperationStore {
  private operations: StoredOperation[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly digestKey: () => Promise<Buffer>,
    private readonly now: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as StoreFile;
      if (parsed?.version === 1 && Array.isArray(parsed.operations)) {
        this.operations = parsed.operations.filter(
          (entry) =>
            entry &&
            typeof entry.snapshot?.operationId === "string" &&
            typeof entry.recovery?.fingerprint === "string",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // A newer or damaged file is left in place, never overwritten blindly.
        const aside = `${this.filePath}.unreadable-${Date.now()}`;
        await fs.rename(this.filePath, aside).catch(() => undefined);
      }
    }
    this.loaded = true;
  }

  async digest(value: unknown): Promise<string> {
    return createHmac("sha256", await this.digestKey())
      .update(JSON.stringify(value))
      .digest("base64url")
      .slice(0, 43);
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

  forTarget(targetId: string, limit = 20): McpOperationSnapshot[] {
    return this.operations
      .filter((entry) => entry.snapshot.targetId === targetId)
      .slice(-limit)
      .map((entry) => entry.snapshot)
      .reverse();
  }

  /** Insert or replace, then persist. Enforces retention before writing. */
  async put(entry: StoredOperation): Promise<void> {
    const index = this.operations.findIndex(
      (candidate) => candidate.snapshot.operationId === entry.snapshot.operationId,
    );
    if (index >= 0) this.operations[index] = entry;
    else this.operations.push(entry);
    this.prune();
    await this.persist();
  }

  private prune(): void {
    const cutoff = this.now() - MCP_MANAGEMENT_LIMITS.operationRetentionMs;
    const finished = (entry: StoredOperation) =>
      entry.snapshot.phase !== "pending" &&
      entry.snapshot.phase !== "reconciling" &&
      isTerminalApplyState(entry.snapshot.apply.state);
    this.operations = this.operations.filter(
      (entry) => !finished(entry) || Date.parse(entry.snapshot.updatedAt) >= cutoff,
    );
    // Oldest finished records go first; unfinished work is never dropped.
    while (this.operations.length > MCP_MANAGEMENT_LIMITS.retainedOperations) {
      const index = this.operations.findIndex(finished);
      if (index < 0) break;
      this.operations.splice(index, 1);
    }
  }

  private async persist(): Promise<void> {
    const body = JSON.stringify({ version: 1, operations: this.operations } satisfies StoreFile);
    if (utf8ByteLength(body) > MCP_MANAGEMENT_LIMITS.operationStoreMaxBytes) {
      // Shed finished history until the file fits; never shed unfinished work.
      const finishedIndex = this.operations.findIndex((entry) =>
        isTerminalApplyState(entry.snapshot.apply.state),
      );
      if (finishedIndex >= 0) {
        this.operations.splice(finishedIndex, 1);
        return this.persist();
      }
    }
    const write = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, body, { mode: 0o600 });
        await fs.rename(temporary, this.filePath);
      } catch (error) {
        await fs.unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    this.writeChain = write.catch(() => undefined);
    await write;
  }
}
