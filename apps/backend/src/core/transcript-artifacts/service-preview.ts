/**
 * preview_artifact / cancel_artifact_operation and the verification
 * executor.
 *
 * Admission is one short transaction: request key, revision, per-conversation
 * bound (≤ 2 nonterminal operations) and a `queued` operation with a lease
 * held by this process. Before it, a busy preview runner (advisory
 * `admissionRefusal`) is answered synchronously with a transient
 * `capacity_exceeded` naming the resource, instead of admitting an operation
 * that would only fail in the queue. The tool returns the operation id
 * immediately; the executor runs afterwards, outside any transaction:
 *
 *   queued ──(start txn: cancellation checked first)──▶ running(generation g)
 *   running ──(job, no transaction held)──▶ completion txn
 *
 * The completion commits only while the operation is still `running` at
 * generation g under this process's lease, and only into an environment that
 * was not deleted; anything else (late, superseded, cancelled, deleted) is
 * discarded. A committed cancellation request fences success. Restart
 * recovery marks unfinished operations `interrupted`; nothing is re-run and
 * nothing is ever published automatically.
 *
 * A successful receipt exists only when every required gate passed and every
 * declared probe passed; failed probes and diagnostic captures stay on the
 * failed operation.
 */
import { PREVIEW_ADMISSION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { validatePreviewProfile } from "@orkestrator/protocol/transcript-artifacts-validation";
import {
  ArtifactFailure,
  REQUIRED_ARTIFACT_GATES,
  artifactError,
  isTerminalArtifactOperationStatus,
  type ArtifactError,
  type ArtifactPreviewProfile,
  type ArtifactVerificationGate,
} from "@orkestrator/protocol/transcript-artifacts";
import { diagnosticsHash } from "./hashing.js";
import { logArtifactEvent } from "./metrics.js";
import { notFound, ownsRecord, type ResolvedArtifactCaller } from "./owner.js";
import {
  assertConversationLive,
  boundPersistedDiagnostics,
  errorResponse,
  isRecordableError,
  newId,
  okResponse,
  priorRequest,
  recordRequest,
  replayed,
  requestIdentity,
  toArtifactError,
  type ArtifactResponse,
  type ArtifactServiceContext,
  type RequestIdentity,
} from "./service-context.js";
import { buildIdentity, identityInputHash } from "./service-identity.js";
import {
  ArtifactPreviewJobs,
  failure,
  type Outcome,
  type StoredAssetRef,
} from "./service-preview-jobs.js";
import type { EnvironmentRecords } from "./store.js";
import type {
  PreparedDocumentRef,
  StoredOperation,
  StoredReceipt,
  StoredRevision,
} from "./store-records.js";

interface ActiveOperation {
  controller: AbortController;
  generation: number;
  reason: "cancel" | "timeout" | "shutdown" | null;
}

export class ArtifactPreviews {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly running = new Set<Promise<void>>();
  private readonly jobs: ArtifactPreviewJobs;

  constructor(private readonly ctx: ArtifactServiceContext) {
    this.jobs = new ArtifactPreviewJobs(ctx);
  }

  // ---------------------------------------------------------------------------
  // Admission

  async preview(
    caller: ResolvedArtifactCaller,
    args: { requestKey: unknown; artifactId: unknown; revision: unknown; profile?: unknown },
  ): Promise<ArtifactResponse> {
    const environmentId = caller.owner.environmentId;
    let request: RequestIdentity;
    try {
      request = requestIdentity(caller.owner, "preview", args.requestKey, {
        artifactId: args.artifactId ?? null,
        revision: args.revision ?? null,
        profile: args.profile ?? null,
      });
      const prior = priorRequest(this.ctx.store.records(environmentId), request);
      if (prior) return this.refresh(environmentId, prior.response, replayed(prior));
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
    try {
      if (typeof args.artifactId !== "string") throw notFound();
      const artifactId = args.artifactId;
      const revisionNumber = args.revision;
      if (
        typeof revisionNumber !== "number" ||
        !Number.isSafeInteger(revisionNumber) ||
        revisionNumber < 1
      ) {
        throw new ArtifactFailure(
          artifactError("invalid_input", "revision must be a positive integer", {
            fieldErrors: [
              { path: "revision", code: "type", message: "Expected a positive integer" },
            ],
          }),
        );
      }
      const profileResult = validatePreviewProfile(args.profile);
      if (!profileResult.ok) {
        throw new ArtifactFailure(
          artifactError("invalid_input", "The preview profile is invalid", {
            fieldErrors: profileResult.errors,
          }),
        );
      }
      const head = this.ctx.store.records(environmentId).get("head", artifactId);
      if (!head || !ownsRecord(caller.owner, head)) throw notFound();
      this.requireRenderer(head.kind);
      this.requireRunnerCapacity(head.kind, caller.owner);
      const profile: ArtifactPreviewProfile | null =
        head.kind === "workflow-snapshot" ? null : profileResult.value;
      const response = this.ctx.store.transact(environmentId, (records) => {
        assertConversationLive(records, caller.owner.conversationKey);
        const again = priorRequest(records, request);
        if (again) return replayed(again);
        const latest = records.get("head", artifactId);
        if (!latest || !ownsRecord(caller.owner, latest)) throw notFound();
        const revision = records.get("revision", `${artifactId}/${revisionNumber}`);
        if (!revision || !ownsRecord(caller.owner, revision)) throw notFound("Artifact revision");
        const nonterminal = records
          .list("operation", { owner: caller.owner.conversationKey })
          .filter((operation) => !isTerminalArtifactOperationStatus(operation.status)).length;
        if (nonterminal >= PREVIEW_ADMISSION_POLICY.nonterminalPerConversation) {
          throw new ArtifactFailure(
            artifactError(
              "capacity_exceeded",
              "This conversation already has two previews in progress",
              {
                resource: "conversation-operations",
                retryClass: "transient",
                suggestion:
                  "Wait for a running preview (get_artifact_operation) before starting another.",
              },
            ),
          );
        }
        const now = this.ctx.iso();
        const operation: StoredOperation = {
          schemaVersion: 1,
          operationId: newId("op"),
          artifactId,
          revision: revisionNumber,
          status: "queued",
          profile,
          diagnostics: [],
          omittedDiagnostics: 0,
          semantics: "not-assessed",
          createdAt: now,
          owner: caller.owner,
          kind: latest.kind,
          generation: 0,
          lease: {
            holder: this.ctx.holder,
            expiresAt: new Date(this.ctx.now() + this.ctx.leaseMs).toISOString(),
          },
          transientRetries: 0,
          turnKey: caller.turnId ?? "unattributed",
        };
        records.put("operation", operation.operationId, operation, caller.owner.conversationKey);
        records.put(
          "head",
          artifactId,
          { ...latest, updatedAt: now },
          caller.owner.conversationKey,
        );
        const result = okResponse({
          operationId: operation.operationId,
          artifactId,
          revision: revisionNumber,
          status: "queued",
          next: "get_artifact_operation",
        });
        recordRequest(records, request, result, now, artifactId);
        return { result, operationId: operation.operationId };
      });
      if ("operationId" in response) {
        this.ctx.announceConversation(environmentId, caller.owner.conversationKey);
        this.schedule(environmentId, response.operationId);
        return response.result;
      }
      return this.refresh(environmentId, response.value, response);
    } catch (error) {
      const failure = toArtifactError(error);
      const response = errorResponse(failure);
      if (!isRecordableError(failure)) return response;
      try {
        return this.ctx.store.transact(environmentId, (records) => {
          const prior = priorRequest(records, request);
          if (prior) return replayed(prior);
          recordRequest(records, request, response, this.ctx.iso());
          return response;
        });
      } catch {
        return response;
      }
    }
  }

  /** A replayed admission reports the operation's current status. */
  private refresh(
    environmentId: string,
    stored: Record<string, unknown> | undefined,
    fallback: ArtifactResponse,
  ): ArtifactResponse {
    const operationId = stored?.operationId;
    if (typeof operationId !== "string") return fallback;
    try {
      const operation = this.ctx.store.records(environmentId).get("operation", operationId);
      if (!operation) {
        return errorResponse(artifactError("expired", "The preview operation has expired"));
      }
      return { value: { ...fallback.value, status: operation.status }, isError: false };
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
  }

  /**
   * Answers a busy runner at admission instead of admitting an operation that
   * would only fail later: a transient `capacity_exceeded` naming the
   * exhausted resource, not recorded under the request key, so retrying the
   * same key later is admitted normally. Advisory; the job still re-checks.
   */
  private requireRunnerCapacity(
    kind: StoredOperation["kind"],
    owner: { environmentId: string; conversationKey: string },
  ): void {
    if (kind === "chart" || kind === "workflow-snapshot") return;
    const exhausted = this.ctx.runtime.runner?.admissionRefusal?.({
      environmentId: owner.environmentId,
      conversationKey: owner.conversationKey,
    });
    if (!exhausted) return;
    throw new ArtifactFailure(
      artifactError(
        "capacity_exceeded",
        `The preview renderer is busy (${exhausted.slice(0, 64)})`,
        {
          resource: exhausted.slice(0, 64),
          retryClass: "transient",
          suggestion: "Retry preview_artifact with the same requestKey shortly.",
        },
      ),
    );
  }

  private requireRenderer(kind: StoredOperation["kind"]): void {
    if (kind === "chart" || kind === "workflow-snapshot") return;
    const runner = this.ctx.runtime.runner;
    const status = runner?.status();
    if (!runner || !status?.available) {
      throw new ArtifactFailure(
        artifactError("renderer_unavailable", "Headless preview is unavailable on this host", {
          suggestion:
            "HTML and Mermaid artifacts cannot be verified or published here; the draft source stays readable. Charts and workflow snapshots still work.",
        }),
      );
    }
    if (kind === "html-interactive" && !this.ctx.runtime.preparer) {
      throw new ArtifactFailure(
        artifactError(
          "renderer_unavailable",
          "Interactive HTML preparation is unavailable on this host",
        ),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Cancellation

  async cancel(
    caller: ResolvedArtifactCaller,
    args: { requestKey: unknown; operationId: unknown },
  ): Promise<ArtifactResponse> {
    const environmentId = caller.owner.environmentId;
    let request: RequestIdentity;
    try {
      request = requestIdentity(caller.owner, "cancel", args.requestKey, {
        operationId: args.operationId ?? null,
      });
      const prior = priorRequest(this.ctx.store.records(environmentId), request);
      if (prior) {
        const current =
          typeof args.operationId === "string"
            ? this.ctx.store.records(environmentId).get("operation", args.operationId)
            : null;
        return current ? okResponse(cancelView(current)) : replayed(prior);
      }
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
    try {
      if (typeof args.operationId !== "string") throw notFound("Operation");
      const operationId = args.operationId;
      const outcome = this.ctx.store.transact(environmentId, (records) => {
        assertConversationLive(records, caller.owner.conversationKey);
        const again = priorRequest(records, request);
        const operation = records.get("operation", operationId);
        if (!operation || !ownsRecord(caller.owner, operation)) throw notFound("Operation");
        if (again) return { operation, abort: false };
        const now = this.ctx.iso();
        let next = operation;
        if (operation.status === "queued") {
          // Persisted before dispatch: the renderer never starts it.
          next = {
            ...operation,
            status: "cancelled",
            cancellationRequestedAt: now,
            completedAt: now,
            error: artifactError("cancelled", "The preview was cancelled before it started", {
              operationId,
            }),
            lease: null,
          };
          records.put("operation", operationId, next, operation.owner.conversationKey);
        } else if (operation.status === "running" && !operation.cancellationRequestedAt) {
          // A running job keeps `running` until it really ends.
          next = { ...operation, cancellationRequestedAt: now };
          records.put("operation", operationId, next, operation.owner.conversationKey);
        }
        recordRequest(records, request, okResponse({ operationId }), now, operation.artifactId);
        return { operation: next, abort: next.status === "running" };
      });
      this.ctx.announceConversation(environmentId, caller.owner.conversationKey);
      if (outcome.abort) {
        const active = this.active.get(`${environmentId}/${operationId}`);
        if (active && active.generation === outcome.operation.generation) {
          active.reason ??= "cancel";
          active.controller.abort();
        }
      }
      return okResponse(cancelView(outcome.operation));
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Execution

  private schedule(environmentId: string, operationId: string): void {
    const task = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(() => this.execute(environmentId, operationId))
      .catch((error: unknown) => {
        logArtifactEvent("operation-executor-failed", {
          operationId,
          reason: error instanceof Error ? error.name : "unknown",
        });
      });
    this.running.add(task);
    void task.finally(() => this.running.delete(task));
  }

  /** Resolves when every scheduled execution has settled (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled(Array.from(this.running));
  }

  abortAll(environmentId?: string): void {
    for (const [key, active] of this.active) {
      if (environmentId && !key.startsWith(`${environmentId}/`)) continue;
      active.reason ??= "shutdown";
      active.controller.abort();
    }
  }

  /** Aborts this process's running operations with the given ids (conversation deletion). */
  abortOperations(environmentId: string, operationIds: Iterable<string>): void {
    for (const operationId of operationIds) {
      const active = this.active.get(`${environmentId}/${operationId}`);
      if (!active) continue;
      active.reason ??= "shutdown";
      active.controller.abort();
    }
  }

  async execute(environmentId: string, operationId: string): Promise<void> {
    let started: StoredOperation | null;
    try {
      started = this.ctx.store.transact(environmentId, (records) => {
        const operation = records.get("operation", operationId);
        if (
          !operation ||
          operation.status !== "queued" ||
          operation.lease?.holder !== this.ctx.holder
        )
          return null;
        const now = this.ctx.iso();
        if (operation.cancellationRequestedAt) {
          records.put(
            "operation",
            operationId,
            {
              ...operation,
              status: "cancelled",
              completedAt: now,
              lease: null,
              error: artifactError("cancelled", "The preview was cancelled before it started", {
                operationId,
              }),
            },
            operation.owner.conversationKey,
          );
          return null;
        }
        const next: StoredOperation = {
          ...operation,
          status: "running",
          startedAt: now,
          generation: operation.generation + 1,
          lease: {
            holder: this.ctx.holder,
            expiresAt: new Date(this.ctx.now() + this.ctx.leaseMs).toISOString(),
          },
        };
        records.put("operation", operationId, next, operation.owner.conversationKey);
        return next;
      });
    } catch {
      return;
    }
    if (!started) return;
    const key = `${environmentId}/${operationId}`;
    const active: ActiveOperation = {
      controller: new AbortController(),
      generation: started.generation,
      reason: null,
    };
    this.active.set(key, active);
    const heartbeat = setInterval(
      () => this.renewLease(environmentId, operationId, active.generation),
      Math.max(1_000, Math.floor(this.ctx.leaseMs / 3)),
    );
    heartbeat.unref?.();
    const deadline = setTimeout(() => {
      active.reason ??= "timeout";
      active.controller.abort();
    }, PREVIEW_ADMISSION_POLICY.operationDeadlineMs);
    deadline.unref?.();
    const releases: Array<() => void> = [];
    const startedMs = this.ctx.now();
    let outcome: Outcome;
    try {
      outcome = await this.jobs.perform(environmentId, started, active.controller.signal, releases);
    } catch (error) {
      outcome = failure(toArtifactError(error));
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      this.active.delete(key);
    }
    if (!outcome.ok && active.reason === "timeout") {
      outcome = {
        ...outcome,
        error: artifactError("render_timeout", "The preview exceeded its 45 second deadline", {
          operationId,
        }),
      };
      this.ctx.metrics.increment("deadlines", { kind: started.kind });
    }
    try {
      if (this.complete(environmentId, started, outcome, active))
        this.ctx.announceConversation(environmentId, started.owner.conversationKey);
    } catch {
      this.ctx.metrics.increment("late_completions_discarded");
    } finally {
      for (const release of releases) release();
    }
    if (!outcome.ok)
      logArtifactEvent("operation-failed", {
        operationId,
        kind: started.kind,
        outcome: outcome.ok ? "succeeded" : outcome.error.code,
        durationMs: this.ctx.now() - startedMs,
      });
  }

  private renewLease(environmentId: string, operationId: string, generation: number): void {
    try {
      this.ctx.store.transact(environmentId, (records) => {
        const operation = records.get("operation", operationId);
        if (!operation || operation.status !== "running" || operation.generation !== generation)
          return;
        if (operation.lease?.holder !== this.ctx.holder) return;
        records.put(
          "operation",
          operationId,
          {
            ...operation,
            lease: {
              holder: this.ctx.holder,
              expiresAt: new Date(this.ctx.now() + this.ctx.leaseMs).toISOString(),
            },
          },
          operation.owner.conversationKey,
        );
      });
    } catch {
      // A missed renewal only shortens the lease.
    }
  }

  /** Commits the outcome under its generation fence; false when it was discarded. */
  private complete(
    environmentId: string,
    started: StoredOperation,
    outcome: Outcome,
    active: ActiveOperation,
  ): boolean {
    return this.ctx.store.transact(environmentId, (records) => {
      const operation = records.get("operation", started.operationId);
      if (
        !operation ||
        operation.status !== "running" ||
        operation.generation !== started.generation ||
        operation.lease?.holder !== this.ctx.holder ||
        records.get("conversation", operation.owner.conversationKey)?.deletedAt
      ) {
        this.ctx.metrics.increment("late_completions_discarded");
        return false;
      }
      const now = this.ctx.iso();
      if (active.reason === "shutdown" && !operation.cancellationRequestedAt) {
        records.put(
          "operation",
          operation.operationId,
          {
            ...operation,
            status: "interrupted",
            completedAt: now,
            lease: null,
            error: artifactError("interrupted", "The preview was interrupted by shutdown", {
              operationId: operation.operationId,
            }),
          },
          operation.owner.conversationKey,
        );
        return true;
      }
      const cancelled =
        operation.cancellationRequestedAt !== undefined || active.reason === "cancel";
      const head = records.get("head", operation.artifactId);
      const revision = records.get("revision", `${operation.artifactId}/${operation.revision}`);
      if (!head || !revision) {
        this.ctx.metrics.increment("late_completions_discarded");
        return false;
      }
      if (
        outcome.prepared &&
        this.tryRegister(
          records,
          [
            {
              sha256: outcome.prepared.documentSha256,
              byteLength: outcome.prepared.byteLength,
              mimeType: "text/html",
            },
          ],
          now,
        ) === null
      ) {
        this.recordPrepared(records, revision, outcome.prepared);
      }
      let next: StoredOperation;
      let stored: ArtifactError | null = null;
      if (cancelled) {
        next = {
          ...operation,
          status: "cancelled",
          completedAt: now,
          lease: null,
          error: artifactError("cancelled", "The preview was cancelled", {
            operationId: operation.operationId,
          }),
        };
      } else if (outcome.ok && (stored = this.tryRegister(records, outcome.assets, now)) === null) {
        const identity = buildIdentity(
          revision,
          operation.profile,
          outcome.facts,
          this.ctx.overrides,
        );
        const persisted = boundPersistedDiagnostics(outcome.diagnostics, outcome.omitted);
        const receipt: StoredReceipt = {
          schemaVersion: 1,
          receiptId: newId("rcpt"),
          operationId: operation.operationId,
          artifactId: operation.artifactId,
          revision: operation.revision,
          kind: operation.kind,
          inputHash: identityInputHash(identity),
          identity,
          gates: outcome.gates.map((gate) => ({ gate, result: "passed" as const })),
          evidence: outcome.evidence,
          diagnosticsHash: diagnosticsHash(persisted.diagnostics),
          completedAt: now,
          owner: operation.owner,
          profile: operation.profile,
          semantics: outcome.semantics,
        };
        records.put("receipt", receipt.receiptId, receipt);
        // A successful verification ends the artifact's repair sequence.
        for (const key of records.keys("repair")) {
          if (key.startsWith(`${operation.artifactId}/`)) records.delete("repair", key);
        }
        next = {
          ...operation,
          status: "succeeded",
          completedAt: now,
          lease: null,
          receiptId: receipt.receiptId,
          diagnostics: persisted.diagnostics,
          omittedDiagnostics: persisted.omitted,
          semantics: outcome.semantics,
          ...(outcome.probeResults ? { probeResults: outcome.probeResults } : {}),
        };
        this.ctx.metrics.increment("receipts", { kind: operation.kind });
      } else {
        const failed: Extract<Outcome, { ok: false }> = outcome.ok
          ? {
              ...failure(
                stored ??
                  artifactError("storage_unavailable", "Verification output could not be stored"),
              ),
              diagnostics: outcome.diagnostics,
              omitted: outcome.omitted,
            }
          : outcome;
        const persisted = boundPersistedDiagnostics(failed.diagnostics, failed.omitted);
        let captures = failed.captures;
        if (captures.length > 0 && this.tryRegister(records, captures, now) !== null) captures = [];
        next = {
          ...operation,
          status: "failed",
          completedAt: now,
          lease: null,
          error: { ...failed.error, operationId: operation.operationId },
          diagnostics: persisted.diagnostics,
          omittedDiagnostics: persisted.omitted,
          ...(captures.length > 0 ? { diagnosticCaptures: captures } : {}),
          ...(failed.probeResults
            ? { probeResults: failed.probeResults, semantics: "probes-failed" as const }
            : {}),
        };
      }
      records.put("operation", operation.operationId, next, operation.owner.conversationKey);
      records.put("head", head.artifactId, { ...head, updatedAt: now }, head.owner.conversationKey);
      this.ctx.metrics.increment("operations", { kind: operation.kind, outcome: next.status });
      return true;
    });
  }

  /** Registers asset rows; returns the refusal instead of throwing (nothing is written on refusal). */
  private tryRegister(
    records: EnvironmentRecords,
    assets: ReadonlyArray<StoredAssetRef>,
    now: string,
  ): ArtifactError | null {
    try {
      this.ctx.store.registerAssetsInTransaction(records, assets, now);
      return null;
    } catch (error) {
      return toArtifactError(error);
    }
  }

  private recordPrepared(
    records: EnvironmentRecords,
    revision: StoredRevision,
    prepared: PreparedDocumentRef,
  ): void {
    const key = `${revision.artifactId}/${revision.revision}`;
    const existing = records.get("derived", key) ?? {
      schemaVersion: 1 as const,
      artifactId: revision.artifactId,
      revision: revision.revision,
      prepared: [],
    };
    if (existing.prepared.some((entry) => entry.documentSha256 === prepared.documentSha256)) return;
    records.put("derived", key, {
      ...existing,
      prepared: [...existing.prepared, prepared].slice(-4),
    });
  }

  // ---------------------------------------------------------------------------
  // Recovery

  /**
   * Marks queued/running operations whose lease is not ours and has expired
   * (or that we no longer run) as `interrupted`. Never re-runs them.
   */
  recover(environmentId: string): number {
    const now = this.ctx.now();
    try {
      return this.ctx.store.transact(environmentId, (records) => {
        let recovered = 0;
        for (const operation of records.list("operation")) {
          if (isTerminalArtifactOperationStatus(operation.status)) continue;
          const ours = operation.lease?.holder === this.ctx.holder;
          if (ours && this.isLocallyLive(environmentId, operation)) continue;
          const expired = !operation.lease || Date.parse(operation.lease.expiresAt) <= now;
          if (!ours && !expired) continue;
          records.put(
            "operation",
            operation.operationId,
            {
              ...operation,
              status: "interrupted",
              completedAt: new Date(now).toISOString(),
              lease: null,
              error: artifactError(
                "interrupted",
                "The backend stopped before this preview finished",
                {
                  operationId: operation.operationId,
                  suggestion: "Request a new preview; nothing was published.",
                },
              ),
            },
            operation.owner.conversationKey,
          );
          recovered += 1;
        }
        if (recovered > 0) this.ctx.metrics.increment("interrupted_recoveries", {}, recovered);
        return recovered;
      });
    } catch {
      return 0;
    }
  }

  private isLocallyLive(environmentId: string, operation: StoredOperation): boolean {
    if (operation.status === "queued") {
      // Admitted here and not yet started: its execution is scheduled.
      return Date.parse(operation.lease?.expiresAt ?? "") > this.ctx.now();
    }
    return this.active.has(`${environmentId}/${operation.operationId}`);
  }
}

function cancelView(operation: StoredOperation): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    status: operation.status,
    ...(operation.cancellationRequestedAt
      ? { cancellationRequestedAt: operation.cancellationRequestedAt }
      : {}),
    ...(operation.status === "succeeded"
      ? { alreadyCompleted: true, receiptId: operation.receiptId }
      : {}),
  };
}

/** Required gates for a kind, for tests and publication checks. */
export function requiredGates(kind: StoredOperation["kind"]): readonly ArtifactVerificationGate[] {
  return REQUIRED_ARTIFACT_GATES[kind];
}
