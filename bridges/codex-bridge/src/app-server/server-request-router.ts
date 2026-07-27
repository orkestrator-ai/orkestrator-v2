/**
 * Answers server-initiated requests.
 *
 * app-server is bidirectional: it can ask the *client* for approvals, user input,
 * MCP elicitation, dynamic tool execution, auth refresh, and attestation. The
 * hazard is silence — an unanswered request leaves the turn waiting forever, so
 * every branch here must produce a response, and the switch must stay exhaustive
 * over the generated `ServerRequest` union.
 *
 * Orkestrator runs with `approvalPolicy: "never"` for command/file permissions,
 * while supported user questions and MCP elicitation are parked for the native
 * UI. Requests without an addressable UI are declined explicitly and surfaced in
 * the transcript rather than being dropped.
 *
 * Nothing here ever takes a thread reducer lock. Human-facing requests are
 * parked with a bounded timeout; requests the UI cannot represent are cancelled
 * promptly instead of stalling the thread.
 */
import { JSON_RPC_METHOD_NOT_FOUND } from "./errors.js";
import {
  buildApprovalResponse,
  describeApproval,
  describeApprovalOutcome,
  isInteractiveApprovalMethod,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolution,
  type InteractiveApprovalMethod,
} from "./approvals.js";
import type { InboundServerRequest } from "./envelope-validation.js";
import type { EngineGeneration } from "../engine/types.js";
import {
  buildInteractionResponse,
  describeInteraction,
  type InteractionAnswer,
  type InteractionMethod,
  type InteractionRequest,
  type InteractionResolution,
} from "./interactions.js";

/** Every method in the pinned `ServerRequest` union. */
export type ServerRequestMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request"
  | "item/permissions/requestApproval"
  | "item/tool/call"
  | "account/chatgptAuthTokens/refresh"
  | "attestation/generate"
  | "applyPatchApproval"
  | "execCommandApproval";

export const KNOWN_SERVER_REQUEST_METHODS: readonly ServerRequestMethod[] = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "attestation/generate",
  "applyPatchApproval",
  "execCommandApproval",
];

export type ServerRequestResolution =
  | "declined"
  | "cancelled"
  | "unsupported"
  | "protocol-error"
  /** Answered by a human through the approval UI. */
  | "user-approved"
  | "user-declined"
  | "user-answered";

export interface ServerRequestRecord {
  id: string | number;
  method: string;
  generation: EngineGeneration;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  receivedAt: number;
  resolution?: ServerRequestResolution;
  resolvedAt?: number;
  /** True when our own timeout fired before we produced a response. */
  timedOut?: boolean;
}

