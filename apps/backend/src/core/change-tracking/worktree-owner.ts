/**
 * Physical worktree identity and its single change owner.
 *
 * {@link WorktreeRegistry} resolves every alias of a checkout (relative
 * paths, symlinks, several environments pointing at one directory) to one
 * {@link WorktreeIdentity}; linked worktrees sharing a Git object database
 * stay separate because their roots, indexes and HEADs differ. A replaced
 * container or recreated directory gets a new incarnation, so it never
 * inherits earlier captures because its path string is equal.
 *
 * One {@link WorktreeChangeOwner} per identity serializes captures, shares a
 * queued capture among callers whose freshness fence it satisfies, tracks
 * observation epochs and per-file content generations, and records tool
 * windows and their overlap across every bridge using the checkout. Its
 * durable fence (advanced when it claims the worktree) is checked inside the
 * publication transaction: a stale owner can finish private work but cannot
 * publish.
 */

import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { gitDockerScanPool } from "../git-docker-scan-pool.js";
import { runCommand } from "../shell.js";
import type { WorkAdmissionPool } from "../work-admission.js";
import { resolveWorktreeGitPaths } from "../worktree-git-paths.js";
import {
  captureWorktree,
  ContainerCaptureExecutor,
  HostCaptureExecutor,
  MANIFEST_POLICY_ID,
  OBJECT_FORMAT,
  readManifest,
  type CaptureExecutor,
  type CaptureLimits,
  type Manifest,
  type ManifestMode,
} from "./capture.js";
import {
  OwnerFenceError,
  type ChangeLedger,
  type ToolWindowRow,
  type WorktreeRow,
} from "./change-ledger.js";
import type { ObjectStore } from "./object-store.js";

export type WorktreeTarget =
  | { kind: "local"; worktreePath: string }
  | { kind: "container"; containerId: string; root?: string };

export interface WorktreeIdentity {
  worktreeId: string;
  incarnation: string;
  identityKey: string;
  runtimeKind: "host" | "container";
  runtimeId: string;
  canonicalRoot: string;
  gitDir: string | null;
  commonDir: string | null;
}

export interface PublishedSnapshot {
  kind: "published";
  snapshotId: string;
  manifestId: string;
  manifest: Manifest;
  observationEpoch: number;
  boundarySeq: number;
  consistency: "stable-observation" | "changed-during-capture";
  coverage: "complete" | "partial";
  head: string | null;
  capturedAt: string;
}

export interface UnavailableSnapshot {
  kind: "unavailable";
  reason: string;
  boundarySeq: number;
}

export type CaptureOutcome = PublishedSnapshot | UnavailableSnapshot;

export type CapturePurpose =
  | "turn-start"
  | "turn-end"
  | "tool-before"
  | "tool-after"
  | "provisional"
  | "refresh"
  | "restore-checkpoint"
  | "restore-result";

/** Purposes whose boundary quality depends on waiting; they outrank provisional work. */
const URGENT: ReadonlySet<CapturePurpose> = new Set([
  "turn-start",
  "turn-end",
  "tool-before",
  "tool-after",
  "restore-checkpoint",
  "restore-result",
]);

export interface CaptureRequestOptions {
  purpose: CapturePurpose;
  /** Total budget including admission, capture and publication. */
  deadlineMs: number;
  /** Stable key making the reservation idempotent (for example a turn id). */
  boundaryKey?: string;
  signal?: AbortSignal;
  requestedAt?: number;
}

export interface OwnerDependencies {
  ledger: ChangeLedger;
  store: ObjectStore;
  admission?: WorkAdmissionPool;
  limits?: Partial<CaptureLimits>;
  /** Cap on concurrent container captures inside the shared pool. */
  remoteSlots?: RemoteSlots;
  now?: () => number;
}

/**
 * At most N remote jobs inside the shared admission cap. A released slot is
 * handed directly to the oldest waiter, so a newcomer can neither barge past
 * it nor push the count over the cap.
 */
export class RemoteSlots {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max = 2) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("capture-timeout"));
        };
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        if (signal.aborted) return reject(new Error("capture-timeout"));
        this.waiters.push(wake);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    } else {
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    };
  }
}

const defaultRemoteSlots = new RemoteSlots(2);

export class WorktreeChangeOwner {
  readonly ownerGeneration = randomUUID();
  readonly executor: CaptureExecutor;
  private fence: number | null = null;
  private replaced = false;
  private observationEpoch = 0;
  private readonly contentGenerations = new Map<string, number>();
  private previous: Manifest | null = null;
  private previousLoaded = false;
  private statCache = new Map<string, { stamp: string; oid: string; mode: ManifestMode }>();
  private running: Promise<CaptureOutcome> | null = null;
  private queued: {
    promise: Promise<CaptureOutcome>;
    urgent: boolean;
    options: CaptureRequestOptions;
  } | null = null;
  private leases = 0;
  private lastUsedAt = Date.now();

