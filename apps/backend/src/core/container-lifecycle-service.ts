import {
  CONTAINER_LIFECYCLE_SCHEMA_VERSION,
  MAX_RECENT_OPERATION_OUTCOMES,
  TERMINAL_OPERATION_STATUSES,
  containerLifecycleSnapshot,
  createOperationId,
  formatContainerLifecycleError,
  operationIdTimestamp,
  parseContainerLifecycle,
  parseContainerLifecycleError,
  type ContainerLifecycleErrorCode,
  type ContainerMutationIdentity,
  type ContainerOperationKind,
  type ContainerOperationOutcome,
  type ContainerOperationRecord,
  type ContainerOperationStatus,
  type ContainerRuntimeIdentity,
  type EnvironmentContainerLifecycle,
} from "@orkestrator/protocol/container-lifecycle";
import {
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_OPERATION_ID,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_RUNTIME_GENERATION,
  dockerOwnerNamespace,
  runCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";

/**
 * The container lifecycle authority.
 *
 * Every container mutation runs as one durable operation recorded in the
 * environment's `containerLifecycle` record, persisted before its external
 * effect and completed after it. The per-environment lifecycle queue already
 * serializes operations in this process and the registry writer lease excludes
 * other processes, so a read-check-write of the record is race-free.
 *
 * Lock order: the environment lifecycle queue is taken first (by the caller);
 * this module never enqueues on it, so it cannot re-enter its own queue.
 */

export const CONTAINER_LIFECYCLE_EVENT = "container-lifecycle-updated";

type LifecycleContext = Pick<CommandContext, "storage" | "emit"> &
  Partial<Pick<CommandContext, "strictDockerOwner" | "registryWriterLease">>;

export class ContainerLifecycleError extends Error {
  constructor(
    readonly code: ContainerLifecycleErrorCode,
    message: string,
  ) {
    super(formatContainerLifecycleError(code, message));
    this.name = "ContainerLifecycleError";
  }
}

/** Operations executing in this process, keyed `${registry}:${operationId}`. */
const activeOperations = new Set<string>();

function activeKey(context: LifecycleContext, operationId: string): string {
  return `${dockerOwnerNamespace(context.storage.getDataDir())}:${operationId}`;
}

export function isOperationActive(context: LifecycleContext, operationId: string): boolean {
  return activeOperations.has(activeKey(context, operationId));
}

function readRecord(environment: Environment): EnvironmentContainerLifecycle {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) {
    throw new ContainerLifecycleError(
      "unsupported-format",
      "This environment was changed by a newer version of Orkestrator. Update Orkestrator before changing its container.",
    );
  }
  return parsed.record;
}

async function persist(
  context: LifecycleContext,
  environmentId: string,
  record: EnvironmentContainerLifecycle,
  extra: Partial<Environment> = {},
): Promise<Environment> {
  context.registryWriterLease?.assertHeld();
  const updated = await context.storage.updateEnvironment(environmentId, {
    ...extra,
    containerLifecycle: record,
  });
  // Progress is published only after it is durable, and carries the revision
  // so a client that missed events can tell it is behind.
  context.emit(CONTAINER_LIFECYCLE_EVENT, {
    environmentId,
    snapshot: containerLifecycleSnapshot({ supported: true, record }),
  });
  return updated;
}

function nextRecord(record: EnvironmentContainerLifecycle): EnvironmentContainerLifecycle {
  return {
    ...record,
    schemaVersion: CONTAINER_LIFECYCLE_SCHEMA_VERSION,
    revision: record.revision + 1,
    outcomes: [...record.outcomes],
  };
}

export interface BegunOperation {
  operation: ContainerOperationRecord;
  environment: Environment;
}

export type OperationAdmission =
  | { kind: "begun"; operation: ContainerOperationRecord; environment: Environment }
  /** The same request already finished; its effects must not be repeated. */
  | { kind: "replayed"; outcome: ContainerOperationOutcome };

/**
 * Admits a mutation: validates identity and revision, deduplicates a repeated
 * request, reconciles a stale operation left by an earlier process, and
 * persists the new operation before any external effect.
 */
