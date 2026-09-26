/**
 * Pure rules of the public operation store: request-key scope, namespaces and
 * their expiry fence, record bounds, and the receipt projection. The storage
 * layer (`storage-public-operations.ts`) applies these under its lock.
 *
 * Durability scope: records are written with the same atomic temp-file +
 * rename (+ fsync of the temp file) as the other structural stores. That
 * survives a process crash or kill; it is not a claim of power-loss
 * durability for the directory entry.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  canonicalJson,
  formatPublicNamespace,
  isPublicNamespace,
  isTerminalPublicOperationState,
  PUBLIC_OPERATION_RETENTION,
  publicNamespaceCreatedAt,
  type PublicActionName,
  type PublicDispatchState,
  type PublicErrorCode,
  type PublicExecutionState,
  type PublicOperationResources,
  type PublicOperationState,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";

export const PUBLIC_OPERATION_RECORD_VERSION = 1;

/** Who admitted an operation. Only the gateway operator exists today. */
export type PublicAuthority = "operator";

export interface PublicOperationRecord {
  version: typeof PUBLIC_OPERATION_RECORD_VERSION;
  operationId: string;
  namespace: string;
  requestId: string;
  /** sha256(authority, action, scope, requestId); namespace-independent. */
  requestKey: string;
  authority: PublicAuthority;
  action: PublicActionName;
  /** Canonical target scope, e.g. `project:<id>` or `environment:<id>`. */
  scope: string;
  /** sha256 of the canonical validated intent. */
  fingerprint: string;
  /** Defaults resolved at first admission, so a replay keeps the original choice. */
  resolved?: Record<string, string | number | boolean | null>;
  state: PublicOperationState;
  stage: string;
  resources: PublicOperationResources;
  dispatch?: PublicDispatchState;
  execution?: PublicExecutionState;
  error?: { code: PublicErrorCode; message: string };
  /** Small, content-free action result (IDs) returned again on replay. */
  result?: Record<string, unknown>;
  /** A `session.stop` targeted this run; its end settles as `cancelled`. */
  stopRequestedAt?: string;
  /** Backend generation that last advanced the record. */
  generation: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface PublicNamespaceEntry {
  id: string;
  createdAt: number;
}

export interface PublicOperationIndex {
  version: 1;
  /** Retained namespaces, oldest first; the last one is current. */
  namespaces: PublicNamespaceEntry[];
  /** Recently retired namespace IDs (bounded); older ones are recognized by age. */
  retired: string[];
}

export const MAX_RETIRED_NAMESPACES = 256;

export function emptyIndex(): PublicOperationIndex {
  return { version: 1, namespaces: [], retired: [] };
}

export function newNamespace(now: number): PublicNamespaceEntry {
  return { id: formatPublicNamespace(now, randomBytes(4).toString("hex")), createdAt: now };
}

export function namespaceAdmissionEnds(entry: PublicNamespaceEntry): number {
  return entry.createdAt + PUBLIC_OPERATION_RETENTION.admissionWindowMs;
}

export function namespaceFence(entry: PublicNamespaceEntry): number {
  return namespaceAdmissionEnds(entry) + PUBLIC_OPERATION_RETENTION.retentionMs;
}

/** The namespace currently admitting keys, rotating when its window closed. */
export function currentNamespace(
  index: PublicOperationIndex,
  now: number,
): { index: PublicOperationIndex; current: PublicNamespaceEntry; rotated: boolean } {
  const latest = index.namespaces.at(-1);
  if (latest && now < namespaceAdmissionEnds(latest) && now >= latest.createdAt - 60_000) {
    return { index, current: latest, rotated: false };
  }
  const created = newNamespace(now);
  return {
    index: { ...index, namespaces: [...index.namespaces, created] },
    current: created,
    rotated: true,
  };
}

export type NamespaceStatus = "current" | "retained" | "retired" | "unknown";

export function namespaceStatus(index: PublicOperationIndex, namespace: string): NamespaceStatus {
  if (!isPublicNamespace(namespace)) return "unknown";
  const entry = index.namespaces.find((candidate) => candidate.id === namespace);
  if (entry) return index.namespaces.at(-1)?.id === namespace ? "current" : "retained";
  if (index.retired.includes(namespace)) return "retired";
  // Not retained and not in the bounded retired list: a namespace older than
  // the oldest retained one was retired long ago; anything newer was never
  // issued by this installation.
  const createdAt = publicNamespaceCreatedAt(namespace);
  const oldest = index.namespaces[0]?.createdAt;
  if (createdAt !== null && oldest !== undefined && createdAt < oldest) return "retired";
  return "unknown";
}

export function requestKey(
  authority: PublicAuthority,
  action: PublicActionName,
  scope: string,
  requestId: string,
): string {
  return createHash("sha256")
    .update(authority)
    .update("\0")
    .update(action)
    .update("\0")
    .update(scope)
    .update("\0")
    .update(requestId)
    .digest("hex");
}

export function intentFingerprint(action: PublicActionName, intent: unknown): string {
  return createHash("sha256").update(canonicalJson({ action, intent })).digest("hex");
}

/** Operation IDs embed their namespace, so an expired ID is recognizable. */
export function newOperationId(namespace: string): string {
  return `op-${namespace.slice(3)}-${randomBytes(9).toString("hex")}`;
}

export function namespaceOfOperationId(operationId: string): string | null {
  const match = /^op-([0-9]{13}-[a-f0-9]{8})-[a-f0-9]{18}$/.exec(operationId);
  return match ? `ns-${match[1]}` : null;
}

export function isActiveRecord(record: PublicOperationRecord): boolean {
  return !isTerminalPublicOperationState(record.state);
}

export function recordBytes(record: PublicOperationRecord): number {
  return Buffer.byteLength(JSON.stringify(record));
}

/** Clamp the free-text parts of a record so it fits the per-record bound. */
export function boundRecord(record: PublicOperationRecord): PublicOperationRecord {
  const clamp = (text: string | undefined, max: number) =>
    text === undefined ? undefined : text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  let bounded: PublicOperationRecord = {
    ...record,
    ...(record.error
      ? { error: { ...record.error, message: clamp(record.error.message, 1_000)! } }
      : {}),
    ...(record.dispatch?.error
      ? { dispatch: { ...record.dispatch, error: clamp(record.dispatch.error, 500) } }
      : {}),
    ...(record.execution
      ? {
          execution: {
            ...record.execution,
            ...(record.execution.error ? { error: clamp(record.execution.error, 500) } : {}),
            ...(record.execution.reason ? { reason: clamp(record.execution.reason, 500) } : {}),
            ...(record.execution.interactions
              ? { interactions: record.execution.interactions.slice(0, 16) }
              : {}),
          },
        }
      : {}),
  };
  if (recordBytes(bounded) > PUBLIC_OPERATION_RETENTION.maxRecordBytes) {
    const { result: _result, ...withoutResult } = bounded;
    bounded = withoutResult;
  }
  if (recordBytes(bounded) > PUBLIC_OPERATION_RETENTION.maxRecordBytes) {
    throw new Error("Public operation record exceeds its size bound");
  }
  return bounded;
}

export function retainedUntil(record: PublicOperationRecord): string {
  const createdAt = publicNamespaceCreatedAt(record.namespace) ?? Date.parse(record.createdAt);
  return new Date(
    createdAt +
      PUBLIC_OPERATION_RETENTION.admissionWindowMs +
      PUBLIC_OPERATION_RETENTION.retentionMs,
  ).toISOString();
}

export function toReceipt(record: PublicOperationRecord, replayed: boolean): PublicReceipt {
  return {
    operationId: record.operationId,
    namespace: record.namespace,
    requestId: record.requestId,
    action: record.action,
    state: record.state,
    stage: record.stage,
    replayed,
    resources: record.resources,
    ...(record.dispatch ? { dispatch: record.dispatch } : {}),
    ...(record.execution ? { execution: record.execution } : {}),
    ...(record.error ? { error: record.error } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
    retainedUntil: retainedUntil(record),
  };
}

const OPERATION_STATES: readonly PublicOperationState[] = [
  "admitted",
  "running",
  "succeeded",
  "failed",
  "partial",
  "unknown",
  "interrupted",
  "cancelled",
];

/** Structural check of a persisted record; invalid records are kept on disk but never served. */
export function isPublicOperationRecord(value: unknown): value is PublicOperationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === PUBLIC_OPERATION_RECORD_VERSION &&
    typeof record.operationId === "string" &&
    typeof record.namespace === "string" &&
    typeof record.requestId === "string" &&
    typeof record.requestKey === "string" &&
    record.authority === "operator" &&
    typeof record.action === "string" &&
    typeof record.scope === "string" &&
    typeof record.fingerprint === "string" &&
    OPERATION_STATES.includes(record.state as PublicOperationState) &&
    typeof record.stage === "string" &&
    !!record.resources &&
    typeof record.resources === "object" &&
    typeof record.generation === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
