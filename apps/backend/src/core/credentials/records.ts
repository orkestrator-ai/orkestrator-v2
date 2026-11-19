import {
  CREDENTIAL_LIMITS,
  type CredentialConnection,
  type CredentialGrantRecord,
  type CredentialOperationRecord,
  type CredentialRequestRecord,
  type CredentialVaultKind,
} from "@orkestrator/protocol/agent-credentials";
import type { CredentialProcessOwner } from "./owner.js";
import type { StorageDatabase, StoreRows } from "../storage-database.js";
import {
  CREDENTIAL_CONNECTIONS_STORE,
  CREDENTIAL_GRANTS_STORE,
  CREDENTIAL_OPERATIONS_STORE,
  CREDENTIAL_REQUESTS_STORE,
  CREDENTIAL_RUN_CLEANUP_STORE,
  CREDENTIAL_VAULT_CLEANUP_STORE,
} from "./layout.js";

/**
 * The credential records as database rows. Each stored record is the client
 * DTO plus an `internal` part no command returns: vault entry ids, the
 * conversation and runtime a grant is bound to, an operation's idempotency
 * fingerprint. None of it is a value.
 *
 * Every write is one synchronous transaction, so a use reservation is
 * exactly-once across tool calls and processes sharing the data directory.
 * Reads skip a row that does not parse: an unreadable grant authorizes
 * nothing, which is the fail-closed direction.
 */

export interface StoredConnection extends CredentialConnection {
  internal: { entryId: string };
}

export interface RetiredVaultEntry {
  id: string;
  connectionId: string;
  storage: CredentialVaultKind;
  staging?: { owner: CredentialProcessOwner; bootId: string; abandoned?: true };
}

export interface CredentialRunCleanup {
  id: string;
  environmentId: string;
  owner?: CredentialProcessOwner;
  containerId?: string;
  retryable?: true;
}

export interface StoredRequest extends CredentialRequestRecord {
  internal: {
    agent: string | null;
    callerTabId?: string;
    logicalSessionKey: string;
    providerSessionId: string | null;
    runtimeIdentity: string;
  };
}

export interface StoredGrant extends CredentialGrantRecord {
  internal: {
    logicalSessionKey: string;
    providerSessionId: string | null;
    /** The container id, worktree path or checkout the grant is bound to. */
    runtimeIdentity: string;
    /** Connection source: the revision and value version it pinned. */
    connectionRevision?: number;
    valueVersion?: number;
    /** The vault entry: the connection's, or this grant's memory entry. */
    entryId: string;
    /** The backend process that issued it, and its monotonic clock then. */
    bootId: string;
    owner?: CredentialProcessOwner;
    issuedMonotonicMs: number;
    lifetimeMs: number;
  };
}

export interface StoredOperation extends CredentialOperationRecord {
  internal: {
    idempotencyKey: string | null;
    fingerprint: string;
    scope?: { projectId: string; providerSessionId: string | null };
    bootId: string;
    owner?: CredentialProcessOwner;
    cancelRequested?: boolean;
    /** Legacy location hint. New commands journal this in credential-run-cleanup. */
    containerId?: string;
  };
}

type CredentialStore =
  | typeof CREDENTIAL_VAULT_CLEANUP_STORE
  | typeof CREDENTIAL_CONNECTIONS_STORE
  | typeof CREDENTIAL_REQUESTS_STORE
  | typeof CREDENTIAL_GRANTS_STORE
  | typeof CREDENTIAL_OPERATIONS_STORE
  | typeof CREDENTIAL_RUN_CLEANUP_STORE;

/**
 * Rows of one credential store. Every `rows(...)` call names its store
 * constant, so the storage writer guards can follow each write to its store.
 */
function storeRows(database: StorageDatabase, store: CredentialStore): StoreRows {
  switch (store) {
    case CREDENTIAL_CONNECTIONS_STORE:
      return database.rows(CREDENTIAL_CONNECTIONS_STORE);
    case CREDENTIAL_VAULT_CLEANUP_STORE:
      return database.rows(CREDENTIAL_VAULT_CLEANUP_STORE);
    case CREDENTIAL_REQUESTS_STORE:
      return database.rows(CREDENTIAL_REQUESTS_STORE);
    case CREDENTIAL_GRANTS_STORE:
      return database.rows(CREDENTIAL_GRANTS_STORE);
    case CREDENTIAL_RUN_CLEANUP_STORE:
      return database.rows(CREDENTIAL_RUN_CLEANUP_STORE);
    case CREDENTIAL_OPERATIONS_STORE:
      return database.rows(CREDENTIAL_OPERATIONS_STORE);
  }
}

