/**
 * Web annotation requests: preparation (including follow-ups and retargets),
 * send, the durable queue handoff, cancellation/recovery, and the background
 * reconciler. Results and the agent tool host live in
 * `web-annotation-service-results.ts`.
 *
 * Execution lives behind `WebAnnotationDispatchPort` (native dispatch is the
 * only execution authority). This layer owns the annotation-side record:
 * frozen selections, reservations, the persisted enqueue intent, and the
 * lifecycle projection. The storage queue is never held across a port call.
 */
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_TERMINAL_REQUEST_STATES,
  canTransitionWebAnnotationRequest,
  isWebAnnotationRequestActive,
  type WebAnnotation,
  type WebAnnotationBlockedReason,
  type WebAnnotationCancelRefusal,
  type WebAnnotationDestinationOption,
  type WebAnnotationDispatchMode,
  type WebAnnotationEntry,
  type WebAnnotationPrepareInput,
  type WebAnnotationPreparation,
  type WebAnnotationPreparationIssue,
  type WebAnnotationRequest,
  type WebAnnotationRequestCancelResult,
  type WebAnnotationRequestInteraction,
  type WebAnnotationRequestState,
  type WebAnnotationResponseExcerpt,
  type WebAnnotationSendInput,
  type WebAnnotationTurnOutcome,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationDestination,
  isWebAnnotationId,
} from "@orkestrator/protocol/web-annotations-validation";
import type {
  BriefAnnotationInput,
  BriefDestinationCapabilities,
  BriefFollowUp,
  CompiledBrief,
  DispatchObservation,
  PublishReceipt,
  WebAnnotationThreadSummary,
} from "./web-annotation-contracts.js";
import { retainedRequestCount } from "./web-annotation-assets.js";
import { WebAnnotationServiceResults } from "./web-annotation-service-results.js";
import { buildWebAnnotationThreadSummary } from "./web-annotation-thread-summary.js";
import { archivedError } from "./web-annotation-service-errors.js";
import {
  WebAnnotationServiceError,
  capacityError,
  conflictError,
  newId,
  notFound,
} from "./web-annotation-service-core.js";
import type {
  WebAnnotationEnvironmentStore,
  WebAnnotationManifest,
  WebAnnotationTransaction,
} from "./web-annotation-storage.js";

const MAX_PREPARATIONS = 64;
const BRIEF_ENTRY_LIMIT = 50;
const MAX_MATERIALIZE_FAILURES = 5;
const MAX_BACKOFF_MS = 60_000;
const RECONCILE_CONCURRENCY = 4;
const GC_EVERY_TICKS = 100;
const GC_DEADLINE_MS = 250;

interface PreparationCandidate {
  preparationId: string;
  environmentId: string;
  expiresAtMs: number;
  operation: WebAnnotationPrepareInput["operation"];
  destination: WebAnnotationPrepareInput["destination"];
  compiled: CompiledBrief;
  textOnly: boolean;
  sendable: boolean;
  blockers: string[];
  assetIds: string[];
  followUpOf: string | null;
  retargetOf: string | null;
}

interface StateUpdate {
  state: WebAnnotationRequestState;
  blockedReason?: WebAnnotationBlockedReason | null;
  reason?: string | null;
  dispatchConfirmed?: boolean;
  interactionIds?: string[];
  interactions?: WebAnnotationRequestInteraction[];
  turnOutcome?: WebAnnotationTurnOutcome;
  turnError?: string | null;
  transcript?: { messageId?: string; turnId?: string };
  destinationMissing?: boolean;
  cancelArrivedLate?: boolean;
  cancelSource?: "user" | "chat-queue" | "retarget";
  cancelRefusal?: { code: WebAnnotationCancelRefusal; message: string } | null;
  dispatchMode?: WebAnnotationDispatchMode;
  retargetedTo?: string;
}

function sanitizeReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return reason.replace(/\s+/g, " ").trim().slice(0, 300) || null;
}

