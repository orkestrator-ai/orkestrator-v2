import { randomUUID } from "node:crypto";
import {
  CANCELLABLE_HOST_UPDATE_JOB_STATES,
  HOST_MAINTENANCE_EVENT,
  HOST_MAINTENANCE_LIMITS,
  HOST_TASK_KINDS,
  HOST_UPDATE_IDLE_WAIT,
  HOST_UPDATE_JOB_STATES,
  hostUpdateChannelOfVersion,
  isActiveHostUpdateJob,
  isHostUpdateChannel,
  isHostVersion,
  type HostImageStatus,
  type HostMaintenanceSnapshot,
  type HostReleasePins,
  type HostRestartImpact,
  type HostTask,
  type HostTaskKind,
  type HostToolStatus,
  type HostUpdateChannel,
  type HostUpdateDrain,
  type HostUpdateJob,
  type HostUpdateJobState,
  type HostUpdaterKind,
  type HostUpdaterReport,
  type HostUpdaterReportedJobState,
} from "@orkestrator/protocol/host-maintenance";
import type { BackendEmit } from "./commands-context.js";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

/** The backend database store holding the update job, tasks and the last check. */
export const HOST_MAINTENANCE_STORE = "host-maintenance";
const MAX_RETAINED_OUTCOMES = 1024;

export type HostMaintenanceErrorCode = "unsupported" | "busy" | "invalid-input" | "not-found";

export class HostMaintenanceError extends Error {
  constructor(
    readonly code: HostMaintenanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostMaintenanceError";
  }
}

interface LastCheck {
  latestVersion: string | null;
  updateAvailable: boolean | null;
  checkedAt: string;
  error: string | null;
  /** The version that was running when the check ran. */
  forVersion: string;
}

interface HostMaintenanceDocument {
  version: 1;
  revision: number;
  job: HostUpdateJob | null;
  checkRequest: { id: string; requestedAt: string } | null;
  lastCheck: LastCheck | null;
  tasks: Partial<Record<HostTaskKind, HostTask>>;
  nextRelease: HostReleasePins | null;
  ghChannel: "pinned" | "latest";
  /** Null until {@link HostMaintenanceService.init} records the running version's channel. */
  updateChannel: HostUpdateChannel | null;
  /** Public outcomes pinned until their receipts durably settle; admission is bounded. */
  retained: Record<string, HostTask | HostUpdateJob>;
}

/** Which reported states may follow which; anything else is ignored. */
const REPORTED_TRANSITIONS: Record<HostUpdateJobState, readonly HostUpdaterReportedJobState[]> = {
  requested: ["downloading", "waiting-for-idle", "awaiting-restart", "failed"],
  downloading: ["downloading", "waiting-for-idle", "awaiting-restart", "failed"],
  "waiting-for-idle": ["awaiting-restart", "failed"],
  "awaiting-restart": ["restarting", "postponed", "failed"],
  restarting: ["failed"],
  succeeded: [],
  failed: [],
  postponed: [],
  cancelled: [],
};

const UNSUPPORTED_REASON =
  "This backend is not run by an Orkestrator app that can update itself. Update Orkestrator on the host itself.";
const EXECUTOR_PENDING_REASON =
  "The Orkestrator app on the host has not started its updater yet; try again shortly.";

/** Live readings a detailed status adds; supplied by the backend that owns this service. */
export interface HostMaintenanceReaders {
  impact?: () => Promise<HostRestartImpact>;
  tools?: () => Promise<HostToolStatus[]>;
  image?: () => Promise<HostImageStatus | null>;
}

