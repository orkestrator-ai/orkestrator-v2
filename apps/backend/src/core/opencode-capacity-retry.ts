/**
 * Continues an unattended OpenCode turn a provider overload ended.
 *
 * OpenCode retries an overload itself (5 attempts, about a minute), then ends
 * the turn with the failure on the assistant message and reads idle. An
 * interactive session gets its continuation from `NativeAgentTurnRecovery`,
 * which dispatches under a request id of its own. A workflow cannot use that:
 * its result tool, its read-only tool map and its result key all belong to the
 * dispatched request, and a turn under another id takes the grant away and reads
 * as this request having settled.
 *
 * So this runs inside the provider, where those belong, the way the Codex bridge
 * continues a refused turn: same request, same grant, same turn options. The
 * continuation's message id carries the request's own marker, so everything that
 * finds a request's answer by that marker (settlement, the terminal error, the
 * structured result) reads the newest attempt. While a retry is due the request
 * reads `turnSettled: false`, which every workflow owner waits on. Accepted or
 * ambiguously delivered continuations retain their exact message ID until their
 * own terminal answer appears. A stale refusal cannot spend another attempt.
 * A workflow's own status poll drives retries, so nothing is dispatched once
 * nobody is waiting on the turn.
 *
 * Only in memory: a backend restart during a wait loses the retry, and the turn
 * then fails with its refusal, as it did before.
 */
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { AgentInteractionOrigin } from "@orkestrator/protocol/agent-interactions";
import {
  DEFAULT_CAPACITY_RETRY_POLICY,
  capacityRetryDelayMs,
  namesLimitOrLogin,
  type CapacityRetryPolicy,
} from "@orkestrator/protocol/capacity-retry";
import {
  MAX_TRACKED_INTERACTION_SESSIONS,
  asRecord,
  isTransientHttpStatus,
  setBoundedMapEntry,
} from "./agent-provider-runtime.js";
import type {
  openCodeModelSelection,
  openCodeReasoningVariant,
} from "./opencode-provider-helpers.js";
import { OPENCODE_PROVIDER_ERROR_CONTINUATION } from "./opencode-turn-recovery.js";

/** Bounded read of a response body a gateway may have made arbitrarily long. */
const MAX_CLASSIFIED_TEXT = 16 * 1024;
const OVERLOAD_BODY =
  /overload|at capacity|capacity[ _-]?(?:unavailable|exceeded|reached)|model[ _-]?capacity/i;

/**
 * A retry nobody has looked at for this long is abandoned, so an outcome read
 * cannot be held open by a workflow that stopped polling without aborting.
 * Also bounds reconciliation of a continuation absent from the transcript,
 * measured from dispatch even when the workflow keeps polling.
 */
export const OPENCODE_CAPACITY_RETRY_ABANDON_MS = 5 * 60_000;

/**
 * Whether a failed assistant message's error is a provider overload.
 *
 * 503 and 529 are, and a 429 only when its body says so: every other 429 is a
 * rate limit. Whatever the status, an error naming a usage or rate limit, quota,
 * billing or a login never is. Only `APIError` qualifies, and nothing without a
 * status does.
 */
export function isOpenCodeCapacityError(error: unknown): boolean {
  const record = asRecord(error);
  if (record?.name !== "APIError") return false;
  const data = asRecord(record.data);
  const status = data?.statusCode;
  if (status !== 429 && status !== 503 && status !== 529) return false;
  const text = [data?.message, data?.responseBody]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .slice(0, MAX_CLASSIFIED_TEXT);
  if (namesLimitOrLogin(text)) return false;
  return status !== 429 || OVERLOAD_BODY.test(text);
}

/** Multi Review and build sessions; graph nodes run under the same origins. */
export function isUnattendedOpenCodeOrigin(origin: AgentInteractionOrigin): boolean {
  return origin === "build-pipeline" || origin === "automated-review";
}

/** What the turn's prompt asked for, resent on every attempt. Never the prompt itself. */
export interface OpenCodeContinuationRequest {
  /** Restore instance-scoped tools after a command reload. */
  prepare(): Promise<void>;
  /** Wraps the continuation the way the original prompt was wrapped. */
  shapeText(text: string): string;
  fields: {
    model: ReturnType<typeof openCodeModelSelection>;
    agent: string | undefined;
    variant: ReturnType<typeof openCodeReasoningVariant>;
    tools?: Record<string, boolean>;
    system?: string;
  };
}

interface CapacityRetryPlan {
  requestId: string;
  request: OpenCodeContinuationRequest;
  /** The attempt the turn is on, the original one being 1. */
  attempt: number;
  /** The dispatched continuation; old snapshots cannot answer it. */
  pending?: { messageId: string; sentAt: number };
  /** When the next attempt is due, once this one has been seen to fail. */
  retryAt?: number;
  /** When a workflow last found the refusal and left it waiting. */
  observedAt?: number;
}

