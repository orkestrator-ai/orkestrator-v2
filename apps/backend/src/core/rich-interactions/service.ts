import { createHash } from "node:crypto";
import { CanonicalJsonError, canonicalJson } from "@orkestrator/protocol/canonical-json";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  RICH_INTERACTION_LIMITS,
  RICH_KIND_MODULES,
  RichInteractionValidationError,
  actionClosesRequest,
  buildRichInteractionPrompt,
  isRichInteractionOpen,
  readCreateInput,
  readIdempotencyKey,
  readKindSpec,
  readSubmission,
  submissionFingerprintInput,
  summarizeSubmission,
  utf8Bytes,
  type RichActionDef,
  type RichDeliveryState,
  type RichInteractionKind,
  type RichInteractionOwner,
  type RichInteractionReceipt,
  type RichInteractionRequest,
  type RichInteractionSnapshot,
  type WorkflowActionsSpec,
  type ContentRef,
  type WidgetResultSpec,
  type WidgetResultResult,
} from "@orkestrator/protocol/rich-interactions";
import {
  applyDeliverablePatch,
  recordAcceptedArtifacts,
  type DeliverablePatch,
} from "./deliverables.js";
import type { ProductCommandRegistry } from "./product-commands.js";
import type {
  RichInteractionStore,
  RichInteractionTx,
  StoredDeliverable,
  StoredReceipt,
  StoredRequest,
} from "./store.js";

import { RichInteractionError } from "./errors.js";

const log = createLogger("rich-interactions");

export { RichInteractionError, type RichInteractionErrorCode } from "./errors.js";

function fromValidation<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof RichInteractionValidationError) {
      throw new RichInteractionError(
        error.code === "capacity" ? "capacity" : "invalid",
        error.message,
        error.path,
      );
    }
    if (error instanceof CanonicalJsonError)
      throw new RichInteractionError("invalid", error.message, error.path);
    throw error;
  }
}

function digest(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
}

export function interactionIdFor(environmentId: string, tabId: string, requestKey: string): string {
  return `ri_${digest("create", environmentId, tabId, requestKey).slice(0, 32)}`;
}

export function receiptIdFor(interactionId: string, idempotencyKey: string): string {
  return `rr_${digest("receipt", interactionId, idempotencyKey).slice(0, 32)}`;
}

export function logicalSessionKeyFor(environmentId: string, tabId: string): string {
  return `env-${environmentId}:${tabId}`;
}

/** A tab-scoped caller (an agent tool credential or a UI command naming its tab). */
export interface RichInteractionCaller {
  environmentId: string;
  tabId: string;
}

export interface RichActionView extends RichActionDef {
  available: boolean;
  unavailableReason?: string;
}

export interface RichInteractionView extends RichInteractionSnapshot {
  actions: RichActionView[];
  /** Whether the request still accepts submissions now. */
  open: boolean;
}

interface SubmissionInput {
  interactionId: string;
  expectedRevision: number;
  actionId: string;
  idempotencyKey: string;
  result: unknown;
  expectedDraftRevision?: number;
}

export interface FollowupDelivery {
  /** Resolves the tab's agent platform from its native session. */
  resolveAgent(environmentId: string, logicalSessionKey: string): Promise<string | undefined>;
  /** Idempotent enqueue by request id (see `enqueuePromptQueueMessageIfAbsent`). */
  enqueue(input: {
    queueKey: string;
    environmentId: string;
    requestId: string;
    text: string;
    origin: { kind: "rich-interaction"; interactionId: string; receiptId: string };
  }): Promise<"queued" | "present" | "consumed" | "conflict">;
  notify(queueKey: string): void;
  removed?(queueKey: string, requestId: string): Promise<boolean>;
  /** Whether the session dispatched this request id (undefined: cannot tell). */
  dispatched(
    environmentId: string,
    agent: string,
    logicalSessionKey: string,
    requestId: string,
  ): Promise<boolean | undefined>;
}

export interface RichInteractionServiceOptions {
  store: () => RichInteractionStore;
  delivery: FollowupDelivery;
  commands: ProductCommandRegistry;
  now?: () => Date;
  hasPublishedArtifact?: (
    owner: RichInteractionOwner,
    ref: Extract<ContentRef, { kind: "artifact" }>,
  ) => boolean;
  hasLiveWidget?: (
    owner: RichInteractionOwner,
    spec: WidgetResultSpec,
    generation: string,
  ) => boolean;
}

/** Delivery attempts before an un-enqueueable follow-up is reported as unknown. */
const MAX_DISPATCH_ATTEMPTS = 5;
const OUTBOX_PAGE_SIZE = 200;
const OPERATION_STARTED = "Operation started; awaiting its outcome.";

export class RichInteractionService {
  private readonly now: () => Date;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly sweepCursors = { pending: "", queued: "" };
  private sweeping: Promise<void> | null = null;
  private readonly inFlight = new Map<string, Promise<StoredReceipt>>();