/** Evidence the standalone launcher leaves when it rolled a release back. */
export interface HostRollbackEvidence {
  failedVersion: string;
  restoredVersion: string;
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeJob(value: unknown): HostUpdateJob | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  if (!HOST_UPDATE_JOB_STATES.includes(value.state as HostUpdateJobState)) return null;
  if (typeof value.fromVersion !== "string" || typeof value.requestedAt !== "string") return null;
  return {
    id: value.id,
    state: value.state as HostUpdateJobState,
    fromVersion: value.fromVersion,
    requestedVersion: stringOrNull(value.requestedVersion),
    targetVersion: stringOrNull(value.targetVersion),
    drain: value.drain === "when-idle" ? "when-idle" : "now",
    idleDeadline: stringOrNull(value.idleDeadline),
    progressPercent: typeof value.progressPercent === "number" ? value.progressPercent : null,
    restartAt: stringOrNull(value.restartAt),
    error: stringOrNull(value.error),
    requestedAt: value.requestedAt,
    updatedAt: stringOrNull(value.updatedAt) ?? value.requestedAt,
    completedAt: stringOrNull(value.completedAt),
  };
}

function normalizeTask(kind: HostTaskKind, value: unknown): HostTask | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.startedAt !== "string") {
    return null;
  }
  if (value.state !== "running" && value.state !== "succeeded" && value.state !== "failed") {
    return null;
  }
  return {
    id: value.id,
    kind,
    state: value.state,
    stage: stringOrNull(value.stage),
    error: stringOrNull(value.error),
    result: isRecord(value.result) ? value.result : null,
    startedAt: value.startedAt,
    updatedAt: stringOrNull(value.updatedAt) ?? value.startedAt,
    completedAt: stringOrNull(value.completedAt),
  };
}

function normalizeDocument(value: unknown): HostMaintenanceDocument {
  const empty: HostMaintenanceDocument = {
    version: 1,
    revision: 0,
    job: null,
    checkRequest: null,
    lastCheck: null,
    tasks: {},
    nextRelease: null,
    ghChannel: "pinned",
    updateChannel: null,
    retained: {},
  };
  if (!isRecord(value) || value.version !== 1) return empty;
  if (isRecord(value.retained) && Object.keys(value.retained).length > MAX_RETAINED_OUTCOMES) {
    throw new Error("Maintenance outcome store exceeds capacity; refusing to discard evidence");
  }
  const checkRequest =
    isRecord(value.checkRequest) &&
    typeof value.checkRequest.id === "string" &&
    typeof value.checkRequest.requestedAt === "string"
      ? { id: value.checkRequest.id, requestedAt: value.checkRequest.requestedAt }
      : null;
  const lastCheck =
    isRecord(value.lastCheck) &&
    typeof value.lastCheck.checkedAt === "string" &&
    typeof value.lastCheck.forVersion === "string"
      ? {
          latestVersion: stringOrNull(value.lastCheck.latestVersion),
          updateAvailable:
            typeof value.lastCheck.updateAvailable === "boolean"
              ? value.lastCheck.updateAvailable
              : null,
          checkedAt: value.lastCheck.checkedAt,
          error: stringOrNull(value.lastCheck.error),
          forVersion: value.lastCheck.forVersion,
        }
      : null;
  const tasks: HostMaintenanceDocument["tasks"] = {};
  if (isRecord(value.tasks)) {
    for (const kind of HOST_TASK_KINDS) {
      const task = normalizeTask(kind, value.tasks[kind]);
      if (task) tasks[kind] = task;
    }
  }
  const nextRelease =
    isRecord(value.nextRelease) &&
    isHostVersion(value.nextRelease.version) &&
    isRecord(value.nextRelease.tools)
      ? {
          version: value.nextRelease.version,
          tools: Object.fromEntries(
            Object.entries(value.nextRelease.tools).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          ),
        }
      : null;
  return {
    version: 1,
    revision: typeof value.revision === "number" ? value.revision : 0,
    job: normalizeJob(value.job),
    checkRequest,
    lastCheck,
    tasks,
    nextRelease,
    ghChannel: value.ghChannel === "latest" ? "latest" : "pinned",
    updateChannel: isHostUpdateChannel(value.updateChannel) ? value.updateChannel : null,
    retained: isRecord(value.retained)
      ? Object.fromEntries(
          Object.entries(value.retained).flatMap(([id, entry]) => {
            const record =
              isRecord(entry) && HOST_TASK_KINDS.includes(entry.kind as HostTaskKind)
                ? normalizeTask(entry.kind as HostTaskKind, entry)
                : normalizeJob(entry);
            return record && record.id === id ? [[id, record]] : [];
          }),
        )
      : {},
  };
}

