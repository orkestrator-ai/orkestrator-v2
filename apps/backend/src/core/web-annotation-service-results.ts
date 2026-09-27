/**
 * Web annotation results: after-capture comparison evidence, agent-reported
 * results, follow-up selection, and the agent tool host.
 *
 * Result revisions form one chain per request (any provenance). Every new
 * revision carries the latest agent report forward *and* accumulates
 * app-observed captures, so the newest revision shows both without
 * flattening one into the other. Records are immutable; `provisional` is
 * derived from the request still being active, so settlement clears it.
 */
import {
  WEB_ANNOTATION_LIMITS,
  isWebAnnotationRequestActive,
  type WebAnnotation,
  type WebAnnotationCapture,
  type WebAnnotationCaptureInput,
  type WebAnnotationComparisonDifference,
  type WebAnnotationComparisonMetadata,
  type WebAnnotationEntry,
  type WebAnnotationFileCheck,
  type WebAnnotationFollowUpCandidates,
  type WebAnnotationGetResult,
  type WebAnnotationRequest,
  type WebAnnotationResult,
  type WebAnnotationResultCaptureInput,
  type WebAnnotationResultCaptureMetadata,
  type WebAnnotationResultObservation,
  type WebAnnotationTarget,
} from "@orkestrator/protocol/web-annotations";
import {
  isWebAnnotationId,
  validateWebAnnotationResultCaptureMetadata,
  validateWebAnnotationResultReport,
  type WebAnnotationResultReportInput,
} from "@orkestrator/protocol/web-annotations-validation";
import type { WebAnnotationToolHost, WebAnnotationToolScope } from "./web-annotation-contracts.js";
import {
  WebAnnotationServiceCore,
  WebAnnotationServiceError,
  capacityError,
  conflictError,
  hashBody,
  newId,
  notFound,
} from "./web-annotation-service-core.js";
import type {
  ManifestResult,
  WebAnnotationEnvironmentStore,
  WebAnnotationManifest,
  WebAnnotationTransaction,
} from "./web-annotation-storage.js";

const MAX_OBSERVATIONS = WEB_ANNOTATION_LIMITS.resultRevisions;
const MAX_EVIDENCE_IDS = 50;

function targetIdentity(target: WebAnnotationTarget): string | null {
  switch (target.kind) {
    case "element":
      return target.anchor.stableId
        ? `stable:${target.anchor.stableId.kind}:${target.anchor.stableId.value}`
        : `css:${target.anchor.cssPath}`;
    case "text-range":
      return `text:${target.container.cssPath}:${target.quote.exact}`;
    case "region":
      return "region";
    case "page":
      return "page";
    default:
      return null;
  }
}

function differs(a: number | undefined, b: number | undefined): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) > 0.001;
}

/**
 * Compare an after-capture with the original evidence. Differences are
 * labelled, never resolved away: an unmatched target is evidence of changed
 * identity, not proof that the target was removed as requested.
 */
export function webAnnotationComparison(
  annotation: Pick<WebAnnotation, "contentRevision" | "captureRevision">,
  original: WebAnnotationCapture | null,
  after: WebAnnotationCaptureInput,
  metadata: WebAnnotationResultCaptureMetadata,
  comparedCaptureId: string,
): WebAnnotationComparisonMetadata {
  const differences: WebAnnotationComparisonDifference[] = [];
  let targetMatch: WebAnnotationComparisonMetadata["targetMatch"] = "no-target";
  if (original) {
    if (original.page.route !== after.page.route) differences.push("route");
    if (JSON.stringify(original.page.service) !== JSON.stringify(after.page.service)) {
      differences.push("service");
    }
    const before = original.geometry;
    const now = after.geometry;
    if (
      before &&
      now &&
      (before.viewport.width !== now.viewport.width ||
        before.viewport.height !== now.viewport.height)
    ) {
      differences.push("viewport");
    }
    if (differs(before?.zoomFactor, metadata.zoomFactor ?? now?.zoomFactor)) {
      differences.push("zoom");
    }
    if (differs(before?.devicePixelRatio, metadata.deviceScaleFactor ?? now?.devicePixelRatio)) {
      differences.push("device-scale");
    }
    const beforeTarget = targetIdentity(original.target);
    const afterTarget = targetIdentity(after.target);
    if (metadata.targetResolution && metadata.targetResolution.state !== "matched") {
      targetMatch =
        metadata.targetResolution.state === "missing" ? "no-target" : "different-target";
    } else if (beforeTarget !== null && beforeTarget === afterTarget) {
      targetMatch = "same-target";
    } else {
      targetMatch = afterTarget === null ? "no-target" : "different-target";
    }
    if (targetMatch !== "same-target") differences.push("target");
  }
  if (metadata.stability === "unstable") differences.push("unstable");
  return {
    ...metadata,
    contentRevision: annotation.contentRevision,
    captureRevision: annotation.captureRevision,
    comparedCaptureId,
    targetMatch,
    differences,
  };
}

