import { createHash } from "node:crypto";
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
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
} from "@orkestrator/protocol/rich-interactions";
import { applyDeliverablePatch, recordAcceptedArtifacts, type DeliverablePatch } from "./deliverables.js";
import type { ProductCommandRegistry } from "./product-commands.js";
import type { RichInteractionStore, RichInteractionTx, StoredDeliverable, StoredReceipt, StoredRequest } from "./store.js";

const log = createLogger("rich-interactions");

export type RichInteractionErrorCode =
  | "invalid"
  | "capacity"
  | "not-found"
  | "forbidden"
  | "stale"
  | "closed"
  | "conflict"
  | "unavailable";

/** A refusal with a stable code and a readable, content-free message. */
export class RichInteractionError extends Error {
  constructor(
    readonly code: RichInteractionErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "RichInteractionError";
  }
}

function fromValidation<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof RichInteractionValidationError) {
      throw new RichInteractionError(error.code === "capacity" ? "capacity" : "invalid", error.message, error.path);
    }
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
  /** Whether the session dispatched this request id (undefined: cannot tell). */
  dispatched(environmentId: string, agent: string, logicalSessionKey: string, requestId: string): Promise<boolean | undefined>;
}

export interface RichInteractionServiceOptions {
  store: () => RichInteractionStore;
  delivery: FollowupDelivery;
  commands: ProductCommandRegistry;
  now?: () => Date;
}

/** Delivery attempts before an un-enqueueable follow-up is reported as unknown. */
const MAX_DISPATCH_ATTEMPTS = 5;
const OUTSTANDING_STATES: ReadonlySet<RichDeliveryState> = new Set(["pending", "queued"]);

