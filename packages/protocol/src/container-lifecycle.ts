/**
 * Shared contract for container lifecycle mutations.
 *
 * Every destructive container operation names its intent explicitly. A request
 * that omits the intent resolves to `preserve`, and a backend that cannot yet
 * preserve the requested state refuses rather than discarding it. This keeps an
 * older renderer, CLI or automation that still sends the pre-intent request
 * shape from destroying a workspace by default.
 *
 * Errors cross the command transport as message strings, so a typed failure is
 * encoded as `ContainerLifecycleError:<code>: <message>` (the same convention
 * MCP management uses) and parsed back with `parseContainerLifecycleError`.
 */

export const CONTAINER_LIFECYCLE_ERROR_PREFIX = "ContainerLifecycleError";

export const CONTAINER_LIFECYCLE_ERROR_CODES = [
  /** The runtime has local data this operation cannot yet preserve. */
  "preservation-required",
  /** The request was reviewed against a runtime that has since changed. */
  "runtime-changed",
  /** The request's expected revision does not match the stored revision. */
  "revision-conflict",
  /** The Docker resource is not owned by this backend registry. */
  "not-owned",
  /** Docker could not be reached; nothing was changed. */
  "daemon-unavailable",
  /** Docker refused to remove the runtime; its identity is retained. */
  "removal-failed",
  /** Another lifecycle operation owns this environment. */
  "operation-in-progress",
  /** A durable operation is in a state that needs the user's decision. */
  "needs-attention",
  /** The stored state was written by a newer, unsupported format. */
  "unsupported-format",
  /** The image does not declare a capability the operation needs. */
  "capability-unavailable",
  /** The Docker daemon topology cannot support the operation. */
  "unsupported-topology",
  /** A request field was malformed or out of bounds. */
  "invalid-request",
  /** A bounded resource (retained copies, followers, admission) is full. */
  "resource-exhausted",
  /** The requested operation id is unknown or its record has expired. */
  "operation-unknown",
  /** The runtime did not reach readiness for its current boot. */
  "not-ready",
] as const;

export type ContainerLifecycleErrorCode = (typeof CONTAINER_LIFECYCLE_ERROR_CODES)[number];

