import { randomBytes } from "node:crypto";

import {
  emptyPreviewReadiness,
  PREVIEW_DEFINITION_SCHEMA_VERSION,
  PREVIEW_LIMITS,
  PREVIEW_SERVICES_CHANGED_EVENT,
  previewError,
  previewFailure,
  stablePreviewJson,
  validatePreviewServiceInput,
  type PreviewEndpointSnapshot,
  type PreviewError,
  type PreviewLimits,
  type PreviewReadiness,
  type PreviewRegistrySnapshot,
  type PreviewServiceDefinition,
  type PreviewServicesChangedEvent,
  type PreviewServiceSnapshot,
  type PreviewServiceTombstone,
  type PreviewTransportKind,
} from "@orkestrator/protocol/preview-services";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";

import type { Environment } from "./models.js";
import type {
  LoadedPreviewServiceStore,
  PreviewMutationRecord,
  PreviewServiceStore,
} from "./storage-preview-services.js";

/** Internal resolved endpoint. Never serialized to clients as-is. */
export interface ResolvedPreviewTarget {
  transportKind: PreviewTransportKind;
  host: "127.0.0.1" | "::1";
  port: number;
  addressFamily: "ipv4" | "ipv6";
  /** Full container id for container targets. */
  containerId: string | null;
  ownership: NonNullable<PreviewEndpointSnapshot["ownership"]>;
  /** Changes whenever the verified binding identity changes. */
  bindingKey: string;
  /** HTTPS upstream verification. */
  tls: { servername: string } | null;
  /** Relay-backed targets connect through the supervisor instead of TCP. */
  relay?: { environmentId: string; containerId: string; port: number };
}

export type PreviewResolution =
  | { ok: true; target: ResolvedPreviewTarget }
  | {
      ok: false;
      error: PreviewError;
      /** Which layers were established before the failure. */
      readiness?: Partial<PreviewReadiness>;
    };

export interface PreviewTargetResolverPort {
  resolve(
    definition: PreviewServiceDefinition,
    environment: Environment,
    options: { signal: AbortSignal },
  ): Promise<PreviewResolution>;
  /** Drop cached inspection for an environment after a lifecycle change. */
  invalidate(environmentId: string, containerId?: string | null): void;
}

export interface PreviewReadinessPort {
  probe(
    definition: PreviewServiceDefinition,
    target: ResolvedPreviewTarget,
    signal: AbortSignal,
  ): Promise<Pick<PreviewReadiness, "tcp" | "tls" | "http">>;
}

export interface PreviewRegistryStorage {
  loadPreviewServiceStore(): Promise<LoadedPreviewServiceStore>;
  mutatePreviewServiceStore<T>(
    mutate: (store: PreviewServiceStore) => { changed: boolean; result: T },
  ): Promise<T>;
  getPreviewBackendIdentity(): Promise<{ instanceId: string }>;
  loadEnvironments(): Promise<Environment[]>;
  getEnvironment(environmentId: string): Promise<Environment | null>;
  addResourceChangeListener(listener: (change: ResourceChange) => void): () => void;
}

export type PreviewRevocationReason =
  | "binding-changed"
  | "environment-lifecycle"
  | "service-removed"
  | "service-updated"
  | "service-disabled"
  | "shutdown";

export interface PreviewRegistryOptions {
  storage: PreviewRegistryStorage;
  emit: (event: string, payload: unknown) => void;
  resolver: PreviewTargetResolverPort;
  readiness?: PreviewReadinessPort;
  limits?: PreviewLimits;
  now?: () => number;
  /** Event coalescing window. Revocations are never lost to coalescing. */
  eventDelayMs?: number;
  /** A verified binding older than this is re-resolved before a new connection. */
  verificationTtlMs?: number;
  /** Readiness retry schedule while a service is starting. */
  probeBackoffMs?: readonly number[];
  logger?: Pick<Console, "warn">;
  /** Owned per-environment transport state (the container relay) ends here too. */
  onEnvironmentTargetChange?: (environmentId: string) => void;
}

interface RuntimeEntry {
  endpoint: PreviewEndpointSnapshot;
  target: ResolvedPreviewTarget | null;
  /** Binding the current generation is bound to; null after revocation. */
  generationBindingKey: string | null;
  verifiedAt: number;
  /** Incremented to invalidate in-flight resolution/probe work. */
  token: number;
  job: Promise<void> | null;
  jobController: AbortController | null;
  probe: Promise<void> | null;
  probeTimer: ReturnType<typeof setTimeout> | null;
  probeAttempt: number;
}

export type PreviewMutationResult =
  | { kind: "definition"; definition: PreviewServiceDefinition; replayed: boolean }
  | { kind: "removed"; serviceId: string; replayed: boolean };

type ServicePatch = Partial<
  Pick<
    PreviewServiceDefinition,
    | "label"
    | "applicationPort"
    | "scheme"
    | "addressFamily"
    | "tlsServerName"
    | "readinessPath"
    | "entry"
    | "enabled"
    | "targetKind"
  >
>;

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;

function newServiceId(): string {
  return `svc_${randomBytes(12).toString("base64url")}`;
}

function lifecycleFingerprint(environment: Environment | null): string {
  if (!environment) return "missing";
  return stablePreviewJson({
    status: environment.status,
    type: environment.environmentType,
    containerId: environment.containerId,
    worktreePath: environment.worktreePath ?? null,
    entryPort: environment.entryPort ?? null,
    mappings: (environment.portMappings ?? []).map((mapping) => [
      mapping.containerPort,
      mapping.hostPort,
      mapping.protocol,
    ]),
    deleting: Boolean(environment.deletionRequestedAt),
  });
}

