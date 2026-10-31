/**
 * Automatic continuation of a native-agent turn that ended incomplete.
 *
 * The backend observes turn-end edges through its activity sweep and, for a
 * platform that supplies an {@link IncompleteTurnRecoveryStrategy}, inspects
 * the authoritative transcript and dispatches one bounded continuation prompt.
 * No mounted renderer is involved, which is what makes the recovery survive
 * closed tabs, inactive environments, and app restarts.
 *
 * A continuation must never race a prompt the user is sending by hand, so the
 * same collaborator owns the short-lived manual-prompt claims that suppress it.
 *
 * The service owns locks, storage, and dispatch; this module receives them as
 * narrow dependencies. What an incomplete turn looks like, and which prompt
 * continues it, is the platform strategy's business.
 */
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import {
  isAgentTurnEndTransition,
  isEnvironmentReadyForAgents,
  nativeAgentSessionStorageKey,
  nonBlank,
  type AgentActivityState,
  type AgentInteractionOrigin,
  type BuildPipelineAgent,
  type DispatchNativeAgentPromptInput,
  type EnsureNativeAgentSessionInput,
  type NativeAgentRuntimeProvider,
  type PersistedNativeAgentSession,
  type PromptDispatchPreparation,
  type StorageService,
} from "./native-agent-service-shared.js";
import { nativeAgentPlatformPolicy } from "./native-agent-platform-policy.js";

export const TURN_RECOVERY_RETRY_BASE_MS = 2_000;
export const TURN_RECOVERY_RETRY_CEILING_MS = 60_000;
export const TURN_RECOVERY_MAX_CANDIDATES = 1_024;
export const MANUAL_PROMPT_CLAIM_MS = 2 * 60_000;

/** What a strategy found at the end of an authoritative transcript. */
export interface IncompleteTurnRecovery {
  /** `exhausted` means recovery already ran and stalled again: leave it for the user. */
  action: "continue" | "exhausted";
  /**
   * `provider-error`: a provider API error ended the turn mid-flight.
   * `incomplete`: the turn ended without a usable final answer.
   */
  reason: "incomplete" | "provider-error";
  /** Earliest epoch ms a provider-error retry may be dispatched (backoff). */
  notBefore?: number;
  /** Stalled assistant message id; keys the durable dispatch request id. */
  assistantMessageId: string;
  /** Model of the stalled turn, when the transcript reports it. */
  modelId?: string;
  /** Execution agent of the stalled turn (`build`, `plan`, …). */
  agent?: string;
  /** Model variant/reasoning profile used by the stalled turn. */
  variant?: string;
}

/**
 * The platform-specific half of incomplete-turn recovery. A platform opts in
 * by registering one in `native-agent-platform-policy.ts`.
 */
export interface IncompleteTurnRecoveryStrategy {
  /**
   * Transcript messages read per inspection. A full page cannot prove where
   * the last manual prompt was, so the strategy is told the history may be
   * clipped.
   */
  readonly historyLimit: number;
  inspect(
    messages: readonly unknown[],
    options: { historyComplete: boolean; now: number },
  ): IncompleteTurnRecovery | null;
  /** The fixed continuation prompt for one detected recovery. */
  continuationPrompt(recovery: IncompleteTurnRecovery): string;
  /**
   * Durable dispatch identity for one stalled assistant message. Routing the
   * continuation through `dispatchNativeAgentPromptOnce` with this id makes the
   * whole recovery at-most-once per stall across sweeps and backend restarts.
   */
  requestId(recovery: IncompleteTurnRecovery): string;
}

export interface ManualPromptClaimInput {
  environmentId: string;
  agent: BuildPipelineAgent;
  logicalSessionKey: string;
  providerSessionId: string;
  requestId: string;
}

export interface NativeAgentTurnRecoveryDependencies {
  storage: Pick<
    StorageService,
    "getEnvironment" | "getNativeAgentSession" | "getPromptQueue" | "setIncompleteTurnNotice"
  >;
  now(): number;
  isStopped(): boolean;
  assertAcceptingWork(): void;
  /** Resolve a running provider without starting one. */
  observeProvider(
    input: EnsureNativeAgentSessionInput,
  ): Promise<NativeAgentRuntimeProvider | undefined>;
  /** The service's durable at-most-once dispatch, with a preparation run under its lock. */
  dispatchPrompt(
    input: DispatchNativeAgentPromptInput,
    prepare: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
  ): Promise<unknown>;
  /** Last provider-owned activity the service observed for a durable session. */
  observedActivity(
    key: string,
  ): { providerSessionId: string; state: AgentActivityState } | undefined;
  /** Test seam; production selects by platform in the policy registry. */
  strategyFor?(agent: BuildPipelineAgent): IncompleteTurnRecoveryStrategy | undefined;
}

