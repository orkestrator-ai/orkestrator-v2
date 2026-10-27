/**
 * ChangeTrackingService: composition root of backend change tracking.
 *
 * One instance per backend. It owns the ledger, the object and evidence
 * stores, the worktree registry, and every service that turns evidence and
 * captures into measurements and projections. Background work (evidence
 * pulls, captures, finalization, retention) runs here, independent of any
 * mounted client.
 *
 * See docs/architecture/change-tracking.md.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  ChangeEvidenceAckRequest,
  ChangeEvidenceReadResponse,
} from "@orkestrator/protocol/change-evidence";
import {
  parseChangeResourceKey,
  type CanonicalToolPresentation,
  type CanonicalTurnPresentation,
  type ChangeHistoryEntry,
  type ChangeProjection,
  type ChangesGetHistoryResult,
  type ChangesRefreshResult,
  type ChangeViewResult,
} from "@orkestrator/protocol/change-resources";
import type { DiffScanEvent } from "../diff-stats-service.js";
import type { NativeAgentChangeTrackingHooks } from "../native-agent-service-shared.js";
import type { StorageDatabase } from "../storage-database.js";
import { encodePath } from "./capture.js";
import { ChangeLedger } from "./change-ledger.js";
import { DiffBodyService } from "./diff-bodies.js";
import { EnvironmentChangeProjector } from "./environment-projector.js";
import { EvidenceBodyStore } from "./evidence-body-store.js";
import { GitScopeService, isGitScope } from "./git-scopes.js";
import { ProviderEvidenceIngress, type IngestResult } from "./evidence-ingestion.js";
import { ChangeHandoffSerializer } from "./handoff.js";
import {
  operationIdFor,
  operationVolumeResourceKey,
  providerTurnIdFor,
  threadIdFor,
  toolResourceKeys,
  turnResourceKeys,
} from "./identities.js";
import { ChangeMeasurementService } from "./measurement-service.js";
import { ObjectStore } from "./object-store.js";
import { ChangeTrackingPolicyRegistry, type ChangeTrackingPolicy } from "./policy-registry.js";
import { ChangeProjectionService } from "./projection-service.js";
import { ChangeResourcePublisher } from "./publisher.js";
import { ChangeRestoreService } from "./restore.js";
import { ChangeRetentionService } from "./retention.js";
import {
  TurnBoundaryService,
  turnIdFor,
  type TurnContext,
  type TurnStartResult,
} from "./turn-boundaries.js";
import { RemoteSlots, WorktreeRegistry, type WorktreeTarget } from "./worktree-owner.js";

const MUTATING_TOOL_KINDS = new Set([
  "shell",
  "file-edit",
  "file-write",
  "file-delete",
  "file-move",
  "notebook-edit",
  "other",
]);
const EVIDENCE_UNSUPPORTED_RECHECK_MS = 5 * 60_000;
const RETENTION_INTERVAL_MS = 60 * 60_000;
/** The first retention pass, soon after start so a backlog is not left for an hour. */
const FIRST_RETENTION_DELAY_MS = 2 * 60_000;

/** One producer of canonical evidence (a bridge connection). */
export interface EvidenceSource {
  /** Physical producer identity; a new connection identity resets the cursor. */
  sourceKey: string;
  environmentId: string;
  provider: string;
  read(cursor: number, epoch: string | null): Promise<ChangeEvidenceReadResponse | "unsupported">;
  body(id: string): Promise<Uint8Array | null>;
  ack(request: ChangeEvidenceAckRequest): Promise<void>;
}

export interface ChangeTrackingServiceOptions {
  dataDir: string;
  database: () => StorageDatabase;
  emit: (event: string, payload: unknown) => void;
  /** Resolve an environment to the worktree its agents write. */
  environmentTarget: (environmentId: string) => Promise<WorktreeTarget | null>;
  /** Map a provider conversation to the logical session (tab) that owns it. */
  threadForConversation?: (
    environmentId: string,
    provider: string,
    conversationId: string,
  ) => string | null;
  /** Ask the environment scan owner for a fresh observation. */
  requestEnvironmentRefresh?: (environmentId: string) => void;
  /** The branch an environment's pull request targets (pull-request scope). */
  prBaseBranch?: (environmentId: string) => Promise<string | null>;
  policy?: Partial<ChangeTrackingPolicy>;
  durable?: boolean;
  /** Disable timers (tests drive work explicitly). */
  manualScheduling?: boolean;
}

export class ChangeTrackingService {
  readonly ledger: ChangeLedger;
  readonly objects: ObjectStore;
  readonly bodies: EvidenceBodyStore;
  readonly policies: ChangeTrackingPolicyRegistry;
  readonly registry: WorktreeRegistry;
  readonly ingestion: ProviderEvidenceIngress;
  readonly measurements: ChangeMeasurementService;
  readonly projections: ChangeProjectionService;
  readonly publisher: ChangeResourcePublisher;
  readonly environments: EnvironmentChangeProjector;
  readonly turns: TurnBoundaryService;
  readonly diffBodies: DiffBodyService;
  readonly handoff: ChangeHandoffSerializer;
  readonly restore: ChangeRestoreService;
  readonly retention: ChangeRetentionService;
  readonly gitScopes: GitScopeService;
  readonly generation = randomUUID();
  private readonly pulls = new Map<string, Promise<number>>();
  /** Last evidence source seen per environment and provider, for turn-end pulls. */
  private readonly sources = new Map<string, EvidenceSource>();
  private readonly unsupported = new Map<string, number>();
  private readonly turnFinalizations = new Map<string, Promise<string[]>>();
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private firstRetentionTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly closeListeners: Array<() => void> = [];
  private readonly startListeners: Array<() => void> = [];
  private started = false;
  private stopped = false;