  constructor(
    readonly identity: WorktreeIdentity,
    private readonly deps: OwnerDependencies,
  ) {
    this.executor =
      identity.runtimeKind === "container"
        ? new ContainerCaptureExecutor(identity.runtimeId, identity.canonicalRoot)
        : new HostCaptureExecutor(identity.canonicalRoot);
  }

  get isReplaced(): boolean {
    return this.replaced;
  }

  get currentObservationEpoch(): number {
    return this.observationEpoch;
  }

  /** Operational leases (active runs, environments) keep the owner alive. */
  retain(): () => void {
    this.leases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases--;
      this.lastUsedAt = Date.now();
    };
  }

  idleFor(nowMs: number): number {
    if (this.leases > 0 || this.running || this.queued) return 0;
    return nowMs - this.lastUsedAt;
  }

  /** Claim the durable fence on first use. */
  private claim(): number {
    if (this.fence === null) {
      this.fence = this.deps.ledger.claimOwnership(this.identity.worktreeId, this.ownerGeneration);
    }
    return this.fence;
  }

  ownerFence(): number {
    return this.claim();
  }

  /** Throws when another owner has taken the worktree. Use inside a transaction. */
  assertCurrent(): void {
    const fence = this.claim();
    try {
      this.deps.ledger.assertFence(this.identity.worktreeId, fence);
    } catch (error) {
      if (error instanceof OwnerFenceError) this.replaced = true;
      throw error;
    }
  }

  /** A watcher hint, mutation or refresh: later reads must be newer than this. */
  invalidate(pathIds?: readonly string[]): number {
    this.observationEpoch++;
    for (const pathId of pathIds ?? []) {
      this.contentGenerations.set(pathId, (this.contentGenerations.get(pathId) ?? 0) + 1);
    }
    if (!pathIds) this.statCache.clear();
    return this.observationEpoch;
  }

  contentGeneration(pathId: string): number {
    return this.contentGenerations.get(pathId) ?? 0;
  }

  private async loadPrevious(): Promise<void> {
    if (this.previousLoaded) return;
    this.previousLoaded = true;
    const last = this.deps.ledger.latestSnapshot(this.identity.worktreeId);
    if (last) this.previous = await readManifest(this.deps.store, last.tree_oid);
  }

  /**
   * Capture a fresh endpoint. A capture already running cannot satisfy the
   * request (it may have read files before the boundary); a queued one that
   * has not started can, and is shared.
   */
  capture(options: CaptureRequestOptions): Promise<CaptureOutcome> {
    const controller = new AbortController();
    const requestedAt = (this.deps.now ?? Date.now)();
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<CaptureOutcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "unavailable", reason: "capture-timeout", boundarySeq: 0 });
      }, options.deadlineMs);
    });
    const work = this.scheduleCapture({ ...options, signal: controller.signal, requestedAt });
    return Promise.race([work, expired]).finally(() => clearTimeout(timer));
  }

  private scheduleCapture(options: CaptureRequestOptions): Promise<CaptureOutcome> {
    this.lastUsedAt = Date.now();
    const urgent = URGENT.has(options.purpose);
    if (this.queued) {
      // An urgent caller upgrades the one queued pass (it has not started, so
      // it satisfies any fence) instead of starting a second, concurrent pass.
      if (urgent && !this.queued.urgent) this.queued = { ...this.queued, urgent, options };
      return this.queued.promise;
    }
    if (!this.running) {
      const running = this.captureNow(options).finally(() => {
        if (this.running === running) this.running = null;
      });
      this.running = running;
      return running;
    }
    const after = this.running.catch(() => undefined);
    const promise: Promise<CaptureOutcome> = after.then(() => {
      const queued = this.queued?.promise === promise ? this.queued : null;
      if (queued) this.queued = null;
      const running = this.captureNow(queued?.options ?? options).finally(() => {
        if (this.running === running) this.running = null;
      });
      this.running = running;
      return running;
    });
    this.queued = { promise, urgent, options };
    return promise;
  }

  private async captureNow(options: CaptureRequestOptions): Promise<CaptureOutcome> {
    const { ledger } = this.deps;
    const now = this.deps.now ?? Date.now;
    const started = options.requestedAt ?? now();
    if (options.signal?.aborted || now() - started >= options.deadlineMs)
      return { kind: "unavailable", reason: "capture-timeout", boundarySeq: 0 };
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, options.deadlineMs - (now() - started)));
    timer.unref?.();
    let fence: number;
    try {
      fence = this.claim();
    } catch {
      clearTimeout(timer);
      return { kind: "unavailable", reason: "ledger-unavailable", boundarySeq: 0 };
    }
    const boundarySeq = ledger.nextBoundarySequence(this.identity.worktreeId);
    const epoch = this.observationEpoch;
    const attempt = ledger.transaction(() =>
      ledger.reserveCapture({
        boundaryKey: options.boundaryKey ?? `${options.purpose}:${randomUUID()}`,
        worktreeId: this.identity.worktreeId,
        ownerEpoch: fence,
        requiredAfterBoundarySeq: boundarySeq,
        purpose: options.purpose,
        deadlineAt: new Date(Date.now() + options.deadlineMs).toISOString(),
      }),
    );
    if (attempt.status === "published" && attempt.snapshot_id) {
      clearTimeout(timer);
      const row = ledger.snapshot(attempt.snapshot_id);
      const manifest = row ? await readManifest(this.deps.store, row.tree_oid) : null;
      if (row && manifest) {
        return {
          kind: "published",
          snapshotId: row.id,
          manifestId: row.tree_oid,
          manifest,
          observationEpoch: row.observation_epoch,
          boundarySeq: attempt.required_after_boundary_seq,
          consistency: JSON.parse(row.consistency_json).state,
          coverage: JSON.parse(row.coverage_json).files,
          head: JSON.parse(row.coverage_json).head ?? null,
          capturedAt: row.capture_finished_at,
        };
      }
    }
    const remote = this.identity.runtimeKind === "container";
    let releaseRemote: (() => void) | null = null;
    try {
      await this.loadPrevious();
      if (remote)
        releaseRemote = await (this.deps.remoteSlots ?? defaultRemoteSlots).acquire(
          controller.signal,
        );
      const admission = this.deps.admission ?? gitDockerScanPool;
      const result = await admission.run(
        {
          kind: "change-capture",
          priority: URGENT.has(options.purpose) ? "interactive" : "progress",
          target: `change:${this.identity.worktreeId}`,
          signal: controller.signal,
        },
        () =>
          captureWorktree({
            executor: this.executor,
            store: this.deps.store,
            previous: this.previous,
            statCache: this.statCache,
            limits: this.deps.limits,
            signal: controller.signal,
          }),
      );
      if (result.kind === "unavailable") {
        ledger.transaction(() =>
          ledger.finishCapture(attempt.id, "failed", { errorCode: result.reason }),
        );
        return { kind: "unavailable", reason: result.reason, boundarySeq };
      }
      if (controller.signal.aborted || now() - started >= options.deadlineMs) {
        ledger.transaction(() =>
          ledger.finishCapture(attempt.id, "failed", { errorCode: "capture-timeout" }),
        );
        return { kind: "unavailable", reason: "capture-timeout", boundarySeq };
      }
      const snapshotId = `snap_${randomUUID()}`;
      const coverage = {
        ...result.coverage,
        verification: result.coverage.metadataReused > 0 ? "metadata-reuse" : "full",
      };
      try {
        ledger.transaction(() => {
          this.assertCurrent();
          ledger.insertSnapshot({
            id: snapshotId,
            worktree_id: this.identity.worktreeId,
            incarnation: this.identity.incarnation,
            tree_oid: result.manifestId,
            object_format: OBJECT_FORMAT,
            policy_id: MANIFEST_POLICY_ID,
            capture_started_at: result.startedAt,
            capture_finished_at: result.finishedAt,
            observation_epoch: epoch,
            coverage_json: JSON.stringify(coverage),
            consistency_json: JSON.stringify({
              state: result.consistency,
              unstable: result.coverage.unstable,
              inventoryChanged: result.coverage.inventoryChanged,
            }),
            closure_verified: 1,
            file_count: result.manifest.entries.length,
            retained_bytes: result.coverage.retainedBytes,
            created_at: new Date().toISOString(),
          });
          ledger.finishCapture(attempt.id, "published", { snapshotId });
        });
      } catch (error) {
        if (error instanceof OwnerFenceError) {
          ledger.transaction(() =>
            ledger.finishCapture(attempt.id, "abandoned", { errorCode: "owner-replaced" }),
          );
          return { kind: "unavailable", reason: "owner-replaced", boundarySeq };
        }
        throw error;
      }
      this.previous = result.manifest;
      this.statCache = result.statCache;
      return {
        kind: "published",
        snapshotId,
        manifestId: result.manifestId,
        manifest: result.manifest,
        observationEpoch: epoch,
        boundarySeq,
        consistency: result.consistency,
        coverage: result.coverage.files,
        head: result.coverage.head,
        capturedAt: result.finishedAt,
      };
    } catch (error) {
      const reason =
        controller.signal.aborted || (error instanceof Error && error.message === "capture-timeout")
          ? "capture-timeout"
          : error instanceof Error && error.name === "AdmissionRejectedError"
            ? "capture-capacity"
            : "capture-failed";
      try {
        ledger.transaction(() => ledger.finishCapture(attempt.id, "failed", { errorCode: reason }));
      } catch {
        // The attempt stays reserved and is reconciled at startup.
      }
      return { kind: "unavailable", reason, boundarySeq };
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      releaseRemote?.();
    }
  }

  // -------------------------------------------------------------------------
  // Tool windows
  // -------------------------------------------------------------------------

  /** Open a window; marks overlap on every window it intersects. */
  openWindow(input: {
    windowId: string;
    operationId: string;
    turnId: string | null;
    beforeQuality: string;
    beforeSnapshotId: string | null;
    openedSeq: number;
  }): ToolWindowRow {
    const { ledger } = this.deps;
    return ledger.transaction(() => {
      const existing = ledger.window(input.windowId);
      if (existing) return existing;
      const open = ledger.openWindows(this.identity.worktreeId);
      const overlap = open.length > 0 ? "known-overlap" : "none-observed";
      ledger.insertWindow({
        window_id: input.windowId,
        operation_id: input.operationId,
        turn_id: input.turnId,
        worktree_id: this.identity.worktreeId,
        before_snapshot_id: input.beforeSnapshotId,
        after_snapshot_id: null,
        before_quality: input.beforeQuality,
        after_quality: "unknown",
        overlap,
        overlap_group: null,
        lifecycle: "open",
        opened_seq: input.openedSeq,
        closed_seq: null,
        opened_at: new Date().toISOString(),
        closed_at: null,
        reason: null,
      });
      for (const other of open) {
        if (other.overlap !== "known-overlap")
          ledger.updateWindow(other.window_id, { overlap: "known-overlap" });
      }
      return ledger.window(input.windowId)!;
    });
  }

  /**
   * Close a window and return its final overlap. Closing never clears the
   * overlap already recorded on another window.
   */
  closeWindow(input: {
    windowId: string;
    afterQuality: string;
    afterSnapshotId: string | null;
    closedSeq: number;
    lifecycle?: "closed" | "abandoned" | "discarded";
    reason?: string | null;
  }): ToolWindowRow | null {
    const { ledger } = this.deps;
    return ledger.transaction(() => {
      const window = ledger.window(input.windowId);
      if (!window) return null;
      if (window.lifecycle !== "open") return window;
      const overlapping = ledger.overlappingWindows(
        this.identity.worktreeId,
        window.window_id,
        window.opened_seq,
        input.closedSeq,
      );
      const overlap =
        overlapping.length > 0 || window.overlap === "known-overlap"
          ? "known-overlap"
          : "none-observed";
      ledger.updateWindow(input.windowId, {
        after_quality: input.afterQuality,
        after_snapshot_id: input.afterSnapshotId,
        closed_seq: input.closedSeq,
        closed_at: new Date().toISOString(),
        lifecycle: input.lifecycle ?? "closed",
        overlap,
        reason: input.reason ?? null,
      });
      for (const other of overlapping) {
        if (other.overlap !== "known-overlap")
          ledger.updateWindow(other.window_id, { overlap: "known-overlap" });
      }
      return ledger.window(input.windowId);
    });
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface RegistryOptions extends OwnerDependencies {
  hostId?: string;
  /** Owners with no lease idle this long are disposed (ledger retained). */
  idleGraceMs?: number;
  inspectContainer?: (containerId: string) => Promise<{ id: string; created: string } | null>;
}

async function defaultInspectContainer(
  containerId: string,
): Promise<{ id: string; created: string } | null> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", "{{.Id}} {{.Created}}", containerId],
      {
        timeoutMs: 10_000,
      },
    );
    const [id, created] = stdout.trim().split(" ");
    return id && created ? { id, created } : null;
  } catch {
    return null;
  }
}

