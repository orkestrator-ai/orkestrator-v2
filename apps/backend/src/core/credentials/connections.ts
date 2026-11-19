import { randomUUID } from "node:crypto";
import {
  CREDENTIAL_LIMITS,
  CredentialError,
  credentialValueProblem,
  normalizeCredentialHosts,
  sanitizeCredentialText,
  type CredentialConnection,
} from "@orkestrator/protocol/agent-credentials";
import type { CredentialContext } from "./context.js";
import {
  publicRecord,
  type CredentialRows,
  type RetiredVaultEntry,
  type StoredConnection,
} from "./records.js";
import { newCredentialEntryId } from "./vault.js";

/**
 * Saved connections: a reusable value plus the policy a person attached to
 * it (which projects may ask for it, which hosts a trusted request may reach
 * with it). Saving one authorizes no agent; every use still needs a grant.
 * Values are write-only: there is no way to read one back.
 */

export interface ConnectionInput {
  name: string;
  description?: string;
  projectIds?: string[] | null;
  httpHosts?: string[];
}

function cleanName(name: unknown): string {
  const text =
    typeof name === "string" ? sanitizeCredentialText(name, CREDENTIAL_LIMITS.nameMaxChars) : "";
  if (!text) throw new CredentialError("INVALID_INPUT", "A connection needs a name.");
  return text;
}

function cleanDescription(description: unknown): string | undefined {
  if (typeof description !== "string") return undefined;
  const text = sanitizeCredentialText(description, CREDENTIAL_LIMITS.descriptionMaxChars);
  return text || undefined;
}

function cleanProjects(projectIds: unknown): string[] | null {
  if (projectIds === null || projectIds === undefined) return null;
  if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== "string" || !id)) {
    throw new CredentialError("INVALID_INPUT", "Projects must be a list of project ids.");
  }
  return [...new Set(projectIds as string[])].sort();
}

function cleanHosts(hosts: unknown): string[] {
  if (hosts === undefined) return [];
  if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string")) {
    throw new CredentialError("INVALID_INPUT", "Hosts must be a list of host names.");
  }
  const normalized = normalizeCredentialHosts(hosts as string[]);
  if (!normalized) {
    throw new CredentialError(
      "INVALID_INPUT",
      "Hosts are public host names such as api.example.com (with an optional :port), at most 16.",
    );
  }
  return normalized;
}

function assertValue(value: unknown): asserts value is string {
  const problem = credentialValueProblem(value);
  if (problem) throw new CredentialError("INVALID_INPUT", problem);
}

export function connectionAllowsProject(
  connection: Pick<CredentialConnection, "projectIds">,
  projectId: string,
): boolean {
  return connection.projectIds === null || connection.projectIds.includes(projectId);
}

type Ended = { environments: string[]; grantIds: string[] };
const MAX_TRACKED_VAULT_ENTRIES = CREDENTIAL_LIMITS.maxConnections * 2;

function assertVaultCapacity(rows: CredentialRows, connectionCount: number): void {
  if (rows.countRetiredEntries() + connectionCount >= MAX_TRACKED_VAULT_ENTRIES) {
    throw new CredentialError(
      "STORE_UNAVAILABLE",
      "The vault has pending removals. Try again after cleanup.",
    );
  }
}

const NOTHING_ENDED: Ended = { environments: [], grantIds: [] };

export class CredentialConnections {
  private cleanupSweep: Promise<void> | undefined;
  private cleanupCursor = 0;
  private recoveryCursor = 0;
  private readonly cleaning = new Map<string, Promise<boolean>>();

  constructor(private readonly context: CredentialContext) {}

  list(): CredentialConnection[] {
    const awaitingCleanup = new Set(
      this.context.records.listRetiredEntries().map((entry) => entry.connectionId),
    );
    return this.context.records.listConnections().map((record) => ({
      ...publicRecord(record),
      ...(awaitingCleanup.has(record.id) ? { cleanupPending: true } : {}),
    }));
  }

  /** Connections a project may use, ready ones first. */
  listForProject(projectId: string): CredentialConnection[] {
    return this.list()
      .filter((connection) => connectionAllowsProject(connection, projectId))
      .sort((left, right) =>
        left.status === right.status
          ? left.name.localeCompare(right.name)
          : left.status === "ready"
            ? -1
            : 1,
      );
  }

  private assertCanSave(): void {
    if (!this.context.vaultStatus.canSave) {
      throw new CredentialError("STORE_UNAVAILABLE", this.context.vaultStatus.detail);
    }
  }

  /**
   * Writes a value under a fresh entry and reads it back before anything
   * refers to it; a mismatch removes the entry and fails.
   */
  private async storeValue(value: string): Promise<string> {
    const entryId = newCredentialEntryId();
    try {
      await this.context.vault.put(entryId, value);
      const read = await this.context.vault.get(entryId);
      if (read !== value) throw new Error("read-back mismatch");
    } catch {
      await this.context.vault.delete(entryId).catch(() => undefined);
      throw new CredentialError(
        "STORE_UNAVAILABLE",
        "The credential store did not keep the value. Nothing was saved.",
      );
    }
    return entryId;
  }