type RecoveryCandidate = {
  providerSessionId: string;
  attempts: number;
  retryAt: number;
};

type RecoveryResult = "complete" | "retry" | { retryAt: number };

function platformLabel(agent: BuildPipelineAgent): string {
  return AGENT_PLATFORM_LABELS[agent] ?? agent;
}

export class NativeAgentTurnRecovery {
  /** In-flight incomplete-turn recoveries, coalesced per durable session. */
  private readonly tasks = new Map<string, Promise<void>>();
  /** Idle transcript candidates retained across transient recovery failures. */
  private readonly candidates = new Map<string, RecoveryCandidate>();
  /** Short-lived manual-send claims prevent stale automatic continuations. */
  private readonly manualPromptClaims = new Map<
    string,
    { providerSessionId: string; requestId: string; expiresAt: number }
  >();
  /** Final no-await handoff from recovery validation into provider dispatch. */
  private readonly recoveryDispatches = new Set<string>();

  constructor(private readonly deps: NativeAgentTurnRecoveryDependencies) {}

  private strategy(agent: BuildPipelineAgent): IncompleteTurnRecoveryStrategy | undefined {
    return this.deps.strategyFor
      ? this.deps.strategyFor(agent)
      : nativeAgentPlatformPolicy(agent).incompleteTurnRecovery;
  }

  /**
   * Whether a session takes part in recovery: its platform has a strategy and
   * it is interactive. Unattended workflows own their own turn lifecycle and
   * remain excluded: a continuation here runs under a request id of its own,
   * which would take the workflow's result tool away and read as its request
   * having settled. An overload there is `OpenCodeCapacityRetry`'s.
   */
  appliesTo(session: { agent: BuildPipelineAgent; origin?: AgentInteractionOrigin }): boolean {
    return (
      this.strategy(session.agent) !== undefined &&
      session.origin !== "build-pipeline" &&
      session.origin !== "automated-review"
    );
  }

  /** A retained candidate keeps its provider group from settling as idle. */
  hasCandidate(key: string): boolean {
    return this.candidates.has(key);
  }

  /** In-flight recovery passes, for shutdown to drain. */
  pendingTasks(): Promise<void>[] {
    return [...this.tasks.values()];
  }

  clear(): void {
    this.candidates.clear();
    this.manualPromptClaims.clear();
    this.recoveryDispatches.clear();
  }

  /**
   * Feed one applied activity observation.
   *
   * First-idle inspection is the restart/reconnect snapshot path. Later
   * candidates originate from exact turn-end edges, while a retained
   * candidate is retried after transient provider or storage failures.
   */
  noteActivity(
    session: PersistedNativeAgentSession,
    state: AgentActivityState,
    previous: AgentActivityState | undefined,
  ): void {
    if (!this.appliesTo(session) || state !== "idle") {
      this.candidates.delete(session.key);
      return;
    }
    if (previous === undefined || isAgentTurnEndTransition({ previousState: previous, state })) {
      this.markCandidate(session);
    }
    this.schedule(session);
  }

