/**
 * Approval and interaction cards for the `AppServerRuntime` facade.
 *
 * The engine's server-request router owns each request's lifetime; this keeps
 * the session mapping it cannot compute, publishes the cards in order behind
 * the message flush, and applies the user's answers.
 */

import {
  isGrantingApprovalDecision,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResolution,
  type ApprovalResolvedDecision,
} from "./app-server/approvals.js";
import {
  isInteractionAnswerMap,
  type InteractionAnswer,
  type InteractionRequest,
  type InteractionResolution,
} from "./app-server/interactions.js";
import type { AgentInteractionHold } from "@orkestrator/protocol/agent-interactions";
import type { ParkedHoldOutcome } from "./app-server/server-request-router.js";
import { estimateOrderedEventBytes, isJsonObject } from "./app-server-runtime-base.js";
import type { CodexRuntimeContext } from "./app-server-runtime-context.js";
import type { CodexRuntimeLifecycle } from "./app-server-runtime-lifecycle.js";

/**
 * Outcome of a pause or resume request from a tab.
 *
 * `unknown` is the same "the card is stale" as an answer to a request that has
 * gone; `unavailable` is a deadline that cannot be extended (none at all, or
 * the provider's own limit already is the countdown).
 */
export type ParkedHoldResponse =
  | {
      status: "applied" | "unchanged";
      expiresAt: number;
      hold: AgentInteractionHold;
    }
  | { status: "unknown" }
  | { status: "wrong-session" }
  | { status: "unavailable" };

export class CodexRuntimeApprovals {
  constructor(
    private readonly ctx: CodexRuntimeContext,
    private readonly lifecycle: CodexRuntimeLifecycle,
  ) {}

  /**
   * Claims an approval on behalf of the UI and announces it.
   *
   * Returns false when the request cannot be routed to a session — with no
   * addressable session there is no card to click, so the router's auto-decline is
   * the honest outcome rather than parking a request nobody can see.
   *
   * Must stay synchronous: this runs on the path from the RPC read loop.
   */
  presentApproval(request: ApprovalRequest): boolean {
    const context = request.threadId ? this.ctx.registry.getThread(request.threadId) : undefined;
    const item = request.itemId ? context?.activeTurn?.items.get(request.itemId)?.item : undefined;
    const enriched =
      request.kind === "file-change" &&
      !request.changes?.length &&
      item?.type === "file_change" &&
      item.changes.length > 0
        ? {
            ...request,
            changes: item.changes.map((change) => ({
              path: change.path,
              kind: change.kind,
            })),
            actionable: true,
          }
        : request;
    const sessionIds = this.sessionIdsForApproval(enriched);
    if (sessionIds.length === 0) return false;

    this.ctx.pendingApprovals.set(enriched.approvalId, { request: enriched });
    // The call is parked on a person: a patch is still only a proposal and a
    // command has not run.
    const turn = context?.activeTurn;
    if (context && turn && item && (!request.turnId || request.turnId === turn.turnId)) {
      this.ctx.options.changeEvidence?.item(
        this.lifecycle.evidenceSource(context, turn),
        "awaiting-approval",
        item,
      );
    }
    const publish = () => {
      for (const sessionId of sessionIds) {
        this.ctx.options.emit({
          type: "session.approval-requested",
          sessionId,
          data: { approval: enriched },
        });
      }
    };
    if (enriched.threadId) {
      this.lifecycle.enqueueAfterMessageFlush(enriched.threadId, publish, {
        bytes: estimateOrderedEventBytes(enriched),
      });
    } else {
      publish();
    }
    return true;
  }

  onApprovalResolved(
    request: ApprovalRequest,
    decision: ApprovalResolvedDecision,
    resolution: ApprovalResolution,
  ): void {
    this.ctx.pendingApprovals.delete(request.approvalId);
    // Ownership follows the canonical thread, including tabs attached after the
    // request arrived.
    const sessionIds = this.sessionIdsForApproval(request);
    const publish = () => {
      for (const sessionId of sessionIds) {
        this.ctx.options.emit({
          type: "session.approval-resolved",
          sessionId,
          data: { approvalId: request.approvalId, decision, resolution },
        });
      }
    };
    if (request.threadId) {
      this.lifecycle.enqueueAfterMessageFlush(request.threadId, publish, {
        bytes: estimateOrderedEventBytes(request),
      });
    } else {
      publish();
    }
  }