  constructor(private readonly options: ChangeTrackingServiceOptions) {
    const root = path.join(options.dataDir, "change-tracking");
    this.ledger = new ChangeLedger(options.database);
    this.objects = new ObjectStore({
      root: path.join(root, "objects"),
      durable: options.durable,
      hardBudgetBytes: () => this.policies.policy.snapshotHardBudgetBytes,
    });
    this.bodies = new EvidenceBodyStore(
      path.join(root, "evidence-bodies"),
      options.durable ?? true,
    );
    this.policies = new ChangeTrackingPolicyRegistry(options.policy);
    const policy = () => this.policies.policy;
    this.registry = new WorktreeRegistry({
      ledger: this.ledger,
      store: this.objects,
      remoteSlots: new RemoteSlots(policy().remoteCaptureSlots),
      idleGraceMs: policy().idleOwnerGraceMs,
      limits: {
        maxCandidates: policy().captureMaxCandidates,
        maxFileBytes: policy().captureMaxFileBytes,
        maxCaptureBytes: policy().captureMaxBytes,
        readers: policy().captureReaders,
        stableReadAttempts: policy().stableReadAttempts,
      },
    });
    this.ingestion = new ProviderEvidenceIngress(this.ledger, this.bodies);
    this.measurements = new ChangeMeasurementService(this.ledger, this.bodies, this.objects);
    this.projections = new ChangeProjectionService(this.ledger, this.generation, {
      restoreEnabled: policy().restoreEnabled,
    });
    this.publisher = new ChangeResourcePublisher(this.ledger, this.projections, options.emit);
    this.turns = new TurnBoundaryService({
      ledger: this.ledger,
      registry: this.registry,
      measurements: this.measurements,
      policies: this.policies,
      onPublished: () => this.publisher.drainOutbox(),
    });
    this.environments = new EnvironmentChangeProjector({
      measurements: this.measurements,
      projections: this.projections,
      registry: this.registry,
      announcer: this.publisher,
      liveBodyCoalesceMs: policy().liveBodyCoalesceMs,
      onWorktreeActivity: (environmentId, paths) => this.noteWorktreeActivity(environmentId, paths),
    });
    this.diffBodies = new DiffBodyService({
      ledger: this.ledger,
      store: this.objects,
      bodies: this.bodies,
      measurements: this.measurements,
      projections: this.projections,
      registry: this.registry,
      environmentTarget: options.environmentTarget,
      batchBytes: policy().diffBatchBytes,
    });
    this.handoff = new ChangeHandoffSerializer(this.ledger);
    this.gitScopes = new GitScopeService({
      measurements: this.measurements,
      projections: this.projections,
      registry: this.registry,
      environmentTarget: options.environmentTarget,
      prBaseBranch: options.prBaseBranch,
      announce: (resourceKey) => this.publisher.announce(resourceKey),
    });
    this.retention = new ChangeRetentionService({
      ledger: this.ledger,
      store: this.objects,
      policies: this.policies,
      readerPins: () => this.diffBodies.readerPins.keys(),
    });
    this.restore = new ChangeRestoreService({
      ledger: this.ledger,
      store: this.objects,
      registry: this.registry,
      enabled: () => policy().restoreEnabled,
      tokenTtlMs: () => policy().restoreTokenTtlMs,
      onApplied: (_worktreeId, environmentId) => {
        if (environmentId) options.requestEnvironmentRefresh?.(environmentId);
      },
    });
  }

