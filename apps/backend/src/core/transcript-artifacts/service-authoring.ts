/**
 * create_artifact / update_artifact: validate, resolve assets, and commit an
 * immutable revision (1, or N + 1 under compare-and-swap on the head).
 *
 * Kind is fixed per artifact. Revision N is never rewritten. Workflow
 * snapshots are collected by the backend here; an agent cannot author one.
 * Draft quotas (100 unpublished per conversation, 100 revisions per artifact,
 * 1 GiB of bytes per environment) reject instead of evicting anything.
 *
 * Mutation order (spec step 1–4): validate, then one short transaction
 * reserves the request key (a `pending` idempotency row) and, for create, an
 * unpublished-draft slot; expensive work (workflow collection, asset bytes)
 * runs outside any transaction; one commit transaction re-checks everything
 * and replaces the reservation with the result. Concurrent duplicates in this
 * process await the original; a live reservation held by another process
 * answers a transient `request-in-progress`.
 */
import {
  ARTIFACT_TOOL_POLICY,
  INTERACTIVE_HTML_POLICY,
  utf8ByteLength,
} from "@orkestrator/protocol/rich-content-policy";
import { validateArtifactDraft } from "@orkestrator/protocol/transcript-artifacts-validation";
import {
  ArtifactFailure,
  artifactError,
  type ArtifactAssetRecord,
  type ArtifactDraft,
  type ArtifactPayload,
} from "@orkestrator/protocol/transcript-artifacts";
import { artifactSourceHash, assetManifestHash, shortDigest } from "./hashing.js";
import { notFound, ownsRecord, type ResolvedArtifactCaller } from "./owner.js";
import {
  REQUEST_RESERVATION_MS,
  assertConversationLive,
  assetIdFor,
  errorResponse,
  isRecordableError,
  newId,
  okResponse,
  priorRequest,
  recordRequest,
  releaseRequest,
  replayed,
  requestIdentity,
  reserveRequest,
  toArtifactError,
  type ArtifactResponse,
  type ArtifactServiceContext,
  type RequestIdentity,
} from "./service-context.js";
import type { EnvironmentRecords } from "./store.js";
import type { StoredHead, StoredRevision } from "./store-records.js";

/** Asset MIME types an HTML artifact may embed. */
const ASSET_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "font/woff2",
  "application/json",
  "text/csv",
  "text/plain",
]);
/**
 * Explicit UTF-8 bounds on title and summary. The character limits (120 and
 * 400 UTF-16 units) already imply at most three bytes per unit; these make the
 * byte budget a checked invariant rather than an inference.
 */
export const MAX_TITLE_BYTES = ARTIFACT_TOOL_POLICY.maxTitleCharacters * 3;
export const MAX_SUMMARY_BYTES = ARTIFACT_TOOL_POLICY.maxSummaryCharacters * 3;
/** An unattributed repair sequence (no known turn) restarts after this much quiet. */
export const UNATTRIBUTED_REPAIR_WINDOW_MS = 30 * 60 * 1000;
const ASSET_REF = /^asset_([0-9a-f]{64})$/;

interface PreparedRevision {
  payload: ArtifactPayload;
  assets: ArtifactAssetRecord[];
  releases: Array<() => void>;
}

export class ArtifactAuthoring {
  /** Admitted create/update requests in this process, by (environment, request key). */
  private readonly inflight = new Map<
    string,
    { digest: string; promise: Promise<ArtifactResponse> }
  >();

  constructor(private readonly ctx: ArtifactServiceContext) {}

  /**
   * Runs one admitted mutation. A concurrent duplicate (same key and
   * arguments) in this process awaits the original instead of repeating the
   * work; across processes the durable reservation answers it.
   */
  private async deduplicated(
    environmentId: string,
    request: RequestIdentity,
    work: () => Promise<ArtifactResponse>,
  ): Promise<ArtifactResponse> {
    const slot = `${environmentId}\0${request.key}`;
    const running = this.inflight.get(slot);
    if (running && running.digest === request.digest) {
      const original = await running.promise;
      return { ...original, value: { ...original.value, replayed: true } };
    }
    const promise = work();
    if (!running) {
      this.inflight.set(slot, { digest: request.digest, promise });
      void promise.finally(() => {
        if (this.inflight.get(slot)?.promise === promise) this.inflight.delete(slot);
      });
    }
    return promise;
  }