function parseJson(raw: string | undefined | null): unknown {
  if (raw === undefined || raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasStrings(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && value[key] !== "");
}

function parseConnection(raw: unknown): StoredConnection | null {
  if (!isRecord(raw) || !hasStrings(raw, ["id", "name"]) || !isRecord(raw.internal)) return null;
  if (typeof raw.internal.entryId !== "string") return null;
  if (typeof raw.revision !== "number" || typeof raw.valueVersion !== "number") return null;
  return raw as unknown as StoredConnection;
}

function parseRequest(raw: unknown): StoredRequest | null {
  if (
    !isRecord(raw) ||
    !hasStrings(raw, ["id", "environmentId", "projectId", "tabId", "state", "use"]) ||
    !isRecord(raw.internal) ||
    typeof raw.revision !== "number"
  ) {
    return null;
  }
  return raw as unknown as StoredRequest;
}

function parseGrant(raw: unknown): StoredGrant | null {
  if (
    !isRecord(raw) ||
    !hasStrings(raw, ["id", "requestId", "environmentId", "projectId", "tabId", "state", "use"]) ||
    !isRecord(raw.internal) ||
    typeof raw.internal.entryId !== "string" ||
    typeof raw.internal.runtimeIdentity !== "string" ||
    typeof raw.expiresAt !== "number" ||
    typeof raw.uses !== "number"
  ) {
    return null;
  }
  return raw as unknown as StoredGrant;
}

function parseOperation(raw: unknown): StoredOperation | null {
  if (
    !isRecord(raw) ||
    !hasStrings(raw, ["id", "grantId", "environmentId", "tabId", "state", "kind"]) ||
    !isRecord(raw.internal)
  ) {
    return null;
  }
  return raw as unknown as StoredOperation;
}

function parseRetiredEntry(raw: unknown): RetiredVaultEntry | null {
  return isRecord(raw) &&
    hasStrings(raw, ["id", "connectionId"]) &&
    (raw.storage === "keychain" || raw.storage === "file" || raw.storage === "memory")
    ? (raw as unknown as RetiredVaultEntry)
    : null;
}

function parseRunCleanup(raw: unknown): CredentialRunCleanup | null {
  return isRecord(raw) && hasStrings(raw, ["id", "environmentId"])
    ? (raw as unknown as CredentialRunCleanup)
    : null;
}

/** The client view of a record: everything except `internal`. */
export function publicRecord<T extends { internal: unknown }>(record: T): Omit<T, "internal"> {
  const { internal: _internal, ...rest } = record;
  return rest;
}

const SETTLED_REQUEST = new Set(["granted", "declined", "expired", "cancelled"]);
const SETTLED_GRANT = new Set(["revoked", "expired", "invalidated"]);
const SETTLED_OPERATION = new Set([
  "succeeded",
  "failed",
  "failed_no_effect",
  "outcome_unknown",
  "cancelled_before_start",
]);

export class CredentialRecordStore {
  constructor(
    private readonly options: {
      database: () => StorageDatabase;
      /** Announces a committed change; the id is an environment id or `connections`. */
      announce?: (id: string) => void;
    },
  ) {}

  private database(): StorageDatabase {
    return this.options.database();
  }

  announce(id: string): void {
    this.options.announce?.(id);
  }

  private list<T>(store: CredentialStore, parse: (raw: unknown) => T | null, owner?: string): T[] {
    const database = this.database();
    if (!database.hasStore(store)) return [];
    const records: T[] = [];
    for (const entry of storeRows(database, store).list({
      values: true,
      ...(owner ? { owner } : {}),
    })) {
      const record = parse(parseJson(entry.value));
      if (record) records.push(record);
    }
    return records;
  }

  private get<T extends { id: string }>(
    store: CredentialStore,
    id: string,
    parse: (raw: unknown) => T | null,
  ): T | null {
    const database = this.database();
    if (!database.hasStore(store)) return null;
    const record = parse(parseJson(storeRows(database, store).get(id)));
    return record?.id === id ? record : null;
  }

  /** Runs `fn` in one transaction over the credential stores. */
  transaction<T>(fn: (rows: CredentialRows) => T): T {
    const database = this.database();
    return database.transaction(() => fn(new CredentialRows(database)));
  }

  // --- Connections -----------------------------------------------------------

  listConnections(): StoredConnection[] {
    return this.list(CREDENTIAL_CONNECTIONS_STORE, parseConnection).sort(
      (left, right) => left.createdAt - right.createdAt,
    );
  }

  getConnection(id: string): StoredConnection | null {
    return this.get(CREDENTIAL_CONNECTIONS_STORE, id, parseConnection);
  }

  listRetiredEntries(connectionId?: string): RetiredVaultEntry[] {
    return this.list(CREDENTIAL_VAULT_CLEANUP_STORE, parseRetiredEntry, connectionId);
  }

  listRunCleanup(environmentId?: string): CredentialRunCleanup[] {
    return this.list(CREDENTIAL_RUN_CLEANUP_STORE, parseRunCleanup, environmentId);
  }

  // --- Requests ---------------------------------------------------------------

  listRequests(environmentId?: string): StoredRequest[] {
    return this.list(CREDENTIAL_REQUESTS_STORE, parseRequest, environmentId)
      .filter((request) => !environmentId || request.environmentId === environmentId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  getRequest(id: string): StoredRequest | null {
    return this.get(CREDENTIAL_REQUESTS_STORE, id, parseRequest);
  }

  // --- Grants -------------------------------------------------------------------

  listGrants(environmentId?: string): StoredGrant[] {
    return this.list(CREDENTIAL_GRANTS_STORE, parseGrant, environmentId)
      .filter((grant) => !environmentId || grant.environmentId === environmentId)
      .sort((left, right) => left.issuedAt - right.issuedAt);
  }

  getGrant(id: string): StoredGrant | null {
    return this.get(CREDENTIAL_GRANTS_STORE, id, parseGrant);
  }

  // --- Operations ---------------------------------------------------------------

  listOperations(environmentId?: string): StoredOperation[] {
    return this.list(CREDENTIAL_OPERATIONS_STORE, parseOperation, environmentId)
      .filter((operation) => !environmentId || operation.environmentId === environmentId)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  getOperation(id: string): StoredOperation | null {
    return this.get(CREDENTIAL_OPERATIONS_STORE, id, parseOperation);
  }

  /** Every environment that has a credential record. */
  environments(): string[] {
    const database = this.database();
    const owners = new Set<string>();
    for (const store of [
      CREDENTIAL_REQUESTS_STORE,
      CREDENTIAL_GRANTS_STORE,
      CREDENTIAL_OPERATIONS_STORE,
    ] as const) {
      if (database.hasStore(store))
        for (const owner of storeRows(database, store).owners()) owners.add(owner);
    }
    return [...owners];
  }

  /** Removes every record an environment owns. */
  deleteEnvironment(environmentId: string): void {
    const database = this.database();
    database.transaction(() => {
      for (const store of [
        CREDENTIAL_REQUESTS_STORE,
        CREDENTIAL_GRANTS_STORE,
        CREDENTIAL_OPERATIONS_STORE,
      ] as const) {
        if (database.hasStore(store)) {
          storeRows(database, store).deleteWhere({ owner: environmentId });
        }
      }
    });
  }
}

/** Row access inside one transaction. */
export class CredentialRows {
  constructor(private readonly database: StorageDatabase) {}

  private rows(store: CredentialStore): StoreRows {
    return storeRows(this.database, store);
  }

  private read<T extends { id: string }>(
    store: CredentialStore,
    id: string,
    parse: (raw: unknown) => T | null,
  ): T | null {
    const record = parse(parseJson(this.rows(store).get(id)));
    return record?.id === id ? record : null;
  }

  connection(id: string): StoredConnection | null {
    return this.read(CREDENTIAL_CONNECTIONS_STORE, id, parseConnection);
  }

  connections(): StoredConnection[] {
    return this.rows(CREDENTIAL_CONNECTIONS_STORE)
      .list({ values: true })
      .map((entry) => parseConnection(parseJson(entry.value)))
      .filter((record): record is StoredConnection => record !== null);
  }

  putConnection(record: StoredConnection): void {
    this.rows(CREDENTIAL_CONNECTIONS_STORE).put(record.id, JSON.stringify(record));
  }

  deleteConnection(id: string): boolean {
    return this.rows(CREDENTIAL_CONNECTIONS_STORE).delete(id);
  }

  countRetiredEntries(): number {
    return this.rows(CREDENTIAL_VAULT_CLEANUP_STORE).list().length;
  }

  retireVaultEntry(connection: StoredConnection): RetiredVaultEntry {
    const record = {
      id: connection.internal.entryId,
      connectionId: connection.id,
      storage: connection.storage,
    };
    this.putVaultCleanup(record);
    return record;
  }

  putVaultCleanup(record: RetiredVaultEntry): void {
    this.rows(CREDENTIAL_VAULT_CLEANUP_STORE).put(record.id, JSON.stringify(record));
  }

  countRunCleanup(environmentId: string): number {
    return this.rows(CREDENTIAL_RUN_CLEANUP_STORE).list({ owner: environmentId }).length;
  }

  putRunCleanup(record: CredentialRunCleanup): void {
    this.rows(CREDENTIAL_RUN_CLEANUP_STORE).put(record.id, JSON.stringify(record));
  }

  runCleanup(id: string): CredentialRunCleanup | null {
    return this.read(CREDENTIAL_RUN_CLEANUP_STORE, id, parseRunCleanup);
  }

  confirmRunCleanup(id: string): void {
    this.rows(CREDENTIAL_RUN_CLEANUP_STORE).delete(id);
  }

  confirmVaultRemoval(entryId: string): void {
    this.rows(CREDENTIAL_VAULT_CLEANUP_STORE).delete(entryId);
  }

  request(id: string): StoredRequest | null {
    return this.read(CREDENTIAL_REQUESTS_STORE, id, parseRequest);
  }

  requests(environmentId: string): StoredRequest[] {
    return this.rows(CREDENTIAL_REQUESTS_STORE)
      .list({ values: true, owner: environmentId })
      .map((entry) => parseRequest(parseJson(entry.value)))
      .filter((record): record is StoredRequest => record?.environmentId === environmentId);
  }

  putRequest(record: StoredRequest): void {
    this.rows(CREDENTIAL_REQUESTS_STORE).put(record.id, JSON.stringify(record));
    this.prune(CREDENTIAL_REQUESTS_STORE, record.environmentId, parseRequest, (item) =>
      SETTLED_REQUEST.has(item.state),
    );
  }

  grant(id: string): StoredGrant | null {
    return this.read(CREDENTIAL_GRANTS_STORE, id, parseGrant);
  }

  grants(environmentId?: string): StoredGrant[] {
    return this.rows(CREDENTIAL_GRANTS_STORE)
      .list({ values: true, ...(environmentId ? { owner: environmentId } : {}) })
      .map((entry) => parseGrant(parseJson(entry.value)))
      .filter(
        (record): record is StoredGrant =>
          record !== null && (!environmentId || record.environmentId === environmentId),
      );
  }

  putGrant(record: StoredGrant): void {
    this.rows(CREDENTIAL_GRANTS_STORE).put(record.id, JSON.stringify(record));
    this.prune(CREDENTIAL_GRANTS_STORE, record.environmentId, parseGrant, (item) =>
      SETTLED_GRANT.has(item.state),
    );
  }

  operation(id: string): StoredOperation | null {
    return this.read(CREDENTIAL_OPERATIONS_STORE, id, parseOperation);
  }

  operations(environmentId?: string): StoredOperation[] {
    return this.rows(CREDENTIAL_OPERATIONS_STORE)
      .list({ values: true, ...(environmentId ? { owner: environmentId } : {}) })
      .map((entry) => parseOperation(parseJson(entry.value)))
      .filter(
        (record): record is StoredOperation =>
          record !== null && (!environmentId || record.environmentId === environmentId),
      );
  }

  operationCanBePruned(operation: StoredOperation): boolean {
    return (
      SETTLED_OPERATION.has(operation.state) &&
      (!operation.internal.idempotencyKey || this.grant(operation.grantId)?.state !== "active")
    );
  }

  putOperation(record: StoredOperation): void {
    this.rows(CREDENTIAL_OPERATIONS_STORE).put(record.id, JSON.stringify(record));
    this.prune(CREDENTIAL_OPERATIONS_STORE, record.environmentId, parseOperation, (item) =>
      this.operationCanBePruned(item),
    );
  }

  /**
   * Keeps an environment's records of one store within the bound by
   * removing its oldest settled ones. Open records are never removed: a
   * pending request, an active grant or a running operation still matters.
   */
  private prune<T extends { id: string; createdAt?: number; issuedAt?: number }>(
    store: CredentialStore,
    environmentId: string,
    parse: (raw: unknown) => T | null,
    settled: (record: T) => boolean,
  ): void {
    const entries = this.rows(store).list({ values: true, owner: environmentId });
    if (entries.length <= CREDENTIAL_LIMITS.maxRecordsPerEnvironment) return;
    const removable = entries
      .map((entry) => parse(parseJson(entry.value)))
      .filter((record): record is T => record !== null && settled(record))
      .sort(
        (left, right) =>
          (left.createdAt ?? left.issuedAt ?? 0) - (right.createdAt ?? right.issuedAt ?? 0),
      );
    let excess = entries.length - CREDENTIAL_LIMITS.maxRecordsPerEnvironment;
    for (const record of removable) {
      if (excess <= 0) break;
      this.rows(store).delete(record.id);
      excess -= 1;
    }
  }
}