export function isContainerLifecycleErrorCode(
  value: unknown,
): value is ContainerLifecycleErrorCode {
  return (
    typeof value === "string" &&
    (CONTAINER_LIFECYCLE_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function formatContainerLifecycleError(
  code: ContainerLifecycleErrorCode,
  message: string,
): string {
  return `${CONTAINER_LIFECYCLE_ERROR_PREFIX}:${code}: ${message}`;
}

export interface ParsedContainerLifecycleError {
  code: ContainerLifecycleErrorCode;
  message: string;
}

/**
 * Extracts a typed lifecycle failure from an error message. Transport layers
 * may prefix the message (for example `Error invoking remote method ...:`), so
 * the marker is located anywhere in the string.
 */
export function parseContainerLifecycleError(value: unknown): ParsedContainerLifecycleError | null {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : null;
  if (!message) return null;
  const match = /ContainerLifecycleError:([a-z-]+): (.*)$/s.exec(message);
  if (!match) return null;
  const code = match[1];
  if (!isContainerLifecycleErrorCode(code)) return null;
  return { code, message: match[2] ?? "" };
}

export type RecreateEnvironmentIntent = "preserve" | "discard";

export interface RecreateEnvironmentRequest extends ContainerMutationIdentity {
  environmentId: string;
  /** Omitted means `preserve`. */
  intent: RecreateEnvironmentIntent;
  /**
   * The runtime the user reviewed before choosing `discard`. Required for
   * discard: a replacement that appeared after the review must not be removed
   * on the strength of a confirmation that described a different container.
   */
  expectedContainerId: string | null;
  /**
   * Preserving rebuilds only: proceed when free space on the Docker host
   * cannot be measured. A measured shortfall is always refused.
   */
  allowUnknownCapacity?: boolean;
}

const MAX_ID_LENGTH = 256;

function boundedId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(formatContainerLifecycleError("invalid-request", `Expected ${field}`));
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new Error(formatContainerLifecycleError("invalid-request", `${field} is too long`));
  }
  return value;
}

/**
 * Validates the `recreate_environment` arguments. Unknown keys are ignored so
 * the command remains callable by adapters that forward extra transport
 * metadata, but every recognised field is strictly typed.
 */
export function parseRecreateEnvironmentRequest(
  args: Record<string, unknown>,
): RecreateEnvironmentRequest {
  const environmentId = boundedId(args.environmentId, "environmentId");
  const rawIntent = args.intent;
  if (rawIntent !== undefined && rawIntent !== "preserve" && rawIntent !== "discard") {
    throw new Error(
      formatContainerLifecycleError("invalid-request", "intent must be preserve or discard"),
    );
  }
  const intent: RecreateEnvironmentIntent = rawIntent ?? "preserve";
  const rawExpected = args.expectedContainerId;
  const expectedContainerId =
    rawExpected === undefined || rawExpected === null
      ? null
      : boundedId(rawExpected, "expectedContainerId");
  if (intent === "discard" && !expectedContainerId) {
    throw new Error(
      formatContainerLifecycleError(
        "invalid-request",
        "Discarding a container requires the container id that was reviewed",
      ),
    );
  }
  if (args.allowUnknownCapacity !== undefined && typeof args.allowUnknownCapacity !== "boolean") {
    throw new Error(
      formatContainerLifecycleError("invalid-request", "allowUnknownCapacity must be a boolean"),
    );
  }
  return {
    environmentId,
    intent,
    expectedContainerId,
    ...(args.allowUnknownCapacity === true ? { allowUnknownCapacity: true } : {}),
    ...parseContainerMutationIdentity(args),
  };
}

/** Plain-language consequence of discarding a legacy container. */
export const LEGACY_CONTAINER_DISCARD_WARNING =
  "Resetting deletes this container's local files: uncommitted and untracked changes, " +
  "ignored files, unpushed commits, installed tools and container-local agent session state. " +
  "The remote Git repository does not back up any of these.";

// ---------------------------------------------------------------------------
// Durable lifecycle state (step 02)
// ---------------------------------------------------------------------------

/**
 * Version of the per-environment lifecycle record this code reads and writes.
 * A record carrying a higher version was written by a newer backend; readers
 * keep it verbatim and refuse destructive mutations rather than reinterpreting
 * fields they do not understand.
 */
export const CONTAINER_LIFECYCLE_SCHEMA_VERSION = 1;

/** Recent terminal outcomes retained per environment for request dedupe. */
export const MAX_RECENT_OPERATION_OUTCOMES = 32;
/** Serialized size cap for one environment's lifecycle record. */
export const MAX_LIFECYCLE_RECORD_BYTES = 64 * 1024;

export type ContainerStorageFormat = "legacy-layer" | "volume-v1";

export type ContainerOperationKind =
  | "create"
  | "start"
  | "stop"
  | "discard"
  | "adopt"
  | "rebuild"
  | "migrate"
  | "reset-workspace"
  | "restore"
  | "delete"
  | "refresh-inputs"
  | "update-network"
  | "update-resources";

export const CONTAINER_OPERATION_KINDS: readonly ContainerOperationKind[] = [
  "create",
  "start",
  "stop",
  "discard",
  "adopt",
  "rebuild",
  "migrate",
  "reset-workspace",
  "restore",
  "delete",
  "refresh-inputs",
  "update-network",
  "update-resources",
];

export type ContainerOperationStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  /** Interrupted by a backend exit; reconciliation decided nothing was lost. */
  | "interrupted"
  /** Ambiguous state that requires the user's decision; data is preserved. */
  | "needs-attention";

export const TERMINAL_OPERATION_STATUSES: readonly ContainerOperationStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
];