  /** Startup reconciliation, outbox recovery and the retention timer. */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.ledger.transaction(() => this.ledger.recoverRestoreOperations());
      this.turns.reconcileAfterRestart();
      this.publisher.drainOutbox();
    } catch (error) {
      console.warn(
        "[change-tracking] startup reconciliation failed:",
        error instanceof Error ? error.message : error,
      );
    }
    for (const listener of this.startListeners.splice(0)) listener();
    if (!this.options.manualScheduling) {
      const retain = () => {
        void this.retention.run().catch(() => undefined);
        this.registry.sweepIdle();
      };
      this.firstRetentionTimer = setTimeout(retain, FIRST_RETENTION_DELAY_MS);
      this.firstRetentionTimer.unref?.();
      this.retentionTimer = setInterval(retain, RETENTION_INTERVAL_MS);
      this.retentionTimer.unref?.();
    }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.firstRetentionTimer) clearTimeout(this.firstRetentionTimer);
    this.firstRetentionTimer = null;
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
    for (const listener of this.closeListeners.splice(0)) {
      try {
        listener();
      } catch {
        // Closing is best effort.
      }
    }
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onStart(listener: () => void): void {
    if (this.started) listener();
    else this.startListeners.push(listener);
  }

  /** Adapter for `NativeAgentServiceOptions.changeTracking`. */
  nativeAgentHooks(): NativeAgentChangeTrackingHooks {
    return {
      prepareTurnStart: (context) => this.prepareTurnStart(context),
      markTurnDispatched: (environmentId, logicalSessionKey, requestId, outcome) =>
        this.markTurnDispatched(environmentId, logicalSessionKey, requestId, outcome),
      noteProviderObserved: (provider, environmentId) => {
        const source = provider.changeEvidenceSource?.(environmentId);
        if (source) void this.pullEvidence(source);
      },
      noteFork: (input) => this.noteFork(input),
    };
  }

  /** Listener for the environment scan owner (`DiffStatsService.onScanEvent`). */
  readonly onDiffScanEvent = (event: DiffScanEvent): void => {
    if (this.stopped) return;
    this.environments.handle(event);
    if (event.kind === "scanned") this.gitScopes.invalidate(event.target.environmentId);
    else if (event.kind === "removed") this.gitScopes.forget(event.environmentId);
  };

  /** Compute on-demand resources (Git scopes) before their first read. */
  async ensureResource(resourceKey: string): Promise<void> {
    const parts = parseChangeResourceKey(resourceKey);
    if (!parts || !isGitScope(parts.scope)) return;
    if (this.ledger.selection(resourceKey) && parts.selector === "pinned") return;
    await this.gitScopes.ensure(resourceKey);
    this.publisher.drainOutbox();
  }

  private noteWorktreeActivity(environmentId: string, paths: readonly string[] | null): void {
    void (async () => {
      const target = await this.options.environmentTarget(environmentId);
      const identity = target ? await this.registry.resolve(target) : null;
      if (!identity) return;
      const owner = this.registry.owner(identity);
      // Known paths invalidate only their cached stats; an unknown or
      // overflowing burst invalidates every reuse.
      owner.invalidate(
        paths ? paths.map((path) => encodePath(new TextEncoder().encode(path))) : undefined,
      );
      const keys = await this.turns.provisional(environmentId, owner);
      if (keys.length > 0) this.publisher.drainOutbox();
    })().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  /**
   * Called inside the dispatch window, before `provider.send`. Bounded by the
   * foreground boundary deadline; never throws.
   */
  async prepareTurnStart(
    context: Omit<TurnContext, "target"> & {
      target?: WorktreeTarget | null;
      providerSessionId?: string;
    },
  ): Promise<TurnStartResult> {
    try {
      await this.turnFinalizations.get(
        threadIdFor(context.environmentId, context.logicalSessionKey),
      );
      if (context.providerSessionId)
        this.rememberConversation(
          context.environmentId,
          context.provider,
          context.providerSessionId,
          context.logicalSessionKey,
        );
      const target =
        context.target === undefined
          ? await this.options.environmentTarget(context.environmentId)
          : context.target;
      const inheritedFrom = context.providerSessionId
        ? this.ledger.meta(
            `fork:${context.environmentId}\0${context.provider}\0${context.providerSessionId}`,
          )
        : null;
      return await this.turns.prepareTurnStart({ ...context, target, inheritedFrom });
    } catch (error) {
      console.warn(
        "[change-tracking] turn start capture failed:",
        error instanceof Error ? error.message : error,
      );
      return { kind: "untracked", reason: "change-tracking-error" };
    }
  }

  /**
   * Record fork lineage. The child's first segment references the parent's
   * current segment as its inherited prefix; its own baseline is still
   * captured fresh when it first executes.
   */
  noteFork(input: {
    environmentId: string;
    provider: string;
    parentLogicalSessionKey: string;
    childProviderSessionId: string;
  }): void {
    const parent = this.ledger.currentSegment(
      threadIdFor(input.environmentId, input.parentLogicalSessionKey),
    );
    if (!parent) return;
    this.ledger.transaction(() =>
      this.ledger.setMeta(
        `fork:${input.environmentId}\0${input.provider}\0${input.childProviderSessionId}`,
        parent.segment_id,
      ),
    );
  }

  /** Durable provider-conversation → logical session (thread) association. */
  rememberConversation(
    environmentId: string,
    provider: string,
    conversationId: string,
    logicalSessionKey: string,
  ): void {
    const key = `conv:${environmentId}\0${provider}\0${conversationId}`;
    if (this.ledger.meta(key) === logicalSessionKey) return;
    this.ledger.transaction(() => this.ledger.setMeta(key, logicalSessionKey));
  }

  private conversationThread(
    environmentId: string,
    provider: string,
    conversationId: string,
  ): string | null {
    return (
      this.ledger.meta(`conv:${environmentId}\0${provider}\0${conversationId}`) ??
      this.options.threadForConversation?.(environmentId, provider, conversationId) ??
      null
    );
  }

  markTurnDispatched(
    environmentId: string,
    logicalSessionKey: string,
    requestId: string,
    outcome: "accepted" | "rejected" | "uncertain",
  ): void {
    try {
      this.turns.markDispatched(turnIdFor(environmentId, logicalSessionKey, requestId), outcome);
    } catch (error) {
      console.warn(
        "[change-tracking] dispatch record failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** Turn-end hook (the activity transition to idle). Serialized per thread. */
  finalizeTurn(input: {
    environmentId: string;
    logicalSessionKey: string;
    requestId?: string | null;
    writersSettled?: boolean;
  }): Promise<string[]> {
    const key = threadIdFor(input.environmentId, input.logicalSessionKey);
    // Select synchronously at the idle edge, before evidence I/O or queue drains.
    const ending = input.requestId
      ? this.ledger.turn(turnIdFor(input.environmentId, input.logicalSessionKey, input.requestId))
      : this.turns.activeTurn(input.environmentId, input.logicalSessionKey);
    if (!ending) return Promise.resolve([]);
    const previous = this.turnFinalizations.get(key) ?? Promise.resolve([]);
    const next = previous
      .catch(() => [])
      .then(async () => {
        // Take in the provider's latest frames (its terminal turn report and
        // background tasks) before deciding whether writers settled.
        await this.pullPendingEvidence(input.environmentId);
        return this.turns.finalizeTurn({
          environmentId: input.environmentId,
          logicalSessionKey: input.logicalSessionKey,
          turnId: ending.turn_id,
          writersSettled: input.writersSettled ?? this.writersSettled(ending.turn_id),
          terminalEvidence: "activity-idle",
        });
      })
      .then((keys) => {
        this.publisher.drainOutbox();
        return keys;
      })
      .catch((error) => {
        console.warn(
          "[change-tracking] turn finalization failed:",
          error instanceof Error ? error.message : error,
        );
        return [] as string[];
      })
      .finally(() => {
        if (this.turnFinalizations.get(key) === next) this.turnFinalizations.delete(key);
      });
    this.turnFinalizations.set(key, next);
    return next;
  }

  private async pullPendingEvidence(environmentId: string): Promise<void> {
    const pulls = [...this.sources.values()]
      .filter((source) => source.environmentId === environmentId)
      .map((source) => this.pullEvidence(source));
    if (pulls.length === 0) return;
    await Promise.race([
      Promise.all(pulls),
      new Promise((resolve) => setTimeout(resolve, 3_000).unref?.()),
    ]);
  }

  /**
   * A terminal provider turn that still reports `may-write`, or a background
   * task not yet reported terminal, means known writers have not settled:
   * the turn then finalizes as interrupted, never silently final. A
   * background task's terminal report counts only when its provider declares
   * background completion observable; a launch-only report cannot prove the
   * detached process stopped.
   */
  private writersSettled(turnId: string | null): boolean {
    if (!turnId) return true;
    const operations = (JSON.parse(this.ledger.meta(`turnops:${turnId}`) ?? "[]") as string[])
      .map((id) => this.ledger.operation(id))
      .filter((row): row is NonNullable<typeof row> => row !== null);
    const terminal = new Set(["succeeded", "failed", "cancelled"]);
    for (const op of operations) {
      if (
        op.tool_kind === "turn" &&
        terminal.has(op.phase) &&
        op.execution_occurrence === "may-write"
      )
        return false;
      if (op.tool_kind === "background-task") {
        if (!terminal.has(op.phase)) return false;
        const capabilities = op.capability_revision
          ? this.ledger.capabilities(op.capability_revision)
          : null;
        const completion = capabilities
          ? (JSON.parse(capabilities) as { backgroundCompletion?: string }).backgroundCompletion
          : undefined;
        if (completion !== "observable") return false;
      }
    }
    return true;
  }

  /**
   * Settle interrupted turns whose last unresolved writer just reported
   * terminal (acceptance H13). The settlement appends a superseding
   * `later-recovery` measurement; the interrupted one stays retrievable.
   */
  private async settleInterruptedTurns(operationIds: Iterable<string>): Promise<void> {
    const turnIds = new Set<string>();
    for (const operationId of operationIds) {
      const turnId = this.ledger.meta(`opturn:${operationId}`);
      if (turnId && this.ledger.turn(turnId)?.lifecycle === "interrupted") turnIds.add(turnId);
    }
    for (const turnId of turnIds) {
      if (!this.writersSettled(turnId)) continue;
      await this.turns.settleInterrupted(turnId).catch((error) => {
        console.warn(
          "[change-tracking] late turn settlement failed:",
          error instanceof Error ? error.message : error,
        );
      });
    }
  }

  // -------------------------------------------------------------------------
  // Evidence
  // -------------------------------------------------------------------------

  /**
   * Pull, durably ingest and acknowledge one producer's evidence. Single
   * flight per producer; a bridge without the route is rechecked later.
   */
  pullEvidence(source: EvidenceSource): Promise<number> {
    this.sources.set(`${source.environmentId}\0${source.provider}`, source);
    if (this.sources.size > 1_024) {
      const oldest = this.sources.keys().next().value;
      if (oldest !== undefined) this.sources.delete(oldest);
    }
    const pending = this.pulls.get(source.sourceKey);
    if (pending) return pending;
    const unsupportedAt = this.unsupported.get(source.sourceKey);
    if (
      unsupportedAt !== undefined &&
      Date.now() - unsupportedAt < EVIDENCE_UNSUPPORTED_RECHECK_MS
    ) {
      return Promise.resolve(0);
    }
    const run = this.pullNow(source)
      .catch((error) => {
        console.warn(
          "[change-tracking] evidence pull failed:",
          error instanceof Error ? error.message : error,
        );
        return 0;
      })
      .finally(() => this.pulls.delete(source.sourceKey));
    this.pulls.set(source.sourceKey, run);
    return run;
  }

  private async pullNow(source: EvidenceSource): Promise<number> {
    let total = 0;
    const ackKey = `pending-evidence-ack:${source.sourceKey}`;
    const retryAck = async (): Promise<boolean> => {
      const pending = this.ledger.meta(ackKey);
      if (!pending) return true;
      try {
        const request = JSON.parse(pending) as Parameters<EvidenceSource["ack"]>[0];
        do {
          const retainedBodyIds = request.retainedBodyIds.slice(0, 10_000);
          const unavailableBodyIds = request.unavailableBodyIds.slice(0, 10_000);
          await source.ack({ ...request, retainedBodyIds, unavailableBodyIds });
          request.retainedBodyIds = request.retainedBodyIds.slice(retainedBodyIds.length);
          request.unavailableBodyIds = request.unavailableBodyIds.slice(unavailableBodyIds.length);
          this.ledger.transaction(() =>
            this.ledger.setMeta(
              ackKey,
              request.retainedBodyIds.length || request.unavailableBodyIds.length
                ? JSON.stringify(request)
                : "",
            ),
          );
        } while (request.retainedBodyIds.length || request.unavailableBodyIds.length);
        return true;
      } catch {
        return false;
      }
    };
    if (!(await retryAck())) return 0;
    for (let round = 0; round < 8 && !this.stopped; round++) {
      const cursor = this.ledger.cursor(source.sourceKey);
      const response = await source.read(cursor?.cursor ?? 0, cursor?.runtimeEpoch ?? null);
      if (response === "unsupported") {
        this.unsupported.set(source.sourceKey, Date.now());
        return total;
      }
      this.unsupported.delete(source.sourceKey);
      const startCursor =
        cursor && cursor.runtimeEpoch === response.runtimeEpoch ? cursor.cursor : 0;
      const fresh = response.entries.filter((entry) => entry.seq > startCursor);
      if (fresh.length === 0) {
        if (cursor?.runtimeEpoch === response.runtimeEpoch)
          await source
            .ack({
              runtimeEpoch: cursor.runtimeEpoch,
              upTo: cursor.cursor,
              retainedBodyIds: [],
              unavailableBodyIds: [],
            })
            .catch(() => undefined);
        if (!cursor || cursor.runtimeEpoch !== response.runtimeEpoch) {
          this.ledger.transaction(() =>
            this.ledger.setCursor(source.sourceKey, response.runtimeEpoch, response.nextCursor),
          );
        }
        return total;
      }
      const target = await this.options.environmentTarget(source.environmentId);
      const identity = target ? await this.registry.resolve(target).catch(() => null) : null;
      const result = await this.ingestion.ingest(
        {
          sourceKey: source.sourceKey,
          environmentId: source.environmentId,
          provider: source.provider,
          worktreeId: identity?.worktreeId ?? null,
        },
        fresh,
        response.capabilities,
        (id) => source.body(id),
      );
      // Cursor and body dispositions commit together. A failed acknowledgment
      // is retried before the next read, including after process restart.
      const ack = {
        runtimeEpoch: response.runtimeEpoch,
        upTo: response.nextCursor,
        retainedBodyIds: [...new Set(result.retainedBodyIds)],
        unavailableBodyIds: [...new Set(result.unavailableBodyIds)],
      };
      this.ledger.transaction(() => {
        this.ledger.setCursor(source.sourceKey, response.runtimeEpoch, response.nextCursor);
        this.ledger.setMeta(ackKey, JSON.stringify(ack));
      });
      const acknowledged = await retryAck();
      await this.afterIngest(
        source,
        result,
        identity ? { worktreeId: identity.worktreeId, incarnation: identity.incarnation } : null,
      );
      total += fresh.length;
      if (!acknowledged) break;
      if (response.entries.length < this.policies.policy.evidencePullEntries) break;
    }
    return total;
  }

  private async afterIngest(
    source: { environmentId: string; provider: string },
    result: IngestResult,
    worktree: { worktreeId: string; incarnation: string } | null,
  ): Promise<void> {
    const owner = worktree ? this.registry.ownerById(worktree.worktreeId) : null;
    const volumeTurns = new Set<string>();
    for (const operationId of result.dirtyOperations) {
      const op = this.ledger.operation(operationId);
      if (!op) continue;
      // Associate live operations with the backend turn running in their
      // thread, for that turn's recorded edit activity.
      if (op.history_mode === "live") {
        let turnId = this.ledger.meta(`opturn:${operationId}`);
        if (!turnId) {
          const logical = this.conversationThread(
            source.environmentId,
            source.provider,
            op.conversation_id,
          );
          turnId = logical
            ? (this.turns.activeTurn(source.environmentId, logical)?.turn_id ?? null)
            : null;
          if (turnId) {
            const linked = turnId;
            this.ledger.transaction(() => {
              this.ledger.setMeta(`opturn:${operationId}`, linked);
              const members = new Set(
                JSON.parse(this.ledger.meta(`turnops:${linked}`) ?? "[]") as string[],
              );
              members.add(operationId);
              this.ledger.setMeta(`turnops:${linked}`, JSON.stringify([...members].slice(-2_000)));
            });
          }
        }
        if (turnId) volumeTurns.add(turnId);
      }
      let window: { overlap: string; beforeQuality: string; afterQuality: string } | null = null;
      if (owner && MUTATING_TOOL_KINDS.has(op.tool_kind) && op.history_mode === "live") {
        const windowId = `win_${operationId}`;
        const terminal = ["succeeded", "failed", "denied", "cancelled"].includes(op.phase);
        const existing = this.ledger.window(windowId);
        if (!existing && op.phase !== "proposed" && op.phase !== "awaiting-approval") {
          owner.openWindow({
            windowId,
            operationId,
            turnId: op.turn_id,
            beforeQuality: "prior-observation",
            beforeSnapshotId: null,
            openedSeq: op.first_seen_seq,
          });
        }
        if (terminal) {
          owner.closeWindow({
            windowId,
            afterQuality: "after-terminal",
            afterSnapshotId: null,
            closedSeq: op.updated_seq,
            lifecycle: op.phase === "denied" ? "discarded" : "closed",
          });
        }
        const row = this.ledger.window(windowId);
        if (row)
          window = {
            overlap: row.overlap,
            beforeQuality: row.before_quality,
            afterQuality: row.after_quality,
          };
      }
      await this.measurements.recomputeOperation(operationId, worktree, window).catch((error) => {
        console.warn(
          "[change-tracking] tool measurement failed:",
          error instanceof Error ? error.message : error,
        );
      });
    }
    this.publishVolumes(volumeTurns, source.environmentId, worktree);
    await this.settleInterruptedTurns(result.dirtyOperations);
    for (const providerTurnId of result.dirtyProviderTurns) {
      const evidence = this.ledger.selectedEvidence("provider-turn", providerTurnId)[0];
      if (!evidence) continue;
      const frame = this.ledger.frame(evidence.frame_key);
      void frame;
      const binding = this.ledger.binding(evidence.frame_key.split("\0")[0]!);
      const conversationId = binding?.conversation_id ?? "unknown";
      const logical = this.conversationThread(
        source.environmentId,
        source.provider,
        conversationId,
      );
      const active = logical ? this.turns.activeTurn(source.environmentId, logical) : null;
      const turnId = active?.turn_id ?? providerTurnId;
      if (active)
        this.ledger.transaction(() =>
          this.ledger.setMeta(`pturn:${active.turn_id}`, providerTurnId),
        );
      await this.measurements
        .recomputeProviderTurn(providerTurnId, {
          environmentId: source.environmentId,
          conversationId,
          turnId,
          worktreeId: worktree?.worktreeId ?? `unresolved:${source.environmentId}`,
          incarnation: worktree?.incarnation ?? "unknown",
        })
        .catch(() => null);
    }
    this.publisher.drainOutbox();
  }

  /** Recorded edit activity per turn and per thread segment (never net). */
  private publishVolumes(
    turnIds: Iterable<string>,
    environmentId: string,
    fallback: { worktreeId: string; incarnation: string } | null,
  ): void {
    const operationsOf = (turnId: string) =>
      (JSON.parse(this.ledger.meta(`turnops:${turnId}`) ?? "[]") as string[])
        .map((id) => this.ledger.operation(id))
        .filter((row): row is NonNullable<typeof row> => row !== null);
    const segments = new Map<string, { worktreeId: string; incarnation: string }>();
    for (const turnId of turnIds) {
      const turn = this.ledger.turn(turnId);
      const row = turn ? this.ledger.worktree(turn.worktree_id) : null;
      const worktree = row
        ? { worktreeId: row.id, incarnation: row.incarnation }
        : (fallback ?? { worktreeId: `unresolved:${environmentId}`, incarnation: "unknown" });
      this.measurements.publishOperationVolume(
        { kind: "turn", id: turnId },
        operationsOf(turnId),
        worktree,
        environmentId,
      );
      if (turn) segments.set(turn.segment_id, worktree);
    }
    for (const [segmentId, worktree] of segments) {
      const segment = this.ledger.segment(segmentId);
      if (!segment) continue;
      const operations = this.ledger
        .turnsForThread(segment.thread_id, 0, 10_000)
        .filter((turn) => turn.segment_id === segmentId)
        .flatMap((turn) => operationsOf(turn.turn_id));
      this.measurements.publishOperationVolume(
        { kind: "segment", id: segmentId },
        operations,
        worktree,
        environmentId,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Read APIs
  // -------------------------------------------------------------------------

  getView(input: {
    resourceKey: string;
    knownGeneration?: string;
    knownRevision?: number;
    pageSize?: number;
  }): ChangeViewResult {
    const projection = this.projections.project(
      input.resourceKey,
      input.pageSize ?? this.policies.policy.filePageRows,
    );
    if (!projection)
      return {
        kind: "error",
        error: { code: "invalid-request", reasonKey: "changes.error.invalid-request" },
      };
    if (projection.state === "deleted") return { kind: "deleted", resourceKey: input.resourceKey };
    if (
      input.knownGeneration !== undefined &&
      input.knownGeneration !== projection.ownerGeneration
    ) {
      return { kind: "reset", projection };
    }
    if (
      input.knownGeneration === projection.ownerGeneration &&
      input.knownRevision === projection.revision
    ) {
      return {
        kind: "unchanged",
        ownerGeneration: projection.ownerGeneration,
        revision: projection.revision,
      };
    }
    return { kind: "projection", projection };
  }

  /** Tool presentations for transcript rows, plus their summary projections. */
  getToolPresentations(input: {
    environmentId: string;
    provider: string;
    conversationId: string;
    callIds: readonly string[];
  }): {
    presentations: Record<string, CanonicalToolPresentation | null>;
    projections: Record<string, ChangeProjection>;
  } {
    const presentations: Record<string, CanonicalToolPresentation | null> = {};
    const projections: Record<string, ChangeProjection> = {};
    for (const callId of input.callIds.slice(0, 500)) {
      let nativeCallId = callId;
      let attemptId: string | undefined;
      // An occurrence-aware transcript can address an attempt without making
      // the shared domain depend on which adapter produced it.
      if (callId.startsWith("[")) {
        try {
          const tuple = JSON.parse(callId);
          if (
            Array.isArray(tuple) &&
            tuple.length === 2 &&
            tuple.every((item) => typeof item === "string")
          ) {
            nativeCallId = tuple[0]!;
            attemptId = tuple[1]!;
          }
        } catch {
          /* A plain native call id remains supported. */
        }
      }
      const operationId = operationIdFor({
        environmentId: input.environmentId,
        provider: input.provider,
        conversationId: input.conversationId,
        callId: nativeCallId,
        attemptId,
      });
      const op = this.ledger.operation(operationId);
      if (!op) {
        presentations[callId] = null;
        continue;
      }
      const keys = toolResourceKeys(operationId);
      const changes: CanonicalToolPresentation["changes"][number][] = [];
      const has = (key: string) => this.ledger.selection(key)?.measurement_id != null;
      const hasEffect = has(keys.effect);
      const hasPayload = has(keys.payload);
      const hasObservation = has(keys.observation);
      if (hasEffect)
        changes.push({ role: "effect", resourceKey: keys.effect, prominence: "primary" });
      if (hasPayload)
        changes.push({
          role: "payload",
          resourceKey: keys.payload,
          prominence: hasEffect ? "secondary" : "primary",
        });
      if (hasObservation) {
        changes.push({
          role: "observation",
          resourceKey: keys.observation,
          prominence: hasEffect || hasPayload ? "secondary" : "primary",
        });
      }
      presentations[callId] = {
        schemaVersion: 1,
        operationId,
        attemptId: op.attempt_id,
        revision: op.presentation_revision,
        toolKind: op.tool_kind as CanonicalToolPresentation["toolKind"],
        lifecycle: {
          phase: op.phase as CanonicalToolPresentation["lifecycle"]["phase"],
          executionOccurrence:
            op.execution_occurrence as CanonicalToolPresentation["lifecycle"]["executionOccurrence"],
        },
        changes,
      };
      for (const change of changes) {
        const projection = this.projections.project(change.resourceKey, 0);
        if (projection) projections[change.resourceKey] = projection;
      }
    }
    return { presentations, projections };
  }

  getHistory(input: {
    environmentId: string;
    logicalSessionKey: string;
    cursor?: string | null;
    pageSize?: number;
    /** Renderer history refreshes its tail; the public CLI keeps oldest-first paging. */
    newestFirst?: boolean;
  }): ChangesGetHistoryResult {
    const threadId = threadIdFor(input.environmentId, input.logicalSessionKey);
    const after = input.cursor
      ? Number(input.cursor)
      : input.newestFirst
        ? Number.MAX_SAFE_INTEGER
        : 0;
    if (!Number.isSafeInteger(after) || after < 0) {
      return {
        kind: "error",
        error: { code: "stale-cursor", reasonKey: "changes.error.stale-cursor" },
      };
    }
    const limit = Math.max(1, Math.min(input.pageSize ?? 50, 200));
    const rows = input.newestFirst
      ? this.ledger.recentTurnsForThread(threadId, after, limit + 1)
      : this.ledger.turnsForThread(threadId, after, limit + 1);
    const entries: ChangeHistoryEntry[] = rows.slice(0, limit).map((turn) => {
      const providerTurnId = this.ledger.meta(`pturn:${turn.turn_id}`);
      const keys = turnResourceKeys(turn.turn_id, providerTurnId);
      const presentation: CanonicalTurnPresentation = {
        schemaVersion: 1,
        turnId: turn.turn_id,
        revision: this.projections.revision(keys.turnNet),
        changes: [
          { role: "turn-net", resourceKey: keys.turnNet, prominence: "primary" },
          ...(keys.providerTurnDiff
            ? [
                {
                  role: "provider-turn-diff" as const,
                  resourceKey: keys.providerTurnDiff,
                  prominence: "secondary" as const,
                },
              ]
            : []),
          ...(this.ledger.selection(operationVolumeResourceKey(turn.turn_id))
            ? [
                {
                  role: "operation-volume" as const,
                  resourceKey: operationVolumeResourceKey(turn.turn_id),
                  prominence: "secondary" as const,
                },
              ]
            : []),
        ],
      };
      return {
        turnId: turn.turn_id,
        segmentId: turn.segment_id,
        lifecycle: turn.lifecycle,
        startedAt: turn.started_at,
        finishedAt: turn.finished_at,
        turnResourceKey: keys.turnNet,
        measurementId: this.ledger.selection(keys.turnNet)?.measurement_id ?? null,
        presentation,
      };
    });
    const next = rows.length > limit ? String(rows[limit - 1]!.ordinal) : null;
    return { kind: "page", entries, nextCursor: next };
  }

  /** The current thread segment's resource key, for the thread header. */
  threadResource(
    environmentId: string,
    logicalSessionKey: string,
  ): { segmentId: string; resourceKey: string } | null {
    const segment = this.ledger.currentSegment(threadIdFor(environmentId, logicalSessionKey));
    if (!segment) return null;
    return {
      segmentId: segment.segment_id,
      resourceKey: `thread-net/segment/${encodeURIComponent(segment.segment_id)}/live`,
    };
  }

  /**
   * Manual refresh with a freshness fence: settles only on an observation
   * newer than the request, or reports pending/failure. Never satisfied by an
   * older scan.
   */
  async refresh(input: { resourceKey: string }): Promise<ChangesRefreshResult> {
    const parts = parseChangeResourceKey(input.resourceKey);
    const token = `rf_${randomUUID()}`;
    if (!parts || parts.scope !== "environment-net" || parts.ownerKind !== "environment") {
      return {
        kind: "error",
        error: { code: "unsupported-capability", reasonKey: "changes.error.refresh-unsupported" },
        token: null,
      };
    }
    const before =
      this.projections.getFreshness(input.resourceKey)?.freshness.lastSuccessfulCheckAt ?? null;
    const requiredEpoch = this.projections.revision(input.resourceKey) + 1;
    const requestedAt = new Date().toISOString();
    this.options.requestEnvironmentRefresh?.(parts.ownerId);
    const deadline = Date.now() + this.policies.policy.manualRefreshDeadlineMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const freshness = this.projections.getFreshness(input.resourceKey);
      const checked = freshness?.freshness.lastSuccessfulCheckAt ?? null;
      // Only a pass that started after the request satisfies its fence.
      const started = freshness?.checkStartedAt ?? null;
      if (checked && checked !== before && started && started >= requestedAt) {
        return {
          kind: "settled",
          token,
          requiredObservationEpoch: requiredEpoch,
          projection: this.projections.project(input.resourceKey, 0),
        };
      }
      if (
        freshness?.freshness.lastAttemptAt &&
        freshness.freshness.lastAttemptAt >= requestedAt &&
        freshness.stale
      ) {
        return {
          kind: "error",
          error: { code: "capture-timeout", reasonKey: "changes.error.refresh-failed" },
          token,
        };
      }
    }
    return { kind: "pending", token, requiredObservationEpoch: requiredEpoch };
  }

  /** Legacy command-journal import: summary-only, no invented endpoints. */
  importLegacyJournal(input: {
    environmentId: string;
    provider: string;
    conversationId: string;
    records: ReadonlyMap<string, import("@orkestrator/protocol/tool-diff").MeasuredWorkspaceChange>;
  }): number {
    let imported = 0;
    for (const [callId, change] of input.records) {
      const operationId = operationIdFor({
        environmentId: input.environmentId,
        provider: input.provider,
        conversationId: input.conversationId,
        callId,
      });
      if (this.ledger.selection(toolResourceKeys(operationId).observation)) continue;
      this.measurements.importLegacySummary({
        operationId,
        environmentId: input.environmentId,
        conversationId: input.conversationId,
        worktreeId: `legacy:${input.environmentId}`,
        change,
      });
      imported++;
    }
    if (imported > 0) this.publisher.drainOutbox();
    return imported;
  }

  /** Content-free diagnostics for operators. */
  diagnostics() {
    return {
      generation: this.generation,
      policyVersion: this.policies.policy.version,
      activeOwners: this.registry.activeOwners(),
      publisher: this.publisher.stats(),
      pendingPulls: this.pulls.size,
      retentionRefusingCaptures: this.retention.captureRefused,
      activeTurns: this.ledger.activeTurns().length,
      openWindows: this.ledger.allOpenWindows().length,
    };
  }

  providerTurnId(
    environmentId: string,
    provider: string,
    conversationId: string,
    turnId: string,
  ): string {
    return providerTurnIdFor({ environmentId, provider, conversationId, turnId });
  }
}