function bounded(text: string): string {
  return text.length > HOST_MAINTENANCE_LIMITS.errorMaxChars
    ? `${text.slice(0, HOST_MAINTENANCE_LIMITS.errorMaxChars - 1)}…`
    : text;
}

/**
 * Remote-initiated maintenance of the host running this backend: Orkestrator
 * updates and dependency tasks.
 *
 * The record is durable because an update outlives the process that applies
 * it: installing restarts the app (or the standalone backend) and this
 * backend with it, and the new backend settles the job from evidence (the
 * version it now runs, or the launcher's rollback record) in {@link markReady}.
 * Nothing here installs anything. The desktop app's main process, or the
 * standalone self-updater, reads the snapshot, does the work and reports
 * back through {@link report}.
 */
export class HostMaintenanceService {
  private storage: StorageDatabase | null = null;
  private executorReady: boolean;
  private releaseSelectionRevision = 0;
  private initialized = false;
  private readinessSettled = false;
  private startupJobId: string | null = null;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readers: HostMaintenanceReaders;
  private readonly listeners = new Set<(snapshot: HostMaintenanceSnapshot) => void>();

  constructor(
    private readonly options: {
      dataDir: string;
      updater: HostUpdaterKind;
      version: string;
      emit: BackendEmit;
      now?: () => number;
      newId?: () => string;
      readers?: HostMaintenanceReaders;
      /** Read once at startup; the standalone launcher writes it after a rollback. */
      rollbackEvidence?: () => HostRollbackEvidence | null;
      /** Called after every check report, for example to fetch the release's pins. */
      onCheck?: (latestVersion: string | null, isCurrent: () => boolean) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `hostupd-${randomUUID()}`);
    this.readers = options.readers ?? {};
    // The desktop executor announces itself; nothing else needs to.
    this.executorReady = options.updater !== "desktop";
  }

