import { asRecord } from "./agent-provider-runtime.js";
import { isValidTimeZone } from "@orkestrator/protocol/schedule-time";
import type {
  NativeAgentControlUpdate,
  NativeAgentDispatchOutcome,
  NativeAgentSessionAction,
  NativeAgentSessionActionOutcome,
  Environment,
  PersistedNativeAgentSession,
  PersistedNativeAgentPendingDispatch,
  StorageService,
  NativeAgentRuntimeProvider,
  CommandInvoker,
  EnsureNativeAgentSessionInput,
  DispatchNativeAgentPromptInput,
  NativeAgentProjectionInput,
  NativeAgentServiceOptions,
  PromptDispatchPreparation,
  PersistedNativeAgentPendingSteer,
} from "./native-agent-service-shared.js";
import {
  nativeAgentSessionStorageKey,
  compactInstructionsRefusal,
  nativeCapabilities,
  nonBlank,
  readProviderStatus,
  AmbiguousPromptDispatchError,
  PARKED_DISPATCH_CONFLICT_MESSAGE,
  isTransientDispatchRefusal,
  PendingNativeAgentDispatchError,
  PendingNativeAgentSteerError,
  createHash,
  ProviderUnavailableError,
} from "./native-agent-service-shared.js";
import {
  stripCoordinatorContext,
  coordinatorConversationIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  insertUserCommandContext,
  leadingUserCommandContext,
} from "@orkestrator/protocol/user-commands";
import {
  nativeAgentSteerRejectionMessage,
  dispatchOutcomeLostMessage,
  nativeAsyncQuestionItemId,
  resolveNativeAgentApprovalMode,
  nativeAgentCapabilities,
  type NativeAgentCommandIntent,
} from "@orkestrator/protocol/native-agent";
import { bugReportIdFromRuntimeId } from "@orkestrator/protocol/bug-report";
import { nativeAgentObservationGroupKey } from "./native-agent-observation.js";
import { deliverMissedSteer } from "./native-agent-missed-steer.js";
import { randomUUID } from "node:crypto";
import { PromptRejectedError } from "./agent-provider-contract.js";
import { sessionTakesAgentTools } from "./native-agent-opencode-server.js";
import { claudeReasoningSelection } from "@orkestrator/protocol/claude-model-catalog";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import { unsupportedCommandCatalogueState } from "@orkestrator/protocol/agent-command-catalogue";
import {
  isProjectHomeEnvironment,
  reconcileProjectHomeEnvironment,
} from "./project-home-environment.js";
import { isGeneratedEnvironmentName } from "./environment-name.js";
import { parseGoalCarrier } from "@orkestrator/protocol/native-agent-goal";
import { GoalCommandError } from "./native-agent-goal-service.js";
import { withSessionActionSlashCommands } from "@orkestrator/protocol/agent-slash-commands";
import {
  parseSuborkRequestCarrier,
  renderSuborkRequestCarrier,
} from "@orkestrator/protocol/suborks";
import {
  commandDispatchNeedsCatalogue,
  planCommandDispatch,
  type CommandDispatchPlan,
} from "./native-agent-command-dispatch.js";
import { beginChangeTrackingTurn } from "./native-agent-change-tracking.js";
import {
  pendingHandoffCommandRefusal,
  coordinatorPromptWithAttachmentPaths,
  promptWithPendingAgentHandoff,
} from "./native-agent-handoffs.js";
import { beginArtifactDispatchTurn } from "./workflow-artifact-turns.js";
import type { NativeAgentCatalogCache } from "./native-agent-catalog-cache.js";
import type {
  NativeAgentTranscriptProjection,
  ResolvedProjectionSession,
} from "./native-agent-transcript-projection.js";
import type {
  NativeAgentPromptQueueDispatcher,
  NativeAgentPromptQueueDispatcherHost,
} from "./native-agent-prompt-queue-dispatcher.js";
import type { NativeAgentObservationBroker } from "./native-agent-observation.js";
import type { NativeAgentLaunchActivityReconciler } from "./native-agent-launch-activity-reconciler.js";
import type { ProviderRegistry } from "./native-agent-provider-registry.js";
import type { NativeAgentTurnRecovery } from "./native-agent-turn-recovery.js";
import type { NativeAgentGoalService } from "./native-agent-goal-service.js";
import type { NativeAgentHandoffs } from "./native-agent-handoffs.js";
import type { NativeAgentSignInResends } from "./native-agent-sign-in-resend.js";
import type { EnsuredNativeAgentSession } from "./native-agent-service.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("native-agent");

/**
 * The tab's pending teardown refuses new work: closing a tab must not race a
 * prompt still being admitted to it.
 */
export function hasPendingTabTeardown(
  environment: Environment | null,
  logicalSessionKey: string,
): boolean {
  return Object.keys(environment?.tabTeardownIntents ?? {}).some(
    (tabId) => logicalSessionKey === `env-${environment!.id}:${tabId}`,
  );
}

/** What prompt dispatch needs from the service that wires it. */
export interface NativeAgentPromptDispatchHost {
  storage: StorageService;
  invoke: CommandInvoker;
  options: NativeAgentServiceOptions;
  /** Admits each prompt against a replacement or move of its environment. */
  environmentFence: NonNullable<NativeAgentServiceOptions["environmentFence"]>;
  catalogs: Pick<NativeAgentCatalogCache, "readCommandsForDispatch">;
  projections: Pick<
    NativeAgentTranscriptProjection,
    "invalidateProjection" | "refreshProjectionState"
  >;
  /** The session mutation intent, mutation fence and work fence are taken here. */
  promptQueues: Pick<
    NativeAgentPromptQueueDispatcher,
    | "scheduleAmbiguousSteerSettle"
    | "withSessionMutationFence"
    | "withSessionMutationIntent"
    | "withSessionWorkFence"
  >;
  observations: Pick<NativeAgentObservationBroker, "beginDispatch" | "recordDispatchAccepted">;
  launches: Pick<NativeAgentLaunchActivityReconciler, "recordObservedActivity">;
  providerRegistry: Pick<ProviderRegistry, "beginDispatch" | "endDispatch">;
  turnRecovery: Pick<
    NativeAgentTurnRecovery,
    "appliesTo" | "claimManualPrompt" | "releaseManualPrompt"
  >;
  goals: Pick<NativeAgentGoalService, "command">;
  handoffs: Pick<NativeAgentHandoffs, "markConsumed" | "pending">;
  signInResends: Pick<NativeAgentSignInResends, "remember">;
  now(): number;
  assertAcceptingWork(): void;
  assertEnvironmentLive(environmentId: string): Promise<Environment>;
  assertProjectionInput(input: NativeAgentProjectionInput): void;
  /** Reserve the bridge against a replacement; returns its release. */
  beginBridgeWork(input: NativeAgentProjectionInput): () => void;
  /** Resolve coordinator authority from persisted ownership, never caller metadata. */
  trustedSessionInput<T extends EnsureNativeAgentSessionInput>(input: T): Promise<T>;
  ensureSession(input: EnsureNativeAgentSessionInput): Promise<EnsuredNativeAgentSession>;
  /** Resolve a provider, starting its bridge if needed. */
  provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider>;
  resolveProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<ResolvedProjectionSession | null>;
  applySessionHeldDispatchModel(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
  ): Promise<NativeAgentControlUpdate | undefined>;
  sessionTurnIsBusy(input: NativeAgentProjectionInput): boolean;
  recordObservedTurnOutcome: NativeAgentPromptQueueDispatcherHost["recordObservedTurnOutcome"];
  settleArtifactTurn(
    session: Pick<PersistedNativeAgentSession, "environmentId" | "logicalSessionKey">,
    requestId: string,
  ): void;
  tabMailFor(
    durable: PersistedNativeAgentSession,
  ): Promise<{ environmentId: string; tabId: string } | undefined>;
  notifyPromptQueueChanged(queueKey: string): void;
}