export interface ServerRequestRouterOptions {
  respond: (
    generation: EngineGeneration,
    id: string | number,
    result: unknown,
  ) => Promise<void>;
  respondWithError: (
    generation: EngineGeneration,
    id: string | number,
    code: number,
    message: string,
  ) => Promise<void>;
  /**
   * Surfaces a user-readable explanation in the transcript. Called for requests
   * we cannot honour, so a declined approval is visible rather than a mystery
   * stall.
   */
  reportToTranscript?: (options: {
    threadId: string | null;
    turnId: string | null;
    message: string;
  }) => void;
  /** Incremented for anything that should not have been possible. */
  onInvariantViolation?: (method: string, detail: string) => void;
  onUnknownRequest?: (method: string) => void;
  /**
   * Offers an approval request to the UI.
   *
   * Returning `true` means someone has taken ownership and will answer through
   * `resolveApproval`; the router then parks the request for up to
   * `approvalTimeoutMs`. Returning `false` (or throwing) falls straight through to
   * the non-interactive behaviour, so a bridge with no UI attached behaves exactly
   * as it did before approvals existed.
   *
   * Must be synchronous and cheap: it is called on the path from the read loop.
   */
  presentApproval?: (request: ApprovalRequest) => boolean;
  /** Notifies the UI that a parked approval is no longer actionable. */
  onApprovalResolved?: (
    request: ApprovalRequest,
    decision: ApprovalDecision,
    resolution: ApprovalResolution,
  ) => void;
  presentInteraction?: (request: InteractionRequest) => boolean;
  onInteractionResolved?: (
    request: InteractionRequest,
    answer: InteractionAnswer,
    resolution: InteractionResolution,
  ) => void;
  /** Backstop so a branch that somehow fails to answer still answers. */
  responseTimeoutMs?: number;
  /** How long a human has to answer before the request auto-declines. */
  approvalTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_RESPONSE_TIMEOUT_MS = 10_000;

/**
 * Humans are slow. This has to be long enough that a real person reading a diff
 * is not cut off, and short enough that a forgotten prompt does not pin a turn
 * open indefinitely.
 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000;

interface PendingApproval {
  key: string;
  record: ServerRequestRecord;
  request: ApprovalRequest;
  method: InteractiveApprovalMethod;
  rawParams: unknown;
  generation: EngineGeneration;
  requestId: string | number;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingInteraction {
  key: string;
  record: ServerRequestRecord;
  request: InteractionRequest;
  generation: EngineGeneration;
  requestId: string | number;
  timer: ReturnType<typeof setTimeout>;
}

export class ServerRequestRouter {
  private readonly options: ServerRequestRouterOptions;
  private readonly now: () => number;
  private readonly responseTimeoutMs: number;
  private readonly pending = new Map<string, ServerRequestRecord>();
  /** Requests whose response write has begun; the double-answer guard. */
  private readonly sendStarted = new Set<string>();
  /** Approvals handed to the UI and awaiting a human, keyed by public id. */
  private readonly parkedApprovals = new Map<string, PendingApproval>();
  private readonly parkedInteractions = new Map<string, PendingInteraction>();
  /** Router keys currently parked, so the fast backstop stands down. */
  private readonly parkedKeys = new Set<string>();
  private readonly history: ServerRequestRecord[] = [];
  private readonly approvalTimeoutMs: number;
  private nextApprovalSeq = 0;
  private counts = {
    total: 0,
    declined: 0,
    cancelled: 0,
    unknown: 0,
    timedOut: 0,
    approvalsPresented: 0,
    approvalsApproved: 0,
    approvalsDenied: 0,
    approvalsExpired: 0,
    interactionsPresented: 0,
    interactionsAnswered: 0,
    interactionsExpired: 0,
  };

  constructor(options: ServerRequestRouterOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.responseTimeoutMs = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  }

  /** Approvals currently waiting on a human, for SSE rehydration. */
  getParkedApprovals(): readonly ApprovalRequest[] {
    return [...this.parkedApprovals.values()].map((entry) => entry.request);
  }

  getParkedInteractions(): readonly InteractionRequest[] {
    return [...this.parkedInteractions.values()].map((entry) => entry.request);
  }

  resolveInteraction(interactionId: string, answer: InteractionAnswer): boolean {
    const parked = this.parkedInteractions.get(interactionId);
    if (!parked) return false;
    const resolution: InteractionResolution =
      answer.action === "accept"
        ? "answered"
        : answer.action === "decline"
          ? "declined"
          : "cancelled";
    void this.settleInteraction(parked, answer, resolution);
    return true;
  }