  async claimManualPrompt(input: ManualPromptClaimInput): Promise<void> {
    this.deps.assertAcceptingWork();
    const label = platformLabel(input.agent);
    if (
      !nonBlank(input.environmentId) ||
      !nonBlank(input.logicalSessionKey) ||
      !nonBlank(input.providerSessionId) ||
      !nonBlank(input.requestId)
    ) {
      throw new Error(`${label} manual prompt claim is invalid`);
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const existing = this.manualPromptClaims.get(key);
    if (this.recoveryDispatches.has(key)) {
      throw new Error(`${label} automatic recovery is already being sent`);
    }
    if (
      existing &&
      existing.expiresAt > this.deps.now() &&
      existing.requestId !== input.requestId
    ) {
      throw new Error(`Another ${label} prompt is already being sent`);
    }
    if (!existing && this.manualPromptClaims.size >= TURN_RECOVERY_MAX_CANDIDATES) {
      const oldest = this.manualPromptClaims.keys().next().value;
      if (oldest) this.manualPromptClaims.delete(oldest);
    }
    const claim = {
      providerSessionId: input.providerSessionId,
      requestId: input.requestId,
      expiresAt: this.deps.now() + MANUAL_PROMPT_CLAIM_MS,
    };
    // Publish before the first await so a recovery guard cannot pass while the
    // durable identity check is in flight.
    this.manualPromptClaims.set(key, claim);
    try {
      const durable = await this.deps.storage.getNativeAgentSession(key);
      if (durable?.providerSessionId !== input.providerSessionId) {
        throw new Error(`${label} manual prompt session no longer matches`);
      }
      // The user is explicitly replacing the stalled turn. Remove any older
      // automatic-recovery notice from the authoritative session snapshot so
      // it cannot reappear after a renderer remount.
      const cleared = await this.deps.storage.setIncompleteTurnNotice(
        key,
        input.providerSessionId,
        null,
      );
      if (!cleared) {
        throw new Error(`${label} manual prompt session no longer matches`);
      }
    } catch (error) {
      if (this.manualPromptClaims.get(key) === claim) {
        this.manualPromptClaims.delete(key);
      }
      throw error;
    }
  }

  releaseManualPrompt(input: ManualPromptClaimInput): void {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const claim = this.manualPromptClaims.get(key);
    if (
      claim?.providerSessionId === input.providerSessionId &&
      claim.requestId === input.requestId
    ) {
      this.manualPromptClaims.delete(key);
    }
  }

  private markCandidate(session: PersistedNativeAgentSession): void {
    const current = this.candidates.get(session.key);
    if (current?.providerSessionId === session.providerSessionId) return;
    if (!current && this.candidates.size >= TURN_RECOVERY_MAX_CANDIDATES) {
      const oldest = this.candidates.keys().next().value;
      if (oldest) this.candidates.delete(oldest);
    }
    this.candidates.set(session.key, {
      providerSessionId: session.providerSessionId,
      attempts: 0,
      retryAt: 0,
    });
  }

  private hasManualPromptClaim(session: PersistedNativeAgentSession): boolean {
    const claim = this.manualPromptClaims.get(session.key);
    if (!claim) return false;
    if (
      claim.providerSessionId !== session.providerSessionId ||
      claim.expiresAt <= this.deps.now()
    ) {
      this.manualPromptClaims.delete(session.key);
      return false;
    }
    return true;
  }

  private hasNewerActivity(session: PersistedNativeAgentSession): boolean {
    const observed = this.deps.observedActivity(session.key);
    return observed?.providerSessionId === session.providerSessionId && observed.state !== "idle";
  }

  /** Coalesce concurrent idle observations onto one recovery pass per session. */
  private schedule(session: PersistedNativeAgentSession): void {
    const candidate = this.candidates.get(session.key);
    const strategy = this.strategy(session.agent);
    if (
      !strategy ||
      this.deps.isStopped() ||
      this.tasks.has(session.key) ||
      candidate?.providerSessionId !== session.providerSessionId ||
      candidate.retryAt > this.deps.now()
    )
      return;
    const task = this.recoverOnce(session, strategy)
      .then((result) => {
        const latest = this.candidates.get(session.key);
        if (latest?.providerSessionId !== session.providerSessionId) return;
        if (result === "complete") {
          this.candidates.delete(session.key);
          return;
        }
        latest.retryAt =
          result === "retry" ? this.deps.now() + TURN_RECOVERY_RETRY_BASE_MS : result.retryAt;
      })
      .catch((error) => {
        const latest = this.candidates.get(session.key);
        if (latest?.providerSessionId === session.providerSessionId) {
          latest.attempts += 1;
          latest.retryAt =
            this.deps.now() +
            Math.min(
              TURN_RECOVERY_RETRY_CEILING_MS,
              TURN_RECOVERY_RETRY_BASE_MS * 2 ** Math.min(latest.attempts - 1, 8),
            );
        }
        console.warn(
          `[native-agent] ${platformLabel(session.agent)} incomplete-turn recovery for ${session.environmentId} failed:`,
          error instanceof Error ? error.name : "unknown error",
        );
      })
      .finally(() => {
        if (this.tasks.get(session.key) === task) {
          this.tasks.delete(session.key);
        }
      });
    this.tasks.set(session.key, task);
  }

  /**
   * Continue a turn that ended incomplete, at most once per stall.
   *
   * The authoritative transcript is both the detector and the loop bound: the
   * strategy must find the stalled shape, and reports `exhausted` when
   * recovery already ran and stalled again — that turn is left for the user.
   * A turn ended by a retryable provider error is continued the same way,
   * after a backoff and within a small retry budget. Dispatch itself goes
   * through the durable per-request-id journal, so a re-observed edge or a
   * backend restart cannot double-send.
   */
  private async recoverOnce(
    session: PersistedNativeAgentSession,
    strategy: IncompleteTurnRecoveryStrategy,
  ): Promise<RecoveryResult> {
    const { storage } = this.deps;
    const label = platformLabel(session.agent);
    if (this.deps.isStopped()) return "complete";
    const environment = await storage.getEnvironment(session.environmentId);
    if (
      !environment ||
      environment.deletionRequestedAt ||
      !isEnvironmentReadyForAgents(environment)
    ) {
      return "complete";
    }
    // The mapping may have been replaced since the sweep observed the edge; a
    // continuation must never reach a different provider session.
    const durable = await storage.getNativeAgentSession(session.key);
    if (durable?.providerSessionId !== session.providerSessionId) return "complete";

    const provider = await this.deps.observeProvider({
      environmentId: session.environmentId,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
    });
    if (!provider) return "retry";
    if (this.hasManualPromptClaim(session)) return "retry";
    const initialMessages = await provider.messages(session.providerSessionId, {
      limit: strategy.historyLimit,
    });
    if (this.deps.isStopped()) return "complete";
    const initialRecovery = strategy.inspect(initialMessages, {
      historyComplete: initialMessages.length < strategy.historyLimit,
      now: this.deps.now(),
    });
    if (!initialRecovery) return "complete";
    if (
      initialRecovery.action === "continue" &&
      initialRecovery.notBefore !== undefined &&
      initialRecovery.notBefore > this.deps.now()
    ) {
      return { retryAt: initialRecovery.notBefore };
    }
    const providerError = initialRecovery.reason === "provider-error";
    let disposition: "complete" | "retry" = "complete";
    let confirmedAssistantMessageId: string | undefined;
    try {
      await this.deps.dispatchPrompt(
        {
          environmentId: session.environmentId,
          agent: session.agent,
          logicalSessionKey: session.logicalSessionKey,
          origin: session.origin,
          interactionPolicy: session.interactionPolicy,
          prompt: strategy.continuationPrompt(initialRecovery),
          requestId: strategy.requestId(initialRecovery),
        },
        async (lockedSession, lockedProvider) => {
          if (this.deps.isStopped()) return { dispatch: false };
          if (this.hasManualPromptClaim(lockedSession) || this.hasNewerActivity(lockedSession)) {
            disposition = "retry";
            return { dispatch: false };
          }
          const queue = await storage.getPromptQueue(
            `${lockedSession.agent}\0${lockedSession.logicalSessionKey}`,
          );
          if (queue && (queue.messages.length > 0 || queue.inFlight !== undefined)) {
            disposition = "retry";
            return { dispatch: false };
          }
          const messages = await lockedProvider.messages(lockedSession.providerSessionId, {
            limit: strategy.historyLimit,
          });
          if (this.deps.isStopped()) return { dispatch: false };
          // Claims and queues may have appeared while the authoritative read was
          // in flight. This final check is inside the durable dispatch lock.
          if (this.hasManualPromptClaim(lockedSession) || this.hasNewerActivity(lockedSession)) {
            disposition = "retry";
            return { dispatch: false };
          }
          const latestQueue = await storage.getPromptQueue(
            `${lockedSession.agent}\0${lockedSession.logicalSessionKey}`,
          );
          if (this.hasManualPromptClaim(lockedSession) || this.hasNewerActivity(lockedSession)) {
            disposition = "retry";
            return { dispatch: false };
          }
          if (
            latestQueue &&
            (latestQueue.messages.length > 0 || latestQueue.inFlight !== undefined)
          ) {
            disposition = "retry";
            return { dispatch: false };
          }
          const recovery = strategy.inspect(messages, {
            historyComplete: messages.length < strategy.historyLimit,
            now: this.deps.now(),
          });
          if (!recovery) return { dispatch: false };
          if (recovery.assistantMessageId !== initialRecovery.assistantMessageId) {
            disposition = "retry";
            return { dispatch: false };
          }
          confirmedAssistantMessageId = recovery.assistantMessageId;
          if (recovery.action === "exhausted") {
            console.warn(
              providerError
                ? `[native-agent] ${label} turn for ${session.environmentId} failed with a provider error again after automatic retries; leaving it for the user`
                : `[native-agent] ${label} turn for ${session.environmentId} ended incomplete again after an automatic continuation; leaving it for the user`,
            );
            return {
              dispatch: false,
              notice: {
                kind: "exhausted",
                assistantMessageId: recovery.assistantMessageId,
                updatedAt: new Date(this.deps.now()).toISOString(),
              },
            };
          }
          console.warn(
            providerError
              ? `[native-agent] Retrying the ${label} turn that failed with a provider error for ${session.environmentId}`
              : `[native-agent] Continuing an incomplete ${label} turn for ${session.environmentId}`,
          );
          // Publish synchronously after the last awaited guard. A direct/manual
          // claim now fails until provider acceptance finishes, closing the
          // otherwise unavoidable check-to-send gap.
          this.recoveryDispatches.add(lockedSession.key);
          return {
            dispatch: true,
            model: recovery.modelId,
            effort: recovery.variant,
            executionAgent: recovery.agent,
          };
        },
      );
      return disposition;
    } catch (error) {
      if (confirmedAssistantMessageId) {
        await storage
          .setIncompleteTurnNotice(session.key, session.providerSessionId, {
            kind: "failed",
            assistantMessageId: confirmedAssistantMessageId,
            updatedAt: new Date(this.deps.now()).toISOString(),
          })
          .catch(() => false);
      }
      throw error;
    } finally {
      this.recoveryDispatches.delete(session.key);
    }
  }
}