/** Identity of one container instance. */
export interface ContainerRuntimeIdentity {
  containerId: string;
  /** Changes whenever the container instance is replaced. */
  runtimeGeneration: number;
  /** Registry owner namespace (hash of the data directory). */
  owner: string;
  /** Requested image reference, for display only. */
  imageRef?: string;
  /** Immutable local image id resolved at admission. */
  imageId?: string;
  /** Registry digest, when the image came from a registry. */
  registryDigest?: string;
  /** Last observed entrypoint boot id (step 04). */
  bootId?: string;
  /** Operation that created this runtime. */
  createdByOperationId?: string;
  /** Storage set this runtime mounts; absent for a legacy writable layer. */
  storageSetId?: string;
  /** Set when the runtime is kept as a recovery copy. */
  retainedAt?: string;
  retainedByOperationId?: string;
  retainedReason?: RetainedStorageSet["reason"] | "migrate-source";
}

export interface ContainerVolumeReference {
  role: string;
  name: string;
}

/** Identity of the physical workspace/session storage. */
export interface ContainerStorageIdentity {
  format: ContainerStorageFormat;
  /** Changes on an intentional workspace reset/import, not a runtime rebuild. */
  workspaceGeneration: number;
  /** Physical storage set; absent for the legacy writable-layer format. */
  storageSetId?: string;
  volumes?: ContainerVolumeReference[];
}

export interface ContainerOperationRecord {
  operationId: string;
  kind: ContainerOperationKind;
  status: ContainerOperationStatus;
  /** Kind-specific phase name, persisted before its external effect. */
  phase: string;
  startedAt: string;
  updatedAt: string;
  source?: ContainerRuntimeIdentity;
  candidate?: ContainerRuntimeIdentity;
  /** Storage set being prepared for the candidate (replacement operations). */
  candidateStorage?: ContainerStorageIdentity;
  /** Fixed, content-free failure category. */
  failureCode?: ContainerLifecycleErrorCode | "interrupted" | "setup-failed" | "unknown";
  /** Bounded, kind-specific resumable details (no paths, no content). */
  details?: Record<string, string | number | boolean | null>;
}

export interface ContainerOperationOutcome {
  operationId: string;
  kind: ContainerOperationKind;
  status: ContainerOperationStatus;
  completedAt: string;
  failureCode?: ContainerOperationRecord["failureCode"];
}

export type ContainerBootPhase =
  | "starting"
  | "initializing"
  | "ready"
  | "failed"
  | "draining"
  | "stopped";

export interface ContainerBootRecord {
  /** Boot id from the entrypoint; absent for a legacy image. */
  bootId?: string;
  phase: ContainerBootPhase;
  observedAt: string;
  failureCode?: string;
}

/** Maximum retained storage sets per environment (step 07). */
export const MAX_RETAINED_STORAGE_SETS = 16;

/** A storage set kept as a recovery copy after a replacement or reset. */
export interface RetainedStorageSet {
  storageSetId: string;
  workspaceGeneration: number;
  volumes: ContainerVolumeReference[];
  retainedAt: string;
  reason: "rebuild-source" | "workspace-reset" | "restore-source" | "failed-candidate";
  /** Operation that retained it. */
  operationId?: string;
}

export interface ContainerSetupRecord {
  runtimeGeneration: number;
  workspaceGeneration: number;
  completedAt: string;
}

/** Backend-private durable record stored with the environment. */
export interface EnvironmentContainerLifecycle {
  schemaVersion: number;
  /** Monotonic; bumped by every persisted lifecycle mutation. */
  revision: number;
  /** Highest runtime generation ever assigned to this environment. */
  lastRuntimeGeneration: number;
  runtime?: ContainerRuntimeIdentity;
  storage: ContainerStorageIdentity;
  operation?: ContainerOperationRecord;
  outcomes: ContainerOperationOutcome[];
  /** Last readiness observation for the current runtime (step 04). */
  boot?: ContainerBootRecord;
  /** Recovery copies kept after replacement or reset; never evicted to fit a bound. */
  retainedStorage?: RetainedStorageSet[];
  /**
   * Legacy containers kept stopped as the recovery copy of a migration
   * (their writable layer is the only other copy of the workspace).
   */
  retainedRuntimes?: ContainerRuntimeIdentity[];
  /**
   * Which workspace/runtime the last successful setup belongs to. A completion
   * recorded for another generation does not count as setup of this one.
   */
  setup?: ContainerSetupRecord;
  /**
   * Operation ids at or before this time have aged out of `outcomes`. A
   * repeated request older than the horizon is answered `operation-unknown`
   * rather than being run again.
   */
  outcomeHorizon?: string;
}