  /**
   * Applies a user's answer.
   *
   * Returns false when the id is unknown — already answered, expired, or killed by
   * a restart. The caller should treat that as "the card is stale", not an error:
   * with a 5-minute window and a restartable child it is a normal race.
   */
  resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const parked = this.parkedApprovals.get(approvalId);
    if (!parked) return false;
    void this.settleApproval(parked, decision, "answered");
    return true;
  }

  /**
   * Drops every approval belonging to a dead generation.
   *
   * app-server has forgotten the request, so answering it is pointless — but the
   * UI still has a card on screen and the transcript needs to say what happened.
   */
  abandonGeneration(generation: EngineGeneration): void {
    for (const parked of [...this.parkedApprovals.values()]) {
      if (parked.generation !== generation) continue;
      void this.settleApproval(parked, "deny", "engine-restarted", { skipSend: true });
    }
    for (const parked of [...this.parkedInteractions.values()]) {
      if (parked.generation !== generation) continue;
      void this.settleInteraction(
        parked,
        { action: "cancel" },
        "engine-restarted",
        { skipSend: true },
      );
    }
  }

  /** Drops approvals for a thread whose session is going away. */
  abandonThread(threadId: string): void {
    for (const parked of [...this.parkedApprovals.values()]) {
      if (parked.request.threadId !== threadId) continue;
      void this.settleApproval(parked, "deny", "session-closed");
    }
    for (const parked of [...this.parkedInteractions.values()]) {
      if (parked.request.threadId !== threadId) continue;
      void this.settleInteraction(parked, { action: "cancel" }, "session-closed");
    }
  }

  getMetrics(): Readonly<typeof this.counts> & { pending: number; awaitingUser: number } {
    return {
      ...this.counts,
      pending: this.pending.size,
      awaitingUser: this.parkedApprovals.size + this.parkedInteractions.size,
    };
  }

  /** Bounded audit trail: id, method, timing and resolution — never payloads. */
  getHistory(): readonly ServerRequestRecord[] {
    return this.history;
  }

  getPending(): readonly ServerRequestRecord[] {
    return [...this.pending.values()];
  }

  /**
   * Entry point from the RPC read loop. Deliberately not awaited by the caller;
   * this schedules its own work and always answers.
   */
  handle(request: InboundServerRequest, generation: EngineGeneration): void {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const record: ServerRequestRecord = {
      id: request.id,
      method: request.method,
      generation,
      threadId: asString(params.threadId),
      turnId: asString(params.turnId),
      itemId: asString(params.itemId),
      receivedAt: this.now(),
    };

    const key = `${generation}:${String(request.id)}`;
    this.pending.set(key, record);
    this.counts.total += 1;

    const timer = setTimeout(() => {
      if (!this.pending.has(key)) return;
      // Parked on a human. The approval's own (much longer) timer owns the answer;
      // firing here would answer a request the user is still looking at.
      if (this.parkedKeys.has(key)) return;
      record.timedOut = true;
      this.counts.timedOut += 1;

      if (this.sendStarted.has(key)) {
        // A response is already on its way but the write has not completed —
        // typically a back-pressured stdin on a dying child. Sending a second
        // response down the same stuck pipe cannot help and would risk answering
        // twice, so record it for metrics and let the process exit clean up.
        console.error(
          `[codex-bridge] Response to ${record.method} has not flushed within ${this.responseTimeoutMs}ms`,
        );
        return;
      }

      // No branch even attempted a response. Should be unreachable, but an
      // unanswered request hangs the turn forever — answer defensively.
      void this.finish(key, record, "protocol-error", () =>
        this.options.respondWithError(
          generation,
          request.id,
          JSON_RPC_METHOD_NOT_FOUND,
          "Orkestrator did not produce a response in time",
        ),
      );
    }, this.responseTimeoutMs);
    timer.unref?.();

    void this.route(key, record, request, generation).finally(() => clearTimeout(timer));
  }

  private async route(
    key: string,
    record: ServerRequestRecord,
    request: InboundServerRequest,
    generation: EngineGeneration,
  ): Promise<void> {
    const method = request.method as ServerRequestMethod;

    // Interactive path first: if the UI takes ownership, none of the automatic
    // responses below should run. If it declines, we fall through to exactly the
    // behaviour that existed before approvals were wired up.
    if (isInteractiveApprovalMethod(method) && this.options.presentApproval) {
      if (this.tryPark(key, record, method, request, generation)) return;
    }
    if (
      (method === "item/tool/requestUserInput"
        || method === "mcpServer/elicitation/request")
      && this.options.presentInteraction
    ) {
      if (this.tryParkInteraction(key, record, method, request, generation)) return;
    }

    switch (method) {
      /**
       * Approvals. We run `approvalPolicy: "never"`, so one arriving means the
       * effective policy diverged from what we asked for. Declining is the safe
       * direction: it refuses the action rather than silently authorising a
       * command or patch the user never saw.
       */
      case "item/commandExecution/requestApproval":
        this.violation(method, "approval requested despite approvalPolicy=never");
        this.explain(record, "Codex asked to run a command that needs approval. Orkestrator declined it because interactive approval is not enabled.");
        return this.finish(key, record, "declined", () =>
          this.options.respond(generation, request.id, { decision: "decline" }),
        );

      case "item/fileChange/requestApproval":
        this.violation(method, "approval requested despite approvalPolicy=never");
        this.explain(record, "Codex asked to apply a file change that needs approval. Orkestrator declined it because interactive approval is not enabled.");
        return this.finish(key, record, "declined", () =>
          this.options.respond(generation, request.id, { decision: "decline" }),
        );

      /** Legacy approval paths, same reasoning; note the snake_case decision. */
      case "execCommandApproval":
      case "applyPatchApproval":
        this.violation(method, "legacy approval requested despite approvalPolicy=never");
        this.explain(record, "Codex requested approval through a legacy path. Orkestrator declined it because interactive approval is not enabled.");
        return this.finish(key, record, "declined", () =>
          this.options.respond(generation, request.id, {
            decision: { denied: { rejection: "Orkestrator does not support interactive approvals" } },
          }),
        );

      /**
       * Permissions escalation. There is no correct "decline" shape here — the
       * response requires a permission profile — so cancel with a protocol error
       * instead of inventing a grant.
       */
      case "item/permissions/requestApproval":
        this.violation(method, "permission escalation requested");
        this.explain(record, "Codex requested additional permissions. Orkestrator cannot grant them, so the request was cancelled.");
        return this.finish(key, record, "cancelled", () =>
          this.options.respondWithError(
            generation,
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            "Orkestrator does not support permission escalation requests",
          ),
        );

      /**
       * Interactive input that could not be parked — an unparseable question set,
       * or no tab attached to the thread to show it. Cancel promptly and say so;
       * leaving the turn hanging would look like a freeze.
       */
      case "item/tool/requestUserInput":
        this.explain(record, "Codex asked a question, but no Orkestrator tab was attached to answer it. The request was cancelled.");
        return this.finish(key, record, "cancelled", () =>
          this.options.respond(generation, request.id, { answers: {} }),
        );

      case "mcpServer/elicitation/request":
        /**
         * Reached whenever the request could not be parked: an elicitation `mode`
         * this build does not recognise, or no tab attached to the thread to show
         * it. We *do* advertise `mcpServerOpenaiFormElicitation: true`, so this is
         * an ordinary outcome, not a protocol violation — counting it as one
         * inflated the `protocol.serverRequests` figure operators watch for real
         * drift (served on the authenticated `/session/:id/runtime-health`; the
         * public `/global/health` payload stays stripped).
         */
        this.explain(record, "An MCP server asked for input, but no Orkestrator tab was attached to display it. The request was cancelled.");
        return this.finish(key, record, "cancelled", () =>
          this.options.respond(generation, request.id, {
            action: "cancel",
            content: null,
            _meta: null,
          }),
        );

      /** Dynamic tools would have to be executed by us; report failure, not silence. */
      case "item/tool/call":
        this.violation(method, "dynamic tool execution requested");
        this.explain(record, "Codex asked Orkestrator to execute a tool it does not provide. The call was reported as failed.");
        return this.finish(key, record, "unsupported", () =>
          this.options.respond(generation, request.id, {
            contentItems: [],
            success: false,
          }),
        );

      /**
       * Auth refresh: Codex owns its own credentials in our setup. Answering with
       * a fabricated token would be worse than an explicit error.
       */
      case "account/chatgptAuthTokens/refresh":
        this.violation(method, "auth token refresh requested");
        return this.finish(key, record, "unsupported", () =>
          this.options.respondWithError(
            generation,
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            "Orkestrator does not manage ChatGPT auth tokens",
          ),
        );

      /** We passed requestAttestation: false, so this should never arrive. */
      case "attestation/generate":
        this.violation(method, "attestation requested despite requestAttestation=false");
        return this.finish(key, record, "unsupported", () =>
          this.options.respondWithError(
            generation,
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            "Orkestrator did not opt into attestation",
          ),
        );

      default: {
        // A method the pinned protocol did not have: a newer app-server. Answer
        // with a protocol error and count it, rather than hanging the turn.
        assertNever(method);
        this.counts.unknown += 1;
        this.options.onUnknownRequest?.(request.method);
        return this.finish(key, record, "protocol-error", () =>
          this.options.respondWithError(
            generation,
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Unsupported server request: ${request.method}`,
          ),
        );
      }
    }
  }

  /**
   * Offers the request to the UI and parks it if the UI takes it.
   *
   * Returns false when nobody will answer, so the caller falls through to the
   * automatic response. A `presentApproval` that throws counts as "nobody will
   * answer": a broken renderer must not be able to hang a turn.
   */
  private tryPark(
    key: string,
    record: ServerRequestRecord,
    method: InteractiveApprovalMethod,
    request: InboundServerRequest,
    generation: EngineGeneration,
  ): boolean {
    this.nextApprovalSeq += 1;
    const requestedAt = this.now();
    const approval = describeApproval({
      // Scoped by generation so an id from a dead child can never be reused.
      approvalId: `apr-${generation}-${this.nextApprovalSeq}`,
      method,
      params: request.params,
      generation,
      requestedAt,
      expiresAt: requestedAt + this.approvalTimeoutMs,
    });

    let accepted = false;
    try {
      accepted = this.options.presentApproval?.(approval) === true;
    } catch (error) {
      console.error("[codex-bridge] presentApproval threw; falling back to auto-decline:", error);
      return false;
    }
    if (!accepted) return false;

    const timer = setTimeout(() => {
      const parked = this.parkedApprovals.get(approval.approvalId);
      if (!parked) return;
      this.counts.approvalsExpired += 1;
      record.timedOut = true;
      // Deny, never approve: an unanswered prompt must not authorise anything.
      void this.settleApproval(parked, "deny", "timed-out");
    }, this.approvalTimeoutMs);
    timer.unref?.();

    this.parkedApprovals.set(approval.approvalId, {
      key,
      record,
      request: approval,
      method,
      rawParams: request.params,
      generation,
      requestId: request.id,
      timer,
    });
    this.parkedKeys.add(key);
    this.counts.approvalsPresented += 1;
    return true;
  }

  /**
   * Answers a parked approval exactly once.
   *
   * `skipSend` is for a dead generation: app-server has already forgotten the
   * request, so there is nothing to answer — but the UI and the transcript still
   * need to be told, which is why this is not simply a delete.
   */
  private async settleApproval(
    parked: PendingApproval,
    decision: ApprovalDecision,
    resolution: ApprovalResolution,
    options: { skipSend?: boolean } = {},
  ): Promise<void> {
    // First writer wins, so a user click racing the expiry timer cannot answer twice.
    if (!this.parkedApprovals.delete(parked.request.approvalId)) return;
    clearTimeout(parked.timer);
    this.parkedKeys.delete(parked.key);

    const approved = decision === "approve" || decision === "approve-for-session";
    if (approved) this.counts.approvalsApproved += 1;
    else this.counts.approvalsDenied += 1;

    const explanation = describeApprovalOutcome(parked.request, decision, resolution);
    if (explanation) this.explain(parked.record, explanation);

    // Told before the write, so the card clears even if the write then fails.
    try {
      this.options.onApprovalResolved?.(parked.request, decision, resolution);
    } catch (error) {
      console.error("[codex-bridge] onApprovalResolved threw:", error);
    }

    if (options.skipSend) {
      // Retire the record without sending: the pending map is the audit trail.
      this.pending.delete(parked.key);
      this.sendStarted.delete(parked.key);
      parked.record.resolution = approved ? "user-approved" : "user-declined";
      parked.record.resolvedAt = this.now();
      this.pushHistory(parked.record);
      return;
    }

    const payload = buildApprovalResponse(parked.method, decision, parked.rawParams);
    await this.finish(
      parked.key,
      parked.record,
      approved ? "user-approved" : "user-declined",
      () => this.options.respond(parked.generation, parked.requestId, payload.result),
    );
  }

  private tryParkInteraction(
    key: string,
    record: ServerRequestRecord,
    method: InteractionMethod,
    request: InboundServerRequest,
    generation: EngineGeneration,
  ): boolean {
    const requestedAt = this.now();
    const interaction = describeInteraction({
      interactionId: `ask-${generation}-${String(request.id)}`,
      method,
      params: request.params,
      generation,
      requestedAt,
      defaultExpiresAt: requestedAt + this.approvalTimeoutMs,
    });
    if (!interaction) return false;

    let accepted = false;
    try {
      accepted = this.options.presentInteraction?.(interaction) === true;
    } catch (error) {
      console.error("[codex-bridge] presentInteraction threw; cancelling:", error);
      return false;
    }
    if (!accepted) return false;

    const timer = setTimeout(() => {
      const parked = this.parkedInteractions.get(interaction.interactionId);
      if (!parked) return;
      this.counts.interactionsExpired += 1;
      record.timedOut = true;
      void this.settleInteraction(
        parked,
        { action: "cancel" },
        "timed-out",
      );
    }, Math.max(1, interaction.expiresAt - requestedAt));
    timer.unref?.();

    this.parkedInteractions.set(interaction.interactionId, {
      key,
      record,
      request: interaction,
      generation,
      requestId: request.id,
      timer,
    });
    this.parkedKeys.add(key);
    this.counts.interactionsPresented += 1;
    return true;
  }

  private async settleInteraction(
    parked: PendingInteraction,
    answer: InteractionAnswer,
    resolution: InteractionResolution,
    options: { skipSend?: boolean } = {},
  ): Promise<void> {
    if (!this.parkedInteractions.delete(parked.request.interactionId)) return;
    clearTimeout(parked.timer);
    this.parkedKeys.delete(parked.key);
    if (resolution === "answered") this.counts.interactionsAnswered += 1;

    try {
      this.options.onInteractionResolved?.(parked.request, answer, resolution);
    } catch (error) {
      console.error("[codex-bridge] onInteractionResolved threw:", error);
    }

    if (options.skipSend) {
      this.pending.delete(parked.key);
      this.sendStarted.delete(parked.key);
      parked.record.resolution =
        resolution === "answered" ? "user-answered" : "cancelled";
      parked.record.resolvedAt = this.now();
      this.pushHistory(parked.record);
      return;
    }

    await this.finish(
      parked.key,
      parked.record,
      resolution === "answered" ? "user-answered" : "cancelled",
      () => this.options.respond(
        parked.generation,
        parked.requestId,
        buildInteractionResponse(parked.request, answer),
      ),
    );
  }

  private async finish(
    key: string,
    record: ServerRequestRecord,
    resolution: ServerRequestResolution,
    send: () => Promise<void>,
  ): Promise<void> {
    // `sendStarted` is the double-answer guard: it is set before the await, so a
    // concurrent timeout cannot also respond.
    if (!this.pending.has(key) || this.sendStarted.has(key)) return;
    this.sendStarted.add(key);

    record.resolution = resolution;
    record.resolvedAt = this.now();
    if (resolution === "declined") this.counts.declined += 1;
    if (resolution === "cancelled") this.counts.cancelled += 1;

    try {
      await send();
    } catch (error) {
      // The generation may have died mid-response; app-server has forgotten the
      // request either way.
      console.error(
        `[codex-bridge] Failed to answer server request ${record.method}:`,
        error instanceof Error ? error.message : error,
      );
    } finally {
      this.pending.delete(key);
      this.sendStarted.delete(key);
      this.pushHistory(record);
    }
  }

  private pushHistory(record: ServerRequestRecord): void {
    this.history.push(record);
    if (this.history.length > 200) this.history.shift();
  }

  private violation(method: string, detail: string): void {
    this.options.onInvariantViolation?.(method, detail);
    console.error(`[codex-bridge] app-server invariant violation (${method}): ${detail}`);
  }

  private explain(record: ServerRequestRecord, message: string): void {
    this.options.reportToTranscript?.({
      threadId: record.threadId,
      turnId: record.turnId,
      message,
    });
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Compile-time exhaustiveness. If a Codex upgrade adds a `ServerRequest` variant,
 * regenerating the protocol makes this fail to typecheck — which is the point:
 * an unhandled server request would hang a turn.
 */
function assertNever(value: never): void {
  void value;
}
