/**
 * In-memory fakes for web annotation tests: a backend that honours the frozen
 * command shapes, a desktop capture API with a pending spool, and a
 * `window.orkestrator` event bus. Not bundled: only tests import this.
 */
import { mock } from "bun:test";
import {
  EMPTY_WEB_ANNOTATION_REDACTION,
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_CONFLICT,
  WEB_ANNOTATION_CONTRACT_VERSION,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATIONS_CHANGED_EVENT,
  webAnnotationPageKey,
  type WebAnnotation,
  type WebAnnotationCapabilities,
  type WebAnnotationCapture,
  type WebAnnotationChangeHint,
  type WebAnnotationCommandArgs,
  type WebAnnotationDestinationOption,
  type WebAnnotationDraft,
  type WebAnnotationEntry,
  type WebAnnotationMigrationStatus,
  type WebAnnotationOperationReceipt,
  type WebAnnotationPreparation,
  type WebAnnotationRequest,
  type WebAnnotationResult,
  type WebAnnotationSummary,
} from "@orkestrator/protocol/web-annotations";
import {
  FIXTURE_TIME,
  fixtureAnnotation,
  fixtureCapture,
  fixtureCaptureInput,
  fixtureDestination,
  fixtureEntry,
  fixtureRequest,
} from "@orkestrator/protocol/web-annotations-fixtures";
import type {
  BrowserPreviewCaptureApi,
  BrowserPreviewCaptureEvent,
  BrowserPreviewPendingCapture,
  BrowserPreviewSelectionStatus,
} from "@orkestrator/protocol/browser-preview";
import { invoke } from "@/lib/native/backend";

export const invokeMock = invoke as unknown as ReturnType<typeof mock>;
export const PNG = "data:image/png;base64,iVBORw0KGgo=";

export function fixtureCapabilities(
  overrides: Partial<WebAnnotationCapabilities["operations"]> = {},
): WebAnnotationCapabilities {
  return {
    contractVersion: WEB_ANNOTATION_CONTRACT_VERSION,
    storage: "ready",
    operations: {
      read: true,
      author: true,
      captureAccept: true,
      dispatch: true,
      batch: true,
      comparison: true,
      migration: false,
      resultTools: false,
      ...overrides,
    },
    targets: ["element", "text-range", "region", "page"],
    maxRequestAnnotations: 20,
    limits: WEB_ANNOTATION_LIMITS,
  };
}

function conflict(detail: string): Error {
  return new Error(`${WEB_ANNOTATION_CONFLICT} ${detail}`);
}

type Handler = (args: Record<string, unknown>) => unknown;

/** A backend honouring the frozen command shapes, with injectable faults. */
export class FakeWebAnnotationBackend {
  generation = "gen-1";
  revision = 1;
  capabilities: WebAnnotationCapabilities | null = fixtureCapabilities();
  /** Successive migrate responses; once drained, migration reports completion. */
  migrationBatches: Array<Partial<WebAnnotationMigrationStatus>> = [];
  annotations = new Map<string, WebAnnotation>();
  entries = new Map<string, WebAnnotationEntry[]>();
  captures = new Map<string, WebAnnotationCapture>();
  requests = new Map<string, WebAnnotationRequest>();
  results = new Map<string, WebAnnotationResult>();
  drafts = new Map<string, WebAnnotationDraft>();
  receipts = new Map<string, WebAnnotationOperationReceipt>();
  assets = new Map<string, string>();
  changeLog: Array<{ revision: number; annotationIds: string[]; requestIds: string[] }> = [];
  destinations: WebAnnotationDestinationOption[] = [
    {
      destination: fixtureDestination,
      title: "Claude Code",
      model: "opus",
      activity: "idle",
      images: true,
      planMode: true,
      resultTools: false,
      holds: [],
      isDefault: false,
    },
  ];
  /** Throw once for a command before (or after, when `afterCommit`) handling. */
  failures = new Map<string, { error: Error; afterCommit?: boolean; times: number }>();
  private gates = new Map<string, Promise<void>[]>();
  calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  private sequence = 0;
  overrides = new Map<string, Handler>();

  constructor(readonly environmentId = "env-1") {}