  async create(input: ConnectionInput & { value: unknown }): Promise<CredentialConnection> {
    this.assertCanSave();
    const name = cleanName(input.name);
    const description = cleanDescription(input.description);
    const projectIds = cleanProjects(input.projectIds);
    const httpHosts = cleanHosts(input.httpHosts);
    assertValue(input.value);
    if (this.context.records.listConnections().length >= CREDENTIAL_LIMITS.maxConnections) {
      throw new CredentialError("REQUEST_LIMIT", "At most 200 connections can be saved.");
    }
    const entryId = await this.storeValue(input.value);
    const now = this.context.now();
    const record: StoredConnection = {
      id: randomUUID(),
      name,
      ...(description ? { description } : {}),
      projectIds,
      httpHosts,
      storage: this.context.vault.kind,
      revision: 1,
      valueVersion: 1,
      createdAt: now,
      updatedAt: now,
      status: "ready",
      internal: { entryId },
    };
    try {
      this.context.records.transaction((rows) => {
        const existingConnections = rows.connections();
        assertVaultCapacity(rows, existingConnections.length);
        if (existingConnections.length >= CREDENTIAL_LIMITS.maxConnections) {
          throw new CredentialError("REQUEST_LIMIT", "At most 200 connections can be saved.");
        }
        if (existingConnections.some((existing) => existing.name === name)) {
          throw new CredentialError("INVALID_INPUT", `A connection named ${name} already exists.`);
        }
        rows.putConnection(record);
      });
    } catch (error) {
      await this.context.vault.delete(entryId).catch(() => undefined);
      throw error;
    }
    this.context.announce("connections");
    return publicRecord(record);
  }

  /**
   * Changes a connection's name, description or policy. A policy change
   * (projects, hosts) bumps the revision, which ends every grant that pinned
   * the old one; a new grant needs a new approval.
   */
  update(input: { id: string; revision: number } & Partial<ConnectionInput>): CredentialConnection {
    const result = this.context.records.transaction((rows) => {
      const current = rows.connection(input.id);
      if (!current)
        throw new CredentialError("REQUEST_NOT_FOUND", "That connection no longer exists.");
      if (current.revision !== input.revision) {
        throw new CredentialError("REQUEST_STALE", "The connection changed; reload and try again.");
      }
      const name = input.name === undefined ? current.name : cleanName(input.name);
      if (name !== current.name && rows.connections().some((existing) => existing.name === name)) {
        throw new CredentialError("INVALID_INPUT", `A connection named ${name} already exists.`);
      }
      const description =
        input.description === undefined ? current.description : cleanDescription(input.description);
      const projectIds =
        input.projectIds === undefined ? current.projectIds : cleanProjects(input.projectIds);
      const httpHosts =
        input.httpHosts === undefined ? current.httpHosts : cleanHosts(input.httpHosts);
      const policyChanged =
        JSON.stringify(projectIds) !== JSON.stringify(current.projectIds) ||
        JSON.stringify(httpHosts) !== JSON.stringify(current.httpHosts);
      const { description: _previous, ...rest } = current;
      const next: StoredConnection = {
        ...rest,
        name,
        ...(description ? { description } : {}),
        projectIds,
        httpHosts,
        revision: current.revision + 1,
        updatedAt: this.context.now(),
      };
      rows.putConnection(next);
      const ended = policyChanged
        ? this.endConnectionGrants(rows, current.id, "The connection's policy changed.")
        : NOTHING_ENDED;
      return { next, ended };
    });
    this.afterGrantsEnded(result.ended);
    this.context.announce("connections");
    return publicRecord(result.next);
  }

  /** Replaces the value. Grants that pinned the old value end. */
  async replaceValue(input: { id: string; value: unknown }): Promise<CredentialConnection> {
    this.assertCanSave();
    assertValue(input.value);
    if (!this.context.records.getConnection(input.id)) {
      throw new CredentialError("REQUEST_NOT_FOUND", "That connection no longer exists.");
    }
    const entryId = await this.storeValue(input.value);
    let result: { next: StoredConnection; ended: Ended; retired: RetiredVaultEntry };
    try {
      result = this.context.records.transaction((rows) => {
        const current = rows.connection(input.id);
        if (!current)
          throw new CredentialError("REQUEST_NOT_FOUND", "That connection no longer exists.");
        assertVaultCapacity(rows, rows.connections().length);
        const retired = rows.retireVaultEntry(current);
        const next: StoredConnection = {
          ...current,
          storage: this.context.vault.kind,
          valueVersion: current.valueVersion + 1,
          revision: current.revision + 1,
          updatedAt: this.context.now(),
          status: "ready",
          internal: { entryId },
        };
        rows.putConnection(next);
        return {
          next,
          retired,
          ended: this.endConnectionGrants(rows, current.id, "The connection's value was replaced."),
        };
      });
    } catch (error) {
      await this.context.vault.delete(entryId).catch(() => undefined);
      throw error;
    }
    this.afterGrantsEnded(result.ended);
    this.context.announce("connections");
    await this.cleanRetiredEntry(result.retired);
    const cleanupPending = this.context.records.listRetiredEntries(input.id).length > 0;
    return { ...publicRecord(result.next), ...(cleanupPending ? { cleanupPending } : {}) };
  }