  sessionIdsForApproval(request: ApprovalRequest): string[] {
    if (!request.threadId) return [];
    return this.ctx.registry.sessionsForThread(request.threadId).map((session) => session.id);
  }

  /** Pending approvals for one session, so a remounting UI can rehydrate. */
  listApprovals(sessionId: string): ApprovalRequest[] {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session?.threadId) return [];
    return [...this.ctx.pendingApprovals.values()]
      .filter((entry) => entry.request.threadId === session.threadId)
      .map((entry) => entry.request);
  }

  /**
   * Applies a user's answer.
   *
   * `unknown` covers already-answered, expired and withdrawn-by-restart alike —
   * all normal races over a five-minute window, and all meaning "the card is
   * stale" rather than "something went wrong".
   */
  respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    amendmentIndex?: number,
  ): "applied" | "unknown" | "wrong-session" | "not-actionable" {
    const entry = this.ctx.pendingApprovals.get(approvalId);
    if (!entry) return "unknown";
    // Scoped to the current canonical thread so unrelated tabs cannot answer,
    // while a tab attached after presentation can still take ownership.
    if (!this.sessionIdsForApproval(entry.request).includes(sessionId)) {
      return "wrong-session";
    }
    /**
     * Fail closed on the server too.
     *
     * The renderer hides Approve for a request the bridge could not describe,
     * but that is presentation. Anything that can reach this route — a stale
     * tab, another client, a cross-origin page — must not be able to approve an
     * action no human was ever shown.
     */
    if (!entry.request.actionable && isGrantingApprovalDecision(decision)) {
      return "not-actionable";
    }

    if (this.ctx.options.engine.resolveApproval(approvalId, decision, amendmentIndex)) {
      if (decision === "cancel") {
        void this.ctx.callbacks.abort(sessionId).catch((error: unknown) => {
          console.error("[codex-bridge] Failed to cancel turn after approval response:", error);
        });
      }
      return "applied";
    }

    // The router no longer has it but we do. There is no known path to this — the
    // router notifies before it forgets — so drop our copy rather than leave a card
    // that can never be answered.
    this.ctx.pendingApprovals.delete(approvalId);
    return "unknown";
  }

  /**
   * Pauses or resumes a parked approval's countdown for the tab that owns it.
   *
   * Never answers the request, and never touches liveness: the router re-arms
   * the same deny-at-expiry timer. The mirror served by `listApprovals` takes
   * the moved deadline at once, since the backend reads that route rather than
   * an SSE frame.
   */
  holdApproval(sessionId: string, approvalId: string, held: boolean): ParkedHoldResponse {
    const entry = this.ctx.pendingApprovals.get(approvalId);
    if (!entry) return { status: "unknown" };
    if (!this.sessionIdsForApproval(entry.request).includes(sessionId)) {
      return { status: "wrong-session" };
    }
    const outcome = this.ctx.options.engine.holdApproval(approvalId, held);
    return this.applyHold(this.ctx.pendingApprovals, approvalId, entry, outcome);
  }

  /** Same contract as `holdApproval`. */
  holdInteraction(sessionId: string, interactionId: string, held: boolean): ParkedHoldResponse {
    const entry = this.ctx.pendingInteractions.get(interactionId);
    if (!entry) return { status: "unknown" };
    if (!this.ctx.sessionIdsForThread(entry.request.threadId).includes(sessionId)) {
      return { status: "wrong-session" };
    }
    const outcome = this.ctx.options.engine.holdInteraction(interactionId, held);
    return this.applyHold(this.ctx.pendingInteractions, interactionId, entry, outcome);
  }

  private applyHold<T extends ApprovalRequest | InteractionRequest>(
    mirror: Map<string, { request: T }>,
    id: string,
    entry: { request: T },
    outcome: ParkedHoldOutcome,
  ): ParkedHoldResponse {
    if (outcome.status === "stale") {
      // As for an answer: a card the router no longer holds open (gone, or from
      // a dead generation) must not stay in the rehydration snapshot.
      mirror.delete(id);
      return { status: "unknown" };
    }
    if (outcome.status === "unavailable") return outcome;
    // A fresh object, never a mutation: an emitted SSE frame may still hold the old one.
    entry.request = { ...entry.request, expiresAt: outcome.expiresAt, hold: outcome.hold };
    return outcome;
  }

  presentInteraction(request: InteractionRequest): boolean {
    const sessionIds = this.ctx.sessionIdsForThread(request.threadId);
    if (sessionIds.length === 0) return false;
    this.ctx.pendingInteractions.set(request.interactionId, { request });
    this.lifecycle.enqueueAfterMessageFlush(
      request.threadId,
      () => {
        for (const sessionId of sessionIds) {
          this.ctx.options.emit({
            type: "session.interaction-requested",
            sessionId,
            data: { interaction: request },
          });
        }
      },
      { bytes: estimateOrderedEventBytes(request) },
    );
    return true;
  }

  onInteractionResolved(
    request: InteractionRequest,
    answer: InteractionAnswer,
    resolution: InteractionResolution,
  ): void {
    this.ctx.pendingInteractions.delete(request.interactionId);
    this.lifecycle.enqueueAfterMessageFlush(
      request.threadId,
      () => {
        for (const sessionId of this.ctx.sessionIdsForThread(request.threadId)) {
          this.ctx.options.emit({
            type: "session.interaction-resolved",
            sessionId,
            data: { interactionId: request.interactionId, action: answer.action, resolution },
          });
        }
      },
      { bytes: estimateOrderedEventBytes(request) },
    );
  }

  listInteractions(sessionId: string): InteractionRequest[] {
    const session = this.ctx.registry.getSession(sessionId);
    if (!session?.threadId) return [];
    return [...this.ctx.pendingInteractions.values()]
      .filter((entry) => entry.request.threadId === session.threadId)
      .map((entry) => entry.request);
  }

  respondToInteraction(
    sessionId: string,
    interactionId: string,
    answer: InteractionAnswer,
  ): "applied" | "unknown" | "wrong-session" | "invalid" {
    const entry = this.ctx.pendingInteractions.get(interactionId);
    if (!entry) return "unknown";
    if (!this.ctx.sessionIdsForThread(entry.request.threadId).includes(sessionId)) {
      return "wrong-session";
    }
    /**
     * Shape first, semantics second.
     *
     * The route validates too, but this is reachable from any caller, and the
     * per-question checks below invoke `.some()` on client-supplied values. A
     * non-array value there throws a `TypeError` rather than returning
     * `invalid`, which the route would report as a 500 while leaving the card
     * parked until its auto-cancel.
     */
    if (
      answer.action === "accept" &&
      answer.answers !== undefined &&
      !isInteractionAnswerMap(answer.answers)
    ) {
      return "invalid";
    }

    if (entry.request.kind === "question" && answer.action === "accept") {
      const expectedIds = new Set(entry.request.questions?.map((question) => question.id));
      const provided = answer.answers;
      if (
        !provided ||
        [...expectedIds].some((id) => provided[id] === undefined) ||
        Object.keys(provided).some((id) => !expectedIds.has(id))
      ) {
        return "invalid";
      }
    }
    /**
     * MCP elicitation content.
     *
     * `form` (and `openai/form`) answers a schema, so an accept without a JSON
     * object is meaningless. `url` has no form to fill — the user follows a link
     * and comes back — so an accept may legitimately carry nothing, but if it
     * does carry something it must still be a JSON object. Neither kind may pass
     * an arbitrary scalar or array straight through to the MCP server.
     */
    if (answer.action === "accept" && entry.request.kind === "mcp-form") {
      if (!isJsonObject(answer.content)) return "invalid";
    }
    if (answer.action === "accept" && entry.request.kind === "mcp-url") {
      if (
        answer.content !== undefined &&
        answer.content !== null &&
        !isJsonObject(answer.content)
      ) {
        return "invalid";
      }
    }

    if (this.ctx.options.engine.resolveInteraction(interactionId, answer)) return "applied";

    // The router no longer has it but we do. Mirrors the approval path: drop our
    // copy rather than leave `listInteractions` serving a card no client can
    // ever resolve.
    this.ctx.pendingInteractions.delete(interactionId);
    return "unknown";
  }
}