/** Safe projection sent to clients. */
export interface ContainerLifecycleSnapshot {
  revision: number;
  supported: boolean;
  runtimeGeneration: number | null;
  imageId: string | null;
  storageFormat: ContainerStorageFormat;
  workspaceGeneration: number;
  operation: {
    operationId: string;
    kind: ContainerOperationKind;
    status: ContainerOperationStatus;
    phase: string;
    startedAt: string;
    updatedAt: string;
    failureCode: string | null;
  } | null;
  lastOutcome: ContainerOperationOutcome | null;
  /** Readiness of the current runtime, when observed. */
  bootPhase: ContainerBootPhase | null;
}

export function emptyContainerLifecycle(): EnvironmentContainerLifecycle {
  return {
    schemaVersion: CONTAINER_LIFECYCLE_SCHEMA_VERSION,
    revision: 0,
    lastRuntimeGeneration: 0,
    storage: { format: "legacy-layer", workspaceGeneration: 1 },
    outcomes: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseRuntime(value: unknown): ContainerRuntimeIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const containerId = boundedString(value.containerId);
  const runtimeGeneration = nonNegativeInteger(value.runtimeGeneration);
  const owner = boundedString(value.owner, 64);
  if (!containerId || runtimeGeneration === undefined || !owner) return undefined;
  const runtime: ContainerRuntimeIdentity = { containerId, runtimeGeneration, owner };
  for (const key of [
    "imageRef",
    "imageId",
    "registryDigest",
    "bootId",
    "createdByOperationId",
    "storageSetId",
    "retainedAt",
    "retainedByOperationId",
  ] as const) {
    const field = boundedString(value[key], 512);
    if (field) runtime[key] = field;
  }
  if (
    value.retainedReason === "rebuild-source" ||
    value.retainedReason === "workspace-reset" ||
    value.retainedReason === "restore-source" ||
    value.retainedReason === "failed-candidate" ||
    value.retainedReason === "migrate-source"
  ) {
    runtime.retainedReason = value.retainedReason;
  }
  return runtime;
}

function parseStorage(value: unknown): ContainerStorageIdentity {
  if (!isRecord(value)) return { format: "legacy-layer", workspaceGeneration: 1 };
  const format: ContainerStorageFormat =
    value.format === "volume-v1" ? "volume-v1" : "legacy-layer";
  const storage: ContainerStorageIdentity = {
    format,
    workspaceGeneration: nonNegativeInteger(value.workspaceGeneration) ?? 1,
  };
  const storageSetId = boundedString(value.storageSetId, 128);
  if (storageSetId) storage.storageSetId = storageSetId;
  if (Array.isArray(value.volumes)) {
    storage.volumes = value.volumes
      .slice(0, 16)
      .flatMap((volume) =>
        isRecord(volume) && boundedString(volume.role, 64) && boundedString(volume.name, 255)
          ? [{ role: volume.role as string, name: volume.name as string }]
          : [],
      );
  }
  return storage;
}

function isOperationKind(value: unknown): value is ContainerOperationKind {
  return (
    typeof value === "string" && (CONTAINER_OPERATION_KINDS as readonly string[]).includes(value)
  );
}

const OPERATION_STATUSES: readonly ContainerOperationStatus[] = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "needs-attention",
];

function isOperationStatus(value: unknown): value is ContainerOperationStatus {
  return typeof value === "string" && (OPERATION_STATUSES as readonly string[]).includes(value);
}