export class RichInteractionService {
  private readonly now: () => Date;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
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
  async present(caller: RichInteractionCaller, input: unknown, toolCallId?: string): Promise<{ created: boolean; request: RichInteractionRequest }> {
    const record = (input ?? {}) as Record<string, unknown>;
    const requestKey = fromValidation(() => readIdempotencyKey(record.requestKey, "$.requestKey"));
    const validated = fromValidation(() => readCreateInput(input, { origin: "agent" }));
    const logicalSessionKey = logicalSessionKeyFor(caller.environmentId, caller.tabId);
    const agent = await this.options.delivery.resolveAgent(caller.environmentId, logicalSessionKey).catch(() => undefined);
    const interactionId = interactionIdFor(caller.environmentId, caller.tabId, requestKey);
    const { requestKey: _key, ...semantic } = record;
    const createFingerprint = digest(canonicalJson(semantic));
    const now = this.now();
    const owner: RichInteractionOwner = { environmentId: caller.environmentId, tabId: caller.tabId, logicalSessionKey, ...(agent ? { agent } : {}) };
    return this.store().atomic((tx) => {
      const existing = tx.getRequest(interactionId);
      if (existing) {
        if (existing.createFingerprint !== createFingerprint) {
          throw new RichInteractionError("conflict", "This requestKey already created a different interaction; use a new requestKey for a new request.");
        }
        return { created: false, request: publicRequest(existing) };
      }
      const conversation = tx.listRequests(caller.environmentId);
      if (conversation.length >= RICH_INTERACTION_LIMITS.perEnvironment) {
        throw new RichInteractionError("capacity", `This environment holds ${RICH_INTERACTION_LIMITS.perEnvironment} interactions; close or supersede older ones.`);
      }
      const open = conversation.filter((r) => r.owner.logicalSessionKey === logicalSessionKey && isRichInteractionOpen(r, now.getTime()));
      if (open.length >= RICH_INTERACTION_LIMITS.openPerConversation) {
        throw new RichInteractionError("capacity", `At most ${RICH_INTERACTION_LIMITS.openPerConversation} interactions may be open per conversation; close finished ones with update_interaction.`);
      }
      if (validated.supersedes) {
        const previous = tx.getRequest(validated.supersedes);
        if (!previous || previous.owner.logicalSessionKey !== logicalSessionKey) {
          throw new RichInteractionError("not-found", "supersedes names no interaction of this conversation.", "$.supersedes");
        }
        if (previous.state === "open") {
          tx.putRequest({ ...previous, state: "superseded", supersededBy: interactionId, updatedAt: now.toISOString() });
        }
      }
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
        ...(validated.expiresInSeconds ? { expiresAt: new Date(now.getTime() + validated.expiresInSeconds * 1000).toISOString() } : {}),
        ...(toolCallId ? { toolCallId: toolCallId.slice(0, 200) } : {}),
      };
      tx.putRequest(request);
      return { created: true, request: publicRequest(request) };
    });
  }

  /**
   * `update_interaction`: publish a new agent revision (new evidence, a revised
   * plan or document, a reply to a thread) or close the request. User-owned
   * state (thread history, human assessments, preserved sections) is merged by
   * the kind and can never be rewritten here.
   */
  async update(
    caller: RichInteractionCaller,
    input: { interactionId: unknown; expectedRevision: unknown; spec?: unknown; title?: unknown; body?: unknown; close?: unknown },
  ): Promise<RichInteractionRequest> {
    const interactionId = String(input.interactionId ?? "");
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new RichInteractionError("invalid", "expectedRevision must be the revision you last read.", "$.expectedRevision");
    const logicalSessionKey = logicalSessionKeyFor(caller.environmentId, caller.tabId);
    const current = this.store().read((tx) => tx.getRequest(interactionId));
    if (!current || current.owner.logicalSessionKey !== logicalSessionKey) {
      throw new RichInteractionError("not-found", "No interaction with that id belongs to this conversation.");
    }
    const module = RICH_KIND_MODULES[current.kind];
    const nextSpec =
      input.spec === undefined
        ? undefined
        : fromValidation(() => {
            const read = readKindSpec(current.kind, input.spec);
            return module.mergeAgentUpdate ? module.mergeAgentUpdate(current.spec, read, "$.spec") : read;
          });
    const title = input.title === undefined ? undefined : String(input.title).trim().slice(0, RICH_INTERACTION_LIMITS.titleChars);
    const body = input.body === undefined ? undefined : String(input.body).trim().slice(0, RICH_INTERACTION_LIMITS.bodyChars);
    const close = input.close === true;
    const now = this.now().toISOString();
    return this.store().atomic((tx) => {
      const latest = tx.getRequest(interactionId);
      if (!latest) throw new RichInteractionError("not-found", "The interaction no longer exists.");
      // Replay: the previous call already produced exactly this revision.
      if (
        latest.revision === expectedRevision + 1 &&
        latest.revisionAuthor === "agent" &&
        (nextSpec === undefined || canonicalJson(latest.spec) === canonicalJson(nextSpec)) &&
        (!close || latest.state === "closed")
      ) {
        return publicRequest(latest);
      }
      if (latest.revision !== expectedRevision) {
        throw new RichInteractionError("stale", `The interaction is at revision ${latest.revision}${latest.revisionAuthor === "user" ? " after a user edit" : ""}; read it again and resubmit against that revision.`);
      }
      if (latest.state !== "open") throw new RichInteractionError("closed", `The interaction is ${latest.state}.`);
      if (close && nextSpec === undefined && title === undefined && body === undefined) {
        const closed = { ...latest, state: "closed" as const, updatedAt: now };
        tx.putRequest(closed);
        return publicRequest(closed);
      }
      const next: StoredRequest = {
        ...latest,
        revision: latest.revision + 1,
        revisionAuthor: "agent",
        updatedAt: now,
        ...(nextSpec === undefined ? {} : { spec: nextSpec, fallbackText: module.fallback(nextSpec) }),
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
      if (!request || request.owner.logicalSessionKey !== logicalSessionKeyFor(caller.environmentId, caller.tabId)) return null;
      return this.view(tx, request);
    });
    if (!view) throw new RichInteractionError("not-found", "No interaction with that id belongs to this conversation.");
    return view;
  }

  listForConversation(environmentId: string, logicalSessionKey: string | undefined): RichInteractionView[] {
    return this.store().read((tx) =>
      tx
        .listRequests(environmentId)
        .filter((request) => !logicalSessionKey || request.owner.logicalSessionKey === logicalSessionKey)
        .map((request) => this.view(tx, request)),
    );
  }

  get(environmentId: string, interactionId: string): RichInteractionView {
    const view = this.store().read((tx) => {
      const request = tx.getRequest(interactionId);
      return request && request.owner.environmentId === environmentId ? this.view(tx, request) : null;
    });
    if (!view) throw new RichInteractionError("not-found", "The interaction does not exist in this environment.");
    return view;
  }

  private view(tx: RichInteractionTx, request: StoredRequest): RichInteractionView {
    const receipts = tx.listReceipts(request.owner.environmentId, request.interactionId).slice(-RICH_INTERACTION_LIMITS.receiptsPerRequest).map(publicReceipt);
    const draft = tx.getDraft(request.interactionId);
    const open = isRichInteractionOpen(request, this.now().getTime());
    return {
      request: { ...publicRequest(request), ...(request.state === "open" && !open ? { state: "expired" as const } : {}) },
      receipts,
      draft: draft ? { interactionId: draft.interactionId, requestRevision: draft.requestRevision, revision: draft.revision, value: draft.value, updatedAt: draft.updatedAt } : null,
      open,
      actions: request.actions.map((action) => {
        if (action.route !== "product-command") return { ...action, available: true };
        const availability = this.options.commands.availability(action.commandId, request);
        return availability.available ? { ...action, available: true } : { ...action, available: false, unavailableReason: availability.reason };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Drafts

  saveDraft(environmentId: string, input: { interactionId: string; expectedDraftRevision: number; requestRevision: number; value: unknown }): RichInteractionView["draft"] {
    const bytes = utf8Bytes(JSON.stringify(input.value ?? null));
    if (bytes > RICH_INTERACTION_LIMITS.draftBytes) {
      throw new RichInteractionError("capacity", `The draft is ${bytes} bytes; at most ${RICH_INTERACTION_LIMITS.draftBytes} are kept. Your edits stay in this window.`);
    }
    const now = this.now().toISOString();
    return this.store().atomic((tx) => {
      const request = tx.getRequest(input.interactionId);
      if (!request || request.owner.environmentId !== environmentId) throw new RichInteractionError("not-found", "The interaction does not exist in this environment.");
      if (request.state !== "open") throw new RichInteractionError("closed", `The interaction is ${request.state}; drafts are no longer kept.`);
      const current = tx.getDraft(input.interactionId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedDraftRevision) {
        throw new RichInteractionError("conflict", "Another window saved a newer draft. Compare it with yours before saving again.");
      }
      const draft = { environmentId, interactionId: input.interactionId, requestRevision: input.requestRevision, revision: currentRevision + 1, value: input.value ?? null, updatedAt: now };
      tx.putDraft(draft);
      const { environmentId: _env, ...rest } = draft;
      return rest;
    });
  }

  clearDraft(environmentId: string, interactionId: string): void {
    this.store().atomic((tx) => {
      const request = tx.getRequest(interactionId);
      if (request && request.owner.environmentId === environmentId) tx.deleteDraft(environmentId, interactionId);
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
  async submit(
    environmentId: string,
    input: { interactionId: string; expectedRevision: number; actionId: string; idempotencyKey: string; result: unknown },
  ): Promise<RichInteractionReceipt> {
    const idempotencyKey = fromValidation(() => readIdempotencyKey(input.idempotencyKey, "$.idempotencyKey"));
    const receiptId = receiptIdFor(input.interactionId, idempotencyKey);
    const snapshot = this.store().read((tx) => ({ request: tx.getRequest(input.interactionId), receipt: tx.getReceipt(receiptId) }));
    if (!snapshot.request || snapshot.request.owner.environmentId !== environmentId) {
      throw new RichInteractionError("not-found", "The interaction does not exist in this environment.");
    }
    // A retry of a committed submission is answered from its receipt, even
    // after the request closed or moved on.
    if (snapshot.receipt) {
      return this.replayOrConflict(snapshot.receipt, snapshot.request, input);
    }
    // Validate against the revision the person saw, never a newer one.
    if (snapshot.request.revision !== input.expectedRevision) {
      throw new RichInteractionError("stale", `This request changed (now revision ${snapshot.request.revision}). Review the update; your draft is kept.`);
    }
    const { action, result } = fromValidation(() => readSubmission(snapshot.request!, { actionId: input.actionId, result: input.result }));
    if (action.route === "product-command") {
      const availability = this.options.commands.availability(action.commandId, snapshot.request);
      if (!availability.available) throw new RichInteractionError("unavailable", availability.reason);
    }
    const fingerprint = digest(submissionFingerprintInput({ interactionId: input.interactionId, requestRevision: input.expectedRevision, actionId: action.id, result }));
    const now = this.now();
    const committed = this.store().atomic((tx) => {
      const existing = tx.getReceipt(receiptId);
      const request = tx.getRequest(input.interactionId);
      if (!request) throw new RichInteractionError("not-found", "The interaction no longer exists.");
      if (existing) return { receipt: existing, replay: true };
      if (request.revision !== input.expectedRevision) {
        throw new RichInteractionError("stale", `This request changed (now revision ${request.revision}). Review the update; your draft is kept.`);
      }
      if (!isRichInteractionOpen(request, now.getTime())) {
        throw new RichInteractionError("closed", request.state === "open" ? "This request expired." : `This request is ${request.state}${request.supersededBy ? "; open the current request" : ""}.`);
      }
      if (request.submissions >= RICH_INTERACTION_LIMITS.receiptsPerRequest) {
        throw new RichInteractionError("capacity", "This request has reached its submission limit.");
      }
      const module = RICH_KIND_MODULES[request.kind];
      const summary = summarizeSubmission(request, action, result);
      const revisedSpec = module.applyRevision?.(request.spec, result, action, { now: now.toISOString(), actionRecordId: receiptId }) ?? null;
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
        result,
        summary,
        submittedAt: now.toISOString(),
        delivery,
        deliveryUpdatedAt: now.toISOString(),
        dispatchAttempts: 0,
        ...(revisedSpec ? { resultingRevision: nextRevision } : {}),
        ...(action.commandId ? { commandId: action.commandId } : {}),
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
        ...(revisedSpec ? { spec: revisedSpec, revision: nextRevision, revisionAuthor: "user" as const, fallbackText: module.fallback(revisedSpec) } : {}),
        ...(closes ? { state: "closed" as const } : {}),
      });
      if (closes || revisedSpec) tx.deleteDraft(request.owner.environmentId, request.interactionId);
      recordAcceptedArtifacts(tx, request, action.id, result, now.toISOString());
      return { receipt, replay: false };
    });
    if (committed.replay) return this.replayOrConflict(committed.receipt, snapshot.request, input);
    if (committed.receipt.delivery === "pending") {
      // One immediate attempt; the sweep retries anything left pending.
      return publicReceipt(await this.deliver(committed.receipt.receiptId).catch(() => committed.receipt));
    }
    return publicReceipt(committed.receipt);
  }

  private replayOrConflict(
    receipt: StoredReceipt,
    request: StoredRequest,
    input: { interactionId: string; expectedRevision: number; actionId: string; result: unknown },
  ): RichInteractionReceipt {
    let fingerprint: string | null = null;
    try {
      const { action, result } = readSubmission(request, { actionId: input.actionId, result: input.result });
      fingerprint = digest(submissionFingerprintInput({ interactionId: input.interactionId, requestRevision: input.expectedRevision, actionId: action.id, result }));
    } catch {
      // The request moved on (a revise action changed the spec): compare the raw intent instead.
      fingerprint = null;
    }
    const sameIntent =
      receipt.requestRevision === input.expectedRevision &&
      receipt.actionId === input.actionId &&
      (fingerprint === receipt.fingerprint || canonicalJson(receipt.result) === canonicalJson(input.result));
    if (!sameIntent) {
      throw new RichInteractionError("conflict", "This idempotency key already committed a different submission. Start a new submission to send a different decision.");
    }
    return publicReceipt(receipt);
  }

  /**
   * User-originated requests (comment threads, context packets, spoken
   * requests, demonstrations): create the request in the user's own tab and
   * commit the first action. Replays by idempotency key.
   */
  async compose(
    environmentId: string,
    input: { tabId: string; kind: RichInteractionKind; title: string; spec: unknown; sourceRefs?: unknown; actionId: string; idempotencyKey: string; result: unknown },
  ): Promise<{ request: RichInteractionRequest; receipt: RichInteractionReceipt }> {
    const idempotencyKey = fromValidation(() => readIdempotencyKey(input.idempotencyKey, "$.idempotencyKey"));
    const validated = fromValidation(() => readCreateInput({ requestKey: idempotencyKey, kind: input.kind, title: input.title, spec: input.spec, sourceRefs: input.sourceRefs }, { origin: "user" }));
    const tabId = fromValidation(() => readIdempotencyKey(input.tabId, "$.tabId"));
    const logicalSessionKey = logicalSessionKeyFor(environmentId, tabId);
    const agent = await this.options.delivery.resolveAgent(environmentId, logicalSessionKey).catch(() => undefined);
    const interactionId = interactionIdFor(environmentId, tabId, `user:${idempotencyKey}`);
    const createFingerprint = digest(canonicalJson({ kind: validated.kind, title: validated.title, spec: validated.spec, sourceRefs: validated.sourceRefs }));
    const now = this.now().toISOString();
    this.store().atomic((tx) => {
      const existing = tx.getRequest(interactionId);
      if (existing) {
        if (existing.createFingerprint !== createFingerprint) throw new RichInteractionError("conflict", "This idempotency key already composed a different request.");
        return;
      }
      tx.putRequest({
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
        createdAt: now,
        updatedAt: now,
        submissions: 0,
        createFingerprint,
      });
    });
    const receipt = await this.submit(environmentId, { interactionId, expectedRevision: 1, actionId: input.actionId, idempotencyKey, result: input.result });
    return { request: this.get(environmentId, interactionId).request, receipt };
  }

  /** Closes a request the user dismisses without deciding. */
  dismiss(environmentId: string, interactionId: string, expectedRevision: number): RichInteractionRequest {
    const now = this.now().toISOString();
    return this.store().atomic((tx) => {
      const request = tx.getRequest(interactionId);
      if (!request || request.owner.environmentId !== environmentId) throw new RichInteractionError("not-found", "The interaction does not exist in this environment.");
      if (request.state !== "open") return publicRequest(request);
      if (request.revision !== expectedRevision) throw new RichInteractionError("stale", "The request changed; review it before dismissing.");
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
    if (!request) return this.mark(receipt, { delivery: "failed", deliveryDetail: "The interaction was deleted before delivery." });
    if (receipt.route === "agent-followup") return this.deliverFollowup(receipt, request);
    if (receipt.route === "product-command" && receipt.delivery === "pending") {
      // Claim before running so a concurrent sweep or another process cannot run it twice.
      const claimed = this.store().atomic((tx) => {
        const latest = tx.getReceipt(receiptId);
        if (!latest || latest.delivery !== "pending") return null;
        const next = { ...latest, delivery: "unknown" as const, deliveryDetail: "Operation started; awaiting its outcome.", deliveryUpdatedAt: this.now().toISOString(), dispatchAttempts: latest.dispatchAttempts + 1 };
        tx.putReceipt(next);
        return next;
      });
      if (!claimed) return this.store().read((tx) => tx.getReceipt(receiptId)) ?? receipt;
      const outcome = await this.options.commands.run(receipt.commandId ?? "", { request, receipt: claimed, result: receipt.result });
      return this.mark(claimed, { delivery: outcome.state, deliveryDetail: outcome.detail });
    }
    return receipt;
  }

  private async deliverFollowup(receipt: StoredReceipt, request: StoredRequest): Promise<StoredReceipt> {
    if (!receipt.dispatchText || !receipt.dispatchRequestId) return this.mark(receipt, { delivery: "failed", deliveryDetail: "The follow-up has no prepared text." });
    const agent = request.owner.agent ?? (await this.options.delivery.resolveAgent(receipt.environmentId, receipt.logicalSessionKey).catch(() => undefined));
    if (!agent) {
      return this.bumpAttempt(receipt, "The session for this tab is not available yet; delivery will be retried.");
    }
    const queueKey = `${agent}\0${receipt.logicalSessionKey}`;
    if (receipt.delivery === "queued") {
      const dispatched = await this.options.delivery.dispatched(receipt.environmentId, agent, receipt.logicalSessionKey, receipt.dispatchRequestId).catch(() => undefined);
      if (dispatched) return this.mark(receipt, { delivery: "delivered", deliveryDetail: "Delivered to the session." });
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
        origin: { kind: "rich-interaction", interactionId: receipt.interactionId, receiptId: receipt.receiptId },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (/environment (not found|is being deleted)/.test(reason)) {
        return this.mark(receipt, { delivery: "failed", deliveryDetail: "The environment is gone; the decision is kept but was not delivered." });
      }
      log.warn("dispatch.enqueue-failed", { attempts: receipt.dispatchAttempts + 1 });
      return this.bumpAttempt(receipt, "Delivery is being retried.");
    }
    if (status === "conflict") {
      return this.mark(receipt, { delivery: "unknown", deliveryDetail: "The queue holds a different message under this request id; nothing was resent." });
    }
    if (status === "consumed") {
      const dispatched = await this.options.delivery.dispatched(receipt.environmentId, agent, receipt.logicalSessionKey, receipt.dispatchRequestId).catch(() => undefined);
      return this.mark(receipt, dispatched
        ? { delivery: "delivered", deliveryDetail: "Delivered to the session." }
        : { delivery: "unknown", deliveryDetail: "The queue no longer holds this follow-up (it may have been removed); it was not resent." });
    }
    try {
      this.options.delivery.notify(queueKey);
    } catch {
      // The queue's own drain sweep is the safety net.
    }
    return this.mark(receipt, { delivery: "queued", deliveryDetail: "Queued for the session; it is sent when the session is ready." });
  }

  private bumpAttempt(receipt: StoredReceipt, detail: string): StoredReceipt {
    const attempts = receipt.dispatchAttempts + 1;
    return attempts >= MAX_DISPATCH_ATTEMPTS
      ? this.mark(receipt, { delivery: "unknown", deliveryDetail: "Delivery could not be confirmed after several attempts. It was not resent; retry it explicitly.", dispatchAttempts: attempts })
      : this.mark(receipt, { deliveryDetail: detail, dispatchAttempts: attempts });
  }

  private mark(receipt: StoredReceipt, patch: Partial<Pick<StoredReceipt, "delivery" | "deliveryDetail" | "dispatchAttempts">>): StoredReceipt {
    return this.store().atomic((tx) => {
      const latest = tx.getReceipt(receipt.receiptId) ?? receipt;
      const next: StoredReceipt = { ...latest, ...patch, deliveryUpdatedAt: this.now().toISOString() };
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
      if (!latest || latest.environmentId !== environmentId) throw new RichInteractionError("not-found", "The receipt does not exist in this environment.");
      if (latest.route !== "agent-followup") throw new RichInteractionError("invalid", "Only follow-ups can be retried; a product operation is never re-run automatically.");
      if (latest.delivery !== "unknown" && latest.delivery !== "failed") return latest;
      const next = { ...latest, delivery: "pending" as const, dispatchAttempts: 0, deliveryDetail: "Retry requested.", deliveryUpdatedAt: this.now().toISOString() };
      tx.putReceipt(next);
      return next;
    });
    return publicReceipt(receipt.delivery === "pending" ? await this.deliver(receiptId) : receipt);
  }

  /** Advances every outstanding receipt; called on a timer and at startup (restart recovery). */
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      const outstanding = this.store().read((tx) => tx.listOutstandingReceipts(OUTSTANDING_STATES, 200));
      for (const receipt of outstanding) {
        await this.deliver(receipt.receiptId).catch((error: unknown) => log.warn("sweep.deliver-failed", { error: formatLogError(error) }));
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

  listDeliverables(environmentId: string, logicalSessionKey: string): Array<Omit<StoredDeliverable, "environmentId">> {
    return this.store().read((tx) => tx.listDeliverables(environmentId, logicalSessionKey)).map(({ environmentId: _e, ...rest }) => rest);
  }

  updateDeliverable(
    environmentId: string,
    input: { logicalSessionKey: string; artifactId: string; expectedRevision: number; patch: DeliverablePatch },
  ): Omit<StoredDeliverable, "environmentId"> {
    if (!input.logicalSessionKey.startsWith(`env-${environmentId}:`)) {
      throw new RichInteractionError("forbidden", "The conversation does not belong to this environment.");
    }
    const outcome = this.store().atomic((tx) =>
      applyDeliverablePatch(tx, { environmentId, ...input, now: this.now().toISOString() }),
    );
    if ("conflict" in outcome) throw new RichInteractionError("conflict", "Another window changed this deliverable; refresh and try again.");
    const { environmentId: _e, ...rest } = outcome;
    return rest;
  }

  environmentDeleted(environmentId: string): void {
    this.store().atomic((tx) => tx.deleteEnvironment(environmentId));
  }
}

export function publicRequest(request: StoredRequest | RichInteractionRequest): RichInteractionRequest {
  const { createFingerprint: _fingerprint, ...rest } = request as StoredRequest;
  return rest;
}

export function publicReceipt(receipt: StoredReceipt | RichInteractionReceipt): RichInteractionReceipt {
  const { environmentId: _e, logicalSessionKey: _l, dispatchText: _t, dispatchAttempts: _a, ...rest } = receipt as StoredReceipt;
  return rest;
}