export async function beginContainerOperation(
  context: LifecycleContext,
  environmentId: string,
  kind: ContainerOperationKind,
  options: ContainerMutationIdentity & {
    phase?: string;
    source?: ContainerRuntimeIdentity;
    details?: ContainerOperationRecord["details"];
    now?: Date;
  } = {},
): Promise<OperationAdmission> {
  let environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  let record = readRecord(environment);

  if (options.operationId) {
    const replay = record.outcomes.find((entry) => entry.operationId === options.operationId);
    if (replay) return { kind: "replayed", outcome: replay };
    if (record.operation?.operationId === options.operationId) {
      throw new ContainerLifecycleError(
        "operation-in-progress",
        "This request is already running.",
      );
    }
    if (
      record.outcomeHorizon &&
      operationIdTimestamp(options.operationId) <= Date.parse(record.outcomeHorizon)
    ) {
      // Its outcome may have aged out. Running it again could repeat a
      // destructive effect the caller already observed.
      throw new ContainerLifecycleError(
        "operation-unknown",
        "This request is too old to be matched to its result. Review the environment and submit a new request.",
      );
    }
  }

  if (record.operation && !isOperationActive(context, record.operation.operationId)) {
    // Left behind by an earlier process (or an ambiguous failure in this one).
    await reconcileContainerOperation(context, environment);
    environment = (await context.storage.getEnvironment(environmentId)) ?? environment;
    record = readRecord(environment);
  }
  if (record.operation) {
    throw new ContainerLifecycleError(
      record.operation.status === "needs-attention" ? "needs-attention" : "operation-in-progress",
      record.operation.status === "needs-attention"
        ? "An earlier container operation needs your attention before anything else can change this environment."
        : "Another container operation is still running for this environment.",
    );
  }
  if (options.expectedRevision !== undefined && options.expectedRevision !== record.revision) {
    throw new ContainerLifecycleError(
      "revision-conflict",
      "The environment changed since it was reviewed. Review it again and retry.",
    );
  }

  const now = (options.now ?? new Date()).toISOString();
  const operation: ContainerOperationRecord = {
    operationId: options.operationId ?? createOperationId(),
    kind,
    status: "running",
    phase: options.phase ?? "requested",
    startedAt: now,
    updatedAt: now,
    ...(options.source ? { source: options.source } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
  const next = nextRecord(record);
  next.operation = operation;
  activeOperations.add(activeKey(context, operation.operationId));
  try {
    environment = await persist(context, environmentId, next);
  } catch (error) {
    activeOperations.delete(activeKey(context, operation.operationId));
    throw error;
  }
  return { kind: "begun", operation, environment };
}

export interface OperationPatch {
  phase?: string;
  candidate?: ContainerRuntimeIdentity;
  /** Replaces the committed runtime pointer (`null` clears it). */
  runtime?: ContainerRuntimeIdentity | null;
  details?: ContainerOperationRecord["details"];
  /** Environment fields committed atomically with the record. */
  environment?: Partial<Environment>;
  storage?: EnvironmentContainerLifecycle["storage"];
  /** Readiness observation; `observedAt` is filled in. */
  boot?: Omit<NonNullable<EnvironmentContainerLifecycle["boot"]>, "observedAt">;
}

function applyPatch(
  record: EnvironmentContainerLifecycle,
  operation: ContainerOperationRecord,
  patch: OperationPatch,
  now: string,
): void {
  if (patch.phase) operation.phase = patch.phase;
  if (patch.candidate) operation.candidate = patch.candidate;
  if (patch.details) operation.details = { ...operation.details, ...patch.details };
  operation.updatedAt = now;
  if (patch.runtime === null) {
    delete record.runtime;
  } else if (patch.runtime) {
    record.runtime = patch.runtime;
    record.lastRuntimeGeneration = Math.max(
      record.lastRuntimeGeneration,
      patch.runtime.runtimeGeneration,
    );
  }
  if (patch.storage) record.storage = patch.storage;
  if (patch.boot) {
    record.boot = {
      ...patch.boot,
      // A new boot id replaces the old one; a phase change keeps it.
      ...(patch.boot.bootId || !record.boot?.bootId ? {} : { bootId: record.boot.bootId }),
      observedAt: now,
    };
  }
}

function currentOperation(
  record: EnvironmentContainerLifecycle,
  operationId: string,
): ContainerOperationRecord {
  if (record.operation?.operationId !== operationId) {
    throw new ContainerLifecycleError(
      "operation-unknown",
      "The container operation is no longer current.",
    );
  }
  return { ...record.operation };
}

/** Persists a phase transition before the effect it names. */
export async function advanceContainerOperation(
  context: LifecycleContext,
  environmentId: string,
  operationId: string,
  patch: OperationPatch,
): Promise<Environment> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const record = nextRecord(readRecord(environment));
  const operation = currentOperation(record, operationId);
  applyPatch(record, operation, patch, new Date().toISOString());
  record.operation = operation;
  return persist(context, environmentId, record, patch.environment);
}

function retainOutcome(record: EnvironmentContainerLifecycle, outcome: ContainerOperationOutcome) {
  record.outcomes.push(outcome);
  while (record.outcomes.length > MAX_RECENT_OPERATION_OUTCOMES) {
    const evicted = record.outcomes.shift();
    if (!evicted) break;
    const evictedAt = operationIdTimestampSafe(evicted.operationId);
    if (evictedAt !== null) {
      const current = record.outcomeHorizon ? Date.parse(record.outcomeHorizon) : 0;
      record.outcomeHorizon = new Date(Math.max(current, evictedAt)).toISOString();
    }
  }
}

function operationIdTimestampSafe(operationId: string): number | null {
  const value = operationIdTimestamp(operationId);
  return Number.isFinite(value) ? value : null;
}

/**
 * Settles the current operation. `needs-attention` keeps it current so no new
 * writer is admitted; every other status moves it into the outcome list.
 */
export async function completeContainerOperation(
  context: LifecycleContext,
  environmentId: string,
  operationId: string,
  status: Exclude<ContainerOperationStatus, "running">,
  patch: OperationPatch & { failureCode?: ContainerOperationRecord["failureCode"] } = {},
): Promise<Environment | undefined> {
  try {
    const environment = await context.storage.getEnvironment(environmentId);
    if (!environment) return undefined;
    const record = nextRecord(readRecord(environment));
    const operation = currentOperation(record, operationId);
    const now = new Date().toISOString();
    applyPatch(record, operation, patch, now);
    operation.status = status;
    if (patch.failureCode) operation.failureCode = patch.failureCode;
    if (status === "needs-attention") {
      record.operation = operation;
    } else {
      delete record.operation;
      retainOutcome(record, {
        operationId,
        kind: operation.kind,
        status,
        completedAt: now,
        ...(operation.failureCode ? { failureCode: operation.failureCode } : {}),
      });
    }
    return await persist(context, environmentId, record, patch.environment);
  } finally {
    activeOperations.delete(activeKey(context, operationId));
  }
}

/**
 * Forgets that this process is executing an operation without settling it.
 * Used when the outcome is unknown: the record stays current and the next
 * admission reconciles it by exact Docker identity.
 */
export function releaseActiveContainerOperation(
  context: LifecycleContext,
  operationId: string,
): void {
  activeOperations.delete(activeKey(context, operationId));
}

/** Maps a thrown error onto a content-free failure code. */
export function operationFailureCode(error: unknown): ContainerOperationRecord["failureCode"] {
  if (error instanceof ContainerLifecycleError) return error.code;
  const parsed = parseContainerLifecycleError(error);
  if (parsed) return parsed.code;
  const message = error instanceof Error ? error.message : String(error);
  if (
    /cannot connect to the docker daemon|error during connect|is the docker daemon running/i.test(
      message,
    )
  ) {
    return "daemon-unavailable";
  }
  return "unknown";
}

/**
 * Runs `body` as one durable operation. A body that throws a
 * `needs-attention` error leaves the operation current; any other failure is
 * recorded and rethrown. A repeated request returns the stored outcome.
 */
export async function runContainerOperation<T>(
  context: LifecycleContext,
  environmentId: string,
  kind: ContainerOperationKind,
  identity: ContainerMutationIdentity,
  body: (operation: ContainerOperationRecord) => Promise<T>,
  options: { phase?: string; source?: ContainerRuntimeIdentity } = {},
): Promise<{ replayed: ContainerOperationOutcome } | { result: T }> {
  const admission = await beginContainerOperation(context, environmentId, kind, {
    ...identity,
    ...options,
  });
  if (admission.kind === "replayed") return { replayed: admission.outcome };
  const { operation } = admission;
  let result: T;
  try {
    result = await body(operation);
  } catch (error) {
    const code = operationFailureCode(error);
    const attention = code === "needs-attention";
    await completeContainerOperation(
      context,
      environmentId,
      operation.operationId,
      attention ? "needs-attention" : "failed",
      { failureCode: code },
    ).catch((completionError: unknown) => {
      console.warn(
        "[container-lifecycle] Failed to record operation failure",
        environmentId,
        completionError instanceof Error ? completionError.message : completionError,
      );
    });
    throw error;
  }
  await completeContainerOperation(context, environmentId, operation.operationId, "succeeded");
  return { result };
}

// ---------------------------------------------------------------------------
// Docker identity
// ---------------------------------------------------------------------------

export type ContainerProbe =
  | { kind: "present"; containerId: string; state: string; labels: Record<string, string> }
  | { kind: "missing" }
  | { kind: "unreachable"; message: string }
  | { kind: "malformed" };

/**
 * Docker renders a missing map key as `<no value>`; an empty value is also
 * treated as absent.
 */
function labelValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value && value !== "<no value>" ? value : undefined;
}