export abstract class WebAnnotationServiceResults extends WebAnnotationServiceCore {
  protected requireRequest(
    manifest: WebAnnotationManifest,
    requestId: string,
  ): WebAnnotationRequest {
    const request = isWebAnnotationId(requestId) ? manifest.requests[requestId] : undefined;
    if (!request) throw notFound("Request");
    return request;
  }

  /** A result is provisional only while its request can still execute. */
  protected projectResult(
    result: WebAnnotationResult,
    request: WebAnnotationRequest | undefined,
  ): WebAnnotationResult {
    const provisional =
      result.provisional && request !== undefined && isWebAnnotationRequestActive(request.state);
    return provisional === result.provisional ? result : { ...result, provisional };
  }

  /** Settlement clears the provisional flag on the request's result indexes. */
  protected settleResultsInTx(tx: WebAnnotationTransaction, request: WebAnnotationRequest): void {
    for (const result of Object.values(tx.manifest.results)) {
      if (result.requestId === request.id && result.provisional) result.provisional = false;
    }
  }

  override async get(
    ...args: Parameters<WebAnnotationServiceCore["get"]>
  ): Promise<WebAnnotationGetResult> {
    const got = await super.get(...args);
    const requests = new Map(got.requests.map((request) => [request.id, request]));
    return {
      ...got,
      results: got.results.map((result) =>
        this.projectResult(result, requests.get(result.requestId)),
      ),
    };
  }

  async getRequest(
    environmentId: string,
    requestId: string,
  ): Promise<{ request: WebAnnotationRequest; results: WebAnnotationResult[] }> {
    const store = await this.env(environmentId);
    const request = this.requireRequest(store.manifest, requestId);
    const results: WebAnnotationResult[] = [];
    for (const id of request.resultIds.slice(-WEB_ANNOTATION_LIMITS.resultRevisions)) {
      const result = await this.readResult(store, id);
      if (result) results.push(this.projectResult(result, request));
    }
    return { request: { ...request }, results };
  }

  // -------------------------------------------------------------------------
  // Result chain

  protected resultsFor(manifest: WebAnnotationManifest, requestId: string): ManifestResult[] {
    return Object.values(manifest.results)
      .filter((result) => result.requestId === requestId)
      .sort((a, b) => a.revision - b.revision);
  }

  /** Latest result index for a request, optionally of one provenance. */
  protected latestResult(
    manifest: WebAnnotationManifest,
    requestId: string,
    provenance?: WebAnnotationResult["provenance"],
  ): ManifestResult | null {
    return (
      this.resultsFor(manifest, requestId)
        .filter((result) => provenance === undefined || result.provenance === provenance)
        .at(-1) ?? null
    );
  }

  protected writeResult(
    tx: WebAnnotationTransaction,
    request: WebAnnotationRequest,
    result: WebAnnotationResult,
  ): void {
    const bytes = tx.writeRecord("result", result.id, 1, result);
    tx.manifest.results[result.id] = {
      id: result.id,
      requestId: request.id,
      revision: result.revision,
      provenance: result.provenance,
      provisional: result.provisional,
      assetIds: result.evidenceAssetIds,
      captureIds: result.captureIds,
      supersedes: result.supersedes,
      createdAt: result.createdAt,
      bytes,
    };
    request.resultIds.push(result.id);
    request.revision++;
    request.updatedAt = tx.now;
    for (const selection of request.selections) {
      const annotation = tx.manifest.annotations[selection.annotationId];
      if (annotation) this.bumpMetadata(tx, annotation);
    }
    tx.touch({ requestIds: [request.id] });
  }