  install() {
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) =>
      this.handle(command, args),
    );
    return this;
  }

  fail(command: string, error: Error, options: { afterCommit?: boolean; times?: number } = {}) {
    this.failures.set(command, {
      error,
      afterCommit: options.afterCommit,
      times: options.times ?? 1,
    });
  }

  /** Delay a command's response (after it commits) until `release()`. */
  hold(command: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = this.gates.get(command) ?? [];
    list.push(gate);
    this.gates.set(command, list);
    return { release };
  }

  callsOf(command: string) {
    return this.calls.filter((call) => call.command === command);
  }

  bump(annotationIds: string[] = [], requestIds: string[] = []) {
    this.revision += 1;
    this.changeLog.push({ revision: this.revision, annotationIds, requestIds });
    return this.revision;
  }

  hint(annotationIds: string[] = [], requestIds: string[] = []): WebAnnotationChangeHint {
    return {
      environmentId: this.environmentId,
      generation: this.generation,
      revision: this.revision,
      annotationIds,
      requestIds,
      reset: false,
    };
  }

  seed(overrides: Partial<WebAnnotation> = {}, entries?: WebAnnotationEntry[]) {
    const id = overrides.id ?? `annotation-${++this.sequence}`;
    const captureId = overrides.currentCaptureId ?? `capture-${id}`;
    const annotation = fixtureAnnotation({
      environmentId: this.environmentId,
      ...overrides,
      id,
      currentCaptureId: captureId,
    });
    this.annotations.set(id, annotation);
    this.captures.set(
      captureId,
      fixtureCapture(annotation.targetKind, {
        id: captureId,
        annotationId: id,
        page: annotation.page,
      }),
    );
    this.entries.set(
      id,
      entries ?? [
        fixtureEntry({
          id: `entry-${id}`,
          annotationId: id,
          captureId,
          body: annotation.latestIntent,
        }),
      ],
    );
    return annotation;
  }

  summary(annotation: WebAnnotation): WebAnnotationSummary {
    const active = annotation.activeRequestId
      ? this.requests.get(annotation.activeRequestId)
      : null;
    return {
      ...annotation,
      activeRequest: active
        ? {
            id: active.id,
            state: active.state,
            operation: active.operation,
            blockedReason: active.blockedReason,
            destination: active.destination,
          }
        : null,
    };
  }

  async handle(command: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ command, args });
    const failure = this.failures.get(command);
    if (failure && !failure.afterCommit) {
      if (--failure.times <= 0) this.failures.delete(command);
      throw failure.error;
    }
    const gate = this.gates.get(command)?.shift();
    const override = this.overrides.get(command);
    const result = override ? override(args) : this.dispatch(command, args);
    if (gate) await gate;
    if (failure?.afterCommit) {
      if (--failure.times <= 0) this.failures.delete(command);
      throw failure.error;
    }
    return result;
  }

  private dispatch(command: string, raw: Record<string, unknown>): unknown {
    const args = raw as never;
    switch (command) {
      case "web_annotations_capabilities":
        if (!this.capabilities)
          throw new Error("Unknown backend command: web_annotations_capabilities");
        return this.capabilities;
      case "web_annotations_list":
        return this.list(args);
      case "web_annotations_changes":
        return this.changes(args);
      case "web_annotation_get":
        return this.get(args);
      case "web_annotation_capture": {
        const { captureId } = args as WebAnnotationCommandArgs["web_annotation_capture"];
        const capture = this.captures.get(captureId);
        if (!capture) throw new Error("Capture not found");
        return { capture };
      }
      case "web_annotation_draft_get": {
        const { editorId } = args as WebAnnotationCommandArgs["web_annotation_draft_get"];
        return { draft: this.drafts.get(editorId) ?? null };
      }
      case "web_annotation_draft_save":
        return this.draftSave(args);
      case "web_annotation_draft_delete": {
        const { editorId } = args as WebAnnotationCommandArgs["web_annotation_draft_delete"];
        return { deleted: this.drafts.delete(editorId) };
      }
      case "web_annotation_create":
        return this.create(args);
      case "web_annotation_operation_receipt": {
        const { operationId } =
          args as WebAnnotationCommandArgs["web_annotation_operation_receipt"];
        return { receipt: this.receipts.get(operationId) ?? null };
      }
      case "web_annotation_entry_append":
      case "web_annotation_entry_edit":
        return this.appendEntry(command, args);
      case "web_annotation_update":
        return this.mutateAnnotation(args, (annotation, input) => {
          const update = input as WebAnnotationCommandArgs["web_annotation_update"];
          if (update.title !== undefined) annotation.title = update.title;
          if (update.defaultDestination !== undefined)
            annotation.defaultDestination = update.defaultDestination;
        });
      case "web_annotation_capture_replace":
        return this.captureReplace(args);
      case "web_annotation_resolve":
        return this.resolve(args);
      case "web_annotation_reopen":
        return this.mutateAnnotation(args, (annotation) => {
          annotation.state = "open";
          annotation.resolution = null;
        });
      case "web_annotation_delete":
        return this.mutateAnnotation(args, (annotation) => {
          if (annotation.activeRequestId) throw conflict("an implementation request is active");
          annotation.state = "deleted";
        });
      case "web_annotation_asset_stage": {
        const input = args as WebAnnotationCommandArgs["web_annotation_asset_stage"];
        const id = `asset-${input.operationId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 120);
        const deduplicated = this.assets.has(id);
        this.assets.set(id, input.data);
        return {
          asset: {
            id,
            environmentId: this.environmentId,
            digest: "d",
            mediaType: "image/png",
            bytes: input.data.length,
            width: 10,
            height: 10,
            createdAt: FIXTURE_TIME,
          },
          deduplicated,
        };
      }
      case "web_annotation_asset_get": {
        const { assetId } = args as WebAnnotationCommandArgs["web_annotation_asset_get"];
        const data = this.assets.get(assetId);
        if (!data) throw new Error("Asset not found");
        return {
          asset: {
            id: assetId,
            environmentId: this.environmentId,
            digest: "d",
            mediaType: "image/png",
            bytes: data.length,
            width: 10,
            height: 10,
            createdAt: FIXTURE_TIME,
          },
          data,
        };
      }
      case "web_annotation_destinations":
        return { options: this.destinations };
      case "web_annotation_request_prepare":
        return this.prepare(args);
      case "web_annotation_request_send":
        return this.send(args);
      case "web_annotation_request_get": {
        const { requestId } = args as WebAnnotationCommandArgs["web_annotation_request_get"];
        const request = this.requests.get(requestId);
        if (!request) throw new Error("Request not found");
        return {
          request,
          results: Array.from(this.results.values()).filter((r) => r.requestId === requestId),
        };
      }
      case "web_annotation_requests":
        return { requests: Array.from(this.requests.values()) };
      case "web_annotation_request_cancel": {
        const input = args as WebAnnotationCommandArgs["web_annotation_request_cancel"];
        const request = this.requests.get(input.requestId)!;
        const outcome = request.state === "queued" ? "cancelled" : "cancelling";
        request.state = outcome === "cancelled" ? "cancelled" : "cancelling";
        request.revision += 1;
        this.bump([], [request.id]);
        return { request, outcome };
      }
      case "web_annotation_request_recover": {
        const input = args as WebAnnotationCommandArgs["web_annotation_request_recover"];
        const request = this.requests.get(input.requestId)!;
        if (input.action === "discard") request.state = "abandoned-unconfirmed";
        if (input.action === "retry") request.state = "dispatching";
        request.revision += 1;
        return { request };
      }
      case "web_annotation_request_response": {
        const { requestId } = args as WebAnnotationCommandArgs["web_annotation_request_response"];
        const request = this.requests.get(requestId)!;
        return { request, response: request.response, sourceAvailable: true };
      }
      case "web_annotation_result_capture": {
        const input = args as WebAnnotationCommandArgs["web_annotation_result_capture"];
        const captureId = `after-${input.operationId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, 120);
        const result: WebAnnotationResult = {
          id: `result-${captureId}`,
          requestId: input.requestId,
          bodyHash: "0",
          revision: 1,
          provenance: "user-capture",
          provisional: false,
          outcomes: [],
          summary: "",
          files: [],
          checks: [],
          evidenceAssetIds: [],
          captureIds: [captureId],
          limitations: [],
          questions: [],
          supersedes: null,
          createdAt: FIXTURE_TIME,
        };
        this.results.set(result.id, result);
        this.receipts.set(input.operationId, {
          operationId: input.operationId,
          annotationId: "",
          captureId,
          entryId: null,
          contentRevision: 0,
          metadataRevision: 0,
          captureRevision: 0,
          environmentRevision: this.bump(),
        });
        return { result, captureId };
      }
      case "web_annotations_migrate":
      case "web_annotations_migration_status": {
        const batch = command === "web_annotations_migrate" ? this.migrationBatches.shift() : {};
        return {
          environmentId: this.environmentId,
          scannedDrafts: 0,
          importedAnnotations: 0,
          pendingDrafts: 0,
          deferredDrafts: 0,
          failedDrafts: 0,
          completedAt: FIXTURE_TIME,
          ...batch,
        };
      }
      default:
        return undefined;
    }
  }

  private list(input: WebAnnotationCommandArgs["web_annotations_list"]) {
    const filter = input.filter ?? {};
    const state = filter.state ?? "open";
    const all = Array.from(this.annotations.values()).filter(
      (annotation) =>
        annotation.state !== "deleted" &&
        (state === "all" || annotation.state === state) &&
        (!filter.pageKey || webAnnotationPageKey(annotation.page) === filter.pageKey) &&
        (!filter.importedOnly || annotation.imported) &&
        (!filter.destinationTabId ||
          annotation.defaultDestination?.tabId === filter.destinationTabId),
    );
    const offset = input.cursor ? Number(input.cursor.split(":")[1]) : 0;
    const limit = input.limit ?? WEB_ANNOTATION_LIMITS.listPageItems;
    const items = all.slice(offset, offset + limit).map((annotation) => this.summary(annotation));
    return {
      generation: this.generation,
      revision: this.revision,
      items,
      nextCursor: offset + limit < all.length ? `cursor:${offset + limit}` : null,
      total: all.length,
      ...(filter.pageKey ? { openOnPage: all.filter((a) => a.state === "open").length } : {}),
    };
  }

  private changes(input: WebAnnotationCommandArgs["web_annotations_changes"]) {
    if (input.generation !== this.generation) {
      return {
        generation: this.generation,
        revision: this.revision,
        resetRequired: true,
        changes: [],
      };
    }
    return {
      generation: this.generation,
      revision: this.revision,
      resetRequired: false,
      changes: this.changeLog.filter((change) => change.revision > input.after),
    };
  }

  private get(input: WebAnnotationCommandArgs["web_annotation_get"]) {
    const annotation = this.annotations.get(input.annotationId);
    if (!annotation || annotation.state === "deleted") throw new Error("Annotation not found");
    const requests = annotation.requestIds
      .map((id) => this.requests.get(id))
      .filter((request): request is WebAnnotationRequest => Boolean(request));
    return {
      generation: this.generation,
      revision: this.revision,
      annotation: { ...annotation },
      capture: this.captures.get(annotation.currentCaptureId) ?? null,
      entries: this.entries.get(annotation.id) ?? [],
      nextEntrySequence: null,
      requests,
      results: Array.from(this.results.values()).filter((result) =>
        annotation.requestIds.includes(result.requestId),
      ),
    };
  }

  private draftSave(input: WebAnnotationCommandArgs["web_annotation_draft_save"]) {
    const existing = this.drafts.get(input.editorId);
    if ((existing?.revision ?? 0) !== input.expectedRevision) {
      throw conflict(`draft is at revision ${existing?.revision ?? 0}`);
    }
    const draft: WebAnnotationDraft = {
      id: existing?.id ?? `draft-${input.editorId}`,
      environmentId: this.environmentId,
      editorId: input.editorId,
      revision: input.expectedRevision + 1,
      annotationId: input.annotationId ?? null,
      captureId: input.captureId ?? null,
      pendingCaptureId: input.pendingCaptureId ?? null,
      text: input.text,
      operation: input.operation ?? null,
      destination: input.destination ?? null,
      updatedAt: FIXTURE_TIME,
    };
    this.drafts.set(input.editorId, draft);
    return { draft };
  }

  private receipt(operationId: string, annotation: WebAnnotation, entryId: string | null) {
    const receipt: WebAnnotationOperationReceipt = {
      operationId,
      annotationId: annotation.id,
      captureId: annotation.currentCaptureId,
      entryId,
      contentRevision: annotation.contentRevision,
      metadataRevision: annotation.metadataRevision,
      captureRevision: annotation.captureRevision,
      environmentRevision: this.bump([annotation.id]),
    };
    this.receipts.set(operationId, receipt);
    return receipt;
  }

  private create(input: WebAnnotationCommandArgs["web_annotation_create"]) {
    const prior = this.receipts.get(input.operationId);
    if (prior) return prior;
    if (!input.body.trim()) throw new Error("Comment must not be empty");
    const id = `annotation-${++this.sequence}`;
    const captureId = `capture-${id}`;
    const annotation = fixtureAnnotation({
      id,
      environmentId: this.environmentId,
      currentCaptureId: captureId,
      page: input.capture.page,
      title: input.title ?? input.capture.target.label,
      targetKind: input.capture.target.kind,
      targetLabel: input.capture.target.label,
      latestIntent: input.body,
    });
    this.annotations.set(id, annotation);
    this.captures.set(captureId, {
      ...input.capture,
      id: captureId,
      annotationId: id,
      schemaVersion: 1,
      revision: 1,
      producer: "desktop-native",
      state: "complete",
    } as WebAnnotationCapture);
    const entry = fixtureEntry({
      id: `entry-${id}`,
      annotationId: id,
      captureId,
      body: input.body,
    });
    this.entries.set(id, [entry]);
    return this.receipt(input.operationId, annotation, entry.id);
  }

  private appendEntry(command: string, raw: unknown) {
    const input = raw as WebAnnotationCommandArgs["web_annotation_entry_append"] & {
      entryId?: string;
    };
    const annotation = this.annotations.get(input.annotationId)!;
    if (annotation.contentRevision !== input.expectedContentRevision) {
      throw conflict(`content is at revision ${annotation.contentRevision}`);
    }
    annotation.contentRevision += 1;
    annotation.metadataRevision += 1;
    const list = this.entries.get(annotation.id) ?? [];
    const entry = fixtureEntry({
      id: `entry-${annotation.id}-${list.length + 1}`,
      annotationId: annotation.id,
      sequence: list.length + 1,
      body: input.body,
      contentRevision: annotation.contentRevision,
      ...(command === "web_annotation_entry_edit" ? { supersedes: input.entryId } : {}),
    });
    if (command === "web_annotation_entry_edit") {
      for (const existing of list)
        if (existing.id === input.entryId) existing.supersededBy = entry.id;
    }
    list.push(entry);
    this.entries.set(annotation.id, list);
    annotation.lastSequence = list.length;
    return this.receipt(input.operationId, annotation, entry.id);
  }

  private mutateAnnotation(
    raw: unknown,
    apply: (annotation: WebAnnotation, input: unknown) => void,
  ) {
    const input = raw as {
      annotationId: string;
      operationId: string;
      expectedMetadataRevision: number;
    };
    const annotation = this.annotations.get(input.annotationId)!;
    if (annotation.metadataRevision !== input.expectedMetadataRevision) {
      throw conflict(`metadata is at revision ${annotation.metadataRevision}`);
    }
    apply(annotation, raw);
    annotation.metadataRevision += 1;
    return this.receipt(input.operationId, annotation, null);
  }

  private captureReplace(input: WebAnnotationCommandArgs["web_annotation_capture_replace"]) {
    const prior = this.receipts.get(input.operationId);
    if (prior) return prior;
    const annotation = this.annotations.get(input.annotationId)!;
    if (annotation.contentRevision !== input.expectedContentRevision) {
      throw conflict(`content is at revision ${annotation.contentRevision}`);
    }
    const captureId = `capture-${annotation.id}-${annotation.captureRevision + 1}`;
    this.captures.set(captureId, {
      ...input.capture,
      id: captureId,
      annotationId: annotation.id,
      schemaVersion: 1,
      revision: annotation.captureRevision + 1,
      producer: "desktop-native",
      state: "complete",
    } as WebAnnotationCapture);
    annotation.currentCaptureId = captureId;
    annotation.captureRevision += 1;
    annotation.contentRevision += 1;
    annotation.metadataRevision += 1;
    return this.receipt(input.operationId, annotation, null);
  }

  private resolve(input: WebAnnotationCommandArgs["web_annotation_resolve"]) {
    const annotation = this.annotations.get(input.annotationId)!;
    if (
      annotation.contentRevision !== input.expectedContentRevision ||
      annotation.currentCaptureId !== input.expectedCaptureId
    ) {
      throw conflict("the annotation has newer content");
    }
    annotation.state = "resolved";
    annotation.resolution = {
      acceptedBy: "host-user",
      acceptedAt: FIXTURE_TIME,
      contentRevision: annotation.contentRevision,
      captureId: annotation.currentCaptureId,
      captureRevision: annotation.captureRevision,
      requestId: input.requestId,
    };
    annotation.metadataRevision += 1;
    return this.receipt(input.operationId, annotation, null);
  }

  private prepare(
    input: WebAnnotationCommandArgs["web_annotation_request_prepare"],
  ): WebAnnotationPreparation {
    return {
      preparationId: `prep-${this.calls.length}`,
      expiresAt: "2026-09-21T12:15:00.000Z",
      operation: input.operation,
      destination: input.destination,
      selections: input.annotations.map((item, index) => ({
        annotationId: item.annotationId,
        reference: index + 1,
        contentRevision: item.expectedContentRevision,
        captureId: item.expectedCaptureId,
        captureRevision: 1,
        entryIds: [],
        desiredOutcome: item.desiredOutcome ?? null,
        historicalEvidence: Boolean(item.allowHistoricalEvidence),
      })),
      instruction: input.instruction || "Give the Save button more padding.",
      briefPreview: "Orkestrator web annotation request … (preview)",
      briefBytes: 2048,
      bodyHash: `hash-${input.operation}`,
      evidence: {
        items: input.annotations.map((item, index) => ({
          annotationId: item.annotationId,
          reference: index + 1,
          included: ["intent", "target", "page", "text"],
          omitted: ["html"],
          unavailable: input.textOnly ? ["image"] : [],
          captureState: "complete",
          targetKind: "element",
        })),
        textBytes: 2048,
        imageCount: input.textOnly ? 0 : 1,
        imageBytes: 0,
      },
      attachments: [],
      textOnly: Boolean(input.textOnly),
      readOnly: input.operation === "discuss" ? "plan-mode" : "not-applicable",
      issues: [],
      sendable: true,
    };
  }

  private send(input: WebAnnotationCommandArgs["web_annotation_request_send"]) {
    const existing = this.requests.get(input.requestId);
    if (existing) return { request: existing, deduplicated: true };
    const request = fixtureRequest("queued", {
      id: input.requestId,
      environmentId: this.environmentId,
      blockedReason: null,
      transcript: { ...fixtureRequest("queued").transcript, requestId: input.requestId },
    });
    this.requests.set(request.id, request);
    for (const selection of request.selections) {
      const annotation = this.annotations.get(selection.annotationId);
      if (annotation) {
        annotation.requestIds = [...annotation.requestIds, request.id];
        annotation.activeRequestId = request.id;
      }
    }
    this.bump(
      request.selections.map((s) => s.annotationId),
      [request.id],
    );
    return { request, deduplicated: false };
  }
}