export class WorktreeRegistry {
  private readonly owners = new Map<string, WorktreeChangeOwner>();
  private readonly resolving = new Map<string, Promise<WorktreeIdentity | null>>();
  private readonly hostId: string;
  private readonly idleGraceMs: number;

  constructor(private readonly options: RegistryOptions) {
    this.hostId = options.hostId ?? hostname();
    this.idleGraceMs = options.idleGraceMs ?? 30_000;
  }

  /** Resolve an alias to its physical identity, creating a ledger row on first sight. */
  resolve(target: WorktreeTarget): Promise<WorktreeIdentity | null> {
    const key =
      target.kind === "local"
        ? `local:${target.worktreePath}`
        : `container:${target.containerId}\0${target.root ?? "/workspace"}`;
    let pending = this.resolving.get(key);
    if (!pending) {
      pending = this.resolveNow(target).finally(() => this.resolving.delete(key));
      this.resolving.set(key, pending);
    }
    return pending;
  }

  private async resolveNow(target: WorktreeTarget): Promise<WorktreeIdentity | null> {
    let identity: Omit<WorktreeIdentity, "worktreeId">;
    if (target.kind === "local") {
      const root = await realpath(target.worktreePath).catch(() => null);
      if (!root) return null;
      const info = await stat(root).catch(() => null);
      if (!info?.isDirectory()) return null;
      const git = await resolveWorktreeGitPaths(root);
      const gitDir = git ? await realpath(git.gitDir).catch(() => git.gitDir) : null;
      identity = {
        identityKey: `host:${this.hostId}:${root}:${gitDir ?? "-"}`,
        incarnation: `ino:${info.ino}:${Math.trunc(info.birthtimeMs)}`,
        runtimeKind: "host",
        runtimeId: this.hostId,
        canonicalRoot: root,
        gitDir,
        commonDir: git ? await realpath(git.commonDir).catch(() => git.commonDir) : null,
      };
    } else {
      const inspected = await (this.options.inspectContainer ?? defaultInspectContainer)(
        target.containerId,
      );
      if (!inspected) return null;
      const root = target.root ?? "/workspace";
      identity = {
        identityKey: `container:${inspected.id}:${root}`,
        incarnation: `created:${inspected.created}`,
        runtimeKind: "container",
        runtimeId: inspected.id,
        canonicalRoot: root,
        gitDir: null,
        commonDir: null,
      };
    }
    const { ledger } = this.options;
    const row: WorktreeRow = ledger.transaction(() => {
      const existing = ledger.worktreeByIdentity(identity.identityKey);
      if (existing && existing.incarnation === identity.incarnation) return existing;
      if (existing) ledger.tombstoneWorktree(existing.id);
      return ledger.insertWorktree({
        id: `wt_${randomUUID()}`,
        identity_key: identity.identityKey,
        incarnation: identity.incarnation,
        runtime_kind: identity.runtimeKind,
        runtime_id: identity.runtimeId,
        canonical_root: identity.canonicalRoot,
        git_dir: identity.gitDir,
        common_dir: identity.commonDir,
      });
    });
    return { ...identity, worktreeId: row.id };
  }