  /** In-process executors (the standalone self-updater) follow changes here. */
  subscribe(listener: (snapshot: HostMaintenanceSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Readers depend on services built after this one. */
  setReaders(readers: HostMaintenanceReaders): void {
    this.readers = { ...this.readers, ...readers };
  }

  get updaterKind(): HostUpdaterKind {
    return this.options.updater;
  }

  get version(): string {
    return this.options.version;
  }

  private get database(): StorageDatabase {
    if (!this.storage || this.storage.isClosed()) {
      this.storage = openBackendDatabase(this.options.dataDir);
    }
    return this.storage;
  }

  private load(): HostMaintenanceDocument {
    return normalizeDocument(this.database.readStore(HOST_MAINTENANCE_STORE)?.value);
  }

  /** Read-modify-write under one transaction; emits the new snapshot when it changed. */
  private update(mutate: (document: HostMaintenanceDocument) => boolean): HostMaintenanceSnapshot {
    const changed = this.database.transaction(() => {
      const document = normalizeDocument(
        this.database.readStoreValueInTransaction(HOST_MAINTENANCE_STORE)?.value,
      );
      if (!mutate(document)) return null;
      for (const record of [document.job, ...Object.values(document.tasks)]) {
        if (record && document.retained[record.id]) document.retained[record.id] = record;
      }
      document.revision += 1;
      this.database.writeStoreInTransaction(HOST_MAINTENANCE_STORE, document);
      return document;
    });
    if (!changed) return this.snapshotOf(this.load());
    const snapshot = this.snapshotOf(changed);
    this.options.emit(HOST_MAINTENANCE_EVENT, snapshot);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn("[host-maintenance] Listener failed:", error);
      }
    }
    return snapshot;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** The channel a host that never chose one follows: the running release's. */
  private get defaultUpdateChannel(): HostUpdateChannel {
    return hostUpdateChannelOfVersion(this.options.version) ?? "stable";
  }

  /**
   * Settles work the previous process left in progress. Installing restarts
   * this backend; update settlement waits for markReady. Dependency tasks the restart cut
   * short fail and can be started again.
   *
   * A host that never chose an update channel is pinned to the one its first
   * release came from, so a beta install that updates to a stable release
   * stays on Beta.
   */
  init(): void {
    if (this.initialized) return;
    this.update((document) => {
      this.startupJobId = document.job?.id ?? null;
      let changed = false;
      if (document.updateChannel === null) {
        document.updateChannel = this.defaultUpdateChannel;
        changed = true;
      }
      const at = this.iso();
      for (const kind of HOST_TASK_KINDS) {
        const task = document.tasks[kind];
        if (task?.state !== "running") continue;
        document.tasks[kind] = {
          ...task,
          state: "failed",
          error: "The backend restarted before this finished; start it again",
          updatedAt: at,
          completedAt: at,
        };
        changed = true;
      }
      return changed;
    });
    this.initialized = true;
  }

  /** Called only after gateway startup, descriptor publication and the ready handshake. */
  markReady(): void {
    if (this.readinessSettled) return;
    const version = this.options.version;
    const rollback = this.options.rollbackEvidence?.() ?? null;
    this.update((document) => {
      const at = this.iso();
      const job = document.job;
      if (!job || job.id !== this.startupJobId || !isActiveHostUpdateJob(job)) return false;
      const expected = job.targetVersion ?? job.requestedVersion;
      const settle = (patch: Partial<HostUpdateJob>) => {
        document.job = {
          ...job,
          ...patch,
          progressPercent: null,
          restartAt: null,
          updatedAt: at,
          completedAt: at,
        };
      };
      if (version !== job.fromVersion && (expected === null || expected === version)) {
        settle({ state: "succeeded", targetVersion: version, error: null });
      } else if (version !== job.fromVersion) {
        settle({ state: "failed", error: `The host restarted on ${version}, not ${expected}` });
      } else if (
        rollback &&
        rollback.restoredVersion === version &&
        rollback.failedVersion === expected &&
        Date.parse(rollback.at) >= Date.parse(job.requestedAt)
      ) {
        settle({
          state: "failed",
          error: `${rollback.failedVersion} did not start, so the host went back to ${version}`,
        });
      } else {
        settle({
          state: "failed",
          error:
            job.state === "restarting"
              ? "The app restarted without installing the update"
              : "The app restarted before the update was installed",
        });
      }
      return true;
    });
    this.readinessSettled = true;
  }

  snapshot(): HostMaintenanceSnapshot {
    return this.snapshotOf(this.load());
  }

  /** The snapshot plus live readings (impact, tools, image). Readers that fail are left out. */
  async detailedSnapshot(): Promise<HostMaintenanceSnapshot> {
    const base = this.snapshot();
    const [impact, tools, image] = await Promise.all([
      this.readers.impact?.().catch(() => undefined),
      this.readers.tools?.().catch(() => undefined),
      this.readers.image?.().catch(() => undefined),
    ]);
    return {
      ...base,
      ...(impact ? { impact } : {}),
      ...(tools ? { tools } : {}),
      ...(image !== undefined ? { image } : {}),
    };
  }

  /**
   * The snapshot plus the restart impact only: what the desktop executor
   * polls while it waits for idle, without the tool and image probes.
   */
  async snapshotWithImpact(): Promise<HostMaintenanceSnapshot> {
    const impact = await this.impact();
    return { ...this.snapshot(), ...(impact ? { impact } : {}) };
  }

  /** What a restart would interrupt now. */
  async impact(): Promise<HostRestartImpact | null> {
    return (await this.readers.impact?.().catch(() => null)) ?? null;
  }

  private snapshotOf(document: HostMaintenanceDocument): HostMaintenanceSnapshot {
    const { updater, version } = this.options;
    const available = updater !== "none" && this.executorReady;
    const check = document.lastCheck;
    const current = check?.forVersion === version;
    const nextRelease =
      document.nextRelease && document.nextRelease.version !== version
        ? document.nextRelease
        : null;
    return {
      revision: document.revision,
      version,
      updater: {
        kind: updater,
        available,
        reason: available
          ? null
          : updater === "none"
            ? UNSUPPORTED_REASON
            : EXECUTOR_PENDING_REASON,
        latestVersion: check?.latestVersion ?? null,
        // A check made before this version started says nothing about it.
        updateAvailable: current ? (check?.updateAvailable ?? null) : null,
        checkedAt: check?.checkedAt ?? null,
        checkError: current ? (check?.error ?? null) : null,
      },
      checkRequest: document.checkRequest,
      job: document.job,
      tasks: document.tasks,
      nextRelease,
      ghChannel: document.ghChannel,
      updateChannel: document.updateChannel ?? this.defaultUpdateChannel,
    };
  }

  /** The current job or a prior job retained for an unsettled public receipt. */
  job(id: string): HostUpdateJob | null {
    const document = this.load();
    const job = document.job?.id === id ? document.job : document.retained[id];
    return job && "fromVersion" in job ? job : null;
  }

  /** The latest task or a prior task retained for an unsettled public receipt. */
  task(id: string): HostTask | null {
    const document = this.load();
    const task =
      Object.values(document.tasks).find((task) => task?.id === id) ?? document.retained[id];
    return task && "kind" in task ? task : null;
  }

  assertOutcomeCapacity(): void {
    if (Object.keys(this.load().retained).length >= MAX_RETAINED_OUTCOMES) {
      throw new HostMaintenanceError(
        "busy",
        "Maintenance receipts must settle before starting more work",
      );
    }
  }

  retainOutcome(id: string): void {
    this.update((document) => {
      const record =
        document.job?.id === id
          ? document.job
          : Object.values(document.tasks).find((task) => task?.id === id);
      if (!record) throw new HostMaintenanceError("not-found", "Maintenance record is gone");
      if (
        !document.retained[id] &&
        Object.keys(document.retained).length >= MAX_RETAINED_OUTCOMES
      ) {
        throw new HostMaintenanceError("busy", "Maintenance receipt capacity reached");
      }
      document.retained[id] = record;
      return true;
    });
  }

  releaseOutcome(id: string): void {
    this.update((document) => {
      if (!document.retained[id]) return false;
      delete document.retained[id];
      return true;
    });
  }

  private assertAvailable(): void {
    if (this.options.updater === "none") {
      throw new HostMaintenanceError("unsupported", UNSUPPORTED_REASON);
    }
    if (!this.executorReady) throw new HostMaintenanceError("unsupported", EXECUTOR_PENDING_REASON);
  }

  /** Asks the executor to check for an update; answered through {@link report}. */
  requestCheck(): HostMaintenanceSnapshot {
    this.assertAvailable();
    return this.update((document) => {
      document.checkRequest = { id: this.newId(), requestedAt: this.iso() };
      return true;
    });
  }

  /** Records a new update job. One job runs at a time. */
  requestUpdate(input: {
    requestedVersion: string | null;
    drain?: HostUpdateDrain;
    maxWaitSeconds?: number;
  }): HostUpdateJob {
    const requestedVersion = input.requestedVersion;
    const drain = input.drain ?? "now";
    if (requestedVersion !== null && !isHostVersion(requestedVersion)) {
      throw new HostMaintenanceError("invalid-input", "version is not a release version");
    }
    if (requestedVersion === this.options.version) {
      throw new HostMaintenanceError(
        "invalid-input",
        `The host already runs Orkestrator ${requestedVersion}`,
      );
    }
    const maxWait = input.maxWaitSeconds ?? HOST_UPDATE_IDLE_WAIT.defaultSeconds;
    if (
      !Number.isInteger(maxWait) ||
      maxWait < HOST_UPDATE_IDLE_WAIT.minSeconds ||
      maxWait > HOST_UPDATE_IDLE_WAIT.maxSeconds
    ) {
      throw new HostMaintenanceError(
        "invalid-input",
        `maxWaitSeconds must be between ${HOST_UPDATE_IDLE_WAIT.minSeconds} and ${HOST_UPDATE_IDLE_WAIT.maxSeconds}`,
      );
    }
    this.assertAvailable();
    let created: HostUpdateJob | null = null;
    let active: HostUpdateJob | null = null;
    this.update((document) => {
      if (document.job && isActiveHostUpdateJob(document.job)) {
        active = document.job;
        return false;
      }
      const nowMs = this.now();
      const at = new Date(nowMs).toISOString();
      created = {
        id: this.newId(),
        state: "requested",
        fromVersion: this.options.version,
        requestedVersion,
        targetVersion: null,
        drain,
        idleDeadline: drain === "when-idle" ? new Date(nowMs + maxWait * 1000).toISOString() : null,
        progressPercent: null,
        restartAt: null,
        error: null,
        requestedAt: at,
        updatedAt: at,
        completedAt: null,
      };
      document.job = created;
      return true;
    });
    if (!created) {
      throw new HostMaintenanceError(
        "busy",
        `An update is already in progress (${(active as HostUpdateJob | null)?.state ?? "active"})`,
      );
    }
    return created;
  }

  /**
   * Cancels the current update before its restart. A download already in
   * progress finishes; the staged update then installs on the next ordinary
   * quit, as any background update would.
   */
  cancelUpdate(jobId?: string): HostUpdateJob {
    let result: HostUpdateJob | null = null;
    let refusal: HostMaintenanceError | null = null;
    this.update((document) => {
      const job = document.job;
      if (!job || (jobId && job.id !== jobId) || !isActiveHostUpdateJob(job)) {
        refusal = new HostMaintenanceError("not-found", "No update is in progress");
        return false;
      }
      if (!CANCELLABLE_HOST_UPDATE_JOB_STATES.has(job.state)) {
        refusal = new HostMaintenanceError("busy", "The host is already restarting");
        return false;
      }
      const at = this.iso();
      result = {
        ...job,
        state: "cancelled",
        progressPercent: null,
        restartAt: null,
        updatedAt: at,
        completedAt: at,
      };
      document.job = result;
      return true;
    });
    if (refusal) throw refusal;
    return result!;
  }

  /** Applies what the executor reports. Stale or out-of-order reports are ignored. */
  report(report: HostUpdaterReport): HostMaintenanceSnapshot {
    if (report.type === "ready") {
      if (this.executorReady) return this.snapshot();
      this.executorReady = true;
      // Bump the revision so clients holding an "unavailable" snapshot refresh.
      return this.update(() => true);
    }
    if (report.type === "check") {
      const pending = this.load().checkRequest;
      if (report.channel && report.channel !== this.updateChannel()) return this.snapshot();
      if (report.checkRequestId && report.checkRequestId !== pending?.id) return this.snapshot();
      const selection = ++this.releaseSelectionRevision;
      const isCurrent = () => selection === this.releaseSelectionRevision;
      queueMicrotask(() => {
        if (isCurrent()) this.options.onCheck?.(report.latestVersion, isCurrent);
      });
      return this.update((document) => {
        document.lastCheck = {
          latestVersion: report.latestVersion,
          updateAvailable: report.updateAvailable,
          checkedAt: report.checkedAt,
          error: report.error,
          forVersion: this.options.version,
        };
        const pending = document.checkRequest;
        if (
          pending &&
          (report.checkRequestId === pending.id ||
            Date.parse(report.checkedAt) >= Date.parse(pending.requestedAt))
        ) {
          document.checkRequest = null;
        }
        return true;
      });
    }
    return this.update((document) => {
      const job = document.job;
      if (!job || job.id !== report.jobId) return false;
      if (!REPORTED_TRANSITIONS[job.state].includes(report.state)) return false;
      const at = this.iso();
      const terminal = report.state === "failed" || report.state === "postponed";
      document.job = {
        ...job,
        state: report.state,
        targetVersion: report.targetVersion ?? job.targetVersion,
        progressPercent:
          report.state === "downloading"
            ? (report.progressPercent ?? job.progressPercent ?? 0)
            : null,
        restartAt: report.state === "awaiting-restart" ? (report.restartAt ?? null) : null,
        error: report.state === "failed" ? bounded(report.error ?? "The update failed") : null,
        updatedAt: at,
        completedAt: terminal ? at : null,
      };
      return true;
    });
  }

  /** Records the pins the newest release brings (fetched after a check). */
  setNextRelease(pins: HostReleasePins | null): HostMaintenanceSnapshot {
    return this.update((document) => {
      if (JSON.stringify(document.nextRelease) === JSON.stringify(pins)) return false;
      document.nextRelease = pins;
      return true;
    });
  }

  setGhChannel(channel: "pinned" | "latest"): HostMaintenanceSnapshot {
    return this.update((document) => {
      if (document.ghChannel === channel) return false;
      document.ghChannel = channel;
      return true;
    });
  }

  ghChannel(): "pinned" | "latest" {
    return this.load().ghChannel;
  }

  updateChannel(): HostUpdateChannel {
    return this.load().updateChannel ?? this.defaultUpdateChannel;
  }

  /**
   * Switches the releases this host updates to. The last check answered for
   * the old channel, so it is dropped and, when the host can update, a new
   * check is requested. Refused while an update is in progress: its release
   * was chosen from the old channel.
   */
  setUpdateChannel(channel: HostUpdateChannel): HostMaintenanceSnapshot {
    if (!isHostUpdateChannel(channel)) {
      throw new HostMaintenanceError("invalid-input", "channel must be stable, beta or unstable");
    }
    let busy = false;
    const snapshot = this.update((document) => {
      if ((document.updateChannel ?? this.defaultUpdateChannel) === channel) return false;
      if (document.job && isActiveHostUpdateJob(document.job)) {
        busy = true;
        return false;
      }
      this.releaseSelectionRevision += 1;
      document.updateChannel = channel;
      document.lastCheck = null;
      document.nextRelease = null;
      document.checkRequest =
        this.options.updater !== "none" && this.executorReady
          ? { id: this.newId(), requestedAt: this.iso() }
          : null;
      return true;
    });
    if (busy) {
      throw new HostMaintenanceError(
        "busy",
        "Wait for the update in progress to finish before changing the update channel",
      );
    }
    return snapshot;
  }

  /** Starts a dependency task; one of each kind runs at a time. */
  startTask(kind: HostTaskKind, stage: string): HostTask {
    let created: HostTask | null = null;
    this.update((document) => {
      if (document.tasks[kind]?.state === "running") return false;
      const at = this.iso();
      created = {
        id: this.newId(),
        kind,
        state: "running",
        stage,
        error: null,
        result: null,
        startedAt: at,
        updatedAt: at,
        completedAt: null,
      };
      document.tasks[kind] = created;
      return true;
    });
    if (!created) throw new HostMaintenanceError("busy", `A ${kind} is already running`);
    return created;
  }

  /** Updates a running task's stage or finishes it. Ignored once it has finished. */
  updateTask(
    id: string,
    patch:
      | { stage?: string }
      | { state: "succeeded"; result?: Record<string, unknown> }
      | {
          state: "failed";
          error: string;
        },
  ): HostMaintenanceSnapshot {
    return this.update((document) => {
      const entry = Object.entries(document.tasks).find(([, task]) => task?.id === id);
      if (!entry) return false;
      const [kind, task] = entry as [HostTaskKind, HostTask];
      if (task.state !== "running") return false;
      const at = this.iso();
      if ("state" in patch) {
        document.tasks[kind] = {
          ...task,
          state: patch.state,
          stage: null,
          error: patch.state === "failed" ? bounded(patch.error) : null,
          result: patch.state === "succeeded" ? (patch.result ?? null) : task.result,
          updatedAt: at,
          completedAt: at,
        };
      } else {
        if (patch.stage === task.stage) return false;
        document.tasks[kind] = { ...task, stage: patch.stage ?? task.stage, updatedAt: at };
      }
      return true;
    });
  }

  /** Closes this service's database connection; a later call reopens it. */
  close(): void {
    this.storage?.close();
    this.storage = null;
  }
}