  protected assertResultCapacity(manifest: WebAnnotationManifest, requestId: string): number {
    const existing = this.resultsFor(manifest, requestId);
    if (existing.length >= WEB_ANNOTATION_LIMITS.resultRevisions) {
      throw capacityError(
        `request has ${existing.length} of ${WEB_ANNOTATION_LIMITS.resultRevisions} results`,
      );
    }
    return (existing.at(-1)?.revision ?? 0) + 1;
  }

  /** The base a new revision carries forward: the latest revision of any provenance. */
  private async resultBase(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    requestId: string,
  ): Promise<{ index: ManifestResult | null; record: WebAnnotationResult | null }> {
    const index = this.latestResult(manifest, requestId);
    if (!index) return { index: null, record: null };
    const record = await this.readResult(store, index.id);
    if (!record) {
      throw new WebAnnotationServiceError(
        "Web annotation storage degraded: the latest result record is unreadable",
      );
    }
    return { index, record };
  }

  private reportedRevisionOf(result: WebAnnotationResult | null): number | null {
    if (!result) return null;
    if (result.reportedRevision !== undefined) return result.reportedRevision;
    return result.provenance === "agent-reported" ? result.revision : null;
  }

  private resultAnnotationId(request: WebAnnotationRequest, annotationId?: string): string {
    if (annotationId !== undefined) {
      if (!request.selections.some((selection) => selection.annotationId === annotationId)) {
        throw new WebAnnotationServiceError("Annotation is not part of this request");
      }
      return annotationId;
    }
    if (request.selections.length !== 1) {
      throw new WebAnnotationServiceError(
        "annotationId is required to capture a result for a batch request",
      );
    }
    return request.selections[0]!.annotationId;
  }

  async captureResult(
    input: WebAnnotationResultCaptureInput,
  ): Promise<{ result: WebAnnotationResult; captureId: string }> {
    this.assertOperationId(input.operationId);
    const capture = this.validateCapture(input.capture);
    const metadataResult = validateWebAnnotationResultCaptureMetadata(
      input as unknown as Record<string, unknown>,
    );
    if (!metadataResult.ok) throw new WebAnnotationServiceError(metadataResult.error);
    const metadata = metadataResult.value;
    const store = await this.env(input.environmentId);
    // Receipts written before annotation/metadata fields existed keep hashing
    // the same way, so a replay across an upgrade is still recognized.
    const extended = input.annotationId !== undefined || Object.keys(metadata).length > 0;
    const bodyHash = hashBody(
      "result-capture",
      extended
        ? {
            requestId: input.requestId,
            annotationId: input.annotationId ?? null,
            capture: input.capture,
            metadata,
          }
        : { requestId: input.requestId, capture: input.capture },
    );
    // Read the original evidence outside the write queue (immutable record).
    const preview = this.requireRequest(store.manifest, input.requestId);
    const annotationId = this.resultAnnotationId(preview, input.annotationId);
    const selection = preview.selections.find((item) => item.annotationId === annotationId)!;
    const original = await this.readCapture(store, store.manifest, selection.captureId);

    const committed = await store.mutate(async (tx) => {
      const existing = this.lookupReceipt(
        tx.manifest,
        input.operationId,
        "result-capture",
        bodyHash,
      );
      if (existing?.value) {
        return {
          resultId: String(existing.value.resultId),
          captureId: String(existing.value.captureId),
        };
      }
      const request = this.requireRequest(tx.manifest, input.requestId);
      const annotation = tx.manifest.annotations[annotationId];
      if (!annotation || annotation.state === "deleted") throw notFound("Annotation");
      const revision = this.assertResultCapacity(tx.manifest, request.id);
      const base = await this.resultBase(store, tx.manifest, request.id);
      const resultId = newId("result");
      const comparison = webAnnotationComparison(
        annotation,
        original,
        capture,
        metadata,
        selection.captureId,
      );
      const record = this.captureFromInput(
        tx,
        annotationId,
        this.nextCaptureRevision(tx.manifest, annotationId),
        capture,
        "result-capture",
        { requestId: request.id, resultId },
        comparison,
      );
      const observation: WebAnnotationResultObservation = {
        captureId: record.id,
        annotationId,
        capturedAt: capture.capturedAt,
        provenance: "app-observed",
        assetIds: [...capture.assetIds],
        comparison,
      };
      const previous = base.record;
      this.writeResult(tx, request, {
        id: resultId,
        requestId: request.id,
        bodyHash: request.bodyHash,
        revision,
        provenance: "user-capture",
        provisional: isWebAnnotationRequestActive(request.state),
        // The agent's report (if any) is carried unchanged; this revision only
        // adds app-observed evidence.
        outcomes:
          previous?.outcomes ??
          request.selections.map((item) => ({
            annotationId: item.annotationId,
            outcome: "unreported" as const,
            note: null,
          })),
        summary: previous?.summary ?? "No agent report yet; the page was captured by the user.",
        files: previous?.files ?? [],
        checks: previous?.checks ?? [],
        evidenceAssetIds: Array.from(
          new Set([...(previous?.evidenceAssetIds ?? []), ...capture.assetIds]),
        ),
        captureIds: [...(previous?.captureIds ?? []), record.id],
        limitations: previous?.limitations ?? [],
        questions: previous?.questions ?? [],
        supersedes: base.index?.id ?? null,
        createdAt: tx.now,
        evidenceIds: previous?.evidenceIds ?? [],
        reportedRevision: this.reportedRevisionOf(previous),
        observations: [...(previous?.observations ?? []), observation].slice(-MAX_OBSERVATIONS),
        ...(previous?.fileChecks ? { fileChecks: previous.fileChecks } : {}),
      });
      this.pushReceipt(tx, {
        operationId: input.operationId,
        kind: "result-capture",
        bodyHash,
        recordedAt: tx.now,
        value: { resultId, captureId: record.id },
      });
      return { resultId, captureId: record.id };
    });
    const result = await this.readResult(store, committed.value.resultId);
    if (!result)
      throw new WebAnnotationServiceError(
        "Web annotation storage degraded: result record is unreadable",
      );
    return {
      result: this.projectResult(result, store.manifest.requests[input.requestId]),
      captureId: committed.value.captureId,
    };
  }