/**
 * One bounded inspect answering existence, state and the two labels that
 * decide ownership. The owner/status columns come first so the answer shares
 * its shape with `inspectDockerContainerIdentity`.
 */
export async function probeContainer(containerId: string): Promise<ContainerProbe> {
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      "docker",
      [
        "inspect",
        "-f",
        `{{ index .Config.Labels "${DOCKER_LABEL_OWNER}" }}\t{{.State.Status}}\t{{ index .Config.Labels "${DOCKER_LABEL_APP}" }}\t{{.Id}}`,
        containerId,
      ],
      { timeoutMs: 10_000 },
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such (object|container)/i.test(message)) return { kind: "missing" };
    return { kind: "unreachable", message };
  }
  const line = stdout.trim().split("\n")[0] ?? "";
  if (!line.includes("\t")) return { kind: "malformed" };
  const [owner, state = "", app, id] = line.split("\t");
  const labels: Record<string, string> = {};
  const ownerLabel = labelValue(owner);
  if (ownerLabel) labels[DOCKER_LABEL_OWNER] = ownerLabel;
  const appLabel = labelValue(app);
  // Only the owner and app labels are read. A registry owner label is written
  // exclusively by this app, so it implies the app label when an older
  // two-column answer omits it.
  if (appLabel) labels[DOCKER_LABEL_APP] = appLabel;
  else if (ownerLabel && app === undefined) labels[DOCKER_LABEL_APP] = DOCKER_LABEL_APP_VALUE;
  return {
    kind: "present",
    containerId: labelValue(id) ?? containerId,
    state: state.trim().toLowerCase(),
    labels,
  };
}