  /** The one owner for an identity; replaced owners are rebuilt with a new fence. */
  owner(identity: WorktreeIdentity): WorktreeChangeOwner {
    let owner = this.owners.get(identity.worktreeId);
    if (!owner || owner.isReplaced) {
      owner = new WorktreeChangeOwner(identity, this.options);
      this.owners.set(identity.worktreeId, owner);
    }
    return owner;
  }

  ownerById(worktreeId: string): WorktreeChangeOwner | null {
    const existing = this.owners.get(worktreeId);
    if (existing) return existing;
    const row = this.options.ledger.worktree(worktreeId);
    if (!row || row.tombstoned_at) return null;
    return this.owner({
      worktreeId: row.id,
      incarnation: row.incarnation,
      identityKey: row.identity_key,
      runtimeKind: row.runtime_kind === "container" ? "container" : "host",
      runtimeId: row.runtime_id,
      canonicalRoot: row.canonical_root,
      gitDir: row.git_dir,
      commonDir: row.common_dir,
    });
  }

  /** Delete tombstone: late events cannot resurrect a removed worktree. */
  tombstone(worktreeId: string): void {
    this.options.ledger.transaction(() => this.options.ledger.tombstoneWorktree(worktreeId));
    this.owners.delete(worktreeId);
  }

  /** Dispose owners idle past the grace window; durable state stays in the ledger. */
  sweepIdle(nowMs = Date.now()): number {
    let disposed = 0;
    for (const [id, owner] of this.owners) {
      if (owner.idleFor(nowMs) >= this.idleGraceMs) {
        this.owners.delete(id);
        disposed++;
      }
    }
    return disposed;
  }

  activeOwners(): number {
    return this.owners.size;
  }
}