export interface OpenCodeCapacityRetryDependencies {
  client: OpencodeClient;
  directory: string | undefined;
  requestOptions: () => { signal: AbortSignal };
  now: () => number;
  random?: () => number;
  policy?: Partial<CapacityRetryPolicy>;
  accepted: (sessionId: string, requestId: string) => void;
  nextMessageId: (
    sessionId: string,
    history: readonly unknown[],
    requestId: string,
    now: number,
  ) => string;
  /** The turn-start bookkeeping a dispatch does: the clock, change evidence. */
  beginAttempt: (sessionId: string, requestId: string, messageId: string) => Promise<number>;
  rejectAttempt: (sessionId: string, startedAt: number, ambiguous: boolean) => void;
}

export class OpenCodeCapacityRetry {
  private readonly plans = new Map<string, CapacityRetryPlan>();
  private readonly policy: CapacityRetryPolicy;

  constructor(private readonly deps: OpenCodeCapacityRetryDependencies) {
    this.policy = { ...DEFAULT_CAPACITY_RETRY_POLICY, ...deps.policy };
  }

  /** The prompt was accepted: this request may be continued. */
  arm(sessionId: string, requestId: string, request: OpenCodeContinuationRequest): void {
    setBoundedMapEntry(
      this.plans,
      sessionId,
      { requestId, request, attempt: 1 },
      MAX_TRACKED_INTERACTION_SESSIONS,
    );
  }

  /** Stop, close, a prompt with nothing to continue: no attempt may follow. */
  forget(sessionId: string): void {
    this.plans.delete(sessionId);
  }

  /** A retry is still going to answer this refusal, so it is not the turn's outcome yet. */
  willRetry(sessionId: string, requestId: string, error: unknown, parentId?: string): boolean {
    const plan = this.plans.get(sessionId);
    if (plan?.requestId !== requestId) return false;
    const now = this.deps.now();
    if (plan.pending && parentId !== plan.pending.messageId) {
      return now - plan.pending.sentAt <= OPENCODE_CAPACITY_RETRY_ABANDON_MS;
    }
    if (!isOpenCodeCapacityError(error) || plan.attempt >= this.policy.maxAttempts) return false;
    if (
      plan.observedAt === undefined ||
      now - plan.observedAt <= OPENCODE_CAPACITY_RETRY_ABANDON_MS
    ) {
      plan.observedAt = now;
      return true;
    }
    this.plans.delete(sessionId);
    return false;
  }

  /**
   * The request's newest answer failed. Answers whether the turn stays open:
   * `true` while a retry is due or was just sent. Called under the dispatch
   * lock, so a continuation cannot interleave with any other prompt.
   */
  async hold(
    sessionId: string,
    requestId: string,
    error: unknown,
    history: readonly unknown[],
  ): Promise<boolean> {
    const latest = asRecord(
      asRecord(
        history.findLast((message) => asRecord(asRecord(message)?.info)?.role === "assistant"),
      )?.info,
    );
    const parentId = typeof latest?.parentID === "string" ? latest.parentID : undefined;
    if (!this.willRetry(sessionId, requestId, error, parentId)) {
      this.plans.delete(sessionId);
      return false;
    }
    const plan = this.plans.get(sessionId)!;
    if (plan.pending && parentId !== plan.pending.messageId) return true;
    plan.pending = undefined;
    const now = this.deps.now();
    const nextAttempt = plan.attempt + 1;
    plan.retryAt ??= now + capacityRetryDelayMs(this.policy, nextAttempt, this.deps.random);
    if (now < plan.retryAt) return true;

    await plan.request.prepare();
    if (this.plans.get(sessionId) !== plan) return false;
    const messageID = this.deps.nextMessageId(sessionId, history, requestId, now);
    const startedAt = await this.deps.beginAttempt(sessionId, requestId, messageID);
    // Stop or a close may have arrived during that await.
    if (this.plans.get(sessionId) !== plan) {
      this.deps.rejectAttempt(sessionId, startedAt, false);
      return false;
    }
    plan.attempt = nextAttempt;
    plan.pending = { messageId: messageID, sentAt: now };
    plan.retryAt = undefined;
    plan.observedAt = undefined;
    let response;
    try {
      response = await this.deps.client.session.promptAsync(
        {
          sessionID: sessionId,
          directory: this.deps.directory,
          messageID,
          parts: [
            { type: "text", text: plan.request.shapeText(OPENCODE_PROVIDER_ERROR_CONTINUATION) },
          ],
          ...plan.request.fields,
        },
        this.deps.requestOptions(),
      );
    } catch {
      // A missing acknowledgement is unknown until this exact continuation
      // answers, cancellation arrives, or the bounded materialization wait ends.
      this.deps.rejectAttempt(sessionId, startedAt, true);
      return true;
    }
    if ("error" in response && response.error) {
      const status = response.response?.status;
      const ambiguous =
        status === undefined || status === 404 || status === 409 || isTransientHttpStatus(status);
      this.deps.rejectAttempt(sessionId, startedAt, ambiguous);
      if (ambiguous) return true;
      this.plans.delete(sessionId);
      return false;
    }
    this.deps.accepted(sessionId, requestId);
    return true;
  }
}