function parseDetails(value: unknown): ContainerOperationRecord["details"] {
  if (!isRecord(value)) return undefined;
  const details: NonNullable<ContainerOperationRecord["details"]> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (count >= 32 || key.length > 64) break;
    if (
      entry === null ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry)) ||
      (typeof entry === "string" && entry.length <= 512)
    ) {
      details[key] = entry;
      count += 1;
    }
  }
  return details;
}

function parseOperation(value: unknown): ContainerOperationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const operationId = boundedString(value.operationId, 64);
  const phase = boundedString(value.phase, 64);
  const startedAt = boundedString(value.startedAt, 64);
  const updatedAt = boundedString(value.updatedAt, 64);
  if (
    !operationId ||
    !phase ||
    !startedAt ||
    !updatedAt ||
    !isOperationKind(value.kind) ||
    !isOperationStatus(value.status)
  ) {
    return undefined;
  }
  const record: ContainerOperationRecord = {
    operationId,
    kind: value.kind,
    status: value.status,
    phase,
    startedAt,
    updatedAt,
  };
  const source = parseRuntime(value.source);
  if (source) record.source = source;
  const candidate = parseRuntime(value.candidate);
  if (candidate) record.candidate = candidate;
  if (isRecord(value.candidateStorage))
    record.candidateStorage = parseStorage(value.candidateStorage);
  const failureCode = boundedString(value.failureCode, 64);
  if (failureCode) record.failureCode = failureCode as ContainerOperationRecord["failureCode"];
  const details = parseDetails(value.details);
  if (details) record.details = details;
  return record;
}

function parseOutcome(value: unknown): ContainerOperationOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const operationId = boundedString(value.operationId, 64);
  const completedAt = boundedString(value.completedAt, 64);
  if (!operationId || !completedAt || !isOperationKind(value.kind)) return undefined;
  if (!isOperationStatus(value.status)) return undefined;
  const outcome: ContainerOperationOutcome = {
    operationId,
    kind: value.kind,
    status: value.status,
    completedAt,
  };
  const failureCode = boundedString(value.failureCode, 64);
  if (failureCode) outcome.failureCode = failureCode as ContainerOperationOutcome["failureCode"];
  return outcome;
}

export type ParsedContainerLifecycle =
  | { supported: true; record: EnvironmentContainerLifecycle }
  /** Written by a newer schema: keep verbatim, refuse destructive work. */
  | { supported: false; raw: unknown; revision: number };

/**
 * Reads a persisted lifecycle record. Absent → an empty legacy record.
 * Malformed fields are dropped individually; an unresolved operation that
 * cannot be parsed is reported as `needs-attention` rather than forgotten.
 */