  async create(
    caller: ResolvedArtifactCaller,
    args: { requestKey: unknown; draft: unknown },
  ): Promise<ArtifactResponse> {
    const environmentId = caller.owner.environmentId;
    let request: RequestIdentity;
    try {
      request = requestIdentity(caller.owner, "create", args.requestKey, {
        draft: args.draft ?? null,
      });
      const prior = priorRequest(this.ctx.store.records(environmentId), request);
      if (prior) return replayed(prior);
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
    return this.deduplicated(environmentId, request, () => this.runCreate(caller, args, request));
  }

  private async runCreate(
    caller: ResolvedArtifactCaller,
    args: { draft: unknown },
    request: RequestIdentity,
  ): Promise<ArtifactResponse> {
    const environmentId = caller.owner.environmentId;
    const conversationKey = caller.owner.conversationKey;
    let prepared: PreparedRevision | null = null;
    let reserved = false;
    try {
      const draft = this.validate(args.draft);
      // Step 1: reserve the key and the draft quota before any expensive work.
      const replay = this.ctx.store.transact(environmentId, (records) => {
        assertConversationLive(records, conversationKey);
        const prior = reserveRequest(records, request, this.ctx.holder, this.ctx.now());
        if (prior) return replayed(prior);
        this.reserveDraftSlot(records, conversationKey, request.key);
        return null;
      });
      if (replay) return replay;
      reserved = true;
      prepared = await this.prepare(caller, draft, null);
      const preparedRevision = prepared;
      const response = this.ctx.store.transact(environmentId, (records) => {
        assertConversationLive(records, conversationKey);
        const again = priorRequest(records, request);
        if (again) return replayed(again);
        const unpublished = this.unpublishedCount(records, conversationKey);
        if (unpublished >= ARTIFACT_TOOL_POLICY.maxUnpublishedArtifactsPerConversation) {
          throw unpublishedQuota();
        }
        const now = this.ctx.iso();
        this.ctx.store.registerAssetsInTransaction(records, preparedRevision.assets, now);
        const artifactId = newId("art");
        const revision = this.revisionRecord(caller, artifactId, 1, draft, preparedRevision, now);
        const head: StoredHead = {
          schemaVersion: 1,
          artifactId,
          owner: caller.owner,
          kind: revision.payload.kind,
          currentRevision: 1,
          publishedRevision: null,
          storageGeneration: 1,
          createdAt: now,
          updatedAt: now,
          title: draft.title,
          ...(caller.turnId ? { createdTurnId: caller.turnId } : {}),
        };
        this.ctx.store.fault("before-commit", environmentId);
        records.put("head", artifactId, head, conversationKey);
        records.put("revision", `${artifactId}/1`, revision);
        this.releaseDraftSlot(records, conversationKey, request.key);
        const result = okResponse(this.summary(revision));
        recordRequest(records, request, result, now, artifactId);
        return result;
      });
      this.ctx.store.fault("after-commit", environmentId);
      if (response.value.replayed !== true) {
        this.ctx.announceConversation(environmentId, conversationKey);
      }
      return response;
    } catch (error) {
      return this.failed(environmentId, request, error, reserved ? conversationKey : null);
    } finally {
      for (const release of prepared?.releases ?? []) release();
    }
  }

  async update(
    caller: ResolvedArtifactCaller,
    args: { requestKey: unknown; artifactId: unknown; expectedRevision: unknown; draft: unknown },
  ): Promise<ArtifactResponse> {
    const environmentId = caller.owner.environmentId;
    let request: RequestIdentity;
    try {
      request = requestIdentity(caller.owner, "update", args.requestKey, {
        artifactId: args.artifactId ?? null,
        expectedRevision: args.expectedRevision ?? null,
        draft: args.draft ?? null,
      });
      const prior = priorRequest(this.ctx.store.records(environmentId), request);
      if (prior) return replayed(prior);
    } catch (error) {
      return errorResponse(toArtifactError(error));
    }
    return this.deduplicated(environmentId, request, () => this.runUpdate(caller, args, request));
  }

  private async runUpdate(
    caller: ResolvedArtifactCaller,
    args: { artifactId: unknown; expectedRevision: unknown; draft: unknown },
    request: RequestIdentity,
  ): Promise<ArtifactResponse> {
    const environmentId = caller.owner.environmentId;
    const conversationKey = caller.owner.conversationKey;
    let prepared: PreparedRevision | null = null;
    try {
      if (typeof args.artifactId !== "string") throw notFound();
      const artifactId = args.artifactId;
      const expectedRevision = args.expectedRevision;
      if (
        typeof expectedRevision !== "number" ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1
      ) {
        throw new ArtifactFailure(
          artifactError("invalid_input", "expectedRevision must be a positive integer", {
            fieldErrors: [
              { path: "expectedRevision", code: "type", message: "Expected a positive integer" },
            ],
          }),
        );
      }
      const draft = this.validate(args.draft);
      // Step 1: reserve the key and check head, kind, revision and quota
      // before any expensive work; the commit re-checks all of them.
      const admitted = this.ctx.store.transact<{
        replay?: ArtifactResponse;
        current: StoredRevision | null;
      }>(environmentId, (records) => {
        assertConversationLive(records, conversationKey);
        const head = records.get("head", artifactId);
        if (!head || !ownsRecord(caller.owner, head)) throw notFound();
        const prior = reserveRequest(records, request, this.ctx.holder, this.ctx.now());
        if (prior) return { replay: replayed(prior), current: null };
        this.checkUpdatable(head, draft, expectedRevision);
        this.checkRepairBudget(records, caller, head);
        return {
          current: records.get("revision", `${artifactId}/${head.currentRevision}`),
        };
      });
      if (admitted.replay) return admitted.replay;
      prepared = await this.prepare(caller, draft, admitted.current);
      const preparedRevision = prepared;
      const response = this.ctx.store.transact(environmentId, (tx) => {
        assertConversationLive(tx, conversationKey);
        const again = priorRequest(tx, request);
        if (again) return replayed(again);
        const latest = tx.get("head", artifactId);
        if (!latest || !ownsRecord(caller.owner, latest)) throw notFound();
        this.checkUpdatable(latest, draft, expectedRevision);
        const now = this.ctx.iso();
        this.consumeRepairBudget(tx, caller, latest, now);
        this.ctx.store.registerAssetsInTransaction(tx, preparedRevision.assets, now);
        const nextRevision = latest.currentRevision + 1;
        const revision = this.revisionRecord(
          caller,
          artifactId,
          nextRevision,
          draft,
          preparedRevision,
          now,
        );
        this.ctx.store.fault("before-commit", environmentId);
        tx.put("revision", `${artifactId}/${nextRevision}`, revision);
        tx.put(
          "head",
          artifactId,
          {
            ...latest,
            currentRevision: nextRevision,
            storageGeneration: latest.storageGeneration + 1,
            updatedAt: now,
            title: draft.title,
          },
          conversationKey,
        );
        const result = okResponse(this.summary(revision));
        recordRequest(tx, request, result, now, artifactId);
        return result;
      });
      this.ctx.store.fault("after-commit", environmentId);
      if (response.value.replayed !== true) {
        this.ctx.announceConversation(environmentId, conversationKey);
      }
      return response;
    } catch (error) {
      return this.failed(environmentId, request, error, conversationKey);
    } finally {
      for (const release of prepared?.releases ?? []) release();
    }
  }

  /** Kind, compare-and-swap and revision-limit checks shared by admission and commit. */
  private checkUpdatable(head: StoredHead, draft: ArtifactDraft, expectedRevision: number): void {
    this.assertKind(head, draft);
    if (head.currentRevision !== expectedRevision) {
      throw new ArtifactFailure(
        artifactError("revision_conflict", `The artifact is at revision ${head.currentRevision}`, {
          currentRevision: head.currentRevision,
          suggestion: "Read the current revision, then update with that expectedRevision.",
        }),
      );
    }
    if (head.currentRevision >= ARTIFACT_TOOL_POLICY.maxRevisionsPerArtifact) {
      throw new ArtifactFailure(
        artifactError("capacity_exceeded", "This artifact has reached its revision limit", {
          resource: "revisions",
          retryClass: "never",
          currentRevision: head.currentRevision,
          suggestion: "Create a new artifact.",
        }),
      );
    }
  }

  private unpublishedCount(records: EnvironmentRecords, conversationKey: string): number {
    return records
      .list("head", { owner: conversationKey })
      .filter((head) => head.publishedRevision === null).length;
  }

  /**
   * Reserves one unpublished-draft slot for an admitted create, counting
   * other live reservations, so concurrent creates cannot exceed the quota.
   */
  private reserveDraftSlot(
    records: EnvironmentRecords,
    conversationKey: string,
    requestKey: string,
  ): void {
    const conversation = this.conversationRow(records, conversationKey);
    const now = this.ctx.now();
    const pending = (conversation.pendingCreates ?? []).filter(
      (entry) => entry.key !== requestKey && Date.parse(entry.expiresAt) > now,
    );
    if (
      this.unpublishedCount(records, conversationKey) + pending.length >=
      ARTIFACT_TOOL_POLICY.maxUnpublishedArtifactsPerConversation
    ) {
      throw unpublishedQuota();
    }
    pending.push({
      key: requestKey,
      expiresAt: new Date(now + REQUEST_RESERVATION_MS).toISOString(),
    });
    records.put("conversation", conversationKey, { ...conversation, pendingCreates: pending });
  }

  private releaseDraftSlot(
    records: EnvironmentRecords,
    conversationKey: string,
    requestKey: string,
  ): void {
    const conversation = records.get("conversation", conversationKey);
    if (!conversation?.pendingCreates?.some((entry) => entry.key === requestKey)) return;
    const pendingCreates = conversation.pendingCreates.filter((entry) => entry.key !== requestKey);
    const { pendingCreates: _drop, ...rest } = conversation;
    records.put(
      "conversation",
      conversationKey,
      pendingCreates.length > 0 ? { ...rest, pendingCreates } : rest,
    );
  }

  private conversationRow(records: EnvironmentRecords, conversationKey: string) {
    return (
      records.get("conversation", conversationKey) ?? {
        schemaVersion: 1 as const,
        conversationKey,
        sequence: 0,
      }
    );
  }

  /**
   * Records a stable, non-transient failure under the request key; any other
   * failure releases the key's reservation (and draft slot) so a retry with
   * the same key runs again.
   */
  private failed(
    environmentId: string,
    request: RequestIdentity,
    error: unknown,
    reservedConversation: string | null,
  ): ArtifactResponse {
    const artifactFailure = toArtifactError(error);
    if (artifactFailure.code === "repair_budget_exhausted") {
      this.ctx.metrics.increment("repair_budget_exhausted");
    }
    const response = errorResponse(artifactFailure);
    try {
      return this.ctx.store.transact(environmentId, (records) => {
        if (reservedConversation !== null)
          this.releaseDraftSlot(records, reservedConversation, request.key);
        if (!isRecordableError(artifactFailure)) {
          // Only a still-pending reservation of ours is dropped; a result
          // that did commit stays for the retry to replay.
          releaseRequest(records, request, this.ctx.holder);
          return response;
        }
        const prior = priorRequest(records, request);
        if (prior) return replayed(prior);
        recordRequest(records, request, response, this.ctx.iso());
        return response;
      });
    } catch {
      return response;
    }
  }

  private validate(value: unknown): ArtifactDraft {
    const validation = validateArtifactDraft(value);
    if (!validation.ok) {
      throw new ArtifactFailure(
        artifactError("invalid_input", "The artifact draft is invalid", {
          fieldErrors: validation.errors,
          suggestion: "Fix the listed fields and retry with a new requestKey.",
        }),
      );
    }
    const fieldErrors = [
      ["draft.title", validation.value.title, MAX_TITLE_BYTES],
      ["draft.summary", validation.value.summary, MAX_SUMMARY_BYTES],
    ]
      .filter(([, text, limit]) => utf8ByteLength(text as string) > (limit as number))
      .map(([path, , limit]) => ({
        path: path as string,
        code: "too_large",
        message: `Must be at most ${limit as number} bytes of UTF-8`,
      }));
    if (fieldErrors.length > 0) {
      throw new ArtifactFailure(
        artifactError("invalid_input", "The artifact draft is invalid", { fieldErrors }),
      );
    }
    return validation.value;
  }

  private assertKind(head: StoredHead, draft: ArtifactDraft): void {
    if (draft.payload.kind !== head.kind) {
      throw new ArtifactFailure(
        artifactError("invalid_input", `This artifact's kind is fixed as ${head.kind}`, {
          fieldErrors: [
            {
              path: "draft.payload.kind",
              code: "kind_fixed",
              message: "Create a new artifact for a different kind",
            },
          ],
        }),
      );
    }
  }

  /**
   * Whether an update of `head` is a source repair: its current revision has
   * a failed preview and no successful one. A deliberate update after a
   * successful preview, or before any preview, is not a repair and costs
   * nothing from the budget.
   */
  private isRepair(records: EnvironmentRecords, head: StoredHead): boolean {
    let failed = false;
    for (const operation of records.list("operation", { owner: head.owner.conversationKey })) {
      if (operation.artifactId !== head.artifactId || operation.revision !== head.currentRevision)
        continue;
      if (operation.status === "succeeded") return false;
      if (operation.status === "failed") failed = true;
    }
    return failed;
  }

  private repairKey(caller: ResolvedArtifactCaller, artifactId: string) {
    const turnKey = caller.turnId ?? "unattributed";
    return { turnKey, key: `${artifactId}/${shortDigest(caller.owner.conversationKey, turnKey)}` };
  }

  /** Repairs already spent in this (owner, artifact, turn) sequence. */
  private repairsUsed(
    records: EnvironmentRecords,
    caller: ResolvedArtifactCaller,
    artifactId: string,
  ) {
    const { turnKey, key } = this.repairKey(caller, artifactId);
    const existing = records.get("repair", key);
    const stale =
      existing !== null &&
      turnKey === "unattributed" &&
      this.ctx.now() - Date.parse(existing.updatedAt) > UNATTRIBUTED_REPAIR_WINDOW_MS;
    return { turnKey, key, used: existing && !stale ? existing.updates : 0 };
  }

  /**
   * Initial attempt plus at most two source repairs per (owner, artifact,
   * initiating turn). Only a revision made after a failed preview of the
   * previous revision counts. New request keys in the same turn do not reset
   * it; a successful receipt ends the sequence. Without a known turn, a
   * sequence restarts after 30 quiet minutes.
   */
  private checkRepairBudget(
    records: EnvironmentRecords,
    caller: ResolvedArtifactCaller,
    head: StoredHead,
  ): boolean {
    if (!this.isRepair(records, head)) return false;
    if (
      this.repairsUsed(records, caller, head.artifactId).used >=
      ARTIFACT_TOOL_POLICY.maxRepairRevisions
    ) {
      throw new ArtifactFailure(
        artifactError(
          "repair_budget_exhausted",
          `The repair budget (${ARTIFACT_TOOL_POLICY.maxRepairRevisions} corrective revisions) is exhausted for this turn`,
          {
            suggestion:
              "Report the failure to the user with the draft source and diagnostics (get_artifact, get_artifact_operation).",
          },
        ),
      );
    }
    return true;
  }

  private consumeRepairBudget(
    records: EnvironmentRecords,
    caller: ResolvedArtifactCaller,
    head: StoredHead,
    now: string,
  ): void {
    if (!this.checkRepairBudget(records, caller, head)) return;
    const { turnKey, key, used } = this.repairsUsed(records, caller, head.artifactId);
    records.put("repair", key, {
      schemaVersion: 1,
      artifactId: head.artifactId,
      conversationKey: caller.owner.conversationKey,
      turnKey,
      updates: used + 1,
      updatedAt: now,
    });
    this.ctx.metrics.increment("repairs");
  }

  private async prepare(
    caller: ResolvedArtifactCaller,
    draft: ArtifactDraft,
    current: StoredRevision | null,
  ): Promise<PreparedRevision> {
    let payload: ArtifactPayload;
    if (draft.payload.kind === "workflow-snapshot") {
      const snapshot = await this.ctx.collector.collect(
        { environmentId: caller.owner.environmentId, projectId: caller.owner.projectId },
        {
          workflowId: draft.payload.workflowId,
          runId: draft.payload.runId,
          ...(draft.payload.expectedWorkflowRevision !== undefined
            ? { expectedWorkflowRevision: draft.payload.expectedWorkflowRevision }
            : {}),
        },
      );
      payload = { kind: "workflow-snapshot", snapshot };
    } else {
      payload = draft.payload;
    }
    const releases: Array<() => void> = [];
    const assets: ArtifactAssetRecord[] = [];
    try {
      let total = 0;
      for (const [index, entry] of (draft.assets ?? []).entries()) {
        const reused = this.reusableAsset(entry.assetRef, current);
        if (reused) {
          assets.push({ ...reused, name: entry.name });
          total += reused.byteLength;
          continue;
        }
        const resolved = this.ctx.assetResolver
          ? await this.ctx.assetResolver(caller.owner, entry.assetRef)
          : null;
        if (!resolved) {
          throw new ArtifactFailure(
            artifactError("not_found", "Asset reference not found", {
              fieldErrors: [
                {
                  path: `draft.assets[${index}].assetRef`,
                  code: "not_found",
                  message: "Unknown or unauthorized asset reference",
                },
              ],
            }),
          );
        }
        if (!ASSET_MIME_TYPES.has(resolved.mimeType)) {
          throw new ArtifactFailure(
            artifactError("policy_denied", "Asset type is not permitted", {
              fieldErrors: [
                {
                  path: `draft.assets[${index}]`,
                  code: "mime_type",
                  message: `Unsupported MIME type ${resolved.mimeType.slice(0, 80)}`,
                },
              ],
            }),
          );
        }
        total += resolved.bytes.byteLength;
        if (total > INTERACTIVE_HTML_POLICY.maxAssetBytesTotal) {
          throw new ArtifactFailure(
            artifactError("package_size_exceeded", "Assets exceed 10 MiB of decoded bytes", {
              resource: "asset-bytes",
              suggestion: "Reduce or remove assets.",
            }),
          );
        }
        const written = await this.ctx.store.writeAsset(caller.owner.environmentId, resolved.bytes);
        releases.push(written.release);
        assets.push({
          name: entry.name,
          assetId: assetIdFor(written.sha256),
          sha256: written.sha256,
          mimeType: resolved.mimeType,
          byteLength: written.byteLength,
        });
      }
      return { payload, assets, releases };
    } catch (error) {
      for (const release of releases) release();
      throw error;
    }
  }

  /** `asset_<sha256>` already attached to the artifact's current revision. */
  private reusableAsset(
    assetRef: string,
    current: StoredRevision | null,
  ): ArtifactAssetRecord | null {
    const match = ASSET_REF.exec(assetRef);
    if (!match || !current) return null;
    return current.assets.find((asset) => asset.sha256 === match[1]) ?? null;
  }

  private revisionRecord(
    caller: ResolvedArtifactCaller,
    artifactId: string,
    revision: number,
    draft: ArtifactDraft,
    prepared: PreparedRevision,
    now: string,
  ): StoredRevision {
    return {
      schemaVersion: 1,
      artifactId,
      revision,
      owner: caller.owner,
      title: draft.title,
      summary: draft.summary,
      payload: prepared.payload,
      sourceHash: artifactSourceHash(prepared.payload.kind, prepared.payload),
      assetManifestHash: assetManifestHash(prepared.assets),
      assets: prepared.assets,
      createdAt: now,
      createdBy: { origin: "agent", ...(caller.turnId ? { turnId: caller.turnId } : {}) },
    };
  }

  private summary(revision: StoredRevision): Record<string, unknown> {
    return {
      artifactId: revision.artifactId,
      revision: revision.revision,
      kind: revision.payload.kind,
      sourceHash: revision.sourceHash,
      assetManifestHash: revision.assetManifestHash,
      published: false,
      ...(revision.payload.kind === "workflow-snapshot"
        ? {
            workflow: {
              workflowId: revision.payload.snapshot.workflowId,
              runId: revision.payload.snapshot.runId,
              sourceRevision: revision.payload.snapshot.sourceRevision,
              capturedAt: revision.payload.snapshot.capturedAt,
              status: revision.payload.snapshot.status,
              completeness: revision.payload.snapshot.completeness.mode,
            },
          }
        : {}),
      next: "preview_artifact",
    };
  }
}

function unpublishedQuota(): ArtifactFailure {
  return new ArtifactFailure(
    artifactError("capacity_exceeded", "This conversation has too many unpublished artifacts", {
      resource: "unpublished-artifacts",
      retryClass: "never",
      suggestion: "Publish or update an existing draft instead of creating another.",
    }),
  );
}