  // -------------------------------------------------------------------------
  // Follow-up selection

  /**
   * Default follow-up selection for a settled request: items not accepted by
   * the user, not reported `addressed`, or changed since the request. Items
   * reported addressed but not accepted are excluded by default (listed) so
   * work is not redone inadvertently.
   */
  protected async followUpSelection(
    store: WebAnnotationEnvironmentStore,
    manifest: WebAnnotationManifest,
    request: WebAnnotationRequest,
  ): Promise<WebAnnotationFollowUpCandidates & { result: WebAnnotationResult | null }> {
    const latest = this.latestResult(manifest, request.id);
    const result = latest ? await this.readResult(store, latest.id) : null;
    const failed =
      request.state === "failed" ||
      request.state === "cancelled" ||
      request.state === "abandoned-unconfirmed";
    const remaining: WebAnnotationFollowUpCandidates["remaining"] = [];
    const excluded: WebAnnotationFollowUpCandidates["excluded"] = [];
    for (const selection of request.selections) {
      const annotation = manifest.annotations[selection.annotationId];
      const reference = selection.reference;
      if (!annotation || annotation.state === "deleted") {
        excluded.push({ annotationId: selection.annotationId, reference, reason: "deleted" });
        continue;
      }
      if (annotation.archivedAt) {
        excluded.push({ annotationId: annotation.id, reference, reason: "archived" });
        continue;
      }
      if (annotation.state === "resolved") {
        excluded.push({ annotationId: annotation.id, reference, reason: "accepted" });
        continue;
      }
      const previousOutcome =
        result?.outcomes.find((outcome) => outcome.annotationId === annotation.id)?.outcome ??
        "unreported";
      const changed =
        annotation.contentRevision !== selection.contentRevision ||
        annotation.currentCaptureId !== selection.captureId;
      if (failed) {
        remaining.push({
          annotationId: annotation.id,
          reference,
          reason: "request-failed",
          previousOutcome,
        });
      } else if (changed) {
        remaining.push({
          annotationId: annotation.id,
          reference,
          reason: "changed-since",
          previousOutcome,
        });
      } else if (previousOutcome === "addressed") {
        excluded.push({ annotationId: annotation.id, reference, reason: "addressed" });
      } else {
        remaining.push({
          annotationId: annotation.id,
          reference,
          reason: previousOutcome === "unreported" ? "unreported" : "not-addressed",
          previousOutcome,
        });
      }
    }
    return { requestId: request.id, remaining, excluded, resultId: latest?.id ?? null, result };
  }