export function parseContainerLifecycle(value: unknown): ParsedContainerLifecycle {
  if (value === undefined || value === null) {
    return { supported: true, record: emptyContainerLifecycle() };
  }
  if (!isRecord(value)) {
    return { supported: false, raw: value, revision: 0 };
  }
  const schemaVersion = nonNegativeInteger(value.schemaVersion) ?? 0;
  const revision = nonNegativeInteger(value.revision) ?? 0;
  if (schemaVersion > CONTAINER_LIFECYCLE_SCHEMA_VERSION || schemaVersion < 1) {
    return { supported: false, raw: value, revision };
  }
  const record: EnvironmentContainerLifecycle = {
    schemaVersion: CONTAINER_LIFECYCLE_SCHEMA_VERSION,
    revision,
    lastRuntimeGeneration: nonNegativeInteger(value.lastRuntimeGeneration) ?? 0,
    storage: parseStorage(value.storage),
    outcomes: Array.isArray(value.outcomes)
      ? value.outcomes.slice(-MAX_RECENT_OPERATION_OUTCOMES).flatMap((entry) => {
          const outcome = parseOutcome(entry);
          return outcome ? [outcome] : [];
        })
      : [],
  };
  const runtime = parseRuntime(value.runtime);
  if (runtime) record.runtime = runtime;
  if (value.operation !== undefined) {
    const operation = parseOperation(value.operation);
    record.operation = operation ?? {
      operationId: "unreadable",
      kind: "create",
      status: "needs-attention",
      phase: "unreadable",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      failureCode: "unsupported-format",
    };
  }
  const horizon = boundedString(value.outcomeHorizon, 64);
  if (horizon) record.outcomeHorizon = horizon;
  if (isRecord(value.boot)) {
    const phase = value.boot.phase;
    const observedAt = boundedString(value.boot.observedAt, 64);
    if (
      observedAt &&
      (phase === "starting" ||
        phase === "initializing" ||
        phase === "ready" ||
        phase === "failed" ||
        phase === "draining" ||
        phase === "stopped")
    ) {
      record.boot = { phase, observedAt };
      const bootId = boundedString(value.boot.bootId, 64);
      if (bootId) record.boot.bootId = bootId;
      const failureCode = boundedString(value.boot.failureCode, 64);
      if (failureCode) record.boot.failureCode = failureCode;
    }
  }
  if (Array.isArray(value.retainedStorage)) {
    // Retained copies are never dropped to fit a bound: an unreadable entry is
    // kept verbatim-enough (id + volumes) so its data stays referenced.
    record.retainedStorage = value.retainedStorage.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const storageSetId = boundedString(entry.storageSetId, 128);
      if (!storageSetId) return [];
      const reason =
        entry.reason === "rebuild-source" ||
        entry.reason === "workspace-reset" ||
        entry.reason === "restore-source" ||
        entry.reason === "failed-candidate"
          ? entry.reason
          : "rebuild-source";
      const retained: RetainedStorageSet = {
        storageSetId,
        workspaceGeneration: nonNegativeInteger(entry.workspaceGeneration) ?? 0,
        volumes: parseStorage({ volumes: entry.volumes }).volumes ?? [],
        retainedAt: boundedString(entry.retainedAt, 64) ?? new Date(0).toISOString(),
        reason,
      };
      const operationId = boundedString(entry.operationId, 64);
      if (operationId) retained.operationId = operationId;
      return [retained];
    });
  }
  if (Array.isArray(value.retainedRuntimes)) {
    record.retainedRuntimes = value.retainedRuntimes.flatMap((entry) => {
      const runtime = parseRuntime(entry);
      return runtime ? [runtime] : [];
    });
  }
  if (isRecord(value.setup)) {
    const runtimeGeneration = nonNegativeInteger(value.setup.runtimeGeneration);
    const workspaceGeneration = nonNegativeInteger(value.setup.workspaceGeneration);
    const completedAt = boundedString(value.setup.completedAt, 64);
    if (runtimeGeneration !== undefined && workspaceGeneration !== undefined && completedAt) {
      record.setup = { runtimeGeneration, workspaceGeneration, completedAt };
    }
  }
  return { supported: true, record };
}

/**
 * Whether a recorded setup completion belongs to the current runtime and
 * workspace. A legacy writable-layer workspace lives and dies with its
 * runtime, so a new runtime generation invalidates it; persistent storage
 * keeps project setup across runtime replacement and is invalidated by a new
 * workspace generation. No record means the older, generation-less completion
 * flag is all there is, and it is trusted as before.
 */
export function setupCompletionIsCurrent(record: EnvironmentContainerLifecycle): boolean {
  if (!record.setup) return true;
  if (record.storage.format === "legacy-layer") {
    return (
      record.setup.runtimeGeneration ===
      (record.runtime?.runtimeGeneration ?? record.lastRuntimeGeneration)
    );
  }
  return record.setup.workspaceGeneration === record.storage.workspaceGeneration;
}

export function containerLifecycleSnapshot(
  parsed: ParsedContainerLifecycle,
): ContainerLifecycleSnapshot {
  if (!parsed.supported) {
    return {
      revision: parsed.revision,
      supported: false,
      runtimeGeneration: null,
      imageId: null,
      storageFormat: "legacy-layer",
      workspaceGeneration: 0,
      operation: null,
      lastOutcome: null,
      bootPhase: null,
    };
  }
  const { record } = parsed;
  return {
    revision: record.revision,
    supported: true,
    runtimeGeneration: record.runtime?.runtimeGeneration ?? null,
    imageId: record.runtime?.imageId ?? null,
    storageFormat: record.storage.format,
    workspaceGeneration: record.storage.workspaceGeneration,
    operation: record.operation
      ? {
          operationId: record.operation.operationId,
          kind: record.operation.kind,
          status: record.operation.status,
          phase: record.operation.phase,
          startedAt: record.operation.startedAt,
          updatedAt: record.operation.updatedAt,
          failureCode: record.operation.failureCode ?? null,
        }
      : null,
    lastOutcome: record.outcomes.at(-1) ?? null,
    bootPhase: record.boot?.phase ?? null,
  };
}