  constructor(private readonly options: RichInteractionServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private store(): RichInteractionStore {
    return this.options.store();
  }

  // -------------------------------------------------------------------------
  // Agent surface

  /** `present_interaction`: create (or replay) an app-owned request in the caller's conversation. */
  async present(
    caller: RichInteractionCaller,
    input: unknown,
    toolCallId?: string,
  ): Promise<{ created: boolean; request: RichInteractionRequest }> {
    const record = (input ?? {}) as Record<string, unknown>;
    const requestKey = fromValidation(() => readIdempotencyKey(record.requestKey, "$.requestKey"));
    const validated = fromValidation(() => readCreateInput(input, { origin: "agent" }));
    const logicalSessionKey = logicalSessionKeyFor(caller.environmentId, caller.tabId);
    const agent = await this.options.delivery
      .resolveAgent(caller.environmentId, logicalSessionKey)
      .catch(() => undefined);
    const interactionId = interactionIdFor(caller.environmentId, caller.tabId, requestKey);
    const { requestKey: _key, ...semantic } = record;
    const createFingerprint = digest(canonicalJson(semantic));
    const now = this.now();
    const owner: RichInteractionOwner = {
      environmentId: caller.environmentId,
      tabId: caller.tabId,
      logicalSessionKey,
      ...(agent ? { agent } : {}),
    };
    return this.store().atomic((tx) => {
      const existing = tx.getRequest(interactionId);
      if (existing) {
        if (existing.createFingerprint !== createFingerprint) {
          throw new RichInteractionError(
            "conflict",
            "This requestKey already created a different interaction; use a new requestKey for a new request.",
          );
        }
        return { created: false, request: publicRequest(existing) };
      }
      this.assertCreationKeyNotRetired(tx, interactionId);
      if (validated.supersedes) {
        const previous = tx.getRequest(validated.supersedes);
        if (!previous || previous.owner.logicalSessionKey !== logicalSessionKey) {
          throw new RichInteractionError(
            "not-found",
            "supersedes names no interaction of this conversation.",
            "$.supersedes",
          );
        }
        if (previous.state === "open") {
          tx.putRequest({
            ...previous,
            state: "superseded",
            supersededBy: interactionId,
            updatedAt: now.toISOString(),
          });
        }
      }
      this.checkCapacity(tx, owner, now);
      const request: StoredRequest = {
        schemaVersion: 1,
        interactionId,
        revision: 1,
        kind: validated.kind,
        origin: "agent",
        revisionAuthor: "agent",
        title: validated.title,
        spec: validated.spec,
        sourceRefs: validated.sourceRefs,
        actions: validated.actions,
        state: "open",
        fallbackText: validated.fallbackText,
        owner,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        submissions: 0,
        createFingerprint,
        ...(validated.body ? { body: validated.body } : {}),
        ...(validated.expiresInSeconds
          ? { expiresAt: new Date(now.getTime() + validated.expiresInSeconds * 1000).toISOString() }
          : {}),
        ...(toolCallId ? { toolCallId: toolCallId.slice(0, 200) } : {}),
      };
      tx.putRequest(request);
      return { created: true, request: publicRequest(request) };
    });
  }

  private assertCreationKeyNotRetired(tx: RichInteractionTx, interactionId: string): void {
    if (tx.requestRetired(interactionId))
      throw new RichInteractionError(
        "closed",
        "This key belongs to a retired interaction. Start a new interaction to send a new request.",
      );
  }

  private checkCapacity(tx: RichInteractionTx, owner: RichInteractionOwner, now: Date): void {
    const requests = tx.listRequests(owner.environmentId);
    const open = requests.filter(
      (request) =>
        request.owner.logicalSessionKey === owner.logicalSessionKey &&
        isRichInteractionOpen(request, now.getTime()),
    );
    if (open.length >= RICH_INTERACTION_LIMITS.openPerConversation) {
      throw new RichInteractionError(
        "capacity",
        `At most ${RICH_INTERACTION_LIMITS.openPerConversation} interactions may be open per conversation; close finished ones.`,
      );
    }
    let needed = requests.length - RICH_INTERACTION_LIMITS.perEnvironment + 1;
    if (needed <= 0) return;
    const receipts = new Map<string, StoredReceipt[]>();
    for (const receipt of tx.listReceipts(owner.environmentId)) {
      const group = receipts.get(receipt.interactionId);
      if (group) group.push(receipt);
      else receipts.set(receipt.interactionId, [receipt]);
    }
    const retained = requests
      .slice()
      .sort(
        (a, b) =>
          a.updatedAt.localeCompare(b.updatedAt) || a.interactionId.localeCompare(b.interactionId),
      );
    for (const request of retained) {
      if (isRichInteractionOpen(request, now.getTime())) continue;
      const group = receipts.get(request.interactionId) ?? [];
      if (
        group.some(
          (receipt) =>
            receipt.delivery === "pending" ||
            receipt.delivery === "queued" ||
            this.inFlight.has(receipt.receiptId) ||
            (receipt.route === "product-command" && receipt.deliveryDetail === OPERATION_STARTED),
        )
      )
        continue;
      tx.retireRequest(request, group);
      if (--needed === 0) return;
    }
    throw new RichInteractionError(
      "capacity",
      `This environment holds ${RICH_INTERACTION_LIMITS.perEnvironment} interactions. Close finished cards or wait for pending delivery.`,
    );
  }

  /**
   * `update_interaction`: publish a new agent revision (new evidence, a revised
   * plan or document, a reply to a thread) or close the request. User-owned
   * state (thread history, human assessments, preserved sections) is merged by
   * the kind and can never be rewritten here.
   */
  async update(
    caller: RichInteractionCaller,
    input: {
      interactionId: unknown;
      expectedRevision: unknown;
      spec?: unknown;
      title?: unknown;
      body?: unknown;
      close?: unknown;
    },
  ): Promise<RichInteractionRequest> {
    const interactionId = String(input.interactionId ?? "");
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new RichInteractionError(
        "invalid",
        "expectedRevision must be the revision you last read.",
        "$.expectedRevision",
      );
    const logicalSessionKey = logicalSessionKeyFor(caller.environmentId, caller.tabId);
    const current = this.store().read((tx) => tx.getRequest(interactionId));
    if (!current || current.owner.logicalSessionKey !== logicalSessionKey) {
      throw new RichInteractionError(
        "not-found",
        "No interaction with that id belongs to this conversation.",
      );
    }
    const module = RICH_KIND_MODULES[current.kind];
    const title =
      input.title === undefined
        ? undefined
        : String(input.title).trim().slice(0, RICH_INTERACTION_LIMITS.titleChars);
    const body =
      input.body === undefined
        ? undefined
        : String(input.body).trim().slice(0, RICH_INTERACTION_LIMITS.bodyChars);
    const close = input.close === true;
    const readSpec =
      input.spec === undefined
        ? undefined
        : fromValidation(() => readKindSpec(current.kind, input.spec));
    const updateFingerprint = digest(
      canonicalJson({
        expectedRevision,
        title: title ?? null,
        body: body ?? null,
        close,
        spec: readSpec ?? null,
      }),
    );
    const now = this.now().toISOString();
    return this.store().atomic((tx) => {
      const latest = tx.getRequest(interactionId);
      if (!latest) throw new RichInteractionError("not-found", "The interaction no longer exists.");
      if (latest.updateFingerprint === updateFingerprint) return publicRequest(latest);
      if (latest.revision !== expectedRevision) {
        throw new RichInteractionError(
          "stale",
          `The interaction is at revision ${latest.revision}${latest.revisionAuthor === "user" ? " after a user edit" : ""}; read it again and resubmit against that revision.`,
        );
      }
      if (latest.state !== "open")
        throw new RichInteractionError("closed", `The interaction is ${latest.state}.`);
      const nextSpec =
        readSpec !== undefined && module.mergeAgentUpdate
          ? fromValidation(() => module.mergeAgentUpdate!(latest.spec, readSpec, "$.spec"))
          : readSpec;
      if (close && nextSpec === undefined && title === undefined && body === undefined) {
        const closed = { ...latest, state: "closed" as const, updatedAt: now, updateFingerprint };
        tx.putRequest(closed);
        return publicRequest(closed);
      }
      const next: StoredRequest = {
        ...latest,
        revision: latest.revision + 1,
        updateFingerprint,
        revisionAuthor: "agent",
        updatedAt: now,
        ...(nextSpec === undefined
          ? {}
          : { spec: nextSpec, fallbackText: module.fallback(nextSpec) }),
        ...(title ? { title } : {}),
        ...(body === undefined ? {} : { body }),
        ...(close ? { state: "closed" as const } : {}),
      };
      tx.putRequest(next);
      return publicRequest(next);
    });
  }

  /** `read_interaction_result` / `list_interactions`: the caller's own conversation only. */
  read(caller: RichInteractionCaller, interactionId: string): RichInteractionView {
    const view = this.store().read((tx) => {
      const request = tx.getRequest(interactionId);
      if (
        !request ||
        request.owner.logicalSessionKey !== logicalSessionKeyFor(caller.environmentId, caller.tabId)
      )
        return null;
      return this.view(tx, request);
    });
    if (!view)
      throw new RichInteractionError(
        "not-found",
        "No interaction with that id belongs to this conversation.",
      );
    return view;
  }

  listForConversation(
    environmentId: string,
    logicalSessionKey: string | undefined,
  ): RichInteractionView[] {
    return this.store().read((tx) =>
      tx
        .listRequests(environmentId)
        .filter(
          (request) => !logicalSessionKey || request.owner.logicalSessionKey === logicalSessionKey,
        )
        .map((request) => this.view(tx, request)),
    );
  }

  get(environmentId: string, interactionId: string): RichInteractionView {
    const view = this.store().read((tx) => {
      const request = tx.getRequest(interactionId);
      return request && request.owner.environmentId === environmentId
        ? this.view(tx, request)
        : null;
    });
    if (!view)
      throw new RichInteractionError(
        "not-found",
        "The interaction does not exist in this environment.",
      );
    return view;
  }

  private view(tx: RichInteractionTx, request: StoredRequest): RichInteractionView {
    const receipts = tx
      .listReceipts(request.owner.environmentId, request.interactionId)
      .slice(-RICH_INTERACTION_LIMITS.receiptsPerRequest)
      .map(publicReceipt);
    const draft = tx.getDraft(request.interactionId);
    const open = isRichInteractionOpen(request, this.now().getTime());
    return {
      request: {
        ...publicRequest(request),
        ...(request.state === "open" && !open ? { state: "expired" as const } : {}),
      },
      receipts,
      draft: draft
        ? {
            interactionId: draft.interactionId,
            requestRevision: draft.requestRevision,
            revision: draft.revision,
            value: draft.value,
            updatedAt: draft.updatedAt,
          }
        : null,
      open,
      actions: request.actions.map((action) => {
        if (action.route !== "product-command") return { ...action, available: true };
        const availability = this.options.commands.availability(action.commandId, request);
        return availability.available
          ? { ...action, available: true }
          : { ...action, available: false, unavailableReason: availability.reason };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Drafts

  saveDraft(
    environmentId: string,
    input: {
      interactionId: string;
      expectedDraftRevision: number;
      requestRevision: number;
      value: unknown;
    },
  ): RichInteractionView["draft"] {
    const bytes = utf8Bytes(JSON.stringify(input.value ?? null));
    if (bytes > RICH_INTERACTION_LIMITS.draftBytes) {
      throw new RichInteractionError(
        "capacity",
        `The draft is ${bytes} bytes; at most ${RICH_INTERACTION_LIMITS.draftBytes} are kept. Your edits stay in this window.`,
      );
    }
    const now = this.now().toISOString();
    return this.store().atomic((tx) => {
      const request = tx.getRequest(input.interactionId);
      if (!request || request.owner.environmentId !== environmentId)
        throw new RichInteractionError(
          "not-found",
          "The interaction does not exist in this environment.",
        );
      if (request.state !== "open")
        throw new RichInteractionError(
          "closed",
          `The interaction is ${request.state}; drafts are no longer kept.`,
        );
      const current = tx.getDraft(input.interactionId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedDraftRevision) {
        throw new RichInteractionError(
          "conflict",
          "Another window saved a newer draft. Compare it with yours before saving again.",
        );
      }
      const draft = {
        environmentId,
        interactionId: input.interactionId,
        requestRevision: input.requestRevision,
        revision: Math.max(currentRevision, request.draftSequence ?? 0) + 1,
        value: input.value ?? null,
        updatedAt: now,
      };
      tx.putRequest({ ...request, draftSequence: draft.revision });
      tx.putDraft(draft);
      const { environmentId: _env, ...rest } = draft;
      return rest;
    });
  }

  clearDraft(environmentId: string, interactionId: string): void {
    this.store().atomic((tx) => {
      const request = tx.getRequest(interactionId);
      if (request && request.owner.environmentId === environmentId)
        tx.deleteDraft(environmentId, interactionId);
    });
  }

  // -------------------------------------------------------------------------
  // Submissions

  /**
   * Commits a validated user action exactly once per idempotency key. The
   * receipt, the request revision it produces and its dispatch intent commit
   * in one transaction; delivery happens after the commit and is tracked on
   * the receipt. An identical retry returns the original receipt; a changed
   * payload under the same key is a conflict.
   */
  async submit(environmentId: string, input: SubmissionInput): Promise<RichInteractionReceipt> {
    const committed = this.store().atomic((tx) => {
      const request = tx.getRequest(input.interactionId);
      if (!request || request.owner.environmentId !== environmentId)
        throw new RichInteractionError(
          "not-found",
          "The interaction does not exist in this environment.",
        );
      return this.commitSubmission(tx, request, input, this.now());
    });
    return this.finishSubmission(committed);
  }

  private commitSubmission(
    tx: RichInteractionTx,
    request: StoredRequest,
    input: SubmissionInput,
    now: Date,
  ): { receipt: StoredReceipt; replay: boolean } {
    const idempotencyKey = fromValidation(() =>
      readIdempotencyKey(input.idempotencyKey, "$.idempotencyKey"),
    );
    const receiptId = receiptIdFor(request.interactionId, idempotencyKey);
    const existing = tx.getReceipt(receiptId);
    if (utf8Bytes(JSON.stringify(input.result ?? null)) > RICH_INTERACTION_LIMITS.resultBytes)
      throw new RichInteractionError(
        "capacity",
        "The submission exceeds the result size limit.",
        "$.result",
      );
    const inputFingerprint = fromValidation(() =>
      digest(
        submissionFingerprintInput({
          interactionId: request.interactionId,
          requestRevision: input.expectedRevision,
          actionId: input.actionId,
          result: input.result ?? null,
        }),
      ),
    );
    if (existing) {
      this.assertReplay(existing, request, input, inputFingerprint);
      return { receipt: existing, replay: true };
    }
    if (request.revision !== input.expectedRevision) {
      throw new RichInteractionError(
        "stale",
        `This request changed (now revision ${request.revision}). Review the update; your draft is kept.`,
      );
    }
    const { action, result } = fromValidation(() =>
      readSubmission(request, { actionId: input.actionId, result: input.result }),
    );
    if (action.route === "product-command") {
      const availability = this.options.commands.availability(action.commandId, request);
      if (!availability.available)
        throw new RichInteractionError("unavailable", availability.reason);
    }
    if (
      request.kind === "widget-result" &&
      !this.options.hasLiveWidget?.(
        request.owner,
        request.spec as WidgetResultSpec,
        (result as WidgetResultResult).generation,
      )
    )
      throw new RichInteractionError(
        "stale",
        "The explorer viewer is no longer active. Open it again and review a new result.",
      );
    const fingerprint = digest(
      submissionFingerprintInput({
        interactionId: request.interactionId,
        requestRevision: input.expectedRevision,
        actionId: action.id,
        result,
      }),
    );
    if (!isRichInteractionOpen(request, now.getTime())) {
      throw new RichInteractionError(
        "closed",
        request.state === "open"
          ? "This request expired."
          : `This request is ${request.state}${request.supersededBy ? "; open the current request" : ""}.`,
      );
    }
    if (request.submissions >= RICH_INTERACTION_LIMITS.receiptsPerRequest) {
      throw new RichInteractionError("capacity", "This request has reached its submission limit.");
    }
    const module = RICH_KIND_MODULES[request.kind];
    const summary = summarizeSubmission(request, action, result);
    const revisedSpec =
      module.applyRevision?.(request.spec, result, action, {
        now: now.toISOString(),
        actionRecordId: receiptId,
      }) ?? null;
    const closes = actionClosesRequest(request, action);
    const nextRevision = revisedSpec ? request.revision + 1 : request.revision;
    const delivery: RichDeliveryState = action.route === "record-only" ? "recorded" : "pending";
    const receipt: StoredReceipt = {
      receiptId,
      interactionId: request.interactionId,
      environmentId: request.owner.environmentId,
      logicalSessionKey: request.owner.logicalSessionKey,
      requestRevision: request.revision,
      actionId: action.id,
      actionLabel: action.label,
      route: action.route,
      idempotencyKey,
      fingerprint,
      inputFingerprint,
      submissionOrdinal: request.submissions + 1,
      result,
      summary,
      submittedAt: now.toISOString(),
      delivery,
      deliveryUpdatedAt: now.toISOString(),
      dispatchAttempts: 0,
      ...(revisedSpec ? { resultingRevision: nextRevision } : {}),
      ...(action.commandId ? { commandId: action.commandId } : {}),
      ...(action.route === "product-command" && request.kind === "workflow-actions"
        ? { operationRunId: (request.spec as WorkflowActionsSpec).runId }
        : {}),
      ...(action.route === "agent-followup"
        ? {
            dispatchRequestId: receiptId,
            dispatchText: buildRichInteractionPrompt(summary, {
              interactionId: request.interactionId,
              revision: request.revision,
              receiptId,
              actionId: action.id,
              kind: request.kind,
              title: request.title,
            }),
          }
        : {}),
    };
    tx.putReceipt(receipt);
    tx.putRequest({
      ...request,
      submissions: request.submissions + 1,
      updatedAt: now.toISOString(),
      ...(revisedSpec
        ? {
            spec: revisedSpec,
            revision: nextRevision,
            revisionAuthor: "user" as const,
            updateFingerprint: undefined,
            fallbackText: module.fallback(revisedSpec),
          }
        : {}),
      ...(closes ? { state: "closed" as const } : {}),
    });
    const draft = tx.getDraft(request.interactionId);
    if (
      draft &&
      draft.requestRevision === request.revision &&
      draft.revision === input.expectedDraftRevision
    )
      tx.deleteDraft(request.owner.environmentId, request.interactionId);
    recordAcceptedArtifacts(
      tx,
      request,
      action.id,
      result,
      now.toISOString(),
      (ref) => this.options.hasPublishedArtifact?.(request.owner, ref) ?? false,
    );
    return { receipt, replay: false };
  }

  private async finishSubmission(committed: {
    receipt: StoredReceipt;
    replay: boolean;
  }): Promise<RichInteractionReceipt> {
    if (!committed.replay && committed.receipt.delivery === "pending") {
      // One immediate attempt; the sweep retries anything left pending.
      return publicReceipt(
        await this.deliver(committed.receipt.receiptId).catch(() => committed.receipt),
      );
    }
    return publicReceipt(committed.receipt);
  }

  private assertReplay(
    receipt: StoredReceipt,
    request: StoredRequest,
    input: SubmissionInput,
    inputFingerprint: string,
  ): void {
    if (receipt.inputFingerprint === inputFingerprint) return;
    let fingerprint: string | null = null;
    try {
      const { action, result } = readSubmission(request, {
        actionId: input.actionId,
        result: input.result,
      });
      fingerprint = digest(
        submissionFingerprintInput({
          interactionId: input.interactionId,
          requestRevision: input.expectedRevision,
          actionId: action.id,
          result,
        }),
      );
    } catch {
      // The request moved on (a revise action changed the spec): compare the raw intent instead.
      fingerprint = null;
    }
    const sameIntent =
      receipt.requestRevision === input.expectedRevision &&
      receipt.actionId === input.actionId &&
      receipt.inputFingerprint === undefined &&
      (fingerprint === receipt.fingerprint ||
        canonicalJson(receipt.result) === canonicalJson(input.result));
    if (!sameIntent) {
      throw new RichInteractionError(
        "conflict",
        "This idempotency key already committed a different submission. Start a new submission to send a different decision.",
      );
    }
  }

  /**
   * User-originated requests (comment threads, context packets, spoken
   * requests, demonstrations): create the request in the user's own tab and
   * commit the first action. Replays by idempotency key.
   */
  async compose(
    environmentId: string,
    input: {
      tabId: string;
      kind: RichInteractionKind;
      title: string;
      spec: unknown;
      sourceRefs?: unknown;
      actionId: string;
      idempotencyKey: string;
      result: unknown;
    },
  ): Promise<{ request: RichInteractionRequest; receipt: RichInteractionReceipt }> {
    const idempotencyKey = fromValidation(() =>
      readIdempotencyKey(input.idempotencyKey, "$.idempotencyKey"),
    );
    const validated = fromValidation(() =>
      readCreateInput(
        {
          requestKey: idempotencyKey,
          kind: input.kind,
          title: input.title,
          spec: input.spec,
          sourceRefs: input.sourceRefs,
        },
        { origin: "user" },
      ),
    );
    const tabId = fromValidation(() => readIdempotencyKey(input.tabId, "$.tabId"));
    const logicalSessionKey = logicalSessionKeyFor(environmentId, tabId);
    const agent = await this.options.delivery
      .resolveAgent(environmentId, logicalSessionKey)
      .catch(() => undefined);
    const interactionId = interactionIdFor(environmentId, tabId, `user:${idempotencyKey}`);
    const createFingerprint = digest(
      canonicalJson({
        kind: validated.kind,
        title: validated.title,
        spec: validated.spec,
        sourceRefs: validated.sourceRefs,
      }),
    );
    const now = this.now();
    const committed = this.store().atomic((tx) => {
      const existing = tx.getRequest(interactionId);
      if (existing) {
        if (existing.createFingerprint !== createFingerprint)
          throw new RichInteractionError(
            "conflict",
            "This idempotency key already composed a different request.",
          );
      } else {
        this.assertCreationKeyNotRetired(tx, interactionId);
        this.checkCapacity(tx, { environmentId, tabId, logicalSessionKey }, now);
      }
      const request: StoredRequest = existing ?? {
        schemaVersion: 1,
        interactionId,
        revision: 1,
        kind: validated.kind,
        origin: "user",
        revisionAuthor: "user",
        title: validated.title,
        spec: validated.spec,
        sourceRefs: validated.sourceRefs,
        actions: validated.actions,
        state: "open",
        fallbackText: validated.fallbackText,
        owner: { environmentId, tabId, logicalSessionKey, ...(agent ? { agent } : {}) },
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        submissions: 0,
        createFingerprint,
      };
      return this.commitSubmission(
        tx,
        request,
        {
          interactionId,
          expectedRevision: 1,
          actionId: input.actionId,
          idempotencyKey,
          result: input.result,
        },
        now,
      );
    });
    const receipt = await this.finishSubmission(committed);
    return { request: this.get(environmentId, interactionId).request, receipt };
  }

  /** Closes a request the user dismisses without deciding. */
  dismiss(
    environmentId: string,
    interactionId: string,
    expectedRevision: number,
  ): RichInteractionRequest {
    const now = this.now().toISOString();
    return this.store().atomic((tx) => {
      const request = tx.getRequest(interactionId);
      if (!request || request.owner.environmentId !== environmentId)
        throw new RichInteractionError(
          "not-found",
          "The interaction does not exist in this environment.",
        );
      if (request.state !== "open") return publicRequest(request);
      if (request.revision !== expectedRevision)
        throw new RichInteractionError(
          "stale",
          "The request changed; review it before dismissing.",
        );
      const closed = { ...request, state: "closed" as const, updatedAt: now };
      tx.putRequest(closed);
      tx.deleteDraft(environmentId, interactionId);
      return publicRequest(closed);
    });
  }

  // -------------------------------------------------------------------------
  // Delivery (outbox)

  /** Moves one receipt forward. Serialized per receipt within this process. */
  deliver(receiptId: string): Promise<StoredReceipt> {
    const running = this.inFlight.get(receiptId);
    if (running) return running;
    const work = this.deliverOnce(receiptId).finally(() => this.inFlight.delete(receiptId));
    this.inFlight.set(receiptId, work);
    return work;
  }

  private async deliverOnce(receiptId: string): Promise<StoredReceipt> {
    const { receipt, request } = this.store().read((tx) => {
      const receipt = tx.getReceipt(receiptId);
      return { receipt, request: receipt ? tx.getRequest(receipt.interactionId) : null };
    });
    if (!receipt) throw new RichInteractionError("not-found", "The receipt does not exist.");
    if (!request)
      return this.mark(receipt, {
        delivery: "failed",
        deliveryDetail: "The interaction was deleted before delivery.",
      });
    if (receipt.route === "agent-followup") return this.deliverFollowup(receipt, request);
    if (receipt.route === "product-command" && receipt.delivery === "pending") {
      // Claim before running so a concurrent sweep or another process cannot run it twice.
      const claimed = this.store().atomic((tx) => {
        const latest = tx.getReceipt(receiptId);
        if (!latest || latest.delivery !== "pending") return null;
        const next = {
          ...latest,
          delivery: "unknown" as const,
          deliveryDetail: OPERATION_STARTED,
          deliveryUpdatedAt: this.now().toISOString(),
          dispatchAttempts: latest.dispatchAttempts + 1,
        };
        tx.putReceipt(next);
        return next;
      });
      if (!claimed) return this.store().read((tx) => tx.getReceipt(receiptId)) ?? receipt;
      const outcome = await this.options.commands.run(receipt.commandId ?? "", {
        request,
        receipt: claimed,
        result: receipt.result,
      });
      return this.mark(claimed, { delivery: outcome.state, deliveryDetail: outcome.detail });
    }
    return receipt;
  }

  private async deliverFollowup(
    receipt: StoredReceipt,
    request: StoredRequest,
  ): Promise<StoredReceipt> {
    if (!receipt.dispatchText || !receipt.dispatchRequestId)
      return this.mark(receipt, {
        delivery: "failed",
        deliveryDetail: "The follow-up has no prepared text.",
      });
    const agent =
      request.owner.agent ??
      (await this.options.delivery
        .resolveAgent(receipt.environmentId, receipt.logicalSessionKey)
        .catch(() => undefined));
    if (!agent) {
      return this.bumpAttempt(
        receipt,
        "The session for this tab is not available yet; delivery will be retried.",
      );
    }
    const queueKey = `${agent}\0${receipt.logicalSessionKey}`;
    if (receipt.delivery === "queued") {
      const dispatched = await this.options.delivery
        .dispatched(
          receipt.environmentId,
          agent,
          receipt.logicalSessionKey,
          receipt.dispatchRequestId,
        )
        .catch(() => undefined);
      if (dispatched)
        return this.mark(receipt, {
          delivery: "delivered",
          deliveryDetail: "Delivered to the session.",
        });
      if (await this.options.delivery.removed?.(queueKey, receipt.dispatchRequestId))
        return this.mark(receipt, {
          delivery: "failed",
          deliveryDetail: "The follow-up was removed from the session queue.",
        });
      return receipt;
    }
    if (receipt.delivery !== "pending") return receipt;
    let status: Awaited<ReturnType<FollowupDelivery["enqueue"]>>;
    try {
      status = await this.options.delivery.enqueue({
        queueKey,
        environmentId: receipt.environmentId,
        requestId: receipt.dispatchRequestId,
        text: receipt.dispatchText,
        origin: {
          kind: "rich-interaction",
          interactionId: receipt.interactionId,
          receiptId: receipt.receiptId,
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/environment (not found|is being deleted)/.test(reason)) {
        return this.mark(receipt, {
          delivery: "failed",
          deliveryDetail: "The environment is gone; the decision is kept but was not delivered.",
        });
      }
      log.warn("dispatch.enqueue-failed", { attempts: receipt.dispatchAttempts + 1 });
      return this.bumpAttempt(receipt, "Delivery is being retried.");
    }
    if (status === "conflict") {
      return this.mark(receipt, {
        delivery: "unknown",
        deliveryDetail:
          "The queue holds a different message under this request id; nothing was resent.",
      });
    }
    if (status === "consumed") {
      if (await this.options.delivery.removed?.(queueKey, receipt.dispatchRequestId))
        return this.mark(receipt, {
          delivery: "failed",
          deliveryDetail: "The follow-up was removed from the session queue.",
        });
      const dispatched = await this.options.delivery
        .dispatched(
          receipt.environmentId,
          agent,
          receipt.logicalSessionKey,
          receipt.dispatchRequestId,
        )
        .catch(() => undefined);
      return this.mark(
        receipt,
        dispatched
          ? { delivery: "delivered", deliveryDetail: "Delivered to the session." }
          : {
              delivery: "unknown",
              deliveryDetail:
                "The queue no longer holds this follow-up (it may have been removed); it was not resent.",
            },
      );
    }
    try {
      this.options.delivery.notify(queueKey);
    } catch {
      // The queue's own drain sweep is the safety net.
    }
    return this.mark(receipt, {
      delivery: "queued",
      deliveryDetail: "Queued for the session; it is sent when the session is ready.",
    });
  }

  private bumpAttempt(receipt: StoredReceipt, detail: string): StoredReceipt {
    const attempts = receipt.dispatchAttempts + 1;
    return attempts >= MAX_DISPATCH_ATTEMPTS
      ? this.mark(receipt, {
          delivery: "unknown",
          deliveryDetail:
            "Delivery could not be confirmed after several attempts. It was not resent; retry it explicitly.",
          dispatchAttempts: attempts,
        })
      : this.mark(receipt, { deliveryDetail: detail, dispatchAttempts: attempts });
  }

  private mark(
    receipt: StoredReceipt,
    patch: Partial<Pick<StoredReceipt, "delivery" | "deliveryDetail" | "dispatchAttempts">>,
  ): StoredReceipt {
    return this.store().atomic((tx) => {
      const latest = tx.getReceipt(receipt.receiptId);
      if (!latest || !tx.getRequest(latest.interactionId)) return receipt;
      if (
        latest.delivery !== receipt.delivery ||
        latest.dispatchAttempts !== receipt.dispatchAttempts
      )
        return latest;
      const next: StoredReceipt = {
        ...latest,
        ...patch,
        deliveryUpdatedAt: this.now().toISOString(),
      };
      tx.putReceipt(next);
      return next;
    });
  }

  /**
   * An explicit user retry of an `unknown` or `failed` follow-up. It re-enqueues
   * the identical bytes under the same request id, so a delivery that did in
   * fact happen is not duplicated by the queue.
   */
  async retryDelivery(environmentId: string, receiptId: string): Promise<RichInteractionReceipt> {
    const receipt = this.store().atomic((tx) => {
      const latest = tx.getReceipt(receiptId);
      if (!latest || latest.environmentId !== environmentId)
        throw new RichInteractionError(
          "not-found",
          "The receipt does not exist in this environment.",
        );
      if (latest.route !== "agent-followup")
        throw new RichInteractionError(
          "invalid",
          "Only follow-ups can be retried; a product operation is never re-run automatically.",
        );
      if (latest.delivery !== "unknown" && latest.delivery !== "failed") return latest;
      const next = {
        ...latest,
        delivery: "pending" as const,
        dispatchAttempts: 0,
        deliveryDetail: "Retry requested.",
        deliveryUpdatedAt: this.now().toISOString(),
      };
      tx.putReceipt(next);
      return next;
    });
    return publicReceipt(receipt.delivery === "pending" ? await this.deliver(receiptId) : receipt);
  }

  /** Advances every outstanding receipt; called on a timer and at startup (restart recovery). */
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      const outstanding = this.store().read((tx) =>
        (["pending", "queued"] as const).flatMap((state) => {
          const page = tx.listOutstandingReceipts(
            state,
            this.sweepCursors[state],
            OUTBOX_PAGE_SIZE,
          );
          this.sweepCursors[state] = page.length === OUTBOX_PAGE_SIZE ? page.at(-1)!.receiptId : "";
          return page;
        }),
      );
      for (const receipt of outstanding) {
        await this.deliver(receipt.receiptId).catch((error: unknown) =>
          log.warn("sweep.deliver-failed", { error: formatLogError(error) }),
        );
      }
    })().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  start(intervalMs = 5_000): void {
    if (this.sweepTimer) return;
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  // -------------------------------------------------------------------------
  // Deliverables (feature 13)

  listDeliverables(
    environmentId: string,
    logicalSessionKey: string,
  ): Array<Omit<StoredDeliverable, "environmentId">> {
    return this.store()
      .read((tx) => tx.listDeliverables(environmentId, logicalSessionKey))
      .map(({ environmentId: _e, ...rest }) => rest);
  }

  updateDeliverable(
    environmentId: string,
    input: {
      logicalSessionKey: string;
      artifactId: string;
      expectedRevision: number;
      patch: DeliverablePatch;
    },
  ): Omit<StoredDeliverable, "environmentId"> {
    if (!input.logicalSessionKey.startsWith(`env-${environmentId}:`)) {
      throw new RichInteractionError(
        "forbidden",
        "The conversation does not belong to this environment.",
      );
    }
    const outcome = this.store().atomic((tx) =>
      applyDeliverablePatch(tx, { environmentId, ...input, now: this.now().toISOString() }),
    );
    if ("conflict" in outcome)
      throw new RichInteractionError(
        "conflict",
        "Another window changed this deliverable; refresh and try again.",
      );
    const { environmentId: _e, ...rest } = outcome;
    return rest;
  }

  environmentDeleted(environmentId: string): void {
    this.store().atomic((tx) => tx.deleteEnvironment(environmentId));
  }
}

export function publicRequest(
  request: StoredRequest | RichInteractionRequest,
): RichInteractionRequest {
  const {
    createFingerprint: _fingerprint,
    updateFingerprint: _update,
    draftSequence: _draftSequence,
    ...rest
  } = request as StoredRequest;
  return rest;
}

export function publicReceipt(
  receipt: StoredReceipt | RichInteractionReceipt,
): RichInteractionReceipt {
  const {
    environmentId: _e,
    logicalSessionKey: _l,
    dispatchText: _t,
    dispatchAttempts: _a,
    inputFingerprint: _input,
    submissionOrdinal: _ordinal,
    operationRunId: _run,
    ...rest
  } = receipt as StoredReceipt;
  return rest;
}