/** Deterministic generated definitions for an environment's configured ports. */
export function desiredGeneratedDefinitions(environment: Environment): Array<{
  key: string;
  label: string;
  port: number;
  entry: boolean;
  kind: "entry-port" | "port-mapping";
}> {
  if (environment.environmentType !== "containerized") return [];
  const desired: Array<{
    key: string;
    label: string;
    port: number;
    entry: boolean;
    kind: "entry-port" | "port-mapping";
  }> = [];
  const seen = new Set<number>();
  if (environment.entryPort && environment.entryPort > 0) {
    desired.push({
      key: `entry:${environment.entryPort}`,
      label: "app",
      port: environment.entryPort,
      entry: true,
      kind: "entry-port",
    });
    seen.add(environment.entryPort);
  }
  for (const mapping of environment.portMappings ?? []) {
    // UDP publications are not HTTP services; never infer preview capability.
    if (mapping.protocol === "udp" || seen.has(mapping.containerPort)) continue;
    seen.add(mapping.containerPort);
    desired.push({
      key: `mapping:${mapping.containerPort}`,
      label: `port ${mapping.containerPort}`,
      port: mapping.containerPort,
      entry: false,
      kind: "port-mapping",
    });
  }
  return desired;
}

/**
 * Backend-owned registry of preview services.
 *
 * Definitions are durable (StorageService). Runtime entries — endpoint
 * generation, readiness, resolved target — are rebuilt from scratch in every
 * backend epoch and never claim readiness before re-validating their owner.
 * Nothing here depends on a mounted client: an unmounted tab only releases its
 * subscription.
 */