// ---------------------------------------------------------------------------
// Operation ids
// ---------------------------------------------------------------------------

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isOperationId(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

/** Milliseconds since the epoch embedded in a UUIDv7 operation id. */
export function operationIdTimestamp(operationId: string): number {
  return Number.parseInt(operationId.replaceAll("-", "").slice(0, 12), 16);
}

/**
 * Time-ordered id, so an aged-out request can be told apart from a new one
 * without retaining every id ever seen.
 */
export function createOperationId(now = Date.now(), random: () => number = Math.random): string {
  const hex = (count: number) =>
    Array.from({ length: count }, () => Math.floor(random() * 16).toString(16)).join("");
  const time = Math.max(0, Math.floor(now)).toString(16).padStart(12, "0").slice(-12);
  const variant = (8 + Math.floor(random() * 4)).toString(16);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

/** Optional mutation identity carried by lifecycle commands. */
export interface ContainerMutationIdentity {
  operationId?: string;
  expectedRevision?: number;
}

/** Maximum clock skew accepted on a client-supplied operation id. */
export const MAX_OPERATION_ID_FUTURE_SKEW_MS = 5 * 60_000;

export function parseContainerMutationIdentity(
  args: Record<string, unknown>,
  now = Date.now(),
): ContainerMutationIdentity {
  const identity: ContainerMutationIdentity = {};
  if (args.operationId !== undefined && args.operationId !== null) {
    if (!isOperationId(args.operationId)) {
      throw new Error(
        formatContainerLifecycleError("invalid-request", "operationId must be a UUIDv7"),
      );
    }
    if (operationIdTimestamp(args.operationId) > now + MAX_OPERATION_ID_FUTURE_SKEW_MS) {
      throw new Error(
        formatContainerLifecycleError("invalid-request", "operationId is from the future"),
      );
    }
    identity.operationId = args.operationId;
  }
  if (args.expectedRevision !== undefined && args.expectedRevision !== null) {
    const revision = nonNegativeInteger(args.expectedRevision);
    if (revision === undefined) {
      throw new Error(
        formatContainerLifecycleError("invalid-request", "expectedRevision must be an integer"),
      );
    }
    identity.expectedRevision = revision;
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Preserving rebuild preview (step 06)
// ---------------------------------------------------------------------------

export type RebuildUnavailableReason =
  | "not-containerized"
  | "no-container"
  | "operation-in-progress"
  | "image-unavailable"
  | "image-without-storage-contract"
  | "engine-without-volume-subpath"
  | "disabled-by-configuration"
  | "unsupported-topology"
  | "retention-limit"
  | "unsupported-format";

export interface RebuildProviderPreservation {
  provider: string;
  level: "full" | "partial";
  /** Plain-language description of what is not preserved, if anything. */
  limitations: string | null;
}

/**
 * What a preserving rebuild would do for one environment, read before the
 * user confirms. Content-free: paths are the fixed layout, never file names.
 */
export interface RebuildPreview {
  environmentId: string;
  /** The runtime the preview describes; the confirmation binds to it. */
  containerId: string | null;
  available: boolean;
  unavailableReason?: RebuildUnavailableReason;
  /** `migrate` moves a legacy writable layer onto volumes; `rebuild` copies volumes. */
  kind: "migrate" | "rebuild";
  preservedPaths: string[];
  notPreserved: string[];
  providers: RebuildProviderPreservation[];
  retainedCopies: number;
  retainedCopyLimit: number;
}
