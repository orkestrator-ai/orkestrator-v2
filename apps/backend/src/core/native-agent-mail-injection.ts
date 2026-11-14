import type {
  NativeAgentSessionActionOutcome,
  Environment,
  StorageService,
  NativeAgentRuntimeProvider,
  EnsureNativeAgentSessionInput,
  DispatchNativeAgentPromptInput,
  NativeAgentProjectionInput,
  NativeAgentServiceOptions,
  PersistedNativeAgentPendingSteer,
  MailInjectDispatchOutcome,
  MailSteerDispatchOutcome,
} from "./native-agent-service-shared.js";
import {
  nativeAgentSessionStorageKey,
  nativeCapabilities,
  readProviderStatus,
  AmbiguousPromptDispatchError,
  PendingNativeAgentDispatchError,
  createHash,
  ProviderUnavailableError,
  isEnvironmentReadyForAgents,
} from "./native-agent-service-shared.js";
import {
  coordinatorIdFromRuntimeId,
  coordinatorConversationIdFromRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  MAIL_INJECT_OBSERVATION_MAX_AGE_MS,
  observationSatisfies,
} from "./native-agent-observation.js";
import type { MailboxPresence } from "@orkestrator/protocol/agent-mail";
import { composeDraftHoldsQueue } from "./compose-draft-occupancy.js";
import type {
  NativeAgentTranscriptProjection,
  ResolvedProjectionSession,
} from "./native-agent-transcript-projection.js";
import type { NativeAgentObservationBroker } from "./native-agent-observation.js";
import type { NativeAgentLaunchActivityReconciler } from "./native-agent-launch-activity-reconciler.js";
import type { NativeAgentPromptDispatch } from "./native-agent-prompt-dispatch.js";

/** What mail injection needs from the service that wires it. */
export interface NativeAgentMailInjectionHost {
  storage: StorageService;
  options: NativeAgentServiceOptions;
  launches: Pick<NativeAgentLaunchActivityReconciler, "sessionTurnActivitySnapshot">;
  observations: Pick<NativeAgentObservationBroker, "view">;
  projections: Pick<NativeAgentTranscriptProjection, "invalidateProjection">;
  /** Every fence and lease mail takes is taken inside these entry points. */
  dispatch: Pick<
    NativeAgentPromptDispatch,
    | "dispatchPersistedSteer"
    | "dispatchPromptInternal"
    | "settleAmbiguousDispatch"
    | "settleAmbiguousSteer"
  >;
  /** Resolve a provider, starting its bridge if needed. */
  provider(input: EnsureNativeAgentSessionInput): Promise<NativeAgentRuntimeProvider>;
  resolveProjectionSession(
    input: NativeAgentProjectionInput,
  ): Promise<ResolvedProjectionSession | null>;
}

/**
 * Agent mail delivered into a native session: the presence gate, the
 * idle-turn injection, Deliver now's steer into a running turn, and the two
 * reconciliations that tell whether an unanswered delivery reached the agent.
 *
 * Mail is a dispatch variant. Injection runs through
 * `NativeAgentPromptDispatch.dispatchPromptInternal` with `mailInject` set,
 * and its admission check runs as that dispatch's `prepare`, under the same
 * storage lease as a typed prompt; a steer runs through
 * `dispatchPersistedSteer`. So the fence and lease order stays in the
 * dispatch collaborator and this class takes none itself. It owns no state.
 */
export class NativeAgentMailInjection {
  constructor(private readonly host: NativeAgentMailInjectionHost) {}