  async followUpCandidates(
    environmentId: string,
    requestId: string,
  ): Promise<WebAnnotationFollowUpCandidates> {
    const store = await this.env(environmentId);
    const request = this.requireRequest(store.manifest, requestId);
    if (isWebAnnotationRequestActive(request.state)) {
      throw new WebAnnotationServiceError(
        "The request is still active; follow up after it settles",
      );
    }
    const { result: _result, ...candidates } = await this.followUpSelection(
      store,
      store.manifest,
      request,
    );
    return candidates;
  }

  // -------------------------------------------------------------------------
  // Agent tool host: scope comes from the credential, never the model.

  async assignedRequest(scope: WebAnnotationToolScope): Promise<{
    request: WebAnnotationRequest;
    brief: string;
    latestResult: WebAnnotationResult | null;
  } | null> {
    if (!scope.tabId) return null;
    const store = await this.env(scope.environmentId);
    const request = this.assignedFor(store.manifest, scope.tabId);
    if (!request) return null;
    let body = "";
    try {
      body = (await store.readRecord<{ body: string }>("brief", request.id, 1)).body;
    } catch {
      return null;
    }
    const brief = this.options.composeText
      ? this.options.composeText(request.id, { body }, request.operation, request.selections.length)
      : body;
    const latest = this.latestResult(store.manifest, request.id);
    const record = latest ? await this.readResult(store, latest.id) : null;
    return {
      request: { ...request },
      brief,
      latestResult: record ? this.projectResult(record, request) : null,
    };
  }

  protected assignedFor(
    manifest: WebAnnotationManifest,
    tabId: string,
  ): WebAnnotationRequest | null {
    const mine = Object.values(manifest.requests).filter(
      (request) => request.destination.tabId === tabId,
    );
    const newest = (list: WebAnnotationRequest[], key: "createdAt" | "settledAt") =>
      list.sort((a, b) =>
        (a[key] ?? "") < (b[key] ?? "") ? 1 : (a[key] ?? "") > (b[key] ?? "") ? -1 : 0,
      )[0] ?? null;
    const active = mine.filter((request) => isWebAnnotationRequestActive(request.state));
    if (active.length > 0) return newest(active, "createdAt");
    return newest(
      mine.filter(
        (request) => request.state === "awaiting-review" || request.state === "completed",
      ),
      "settledAt",
    );
  }

  async toolEvidence(
    scope: WebAnnotationToolScope,
    requestId: string,
    annotationId: string,
  ): Promise<{
    annotation: WebAnnotation;
    capture: WebAnnotationCapture | null;
    entries: WebAnnotationEntry[];
  }> {
    const store = await this.env(scope.environmentId);
    const manifest = store.manifest;
    const request = isWebAnnotationId(requestId) ? manifest.requests[requestId] : undefined;
    if (!request || !scope.tabId || request.destination.tabId !== scope.tabId) {
      throw new WebAnnotationServiceError("Request is not assigned to this session");
    }
    const selection = request.selections.find((item) => item.annotationId === annotationId);
    if (!selection) throw new WebAnnotationServiceError("Annotation is not part of this request");
    const annotation = this.requireAnnotation(manifest, annotationId);
    const capture = await this.readCapture(store, manifest, selection.captureId);
    const indexes = manifest.entries[annotationId] ?? [];
    const entries: WebAnnotationEntry[] = [];
    for (const id of selection.entryIds.slice(0, WEB_ANNOTATION_LIMITS.entryPageItems)) {
      const index = indexes.find((entry) => entry.id === id);
      if (index) entries.push(await this.readEntry(store, index));
    }
    return { annotation: this.project(store, annotation), capture, entries };
  }

  /** Workspace containment/existence of reported files (outside the write queue). */
  private async fileChecks(
    environmentId: string,
    files: readonly string[],
  ): Promise<WebAnnotationFileCheck[] | undefined> {
    const check = this.options.dispatch?.checkWorkspacePaths;
    if (files.length === 0 || !check) return undefined;
    const environment = await this.hostEnvironment(environmentId).catch(() => null);
    if (!environment) return undefined;
    return check
      .call(
        this.options.dispatch,
        {
          id: environment.id,
          environmentType: environment.environmentType,
          ...(environment.worktreePath ? { worktreePath: environment.worktreePath } : {}),
          ...(environment.containerId ? { containerId: environment.containerId } : {}),
        },
        files,
      )
      .catch(() => undefined);
  }

