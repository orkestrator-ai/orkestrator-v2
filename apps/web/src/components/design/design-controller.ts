import { useEffect, useMemo, useState } from "react";
import {
  DESIGN_EVENT,
  type DesignChange,
  type DesignFrame,
} from "@orkestrator/protocol/design-canvas";
import type {
  DesignCapabilities,
  DesignExportReceipt,
  DesignFailure,
  DesignOperationDescriptor,
  DesignOperationStatus,
  DesignSnapshotResult,
  DesignSyncDelta,
  DesignSyncResult,
} from "@orkestrator/protocol/design-operations";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { createUuid } from "@/lib/uuid";
import { getReadCoordinator, type ReadSubscription } from "@/lib/read-coordinator";
import {
  emptyProjection,
  useDesignStore,
  type DesignIntent,
  type DesignProjection,
} from "@/stores/designStore";
import {
  classifyTransportError,
  designAction,
  designApi,
  designBackendKey,
  failureOf,
  getCanvasState,
  getCapabilities,
  getChanges,
} from "./design-client";
import { loadDrafts, saveDrafts } from "./design-drafts";

export const DESIGN_CANVAS_CURSOR_CHECK_MS = 3_000;
const MAX_ACTIVE_LANES = 4;
const MAX_INACTIVE_PROJECTIONS = 16;
const MAX_INACTIVE_BYTES = 32 * 1024 * 1024;
const MAX_BACKOFF_MS = 30_000;
const EXECUTE_WAIT_MS = 30_000;
const RETRY_BASE_MS = 1000;
const TERMINAL = new Set([
  "committed",
  "no-op",
  "rejected",
  "canceled",
  "interrupted",
  "expired",
  "unknown",
]);
/** Terminal outcomes proving the operation never ran: only these may be re-prepared. */
const NOT_RUN = new Set(["rejected", "canceled", "interrupted", "expired"]);

declare module "@/stores/designStore" {
  interface DesignIntent {
    /**
     * Prepared, but its token could not be saved locally (draft storage over
     * bounds). It never executes automatically; only an explicit Resume sends it.
     */
    held?: boolean;
  }
}

/** One own acknowledged commit of a frame, keyed by the frame revision it produced. */
interface OwnCommit {
  structureId?: string;
  contentId?: string;
  canvasRevision: number;
}

export interface DesignSubmitInput {
  descriptor: Omit<DesignOperationDescriptor, "canvasId" | "correlationId" | "clientId">;
  label: string;
  lane?: string;
  preview?: DesignIntent["preview"];
  /** Unsent samples sharing this key (same gesture and kind) collapse to the newest. */
  gestureKey?: string;
}

function laneOf(descriptor: DesignSubmitInput["descriptor"]): string {
  const input = descriptor.input as { frameId?: string; kind: string };
  if (input.kind === "delete_frame" || input.kind === "duplicate_frame") return "canvas";
  return input.frameId ?? "canvas";
}

function settledOk(intent: DesignIntent) {
  return (
    intent.phase === "settled" && (intent.outcome === "committed" || intent.outcome === "no-op")
  );
}