/**
 * Prompt dispatch for native sessions: the intent path and its bounded
 * recovery retry, the at-most-once prompt path (`dispatchAdmittedPrompt`), the
 * parked-dispatch and parked-steer settles, retry and discard, and steer.
 *
 * Fence and lease order lives here and nowhere else. A prompt takes, in this
 * order: the bridge reservation, the environment agent-work fence, the
 * session mutation intent (intent path) or mutation fence (internal path) on
 * `NativeAgentPromptQueueDispatcher`, the storage lease
 * (`dispatchNativeAgentPromptOnce`, held across provider I/O) and, inside it,
 * the observation dispatch fence. A steer takes the mutation fence around
 * `dispatchNativeAgentSteerOnce`. Stop (`NativeAgentSessionOperations`) takes
 * the same dispatcher fences in the same order; the fence state itself lives
 * on the dispatcher, so neither class holds any.
 *
 * Mail injection (`NativeAgentMailInjection`) reaches dispatch only through
 * `dispatchPromptInternal`, `dispatchPersistedSteer` and the settles, so it
 * never takes a fence or lease of its own.
 *
 * It owns no state.
 */
export class NativeAgentPromptDispatch {
  constructor(private readonly host: NativeAgentPromptDispatchHost) {}

  async dispatchIntent(input: DispatchNativeAgentPromptInput): Promise<NativeAgentDispatchOutcome> {
    return this.dispatchIntentInternal(input, false);
  }

  /**
   * Whether an existing tab's session can take another prompt, for a caller
   * choosing between that tab and a new one. `busy` means the prompt has to wait
   * in the durable queue. `unavailable` means it would not run there: no session,
   * a tab being closed, a parked dispatch or queue, or a failed provider session
   * (the queue parks a prompt behind a terminal error rather than sending it).
   * Never creates a session; a read that fails answers `unavailable`.
   */
  async promptReadiness(
    input: NativeAgentProjectionInput,
  ): Promise<"idle" | "busy" | "unavailable"> {
    try {
      const environment = await this.host.storage.getEnvironment(input.environmentId);
      if (hasPendingTabTeardown(environment, input.logicalSessionKey)) return "unavailable";
      const resolved = await this.host.resolveProjectionSession(input);
      if (!resolved) return "unavailable";
      const { provider } = resolved;
      let { session } = resolved;
      if (session.pendingDispatch)
        await this.settleAmbiguousDispatch(
          input,
          session.key,
          session.pendingDispatch.requestId,
          provider,
        );
      if (session.pendingSteer)
        await this.settleAmbiguousSteer(
          input,
          session.key,
          session.pendingSteer.requestId,
          provider,
        );
      if (session.pendingDispatch || session.pendingSteer)
        session = (await this.host.storage.getNativeAgentSession(session.key)) ?? session;
      if (session.pendingDispatch || session.pendingSteer) return "unavailable";
      const queue = await this.host.storage.getPromptQueue(
        `${input.agent}\0${input.logicalSessionKey}`,
      );
      if (queue?.dispatchError) return "unavailable";
      const { status, contextUsage } = await readProviderStatus(
        provider,
        session.providerSessionId,
      );
      await this.host.recordObservedTurnOutcome(
        session,
        status,
        undefined,
        provider,
        undefined,
        contextUsage,
      );
      if (status === "running" || status === "blocked") return "busy";
      if (status !== "idle") return "unavailable";
      // Sending past a backlog would overtake prompts the user queued first.
      return queue &&
        (queue.outstandingClaim !== undefined ||
          queue.inFlight !== undefined ||
          queue.messages.length > 0)
        ? "busy"
        : "idle";
    } catch {
      return "unavailable";
    }
  }
  private async dispatchIntentInternal(
    input: DispatchNativeAgentPromptInput,
    preserveExistingPending: boolean,
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
  ): Promise<NativeAgentDispatchOutcome> {
    let release: () => void;
    try {
      // Reserve before identity/session reads: a close must see even a prompt
      // whose asynchronous preflight has not reached provider dispatch yet.
      const releaseBridge = this.host.beginBridgeWork(input);
      try {
        const releaseEnvironment = this.host.environmentFence.beginAgentWork(input.environmentId);
        release = () => {
          releaseEnvironment();
          releaseBridge();
        };
      } catch (error) {
        releaseBridge();
        throw error;
      }
    } catch (error) {
      return { outcome: "rejected", error: error instanceof Error ? error.message : String(error) };
    }
    try {
      if (
        hasPendingTabTeardown(
          await this.host.storage.getEnvironment(input.environmentId),
          input.logicalSessionKey,
        )
      )
        return {
          outcome: "rejected",
          error: "This tab has pending teardown; finish closing it before sending more work",
        };
      return await this.host.promptQueues.withSessionMutationIntent(input, () =>
        this.dispatchIntentUnderIntent(input, preserveExistingPending, prepare),
      );
    } finally {
      release();
    }
  }