export function capacityError(detail = "environment image quota") {
  return new Error(`${WEB_ANNOTATION_CAPACITY} ${detail}`);
}

/** `window.orkestrator` with an event bus and optional capture API. */
export function installFakeOrkestrator(extra: { capture?: BrowserPreviewCaptureApi } = {}) {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const listen = mock((event: string, callback: (payload: unknown) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(callback);
    listeners.set(event, set);
    return () => set.delete(callback);
  });
  const previous = window.orkestrator;
  window.orkestrator = {
    invoke: invokeMock,
    listen,
    ...(extra.capture ? { browserPreview: { capture: extra.capture } } : {}),
  } as unknown as Window["orkestrator"];
  return {
    listen,
    emit(event: string, payload: unknown) {
      for (const callback of Array.from(listeners.get(event) ?? [])) callback(payload);
    },
    emitHint(hint: WebAnnotationChangeHint) {
      for (const callback of Array.from(listeners.get(WEB_ANNOTATIONS_CHANGED_EVENT) ?? []))
        callback(hint);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    restore() {
      window.orkestrator = previous;
    },
  };
}

/** Desktop capture API with an in-memory pending spool. */
export function createFakeCaptureApi() {
  const spool = new Map<string, BrowserPreviewPendingCapture>();
  let status: BrowserPreviewSelectionStatus = { status: "inactive" };
  let next = 0;
  const listeners: Array<(event: BrowserPreviewCaptureEvent) => void> = [];
  const api = {
    startCapture: mock(
      async (input: {
        tabId: string;
        mode: "element";
        annotationId?: string;
        environmentId: string;
      }) => {
        const captureId = `cap-${++next}`;
        status = { status: "selecting", captureId, mode: input.mode };
        pendingStart = { ...input, captureId };
        return status;
      },
    ),
    getCaptureStatus: mock(async () => status),
    cancelCapture: mock(async () => {
      status = { status: "inactive" };
    }),
    listPendingCaptures: mock(async () =>
      Array.from(spool.values())
        .map((record) => record.descriptor)
        .reverse(),
    ),
    readPendingCapture: mock(async (captureId: string) => spool.get(captureId) ?? null),
    replacePendingCaptureImage: mock(
      async (captureId: string, input: { imageDataUrl: string | null; manualRegions: number }) => {
        const record = spool.get(captureId)!;
        record.imageDataUrl = input.imageDataUrl;
        record.capture = {
          ...record.capture,
          redaction: {
            ...record.capture.redaction,
            manualRegions: record.capture.redaction.manualRegions + input.manualRegions,
            imageExcluded: input.imageDataUrl === null,
          },
        };
        return record.descriptor;
      },
    ),
    acknowledgePendingCapture: mock(async (ack: { captureId: string }) => {
      spool.delete(ack.captureId);
    }),
    discardPendingCapture: mock(async (captureId: string) => {
      spool.delete(captureId);
    }),
    showPins: mock(async (input: { pins: Array<{ annotationId: string }> }) =>
      input.pins.map((pin) => ({
        annotationId: pin.annotationId,
        resolution: {
          state: "matched" as const,
          rule: "stable-id" as const,
          candidateCount: 1,
          documentGeneration: 1,
          rect: null,
        },
      })),
    ),
    clearPins: mock(async () => undefined),
  };
  let pendingStart: {
    tabId: string;
    environmentId: string;
    annotationId?: string;
    captureId: string;
  } | null = null;

  return {
    api: api as unknown as BrowserPreviewCaptureApi,
    mocks: api,
    spool,
    listeners,
    /** Simulate the user clicking a target: the spool gains a pending record. */
    complete(overrides: { image?: string | null; label?: string } = {}) {
      const start = pendingStart;
      if (!start) throw new Error("No capture in progress");
      const record = seedPending(spool, {
        captureId: start.captureId,
        tabId: start.tabId,
        environmentId: start.environmentId,
        annotationId: start.annotationId ?? null,
        image: overrides.image === undefined ? PNG : overrides.image,
        label: overrides.label,
      });
      status = { status: "captured", captureId: start.captureId, pending: record.descriptor };
      pendingStart = null;
      return record;
    },
    setStatus(next: BrowserPreviewSelectionStatus) {
      status = next;
    },
  };
}

export function seedPending(
  spool: Map<string, BrowserPreviewPendingCapture>,
  input: {
    captureId: string;
    tabId?: string;
    environmentId?: string;
    annotationId?: string | null;
    image?: string | null;
    label?: string;
  },
): BrowserPreviewPendingCapture {
  const record: BrowserPreviewPendingCapture = {
    descriptor: {
      captureId: input.captureId,
      tabId: input.tabId ?? "browser-1",
      environmentId: input.environmentId ?? "env-1",
      annotationId: input.annotationId ?? null,
      mode: "element",
      createdAt: FIXTURE_TIME,
      expiresAt: "2026-09-22T12:00:00.000Z",
      targetLabel: input.label ?? "button “Save”",
      pageTitle: "Settings",
      displayUrl: "http://localhost:5173/settings?tab=profile",
      stale: false,
      staleReason: null,
      image: input.image === null ? null : { width: 100, height: 50, bytes: 1024, reduced: false },
      acknowledged: false,
    },
    capture: {
      ...fixtureCaptureInput("element"),
      redaction: { ...EMPTY_WEB_ANNOTATION_REDACTION },
    },
    imageDataUrl: input.image === undefined ? PNG : input.image,
  };
  spool.set(input.captureId, record);
  return record;
}