  /** Removes the connection and its value. Its grants end at once. */
  async delete(id: string): Promise<{ deleted: boolean; cleanupPending?: boolean }> {
    const result = this.context.records.transaction((rows) => {
      const current = rows.connection(id);
      if (!current) return null;
      rows.retireVaultEntry(current);
      rows.deleteConnection(id);
      return this.endConnectionGrants(rows, id, "The connection was deleted.");
    });
    if (result) {
      this.afterGrantsEnded(result);
      this.context.announce("connections");
    }
    const entries = this.context.records.listRetiredEntries(id);
    if (!entries.length) return { deleted: result !== null };
    for (const entry of entries) await this.cleanRetiredEntry(entry);
    return this.context.records.listRetiredEntries(id).length
      ? { deleted: false, cleanupPending: true }
      : { deleted: true };
  }

  async readValue(id: string, entryId: string): Promise<string | null> {
    const connection = this.context.records.getConnection(id);
    if (!connection || connection.internal.entryId !== entryId) return null;
    const vault = this.context.vaultFor(connection.storage);
    if (!vault) return null;
    const value = await vault.get(entryId);
    // Older versions could mark a connection unavailable after reading the wrong vault.
    if (value !== null && connection.status === "unavailable" && !this.context.isStopped) {
      this.context.records.transaction((rows) => {
        const current = rows.connection(id);
        if (current?.internal.entryId === entryId)
          rows.putConnection({ ...current, status: "ready" });
      });
      this.context.announce("connections");
    }
    return value;
  }

  cleanRetiredEntries(): Promise<void> {
    this.cleanupSweep ??= this.runCleanupSweep().finally(() => {
      this.cleanupSweep = undefined;
    });
    return this.cleanupSweep;
  }

  private async runCleanupSweep(): Promise<void> {
    const entries = this.context.records.listRetiredEntries();
    if (entries.length) {
      const start = this.cleanupCursor % entries.length;
      const count = Math.min(entries.length, 8);
      this.cleanupCursor = start + count;
      for (let offset = 0; offset < count && !this.context.isStopped; offset++) {
        await this.cleanRetiredEntry(entries[(start + offset) % entries.length]!);
      }
    }
    // Recover status left by an older backend once its original vault answers.
    const unavailable = this.context.records
      .listConnections()
      .filter((entry) => entry.status === "unavailable");
    if (!unavailable.length || this.context.isStopped) return;
    const next = unavailable[this.recoveryCursor++ % unavailable.length]!;
    await this.readValue(next.id, next.internal.entryId).catch(() => undefined);
  }

  private cleanRetiredEntry(entry: RetiredVaultEntry): Promise<boolean> {
    const inFlight = this.cleaning.get(entry.id);
    if (inFlight) return inFlight;
    const vault = this.context.vaultFor(entry.storage);
    if (!vault) return Promise.resolve(false);
    const removal = vault
      .delete(entry.id)
      .then(() => {
        if (this.context.isStopped) return false;
        this.context.records.transaction((rows) => rows.confirmVaultRemoval(entry.id));
        this.context.announce("connections");
        return true;
      })
      .catch(() => false)
      .finally(() => this.cleaning.delete(entry.id));
    this.cleaning.set(entry.id, removal);
    return removal;
  }

  noteUsed(id: string): void {
    this.context.records.transaction((rows) => {
      const current = rows.connection(id);
      if (!current) return;
      rows.putConnection({ ...current, lastUsedAt: this.context.now() });
    });
  }

  /** Ends the active grants of a connection; returns their environment ids. */
  private endConnectionGrants(rows: CredentialRows, connectionId: string, reason: string): Ended {
    const environments = new Set<string>();
    const grantIds: string[] = [];
    for (const grant of rows.grants()) {
      if (
        grant.state !== "active" ||
        grant.source.kind !== "connection" ||
        grant.source.connectionId !== connectionId
      ) {
        continue;
      }
      rows.putGrant({
        ...grant,
        state: "invalidated",
        endedAt: this.context.now(),
        endReason: reason,
      });
      environments.add(grant.environmentId);
      grantIds.push(grant.id);
    }
    return { environments: [...environments], grantIds };
  }

  /** Set by the facade: cancels running work of grants a change ended. */
  onGrantsEnded: (grantIds: string[]) => void = () => undefined;

  private afterGrantsEnded(ended: Ended): void {
    if (ended.grantIds.length) this.onGrantsEnded(ended.grantIds);
    for (const environmentId of ended.environments) this.context.announce(environmentId);
  }
}