export type OperationCandidateSearch =
  | { kind: "none" }
  | { kind: "one"; containerId: string; generation: number | null }
  | { kind: "many"; containerIds: string[] }
  | { kind: "unreachable" };

/**
 * Finds containers created by one operation. Exact label identity only —
 * never a display-name prefix.
 */
export async function findOperationContainers(
  context: Pick<CommandContext, "storage">,
  operationId: string,
): Promise<OperationCandidateSearch> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  let stdout: string;
  try {
    ({ stdout } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--no-trunc",
        "--filter",
        `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
        "--filter",
        `label=${DOCKER_LABEL_OWNER}=${owner}`,
        "--filter",
        `label=${DOCKER_LABEL_OPERATION_ID}=${operationId}`,
        "--format",
        `{{.ID}}\t{{.Label "${DOCKER_LABEL_RUNTIME_GENERATION}"}}`,
      ],
      { timeoutMs: 15_000 },
    ));
  } catch {
    return { kind: "unreachable" };
  }
  const rows = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id = "", generation = ""] = line.split("\t");
      const parsedGeneration = Number.parseInt(generation, 10);
      return {
        id,
        generation: Number.isSafeInteger(parsedGeneration) ? parsedGeneration : null,
      };
    })
    .filter((row) => row.id);
  if (rows.length === 0) return { kind: "none" };
  if (rows.length === 1) {
    return { kind: "one", containerId: rows[0]!.id, generation: rows[0]!.generation };
  }
  return { kind: "many", containerIds: rows.map((row) => row.id) };
}

export type ContainerOwnership =
  | { verdict: "owned"; labelled: boolean }
  | { verdict: "missing" }
  | { verdict: "foreign"; reason: "other-owner" | "not-orkestrator" | "unlabelled-unassigned" }
  | { verdict: "unknown"; reason: "unreachable" | "malformed" };

/** Positive owner-label verdicts: labels are immutable for a container id. */
const ownedByLabel = new Map<string, string>();
const OWNED_CACHE_LIMIT = 2_048;

function referencedByEnvironment(environments: Environment[], containerId: string): boolean {
  return environments.some(
    (environment) =>
      environment.containerId &&
      (environment.containerId === containerId ||
        environment.containerId.startsWith(containerId) ||
        containerId.startsWith(environment.containerId)),
  );
}

/**
 * Decides whether a supplied container id belongs to this registry. A caller
 * supplying an id is not evidence of ownership: the container must carry this
 * app's label and this registry's owner label. A pre-label container is owned
 * only when an environment record already references it (and never under a
 * strict profile, which never adopts unlabelled containers).
 */
export async function resolveContainerOwnership(
  containerId: string,
  context: Pick<CommandContext, "storage"> & Partial<Pick<CommandContext, "strictDockerOwner">>,
  options: { trustExactAssociation?: boolean } = {},
): Promise<ContainerOwnership> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  if (ownedByLabel.get(containerId) === owner) return { verdict: "owned", labelled: true };
  if (options.trustExactAssociation && !context.strictDockerOwner) {
    // The record was written by this registry when it created (or explicitly
    // adopted) the container, so an exact match is the persisted association.
    // Exact only: a caller-supplied prefix could resolve to another container.
    // Embedded command fixtures may supply a partial storage adapter; without
    // a record to consult the labels decide.
    const environments = (await context.storage.loadEnvironments?.().catch(() => [])) ?? [];
    if (environments.some((environment) => environment.containerId === containerId)) {
      return { verdict: "owned", labelled: false };
    }
  }
  const probe = await probeContainer(containerId);
  if (probe.kind === "missing") return { verdict: "missing" };
  if (probe.kind === "unreachable") return { verdict: "unknown", reason: "unreachable" };
  if (probe.kind === "malformed") return { verdict: "unknown", reason: "malformed" };
  if (probe.labels[DOCKER_LABEL_APP] !== DOCKER_LABEL_APP_VALUE) {
    return { verdict: "foreign", reason: "not-orkestrator" };
  }
  const ownerLabel = probe.labels[DOCKER_LABEL_OWNER];
  if (ownerLabel === owner) {
    if (ownedByLabel.size >= OWNED_CACHE_LIMIT) ownedByLabel.clear();
    ownedByLabel.set(containerId, owner);
    return { verdict: "owned", labelled: true };
  }
  if (ownerLabel !== undefined) return { verdict: "foreign", reason: "other-owner" };
  if (context.strictDockerOwner) return { verdict: "foreign", reason: "other-owner" };
  const environments = (await context.storage.loadEnvironments?.().catch(() => [])) ?? [];
  return referencedByEnvironment(environments, containerId) ||
    referencedByEnvironment(environments, probe.containerId)
    ? { verdict: "owned", labelled: false }
    : { verdict: "foreign", reason: "unlabelled-unassigned" };
}

/** Test seam: forget cached ownership verdicts. */
export function resetContainerOwnershipCache(): void {
  ownedByLabel.clear();
}

// ---------------------------------------------------------------------------
// Restart reconciliation
// ---------------------------------------------------------------------------

export type ReconcileResult =
  | "none"
  | "settled"
  | "adopted"
  | "needs-attention"
  | "unreachable"
  | "deletion-owned";

/**
 * Resolves an operation that no live task owns — one left by a backend that
 * exited, or one whose outcome was ambiguous. Exact Docker identities decide
 * the next step; a create/remove is never blindly repeated.
 */
export async function reconcileContainerOperation(
  context: LifecycleContext,
  environment: Environment,
): Promise<ReconcileResult> {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) return "none";
  const operation = parsed.record.operation;
  if (!operation) return "none";
  if (isOperationActive(context, operation.operationId)) return "none";
  if (operation.status === "needs-attention") return "needs-attention";
  // Deletion tombstones stay authoritative: the deletion continuation owns
  // every resource of a deleting environment.
  if (environment.deletionRequestedAt) {
    await completeContainerOperation(
      context,
      environment.id,
      operation.operationId,
      "interrupted",
      {
        failureCode: "interrupted",
      },
    );
    return "deletion-owned";
  }
  activeOperations.add(activeKey(context, operation.operationId));

  if (operation.phase === "creating") {
    const search = await findOperationContainers(context, operation.operationId);
    if (search.kind === "unreachable") {
      activeOperations.delete(activeKey(context, operation.operationId));
      return "unreachable";
    }
    if (search.kind === "many") {
      await completeContainerOperation(
        context,
        environment.id,
        operation.operationId,
        "needs-attention",
        {
          failureCode: "needs-attention",
          details: { candidateCount: search.containerIds.length },
        },
      );
      return "needs-attention";
    }
    if (search.kind === "one") {
      const generation =
        search.generation ??
        (typeof operation.details?.generation === "number" ? operation.details.generation : 0);
      const runtime: ContainerRuntimeIdentity = {
        containerId: search.containerId,
        runtimeGeneration: generation,
        owner: dockerOwnerNamespace(context.storage.getDataDir()),
        createdByOperationId: operation.operationId,
        ...(typeof operation.details?.imageRef === "string"
          ? { imageRef: operation.details.imageRef }
          : {}),
        ...(typeof operation.details?.imageId === "string"
          ? { imageId: operation.details.imageId }
          : {}),
      };
      // Adopt the exact container the interrupted create produced instead of
      // creating a second one. The environment is left stopped; the user's
      // next start runs from here with nothing repeated.
      await completeContainerOperation(
        context,
        environment.id,
        operation.operationId,
        "interrupted",
        {
          failureCode: "interrupted",
          runtime,
          environment:
            !environment.containerId || environment.containerId === search.containerId
              ? { containerId: search.containerId, status: "stopped" }
              : {},
        },
      );
      return "adopted";
    }
  }

  if (operation.phase === "removing" && operation.source) {
    const probe = await probeContainer(operation.source.containerId);
    if (probe.kind === "unreachable" || probe.kind === "malformed") {
      activeOperations.delete(activeKey(context, operation.operationId));
      return "unreachable";
    }
    if (probe.kind === "missing" && environment.containerId === operation.source.containerId) {
      await completeContainerOperation(
        context,
        environment.id,
        operation.operationId,
        "interrupted",
        {
          failureCode: "interrupted",
          runtime: null,
          environment: { containerId: null, status: "stopped" },
        },
      );
      return "settled";
    }
  }

  await completeContainerOperation(context, environment.id, operation.operationId, "interrupted", {
    failureCode: "interrupted",
  });
  return "settled";
}

/**
 * Startup pass: reconcile every unresolved operation before background launch
 * or cleanup can act on its resources. Unreachable Docker leaves operations in
 * place for the next attempt.
 */
export async function reconcileContainerOperations(
  context: LifecycleContext,
): Promise<{ environmentId: string; result: ReconcileResult }[]> {
  const results: { environmentId: string; result: ReconcileResult }[] = [];
  for (const environment of await context.storage.loadEnvironments()) {
    if (!environment.containerLifecycle) continue;
    try {
      const result = await reconcileContainerOperation(context, environment);
      if (result !== "none") results.push({ environmentId: environment.id, result });
    } catch (error) {
      console.warn(
        "[container-lifecycle] Reconciliation failed",
        environment.id,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return results;
}

/** Whether a record's operation (if any) is terminal. Exposed for tests. */
export function isTerminalStatus(status: ContainerOperationStatus): boolean {
  return (TERMINAL_OPERATION_STATUSES as readonly string[]).includes(status);
}

/** Current runtime identity, synthesizing one for a pre-record container. */
export function currentRuntimeIdentity(
  environment: Environment,
  context: Pick<CommandContext, "storage">,
): ContainerRuntimeIdentity | undefined {
  if (!environment.containerId) return undefined;
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  const runtime = parsed.supported ? parsed.record.runtime : undefined;
  if (runtime && runtime.containerId === environment.containerId) return runtime;
  return {
    containerId: environment.containerId,
    runtimeGeneration: parsed.supported ? parsed.record.lastRuntimeGeneration : 0,
    owner: dockerOwnerNamespace(context.storage.getDataDir()),
  };
}

export function nextRuntimeGeneration(environment: Environment): number {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  return (parsed.supported ? parsed.record.lastRuntimeGeneration : 0) + 1;
}

/**
 * Settles a `needs-attention` operation by the user's decision. `adopt`
 * commits one of the operation's own labelled containers as the runtime;
 * `release` records the decision and keeps every candidate untouched.
 */
export async function resolveNeedsAttentionOperation(
  context: LifecycleContext,
  environmentId: string,
  operationId: string,
  resolution: { kind: "adopt"; containerId: string } | { kind: "release" },
): Promise<Environment | undefined> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const record = readRecord(environment);
  if (
    record.operation?.operationId !== operationId ||
    record.operation.status !== "needs-attention"
  ) {
    throw new ContainerLifecycleError(
      "operation-unknown",
      "That operation is not waiting for a decision.",
    );
  }
  activeOperations.add(activeKey(context, operationId));
  if (resolution.kind === "release") {
    return completeContainerOperation(context, environmentId, operationId, "cancelled", {
      details: { resolution: "release" },
    });
  }
  const probe = await probeContainer(resolution.containerId);
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  if (probe.kind !== "present" || probe.labels[DOCKER_LABEL_OWNER] !== owner) {
    activeOperations.delete(activeKey(context, operationId));
    throw new ContainerLifecycleError("not-owned", "That container cannot be adopted.");
  }
  const search = await findOperationContainers(context, operationId);
  const belongs =
    (search.kind === "one" && search.containerId === probe.containerId) ||
    (search.kind === "many" && search.containerIds.includes(probe.containerId));
  if (!belongs) {
    activeOperations.delete(activeKey(context, operationId));
    throw new ContainerLifecycleError(
      "not-owned",
      "That container was not created by this operation.",
    );
  }
  const generation =
    typeof record.operation.details?.generation === "number"
      ? record.operation.details.generation
      : record.lastRuntimeGeneration + 1;
  return completeContainerOperation(context, environmentId, operationId, "interrupted", {
    failureCode: "interrupted",
    details: { resolution: "adopt" },
    runtime: {
      containerId: probe.containerId,
      runtimeGeneration: generation,
      owner,
      createdByOperationId: operationId,
    },
    environment: { containerId: probe.containerId, status: "stopped" },
  });
}

/**
 * Rejects a request bound to a runtime generation that is no longer current.
 * The environment is named by `environmentId`, or found by `containerId`.
 */
export async function assertRuntimeGeneration(
  args: Record<string, unknown>,
  context: Pick<CommandContext, "storage">,
): Promise<void> {
  const expected = args.expectedRuntimeGeneration;
  if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) {
    throw new ContainerLifecycleError(
      "invalid-request",
      "expectedRuntimeGeneration must be a non-negative integer",
    );
  }
  let environment: Environment | null | undefined;
  if (typeof args.environmentId === "string") {
    environment = await context.storage.getEnvironment(args.environmentId);
  } else if (typeof args.containerId === "string") {
    const containerId = args.containerId;
    environment = (await context.storage.loadEnvironments()).find(
      (candidate) => candidate.containerId === containerId,
    );
  }
  const current = environment ? currentRuntimeIdentity(environment, context) : undefined;
  if (!current || current.runtimeGeneration !== expected) {
    throw new ContainerLifecycleError(
      "runtime-changed",
      "This session belongs to a container that has been replaced. Reopen it.",
    );
  }
}