  private async dispatchIntentUnderIntent(
    input: DispatchNativeAgentPromptInput,
    preserveExistingPending: boolean,
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
  ): Promise<NativeAgentDispatchOutcome> {
    input = await this.host.trustedSessionInput(input);
    // A manual prompt to a session with automatic turn recovery claims it
    // first, so a stale automatic continuation cannot be sent alongside.
    let manualClaimSession: PersistedNativeAgentSession | null = null;
    try {
      if (this.host.turnRecovery.appliesTo(input)) {
        const ensured = await this.host.ensureSession(input);
        manualClaimSession = ensured;
        // Creating the session here replaced the model this prompt names (a new
        // OpenCode session); the later ensure finds it existing and cannot say so.
        const substitution = ensured.modelSubstitution;
        if (substitution && substitution.requestedModelId === input.model) {
          input = { ...input, model: substitution.modelId };
        }
        await this.host.turnRecovery.claimManualPrompt({
          environmentId: input.environmentId,
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualClaimSession.providerSessionId,
          requestId: input.requestId,
        });
      }
      return await this.attemptDispatch(input, true, preserveExistingPending, prepare);
    } catch (error) {
      // Everything before the first dispatch attempt: session creation, the
      // manual-prompt claim. A normal send has no earlier record to preserve;
      // an explicit recovery retry does, and must leave it parked on failure.
      const cleared = !preserveExistingPending && (await this.clearRefusedDispatch(input));
      const transient = cleared && isTransientDispatchRefusal(error);
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Prompt dispatch failed",
        ...(transient ? { transient: true as const } : {}),
      };
    } finally {
      if (manualClaimSession) {
        this.host.turnRecovery.releaseManualPrompt({
          environmentId: input.environmentId,
          agent: input.agent,
          logicalSessionKey: input.logicalSessionKey,
          providerSessionId: manualClaimSession.providerSessionId,
          requestId: input.requestId,
        });
      }
    }
  }

  /**
   * One dispatch attempt, plus a single bounded retry once a stale block has
   * been cleared.
   *
   * `allowRecoveryRetry` is what bounds it. A prompt refused because an earlier
   * dispatch is still parked can legitimately proceed the moment that parked
   * record is settled against the provider — but only once, so a session that
   * keeps re-parking cannot drive an unbounded dispatch loop.
   */
  private async attemptDispatch(
    input: DispatchNativeAgentPromptInput,
    allowRecoveryRetry: boolean,
    preserveExistingPending: boolean,
    /** An admission check under the dispatch fence; refusing it sends nothing. */
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
  ): Promise<NativeAgentDispatchOutcome> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    try {
      let instructionsIgnored = false;
      await this.dispatchPromptInternal(input, prepare, true, false, false, () => {
        instructionsIgnored = true;
      });
      void this.host.projections.refreshProjectionState(input).catch(() => undefined);
      return {
        outcome: "accepted",
        requestId: input.requestId,
        ...(instructionsIgnored ? { instructionsIgnored: true } : {}),
      };
    } catch (error) {
      if (error instanceof PendingNativeAgentDispatchError) {
        // The only thing refusing this prompt is an older dispatch nobody has
        // resolved. If the provider can prove that one landed, or that it never
        // will (retired), the block was stale and this prompt was never in
        // conflict with anything. The same holds when the record is already
        // gone: a projection read settles parked dispatches in the background,
        // and one that confirmed it between this refusal and the settle here
        // leaves this settle nothing to clear.
        if (
          allowRecoveryRetry &&
          ((await this.settleAmbiguousDispatch(input, key, error.pendingRequestId)) ||
            (await this.parkedDispatchReleased(key, error.pendingRequestId)))
        ) {
          return this.attemptDispatch(input, false, preserveExistingPending, prepare);
        }
        void this.host.projections.refreshProjectionState(input).catch(() => undefined);
        return { outcome: "rejected", error: PARKED_DISPATCH_CONFLICT_MESSAGE };
      }
      if (error instanceof PendingNativeAgentSteerError) {
        if (
          allowRecoveryRetry &&
          (await this.settleAmbiguousSteer(input, key, error.pendingRequestId))
        ) {
          return this.attemptDispatch(input, false, preserveExistingPending, prepare);
        }
        void this.host.projections.refreshProjectionState(input).catch(() => undefined);
        return { outcome: "rejected", error: PARKED_DISPATCH_CONFLICT_MESSAGE };
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        // Ask the provider before handing the ambiguity to the user. A lost
        // acknowledgement is not the same fact as a lost prompt, and the
        // provider's own dispatch journal can usually tell the two apart.
        const settled = await this.settleAmbiguousDispatch(input, key, input.requestId);
        if (settled === "confirmed") {
          void this.host.projections.refreshProjectionState(input).catch(() => undefined);
          return { outcome: "accepted", requestId: input.requestId };
        }
        if (settled === "retired") {
          // The bridge restarted under this very request and will refuse the
          // id for good: the same answer a retry would get, without the card.
          void this.host.projections.refreshProjectionState(input).catch(() => undefined);
          return {
            outcome: "rejected",
            error: dispatchOutcomeLostMessage(input.agent),
            requestIdRetired: true,
          };
        }
        void this.host.projections.refreshProjectionState(input).catch(() => undefined);
        return {
          outcome: "unknown",
          requestId: input.requestId,
          error: error.message,
        };
      }
      // A retry of an id the bridge has retired can never succeed, so the
      // parked record is resolved here too rather than left asking for one.
      const retired = error instanceof PromptRejectedError && error.requestIdRetired;
      const cleared =
        !preserveExistingPending || retired ? await this.clearRefusedDispatch(input) : false;
      if (retired) void this.host.projections.refreshProjectionState(input).catch(() => undefined);
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Prompt dispatch failed",
        ...(retired ? { requestIdRetired: true as const } : {}),
        // Nothing was sent and no record stays parked: a new id may succeed.
        ...(!preserveExistingPending && cleared && isTransientDispatchRefusal(error)
          ? { transient: true as const }
          : {}),
      };
    }
  }

  /** Reacquire the session fence before certifying cleanup; unreadable state is not retryable. */
  private async clearRefusedDispatch(input: DispatchNativeAgentPromptInput): Promise<boolean> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    try {
      return await this.host.promptQueues.withSessionWorkFence(input, async () => {
        await this.host.storage.clearPendingNativeAgentDispatch(key, input.requestId);
        const session = await this.host.storage.getNativeAgentSession(key);
        return !session?.pendingDispatch && !session?.pendingSteer;
      });
    } catch {
      return false;
    }
  }

  /**
   * Discard a parked dispatch without sending it.
   *
   * The other half of the recovery choice: retrying re-offers the prompt under
   * the same idempotency key, discarding accepts that it may have run and stops
   * blocking the session. Deliberately requires the exact request id the caller
   * was shown, so a stale tab cannot drop a newer parked dispatch it never saw.
   */
  async discardRecoverableDispatch(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<{ discarded: boolean }> {
    this.host.assertProjectionInput(input);
    if (!nonBlank(input.requestId)) {
      throw new Error("Recoverable native agent request ID must not be blank");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.host.storage.getNativeAgentSession(key);
    const discarded =
      session?.pendingSteer?.requestId === input.requestId
        ? await this.host.storage.clearPendingNativeAgentSteer(key, input.requestId, true)
        : await this.host.storage.clearPendingNativeAgentDispatch(key, input.requestId);
    if (discarded) {
      void this.host.projections.refreshProjectionState(input).catch(() => undefined);
    }
    return { discarded };
  }

  /**
   * Settle a parked dispatch against the provider's own journal.
   *
   * A dispatch becomes recoverable because Orkestrator lost the answer, not
   * because the provider lost the prompt — and every bridge keeps a durable
   * record keyed by the same request id. Asking it turns the common case (the
   * turn is running; only the acknowledgement went missing) back into a plain
   * accepted dispatch, instead of a banner the user has to act on.
   *
   * Read-only and strictly one-directional: it can only ever *clear* a pending
   * record, and only on an explicit answer. `dispatched` confirms it
   * (`confirmed`). `lost` means the provider recorded the id in an earlier
   * process and will refuse it for good, so a retry could only report that:
   * the record is retired instead (`retired`), with a content-free marker the
   * projection carries so every renderer releases the draft's id and shows
   * the message without a click. A parked prompt never belongs to a queue
   * item — the queue dispatches without parking and retries its own in-flight
   * id, which the bridge then refuses as retired. Providers with no journal to
   * ask, an unreachable bridge, and any failure at all leave the record exactly
   * where it was (`undefined`), because "I could not find out" must never read
   * as "it ran".
   */
  async settleAmbiguousDispatch(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved?: NativeAgentRuntimeProvider,
  ): Promise<"confirmed" | "retired" | undefined> {
    try {
      // Cheapest question first. Projection reads drive this on every refresh,
      // and a provider with no journal to ask must not cost a storage read each
      // time to establish that it still has nothing to say.
      const provider = resolved ?? (await this.host.provider(input));
      if (!provider.dispatchStatus) return undefined;
      // Re-read rather than trusting the caller's snapshot: a real
      // acknowledgement may have landed since, and confirming against a stale
      // record would resurrect a request id that is no longer parked.
      const session = await this.host.storage.getNativeAgentSession(key);
      if (session?.pendingDispatch?.requestId !== requestId) return undefined;
      const status = await provider.dispatchStatus(session.providerSessionId, requestId);
      if (status === "lost") {
        return (await this.host.storage.retireNativeAgentDispatch(key, requestId))
          ? "retired"
          : undefined;
      }
      if (status !== "dispatched" && status !== "pending") return undefined;
      return (await this.host.storage.confirmNativeAgentDispatch(key, requestId))
        ? "confirmed"
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether the parked dispatch `requestId` no longer blocks this session,
   * because something else settled or discarded it after it refused a prompt.
   * A failed read answers `false`: "I could not find out" keeps the block.
   */
  private async parkedDispatchReleased(key: string, requestId: string): Promise<boolean> {
    try {
      const session = await this.host.storage.getNativeAgentSession(key);
      return session?.pendingDispatch?.requestId !== requestId;
    } catch {
      return false;
    }
  }

  async settleAmbiguousSteer(
    input: NativeAgentProjectionInput,
    key: string,
    requestId: string,
    resolved?: NativeAgentRuntimeProvider,
  ): Promise<"dispatched" | "absent" | undefined> {
    try {
      await this.host.storage.recoverPromptQueueSteer(key, requestId);
      const session = await this.host.storage.getNativeAgentSession(key);
      if (session?.pendingSteer?.requestId !== requestId) {
        return session?.dispatchedRequestIds?.includes(requestId) ? "dispatched" : undefined;
      }
      const provider = resolved ?? (await this.host.provider(input));
      if (!provider.steerStatus) return undefined;
      const status = await this.host.storage.reconcileNativeAgentSteer(key, requestId, () =>
        provider.steerStatus!(session.providerSessionId, requestId),
      );
      if (status === "dispatched")
        await this.acknowledgeQueuedAsyncQuestionAnswer(input, requestId);
      return status;
    } catch {
      return undefined;
    }
  }

  private async acknowledgeQueuedAsyncQuestionAnswer(
    input: NativeAgentProjectionInput,
    requestId: string,
  ): Promise<void> {
    if (!nativeAsyncQuestionItemId(requestId)) return;
    await this.host.storage.acknowledgePromptQueueDispatch(
      `${input.agent}\0${input.logicalSessionKey}`,
      requestId,
    );
  }

  async retryRecoverableDispatch(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<NativeAgentDispatchOutcome> {
    this.host.assertProjectionInput(input);
    if (!nonBlank(input.requestId)) {
      throw new Error("Recoverable native agent request ID must not be blank");
    }
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const session = await this.host.storage.getNativeAgentSession(key);
    const pending = session?.pendingDispatch;
    const pendingSteer = session?.pendingSteer;
    if (!session || (!pending && !pendingSteer)) {
      return {
        outcome: "rejected",
        error: "There is no recoverable dispatch for this session",
      };
    }
    if ((pending?.requestId ?? pendingSteer?.requestId) !== input.requestId) {
      return {
        outcome: "rejected",
        error: "The recoverable dispatch changed; refresh before retrying",
      };
    }
    if (pendingSteer) {
      const resolved = await this.host.resolveProjectionSession(input);
      if (!resolved?.provider.performSessionAction || !resolved.provider.steerSupported) {
        return { outcome: "rejected", error: `${input.agent} does not support steer` };
      }
      const qualified = await resolved.provider
        .steerSupported(resolved.session.providerSessionId)
        .catch(() => false);
      if (!qualified) {
        return {
          outcome: "rejected",
          error: `${input.agent} bridge does not support reliable steering; recovery remains parked`,
        };
      }
      const settlement = await this.settleAmbiguousSteer(
        input,
        key,
        input.requestId,
        resolved.provider,
      );
      if (settlement === "dispatched") {
        this.host.projections.invalidateProjection(key);
        return { outcome: "accepted", requestId: input.requestId };
      }
      if (
        settlement === "absent" ||
        !(await this.host.storage.getNativeAgentSession(key))?.pendingSteer
      ) {
        this.host.projections.invalidateProjection(key);
        return {
          outcome: "rejected",
          error: pendingSteer.sourceQueue
            ? "The steering instruction was not delivered. The prompt was returned to the queue."
            : "The steering instruction was not delivered.",
        };
      }
      const outcome = await this.dispatchPersistedSteer(
        resolved.provider,
        resolved.session.providerSessionId,
        key,
        pendingSteer,
      );
      this.host.projections.invalidateProjection(key);
      if (outcome.outcome === "applied") {
        await this.acknowledgeQueuedAsyncQuestionAnswer(input, input.requestId);
        return { outcome: "accepted", requestId: input.requestId };
      }
      if (outcome.outcome === "unknown") {
        return {
          outcome: "unknown",
          requestId: input.requestId,
          error: "The steering instruction is still being reconciled.",
        };
      }
      if (outcome.outcome === "rejected") {
        return { outcome: "rejected", error: nativeAgentSteerRejectionMessage(outcome) };
      }
      if (pendingSteer.onMissedTurn === "refuse") {
        return {
          outcome: "rejected",
          error: "The steering instruction missed its turn and was refused.",
        };
      }
      // Missed its turn. A steer taken from the queue was put back there, and
      // the queue sends it as the next turn: sending it here as well would
      // deliver it twice.
      if (pendingSteer.sourceQueue) {
        return {
          outcome: "rejected",
          error:
            "The steering instruction missed its turn. The prompt was returned to the queue and is sent as the next turn.",
        };
      }
      const delivered = await this.deliverMissedSteer(
        resolved,
        pendingSteer.text,
        outcome.outcome === "mismatch" ? "mismatch" : "idle",
        pendingSteer.turnRequestId,
      );
      if (delivered.outcome === "applied") {
        return {
          outcome: "accepted",
          requestId: delivered.requestId!,
          ...(delivered.deliveredAs ? { deliveredAs: delivered.deliveredAs } : {}),
        };
      }
      return {
        outcome: "unknown",
        requestId: delivered.requestId!,
        error: "The steering instruction was sent as a new turn and is still being reconciled.",
      };
    }
    if (!pending) {
      return { outcome: "rejected", error: "There is no recoverable dispatch for this session" };
    }
    return this.dispatchIntentInternal(
      {
        environmentId: session.environmentId,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
        origin: session.origin,
        interactionPolicy: session.interactionPolicy,
        prompt: pending.prompt,
        requestId: pending.requestId,
        images: pending.images,
        attachments: pending.attachments,
        schema: pending.schema,
        mode: pending.mode,
        fastMode: pending.fastMode,
        subAgent: pending.subAgent,
        executionAgent: pending.executionAgent,
        includeLocalSettings: pending.includeLocalSettings,
        promptSuggestions: pending.promptSuggestions,
        model: pending.model,
        reasoningEffort: pending.reasoningEffort,
        // The same resolved intent, never re-derived from the text: a retry of
        // a command must run that command or fail, not become a prompt.
        ...(pending.command ? { command: pending.command } : {}),
      },
      true,
    );
  }

  /** One renderer request transfers a queue item into the backend-owned receipt. */
  async steerQueuedPrompt(
    input: NativeAgentProjectionInput & { messageId: string },
  ): Promise<NativeAgentSessionActionOutcome | null> {
    this.host.assertProjectionInput(input);
    if (!nonBlank(input.messageId)) throw new Error("Queued message ID must not be blank");
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) throw new Error("Native agent session was not found");
    const queueKey = `${input.agent}\0${input.logicalSessionKey}`;
    const queue = await this.host.storage.getPromptQueue(queueKey);
    if (queue?.inFlight?.steer) {
      await this.host.storage.recoverPromptQueueSteer(resolved.key, queue.inFlight.requestId);
      const latest = await this.host.storage.getNativeAgentSession(resolved.key);
      const item = queue.inFlight.message as { id?: string };
      if (
        item.id === input.messageId &&
        latest?.pendingSteer?.requestId === queue.inFlight.requestId
      ) {
        return { outcome: "unknown", requestId: queue.inFlight.requestId };
      }
      // A lost applied response can be replayed without another provider call.
      if (
        item.id === input.messageId &&
        latest?.dispatchedRequestIds?.includes(queue.inFlight.requestId)
      )
        return { outcome: "applied", requestId: queue.inFlight.requestId };
    }
    if (
      !resolved.provider.performSessionAction ||
      !resolved.provider.activeSteerRun ||
      !resolved.provider.steerSupported ||
      !resolved.provider.steerStatus ||
      !nativeCapabilities(input.agent).actions?.steer
    )
      throw new Error(`${input.agent} does not support reliable steering`);
    if (!(await resolved.provider.steerSupported(resolved.session.providerSessionId)))
      throw new Error(`${input.agent} bridge does not support reliable steering`);
    const active = await resolved.provider.activeSteerRun(resolved.session.providerSessionId);
    if (active.state === "idle") return { outcome: "idle" };
    if (active.state !== "running") throw new Error("The active turn is not ready to steer");
    const pending = await this.host.storage.reservePromptQueueSteer(
      resolved.key,
      input.messageId,
      active.runId,
    );
    if (!pending) return null;
    const outcome = await this.dispatchPersistedSteer(
      resolved.provider,
      resolved.session.providerSessionId,
      resolved.key,
      pending,
    );
    this.host.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  /**
   * The composer's `/steer`, the Agent Info steer box and the public CLI. A
   * steer that misses its turn starts a new turn or waits in the queue for the
   * next one (`native-agent-missed-steer.ts`), unless the caller bound it to
   * one run and asked to be told instead (`onMissedTurn: "refuse"`).
   */
  async performProjectionSteer(
    input: NativeAgentProjectionInput,
    resolved: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
    },
    action: Extract<NativeAgentSessionAction, { kind: "steer" }>,
  ): Promise<NativeAgentSessionActionOutcome> {
    const turnRequestId = action.turnRequestId;
    const steerRequestId = turnRequestId
      ? `steer:${createHash("sha256").update(turnRequestId).digest("hex")}`
      : randomUUID();
    if (turnRequestId) {
      const current = await this.host.storage.getNativeAgentSession(resolved.key);
      if (current?.dispatchedRequestIds?.includes(turnRequestId)) {
        return { outcome: "applied", deliveredAs: "new-turn", requestId: turnRequestId };
      }
      if (current?.dispatchedRequestIds?.includes(steerRequestId))
        return { outcome: "applied", requestId: steerRequestId };
      if (current?.pendingDispatch?.requestId === turnRequestId)
        return { outcome: "unknown", requestId: turnRequestId };
      const queue = await this.host.storage.getPromptQueue(
        `${input.agent}\0${input.logicalSessionKey}`,
      );
      if (
        queue?.messages.some((message) => asRecord(message)?.id === turnRequestId) ||
        queue?.inFlight?.requestId === turnRequestId ||
        queue?.outstandingClaim?.message.requestId === turnRequestId
      ) {
        return { outcome: "applied", deliveredAs: "queued", requestId: turnRequestId };
      }
    }
    const outcome = await this.steerProjectionOnce(input, resolved, action, steerRequestId);
    if (
      (outcome.outcome !== "idle" && outcome.outcome !== "mismatch") ||
      action.onMissedTurn === "refuse"
    ) {
      return outcome;
    }
    return this.deliverMissedSteer(
      resolved,
      action.text.trim(),
      outcome.outcome,
      action.turnRequestId,
    );
  }

  private deliverMissedSteer(
    resolved: { key: string; session: PersistedNativeAgentSession },
    text: string,
    missed: "idle" | "mismatch",
    requestId: string = randomUUID(),
  ): Promise<NativeAgentSessionActionOutcome> {
    return deliverMissedSteer(
      {
        storage: this.host.storage,
        dispatchIntent: (dispatch, prepare) =>
          this.dispatchIntentInternal(dispatch, false, prepare),
        notifyPromptQueueChanged: (queueKey) => this.host.notifyPromptQueueChanged(queueKey),
      },
      { session: resolved.session, key: resolved.key, text, missed, requestId },
    );
  }

  private async steerProjectionOnce(
    input: NativeAgentProjectionInput,
    resolved: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
    },
    action: Extract<NativeAgentSessionAction, { kind: "steer" }>,
    requestId: string = randomUUID(),
  ): Promise<NativeAgentSessionActionOutcome> {
    const text = action.text.trim();
    if (!text) throw new Error("Steering text must not be blank");
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) {
      throw new Error("Steering text exceeds the 64 KB limit");
    }
    if (
      !resolved.provider.activeSteerRun ||
      !resolved.provider.steerSupported ||
      !resolved.provider.steerStatus
    ) {
      throw new Error(`${input.agent} does not support reliable steering`);
    }
    if (resolved.session.pendingDispatch) {
      throw new PendingNativeAgentDispatchError(resolved.session.pendingDispatch.requestId);
    }
    if (resolved.session.pendingSteer) {
      if (resolved.session.pendingSteer.requestId !== requestId)
        throw new Error(PARKED_DISPATCH_CONFLICT_MESSAGE);
      this.host.promptQueues.scheduleAmbiguousSteerSettle(
        input,
        resolved.key,
        resolved.session.pendingSteer.requestId,
        resolved.provider,
      );
      return { outcome: "unknown", requestId: resolved.session.pendingSteer.requestId };
    }

    if (!(await resolved.provider.steerSupported(resolved.session.providerSessionId))) {
      throw new Error(`${input.agent} bridge does not support reliable steering`);
    }
    const active = await resolved.provider.activeSteerRun(resolved.session.providerSessionId);
    if (active.state === "unsupported") {
      throw new Error(`${input.agent} does not support reliable steering`);
    }
    if (active.state === "idle") return { outcome: "idle" };
    if (active.state === "unknown") {
      throw new Error(`${input.agent} active turn is not ready to steer`);
    }

    const pending: PersistedNativeAgentPendingSteer = {
      requestId,
      text,
      inputDigest: createHash("sha256").update(text).digest("hex"),
      expectedRunId: active.runId,
      ...(action.onMissedTurn ? { onMissedTurn: action.onMissedTurn } : {}),
      ...(action.turnRequestId ? { turnRequestId: action.turnRequestId } : {}),
      state: "prepared",
      createdAt: new Date().toISOString(),
    };
    const outcome = await this.dispatchPersistedSteer(
      resolved.provider,
      resolved.session.providerSessionId,
      resolved.key,
      pending,
    );
    this.host.projections.invalidateProjection(resolved.key);
    return outcome;
  }

  async dispatchQueuedAsyncQuestionAnswer(
    input: NativeAgentProjectionInput,
    resolved: {
      key: string;
      session: PersistedNativeAgentSession;
      provider: NativeAgentRuntimeProvider;
    },
    text: string,
    requestId: string,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (!nativeAsyncQuestionItemId(requestId)) {
      throw new Error("Queued response is not an asynchronous-question answer");
    }
    // The queue owns this answer: a miss leaves it queued, never a second copy.
    return this.steerProjectionOnce(input, resolved, { kind: "steer", text }, requestId);
  }

  async dispatchPersistedSteer(
    provider: NativeAgentRuntimeProvider,
    providerSessionId: string,
    key: string,
    pending: PersistedNativeAgentPendingSteer,
  ): Promise<NativeAgentSessionActionOutcome> {
    if (!provider.performSessionAction) {
      throw new Error(`${provider.agent} does not support steer`);
    }
    try {
      const session = await this.host.storage.getNativeAgentSession(key);
      if (!session || session.providerSessionId !== providerSessionId) {
        await this.host.storage.clearPendingNativeAgentSteer(key, pending.requestId);
        return { outcome: "mismatch" };
      }
      return await this.host.promptQueues.withSessionMutationFence(
        {
          environmentId: session.environmentId,
          agent: session.agent,
          logicalSessionKey: session.logicalSessionKey,
        },
        () =>
          this.host.storage.dispatchNativeAgentSteerOnce(key, pending, () =>
            provider.performSessionAction!(providerSessionId, {
              kind: "steer",
              text: pending.text,
              requestId: pending.requestId,
              expectedRunId: pending.expectedRunId,
            }),
          ),
      );
    } catch (error) {
      if (
        error instanceof PendingNativeAgentDispatchError ||
        error instanceof PendingNativeAgentSteerError
      ) {
        throw new Error(PARKED_DISPATCH_CONFLICT_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * Attribute this conversation's artifact tool calls to the turn being
   * dispatched and, when the provider's Orkestrator connection is
   * environment-wide (no per-tab credential), mint the turn's artifact-only
   * grant. Best-effort: artifact bookkeeping never blocks a prompt.
   */
  private beginArtifactTurn(
    durable: PersistedNativeAgentSession,
    requestId: string,
  ): string | undefined {
    if (durable.owner?.kind !== "environment") return undefined;
    return beginArtifactDispatchTurn(this.host.options.artifactDispatch, {
      environmentId: durable.environmentId,
      projectId: durable.owner.projectId,
      conversationKey: durable.logicalSessionKey,
      turnId: requestId,
      providerSessionId: durable.providerSessionId,
      needsGrant: nativeAgentCapabilities(durable.agent).agentTools !== true,
    });
  }

  async dispatchPrompt(
    input: DispatchNativeAgentPromptInput,
  ): Promise<PersistedNativeAgentSession> {
    return this.dispatchPromptInternal(input);
  }

  async dispatchPromptInternal(
    input: DispatchNativeAgentPromptInput,
    prepare?: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
    persistAmbiguousDispatch = false,
    mailInject = false,
    recovery = false,
    onInstructionsIgnored?: () => void,
  ): Promise<PersistedNativeAgentSession> {
    const releaseBridge = this.host.beginBridgeWork(input);
    let releaseAgentWork: (() => void) | undefined;
    try {
      releaseAgentWork = this.host.environmentFence.beginAgentWork(input.environmentId);
      return await this.host.promptQueues.withSessionMutationFence(input, () =>
        this.dispatchAdmittedPrompt(
          input,
          prepare,
          persistAmbiguousDispatch,
          mailInject,
          recovery,
          onInstructionsIgnored,
        ),
      );
    } finally {
      releaseAgentWork?.();
      releaseBridge();
    }
  }

  private async dispatchAdmittedPrompt(
    input: DispatchNativeAgentPromptInput,
    prepare:
      | ((
          session: PersistedNativeAgentSession,
          provider: NativeAgentRuntimeProvider,
        ) => Promise<PromptDispatchPreparation>)
      | undefined,
    persistAmbiguousDispatch: boolean,
    mailInject: boolean,
    recovery = false,
    onInstructionsIgnored?: () => void,
  ): Promise<PersistedNativeAgentSession> {
    input = await this.host.trustedSessionInput(input);
    const coordinatorContextRevision =
      input.owner?.kind === "coordinator"
        ? Number(input.prompt.match(/Repository context revision: (\d+)/)?.[1] ?? Number.NaN)
        : Number.NaN;
    const home =
      input.owner?.kind === "coordinator"
        ? null
        : await this.host.storage.getEnvironment(input.environmentId);
    const checkoutProjectId =
      input.owner?.kind === "coordinator"
        ? input.owner.projectId
        : isProjectHomeEnvironment(home)
          ? home!.projectId
          : undefined;
    const releaseCoordinatorTurn = checkoutProjectId
      ? await this.host.options.beginCoordinatorTurn?.(checkoutProjectId)
      : undefined;
    try {
      if (isProjectHomeEnvironment(home))
        await reconcileProjectHomeEnvironment(home!, this.host.storage);
      this.host.assertAcceptingWork();
      // A rebuild or reset of this environment's runtime is in progress.
      this.host.environmentFence.assertAcceptsAgentWork(input.environmentId);
      if (hasPendingTabTeardown(home, input.logicalSessionKey))
        throw new PromptRejectedError(
          "This tab has pending teardown; finish closing it before sending more work",
        );
      const hasAttachments =
        (input.images?.length ?? 0) > 0 || (input.attachments?.length ?? 0) > 0;
      if ((!nonBlank(input.prompt) && !hasAttachments) || !nonBlank(input.requestId)) {
        throw new Error("Native agent prompt or attachment and request ID must not be blank");
      }
      const session: EnsuredNativeAgentSession = await this.host.ensureSession(input);
      // Freeze the effective inherited choice before preparing and journaling
      // dispatch. Retries replay this concrete model, never a stale default.
      if (input.modelSource === "default" || !input.model) {
        input = {
          ...input,
          model: session.controls?.modelId ?? input.model,
          reasoningEffort: input.reasoningEffort ?? session.controls?.reasoningId,
        };
      } else if (session.modelSubstitution?.requestedModelId === input.model) {
        // The session this dispatch created replaced the model it named (a
        // new OpenCode session); send the model the session runs on.
        input = { ...input, model: session.modelSubstitution.modelId };
      }
      const provider = await this.host.provider(input);
      provider.registerSession?.(session.providerSessionId, {
        origin: session.origin,
        interactionPolicy: session.interactionPolicy,
        phase: input.phase,
      });
      /*
       * Decide what this submission executes before anything is journaled or
       * attached. A command that no longer exists, changed, or cannot accept
       * this input is refused here with the draft intact; it is never sent as
       * ordinary text instead.
       */
      const planned = await this.planDispatchCommand(input, session, provider);
      if (planned.kind === "rejected") throw new PromptRejectedError(planned.message);
      // A "Continue in…" handoff travels with whatever reaches this tab first.
      const pendingHandoff = recovery
        ? undefined
        : await this.host.handoffs.pending(session, provider);
      const handoffRefusal = pendingHandoff && pendingHandoffCommandRefusal(planned);
      if (handoffRefusal) throw new PromptRejectedError(handoffRefusal);
      /*
       * `/subork` is an ordinary turn from here on: the carrier asks the agent to
       * call `ask_agents`, and a retry resends that literal text.
       */
      const commandPlan: Exclude<CommandDispatchPlan, { kind: "rejected" | "subork" }> =
        planned.kind === "subork"
          ? {
              kind: "prompt",
              allowProviderCommands: false,
              persistedIntent: { kind: "literal" },
              commandName: planned.commandName,
            }
          : planned;
      if (planned.kind === "subork") {
        // Environment tabs and coordinator conversations (whose key is a tab key
        // on their runtime id) each have `ask_agents` and a mailbox the answers
        // wake. A session Orkestrator runs itself (a pipeline worker, a reviewer,
        // a subork) has neither, so the request would only fail inside the turn.
        if (
          !session.logicalSessionKey.startsWith(`env-${session.environmentId}:`) &&
          session.owner?.kind !== "coordinator"
        ) {
          throw new PromptRejectedError(
            "/subork works in agent tabs and coordinator conversations. This session is run by Orkestrator itself (a pipeline, review or subork), which has no mailbox for the answers to wake.",
          );
        }
        input = { ...input, prompt: renderSuborkRequestCarrier(planned.request) };
      }
      if (commandPlan.kind === "goal") {
        try {
          await this.host.goals.command(session, commandPlan.arguments, {
            busy: this.host.sessionTurnIsBusy(input),
          });
        } catch (error) {
          if (error instanceof GoalCommandError) throw new PromptRejectedError(error.message);
          throw error;
        }
        return session;
      }
      /*
       * Commands the user ran with `!` since the agent's last turn start this
       * prompt, after any coordinator block (which display strips first). Only
       * ordinary text: a provider command parses the prompt's start. Marked
       * delivered only once this prompt is dispatched, so a refused send
       * offers them again; an ambiguous one replays this exact prompt.
       */
      let userCommandTab = session.logicalSessionKey.startsWith(`env-${input.environmentId}:`)
        ? session.logicalSessionKey.slice(`env-${input.environmentId}:`.length)
        : "";
      if (!userCommandTab && session.owner?.kind === "coordinator") {
        const workspace = await this.host.storage.coordinators.getCoordinatorWorkspaceById(
          session.owner.coordinatorId,
        );
        userCommandTab =
          workspace?.conversations.find(
            (conversation) => conversation.logicalSessionKey === session.logicalSessionKey,
          )?.tabId ?? "";
      }
      const userCommands =
        commandPlan.kind !== "session-action" &&
        !commandPlan.command &&
        userCommandTab &&
        !leadingUserCommandContext(input.prompt)
          ? this.host.options.userCommandContext?.take(input.environmentId, userCommandTab)
          : undefined;
      if (commandPlan.kind === "session-action") {
        const result = await this.host.storage.dispatchNativeAgentPromptOnce(
          session.key,
          input.requestId,
          async (durable) => {
            const outcome = await this.performCommandSessionAction(
              input,
              durable,
              provider,
              commandPlan,
            );
            if (outcome.instructionsIgnored) onInstructionsIgnored?.();
          },
        );
        return result.session;
      }
      /*
       * Attach the provider before the at-most-once window opens.
       *
       * A cold agent process is the single most expensive thing the dispatch
       * request can be waiting on, and it used to run entirely inside the window
       * where a lost acknowledgement becomes an ambiguous dispatch the user has
       * to resolve by hand. Out here it is just a slow request that either works
       * or fails cleanly, and it is also outside the native-agent session
       * mutation queue, so one cold start no longer serializes every other
       * session's dispatch behind it.
       *
       * Best-effort by contract: the prompt request performs the same work, so a
       * failure here is left for it to report authoritatively rather than
       * pre-empting it with a second, less specific error.
       */
      /*
       * Resolve the tab-scoped MCP credential once, before the warm-up attach.
       *
       * The bridge rebuilds its SDK session when the credential it was attached
       * with differs from the one on the prompt, so handing the attach the same
       * connection the prompt will send keeps a restarted session from paying a
       * second cold start. A resolution failure is swallowed here: the prompt
       * path resolves it authoritatively inside the dispatch window.
       */
      const resolveAgentMcp = async (
        durable: PersistedNativeAgentSession,
      ): Promise<{ url: string; token: string } | undefined> => {
        if (
          !sessionTakesAgentTools(durable.agent) ||
          durable.owner?.kind !== "environment" ||
          !this.host.options.resolveAgentToolConnection
        ) {
          return undefined;
        }
        const prefix = `env-${durable.environmentId}:`;
        const tabId = durable.logicalSessionKey.startsWith(prefix)
          ? durable.logicalSessionKey.slice(prefix.length)
          : "";
        const environment = tabId
          ? await this.host.storage.getEnvironment(durable.environmentId)
          : null;
        if (!environment) return undefined;
        return this.host.options.resolveAgentToolConnection(
          durable.environmentId,
          durable.owner.projectId,
          tabId,
          environment.environmentType === "local" ? "host" : "container",
        );
      };
      let dispatchAgentMcp: { url: string; token: string } | undefined;
      let dispatchAgentMcpResolved = false;
      try {
        dispatchAgentMcp = await resolveAgentMcp(session);
        dispatchAgentMcpResolved = true;
      } catch {
        // Best-effort; the prompt request resolves it authoritatively below.
      }
      await provider
        .prepareDispatch?.(session.providerSessionId, { agentMcp: dispatchAgentMcp })
        .catch((error: unknown) => {
          log.warn("dispatch.attach-failed", { agent: input.agent, error: formatLogError(error) });
        });
      await this.prepareEnvironmentFirstPrompt(input, session, provider);
      const commandContextBlock = userCommands?.block || leadingUserCommandContext(input.prompt);
      if (commandContextBlock) {
        input = { ...input, prompt: insertUserCommandContext(input.prompt, commandContextBlock) };
      }
      /*
       * Validate liveness before opening the durable dispatch window, but do not
       * keep the global environments.json mutation lock across provider I/O.
       * The native-agent session lock below is the at-most-once fence; holding an
       * unrelated global lock here only stalls activity and deletion bookkeeping
       * for every environment while a provider is slow.
       *
       * Deletion may begin after this check, and physical teardown — the
       * container, the worktree — is no longer ordered behind this send at all.
       * That is the accepted trade: a send racing a teardown fails, and the user
       * asked for the environment to go away. What *is* still ordered is the part
       * that matters for at-most-once: an accepted request is confirmed
       * atomically under the native-agent lock, and deletion's session cleanup
       * queues behind that same lock, so it cannot remove the record mid-dispatch
       * and leave a confirmed turn unattributed.
       */
      await this.host.assertEnvironmentLive(input.environmentId);
      this.host.providerRegistry.beginDispatch(provider);
      try {
        let preparation: PromptDispatchPreparation = { dispatch: true };
        const result = await this.host.storage.dispatchNativeAgentPromptOnce(
          session.key,
          input.requestId,
          async (durable) => {
            if (!preparation.dispatch) {
              return {
                dispatched: false as const,
                ...(preparation.notice ? { incompleteTurnNotice: preparation.notice } : {}),
              };
            }
            // Reuse the credential resolved for the warm-up attach when it
            // succeeded; otherwise resolve it here, inside the at-most-once
            // window, which is the authoritative path.
            const agentMcp = dispatchAgentMcpResolved
              ? dispatchAgentMcp
              : await resolveAgentMcp(durable);
            const tabMail = await this.host.tabMailFor(durable);
            /*
             * Fence every observation read that started before this point, or
             * runs while the send is in flight: its idle is the provider's
             * answer from before this turn and must never be applied after the
             * `working` recorded below (it would end a turn that just began).
             */
            // Change tracking captures the turn's start before the provider can write.
            const settleChangeTurn = await beginChangeTrackingTurn(
              this.host.options.changeTracking?.(),
              durable,
              input.requestId,
            );
            const artifactGrant = this.beginArtifactTurn(durable, input.requestId);
            const groupKey = nativeAgentObservationGroupKey(durable.environmentId, durable.agent);
            const releaseDispatchFence = this.host.observations.beginDispatch(
              durable.key,
              groupKey,
            );
            // The journal is re-read under this lease, so a delivery another
            // request settled while this one waited is not sent again.
            const outgoing = promptWithPendingAgentHandoff(
              coordinatorPromptWithAttachmentPaths(
                insertUserCommandContext(preparation.prompt ?? input.prompt, commandContextBlock),
                durable.environmentId,
                commandPlan.command ? undefined : input.attachments,
              ),
              pendingHandoff,
              durable,
            );
            try {
              await provider.send(durable.providerSessionId, outgoing.prompt, {
                requestId: input.requestId,
                // Only a person typing into the composer can mean "run this
                // command"; workflow-authored prompts are literal text. The plan
                // above already applied that default and resolved any command.
                allowProviderCommands: commandPlan.allowProviderCommands,
                ...(commandPlan.command ? { command: commandPlan.command } : {}),
                images: input.images,
                attachments: input.attachments,
                schema: input.schema,
                // Resolve inheritance under the session lease: Claude's
                // permission payload treats an omitted mode as Build.
                mode: input.mode ?? durable.controls?.mode,
                fastMode: input.fastMode,
                subAgent: input.subAgent,
                executionAgent:
                  preparation.executionAgent ??
                  input.executionAgent ??
                  (input.mode === undefined
                    ? (durable.controls?.executionProfileId ?? undefined)
                    : undefined),
                includeLocalSettings: input.includeLocalSettings,
                promptSuggestions: input.promptSuggestions,
                model: preparation.model ?? input.model,
                effort:
                  durable.agent === "claude"
                    ? claudeReasoningSelection(
                        preparation.effort ??
                          input.reasoningEffort ??
                          durable.controls?.reasoningId,
                        durable.controls?.parameterValues,
                      )
                    : (preparation.effort ?? input.reasoningEffort),
                parameterValues: durable.controls?.parameterValues,
                persistDefaults: durable.controls?.persistDefaults,
                approvalMode: resolveNativeAgentApprovalMode(
                  durable.agent,
                  durable.policy,
                  durable.controls?.approvalMode,
                ),
                agentMcp,
                ...(artifactGrant ? { artifactGrant } : {}),
                ...(tabMail ? { tabMail } : {}),
              });
              // Provider acceptance is the authoritative working edge. Record it
              // before the durable dispatch bookkeeping completes so a newer
              // idle activity snapshot cannot be overwritten by a late return
              // from storage.
              this.host.launches.recordObservedActivity(durable.key, {
                providerSessionId: durable.providerSessionId,
                state: "working",
                activeRequestId: input.requestId,
              });
              this.host.observations.recordDispatchAccepted({
                sessionKey: durable.key,
                groupKey,
                providerSessionId: durable.providerSessionId,
              });
              settleChangeTurn("accepted");
              this.host.signInResends.remember(durable, input, outgoing.prompt, {
                literalPrompt: commandPlan.command === undefined && !mailInject && !recovery,
              });
              return {
                dispatched: true as const,
                mode: input.mode ?? durable.controls?.mode,
                ...(outgoing.deliveredId ? { deliveredAgentHandoffId: outgoing.deliveredId } : {}),
              };
            } catch (error) {
              settleChangeTurn(
                error instanceof AmbiguousPromptDispatchError ? "uncertain" : "rejected",
              );
              // Ambiguous dispatch may still be running. Reconciliation owns
              // settlement and the artifact grant until the outcome is known.
              if (!(error instanceof AmbiguousPromptDispatchError)) {
                this.host.settleArtifactTurn(durable, input.requestId);
              }
              if (
                mailInject &&
                error instanceof ProviderUnavailableError &&
                !(error instanceof AmbiguousPromptDispatchError)
              ) {
                return { dispatched: false as const, mailRefused: true as const };
              }
              throw error;
            } finally {
              releaseDispatchFence();
            }
          },
          persistAmbiguousDispatch && (session.origin === "interactive-native" || mailInject)
            ? {
                ...this.persistedPendingDispatch({
                  ...input,
                  command: commandPlan.persistedIntent,
                }),
                ...(pendingHandoff ? { agentHandoffId: pendingHandoff.id } : {}),
              }
            : undefined,
          async (durable) => {
            preparation = prepare ? await prepare(durable, provider) : { dispatch: true };
            if (!preparation.dispatch) return undefined;
            // The storage session lease also serializes durable control updates.
            // Recheck after provider preparation, immediately before delivery.
            if (input.requireSessionMode && durable.controls?.mode !== input.requireSessionMode) {
              throw new PromptRejectedError(
                "The session is no longer in Plan mode, so this read-only prompt was not sent. Switch the session back to Plan and retry, or cancel it.",
              );
            }
            // Persist authority before the provider can execute this request.
            // Never restore a prior user origin on rejection or ambiguity: a
            // lost acknowledgement can still mean the non-user turn is running.
            // A replay of a parked request is not a new user instruction, even
            // when retried through the ordinary prompt endpoint.
            if (input.owner?.kind === "coordinator") {
              const owner = input.owner;
              const conversationId = coordinatorConversationIdFromRuntimeId(input.environmentId);
              const startedAt = new Date(this.host.now()).toISOString();
              const userTurn = !(mailInject || recovery || durable.pendingDispatch);
              // The user's own device's zone, for self-timers' absolute times.
              const userTimeZone =
                userTurn && isValidTimeZone(input.clientTimeZone)
                  ? input.clientTimeZone
                  : undefined;
              await this.host.storage.coordinators.mutateCoordinatorWorkspace(
                owner.projectId,
                (workspace) => {
                  if (
                    !workspace ||
                    workspace.id !== owner.coordinatorId ||
                    !workspace.conversations.some(
                      (conversation) =>
                        conversation.id === conversationId && !conversation.closedAt,
                    )
                  ) {
                    throw new PromptRejectedError("The coordinator conversation is unavailable");
                  }
                  return {
                    ...workspace,
                    conversations: workspace.conversations.map((conversation) =>
                      conversation.id === conversationId
                        ? {
                            ...conversation,
                            lastTurnOrigin: userTurn ? ("user" as const) : ("mail" as const),
                            lastTurnStartedAt: startedAt,
                          }
                        : conversation,
                    ),
                    ...(userTimeZone ? { userTimeZone } : {}),
                    updatedAt: startedAt,
                  };
                },
              );
            }
            return this.host.applySessionHeldDispatchModel(input, durable, provider);
          },
        );
        if (result.dispatched && userCommands?.ids.length) {
          this.host.options.userCommandContext?.delivered(userCommands.ids, input.requestId);
        }
        if (result.dispatched && pendingHandoff) {
          await this.host.handoffs.markConsumed(result.session, pendingHandoff.id);
        }
        if (
          result.dispatched &&
          input.owner?.kind === "coordinator" &&
          (Number.isSafeInteger(coordinatorContextRevision) || !recovery)
        ) {
          const coordinatorId = input.owner.coordinatorId;
          const conversationId = coordinatorConversationIdFromRuntimeId(input.environmentId);
          if (conversationId) {
            await this.host.storage.coordinators
              .mutateCoordinatorWorkspace(input.owner.projectId, (workspace) =>
                workspace && workspace.id === coordinatorId
                  ? {
                      ...workspace,
                      conversations: workspace.conversations.map((conversation) =>
                        conversation.id === conversationId
                          ? {
                              ...conversation,
                              ...(Number.isSafeInteger(coordinatorContextRevision)
                                ? {
                                    repositoryContextRevisionAcknowledged: Math.max(
                                      conversation.repositoryContextRevisionAcknowledged ?? 0,
                                      coordinatorContextRevision,
                                    ),
                                  }
                                : {}),
                            }
                          : conversation,
                      ),
                      updatedAt: new Date(this.host.now()).toISOString(),
                    }
                  : workspace,
              )
              .catch((error) =>
                log.warn("coordinator-context.ack-failed", { error: formatLogError(error) }),
              );
          }
        }
        return result.session;
      } finally {
        this.host.providerRegistry.endDispatch(provider);
      }
    } finally {
      releaseCoordinatorTurn?.();
    }
  }

  /**
   * Persist and complete first-prompt naming at the backend dispatch boundary.
   *
   * The provider transcript is authoritative for adopted sessions: an empty
   * local request journal alone does not prove that this is the conversation's
   * first prompt. Naming failure remains cosmetic and never blocks dispatch.
   */
  private async prepareEnvironmentFirstPrompt(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
  ): Promise<void> {
    if ((session.dispatchedRequestIds?.length ?? 0) > 0 || !nonBlank(input.prompt)) return;
    try {
      const environment = await this.host.storage.getEnvironment(input.environmentId);
      if (!environment || !isGeneratedEnvironmentName(environment.name)) return;
      // Emptiness is all this needs; one message answers it on any transport
      // that can bound the read.
      const messages = await provider.messages(session.providerSessionId, { limit: 1 });
      if (messages.length > 0) return;
      await this.host.invoke("prepare_environment_first_prompt", {
        environmentId: input.environmentId,
        // A goal's first turn is a carrier. Name the environment from what the
        // person asked for, not from its framing.
        prompt:
          parseGoalCarrier(input.prompt)?.objective ??
          parseSuborkRequestCarrier(input.prompt)?.request ??
          input.prompt,
      });
    } catch (error) {
      log.warn("naming.prepare-failed", {
        environmentId: input.environmentId,
        error: formatLogError(error, { message: false }),
      });
    }
  }

  private persistedPendingDispatch(
    input: DispatchNativeAgentPromptInput,
  ): PersistedNativeAgentPendingDispatch {
    return {
      requestId: input.requestId,
      prompt: input.prompt,
      images: input.images,
      attachments: input.attachments,
      schema: input.schema,
      mode: input.mode,
      fastMode: input.fastMode,
      subAgent: input.subAgent,
      executionAgent: input.executionAgent,
      includeLocalSettings: input.includeLocalSettings,
      promptSuggestions: input.promptSuggestions,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      ...(input.command ? { command: input.command } : {}),
      createdAt: new Date(this.host.now()).toISOString(),
    };
  }

  /**
   * Resolve command intent against this session's authoritative catalogue.
   *
   * Absent intent keeps the historical default: an interactive composer's
   * text may invoke a command, anything a workflow, mail or schema authored is
   * literal. A selection that is not found gets one forced catalogue re-read,
   * because a list refreshed since the user picked it may simply be newer.
   */
  private async planDispatchCommand(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
  ): Promise<CommandDispatchPlan> {
    const intent: NativeAgentCommandIntent =
      input.allowProviderCommands === false
        ? { kind: "literal" }
        : (input.command ??
          (input.allowProviderCommands === true || session.origin === "interactive-native"
            ? { kind: "typed" }
            : { kind: "literal" }));
    const planInput = {
      platform: input.agent,
      agentLabel: AGENT_PLATFORM_LABELS[input.agent] ?? input.agent,
      prompt:
        input.owner?.kind === "coordinator" || bugReportIdFromRuntimeId(input.environmentId)
          ? stripCoordinatorContext(input.prompt)
          : input.prompt,
      intent,
      structuredOutput: input.schema !== undefined,
      attachments: [
        ...(input.attachments ?? []).map((attachment) => ({ type: attachment.type })),
        ...(input.images ?? []).map(() => ({ type: "image" as const })),
      ],
    };
    const capabilities = nativeCapabilities(input.agent);
    if (!commandDispatchNeedsCatalogue(input.agent, planInput.prompt, intent)) {
      return planCommandDispatch({
        ...planInput,
        commands: [],
        catalogue: { status: "ready", revision: 0, enhanced: false },
      });
    }
    const supported =
      capabilities.slashCommands && Boolean(provider.slashCommands || provider.commandCatalogue);
    const read = async (force: boolean) =>
      supported
        ? this.host.catalogs.readCommandsForDispatch(
            input,
            provider,
            session.providerSessionId,
            force,
          )
        : { commands: [], state: unsupportedCommandCatalogueState() };
    let snapshot = await read(false);
    const busy = (await readProviderStatus(provider, session.providerSessionId)).status !== "idle";
    let plan = planCommandDispatch({
      ...planInput,
      busy,
      commands: withSessionActionSlashCommands(snapshot.commands, capabilities),
      catalogue: snapshot.state,
    });
    if (plan.kind === "rejected" && plan.staleSelection && supported) {
      snapshot = await read(true);
      plan = planCommandDispatch({
        ...planInput,
        busy,
        commands: withSessionActionSlashCommands(snapshot.commands, capabilities),
        catalogue: snapshot.state,
      });
    }
    return plan;
  }

  /** Run a command that resolved to an Orkestrator session action. */
  private async performCommandSessionAction(
    input: DispatchNativeAgentPromptInput,
    session: PersistedNativeAgentSession,
    provider: NativeAgentRuntimeProvider,
    plan: Extract<CommandDispatchPlan, { kind: "session-action" }>,
  ): Promise<{ instructionsIgnored?: boolean }> {
    const label = AGENT_PLATFORM_LABELS[input.agent] ?? input.agent;
    if (!nativeCapabilities(input.agent).actions?.compact || !provider.performSessionAction) {
      throw new PromptRejectedError(`${label} does not support /compact here.`);
    }
    const refusal = compactInstructionsRefusal(input.agent, plan.instructions);
    if (refusal) throw new PromptRejectedError(refusal);
    if (session.pendingDispatch || session.pendingSteer) {
      throw new PromptRejectedError(PARKED_DISPATCH_CONFLICT_MESSAGE);
    }
    // Compacting mid-turn would rewrite the context a running turn is using.
    // The provider's own compact guard is the atomic fence; this check only
    // gives the common case a clear message before asking it.
    const { status } = await readProviderStatus(provider, session.providerSessionId);
    if (status === "running" || status === "blocked") {
      throw new PromptRejectedError(
        `/compact runs when ${label} is idle. Try again after this turn.`,
      );
    }
    const outcome = await provider.performSessionAction(session.providerSessionId, {
      kind: plan.action,
      ...(plan.instructions ? { instructions: plan.instructions } : {}),
    });
    this.host.projections.invalidateProjection(session.key);
    // An applied outcome with `instructionsIgnored` still succeeds: the
    // compaction ran, and refusing now would invite a second one. The bridge
    // adapter has already counted and logged the older bridge.
    if (outcome.outcome !== "applied") {
      throw new PromptRejectedError(
        outcome.outcome === "idle"
          ? `${label} had nothing to compact.`
          : `${label} did not confirm the compaction. Check the transcript before retrying.`,
      );
    }
    return outcome;
  }
}