/** Opaque provider interaction ids are bounded strings, not annotation ids. */
function isInteractionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export abstract class WebAnnotationServiceRequests extends WebAnnotationServiceResults {
  private readonly preparations = new Map<string, PreparationCandidate>();
  private preparing = 0;
  private readonly driving = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private readonly failures = new Map<string, number>();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private reconcileTicks = 0;
  private reconcileOffset = 0;
  private stopped = false;

  // -------------------------------------------------------------------------
  // Destinations and preparation

  protected requireDispatch() {
    const { dispatch, compileBrief, composeText } = this.options;
    if (!dispatch || !compileBrief || !composeText) {
      throw new WebAnnotationServiceError("Web annotation request dispatch is unavailable");
    }
    return { dispatch, compileBrief, composeText };
  }

  async destinations(
    environmentId: string,
  ): Promise<{ options: WebAnnotationDestinationOption[] }> {
    const { dispatch } = this.requireDispatch();
    await this.env(environmentId);
    return { options: await dispatch.listDestinations(environmentId, null) };
  }

  private pruneCandidates(): void {
    const now = this.nowMs();
    for (const [id, candidate] of Array.from(this.preparations)) {
      if (candidate.expiresAtMs <= now) this.dropCandidate(id);
    }
    while (this.preparations.size >= MAX_PREPARATIONS) {
      const oldest = this.preparations.keys().next().value;
      if (oldest === undefined) break;
      this.dropCandidate(oldest);
    }
  }

  private dropCandidate(preparationId: string): void {
    const candidate = this.preparations.get(preparationId);
    if (!candidate) return;
    this.preparations.delete(preparationId);
    this.releaseAssets(candidate.assetIds);
  }

  private async publishedEntries(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    annotationId: string,
  ): Promise<WebAnnotationEntry[]> {
    const indexes = (manifest.entries[annotationId] ?? [])
      .filter((entry) => !entry.supersededBy && entry.kind !== "lifecycle")
      .slice(-BRIEF_ENTRY_LIMIT);
    const entries: WebAnnotationEntry[] = [];
    for (const index of indexes) entries.push(await this.readEntry(store, index));
    return entries;
  }

  /** Entry ids an earlier request already delivered to this same session. */
  private deliveredEntryIds(
    manifest: WebAnnotationManifest,
    destination: WebAnnotationPrepareInput["destination"],
    annotationId: string,
  ): Set<string> {
    const delivered = new Set<string>();
    for (const request of Object.values(manifest.requests)) {
      if (
        request.destination.agent !== destination.agent ||
        request.destination.logicalSessionKey !== destination.logicalSessionKey
      ) {
        continue;
      }
      if (
        (request.state === "failed" || request.state === "cancelled") &&
        !request.dispatchConfirmedAt
      ) {
        continue;
      }
      for (const selection of request.selections) {
        if (selection.annotationId !== annotationId) continue;
        for (const id of selection.entryIds) delivered.add(id);
      }
    }
    return delivered;
  }

  /**
   * Deterministic excerpt of earlier discussion for the brief:
   *
   * - follow-up to the same session: the entries earlier requests already
   *   delivered (summarized, rather than silently skipped);
   * - a session other than the one(s) this thread was discussed with: the
   *   recent human/agent discussion.
   *
   * The latest host note is never excerpted: it stays the explicit instruction.
   */
  private threadSummaryFor(
    manifest: WebAnnotationManifest,
    annotation: WebAnnotation,
    entries: readonly WebAnnotationEntry[],
    delivered: ReadonlySet<string>,
    destination: WebAnnotationPrepareInput["destination"],
    followUp: boolean,
  ): WebAnnotationThreadSummary | null {
    const latestHost = entries
      .filter(
        (entry) =>
          entry.provenance === "host-user" &&
          entry.kind === "comment" &&
          !entry.supersededBy &&
          Boolean(entry.body?.trim()),
      )
      .sort((a, b) => a.sequence - b.sequence)
      .at(-1);
    if (followUp && delivered.size > 0) {
      return buildWebAnnotationThreadSummary(
        entries,
        (entry) => delivered.has(entry.id) && entry.id !== latestHost?.id,
        "follow-up",
      );
    }
    const discussedElsewhere = annotation.requestIds.some((id) => {
      const request = manifest.requests[id];
      return (
        request !== undefined &&
        (request.destination.agent !== destination.agent ||
          request.destination.logicalSessionKey !== destination.logicalSessionKey)
      );
    });
    if (!discussedElsewhere) return null;
    return buildWebAnnotationThreadSummary(
      entries,
      (entry) => entry.id !== latestHost?.id,
      "other-session",
    );
  }

  /** Why `old` cannot be replaced by a request to `destination`, or null. */
  private retargetBlocker(
    old: WebAnnotationRequest,
    destination: WebAnnotationPrepareInput["destination"],
  ): string | null {
    if (!isWebAnnotationRequestActive(old.state)) {
      return "The request has already settled; send a new request instead.";
    }
    if (old.dispatchConfirmedAt !== null || (old.state !== "prepared" && old.state !== "queued")) {
      return "The request may already have reached its agent; cancel or recover it instead.";
    }
    if (
      old.destination.agent === destination.agent &&
      old.destination.logicalSessionKey === destination.logicalSessionKey
    ) {
      return "Choose a different agent session to move this request to.";
    }
    return null;
  }

  async prepare(input: WebAnnotationPrepareInput): Promise<WebAnnotationPreparation> {
    const { dispatch, compileBrief } = this.requireDispatch();
    if (input.operation !== "discuss" && input.operation !== "implement") {
      throw new WebAnnotationServiceError("operation is invalid");
    }
    if (!isWebAnnotationDestination(input.destination)) {
      throw new WebAnnotationServiceError("destination is invalid");
    }
    const followUpOf = input.followUpOf ?? null;
    const retargetOf = input.retargetOf ?? null;
    if (followUpOf !== null && retargetOf !== null) {
      throw new WebAnnotationServiceError("followUpOf and retargetOf cannot be combined");
    }
    if (
      (followUpOf !== null && !isWebAnnotationId(followUpOf)) ||
      (retargetOf !== null && !isWebAnnotationId(retargetOf))
    ) {
      throw new WebAnnotationServiceError("request reference is invalid");
    }
    const defaultsSelection = followUpOf !== null || retargetOf !== null;
    if (
      !Array.isArray(input.annotations) ||
      (input.annotations.length === 0 && !defaultsSelection) ||
      input.annotations.length > WEB_ANNOTATION_LIMITS.briefAnnotations
    ) {
      throw capacityError(
        `a request holds 1 to ${WEB_ANNOTATION_LIMITS.briefAnnotations} annotations`,
      );
    }
    if (
      typeof input.instruction !== "string" ||
      input.instruction.length > WEB_ANNOTATION_LIMITS.instructionChars
    ) {
      throw capacityError(
        `instruction exceeds ${WEB_ANNOTATION_LIMITS.instructionChars} characters`,
      );
    }
    for (const item of input.annotations) {
      if (!isWebAnnotationId(item.annotationId) || !isWebAnnotationId(item.expectedCaptureId)) {
        throw new WebAnnotationServiceError("annotation selection is invalid");
      }
      if (
        item.desiredOutcome !== undefined &&
        item.desiredOutcome !== null &&
        (typeof item.desiredOutcome !== "string" ||
          item.desiredOutcome.length > WEB_ANNOTATION_LIMITS.desiredOutcomeChars)
      ) {
        throw capacityError(
          `desired outcome exceeds ${WEB_ANNOTATION_LIMITS.desiredOutcomeChars} characters`,
        );
      }
    }
    if (this.preparing >= WEB_ANNOTATION_LIMITS.simultaneousPreparations) {
      throw capacityError("too many request previews are being prepared; retry shortly");
    }
    this.preparing++;
    try {
      const store = await this.env(input.environmentId);
      const manifest = store.manifest;
      const issues: WebAnnotationPreparationIssue[] = [];
      let annotations = input.annotations;
      let instruction = input.instruction;
      let followUp: BriefFollowUp | null = null;
      const previousOutcomes = new Map<
        string,
        NonNullable<BriefAnnotationInput["previousOutcome"]>
      >();

      if (followUpOf !== null) {
        const previous = this.requireRequest(manifest, followUpOf);
        if (isWebAnnotationRequestActive(previous.state)) {
          throw new WebAnnotationServiceError(
            "The earlier request is still active; follow up after it settles",
          );
        }
        const selection = await this.followUpSelection(store, manifest, previous);
        for (const outcome of selection.result?.outcomes ?? []) {
          previousOutcomes.set(outcome.annotationId, {
            outcome: outcome.outcome,
            note: outcome.note,
          });
        }
        if (annotations.length === 0) {
          if (selection.remaining.length === 0) {
            throw new WebAnnotationServiceError(
              "Nothing remains to follow up on: every item was accepted, deleted, or reported addressed",
            );
          }
          annotations = selection.remaining.map((item) => {
            const annotation = manifest.annotations[item.annotationId]!;
            const earlier = previous.selections.find(
              (candidate) => candidate.annotationId === item.annotationId,
            );
            return {
              annotationId: annotation.id,
              expectedContentRevision: annotation.contentRevision,
              expectedCaptureId: annotation.currentCaptureId,
              desiredOutcome: earlier?.desiredOutcome ?? null,
              allowHistoricalEvidence: earlier?.historicalEvidence === true,
            };
          });
        }
        const reported =
          selection.result !== null &&
          (selection.result.reportedRevision ??
            (selection.result.provenance === "agent-reported"
              ? selection.result.revision
              : null)) !== null;
        followUp = {
          requestId: previous.id,
          state: previous.state,
          resultId: selection.resultId,
          summary: reported ? selection.result!.summary : null,
        };
      }

      if (retargetOf !== null) {
        const old = this.requireRequest(manifest, retargetOf);
        const blocker = this.retargetBlocker(old, input.destination);
        if (blocker) {
          issues.push({ code: "retarget-unavailable", severity: "blocker", message: blocker });
        }
        if (annotations.length === 0) {
          annotations = old.selections.map((selection) => {
            const annotation = manifest.annotations[selection.annotationId];
            if (!annotation || annotation.state === "deleted") throw notFound("Annotation");
            return {
              annotationId: annotation.id,
              expectedContentRevision: annotation.contentRevision,
              expectedCaptureId: annotation.currentCaptureId,
              desiredOutcome: selection.desiredOutcome,
              allowHistoricalEvidence: selection.historicalEvidence,
            };
          });
          if (!instruction.trim()) instruction = old.instruction;
        }
      }
      if (new Set(annotations.map((item) => item.annotationId)).size !== annotations.length) {
        throw new WebAnnotationServiceError("Each annotation may be selected once");
      }

      let capabilities: BriefDestinationCapabilities = {
        images: false,
        planMode: false,
        resultTools: false,
      };
      const validation = await dispatch
        .validateDestination(input.environmentId, input.destination)
        .catch(() => ({
          ok: false as const,
          reason: "Destination could not be validated",
          code: "destination-unavailable" as const,
        }));
      if (validation.ok) capabilities = validation.capabilities;
      else issues.push({ code: validation.code, severity: "blocker", message: validation.reason });

      const briefInputs: BriefAnnotationInput[] = [];
      for (const item of annotations) {
        const annotation = manifest.annotations[item.annotationId];
        if (!annotation || annotation.state === "deleted") throw notFound("Annotation");
        if (annotation.archivedAt) throw archivedError(annotation.continuationId);
        const unavailable = store.unavailableReason(annotation.id);
        if (unavailable) {
          issues.push({
            code: "missing-evidence",
            severity: "blocker",
            annotationId: annotation.id,
            message: "Stored records for this note are unavailable",
          });
        }
        if (annotation.contentRevision !== item.expectedContentRevision) {
          issues.push({
            code: "stale-revision",
            severity: "blocker",
            annotationId: annotation.id,
            message: "The note changed; refresh before sending",
          });
        }
        if (annotation.currentCaptureId !== item.expectedCaptureId) {
          issues.push({
            code: "stale-capture",
            severity: "blocker",
            annotationId: annotation.id,
            message: "The capture changed; refresh before sending",
          });
        }
        const active = annotation.activeRequestId
          ? manifest.requests[annotation.activeRequestId]
          : undefined;
        if (
          input.operation === "implement" &&
          active &&
          active.id !== retargetOf &&
          isWebAnnotationRequestActive(active.state)
        ) {
          issues.push({
            code: "active-implementation",
            severity: "blocker",
            annotationId: annotation.id,
            message: "Another implementation request is still active for this note",
          });
        }
        if (annotation.state === "resolved") {
          issues.push({
            code: "annotation-resolved",
            severity: "warning",
            annotationId: annotation.id,
            message: "This note is resolved",
          });
        }
        const capture = await this.readCapture(store, manifest, annotation.currentCaptureId);
        const assets = (capture?.assetIds ?? [])
          .map((id) => manifest.assets[id])
          .filter((asset): asset is NonNullable<typeof asset> => Boolean(asset))
          .map((asset) => this.publicAsset(input.environmentId, asset));
        const entries = await this.publishedEntries(store, manifest, annotation.id);
        const delivered = this.deliveredEntryIds(manifest, input.destination, annotation.id);
        briefInputs.push({
          annotation: this.project(store, annotation),
          capture,
          entries,
          assets,
          desiredOutcome: item.desiredOutcome ?? null,
          allowHistoricalEvidence: item.allowHistoricalEvidence === true,
          previouslyDeliveredEntryIds: delivered,
          threadSummary: this.threadSummaryFor(
            manifest,
            annotation,
            entries,
            delivered,
            input.destination,
            followUp !== null,
          ),
          previousOutcome: followUp
            ? (previousOutcomes.get(annotation.id) ?? { outcome: "unreported", note: null })
            : null,
        });
      }
      const compiled = compileBrief({
        operation: input.operation,
        destination: input.destination,
        annotations: briefInputs,
        instruction,
        textOnly: input.textOnly === true,
        capabilities,
        followUp,
      });
      const allIssues = [...issues, ...compiled.issues];
      const blockers = allIssues
        .filter((issue) => issue.severity === "blocker")
        .map((issue) => issue.code);
      this.pruneCandidates();
      const preparationId = newId("prep");
      const expiresAtMs = this.nowMs() + WEB_ANNOTATION_LIMITS.preparationTtlMs;
      const assetIds = compiled.attachments.map((attachment) => attachment.assetId);
      this.preparations.set(preparationId, {
        preparationId,
        environmentId: input.environmentId,
        expiresAtMs,
        operation: input.operation,
        destination: input.destination,
        compiled,
        textOnly: input.textOnly === true,
        sendable: blockers.length === 0,
        blockers,
        assetIds,
        followUpOf,
        retargetOf,
      });
      this.holdAssets(assetIds);
      return {
        preparationId,
        expiresAt: new Date(expiresAtMs).toISOString(),
        operation: input.operation,
        destination: input.destination,
        selections: compiled.selections,
        instruction: compiled.instruction,
        briefPreview: compiled.body,
        briefBytes: compiled.bytes,
        bodyHash: compiled.bodyHash,
        evidence: compiled.evidence,
        attachments: compiled.attachments.map((attachment) => ({
          assetId: attachment.assetId,
          bytes: attachment.bytes,
          digest: attachment.digest,
        })),
        textOnly: input.textOnly === true,
        readOnly: compiled.readOnly,
        issues: allIssues,
        sendable: blockers.length === 0,
        ...(followUpOf ? { followUpOf } : {}),
        ...(retargetOf ? { retargetOf } : {}),
      };
    } finally {
      this.preparing--;
    }
  }

  // -------------------------------------------------------------------------
  // Send

  async send(
    input: WebAnnotationSendInput,
  ): Promise<{ request: WebAnnotationRequest; deduplicated: boolean }> {
    const { dispatch } = this.requireDispatch();
    if (!isWebAnnotationId(input.requestId))
      throw new WebAnnotationServiceError("requestId is invalid");
    if (typeof input.bodyHash !== "string" || !/^[a-f0-9]{64}$/.test(input.bodyHash)) {
      throw new WebAnnotationServiceError("bodyHash is invalid");
    }
    const store = await this.env(input.environmentId);
    const existing = store.manifest.requests[input.requestId];
    if (existing) return this.dedupeSend(existing, input.bodyHash);
    const candidate = this.preparations.get(input.preparationId);
    if (
      !candidate ||
      candidate.environmentId !== input.environmentId ||
      candidate.expiresAtMs <= this.nowMs()
    ) {
      throw new WebAnnotationServiceError(
        "Web annotation preparation expired or was not found; prepare the request again",
      );
    }
    if (candidate.compiled.bodyHash !== input.bodyHash) {
      throw conflictError("request body does not match the prepared brief; prepare again");
    }
    if (!candidate.sendable) {
      throw new WebAnnotationServiceError(
        `Preparation has blocking issues: ${candidate.blockers.join(", ")}`,
      );
    }
    const validation = await dispatch.validateDestination(
      input.environmentId,
      candidate.destination,
    );
    if (!validation.ok)
      throw new WebAnnotationServiceError(
        `Destination unavailable: ${sanitizeReason(validation.reason) ?? "unknown"}`,
      );
    // A retarget first withdraws the old request's queue item through the
    // queue's atomic removal fence; if that fails nothing is sent.
    if (candidate.retargetOf) await this.withdrawForRetarget(store, candidate.retargetOf);

    const result = await store.mutate((tx) => {
      const raced = tx.manifest.requests[input.requestId];
      if (raced) return this.dedupeSend(raced, input.bodyHash);
      const count = retainedRequestCount(tx.manifest);
      if (count >= WEB_ANNOTATION_LIMITS.environmentRequests) {
        throw capacityError(
          `environment has ${count} of ${WEB_ANNOTATION_LIMITS.environmentRequests} requests`,
        );
      }
      const annotations: WebAnnotation[] = [];
      for (const selection of candidate.compiled.selections) {
        const annotation = tx.manifest.annotations[selection.annotationId];
        if (!annotation || annotation.state === "deleted") throw notFound("Annotation");
        if (annotation.archivedAt) throw archivedError(annotation.continuationId);
        if (annotation.contentRevision !== selection.contentRevision) {
          throw conflictError(
            `annotation ${annotation.id} changed after preparation (content revision); prepare again`,
          );
        }
        if (annotation.currentCaptureId !== selection.captureId) {
          throw conflictError(
            `annotation ${annotation.id} changed after preparation (capture); prepare again`,
          );
        }
        annotations.push(annotation);
      }
      // Settle the replaced request in this same commit, releasing its
      // reservations before the new request takes them.
      const replaced = candidate.retargetOf
        ? tx.manifest.requests[candidate.retargetOf]
        : undefined;
      if (replaced) {
        if (isWebAnnotationRequestActive(replaced.state)) {
          if (replaced.dispatchConfirmedAt !== null) {
            throw conflictError(`request ${replaced.id} reached its agent; it was not retargeted`);
          }
          this.applyStateInTx(tx, replaced, {
            state: "cancelled",
            reason: `Moved to another agent session as request ${input.requestId}`,
            cancelSource: "retarget",
            retargetedTo: input.requestId,
          });
        } else if (replaced.retargetedTo === undefined) {
          replaced.retargetedTo = input.requestId;
          replaced.revision++;
          replaced.updatedAt = tx.now;
          tx.touch({ requestIds: [replaced.id] });
        }
      }
      if (candidate.operation === "implement") {
        const conflicting = annotations.filter((annotation) => {
          const active = annotation.activeRequestId
            ? tx.manifest.requests[annotation.activeRequestId]
            : undefined;
          return active !== undefined && isWebAnnotationRequestActive(active.state);
        });
        if (conflicting.length > 0) {
          throw conflictError(
            `active implementation already reserved for ${conflicting.map((annotation) => annotation.id).join(", ")}; nothing was sent`,
          );
        }
      }
      const destination = candidate.destination;
      const request: WebAnnotationRequest = {
        id: input.requestId,
        environmentId: input.environmentId,
        schemaVersion: 1,
        revision: 1,
        operation: candidate.operation,
        destination,
        selections: candidate.compiled.selections,
        instruction: candidate.compiled.instruction,
        bodyHash: candidate.compiled.bodyHash,
        briefBytes: candidate.compiled.bytes,
        evidence: candidate.compiled.evidence,
        attachments: candidate.compiled.attachments.map((attachment) => ({ ...attachment })),
        textOnly: candidate.textOnly,
        readOnly: candidate.compiled.readOnly,
        state: "prepared",
        blockedReason: null,
        stateReason: null,
        reservation: candidate.operation === "implement",
        queueKey: `${destination.agent}\0${destination.logicalSessionKey}`,
        enqueueIntentAt: tx.now,
        queueReceiptAt: null,
        dispatchConfirmedAt: null,
        settledAt: null,
        cancelRequestedAt: null,
        abandonedAt: null,
        interactionIds: [],
        transcript: {
          requestId: input.requestId,
          agent: destination.agent,
          tabId: destination.tabId,
          logicalSessionKey: destination.logicalSessionKey,
        },
        response: null,
        resultIds: [],
        createdAt: tx.now,
        updatedAt: tx.now,
        ...(candidate.followUpOf ? { followUpOf: candidate.followUpOf } : {}),
        ...(candidate.retargetOf ? { retargetOf: candidate.retargetOf } : {}),
      };
      tx.writeRecord("brief", request.id, 1, {
        body: candidate.compiled.body,
        bodyHash: request.bodyHash,
      });
      tx.manifest.requests[request.id] = request;
      for (const attachment of request.attachments) {
        const asset = tx.manifest.assets[attachment.assetId];
        if (asset) asset.orphanedAt = null;
      }
      for (const annotation of annotations) {
        annotation.requestIds.push(request.id);
        if (request.reservation) annotation.activeRequestId = request.id;
        this.appendEntry(tx, annotation, {
          provenance: "system",
          kind: "lifecycle",
          body: null,
          lifecycle: { event: "request-sent", requestId: request.id, state: "prepared" },
          force: true,
        });
        this.bumpMetadata(tx, annotation);
      }
      tx.touch({ requestIds: [request.id] });
      return { request, deduplicated: false };
    });
    if (!result.value.deduplicated) this.dropCandidate(candidate.preparationId);
    await this.drive(input.environmentId, input.requestId).catch((error: unknown) => {
      console.warn(
        `[web-annotations] Request handoff deferred: ${error instanceof Error ? error.name : "unknown"}`,
      );
    });
    const latest = (await this.env(input.environmentId)).manifest.requests[input.requestId];
    return {
      request: { ...(latest ?? result.value.request) },
      deduplicated: result.value.deduplicated,
    };
  }

  /**
   * Remove a never-dispatched request's queue item before its replacement is
   * committed. A `prepared` request is fenced by its cancel marker and the
   * single-flight handoff; a `queued` one by the queue's atomic removal. Any
   * sign that it may have reached the agent refuses the retarget.
   */
  private async withdrawForRetarget(
    store: WebAnnotationEnvironmentStore,
    requestId: string,
  ): Promise<void> {
    const { dispatch } = this.requireDispatch();
    const current = store.manifest.requests[requestId];
    if (!current || !isWebAnnotationRequestActive(current.state)) return;
    const refuse = (why: string) =>
      conflictError(`request ${requestId} was not retargeted: ${why}; nothing was sent`);
    if (current.dispatchConfirmedAt !== null) throw refuse("it reached its agent");
    if (current.state === "prepared") {
      await store.mutate((tx) => {
        const request = tx.manifest.requests[requestId];
        if (!request || request.cancelRequestedAt) return;
        tx.markEssential();
        request.cancelRequestedAt = tx.now;
        request.revision++;
        request.updatedAt = tx.now;
        tx.touch({ requestIds: [requestId] });
      });
      await this.driving.get(`${current.environmentId}\0${requestId}`)?.catch(() => undefined);
    }
    const latest = store.manifest.requests[requestId];
    if (!latest || !isWebAnnotationRequestActive(latest.state) || latest.state === "prepared") {
      return;
    }
    if (latest.state !== "queued") throw refuse("it is being delivered or ran");
    const outcome = await dispatch.cancel({ ...latest });
    if (outcome.outcome !== "cancelled") {
      throw refuse(outcome.outcome === "not-cancellable" ? outcome.reason : "it is running");
    }
  }

  private dedupeSend(existing: WebAnnotationRequest, bodyHash: string) {
    if (existing.bodyHash !== bodyHash) {
      throw conflictError(`request id ${existing.id} was already used for a different brief`);
    }
    return { request: { ...existing }, deduplicated: true };
  }

  // -------------------------------------------------------------------------
  // Durable handoff (outside the write queue)

  /** Single-flight per request: materialize then publish a `prepared` request. */
  protected drive(environmentId: string, requestId: string): Promise<void> {
    const key = `${environmentId}\0${requestId}`;
    const existing = this.driving.get(key);
    if (existing) return existing;
    const run = this.driveOnce(environmentId, requestId).finally(() => {
      this.driving.delete(key);
    });
    this.driving.set(key, run);
    return run;
  }

  private backoff(key: string): void {
    const failures = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, failures);
    this.retryAt.set(
      key,
      this.nowMs() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(failures, 6)),
    );
  }

  private clearBackoff(key: string): void {
    this.failures.delete(key);
    this.retryAt.delete(key);
  }

  private async driveOnce(environmentId: string, requestId: string): Promise<void> {
    const { dispatch, composeText } = this.requireDispatch();
    const store = await this.env(environmentId);
    let request = store.manifest.requests[requestId];
    if (!request || request.state !== "prepared") return;
    const key = `${environmentId}\0${requestId}`;
    if (request.cancelRequestedAt) {
      await this.updateRequestState(store, requestId, {
        state: "cancelled",
        reason: "Cancelled before queue publication",
      });
      return;
    }
    const environment = await this.hostEnvironment(environmentId);
    if (!environment) return;
    const pending = request.attachments.filter((attachment) => !attachment.materializedPath);
    if (pending.length > 0) {
      let materialized;
      try {
        materialized = await dispatch.materialize({
          environment: {
            id: environment.id,
            environmentType: environment.environmentType,
            ...(environment.worktreePath ? { worktreePath: environment.worktreePath } : {}),
            ...(environment.containerId ? { containerId: environment.containerId } : {}),
          },
          requestId,
          attachments: request.attachments.map((attachment) => ({ ...attachment })),
          readAsset: (assetId) => {
            if (!request!.attachments.some((attachment) => attachment.assetId === assetId)) {
              return Promise.reject(
                new WebAnnotationServiceError("Asset is not part of this request"),
              );
            }
            return store.readAsset(assetId);
          },
        });
      } catch (error) {
        this.backoff(key);
        const failures = this.failures.get(key) ?? 0;
        console.warn(
          `[web-annotations] Evidence materialization failed (${failures}): ${error instanceof Error ? error.name : "unknown"}`,
        );
        if (failures >= MAX_MATERIALIZE_FAILURES) {
          await this.updateRequestState(store, requestId, {
            state: "failed",
            reason: "Evidence could not be written to the workspace",
          });
          this.clearBackoff(key);
        }
        return;
      }
      const byAsset = new Map(materialized.map((attachment) => [attachment.assetId, attachment]));
      await store.mutate((tx) => {
        const current = tx.manifest.requests[requestId];
        if (!current || current.state !== "prepared") return;
        tx.markEssential();
        let changed = false;
        current.attachments = current.attachments.map((attachment) => {
          const written = byAsset.get(attachment.assetId);
          if (
            !written?.materializedPath ||
            written.materializedPath === attachment.materializedPath
          )
            return attachment;
          changed = true;
          return { ...attachment, materializedPath: written.materializedPath };
        });
        if (!changed) return;
        current.revision++;
        current.updatedAt = tx.now;
        tx.touch({ requestIds: [requestId] });
      });
      request = store.manifest.requests[requestId];
      if (!request || request.state !== "prepared") return;
      if (request.cancelRequestedAt) {
        await this.updateRequestState(store, requestId, {
          state: "cancelled",
          reason: "Cancelled before queue publication",
        });
        return;
      }
    }
    let body: string;
    try {
      body = (await store.readRecord<{ body: string }>("brief", requestId, 1)).body;
    } catch {
      for (const selection of request.selections)
        store.markUnavailable(selection.annotationId, "request record unreadable");
      return;
    }
    const text = composeText(requestId, { body }, request.operation, request.selections.length);
    let receipt: PublishReceipt;
    try {
      receipt = await dispatch.publish({ request: { ...request }, text });
    } catch (error) {
      // Publication is idempotent by request id; retry later, never a new id.
      this.backoff(key);
      console.warn(
        `[web-annotations] Queue publication deferred: ${error instanceof Error ? error.name : "unknown"}`,
      );
      return;
    }
    this.clearBackoff(key);
    if (receipt.status === "rejected") {
      await this.updateRequestState(store, requestId, { state: "failed", reason: receipt.reason });
      return;
    }
    await store.mutate((tx) => {
      const current = tx.manifest.requests[requestId];
      if (!current) return;
      tx.markEssential();
      if (!current.queueReceiptAt) current.queueReceiptAt = tx.now;
      if (receipt.status === "queued" && receipt.dispatchMode && !current.dispatchMode) {
        current.dispatchMode = receipt.dispatchMode;
      }
      if (current.state === "prepared") {
        this.applyStateInTx(tx, current, { state: "queued" });
      }
      current.revision++;
      current.updatedAt = tx.now;
      tx.touch({ requestIds: [requestId] });
    });
  }

  // -------------------------------------------------------------------------
  // State projection

  /**
   * Apply a suggested state inside a transaction. Terminal requests never
   * change; invalid transitions keep the current state (no regression).
   * Terminal states release reservations, clear pending interactions and the
   * provisional flag on results, and append `request-settled`, but never
   * resolve an annotation.
   */
  protected applyStateInTx(
    tx: WebAnnotationTransaction,
    request: WebAnnotationRequest,
    update: StateUpdate,
  ): boolean {
    if (!isWebAnnotationRequestActive(request.state)) return false;
    let changed = false;
    const previous = request.state;
    const set = <K extends keyof WebAnnotationRequest>(key: K, value: WebAnnotationRequest[K]) => {
      if (JSON.stringify(request[key] ?? null) === JSON.stringify(value ?? null)) return;
      request[key] = value;
      changed = true;
    };
    if (
      update.state !== request.state &&
      (canTransitionWebAnnotationRequest(request.state, update.state) ||
        // A turn can be accepted and finish between two observations (a fast
        // turn, or a backend restart). With dispatch confirmed, the request
        // passed through `running` even though no observation saw it there.
        (update.dispatchConfirmed === true &&
          canTransitionWebAnnotationRequest(request.state, "running") &&
          canTransitionWebAnnotationRequest("running", update.state)))
    ) {
      request.state = update.state;
      changed = true;
    }
    if (update.blockedReason !== undefined) set("blockedReason", update.blockedReason);
    const reason = update.reason === undefined ? undefined : sanitizeReason(update.reason);
    if (reason !== undefined) set("stateReason", reason);
    if (update.dispatchConfirmed && !request.dispatchConfirmedAt) {
      request.dispatchConfirmedAt = tx.now;
      changed = true;
    }
    if (update.interactions) {
      const items = update.interactions.filter((item) => isInteractionId(item.id)).slice(0, 16);
      set("interactions", items);
      set(
        "interactionIds",
        items.map((item) => item.id),
      );
    } else if (update.interactionIds) {
      set("interactionIds", update.interactionIds.filter(isInteractionId).slice(0, 32));
    }
    if (update.dispatchMode !== undefined) set("dispatchMode", update.dispatchMode);
    if (update.transcript) {
      const { messageId, turnId } = update.transcript;
      set("transcript", {
        ...request.transcript,
        ...(messageId && isInteractionId(messageId) ? { messageId } : {}),
        ...(turnId && isInteractionId(turnId) ? { turnId } : {}),
      });
    }
    if (update.destinationMissing === true && !request.destinationMissingAt) {
      set("destinationMissingAt", tx.now);
    } else if (update.destinationMissing === false && request.destinationMissingAt) {
      set("destinationMissingAt", null);
    }
    if (update.cancelRefusal !== undefined) {
      const refusal = update.cancelRefusal;
      const current = request.cancelRefusal ?? null;
      const message = refusal ? (sanitizeReason(refusal.message) ?? refusal.code) : null;
      if (
        !refusal ? current !== null : current?.code !== refusal.code || current.message !== message
      ) {
        request.cancelRefusal = refusal
          ? { code: refusal.code, message: message!, at: tx.now }
          : null;
        changed = true;
      }
    }
    if (!changed) return false;
    const terminal = WEB_ANNOTATION_TERMINAL_REQUEST_STATES.has(request.state);
    if (terminal) {
      request.blockedReason = null;
      request.reservation = false;
      request.settledAt = tx.now;
      request.interactions = [];
      request.interactionIds = [];
      if (request.state === "abandoned-unconfirmed") request.abandonedAt = tx.now;
      if (update.turnOutcome !== undefined) request.turnOutcome = update.turnOutcome;
      if (update.turnError !== undefined) request.turnError = update.turnError;
      if (update.cancelArrivedLate) request.cancelArrivedLate = true;
      if (update.cancelSource && request.state === "cancelled") {
        request.cancelSource = update.cancelSource;
      }
      if (update.retargetedTo) request.retargetedTo = update.retargetedTo;
      this.settleResultsInTx(tx, request);
    }
    request.revision++;
    request.updatedAt = tx.now;
    for (const selection of request.selections) {
      const annotation = tx.manifest.annotations[selection.annotationId];
      if (!annotation) continue;
      if (terminal) {
        if (annotation.activeRequestId === request.id) annotation.activeRequestId = null;
        this.appendEntry(tx, annotation, {
          provenance: "system",
          kind: "lifecycle",
          body: null,
          lifecycle: { event: "request-settled", requestId: request.id, state: request.state },
          force: true,
        });
      }
      if (terminal || previous !== request.state) this.bumpMetadata(tx, annotation);
    }
    tx.markEssential();
    tx.touch({ requestIds: [request.id] });
    return true;
  }

  protected async updateRequestState(
    store: WebAnnotationEnvironmentStore,
    requestId: string,
    update: StateUpdate,
  ): Promise<WebAnnotationRequest | undefined> {
    await store.mutate((tx) => {
      const request = tx.manifest.requests[requestId];
      if (request) this.applyStateInTx(tx, request, update);
    });
    return store.manifest.requests[requestId];
  }

  private async applyObservation(
    store: WebAnnotationEnvironmentStore,
    requestId: string,
    observation: DispatchObservation,
  ): Promise<void> {
    const request = store.manifest.requests[requestId];
    if (!request || !isWebAnnotationRequestActive(request.state)) return;
    await this.updateRequestState(store, requestId, {
      state: observation.state,
      blockedReason: observation.blockedReason,
      reason: observation.reason,
      dispatchConfirmed: observation.dispatchConfirmed,
      interactionIds: observation.interactionIds,
      destinationMissing: observation.destinationMissing,
      ...(observation.interactions ? { interactions: observation.interactions } : {}),
      ...(observation.turnOutcome ? { turnOutcome: observation.turnOutcome } : {}),
      ...(observation.turnError !== undefined ? { turnError: observation.turnError } : {}),
      ...(observation.transcript ? { transcript: observation.transcript } : {}),
      ...(observation.cancelArrivedLate ? { cancelArrivedLate: true } : {}),
      ...(observation.cancelSource ? { cancelSource: observation.cancelSource } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Reads, cancel, recover, response

  async listRequests(
    environmentId: string,
    options: { annotationId?: string; activeOnly?: boolean } = {},
  ) {
    const store = await this.env(environmentId);
    const manifest = store.manifest;
    let requests = Object.values(manifest.requests);
    if (options.annotationId !== undefined) {
      const annotation = this.requireAnnotation(manifest, options.annotationId);
      const ids = new Set(annotation.requestIds);
      requests = requests.filter((request) => ids.has(request.id));
    }
    if (options.activeOnly)
      requests = requests.filter((request) => isWebAnnotationRequestActive(request.state));
    requests.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return { requests: requests.slice(0, 200).map((request) => ({ ...request })) };
  }

  async cancelRequest(
    environmentId: string,
    requestId: string,
    expectedRevision: number,
  ): Promise<WebAnnotationRequestCancelResult> {
    this.requireDispatch();
    const store = await this.env(environmentId);
    const request = this.requireRequest(store.manifest, requestId);
    if (request.revision !== expectedRevision) {
      throw conflictError(
        `request revision ${expectedRevision} is stale (current ${request.revision})`,
      );
    }
    return this.cancelActiveRequest(store, request, "user");
  }

  /**
   * The user removed an annotation request from the ordinary chat queue.
   * That is a cancellation of the request: settle it through the same fence
   * as the annotation panel's Cancel. Returns null when this service does not
   * own an active request with that id (the caller removes the queue item).
   */
  async cancelFromChatQueue(
    environmentId: string,
    requestId: string,
  ): Promise<{ removed: boolean; request: WebAnnotationRequest } | null> {
    if (!this.options.dispatch || !isWebAnnotationId(requestId)) return null;
    const store = await this.env(environmentId).catch(() => null);
    const request = store?.manifest.requests[requestId];
    if (!store || !request || !isWebAnnotationRequestActive(request.state)) return null;
    const result = await this.cancelActiveRequest(store, request, "chat-queue");
    return { removed: result.outcome === "cancelled", request: result.request };
  }

  private async cancelActiveRequest(
    store: WebAnnotationEnvironmentStore,
    request: WebAnnotationRequest,
    source: "user" | "chat-queue",
  ): Promise<WebAnnotationRequestCancelResult> {
    const { dispatch } = this.requireDispatch();
    const requestId = request.id;
    if (!isWebAnnotationRequestActive(request.state)) {
      return { request: { ...request }, outcome: "not-cancellable", refusal: "not-active" };
    }
    await store.mutate((tx) => {
      const current = tx.manifest.requests[requestId];
      if (!current || current.cancelRequestedAt) return;
      tx.markEssential();
      current.cancelRequestedAt = tx.now;
      current.revision++;
      current.updatedAt = tx.now;
      tx.touch({ requestIds: [requestId] });
    });
    // Let an in-flight handoff settle so cancellation cannot race publication.
    await this.driving.get(`${request.environmentId}\0${requestId}`)?.catch(() => undefined);
    let latest = store.manifest.requests[requestId]!;
    if (!isWebAnnotationRequestActive(latest.state)) {
      return {
        request: { ...latest },
        outcome: latest.state === "cancelled" ? "cancelled" : "not-cancellable",
        ...(latest.state === "cancelled" ? {} : { refusal: "not-active" as const }),
      };
    }
    const outcome = await dispatch.cancel({ ...latest });
    if (outcome.outcome === "cancelled") {
      latest =
        (await this.updateRequestState(store, requestId, {
          state: "cancelled",
          reason:
            outcome.reason ??
            (source === "chat-queue" ? "Removed from the chat queue" : "Cancelled by the user"),
          cancelSource: source,
          cancelRefusal: null,
        })) ?? latest;
      return {
        request: { ...latest },
        outcome: latest.state === "cancelled" ? "cancelled" : "cancelling",
      };
    }
    if (outcome.outcome === "cancelling") {
      latest =
        (await this.updateRequestState(store, requestId, {
          state: "cancelling",
          cancelRefusal: null,
        })) ?? latest;
      return { request: { ...latest }, outcome: "cancelling" };
    }
    latest =
      (await this.updateRequestState(store, requestId, {
        state: latest.state,
        reason: outcome.reason,
        cancelRefusal: { code: outcome.code, message: outcome.reason },
      })) ?? latest;
    return { request: { ...latest }, outcome: "not-cancellable", refusal: outcome.code };
  }

  async recoverRequest(
    environmentId: string,
    requestId: string,
    action: "reconcile" | "retry" | "discard",
  ) {
    const { dispatch } = this.requireDispatch();
    if (action !== "reconcile" && action !== "retry" && action !== "discard") {
      throw new WebAnnotationServiceError("action is invalid");
    }
    const store = await this.env(environmentId);
    const request = this.requireRequest(store.manifest, requestId);
    if (!isWebAnnotationRequestActive(request.state)) return { request: { ...request } };
    if (request.state === "prepared" && action !== "discard") {
      this.clearBackoff(`${environmentId}\0${requestId}`);
      await this.drive(environmentId, requestId);
    } else {
      const observation = await dispatch.recover({ ...request }, action);
      await this.applyObservation(store, requestId, observation);
    }
    return { request: { ...store.manifest.requests[requestId]! } };
  }

  async followUp(environmentId: string, requestId: string) {
    return this.followUpCandidates(environmentId, requestId);
  }

  async requestResponse(
    environmentId: string,
    requestId: string,
  ): Promise<{
    request: WebAnnotationRequest;
    response: WebAnnotationResponseExcerpt | null;
    sourceAvailable: boolean;
  }> {
    const { dispatch } = this.requireDispatch();
    const store = await this.env(environmentId);
    const request = this.requireRequest(store.manifest, requestId);
    const read = await dispatch.readResponse({ ...request });
    const excerpt = read.excerpt
      ? {
          text: read.excerpt.text.slice(0, WEB_ANNOTATION_LIMITS.responseExcerptChars),
          capturedAt: read.excerpt.capturedAt,
          provenance: "agent-reference" as const,
          ...(read.excerpt.messageId && isWebAnnotationId(read.excerpt.messageId)
            ? { messageId: read.excerpt.messageId }
            : {}),
          truncated:
            read.excerpt.truncated ||
            read.excerpt.text.length > WEB_ANNOTATION_LIMITS.responseExcerptChars,
        }
      : null;
    // The prompt's own transcript message/turn, so clients can navigate to it.
    const anchor = read.transcript;
    const anchorMessageId =
      anchor?.messageId && isInteractionId(anchor.messageId) ? anchor.messageId : undefined;
    const anchorTurnId =
      anchor?.turnId && isInteractionId(anchor.turnId) ? anchor.turnId : undefined;
    const anchorChanged =
      (anchorMessageId !== undefined && request.transcript.messageId !== anchorMessageId) ||
      (anchorTurnId !== undefined && request.transcript.turnId !== anchorTurnId);
    const excerptChanged =
      excerpt !== null &&
      (request.response?.text !== excerpt.text ||
        request.response?.messageId !== excerpt.messageId);
    if (excerptChanged || anchorChanged) {
      await store.mutate((tx) => {
        const current = tx.manifest.requests[requestId];
        if (!current) return;
        tx.markEssential();
        if (anchorChanged) {
          current.transcript = {
            ...current.transcript,
            ...(anchorMessageId ? { messageId: anchorMessageId } : {}),
            ...(anchorTurnId ? { turnId: anchorTurnId } : {}),
          };
        }
        const first = current.response === null;
        if (excerptChanged && excerpt) current.response = excerpt;
        current.revision++;
        current.updatedAt = tx.now;
        tx.touch({ requestIds: [requestId] });
        if (!first || !excerptChanged || !excerpt) return;
        for (const selection of current.selections) {
          const annotation = tx.manifest.annotations[selection.annotationId];
          if (!annotation || annotation.state === "deleted") continue;
          this.appendEntry(tx, annotation, {
            provenance: "agent-reference",
            kind: "agent-response",
            body: excerpt.text,
            transcript: {
              ...current.transcript,
              ...(excerpt.messageId ? { messageId: excerpt.messageId } : {}),
            },
            force: true,
          });
          this.bumpMetadata(tx, annotation);
        }
      });
    }
    const latest = store.manifest.requests[requestId]!;
    return {
      request: { ...latest },
      response: latest.response ?? excerpt,
      sourceAvailable: read.sourceAvailable,
    };
  }

  // -------------------------------------------------------------------------
  // Background reconciler

  startReconciler(
    intervalMs = this.options.reconcileIntervalMs ?? WEB_ANNOTATION_LIMITS.reconcileIntervalMs,
  ): void {
    if (this.reconcileTimer || this.stopped) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcileOnce().catch((error: unknown) => {
        console.warn(
          `[web-annotations] Reconcile pass failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      });
    }, intervalMs);
    this.reconcileTimer.unref?.();
    void this.reconcileOnce().catch(() => undefined);
  }

  stopReconciler(): void {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /** One bounded pass. Safe to call concurrently; overlapping calls share it. */
  reconcileOnce(): Promise<void> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const run = this.runReconcile().finally(() => {
      this.reconcileInFlight = null;
    });
    this.reconcileInFlight = run;
    return run;
  }

  private async runReconcile(): Promise<void> {
    if (this.stopped) return;
    await this.initialize();
    this.reconcileTicks++;
    const work: Array<{ environmentId: string; requestId: string }> = [];
    if (this.options.dispatch) {
      const all: Array<{ environmentId: string; requestId: string }> = [];
      for (const environmentId of this.storage.loadedEnvironmentIds()) {
        const store = await this.storage.environment(environmentId).catch(() => null);
        if (!store || store.status !== "ready" || store.isClosed) continue;
        for (const requestId of store.activeRequestIds()) all.push({ environmentId, requestId });
      }
      const batch = Math.min(all.length, WEB_ANNOTATION_LIMITS.requestRecoveryBatch);
      const offset = all.length > 0 ? this.reconcileOffset % all.length : 0;
      for (let index = 0; index < batch; index++) work.push(all[(offset + index) % all.length]!);
      this.reconcileOffset = offset + batch;
    }
    let cursor = 0;
    const worker = async () => {
      while (cursor < work.length && !this.stopped) {
        const item = work[cursor++]!;
        await this.reconcileRequest(item.environmentId, item.requestId).catch((error: unknown) => {
          console.warn(
            `[web-annotations] Request reconcile failed: ${error instanceof Error ? error.name : "unknown"}`,
          );
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(RECONCILE_CONCURRENCY, work.length) }, worker));
    if (this.reconcileTicks % GC_EVERY_TICKS === 1) await this.collectAllGarbage();
  }

  private async collectAllGarbage(): Promise<void> {
    const deadline = Date.now() + GC_DEADLINE_MS;
    for (const environmentId of this.storage.loadedEnvironmentIds()) {
      if (Date.now() >= deadline || this.stopped) return;
      await this.collectGarbage(environmentId, { deadline }).catch((error: unknown) => {
        console.warn(
          `[web-annotations] Garbage collection failed: ${error instanceof Error ? error.name : "unknown"}`,
        );
      });
    }
  }

  private async reconcileRequest(environmentId: string, requestId: string): Promise<void> {
    const dispatch = this.options.dispatch;
    if (!dispatch) return;
    const store = await this.env(environmentId);
    const request = store.manifest.requests[requestId];
    if (!request || !isWebAnnotationRequestActive(request.state)) return;
    const key = `${environmentId}\0${requestId}`;
    if ((this.retryAt.get(key) ?? 0) > this.nowMs()) return;
    if (request.state === "prepared") {
      // Re-drive a committed enqueue intent with the same id; publication
      // dedupes against queued, in-flight, and consumed ids.
      await this.drive(environmentId, requestId);
      return;
    }
    const observation = await dispatch.observe({ ...request });
    await this.applyObservation(store, requestId, observation);
  }

  override async close(): Promise<void> {
    this.stopReconciler();
    await this.reconcileInFlight?.catch(() => undefined);
    await Promise.all(Array.from(this.driving.values()).map((run) => run.catch(() => undefined)));
    await super.close();
  }

  override async deleteEnvironment(environmentId: string): Promise<void> {
    for (const [id, candidate] of Array.from(this.preparations)) {
      if (candidate.environmentId === environmentId) this.dropCandidate(id);
    }
    await super.deleteEnvironment(environmentId);
  }
}
