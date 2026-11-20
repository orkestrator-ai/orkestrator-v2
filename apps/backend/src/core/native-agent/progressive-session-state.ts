import type {
  StorageService,
  ProviderSessionStateSnapshot,
  NativeAgentProgressiveInput,
} from "./service-shared.js";
import {
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  readProviderStatus,
  createHash,
  nativeComposerControls,
} from "./service-shared.js";
import {
  nativeAsyncQuestionItemId,
  NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION,
  withoutSuppressedComposerControls,
  type NativeAgentSessionStateUpdate,
  type NativeAgentSessionStateView,
  type NativeAgentAsyncQuestionResponse,
} from "@orkestrator/protocol/native-agent";
import { sessionIncompleteTurnNotice } from "../models.js";
import type { NativeAgentCatalogCache } from "./catalog-cache.js";
import { lastAssistantModelRef } from "./composer-selection.js";
import { nativeAgentPlatformPolicy } from "./platform-policy.js";
import { limitNativeAgentCapabilities } from "./capability-limits.js";
import { projectedRetiredDispatch } from "./retired-dispatch.js";
import { ProgressiveReadPhaseTimer, monotonicMs } from "./progressive-metrics.js";
import { nativeTerminalMessages } from "./terminal-messages.js";
import {
  mergeNativeAgentQueueItems,
  normalizeInteractionKinds,
  sessionModelSubstitutionNotice,
  visibleProjectionNotices,
  withProviderContextWindow,
} from "./projection-helpers.js";
import { createLogger } from "@orkestrator/protocol/logger";
import {
  type NativeAgentTranscriptProjectionHost,
  type NativeAgentProjectionContext,
  goalProjectionField,
} from "./projection-context.js";
import { nativeAgentQueueEditingField } from "./queue-editing.js";

const log = createLogger("native-agent");

/**
 * The progressive session-state view (`get_native_agent_session_state_update`):
 * turn phase, composer, capabilities, pending interactions and queue, usage and
 * notices, read beside the transcript so a running turn's state does not wait
 * on, or re-send, its rows.
 */
export class NativeAgentProgressiveSessionState {
  private readonly host: NativeAgentTranscriptProjectionHost;
  private readonly storage: StorageService;
  private readonly catalogs: NativeAgentCatalogCache;

  constructor(private readonly context: NativeAgentProjectionContext) {
    this.host = context.host;
    this.storage = context.storage;
    this.catalogs = context.catalogs;
  }

  /** Key count of the state cache, for `native-projection` diagnostics. */
  cacheGauges(): Record<string, number> {
    return { progressiveStates: this.progressiveStateCache.size };
  }

  /** Drop every cached state view (shutdown). */
  clear(): void {
    this.progressiveStateCache.clear();
  }

  /** Drop the state views of a session whose identity changed. */
  forgetSession(sessionKey: string): void {
    const progressivePrefix = `${sessionKey}\0progressive-v1\0`;
    for (const candidate of Array.from(this.progressiveStateCache.keys())) {
      if (candidate.startsWith(progressivePrefix)) this.progressiveStateCache.delete(candidate);
    }
  }

  /** Collect the sessions of a deleted environment that have a cached state view. */
  collectEnvironmentSessions(environmentId: string, sessionKeys: Set<string>): void {
    for (const { value } of this.progressiveStateCache.values()) {
      if (value.identity.environmentId !== environmentId) continue;
      sessionKeys.add(
        nativeAgentSessionStorageKey(
          environmentId,
          value.identity.platform,
          value.identity.logicalSessionKey,
        ),
      );
    }
  }

  private readonly progressiveStateCache = new Map<
    string,
    { token: string; value: NativeAgentSessionStateView }
  >();