function jitter(ms: number) {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

let clientId: string | undefined;
function designClientId() {
  if (!clientId) {
    try {
      clientId = window.sessionStorage.getItem("orkestrator.design.client") ?? undefined;
      if (!clientId) {
        clientId = `c-${createUuid().slice(0, 12)}`;
        window.sessionStorage.setItem("orkestrator.design.client", clientId);
      }
    } catch {
      clientId = `c-${createUuid().slice(0, 12)}`;
    }
  }
  return clientId;
}

/**
 * One projection, hint listener and intent queue per backend/environment/canvas.
 * Views subscribe and produce intents; accepted work is owned by the backend,
 * so releasing every view never cancels anything.
 */
export class DesignCanvasController {
  readonly key: string;
  readonly draftKey: string;
  private consumers = 0;
  private epoch = 0;
  private disposed = false;
  private requested = 0;
  private completed = 0;
  private cycle: Promise<void> | null = null;
  private waiters: Array<{ target: number; resolve: () => void }> = [];
  private cursorCheck: ReadSubscription<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffMs = 0;
  /** Wakes `pump()` when the earliest deferred prepare retry becomes due. */
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private pumpTimerAt = 0;
  private prepareBackoffMs = 0;
  /** Unsent intents whose prepare failed on transport: not runnable before this time. */
  private readonly retryAt = new Map<string, number>();
  private readonly reconciling = new Set<string>();
  private unlisten: Array<() => void> = [];
  private readonly running = new Set<string>();
  private readonly ownFrameCommits = new Map<string, Map<number, OwnCommit>>();
  private readonly ownCanvasCommits = new Set<number>();
  /** Generation in which the own commits above were recorded. */
  private commitsGeneration: string | undefined;
  private capabilities: DesignCapabilities | null | undefined;
  lastUsed = Date.now();

  constructor(
    readonly backend: string,
    readonly environmentId: string,
    readonly canvasId: string,
  ) {
    this.key = `${backend}|${environmentId}|${canvasId}`;
    this.draftKey = `${this.key}|${designClientId()}`;
    const store = useDesignStore.getState();
    if (!store.projections.has(this.key)) {
      const owned = loadDrafts(this.draftKey);
      const legacy = owned.length ? [] : loadDrafts(this.key);
      if (legacy.length && saveDrafts(this.draftKey, legacy)) saveDrafts(this.key, []);
      store.put({
        ...emptyProjection(this.key, environmentId, canvasId),
        intents: owned.length ? owned : legacy,
      });
    }
  }

  get projection(): DesignProjection {
    return (
      useDesignStore.getState().projections.get(this.key) ??
      emptyProjection(this.key, this.environmentId, this.canvasId)
    );
  }

  private update(update: (projection: DesignProjection) => DesignProjection) {
    if (this.disposed) return;
    useDesignStore.getState().update(this.key, update);
  }

  private notice(text: string, tone: "info" | "success" | "warning" = "info") {
    this.update((projection) => ({
      ...projection,
      notice: { id: (projection.notice?.id ?? 0) + 1, text, tone },
    }));
  }

  // ---------------------------------------------------------------------------
  // Consumers and lifecycle
  // ---------------------------------------------------------------------------

  /** A visible consumer. Subscribes to hints before reading a snapshot. */
  acquire(): () => void {
    // An evicted controller stays inert; `designController()` hands out a live replacement.
    if (this.disposed) return () => {};
    this.consumers++;
    this.lastUsed = Date.now();
    if (this.consumers === 1) this.activate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.consumers--;
      this.lastUsed = Date.now();
      if (this.consumers === 0) {
        this.deactivate();
        // Deferred so a view switching canvases can acquire the next one first.
        scheduleEviction();
      }
    };
  }

  get visible() {
    return this.consumers > 0;
  }

  private activate() {
    const listen = window.orkestrator?.listen;
    if (typeof listen === "function") {
      const hint = listen<DesignChange & { generation?: string }>(DESIGN_EVENT, (event) => {
        if (event?.canvasId !== this.canvasId) return;
        if (
          event.generation &&
          this.projection.generation &&
          event.generation !== this.projection.generation
        )
          this.update((projection) => ({ ...projection, snapshot: "stale" }));
        void this.refresh();
      });
      const reconnect = listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => {
        this.capabilities = undefined;
        this.update((projection) => ({ ...projection, generation: undefined }));
        void this.refresh();
        this.reconcilePending();
        this.pump();
      });
      this.unlisten.push(hint, reconnect);
    }
    void this.refresh();
    // The coordinator pauses periodic reads while hidden and reconciles on return.
    // The activation read above still subscribes to hints before reading.
    this.cursorCheck = getReadCoordinator().subscribe({
      key: { resource: "design-canvas-cursor", target: this.key },
      demand: { intervalMs: DESIGN_CANVAS_CURSOR_CHECK_MS, priority: "standard" },
      readOnSubscribe: false,
      retainOnDispose: true,
      read: () => this.refresh(),
    });
    this.reconcilePending();
    this.pump();
  }

  private deactivate() {
    this.cursorCheck?.dispose();
    this.cursorCheck = undefined;
    for (const unlisten of this.unlisten.splice(0)) unlisten();
  }

  /** Clean: nothing unsent, unknown or unreviewed would be lost by eviction. */
  get clean() {
    return this.projection.intents.every(settledOk) && this.running.size === 0;
  }

  approximateBytes() {
    const canvas = this.projection.canvas;
    if (!canvas) return 0;
    return canvas.frames.reduce((total, frame) => total + frame.html.length * 2 + 256, 1024);
  }

  get isDisposed() {
    return this.disposed;
  }

  dispose() {
    this.disposed = true;
    this.epoch++;
    this.deactivate();
    clearTimeout(this.retryTimer);
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    for (const waiter of this.waiters.splice(0)) waiter.resolve();
    useDesignStore.getState().remove(this.key);
  }

  // ---------------------------------------------------------------------------
  // Synchronization
  // ---------------------------------------------------------------------------

  /** Resolves after a sync cycle that started after this call (or on disposal). */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const target = ++this.requested;
    const done = new Promise<void>((resolve) => this.waiters.push({ target, resolve }));
    this.startCycles();
    return done;
  }

  private startCycles() {
    if (this.cycle) return;
    this.cycle = this.runCycles().finally(() => {
      this.cycle = null;
      // A request that arrived after the loop's last check but before this
      // settled would otherwise wait forever.
      if (this.completed < this.requested && !this.disposed) this.startCycles();
    });
  }

  private async runCycles() {
    while (this.completed < this.requested && !this.disposed) {
      const target = this.requested;
      await this.syncOnce();
      this.completed = target;
      const ready = this.waiters.filter((waiter) => waiter.target <= target);
      this.waiters = this.waiters.filter((waiter) => waiter.target > target);
      for (const waiter of ready) waiter.resolve();
    }
  }

  private async caps(): Promise<DesignCapabilities | null> {
    if (this.capabilities !== undefined) return this.capabilities;
    this.capabilities = await getCapabilities(this.backend);
    this.update((projection) => ({ ...projection, legacy: this.capabilities === null }));
    return this.capabilities;
  }

  private async syncOnce() {
    const epoch = this.epoch;
    const projection = this.projection;
    if (projection.snapshot === "absent")
      this.update((current) => ({ ...current, snapshot: "loading" }));
    try {
      const caps = await this.caps();
      if (epoch !== this.epoch) return;
      if (!caps) {
        await this.legacySync(epoch);
      } else {
        const current = this.projection;
        const result: DesignSyncResult | DesignSnapshotResult =
          current.generation && current.canvas && current.snapshot !== "invalid"
            ? await designApi.sync(
                this.environmentId,
                this.canvasId,
                current.generation,
                current.revision,
                current.statusVersion >= 0 ? current.statusVersion : undefined,
              )
            : await designApi.snapshot(this.environmentId, this.canvasId);
        if (epoch !== this.epoch) return;
        if (result.kind === "reset" || (result.kind === "delta" && !this.installDelta(result))) {
          const snapshot = await designApi.snapshot(this.environmentId, this.canvasId);
          if (epoch !== this.epoch) return;
          this.install(snapshot);
        } else if (result.kind !== "delta") {
          this.install(result);
        }
      }
      this.backoffMs = 0;
      this.update((current) => ({
        ...current,
        connection: "connected",
        readError: undefined,
        lastSyncedAt: Date.now(),
      }));
      this.prune();
    } catch (error) {
      if (epoch !== this.epoch) return;
      const kind = classifyTransportError(error);
      if (kind === "disconnected" || kind === "unauthorized") {
        this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs ? this.backoffMs * 2 : 1000);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => void this.refresh(), jitter(this.backoffMs));
        this.update((current) => ({
          ...current,
          connection:
            kind === "unauthorized"
              ? "unauthorized"
              : this.backoffMs >= 8000
                ? "offline"
                : "reconnecting",
          snapshot: current.canvas
            ? "stale"
            : current.snapshot === "loading"
              ? "absent"
              : current.snapshot,
        }));
      } else {
        this.update((current) => ({ ...current, readError: failureOf(error) }));
      }
    }
  }

  private async legacySync(epoch: number) {
    const current = this.projection;
    const changes = await getChanges(
      this.environmentId,
      this.canvasId,
      current.generation,
      current.revision,
    );
    if (epoch !== this.epoch) return;
    if (changes.reset || changes.revision !== current.revision || !current.canvas) {
      const state = await getCanvasState(this.environmentId, this.canvasId);
      if (epoch !== this.epoch) return;
      this.update((projection) => ({
        ...projection,
        snapshot: "current",
        canvas: state.canvas,
        revision: state.canvas.revision,
        generation: changes.generation,
        workspace: projection.workspace
          ? { ...projection.workspace, history: state.history }
          : {
              recordSequence: 0,
              statusVersion: 0,
              incarnation: "legacy",
              createdAt: "",
              modifiedAt: "",
              frames: {},
              history: state.history,
              sessions: [],
            },
      }));
    } else {
      this.update((projection) => ({
        ...projection,
        snapshot: "current",
        generation: changes.generation,
      }));
    }
  }

  private install(result: DesignSyncResult | DesignSnapshotResult) {
    this.installResult(result);
    this.forgetStaleCommits();
  }

  private installResult(result: DesignSyncResult | DesignSnapshotResult) {
    this.update((projection) => {
      switch (result.kind) {
        case "snapshot": {
          const sameGeneration = projection.generation === result.generation;
          // Within one generation revisions never regress; a new generation is authoritative.
          if (sameGeneration && projection.canvas && result.canvas.revision < projection.revision)
            return projection;
          return {
            ...projection,
            snapshot: "current",
            canvas: result.canvas,
            workspace: result.workspace,
            revision: result.canvas.revision,
            statusVersion: result.workspace.statusVersion,
            generation: result.generation,
            tombstone: undefined,
            problem: undefined,
          };
        }
        case "deleted":
          return {
            ...projection,
            snapshot: "deleted",
            tombstone: result,
            generation: result.generation,
            statusVersion: result.statusVersion,
          };
        case "missing":
          return { ...projection, snapshot: "missing", generation: result.generation };
        case "record-problem":
          return {
            ...projection,
            snapshot: "invalid",
            problem: result,
            generation: result.generation,
          };
        case "unchanged":
          return projection.snapshot === "current" &&
            projection.statusVersion === result.statusVersion
            ? projection
            : { ...projection, snapshot: "current", statusVersion: result.statusVersion };
        case "status":
          return {
            ...projection,
            snapshot: "current",
            workspace: result.workspace,
            statusVersion: result.statusVersion,
          };
        default:
          return projection;
      }
    });
  }

  /** Installs a contiguous delta atomically, or returns false to request a snapshot. */
  private installDelta(delta: DesignSyncDelta): boolean {
    const projection = this.projection;
    if (
      !projection.canvas ||
      !projection.workspace ||
      delta.generation !== projection.generation ||
      delta.baseRevision !== projection.revision
    )
      return false;
    const byId = new Map(projection.canvas.frames.map((frame) => [frame.id, frame]));
    // Validate every patch before applying any of them.
    for (const added of delta.added)
      if (byId.has(added.id) || added.html === undefined) return false;
    for (const patch of delta.patched) if (!byId.has(patch.id)) return false;
    for (const id of delta.removed) if (!byId.has(id)) return false;
    const next = new Map(byId);
    for (const id of delta.removed) next.delete(id);
    for (const patch of delta.patched) {
      const frame = next.get(patch.id)!;
      next.set(patch.id, {
        ...frame,
        revision: patch.revision,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.x !== undefined ? { x: patch.x } : {}),
        ...(patch.y !== undefined ? { y: patch.y } : {}),
        ...(patch.width !== undefined ? { width: patch.width } : {}),
        ...(patch.height !== undefined ? { height: patch.height } : {}),
        ...(patch.html !== undefined ? { html: patch.html } : {}),
      });
    }
    for (const added of delta.added) {
      next.set(added.id, {
        id: added.id,
        name: added.name!,
        x: added.x!,
        y: added.y!,
        width: added.width!,
        height: added.height!,
        html: added.html!,
        revision: added.revision,
      });
    }
    const order = delta.canvas?.order ?? [
      ...projection.canvas.frames.map((frame) => frame.id).filter((id) => next.has(id)),
      ...delta.added.map((frame) => frame.id),
    ];
    if (order.length !== next.size || order.some((id) => !next.has(id))) return false;
    const frames = order.map((id) => next.get(id)!) as DesignFrame[];
    const metas = { ...(delta.frameMeta ?? projection.workspace.frames) };
    for (const id of delta.removed) delete metas[id];
    for (const patch of [...delta.added, ...delta.patched])
      if (patch.meta) metas[patch.id] = patch.meta;
    useDesignStore.getState().update(this.key, (current) => ({
      ...current,
      snapshot: "current",
      canvas: {
        ...current.canvas!,
        name: delta.canvas?.name ?? current.canvas!.name,
        revision: delta.revision,
        frames,
      },
      workspace: { ...delta.workspace, frames: metas },
      revision: delta.revision,
      statusVersion: delta.statusVersion,
    }));
    this.forgetStaleCommits();
    return true;
  }

  /**
   * Drops own-commit proofs that no longer describe the installed frames: a new
   * generation, a removed frame, a frame whose revision went back (recreated),
   * or a frame whose identity at a recorded revision differs from ours.
   * Projections older than a recorded commit are ignored (they predate it).
   */
  private forgetStaleCommits() {
    const projection = this.projection;
    if (
      this.commitsGeneration !== undefined &&
      projection.generation !== undefined &&
      projection.generation !== this.commitsGeneration
    ) {
      this.ownFrameCommits.clear();
      this.ownCanvasCommits.clear();
      this.commitsGeneration = undefined;
      return;
    }
    const canvas = projection.canvas;
    if (!canvas || !this.ownFrameCommits.size) return;
    const frames = new Map(canvas.frames.map((frame) => [frame.id, frame]));
    for (const [frameId, commits] of this.ownFrameCommits) {
      let newest: [number, OwnCommit] | undefined;
      for (const entry of commits) if (!newest || entry[0] > newest[0]) newest = entry;
      if (!newest) {
        this.ownFrameCommits.delete(frameId);
        continue;
      }
      if (projection.revision < newest[1].canvasRevision) continue;
      const frame = frames.get(frameId);
      const meta = projection.workspace?.frames[frameId];
      const recorded = frame ? commits.get(frame.revision) : undefined;
      const identityChanged =
        recorded !== undefined &&
        meta !== undefined &&
        ((recorded.contentId !== undefined && recorded.contentId !== meta.contentId) ||
          (recorded.structureId !== undefined && recorded.structureId !== meta.structureId));
      if (!frame || frame.revision < newest[0] || identityChanged)
        this.ownFrameCommits.delete(frameId);
    }
  }

  // ---------------------------------------------------------------------------
  // Intents
  // ---------------------------------------------------------------------------

  submit(input: DesignSubmitInput): string {
    const lane = input.lane ?? laneOf(input.descriptor);
    const projection = this.projection;
    if (input.gestureKey) {
      const existing = projection.intents.find(
        (intent) =>
          intent.lane === lane &&
          intent.gestureKey === input.gestureKey &&
          intent.phase === "draft" &&
          !intent.restored &&
          !this.running.has(intent.id) &&
          !this.retryAt.has(intent.id),
      );
      if (existing) {
        // Only the sample changes: the gesture keeps the base it was first
        // observed on, so a commit by another writer in between still conflicts.
        this.patchIntent(existing.id, {
          descriptor: { ...existing.descriptor, input: input.descriptor.input },
          label: input.label,
          preview: input.preview,
        });
        this.persist();
        return existing.id;
      }
    }
    const id = `i-${createUuid()}`;
    const intent: DesignIntent = {
      id,
      environmentId: this.environmentId,
      canvasId: this.canvasId,
      lane,
      descriptor: {
        ...input.descriptor,
        canvasId: this.canvasId,
        correlationId: id,
        clientId: designClientId(),
      },
      label: input.label,
      createdAt: Date.now(),
      phase: "draft",
      ...(input.preview ? { preview: input.preview } : {}),
      ...(input.gestureKey ? { gestureKey: input.gestureKey } : {}),
    };
    this.update((current) => ({ ...current, intents: [...current.intents, intent] }));
    if (!this.persist())
      this.notice("Too many unsaved edits are waiting; they will stay in this window", "warning");
    this.pump();
    return id;
  }

  private patchIntent(id: string, patch: Partial<DesignIntent>) {
    this.update((projection) => ({
      ...projection,
      intents: projection.intents.map((intent) =>
        intent.id === id ? { ...intent, ...patch } : intent,
      ),
    }));
  }

  private intent(id: string) {
    return this.projection.intents.find((intent) => intent.id === id);
  }

  private persist(): boolean {
    return saveDrafts(this.draftKey, this.projection.intents);
  }

  private runnable(intent: DesignIntent, index: number, intents: DesignIntent[]) {
    if (
      intent.phase !== "draft" ||
      intent.restored ||
      intent.held ||
      intent.blocked ||
      this.running.has(intent.id)
    )
      return false;
    const retryAt = this.retryAt.get(intent.id);
    if (retryAt !== undefined && retryAt > Date.now()) return false;
    for (let earlier = 0; earlier < index; earlier++) {
      const other = intents[earlier]!;
      // Settled work (successful or failed) never blocks: edits that depended on a
      // failed one were flagged `blocked` when it failed; newer edits are independent.
      if (other.phase === "settled") continue;
      // Restored work from an earlier session waits for review or reconciliation;
      // edits made in this session carry their own observed base and never wait on it.
      if (other.restored) continue;
      if (other.lane === intent.lane) return false;
      if (intent.lane === "canvas" || other.lane === "canvas") return false;
    }
    return true;
  }

  pump() {
    if (this.disposed) return;
    const intents = this.projection.intents;
    let active = new Set(
      intents.filter((intent) => this.running.has(intent.id)).map((intent) => intent.lane),
    ).size;
    intents.forEach((intent, index) => {
      if (active >= MAX_ACTIVE_LANES || !this.runnable(intent, index, intents)) return;
      active++;
      this.running.add(intent.id);
      void this.run(intent.id).finally(() => {
        this.running.delete(intent.id);
        this.pump();
      });
    });
    this.armRetryTimer();
  }

  /** Keeps one timer for the earliest deferred retry; `pump()` re-arms it as needed. */
  private armRetryTimer() {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const intent of this.projection.intents) {
      const at = this.retryAt.get(intent.id);
      if (at !== undefined && at > now && intent.phase === "draft") next = Math.min(next, at);
    }
    if (next === Number.POSITIVE_INFINITY) return;
    if (this.pumpTimer !== undefined && this.pumpTimerAt <= next) return;
    clearTimeout(this.pumpTimer);
    this.pumpTimerAt = next;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      void this.refresh();
      this.pump();
    }, next - now);
  }

  /**
   * Rebases a precondition only over this client's own acknowledged commits:
   * each proven step starts exactly where the previous own commit ended.
   * Another writer's change breaks the chain and surfaces as a conflict.
   */
  private rebase(descriptor: DesignOperationDescriptor): DesignOperationDescriptor {
    const preconditions = { ...descriptor.preconditions };
    const input = descriptor.input as { frameId?: string };
    if (preconditions.frameRevision !== undefined && input.frameId) {
      const commits = this.ownFrameCommits.get(input.frameId);
      let revision = preconditions.frameRevision;
      while (commits?.has(revision + 1)) {
        const structure = commits.get(revision + 1)?.structureId;
        if (preconditions.structureId !== undefined && structure !== preconditions.structureId)
          break;
        revision++;
      }
      preconditions.frameRevision = revision;
    }
    if (preconditions.canvasRevision !== undefined) {
      let revision = preconditions.canvasRevision;
      while (this.ownCanvasCommits.has(revision + 1)) revision++;
      preconditions.canvasRevision = revision;
    }
    return { ...descriptor, preconditions };
  }

  private async run(id: string) {
    const intent = this.intent(id);
    if (!intent) return;
    const epoch = this.epoch;
    try {
      if (await this.caps().then((caps) => caps === null)) return await this.runLegacy(intent);
      let token = intent.token;
      if (!token) {
        this.patchIntent(id, { phase: "preparing" });
        const prepared = await designApi.prepare(
          this.environmentId,
          this.rebase(intent.descriptor),
        );
        token = prepared.token;
        this.retryAt.delete(id);
        this.prepareBackoffMs = 0;
        // The token is persisted before execution; an unsaved token never runs automatically.
        this.patchIntent(id, { phase: "prepared", token });
        if (!this.persist()) {
          this.patchIntent(id, { held: true });
          this.notice(
            `${intent.label} could not be saved in this window; resume it to send`,
            "warning",
          );
          return;
        }
      }
      if (epoch !== this.epoch) return;
      this.patchIntent(id, { phase: "submitting" });
      const status = await designApi.execute(
        this.environmentId,
        this.canvasId,
        token,
        EXECUTE_WAIT_MS,
      );
      await this.follow(id, status);
    } catch (error) {
      const current = this.intent(id);
      if (!current) return;
      const kind = classifyTransportError(error);
      if (kind === "disconnected" || kind === "unauthorized") {
        if (!current.token) {
          // No execute was sent. Preparing again is idempotent by correlation id.
          // It stays unrunnable until its backoff elapses (see `runnable`).
          this.patchIntent(id, { phase: "draft" });
          this.deferRetry(id);
        } else {
          // Execution may or may not have been admitted: reconcile by status, never resend blindly.
          this.patchIntent(id, { phase: "admitted", outcome: "unknown" });
          this.persist();
          void this.reconcileToken(id);
        }
        return;
      }
      this.settle(id, {
        failure: failureOf(error),
        outcome: current.token ? "unknown" : "rejected",
      });
    }
  }

  /** Bounded exponential backoff with jitter; the timer is armed by `pump()`. */
  private deferRetry(id: string) {
    this.prepareBackoffMs = Math.min(
      MAX_BACKOFF_MS,
      this.prepareBackoffMs ? this.prepareBackoffMs * 2 : RETRY_BASE_MS,
    );
    this.retryAt.set(id, Date.now() + jitter(this.prepareBackoffMs));
  }

  private async follow(id: string, first: DesignOperationStatus) {
    let status = first;
    let delay = 500;
    while (!TERMINAL.has(status.state)) {
      if (status.state === "prepared") {
        // An execute request that never arrived; resending the same token is idempotent.
        status = await designApi.execute(
          this.environmentId,
          this.canvasId,
          status.token,
          EXECUTE_WAIT_MS,
        );
        continue;
      }
      this.patchIntent(id, { phase: "admitted", outcome: "executing" });
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(5000, delay * 2);
      status = await designApi.status(this.environmentId, this.canvasId, status.token);
    }
    this.settleStatus(id, status);
  }

  /**
   * Resolves a token whose outcome is not known by status, with backoff. A
   * `prepared` token is executed only when it is neither restored nor held; an
   * `unknown` outcome keeps being checked and is never re-prepared.
   * Stops while hidden; `activate()` and reconnects restart it.
   */
  private async reconcileToken(id: string) {
    if (this.reconciling.has(id)) return;
    this.reconciling.add(id);
    try {
      let delay = RETRY_BASE_MS;
      for (;;) {
        const intent = this.intent(id);
        if (!intent?.token || this.disposed || !this.visible) return;
        if (intent.phase === "settled" && intent.outcome !== "unknown") return;
        try {
          const status = await designApi.status(this.environmentId, this.canvasId, intent.token);
          const current = this.intent(id);
          if (!current) return;
          if (status.state === "committed" || status.state === "no-op") {
            this.settleStatus(id, status);
            if (current.restored)
              this.notice(`${current.label} was saved in the workspace`, "success");
            return;
          }
          if (status.state !== "unknown" && TERMINAL.has(status.state))
            return this.settleStatus(id, status);
          if (status.state === "prepared") {
            if (current.restored || current.held) return;
            const executed = await designApi.execute(
              this.environmentId,
              this.canvasId,
              intent.token,
              EXECUTE_WAIT_MS,
            );
            return await this.follow(id, executed);
          }
          if (current.phase !== "settled")
            this.patchIntent(id, {
              phase: "admitted",
              outcome: status.state === "unknown" ? "unknown" : "executing",
            });
        } catch (error) {
          const kind = classifyTransportError(error);
          if (kind !== "disconnected" && kind !== "unauthorized") {
            return this.settle(id, { failure: failureOf(error), outcome: "unknown" });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, jitter(delay)));
        delay = Math.min(MAX_BACKOFF_MS, delay * 2);
      }
    } finally {
      this.reconciling.delete(id);
    }
  }

  /** Reconciles every token whose outcome is unresolved and that no run owns. */
  private reconcilePending() {
    for (const intent of this.projection.intents) {
      if (!intent.token || intent.held || this.running.has(intent.id)) continue;
      const unresolved =
        intent.phase === "admitted" ||
        intent.phase === "submitting" ||
        (intent.phase === "settled" && intent.outcome === "unknown") ||
        (intent.restored && intent.phase !== "settled");
      if (unresolved) void this.reconcileToken(intent.id);
    }
  }

  private settleStatus(id: string, status: DesignOperationStatus) {
    if (status.state === "committed" && status.result) {
      const generation = this.projection.generation;
      if (generation !== undefined && this.commitsGeneration !== generation) {
        this.ownFrameCommits.clear();
        this.ownCanvasCommits.clear();
        this.commitsGeneration = generation;
      }
      for (const frame of status.result.frames) {
        if (frame.removed) {
          this.ownFrameCommits.delete(frame.frameId);
          continue;
        }
        const commits = this.ownFrameCommits.get(frame.frameId) ?? new Map<number, OwnCommit>();
        commits.set(frame.revision, {
          structureId: frame.identity?.structureId,
          contentId: frame.identity?.contentId,
          canvasRevision: status.result.canvasRevision,
        });
        this.ownFrameCommits.set(frame.frameId, commits);
      }
      this.ownCanvasCommits.add(status.result.canvasRevision);
    }
    if (status.state === "committed" || status.state === "no-op") {
      const revision = status.result?.canvasRevision ?? this.projection.revision;
      this.patchIntent(id, {
        phase: "settled",
        outcome: status.state,
        result: status.result,
        awaitRevision: revision,
        failure: undefined,
      });
      this.persist();
      void this.refresh();
      return;
    }
    this.settle(id, {
      outcome: status.state,
      failure: status.failure ?? {
        code: status.state === "canceled" ? "unknown-outcome" : "unknown-outcome",
        message: `This edit was ${status.state}`,
        retry: "review",
      },
    });
  }

  private settle(id: string, result: { outcome: DesignIntent["outcome"]; failure: DesignFailure }) {
    const intent = this.intent(id);
    if (!intent) return;
    this.update((projection) => ({
      ...projection,
      intents: projection.intents.map((candidate) => {
        if (candidate.id === id)
          return {
            ...candidate,
            phase: "settled",
            outcome: result.outcome,
            failure: result.failure,
          };
        // Dependent edits in the same lane pause until this one is reviewed. A
        // restored edit's failure pauses only other restored edits.
        if (
          candidate.lane === intent.lane &&
          candidate.phase === "draft" &&
          candidate.createdAt >= intent.createdAt &&
          (!intent.restored || candidate.restored)
        )
          return { ...candidate, blocked: true };
        return candidate;
      }),
    }));
    this.persist();
    this.notice(`${intent.label}: ${result.failure.message}`, "warning");
    void this.refresh();
  }

  /** Drops successful intents once their committed revision is installed. */
  private prune() {
    const revision = this.projection.revision;
    const before = this.projection.intents.length;
    this.update((projection) => ({
      ...projection,
      intents: projection.intents.filter(
        (intent) => !(settledOk(intent) && (intent.awaitRevision ?? 0) <= revision),
      ),
    }));
    if (this.projection.intents.length !== before) {
      this.persist();
      this.pump();
    }
  }

  /** Unblocks lane intents that no longer have an unreviewed failure ahead of them. */
  private unblockLane(lane: string) {
    this.update((projection) => {
      let failedAhead = false;
      let restoredFailedAhead = false;
      return {
        ...projection,
        intents: projection.intents.map((intent) => {
          if (intent.lane !== lane) return intent;
          if (intent.phase === "settled" && !settledOk(intent)) {
            if (intent.restored) restoredFailedAhead = true;
            else failedAhead = true;
            return intent;
          }
          const held = failedAhead || (intent.restored && restoredFailedAhead);
          return intent.blocked && !held ? { ...intent, blocked: false } : intent;
        }),
      };
    });
  }

  /** Clears local intent. Accepted backend work is not claimed canceled. */
  async discard(id: string) {
    const intent = this.intent(id);
    if (!intent) return;
    if (
      intent.token &&
      (intent.phase === "prepared" || (intent.restored && intent.outcome === undefined))
    ) {
      await designApi
        .cancel(this.environmentId, this.canvasId, intent.token)
        .catch(() => undefined);
    }
    this.retryAt.delete(id);
    this.update((projection) => ({
      ...projection,
      intents: projection.intents.filter((candidate) => candidate.id !== id),
    }));
    this.unblockLane(intent.lane);
    this.persist();
    if (intent.phase === "admitted")
      this.notice("Removed from this window. The backend may still finish that edit.", "info");
    this.pump();
  }

  /** Cancel-before-execution: only a prepared, not yet executing token can be canceled. */
  async cancelQueued(id: string) {
    const intent = this.intent(id);
    if (!intent) return;
    if (!intent.token || intent.phase === "draft") return this.discard(id);
    try {
      const status = await designApi.cancel(this.environmentId, this.canvasId, intent.token);
      if (status.state === "canceled") return this.discard(id);
      this.settleStatus(id, status);
    } catch (error) {
      this.notice(failureOf(error).message, "warning");
    }
  }

  /**
   * Explicitly resumes a draft, a held or restored token, or a retryable failure
   * with its ORIGINAL base. `rebaseTo` supplies a reviewed replacement
   * precondition (e.g. apply a geometry change to the current frame after the
   * user confirmed it).
   *
   * A token is kept unless its outcome proves it never ran (rejected, canceled,
   * interrupted, expired): an unknown or in-flight outcome keeps reconciling and
   * is never prepared again.
   */
  resume(id: string, rebaseTo?: DesignOperationDescriptor["preconditions"]) {
    const intent = this.intent(id);
    if (!intent || settledOk(intent)) return;
    this.retryAt.delete(id);
    const notRun = intent.outcome !== undefined && NOT_RUN.has(intent.outcome);
    const cleared = { failure: undefined, restored: false, held: false, blocked: false } as const;
    if (intent.token && !notRun) {
      const inFlight =
        intent.phase === "admitted" ||
        intent.phase === "submitting" ||
        intent.phase === "settled" ||
        intent.outcome !== undefined;
      if (inFlight) {
        this.patchIntent(id, {
          ...cleared,
          phase: "admitted",
          outcome: intent.outcome === "executing" ? "executing" : "unknown",
        });
        this.unblockLane(intent.lane);
        this.persist();
        void this.reconcileToken(id);
        return;
      }
      // Prepared but never sent: executing the same token is idempotent.
      this.patchIntent(id, { ...cleared, phase: "draft", outcome: undefined });
    } else {
      const fresh = `i-${createUuid()}`;
      const descriptor: DesignOperationDescriptor = {
        ...intent.descriptor,
        correlationId: fresh,
        ...(rebaseTo ? { preconditions: rebaseTo } : {}),
      };
      this.patchIntent(id, {
        ...cleared,
        descriptor,
        token: undefined,
        phase: "draft",
        outcome: undefined,
      });
    }
    this.unblockLane(intent.lane);
    this.persist();
    this.pump();
  }

  private async runLegacy(intent: DesignIntent) {
    const input = intent.descriptor.input;
    const pre = intent.descriptor.preconditions;
    const map: Record<string, () => Promise<unknown>> = {
      update_frame: () =>
        designAction(this.environmentId, "update_frame", {
          canvasId: this.canvasId,
          frameId: (input as { frameId: string }).frameId,
          expectedRevision: pre.frameRevision,
          patch: (input as { patch: unknown }).patch,
        }),
      set_element_styles: () =>
        designAction(this.environmentId, "set_element_styles", {
          canvasId: this.canvasId,
          frameId: (input as { frameId: string }).frameId,
          expectedRevision: pre.frameRevision,
          selector: (input as { selector: string }).selector,
          styles: (input as { styles: unknown }).styles,
        }),
      create_frame: () =>
        designAction(this.environmentId, "create_frame", {
          canvasId: this.canvasId,
          expectedRevision: pre.canvasRevision,
          ...(input as { frame: object }).frame,
        }),
      undo: () =>
        designAction(this.environmentId, "undo", {
          canvasId: this.canvasId,
          expectedRevision: pre.canvasRevision,
        }),
      redo: () =>
        designAction(this.environmentId, "redo", {
          canvasId: this.canvasId,
          expectedRevision: pre.canvasRevision,
        }),
    };
    const action = map[input.kind];
    if (!action) {
      this.settle(intent.id, {
        outcome: "rejected",
        failure: {
          code: "unsupported",
          message: "Update the backend to use this action",
          retry: "never",
        },
      });
      return;
    }
    this.patchIntent(intent.id, { phase: "submitting" });
    try {
      await action();
      this.patchIntent(intent.id, {
        phase: "settled",
        outcome: "committed",
        awaitRevision: this.projection.revision + 1,
      });
      await this.refresh();
      this.prune();
    } catch (error) {
      this.settle(intent.id, { outcome: "rejected", failure: failureOf(error) });
    }
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  async exportSave(
    relativePath: string,
    revision: number,
    replaceFingerprint?: string,
  ): Promise<DesignExportReceipt> {
    this.update((projection) => ({ ...projection, busy: { ...projection.busy, export: true } }));
    try {
      const receipt = await designApi.exportSave(
        this.environmentId,
        this.canvasId,
        relativePath,
        revision,
        replaceFingerprint,
      );
      this.notice(`Exported revision ${receipt.revision} to ${receipt.relativePath}`, "success");
      void this.refresh();
      return receipt;
    } finally {
      this.update((projection) => ({ ...projection, busy: { ...projection.busy, export: false } }));
    }
  }

  /** Waits for this client's in-flight edits to settle (bounded), then refreshes. */
  async settleEdits(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = this.projection.intents.some(
        (intent) =>
          intent.phase !== "settled" && !intent.restored && !intent.held && !intent.blocked,
      );
      if (!pending) {
        await this.refresh();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
  }
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

const controllers = new Map<string, DesignCanvasController>();

export function designController(environmentId: string, canvasId: string): DesignCanvasController {
  const backend = designBackendKey();
  const key = `${backend}|${environmentId}|${canvasId}`;
  let controller = controllers.get(key);
  if (!controller || controller.isDisposed) {
    controller = new DesignCanvasController(backend, environmentId, canvasId);
    controllers.set(key, controller);
  }
  controller.lastUsed = Date.now();
  return controller;
}

let evictionTimer: ReturnType<typeof setTimeout> | undefined;

/** Coalesced, deferred eviction: runs after the releasing render could acquire another view. */
function scheduleEviction() {
  if (evictionTimer !== undefined) return;
  evictionTimer = setTimeout(() => {
    evictionTimer = undefined;
    evictInactive();
  }, 0);
}

/** Evicts clean inactive projections by count and bytes; drafts are never evicted. */
export function evictInactive() {
  const inactive = Array.from(controllers.values())
    .filter((controller) => !controller.visible)
    .sort((a, b) => a.lastUsed - b.lastUsed);
  let bytes = inactive.reduce((total, controller) => total + controller.approximateBytes(), 0);
  let count = inactive.length;
  for (const controller of inactive) {
    if (count <= MAX_INACTIVE_PROJECTIONS && bytes <= MAX_INACTIVE_BYTES) break;
    if (!controller.clean) continue;
    bytes -= controller.approximateBytes();
    count--;
    controllers.delete(controller.key);
    controller.dispose();
  }
}

/** Test helper: dispose every controller. */
export function resetDesignControllers() {
  clearTimeout(evictionTimer);
  evictionTimer = undefined;
  for (const controller of Array.from(controllers.values())) controller.dispose();
  controllers.clear();
}

export function useDesignCanvas(environmentId: string, canvasId: string, active: boolean) {
  // Re-resolved on activation: an evicted (disposed) controller is replaced by
  // a fresh one. `active` is deliberately a dependency for that reason.
  // `renewal` re-resolves when the resolved controller was evicted meanwhile.
  const [renewal, setRenewal] = useState(0);
  /* oxlint-disable react-hooks/exhaustive-deps */
  const controller = useMemo(
    () => designController(environmentId, canvasId),
    [environmentId, canvasId, active, renewal],
  );
  /* oxlint-enable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!active) return;
    if (controller.isDisposed) {
      setRenewal((value) => value + 1);
      return;
    }
    return controller.acquire();
  }, [active, controller]);
  const projection = useDesignStore((state) => state.projections.get(controller.key));
  return { controller, projection };
}