  /**
   * Delivery gate; recovers proven-unsent mail before checking its durable fence.
   * `known.environment` is a read of the environment row the caller made in
   * the same pass (the presence pass reads each environment once); absent, the
   * gate reads it itself (todo 7567 task 2).
   */
  async mailInjectPresence(
    input: NativeAgentProjectionInput,
    known: { environment?: Environment | null } = {},
  ): Promise<MailboxPresence> {
    const sessionKey = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    const queueKey = `${input.agent}\0${input.logicalSessionKey}`;
    const draftKey = `${input.agent}:${input.environmentId}:${encodeURIComponent(input.logicalSessionKey)}`;
    let [environment, session, queue, draft] = await Promise.all([
      known.environment !== undefined
        ? known.environment
        : this.host.storage.getEnvironment(input.environmentId),
      this.host.storage.getNativeAgentSession(sessionKey),
      this.host.storage.getPromptQueue(queueKey),
      this.host.storage.getComposeDraft(draftKey),
    ]);
    if (session?.pendingDispatch?.mailRefused) {
      try {
        await this.host.storage.clearPendingNativeAgentDispatch(
          sessionKey,
          session.pendingDispatch.requestId,
          true,
        );
        session = await this.host.storage.getNativeAgentSession(sessionKey);
      } catch {
        return "working";
      }
    }
    if (!coordinatorIdFromRuntimeId(input.environmentId)) {
      if (!environment || environment.deletionRequestedAt || environment.status !== "running") {
        return "environment_stopped";
      }
      if (!isEnvironmentReadyForAgents(environment)) return "environment_unready";
    }
    if (composeDraftHoldsQueue(draft?.value)) return "draft";
    if (
      session?.pendingDispatch ||
      (queue &&
        (queue.outstandingClaim !== undefined ||
          queue.inFlight !== undefined ||
          queue.messages.length > 0))
    ) {
      return "working";
    }
    const activity = this.host.launches.sessionTurnActivitySnapshot(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    // Idle presence is only as good as the observation behind it. A group the
    // observer has backed off keeps its retained idle between safety reads;
    // past the age the injection gate trusts, presence says `unknown` rather
    // than `idle`, so a slower observation never reads as permission to
    // inject (the gate then reads the provider itself).
    if (
      activity === "idle" &&
      !observationSatisfies(this.host.observations.view(sessionKey, session?.providerSessionId), {
        maxAgeMs: MAIL_INJECT_OBSERVATION_MAX_AGE_MS,
        requirePostDispatch: true,
      })
    ) {
      return "unknown";
    }
    return activity === "idle" || activity === "working" || activity === "waiting"
      ? activity
      : "unknown";
  }

  async reconcileMailInject(
    input: NativeAgentProjectionInput & { requestId: string; steerRecovery?: boolean },
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    const candidates = [input];
    const coordinatorId = coordinatorIdFromRuntimeId(input.environmentId);
    const conversationId = coordinatorConversationIdFromRuntimeId(input.environmentId);
    // Mailbox synchronization upgrades routing to the renderer's tab key, but
    // an interrupted send still belongs to its original native-session row.
    // Read that row too, including during later verification passes/restarts;
    // never adopt it over an existing canonical transcript mapping.
    if (
      coordinatorId &&
      conversationId &&
      input.logicalSessionKey.startsWith(`env-${input.environmentId}:`)
    ) {
      candidates.push({
        ...input,
        logicalSessionKey: `coordinator-${coordinatorId}:${conversationId}`,
      });
    }
    const records = await Promise.all(
      candidates.map(async (candidate) => {
        const key = nativeAgentSessionStorageKey(
          candidate.environmentId,
          candidate.agent,
          candidate.logicalSessionKey,
        );
        return { candidate, key, session: await this.host.storage.getNativeAgentSession(key) };
      }),
    );
    if (records.some(({ session }) => session?.dispatchedRequestIds?.includes(input.requestId))) {
      return "dispatched";
    }
    let refused = false;
    let unresolved = false;
    for (const { candidate, key, session } of records) {
      if (session?.retiredDispatch?.requestId === input.requestId) unresolved = true;
      if (session?.pendingDispatch?.requestId !== input.requestId) continue;
      if (session.pendingDispatch.mailRefused) refused = true;
      else if (
        (await this.host.dispatch.settleAmbiguousDispatch(candidate, key, input.requestId)) ===
        "confirmed"
      ) {
        return "dispatched";
      } else unresolved = true;
    }
    // A refusal in one identity cannot prove another identity's attempt unsent.
    // A steer claim may never have entered ordinary dispatch. In recovery,
    // absence of its durable ordinary record rules out a fallback send, but
    // only alongside separate proof from the steer journal. An unsettled
    // matching ordinary dispatch still blocks replay.
    return !unresolved &&
      (refused || (input.steerRecovery && records.some(({ session }) => session)))
      ? "not-dispatched"
      : "unknown";
  }

  async dispatchMailInject(
    input: DispatchNativeAgentPromptInput,
  ): Promise<MailInjectDispatchOutcome> {
    let heldReason: "parked" | "queue" | "draft" | "busy" | undefined;
    // Outside the session fence: a slow fetch must not hold a typed prompt.
    await this.host.options.beforeMailInject?.(input.environmentId).catch(() => undefined);
    try {
      const result = await this.host.dispatch.dispatchPromptInternal(
        { ...input, allowProviderCommands: false },
        async (session, provider) => {
          if (session.pendingDispatch && session.pendingDispatch.requestId !== input.requestId) {
            heldReason = "parked";
            return { dispatch: false };
          }
          const queueKey = `${input.agent}\0${input.logicalSessionKey}`;
          const queue = await this.host.storage.getPromptQueue(queueKey);
          if (
            queue &&
            (queue.outstandingClaim !== undefined ||
              queue.inFlight !== undefined ||
              queue.messages.length > 0)
          ) {
            heldReason = "queue";
            return { dispatch: false };
          }
          const draftKey = `${input.agent}:${input.environmentId}:${encodeURIComponent(input.logicalSessionKey)}`;
          const draft = await this.host.storage.getComposeDraft(draftKey);
          if (composeDraftHoldsQueue(draft?.value)) {
            heldReason = "draft";
            return { dispatch: false };
          }
          // The service-level idle observation happens before the message is
          // claimed. Recheck under the same durable per-session fence as a
          // normal prompt so whichever dispatch entered first has priority.
          //
          // A retained idle is trusted only while it is as fresh as the mail
          // presence lease and was read after the session's latest dispatch.
          // Anything older — a group the observer has backed off, a sweep that
          // has not run — is `unknown` here and costs one authoritative read:
          // slower observation must never read as permission to inject.
          //
          // This reads the turn, not the process: a session whose turn ended
          // but whose CLI still runs background subagents is free to take a
          // prompt, and the Claude bridge writes it into that same CLI rather
          // than resuming a second one. Holding on the raw state instead kept
          // mail from a tab's own subagents undelivered until all of them had
          // finished — long after anyone needed it.
          const observation = this.host.observations.view(session.key, session.providerSessionId);
          const observed = this.host.launches.sessionTurnActivitySnapshot(
            input.environmentId,
            input.agent,
            input.logicalSessionKey,
          );
          const activity =
            observed === "idle" &&
            !observationSatisfies(observation, {
              maxAgeMs: MAIL_INJECT_OBSERVATION_MAX_AGE_MS,
              requirePostDispatch: true,
            })
              ? "unknown"
              : observed;
          if (
            activity !== "idle" &&
            (activity !== "unknown" ||
              (await readProviderStatus(provider, session.providerSessionId)).status !== "idle")
          ) {
            heldReason = "busy";
            return { dispatch: false };
          }
          return { dispatch: true };
        },
        true,
        true,
      );
      if (result.pendingDispatch?.mailRefused) heldReason = "busy";
      if (heldReason === "busy") {
        const key = nativeAgentSessionStorageKey(
          input.environmentId,
          input.agent,
          input.logicalSessionKey,
        );
        try {
          await this.host.storage.clearPendingNativeAgentDispatch(key, input.requestId, true);
          if ((await this.host.storage.getNativeAgentSession(key))?.pendingDispatch) {
            return { outcome: "held", reason: "parked" };
          }
        } catch {
          return { outcome: "held", reason: "parked" };
        }
      }
      return heldReason
        ? { outcome: "held", reason: heldReason }
        : { outcome: "accepted", requestId: input.requestId };
    } catch (error) {
      if (error instanceof PendingNativeAgentDispatchError) {
        return { outcome: "held", reason: "parked" };
      }
      if (error instanceof AmbiguousPromptDispatchError) {
        return { outcome: "unknown", requestId: input.requestId, error: error.message };
      }
      if (error instanceof ProviderUnavailableError) {
        // Readiness/attach can refuse before the dispatch window even opens.
        // Do not release an existing row: it may belong to an ambiguous send.
        const session = await this.host.storage.getNativeAgentSession(
          nativeAgentSessionStorageKey(input.environmentId, input.agent, input.logicalSessionKey),
        );
        if (!session?.pendingDispatch) return { outcome: "held", reason: "busy" };
      }
      return {
        outcome: "rejected",
        error: error instanceof Error ? error.message : "Mail dispatch failed",
      };
    }
  }

  /**
   * Deliver mail into the turn that is running now, as the person's Deliver
   * now asked, instead of waiting for that turn to end. It takes the same
   * persisted path as a typed `/steer`: the backend-owned record is durable
   * before the provider sees the text, so a steer left without an answer is
   * confirmed through `reconcileMailSteer` and mail is still never delivered
   * twice. `requestId` must be fresh for every attempt: the Claude bridge uses
   * it as the message uuid and remembers every id it was offered.
   */
  async steerMailInject(
    input: NativeAgentProjectionInput & { text: string; requestId: string },
  ): Promise<MailSteerDispatchOutcome> {
    const resolved = await this.host.resolveProjectionSession(input);
    // A tab that was never prompted has no turn to steer.
    if (!resolved) return { outcome: "idle" };
    const { key, session, provider } = resolved;
    if (
      !nativeCapabilities(input.agent).actions?.steer ||
      !provider.performSessionAction ||
      !provider.activeSteerRun ||
      !provider.steerSupported ||
      !provider.steerStatus
    ) {
      return { outcome: "refused", reason: "steer-unsupported" };
    }
    // An unresolved delivery comes first; the ordinary path waits for it.
    if (session.pendingDispatch || session.pendingSteer) {
      return { outcome: "refused", reason: "steer-refused" };
    }
    if (!(await provider.steerSupported(session.providerSessionId).catch(() => false))) {
      return { outcome: "refused", reason: "steer-unsupported" };
    }
    const active = await provider
      .activeSteerRun(session.providerSessionId)
      .catch(() => ({ state: "unknown" as const }));
    if (active.state === "idle") return { outcome: "idle" };
    if (active.state === "unsupported") return { outcome: "refused", reason: "steer-unsupported" };
    if (active.state !== "running") return { outcome: "refused", reason: "steer-refused" };
    const pending: PersistedNativeAgentPendingSteer = {
      requestId: input.requestId,
      text: input.text,
      inputDigest: createHash("sha256").update(input.text).digest("hex"),
      expectedRunId: active.runId,
      state: "prepared",
      createdAt: new Date().toISOString(),
    };
    let outcome: NativeAgentSessionActionOutcome;
    try {
      outcome = await this.host.dispatch.dispatchPersistedSteer(
        provider,
        session.providerSessionId,
        key,
        pending,
      );
    } catch {
      // The record is durable before the provider is called: without one the
      // text never left, and with one its fate is the journal's to tell.
      const latest = await this.host.storage.getNativeAgentSession(key).then(
        (record) => record ?? null,
        () => undefined,
      );
      const recorded =
        latest === undefined ||
        latest?.pendingSteer?.requestId === input.requestId ||
        latest?.dispatchedRequestIds?.includes(input.requestId) === true;
      outcome = recorded ? { outcome: "unknown" } : { outcome: "mismatch" };
    } finally {
      this.host.projections.invalidateProjection(key);
    }
    switch (outcome.outcome) {
      case "applied":
        return { outcome: "applied" };
      case "unknown":
        return { outcome: "unknown" };
      // The turn ended between the check and the steer.
      case "idle":
        return { outcome: "idle" };
      default:
        return { outcome: "refused", reason: "steer-refused" };
    }
  }

  /**
   * Whether a mail steer reached the agent. Only evidence counts: the
   * session's delivered history, its parked steer settled against the
   * provider's steer journal, or that journal once the record is gone.
   * Anything short of that is `unknown`, never "not sent".
   */
  async reconcileMailSteer(
    input: NativeAgentProjectionInput & { requestId: string },
  ): Promise<"dispatched" | "not-dispatched" | "unknown"> {
    const key = nativeAgentSessionStorageKey(
      input.environmentId,
      input.agent,
      input.logicalSessionKey,
    );
    try {
      const session = await this.host.storage.getNativeAgentSession(key);
      if (!session) return "unknown";
      if (session.dispatchedRequestIds?.includes(input.requestId)) return "dispatched";
      if (session.pendingSteer?.requestId === input.requestId) {
        const settled = await this.host.dispatch.settleAmbiguousSteer(input, key, input.requestId);
        return settled === "dispatched"
          ? "dispatched"
          : settled === "absent"
            ? "not-dispatched"
            : "unknown";
      }
      const status = await (
        await this.host.provider(input)
      ).steerStatus?.(session.providerSessionId, input.requestId);
      return status === "dispatched"
        ? "dispatched"
        : status === "absent"
          ? "not-dispatched"
          : "unknown";
    } catch {
      return "unknown";
    }
  }
}