  private async readProgressiveSessionState(
    input: NativeAgentProgressiveInput,
    timer?: ProgressiveReadPhaseTimer,
  ): Promise<NativeAgentSessionStateView | null> {
    const resolved = await this.host.resolveProjectionSession(input);
    if (!resolved) return null;
    const advertisedCapabilities = nativeCapabilities(input.agent);
    timer?.sourceStarted();
    const sourceReads = Promise.all([
      this.context.resumeIdentity.read(resolved.session, () =>
        resolved.provider.sessionStateSnapshot
          ? resolved.provider.sessionStateSnapshot(resolved.session.providerSessionId)
          : resolved.provider.interactiveSnapshot
            ? this.context.reads.sharedInteractiveSnapshot(
                input,
                resolved.provider,
                resolved.session.providerSessionId,
              )
            : readProviderStatus(resolved.provider, resolved.session.providerSessionId),
      ),
      this.context.parts.pendingInteractions(resolved),
      advertisedCapabilities.queue
        ? this.storage.getPromptQueue(`${input.agent}\0${input.logicalSessionKey}`)
        : Promise.resolve(null),
      advertisedCapabilities.actions?.steer
        ? (resolved.provider
            .steerSupported?.(resolved.session.providerSessionId)
            .catch(() => false) ?? Promise.resolve(false))
        : Promise.resolve(false),
    ]);
    // A failed source read ends the phase too, so `unavailable` keeps its time.
    const [snapshot, interactionSnapshot, queue, steerSupported] = await sourceReads.finally(() =>
      timer?.sourceEnded(),
    );
    if (snapshot.status === "missing") return null;
    const commandRevision = (snapshot as ProviderSessionStateSnapshot).commandCatalogueRevision;
    if (commandRevision !== undefined) {
      this.catalogs.observeCommandRevision(
        input,
        resolved.provider,
        resolved.session.providerSessionId,
        commandRevision,
      );
    }
    const liveInteractionKinds = normalizeInteractionKinds(
      (snapshot as ProviderSessionStateSnapshot).interactionKinds,
    );
    const sessionCapabilities = limitNativeAgentCapabilities(
      advertisedCapabilities,
      (snapshot as ProviderSessionStateSnapshot).capabilityLimits,
    );
    let capabilities =
      liveInteractionKinds === undefined
        ? sessionCapabilities
        : { ...sessionCapabilities, interactions: { kinds: liveInteractionKinds } };
    if (capabilities.actions?.steer && !steerSupported) {
      log.debug("steer.capability-cleared", {
        agent: input.agent,
        environmentId: input.environmentId,
        status: snapshot.status,
      });
      capabilities = { ...capabilities, actions: { ...capabilities.actions, steer: false } };
    }
    const stateSnapshot = snapshot as ProviderSessionStateSnapshot;
    const lastAssistant = lastAssistantModelRef(
      "messages" in stateSnapshot && Array.isArray(stateSnapshot.messages)
        ? stateSnapshot.messages
        : [],
    );
    const composer = await this.context.parts.projectionComposer(
      input,
      resolved.session,
      stateSnapshot.composer,
      stateSnapshot.controls,
      true,
      {
        lastAssistantModelId: stateSnapshot.lastAssistantModelId ?? lastAssistant.modelId,
        lastAssistantReasoningId:
          stateSnapshot.lastAssistantReasoningId ?? lastAssistant.reasoningId,
        sessionModelId: stateSnapshot.sessionModelId,
        sessionReasoningId: stateSnapshot.sessionReasoningId,
        // A body-free OpenCode state view may see session.model before the
        // stronger last-assistant evidence arrives with transcript hydration.
        persistSelection:
          !nativeAgentPlatformPolicy(input.agent).infersComposerSelection ||
          !!(stateSnapshot.lastAssistantModelId ?? lastAssistant.modelId),
      },
    );
    // Body-free: it shows the title already chosen, never chooses one.
    const stateTitle = this.context.sessionTitles.resolve({
      sessionKey: resolved.key,
      session: resolved.session,
      agent: input.agent,
      ...(stateSnapshot.title ? { providerTitle: stateSnapshot.title } : {}),
      reachesStart: false,
      transient: resolved.transient,
      ...(resolved.provider.setSessionTitle
        ? {
            setProviderTitle: (id: string, value: string) =>
              resolved.provider.setSessionTitle!(id, value),
          }
        : {}),
    });
    const selectedModel = composer.models.find((model) => model.id === composer.selectedModelId);
    // A provider that reports no composer (OpenCode) resolves its model window
    // from the catalogue, which may still be loading on the first state read.
    // Fall back to the usage the last full projection already filled — from
    // whichever representation this tab last read — both to keep the window and
    // to keep the counters when a state read races ahead of the provider's
    // transcript cache.
    const storedContextUsage = [
      this.context.full.projectionCache.get(resolved.key)?.projection,
      this.context.full.projectionCache.get(`${resolved.key}\0detail-recovery`)?.projection,
    ].find(
      (projection) => projection?.sessionId === resolved.session.providerSessionId,
    )?.contextUsage;
    const contextUsage = withProviderContextWindow(
      stateSnapshot.contextUsage ?? storedContextUsage,
      selectedModel?.contextWindow,
      storedContextUsage,
    );
    // The provider's own report only: the stored fallback came from a full
    // projection, which already recorded it. A CLI-driven session may never
    // get one, so this read is what counts its turns.
    this.context.observeSessionUsage(resolved.session, stateSnapshot.contextUsage);
    const blocked = interactionSnapshot.requests.some((request) => request.blocking !== false);
    const providerGeneration = this.host.providerGeneration(input) ?? `in-process:${input.agent}`;
    const sourceGeneration = providerGeneration;
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    if (resolved.session.pendingDispatch) {
      this.host.scheduleAmbiguousDispatchSettle(
        input,
        sessionKey,
        resolved.session.pendingDispatch.requestId,
        resolved.provider,
      );
    }
    if (resolved.session.pendingSteer) {
      this.host.scheduleAmbiguousSteerSettle(
        input,
        sessionKey,
        resolved.session.pendingSteer.requestId,
        resolved.provider,
      );
    }
    const asyncQuestionResponses = new Map<string, NativeAgentAsyncQuestionResponse>();
    const responsePriority: Record<NativeAgentAsyncQuestionResponse["state"], number> = {
      queued: 1,
      failed: 2,
      dispatching: 3,
      sent: 4,
    };
    const recordResponse = (
      requestId: unknown,
      state: NativeAgentAsyncQuestionResponse["state"],
    ) => {
      if (typeof requestId !== "string") return;
      const itemId = nativeAsyncQuestionItemId(requestId);
      if (!itemId) return;
      const existing = asyncQuestionResponses.get(itemId);
      if (existing && responsePriority[existing.state] >= responsePriority[state]) return;
      asyncQuestionResponses.set(itemId, { itemId, requestId, state });
    };
    for (const requestId of resolved.session.dispatchedRequestIds ?? []) {
      recordResponse(requestId, "sent");
    }
    for (const message of queue?.messages ?? []) {
      recordResponse(
        message && typeof message === "object" ? (message as { id?: unknown }).id : undefined,
        "queued",
      );
    }
    recordResponse(queue?.inFlight?.requestId, "dispatching");
    recordResponse(queue?.dispatchError?.messageId, "failed");
    const retiredDispatch = projectedRetiredDispatch(
      input.agent,
      resolved.session,
      this.host.now(),
    );
    const notices = visibleProjectionNotices(
      input.agent,
      stateSnapshot.notices,
      sessionIncompleteTurnNotice(resolved.session),
      retiredDispatch,
      sessionModelSubstitutionNotice(resolved.session, this.host.now()),
    );
    // The transcript read never sees session state, so the rows saying how the
    // turn ended travel here. A kept stop result stays with the full read the
    // stop answers with, which consumes it.
    const terminalMessages = nativeTerminalMessages({
      notices: stateSnapshot.notices,
      error: stateSnapshot.error,
      failedTurn: stateSnapshot.failedTurn,
      failureRequestId: resolved.session.dispatchedRequestIds?.at(-1),
      ...(stateSnapshot.failureReason ? { failureReason: stateSnapshot.failureReason } : {}),
      ...(stateSnapshot.rateLimits ? { rateLimits: stateSnapshot.rateLimits } : {}),
      turnStartedAt: stateSnapshot.turnStartedAt,
      now: this.host.now(),
    });
    return {
      identity: this.context.reads.progressiveIdentity(
        input,
        resolved.session.providerSessionId,
        sourceGeneration,
      ),
      connection: "connected",
      turn: {
        phase:
          stateSnapshot.phase === "cancelling" ||
          stateSnapshot.phase === "recovering" ||
          stateSnapshot.phase === "error"
            ? stateSnapshot.phase
            : blocked
              ? "blocked"
              : (stateSnapshot.phase ??
                (stateSnapshot.status === "error"
                  ? "error"
                  : stateSnapshot.status === "blocked"
                    ? "blocked"
                    : stateSnapshot.status === "running"
                      ? "running"
                      : "idle")),
        ...(stateSnapshot.turnStartedAt === undefined
          ? {}
          : { startedAt: stateSnapshot.turnStartedAt }),
        ...(stateSnapshot.error ? { error: stateSnapshot.error } : {}),
        // Both projection reads carry it, so a progressive refresh cannot
        // strip an indicator the full read just showed.
        ...(stateSnapshot.turnActivity && stateSnapshot.status === "running"
          ? { activity: stateSnapshot.turnActivity }
          : {}),
        // The run a steer from this view is bound to (to-do 8107 (retired)).
        ...(stateSnapshot.turnRunId &&
        (stateSnapshot.status === "running" || stateSnapshot.status === "blocked" || blocked)
          ? { runId: stateSnapshot.turnRunId }
          : {}),
        ...this.context.parts.quietObservationFlag(resolved.session),
      },
      interactions: interactionSnapshot.requests,
      // The progressive read feeds the same rendered projection as the full
      // one, so it must apply the identical suppression table.
      composerControls: withoutSuppressedComposerControls(
        input.agent,
        nativeComposerControls(
          composer,
          stateSnapshot.status === "running" || blocked,
          capabilities,
          input.agent,
        ),
      ),
      composer,
      capabilities,
      ...(stateSnapshot.readiness ? { readiness: stateSnapshot.readiness } : {}),
      ...(stateSnapshot.shareUrl === undefined ? {} : { shareUrl: stateSnapshot.shareUrl }),
      ...(stateTitle ? { title: stateTitle } : {}),
      ...(queue
        ? {
            queue: {
              items: mergeNativeAgentQueueItems(
                stateSnapshot.providerQueue?.items ?? [],
                queue.messages,
              ),
              ...(queue.inFlight ? { inFlightRequestId: queue.inFlight.requestId } : {}),
              ...nativeAgentQueueEditingField(queue),
              ...(queue.dispatchError
                ? {
                    blocked: {
                      messageId: queue.dispatchError.messageId,
                      error: queue.dispatchError.message,
                    },
                  }
                : {}),
            },
          }
        : stateSnapshot.providerQueue
          ? { queue: stateSnapshot.providerQueue }
          : {}),
      ...(contextUsage ? { contextUsage } : {}),
      ...goalProjectionField(resolved.session),
      ...this.context.parts.suborkProjectionField(resolved.session),
      ...(asyncQuestionResponses.size > 0
        ? { asyncQuestionResponses: [...asyncQuestionResponses.values()] }
        : {}),
      ...((stateSnapshot.policy ?? resolved.session.policy)
        ? { policy: stateSnapshot.policy ?? resolved.session.policy }
        : {}),
      ...(stateSnapshot.rateLimits ? { rateLimits: stateSnapshot.rateLimits } : {}),
      ...(stateSnapshot.runtimeHealthAuthoritative === undefined
        ? {}
        : { runtimeHealthAuthoritative: stateSnapshot.runtimeHealthAuthoritative }),
      notices,
      ...(resolved.session.pendingDispatch || resolved.session.pendingSteer
        ? {
            recoverableDispatch: {
              requestId:
                resolved.session.pendingDispatch?.requestId ??
                resolved.session.pendingSteer!.requestId,
              createdAt:
                resolved.session.pendingDispatch?.createdAt ??
                resolved.session.pendingSteer!.createdAt,
              kind: resolved.session.pendingDispatch ? ("prompt" as const) : ("steer" as const),
              status: this.context.parts.recoverableDispatchStatus(
                resolved.session.pendingDispatch?.createdAt ??
                  resolved.session.pendingSteer!.createdAt,
                resolved.session.pendingDispatch ? "prompt" : "steer",
              ),
            },
          }
        : {}),
      ...(retiredDispatch ? { retiredDispatch } : {}),
      ...(stateSnapshot.backgroundTasks ? { backgroundTasks: stateSnapshot.backgroundTasks } : {}),
      ...(stateSnapshot.suggestedPrompt ? { suggestedPrompt: stateSnapshot.suggestedPrompt } : {}),
      ...(stateSnapshot.completionBlockedByBackgroundTasks === undefined
        ? {}
        : {
            completionBlockedByBackgroundTasks: stateSnapshot.completionBlockedByBackgroundTasks,
          }),
      ...(terminalMessages.length > 0 ? { terminalMessages } : {}),
    };
  }