  async reportToolResult(
    scope: WebAnnotationToolScope,
    report: WebAnnotationResultReportInput,
  ): Promise<WebAnnotationResult> {
    const validated = validateWebAnnotationResultReport(report);
    if (!validated.ok) throw new WebAnnotationServiceError(validated.error);
    const input = validated.value;
    const store = await this.env(scope.environmentId);
    const fileChecks = await this.fileChecks(scope.environmentId, input.files);
    const committed = await store.mutate(async (tx) => {
      const request = tx.manifest.requests[input.requestId];
      if (!request || !scope.tabId || request.destination.tabId !== scope.tabId) {
        throw new WebAnnotationServiceError("Request is not assigned to this session");
      }
      const assigned = this.assignedFor(tx.manifest, scope.tabId);
      if (assigned?.id !== request.id)
        throw conflictError("request was superseded by a newer request");
      const selected = new Set(request.selections.map((selection) => selection.annotationId));
      if (input.outcomes.some((outcome) => !selected.has(outcome.annotationId))) {
        throw new WebAnnotationServiceError("Outcomes may name only annotations in this request");
      }
      // The expected revision is the latest revision of any provenance (what
      // `get_annotation_request` returns). A first report may pass null.
      const latest = this.latestResult(tx.manifest, request.id);
      const latestAgent = this.latestResult(tx.manifest, request.id, "agent-reported");
      const expected = input.expectedResultRevision;
      if (expected !== (latest?.revision ?? null) && !(expected === null && latestAgent === null)) {
        throw conflictError("result revision is stale; read the latest result first");
      }
      const evidence = new Set<string>([
        ...request.attachments.map((attachment) => attachment.assetId),
        ...request.selections.map((selection) => selection.captureId),
        ...this.resultsFor(tx.manifest, request.id).flatMap((result) => [
          ...result.captureIds,
          ...result.assetIds,
        ]),
      ]);
      const evidenceIds = input.evidenceIds ?? [];
      if (evidenceIds.some((id) => !evidence.has(id))) {
        throw new WebAnnotationServiceError(
          "evidenceIds may reference only this request's captures and attachments",
        );
      }
      const revision = this.assertResultCapacity(tx.manifest, request.id);
      const base = await this.resultBase(store, tx.manifest, request.id);
      const outcomes = request.selections.map((selection) => {
        const reported = input.outcomes.find(
          (outcome) => outcome.annotationId === selection.annotationId,
        );
        return (
          reported ?? {
            annotationId: selection.annotationId,
            outcome: "unreported" as const,
            note: null,
          }
        );
      });
      const result: WebAnnotationResult = {
        id: newId("result"),
        requestId: request.id,
        bodyHash: request.bodyHash,
        revision,
        provenance: "agent-reported",
        provisional: isWebAnnotationRequestActive(request.state),
        outcomes,
        summary: input.summary,
        files: input.files,
        checks: input.checks.map((check) => ({ ...check, provenance: "agent-reported" as const })),
        // App-observed captures stay attached across agent revisions.
        evidenceAssetIds: base.record?.evidenceAssetIds ?? [],
        captureIds: base.record?.captureIds ?? [],
        limitations: input.limitations,
        questions: input.questions,
        supersedes: base.index?.id ?? null,
        createdAt: tx.now,
        evidenceIds: evidenceIds.slice(0, MAX_EVIDENCE_IDS),
        reportedRevision: revision,
        observations: base.record?.observations ?? [],
        ...(fileChecks ? { fileChecks } : {}),
      };
      this.writeResult(tx, request, result);
      return result;
    });
    return committed.value;
  }

  /** The `WebAnnotationToolHost` seam consumed by the agent tools server. */
  toolHost(): WebAnnotationToolHost {
    return {
      assignedRequest: (scope) => this.assignedRequest(scope),
      evidence: (scope, requestId, annotationId) =>
        this.toolEvidence(scope, requestId, annotationId),
      reportResult: (scope, report) => this.reportToolResult(scope, report),
    };
  }
}