export class PreviewServiceRegistry {
  readonly backendEpoch = `ep_${randomBytes(12).toString("base64url")}`;
  private instanceId: string | null = null;
  private readonly limits: PreviewLimits;
  private readonly now: () => number;
  private readonly definitions = new Map<string, PreviewServiceDefinition>();
  private readonly runtime = new Map<string, RuntimeEntry>();
  private readonly lifecycle = new Map<string, string>();
  private readonly environmentReconciles = new Map<string, Promise<void>>();
  private readonly pendingEnvironmentReconcile = new Set<string>();
  private readonly tombstones: PreviewServiceTombstone[] = [];
  private readonly revocationListeners = new Set<
    (serviceIds: string[], reason: PreviewRevocationReason) => void
  >();
  private invalidDefinitions: LoadedPreviewServiceStore["invalid"] = [];
  private revision = 0;
  private tombstoneFloor = 0;
  private initialized: Promise<void> | null = null;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;
  private pendingEvent: { environmentIds: Set<string>; revoked: Set<string> } | null = null;
  private eventTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly eventDelayMs: number;
  private readonly verificationTtlMs: number;
  private readonly backoff: readonly number[];
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly options: PreviewRegistryOptions) {
    this.limits = options.limits ?? PREVIEW_LIMITS;
    this.now = options.now ?? Date.now;
    this.eventDelayMs = options.eventDelayMs ?? 25;
    this.verificationTtlMs = options.verificationTtlMs ?? 5_000;
    this.backoff = options.probeBackoffMs ?? DEFAULT_BACKOFF_MS;
    this.logger = options.logger ?? console;
  }

  get backendInstanceId(): string {
    if (!this.instanceId)
      throw previewFailure("backend-unavailable", {
        message: "Preview registry is not initialized.",
      });
    return this.instanceId;
  }

  get registryRevision(): number {
    return this.revision;
  }

  init(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    this.instanceId = (await this.options.storage.getPreviewBackendIdentity()).instanceId;
    const loaded = await this.options.storage.loadPreviewServiceStore();
    this.invalidDefinitions = loaded.invalid;
    for (const problem of loaded.invalid) {
      this.logger.warn(`[previews] Ignoring invalid stored service definition: ${problem.reason}`);
    }
    for (const definition of Object.values(loaded.store.definitions)) {
      this.definitions.set(definition.serviceId, definition);
      this.runtime.set(definition.serviceId, this.newRuntime());
    }
    this.unsubscribe = this.options.storage.addResourceChangeListener((change) => {
      if (change.resource !== "environment" || this.disposed) return;
      this.scheduleEnvironmentReconcile(change.id);
    });
    this.revision = 1;
    // Seed and resolve outside init so a slow Docker daemon cannot delay startup.
    const environments = await this.options.storage.loadEnvironments();
    for (const environment of environments) this.scheduleEnvironmentReconcile(environment.id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = null;
    const revoked: string[] = [];
    for (const [serviceId, entry] of this.runtime) {
      entry.token += 1;
      entry.jobController?.abort();
      if (entry.probeTimer) clearTimeout(entry.probeTimer);
      entry.probeTimer = null;
      if (entry.target) revoked.push(serviceId);
    }
    if (revoked.length) this.notifyRevoked(revoked, "shutdown");
    this.revocationListeners.clear();
  }

  onRevoked(listener: (serviceIds: string[], reason: PreviewRevocationReason) => void): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Reads

  snapshot(
    options: { environmentId?: string | null; knownEpoch?: string; knownRevision?: number } = {},
  ): PreviewRegistrySnapshot {
    const environmentId = options.environmentId ?? null;
    const base = {
      backendInstanceId: this.backendInstanceId,
      backendEpoch: this.backendEpoch,
      registryRevision: this.revision,
      environmentId,
      tombstoneFloor: this.tombstoneFloor,
    };
    if (options.knownEpoch === this.backendEpoch && options.knownRevision === this.revision) {
      return { ...base, notModified: true, services: [], tombstones: [] };
    }
    const services: PreviewServiceSnapshot[] = [];
    for (const definition of this.definitions.values()) {
      if (environmentId && definition.environmentId !== environmentId) continue;
      const service = this.serviceSnapshot(definition.serviceId);
      if (service) services.push(service);
    }
    services.sort(
      (a, b) =>
        Number(b.definition.entry) - Number(a.definition.entry) ||
        a.definition.createdAt.localeCompare(b.definition.createdAt) ||
        a.definition.serviceId.localeCompare(b.definition.serviceId),
    );
    const tombstones = this.tombstones.filter(
      (tombstone) => !environmentId || tombstone.environmentId === environmentId,
    );
    const snapshot: PreviewRegistrySnapshot = { ...base, notModified: false, services, tombstones };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > this.limits.snapshotMaxBytes) {
      throw previewFailure("capacity-exceeded", {
        retryable: false,
        message: "The service snapshot exceeds its size bound; request one environment at a time.",
      });
    }
    return snapshot;
  }

  serviceSnapshot(serviceId: string): PreviewServiceSnapshot | null {
    const definition = this.definitions.get(serviceId);
    const entry = this.runtime.get(serviceId);
    if (!definition || !entry) return null;
    return { definition: { ...definition }, endpoint: structuredClone(entry.endpoint) };
  }

  getDefinition(serviceId: string): PreviewServiceDefinition | null {
    const definition = this.definitions.get(serviceId);
    return definition ? { ...definition } : null;
  }

  listDefinitions(environmentId: string): PreviewServiceDefinition[] {
    return Array.from(this.definitions.values())
      .filter((definition) => definition.environmentId === environmentId)
      .map((definition) => ({ ...definition }));
  }

  diagnostics() {
    let available = 0;
    let unavailable = 0;
    let resolving = 0;
    for (const entry of this.runtime.values()) {
      if (entry.endpoint.state === "available") available += 1;
      else if (entry.endpoint.state === "resolving") resolving += 1;
      else unavailable += 1;
    }
    return {
      backendEpoch: this.backendEpoch,
      registryRevision: this.revision,
      definitions: this.definitions.size,
      invalidDefinitions: this.invalidDefinitions.length,
      available,
      unavailable,
      resolving,
      tombstones: this.tombstones.length,
    };
  }

  // -------------------------------------------------------------------------
  // Mutations (compare-and-set, idempotent by operation id)

  async register(
    rawInput: unknown,
    options: { operationId?: string } = {},
  ): Promise<PreviewMutationResult> {
    await this.init();
    const input = validatePreviewServiceInput(rawInput);
    const environment = await this.options.storage.getEnvironment(input.environmentId);
    if (!environment || environment.deletionRequestedAt)
      throw previewFailure("not-found", { message: "Environment not found." });
    this.assertTargetKindFits(input.targetKind, environment);
    const operationId = this.operationId(options.operationId);
    const result = await this.options.storage.mutatePreviewServiceStore((store) => {
      const replay = this.replayOperation(store, operationId, "register");
      if (replay) return { changed: false, result: replay };
      const inEnvironment = Object.values(store.definitions).filter(
        (definition) => definition.environmentId === input.environmentId,
      );
      if (inEnvironment.length >= this.limits.definitionsPerEnvironment) {
        throw previewFailure("capacity-exceeded", {
          retryable: false,
          message: `An environment can register at most ${this.limits.definitionsPerEnvironment} services.`,
        });
      }
      if (Object.keys(store.definitions).length >= this.limits.definitionsPerBackend) {
        throw previewFailure("capacity-exceeded", {
          retryable: false,
          message: "The backend service registry is full.",
        });
      }
      this.assertNoDuplicate(inEnvironment, input, null);
      const timestamp = new Date(this.now()).toISOString();
      const definition: PreviewServiceDefinition = {
        schemaVersion: PREVIEW_DEFINITION_SCHEMA_VERSION,
        serviceId: newServiceId(),
        environmentId: input.environmentId,
        label: input.label,
        targetKind: input.targetKind,
        applicationPort: input.applicationPort,
        scheme: input.scheme,
        addressFamily: input.addressFamily,
        ...(input.tlsServerName ? { tlsServerName: input.tlsServerName } : {}),
        ...(input.readinessPath ? { readinessPath: input.readinessPath } : {}),
        provenance: "user",
        userOverride: false,
        entry: input.entry,
        enabled: input.enabled,
        definitionRevision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      store.definitions[definition.serviceId] = definition;
      if (definition.entry) this.clearOtherEntries(store, definition);
      this.recordOperation(store, operationId, "register", definition);
      return {
        changed: true,
        result: { kind: "definition", definition, replayed: false } as PreviewMutationResult,
      };
    });
    await this.afterCommit(result);
    return result;
  }

  async update(
    serviceId: string,
    expectedRevision: number,
    rawPatch: unknown,
    options: { operationId?: string } = {},
  ): Promise<PreviewMutationResult> {
    await this.init();
    const operationId = this.operationId(options.operationId);
    const current = this.definitions.get(serviceId);
    if (!current) throw previewFailure("not-found");
    const patch = this.validatePatch(current, rawPatch);
    if (patch.targetKind && patch.targetKind !== current.targetKind) {
      const environment = await this.options.storage.getEnvironment(current.environmentId);
      if (!environment) throw previewFailure("not-found", { message: "Environment not found." });
      this.assertTargetKindFits(patch.targetKind, environment);
    }
    const result = await this.options.storage.mutatePreviewServiceStore((store) => {
      const replay = this.replayOperation(store, operationId, "update");
      if (replay) return { changed: false, result: replay };
      const stored = store.definitions[serviceId];
      if (!stored) throw previewFailure("not-found");
      if (stored.definitionRevision !== expectedRevision) {
        throw previewFailure("configuration-conflict", {
          message: `Service changed elsewhere (revision ${stored.definitionRevision}). Refresh and try again.`,
        });
      }
      const next: PreviewServiceDefinition = {
        ...stored,
        ...patch,
        userOverride: stored.provenance !== "user" ? true : stored.userOverride,
        definitionRevision: stored.definitionRevision + 1,
        updatedAt: new Date(this.now()).toISOString(),
      };
      if (next.scheme === "http" || !next.tlsServerName) delete next.tlsServerName;
      if (!next.readinessPath) delete next.readinessPath;
      this.assertNoDuplicate(
        Object.values(store.definitions).filter(
          (definition) => definition.environmentId === next.environmentId,
        ),
        next,
        serviceId,
      );
      store.definitions[serviceId] = next;
      if (next.entry) this.clearOtherEntries(store, next);
      this.recordOperation(store, operationId, "update", next);
      return {
        changed: true,
        result: { kind: "definition", definition: next, replayed: false } as PreviewMutationResult,
      };
    });
    await this.afterCommit(result);
    return result;
  }

  /** Revokes access before deleting. Never stops the application. */
  async remove(
    serviceId: string,
    expectedRevision: number | undefined,
    options: { operationId?: string } = {},
  ): Promise<PreviewMutationResult> {
    await this.init();
    const operationId = this.operationId(options.operationId);
    const current = this.definitions.get(serviceId);
    if (
      current &&
      expectedRevision !== undefined &&
      current.definitionRevision !== expectedRevision
    ) {
      throw previewFailure("configuration-conflict");
    }
    if (current) this.revoke([serviceId], "service-removed");
    const result = await this.options.storage.mutatePreviewServiceStore((store) => {
      const replay = this.replayOperation(store, operationId, "remove");
      if (replay) return { changed: false, result: replay };
      const stored = store.definitions[serviceId];
      if (!stored) throw previewFailure("not-found");
      if (expectedRevision !== undefined && stored.definitionRevision !== expectedRevision) {
        throw previewFailure("configuration-conflict");
      }
      delete store.definitions[serviceId];
      this.recordOperation(store, operationId, "remove", stored);
      return {
        changed: true,
        result: { kind: "removed", serviceId, replayed: false } as PreviewMutationResult,
      };
    });
    if (!result.replayed) this.dropDefinition(serviceId, current?.environmentId ?? "");
    return result;
  }

  private operationId(value: string | undefined): string | null {
    if (value === undefined) return null;
    if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{8,128}$/.test(value)) {
      throw previewFailure("invalid-request", { message: "Invalid operation id." });
    }
    return value;
  }

  private replayOperation(
    store: PreviewServiceStore,
    operationId: string | null,
    kind: PreviewMutationRecord["kind"],
  ): PreviewMutationResult | null {
    if (!operationId) return null;
    const record = store.operations.find((operation) => operation.operationId === operationId);
    if (!record) return null;
    if (record.kind !== kind) {
      throw previewFailure("configuration-conflict", {
        message: "Operation id was used for a different change.",
      });
    }
    if (kind === "remove") return { kind: "removed", serviceId: record.serviceId, replayed: true };
    const definition = store.definitions[record.serviceId];
    if (!definition) throw previewFailure("not-found");
    return { kind: "definition", definition, replayed: true };
  }

  private recordOperation(
    store: PreviewServiceStore,
    operationId: string | null,
    kind: PreviewMutationRecord["kind"],
    definition: PreviewServiceDefinition,
  ): void {
    if (!operationId) return;
    store.operations.push({
      operationId,
      kind,
      serviceId: definition.serviceId,
      definitionRevision: definition.definitionRevision,
      committedAt: new Date(this.now()).toISOString(),
    });
    const retention = this.limits.mutationOperationRetention;
    if (store.operations.length > retention)
      store.operations.splice(0, store.operations.length - retention);
  }

  private validatePatch(current: PreviewServiceDefinition, rawPatch: unknown): ServicePatch {
    if (!rawPatch || typeof rawPatch !== "object" || Array.isArray(rawPatch)) {
      throw previewFailure("invalid-request", { message: "Patch must be an object." });
    }
    const merged = validatePreviewServiceInput({
      environmentId: current.environmentId,
      label: current.label,
      targetKind: current.targetKind,
      applicationPort: current.applicationPort,
      scheme: current.scheme,
      addressFamily: current.addressFamily,
      tlsServerName: current.tlsServerName,
      readinessPath: current.readinessPath,
      entry: current.entry,
      enabled: current.enabled,
      ...(rawPatch as Record<string, unknown>),
    });
    const patch: ServicePatch = {};
    const allowed = [
      "label",
      "applicationPort",
      "scheme",
      "addressFamily",
      "tlsServerName",
      "readinessPath",
      "entry",
      "enabled",
      "targetKind",
    ] as const;
    for (const key of allowed) {
      if (key in (rawPatch as object)) (patch as Record<string, unknown>)[key] = merged[key];
    }
    if (
      "environmentId" in (rawPatch as object) &&
      (rawPatch as { environmentId: unknown }).environmentId !== current.environmentId
    ) {
      throw previewFailure("invalid-request", {
        message: "A service cannot move to another environment.",
      });
    }
    return patch;
  }

  private assertTargetKindFits(
    kind: PreviewServiceDefinition["targetKind"],
    environment: Environment,
  ): void {
    if (kind === "container" && environment.environmentType !== "containerized") {
      throw previewFailure("invalid-request", {
        message: "Container services require a containerized environment.",
      });
    }
    if (kind === "worktree" && environment.environmentType !== "local") {
      throw previewFailure("invalid-request", {
        message: "Worktree services require a local environment.",
      });
    }
  }

  private assertNoDuplicate(
    peers: PreviewServiceDefinition[],
    candidate: Pick<PreviewServiceDefinition, "targetKind" | "applicationPort" | "scheme">,
    ignoreServiceId: string | null,
  ): void {
    const duplicate = peers.find(
      (peer) =>
        peer.serviceId !== ignoreServiceId &&
        peer.targetKind === candidate.targetKind &&
        peer.applicationPort === candidate.applicationPort &&
        peer.scheme === candidate.scheme,
    );
    if (duplicate) {
      throw previewFailure("configuration-conflict", {
        message: `“${duplicate.label}” already targets ${candidate.scheme} port ${candidate.applicationPort}.`,
      });
    }
  }

  private clearOtherEntries(store: PreviewServiceStore, entry: PreviewServiceDefinition): void {
    for (const definition of Object.values(store.definitions)) {
      if (
        definition.environmentId !== entry.environmentId ||
        definition.serviceId === entry.serviceId ||
        !definition.entry
      ) {
        continue;
      }
      store.definitions[definition.serviceId] = {
        ...definition,
        entry: false,
        definitionRevision: definition.definitionRevision + 1,
        updatedAt: entry.updatedAt,
      };
    }
  }

  private async afterCommit(result: PreviewMutationResult): Promise<void> {
    if (result.kind !== "definition" || result.replayed) return;
    await this.reloadDefinitions();
  }

  /** Pull committed definitions into memory, revoking anything whose target changed. */
  private async reloadDefinitions(): Promise<void> {
    const { store } = await this.options.storage.loadPreviewServiceStore();
    const touched = new Set<string>();
    for (const definition of Object.values(store.definitions)) {
      const previous = this.definitions.get(definition.serviceId);
      if (previous && previous.definitionRevision === definition.definitionRevision) continue;
      this.definitions.set(definition.serviceId, definition);
      touched.add(definition.environmentId);
      if (!this.runtime.has(definition.serviceId))
        this.runtime.set(definition.serviceId, this.newRuntime());
      if (previous) {
        const targetChanged =
          previous.applicationPort !== definition.applicationPort ||
          previous.scheme !== definition.scheme ||
          previous.targetKind !== definition.targetKind ||
          previous.addressFamily !== definition.addressFamily ||
          previous.tlsServerName !== definition.tlsServerName;
        if (targetChanged) this.revoke([definition.serviceId], "service-updated");
        else if (previous.enabled && !definition.enabled)
          this.revoke([definition.serviceId], "service-disabled");
      }
      this.markChanged(definition.environmentId);
      this.requestResolve(definition.serviceId);
    }
    for (const serviceId of Array.from(this.definitions.keys())) {
      if (!store.definitions[serviceId])
        this.dropDefinition(serviceId, this.definitions.get(serviceId)!.environmentId);
    }
  }

  private dropDefinition(serviceId: string, environmentId: string): void {
    const definition = this.definitions.get(serviceId);
    if (!definition) return;
    if (this.runtime.get(serviceId)?.endpoint.state !== "revoked")
      this.revoke([serviceId], "service-removed");
    const entry = this.runtime.get(serviceId);
    if (entry) {
      entry.token += 1;
      entry.jobController?.abort();
      if (entry.probeTimer) clearTimeout(entry.probeTimer);
    }
    this.definitions.delete(serviceId);
    this.runtime.delete(serviceId);
    this.revision += 1;
    this.tombstones.push({
      serviceId,
      environmentId: environmentId || definition.environmentId,
      registryRevision: this.revision,
    });
    while (this.tombstones.length > this.limits.tombstoneRetention) {
      const dropped = this.tombstones.shift();
      if (dropped) this.tombstoneFloor = dropped.registryRevision;
    }
    this.queueEvent(definition.environmentId, serviceId);
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  /**
   * Called before a lifecycle operation removes or replaces an environment's
   * target (stop, recreate, delete). Revokes transport access first so a
   * reused host port can never inherit the old authorization.
   */
  beforeEnvironmentTargetChange(environmentId: string): void {
    const affected = this.listDefinitions(environmentId).map((definition) => definition.serviceId);
    this.options.resolver.invalidate(environmentId);
    if (affected.length) this.revoke(affected, "environment-lifecycle");
    this.options.onEnvironmentTargetChange?.(environmentId);
  }

  private scheduleEnvironmentReconcile(environmentId: string): void {
    if (this.environmentReconciles.has(environmentId)) {
      this.pendingEnvironmentReconcile.add(environmentId);
      return;
    }
    const run = this.reconcileEnvironment(environmentId)
      .catch((error: unknown) => {
        this.logger.warn(
          `[previews] Environment reconciliation failed: ${error instanceof Error ? error.message : "error"}`,
        );
      })
      .finally(() => {
        this.environmentReconciles.delete(environmentId);
        if (this.pendingEnvironmentReconcile.delete(environmentId) && !this.disposed) {
          this.scheduleEnvironmentReconcile(environmentId);
        }
      });
    this.environmentReconciles.set(environmentId, run);
  }

  /** Test/diagnostic hook: wait for queued environment reconciliation. */
  async settle(): Promise<void> {
    while (this.environmentReconciles.size) {
      await Promise.all(Array.from(this.environmentReconciles.values()));
    }
    const jobs = Array.from(this.runtime.values()).flatMap((entry) =>
      [entry.job, entry.probe].filter(Boolean),
    );
    await Promise.all(jobs);
  }

  private async reconcileEnvironment(environmentId: string): Promise<void> {
    if (this.disposed) return;
    const environment = await this.options.storage.getEnvironment(environmentId);
    const fingerprint = lifecycleFingerprint(environment);
    const previous = this.lifecycle.get(environmentId);
    if (previous === fingerprint) return;
    this.lifecycle.set(environmentId, fingerprint);
    this.options.resolver.invalidate(environmentId);
    const services = this.listDefinitions(environmentId);

    if (!environment) {
      this.lifecycle.delete(environmentId);
      if (services.length) await this.removeEnvironmentDefinitions(environmentId);
      return;
    }
    const previousState = previous
      ? (JSON.parse(previous) as { status?: string; containerId?: string | null })
      : null;
    const targetReplaced =
      previousState !== null &&
      (previousState.status !== environment.status ||
        previousState.containerId !== environment.containerId);
    if (targetReplaced && services.length) {
      this.revoke(
        services.map((service) => service.serviceId),
        "environment-lifecycle",
      );
    }
    await this.seedEnvironment(environment);
    for (const definition of this.listDefinitions(environmentId)) {
      this.requestResolve(definition.serviceId, {
        probe: environment.status === "running",
        restartBackoff: true,
      });
    }
  }

  private async removeEnvironmentDefinitions(environmentId: string): Promise<void> {
    const removed = await this.options.storage.mutatePreviewServiceStore((store) => {
      const ids = Object.values(store.definitions)
        .filter((definition) => definition.environmentId === environmentId)
        .map((definition) => definition.serviceId);
      for (const id of ids) delete store.definitions[id];
      return { changed: ids.length > 0, result: ids };
    });
    for (const serviceId of removed) this.dropDefinition(serviceId, environmentId);
    for (const definition of this.listDefinitions(environmentId))
      this.dropDefinition(definition.serviceId, environmentId);
  }

  /** Create/update/remove generated definitions; user overrides are left alone. */
  private async seedEnvironment(environment: Environment): Promise<void> {
    if (environment.deletionRequestedAt) return;
    const desired = desiredGeneratedDefinitions(environment);
    const changed = await this.options.storage.mutatePreviewServiceStore((store) => {
      let dirty = false;
      const peers = Object.values(store.definitions).filter(
        (definition) => definition.environmentId === environment.id,
      );
      const generated = new Map(
        peers
          .filter((definition) => definition.provenanceKey)
          .map((definition) => [definition.provenanceKey!, definition]),
      );
      const timestamp = new Date(this.now()).toISOString();
      for (const want of desired) {
        const existing = generated.get(want.key);
        if (existing) {
          generated.delete(want.key);
          continue;
        }
        const userDuplicate = peers.some(
          (peer) =>
            peer.targetKind === "container" &&
            peer.applicationPort === want.port &&
            peer.scheme === "http",
        );
        if (userDuplicate) continue;
        if (peers.length >= this.limits.definitionsPerEnvironment) break;
        if (Object.keys(store.definitions).length >= this.limits.definitionsPerBackend) break;
        const hasEntry = peers.some((peer) => peer.entry);
        const definition: PreviewServiceDefinition = {
          schemaVersion: PREVIEW_DEFINITION_SCHEMA_VERSION,
          serviceId: newServiceId(),
          environmentId: environment.id,
          label: want.label,
          targetKind: "container",
          applicationPort: want.port,
          scheme: "http",
          addressFamily: "auto",
          provenance: want.kind,
          provenanceKey: want.key,
          userOverride: false,
          entry: want.entry && !hasEntry,
          enabled: true,
          definitionRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        store.definitions[definition.serviceId] = definition;
        peers.push(definition);
        dirty = true;
      }
      // Generated definitions whose source mapping disappeared. A user override
      // is kept so the user's configuration is not silently lost; it reports
      // `target-unmapped` until the mapping returns or the user removes it.
      for (const stale of generated.values()) {
        if (stale.userOverride) continue;
        delete store.definitions[stale.serviceId];
        dirty = true;
      }
      return { changed: dirty, result: dirty };
    });
    if (changed) await this.reloadDefinitions();
  }

  // -------------------------------------------------------------------------
  // Resolution and readiness

  private newRuntime(): RuntimeEntry {
    return {
      endpoint: {
        backendEpoch: this.backendEpoch,
        endpointGeneration: 1,
        state: "unresolved",
        transportKind: null,
        addressFamily: null,
        hostPort: null,
        containerId: null,
        ownership: null,
        readiness: emptyPreviewReadiness(),
        failure: null,
      },
      target: null,
      generationBindingKey: null,
      verifiedAt: 0,
      token: 0,
      job: null,
      jobController: null,
      probe: null,
      probeTimer: null,
      probeAttempt: 0,
    };
  }

  /** Resolve (coalesced) and optionally probe. Returns the resulting snapshot. */
  async refresh(
    serviceId: string,
    options: { probe?: boolean } = {},
  ): Promise<PreviewServiceSnapshot> {
    await this.init();
    if (!this.definitions.has(serviceId)) throw previewFailure("not-found");
    await this.resolveNow(serviceId);
    if (options.probe) await this.probeNow(serviceId);
    const snapshot = this.serviceSnapshot(serviceId);
    if (!snapshot) throw previewFailure("not-found");
    return snapshot;
  }

  private requestResolve(
    serviceId: string,
    options: { probe?: boolean; restartBackoff?: boolean } = {},
  ): void {
    const entry = this.runtime.get(serviceId);
    if (!entry) return;
    if (options.restartBackoff) entry.probeAttempt = 0;
    void this.resolveNow(serviceId)
      .then(() => {
        if (options.probe) this.scheduleProbe(serviceId, 0);
      })
      .catch(() => undefined);
  }

  private resolveNow(serviceId: string): Promise<void> {
    const entry = this.runtime.get(serviceId);
    if (!entry) return Promise.resolve();
    if (entry.job) return entry.job;
    const definition = this.definitions.get(serviceId);
    if (!definition) return Promise.resolve();
    const token = entry.token;
    const controller = new AbortController();
    entry.jobController = controller;
    this.setEndpoint(serviceId, { state: entry.target ? entry.endpoint.state : "resolving" });
    const job = (async () => {
      const environment = await this.options.storage.getEnvironment(definition.environmentId);
      let resolution: PreviewResolution;
      if (!environment || environment.deletionRequestedAt) {
        resolution = {
          ok: false,
          error: previewError("not-found", { message: "Environment not found." }),
          readiness: { environment: { state: "failed", lifecycle: "missing" } },
        };
      } else if (!definition.enabled) {
        resolution = {
          ok: false,
          error: previewError("forbidden", { message: "This service is disabled." }),
        };
      } else {
        try {
          resolution = await this.options.resolver.resolve(definition, environment, {
            signal: controller.signal,
          });
        } catch (error) {
          resolution = {
            ok: false,
            error: previewError("internal", { message: "Service resolution failed." }),
          };
          this.logger.warn(
            `[previews] Resolver failed: ${error instanceof Error ? error.name : "error"}`,
          );
        }
      }
      this.commitResolution(
        serviceId,
        token,
        definition.definitionRevision,
        resolution,
        environment,
      );
    })().finally(() => {
      if (entry.job === job) {
        entry.job = null;
        entry.jobController = null;
      }
    });
    entry.job = job;
    return job;
  }

  private commitResolution(
    serviceId: string,
    token: number,
    definitionRevision: number,
    resolution: PreviewResolution,
    environment: Environment | null,
  ): void {
    const entry = this.runtime.get(serviceId);
    const definition = this.definitions.get(serviceId);
    // Stale: the service was revoked, removed, edited, or the registry disposed.
    if (
      this.disposed ||
      !entry ||
      !definition ||
      entry.token !== token ||
      definition.definitionRevision !== definitionRevision
    ) {
      return;
    }
    entry.verifiedAt = this.now();
    const lifecycle: PreviewReadiness["environment"]["lifecycle"] = !environment
      ? "missing"
      : environment.status === "running"
        ? "running"
        : environment.status === "stopped"
          ? "stopped"
          : "other";
    if (resolution.ok) {
      const target = resolution.target;
      const rebound =
        entry.generationBindingKey !== null && entry.generationBindingKey !== target.bindingKey;
      const sameBinding = !rebound && entry.endpoint.hostPort === target.port;
      const generation = entry.endpoint.endpointGeneration + (rebound ? 1 : 0);
      entry.generationBindingKey = target.bindingKey;
      entry.target = target;
      if (rebound) {
        // Commit the new generation before notifying: revocation keeps
        // attachments whose generation is still current.
        this.setEndpoint(serviceId, { endpointGeneration: generation });
        this.notifyRevoked([serviceId], "binding-changed");
        this.queueEvent(definition.environmentId, serviceId);
      }
      this.setEndpoint(serviceId, {
        state: "available",
        endpointGeneration: generation,
        transportKind: target.transportKind,
        addressFamily: target.addressFamily,
        hostPort: target.port,
        containerId: target.containerId ? target.containerId.slice(0, 12) : null,
        ownership: target.ownership,
        failure: null,
        readiness: {
          ...(sameBinding ? entry.endpoint.readiness : emptyPreviewReadiness()),
          environment: { state: "ok", lifecycle },
          binding: { state: "ok" },
          tls:
            definition.scheme === "https"
              ? sameBinding
                ? entry.endpoint.readiness.tls
                : { state: "unknown" }
              : { state: "skipped" },
          http: definition.readinessPath
            ? sameBinding
              ? entry.endpoint.readiness.http
              : { state: "unknown" }
            : { state: "skipped" },
        },
      });
      return;
    }
    if (entry.target) {
      entry.target = null;
      entry.generationBindingKey = null;
      this.setEndpoint(serviceId, { endpointGeneration: entry.endpoint.endpointGeneration + 1 });
      this.notifyRevoked([serviceId], "binding-changed");
      this.queueEvent(definition.environmentId, serviceId);
    }
    const failed = resolution.error;
    this.setEndpoint(serviceId, {
      state: "unavailable",
      transportKind: null,
      addressFamily: null,
      hostPort: null,
      containerId: null,
      ownership: null,
      failure: failed,
      readiness: {
        ...emptyPreviewReadiness(),
        environment: {
          state: lifecycle === "running" ? "ok" : "failed",
          lifecycle,
          ...(lifecycle === "running" ? {} : { failure: "environment-stopped" as const }),
        },
        binding:
          failed.layer === "binding"
            ? { state: "failed", failure: failed.category }
            : { state: lifecycle === "running" ? "unknown" : "skipped" },
        ...resolution.readiness,
        observedAt: new Date(this.now()).toISOString(),
      },
    });
  }

  private scheduleProbe(serviceId: string, delayMs: number): void {
    const entry = this.runtime.get(serviceId);
    if (!entry || this.disposed || !this.options.readiness) return;
    if (entry.probeTimer) clearTimeout(entry.probeTimer);
    entry.probeTimer = setTimeout(() => {
      entry.probeTimer = null;
      void this.probeNow(serviceId)
        .then(() => {
          const current = this.runtime.get(serviceId);
          if (!current || current !== entry) return;
          const tcp = current.endpoint.readiness.tcp.state;
          // Back off only while the target exists but is not yet listening.
          if (
            current.endpoint.state === "available" &&
            tcp === "failed" &&
            current.probeAttempt < this.backoff.length
          ) {
            const wait = this.backoff[current.probeAttempt]!;
            current.probeAttempt += 1;
            this.scheduleProbe(serviceId, wait);
          }
        })
        .catch(() => undefined);
    }, delayMs);
    entry.probeTimer.unref?.();
  }

  private probeNow(serviceId: string): Promise<void> {
    const entry = this.runtime.get(serviceId);
    const readiness = this.options.readiness;
    if (!entry || !readiness) return Promise.resolve();
    if (entry.probe) return entry.probe;
    const definition = this.definitions.get(serviceId);
    const target = entry.target;
    if (!definition || !target) return Promise.resolve();
    const token = entry.token;
    const generation = entry.endpoint.endpointGeneration;
    const controller = new AbortController();
    this.setEndpoint(serviceId, {
      readiness: { ...entry.endpoint.readiness, tcp: { state: "pending" } },
    });
    const probe = readiness
      .probe(definition, target, controller.signal)
      .then((layers) => {
        const current = this.runtime.get(serviceId);
        if (
          !current ||
          current.token !== token ||
          current.endpoint.endpointGeneration !== generation
        )
          return;
        this.setEndpoint(serviceId, {
          readiness: {
            ...current.endpoint.readiness,
            ...layers,
            observedAt: new Date(this.now()).toISOString(),
          },
        });
      })
      .catch(() => undefined)
      .finally(() => {
        if (entry.probe === probe) entry.probe = null;
      });
    entry.probe = probe;
    return probe;
  }

  /**
   * Target for a new upstream connection. Rejects a stale generation and
   * re-verifies a binding older than the verification TTL, so a reused host
   * port cannot be reached with an old attachment.
   */
  async acquireTarget(serviceId: string, generation: number): Promise<ResolvedPreviewTarget> {
    const check = () => {
      const entry = this.runtime.get(serviceId);
      const definition = this.definitions.get(serviceId);
      if (!entry || !definition) throw previewFailure("not-found");
      if (!definition.enabled)
        throw previewFailure("forbidden", { message: "This service is disabled." });
      if (entry.endpoint.endpointGeneration !== generation)
        throw previewFailure("generation-changed");
      return entry;
    };
    let entry = check();
    if (!entry.target || this.now() - entry.verifiedAt > this.verificationTtlMs) {
      await this.resolveNow(serviceId);
      entry = check();
    }
    if (!entry.target || entry.endpoint.state !== "available") {
      throw previewFailure(entry.endpoint.failure?.category ?? "target-unmapped");
    }
    return entry.target;
  }

  /** Current generation for a service that is available right now. */
  currentGeneration(serviceId: string): number | null {
    const entry = this.runtime.get(serviceId);
    return entry?.endpoint.state === "available" ? entry.endpoint.endpointGeneration : null;
  }

  isCurrentGeneration(serviceId: string, generation: number): boolean {
    return this.runtime.get(serviceId)?.endpoint.endpointGeneration === generation;
  }

  // -------------------------------------------------------------------------
  // Revocation and events

  private revoke(serviceIds: string[], reason: PreviewRevocationReason): void {
    const revoked: string[] = [];
    for (const serviceId of serviceIds) {
      const entry = this.runtime.get(serviceId);
      const definition = this.definitions.get(serviceId);
      if (!entry || !definition) continue;
      entry.token += 1;
      entry.jobController?.abort();
      entry.job = null;
      entry.probe = null;
      if (entry.probeTimer) clearTimeout(entry.probeTimer);
      entry.probeTimer = null;
      entry.target = null;
      entry.generationBindingKey = null;
      entry.verifiedAt = 0;
      this.setEndpoint(serviceId, {
        state: "revoked",
        endpointGeneration: entry.endpoint.endpointGeneration + 1,
        transportKind: null,
        addressFamily: null,
        hostPort: null,
        containerId: null,
        ownership: null,
        readiness: emptyPreviewReadiness(),
      });
      this.queueEvent(definition.environmentId, serviceId);
      revoked.push(serviceId);
    }
    if (revoked.length) this.notifyRevoked(revoked, reason);
  }

  private notifyRevoked(serviceIds: string[], reason: PreviewRevocationReason): void {
    for (const listener of Array.from(this.revocationListeners)) {
      try {
        listener(serviceIds, reason);
      } catch (error) {
        this.logger.warn(
          `[previews] Revocation listener failed: ${error instanceof Error ? error.name : "error"}`,
        );
      }
    }
  }

  private setEndpoint(serviceId: string, patch: Partial<PreviewEndpointSnapshot>): void {
    const entry = this.runtime.get(serviceId);
    const definition = this.definitions.get(serviceId);
    if (!entry || !definition) return;
    const next = { ...entry.endpoint, ...patch, backendEpoch: this.backendEpoch };
    if (stablePreviewJson(next) === stablePreviewJson(entry.endpoint)) return;
    entry.endpoint = next;
    this.markChanged(definition.environmentId);
  }

  private markChanged(environmentId: string): void {
    this.revision += 1;
    this.queueEvent(environmentId);
  }

  private queueEvent(environmentId: string, revokedServiceId?: string): void {
    if (this.disposed) return;
    this.pendingEvent ??= { environmentIds: new Set(), revoked: new Set() };
    this.pendingEvent.environmentIds.add(environmentId);
    if (revokedServiceId) this.pendingEvent.revoked.add(revokedServiceId);
    if (this.eventTimer) return;
    this.eventTimer = setTimeout(() => this.flushEvent(), this.eventDelayMs);
    this.eventTimer.unref?.();
  }

  flushEvent(): void {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = null;
    const pending = this.pendingEvent;
    this.pendingEvent = null;
    if (!pending || this.disposed || !this.instanceId) return;
    const payload: PreviewServicesChangedEvent = {
      backendInstanceId: this.instanceId,
      backendEpoch: this.backendEpoch,
      registryRevision: this.revision,
      environmentIds: Array.from(pending.environmentIds).slice(0, 256),
      revokedServiceIds: Array.from(pending.revoked).slice(0, 1_024),
    };
    try {
      this.options.emit(PREVIEW_SERVICES_CHANGED_EVENT, payload);
    } catch (error) {
      this.logger.warn(
        `[previews] Failed to emit change event: ${error instanceof Error ? error.name : "error"}`,
      );
    }
  }
}