  getSessionStateUpdate(
    input: NativeAgentProgressiveInput,
  ): Promise<NativeAgentSessionStateUpdate> {
    return this.context.reads.trackProgressiveRequest(input, () =>
      this.getSessionStateUpdateOnce(input),
    );
  }

  private async getSessionStateUpdateOnce(
    input: NativeAgentProgressiveInput,
  ): Promise<NativeAgentSessionStateUpdate> {
    this.host.assertProjectionInput(input);
    if (input.viewVersion !== NATIVE_AGENT_PROGRESSIVE_VIEW_VERSION) {
      throw new Error("Native agent progressive view version is unsupported");
    }
    const key = this.context.reads.progressiveKey(input, "state");
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const epoch = this.context.projectionEpochs.get(sessionKey) ?? 0;
    const startedAt = monotonicMs();
    const phases = new ProgressiveReadPhaseTimer();
    try {
      const held = await this.context.reads.heldCoordinatorRead(input);
      const value = held
        ? await this.context.reads.heldCoordinatorSessionState(input, held.message)
        : await phases.covering(() =>
            this.context.reads.progressiveReadCovering(
              key,
              sessionKey,
              epoch,
              input.forceSnapshot === true,
              phases.own(() => this.readProgressiveSessionState(input, phases)),
              input.freshSource,
              input.pushObservation,
            ),
          );
      if (!value) {
        this.context.reads.recordProgressiveMetric(
          "state",
          startedAt,
          "provider",
          "missing",
          phases.phases(),
        );
        return { viewVersion: 1, status: "missing" };
      }
      this.context.queuedTurnLog.observe({
        agent: input.agent,
        environmentId: input.environmentId,
        sessionKey,
        phase: value.turn.phase,
        queued: value.queue?.items.length ?? 0,
      });
      const token = phases.normalize(() =>
        createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 43),
      );
      const previous = this.progressiveStateCache.get(key);
      this.progressiveStateCache.delete(key);
      this.progressiveStateCache.set(key, { token, value });
      while (this.progressiveStateCache.size > 128) {
        const oldest = this.progressiveStateCache.keys().next().value as string | undefined;
        if (!oldest || oldest === key) break;
        this.progressiveStateCache.delete(oldest);
      }
      if (!input.forceSnapshot && input.knownToken === token) {
        this.context.reads.recordProgressiveMetric(
          "state",
          startedAt,
          "provider",
          "unchanged",
          phases.phases(),
        );
        return { viewVersion: 1, status: "unchanged", token, identity: value.identity };
      }
      this.context.reads.recordProgressiveMetric(
        "state",
        startedAt,
        "provider",
        "snapshot",
        phases.phases(),
      );
      return {
        viewVersion: 1,
        status: "snapshot",
        token,
        value,
        resetReason:
          input.forceSnapshot || !previous
            ? input.forceSnapshot
              ? "forced"
              : "initial"
            : input.knownToken
              ? "unknown-token"
              : "initial",
      };
    } catch (error) {
      this.context.reads.recordProgressiveMetric(
        "state",
        startedAt,
        "provider",
        "unavailable",
        phases.phases(),
      );
      const cached = this.progressiveStateCache.get(key);
      return {
        viewVersion: 1,
        status: "unavailable",
        retryable: true,
        ...(cached ? { identity: cached.value.identity } : {}),
        error: error instanceof Error ? error.message.slice(0, 4_000) : "Session state unavailable",
      };
    }
  }
}
