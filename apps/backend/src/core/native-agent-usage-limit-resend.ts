/**
 * Resends a native tab's turn the weekly limit stopped, on the account the
 * machine moved to. Like `NativeAgentTurnRecovery` it works from the backend's
 * activity sweep, so it needs no mounted renderer.
 *
 * A resend is one continuation prompt under a durable request id derived from
 * the stopped turn, so:
 * - a repeated observation or a restart finds the journal entry, never a second
 *   turn;
 * - only `failed` qualifies: a turn the user stopped reads `interrupted`, one a
 *   later prompt followed reads `superseded`, and an unknown or pending outcome
 *   is never guessed at;
 * - the id carries a count, so a chain of refusing accounts runs out.
 *
 * Only an edge seen while this backend is running starts one. A stop from before
 * a restart stays stopped, which is also why an account resetting later can never
 * resume work: nothing here looks again once it has decided.
 *
 * Workflows have their own turns and results (see `usageLimitStop` on the
 * provider), and a coordinator's conversation is not a native tab.
 */
import {
  usageLimitResendCount,
  usageLimitResendPrompt,
  usageLimitResendRequestId,
  type UsageLimitStopVerdict,
} from "@orkestrator/protocol/agent-account-auto-switch";
import { isAgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import { coordinatorIdFromRuntimeId } from "@orkestrator/protocol/coordinator";
import {
  isAgentTurnEndTransition,
  type AgentActivityState,
  type DispatchNativeAgentPromptInput,
  type NativeAgentRuntimeProvider,
  type PersistedNativeAgentSession,
  type PromptDispatchPreparation,
  type StorageService,
} from "./native-agent-service-shared.js";

const RETRY_MS = 15_000;
/** A stop still undecided after this stays stopped, and the queue it holds is let go. */
export const USAGE_LIMIT_CANDIDATE_MAX_MS = 45 * 60_000;
const MAX_TRACKED_SESSIONS = 1_024;

/** The part of the auto-switcher a session needs; absent in tests and older wiring. */
export interface UsageLimitStops {
  automatic(platform: "claude" | "codex"): Promise<boolean>;
  noteTurnEnded(platform: "claude" | "codex"): void;
  handleLimitStop(input: {
    platform: "claude" | "codex";
    environmentId: string;
    requestId: string;
    error: string | undefined;
    resends: number;
    turnStartedAt?: string;
    siblingTurnRunning?: () => boolean;
  }): Promise<UsageLimitStopVerdict>;
}

export interface NativeAgentUsageLimitResendDependencies {
  storage: Pick<StorageService, "getEnvironment" | "getNativeAgentSession" | "getPromptQueue">;
  stops(): UsageLimitStops | undefined;
  now(): number;
  isStopped(): boolean;
  requestOutcome(input: {
    environmentId: string;
    agent: PersistedNativeAgentSession["agent"];
    logicalSessionKey: string;
    requestId: string;
    expectedProviderSessionId: string;
  }): Promise<{ outcome: string; error?: string }>;
  observedActivity(
    key: string,
  ): { providerSessionId: string; state: AgentActivityState } | undefined;
  dispatchPrompt(
    input: DispatchNativeAgentPromptInput,
    prepare: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
  ): Promise<unknown>;
}

type Candidate = {
  providerSessionId: string;
  requestId: string;
  retryAt: number;
  firstSeenAt: number;
};

export class NativeAgentUsageLimitResend {
  private readonly candidates = new Map<string, Candidate>();
  private readonly tasks = new Map<string, Promise<void>>();
  /** The newest request seen per session: a turn refused between two sweeps shows no busy state. */
  private readonly seenRequests = new Map<string, string>();
  /** When each session's newest request was first seen, in any state. */
  private readonly turnsSeen = new Map<string, { requestId: string; at: number }>();

  constructor(private readonly deps: NativeAgentUsageLimitResendDependencies) {}

  private appliesTo(session: PersistedNativeAgentSession): boolean {
    return (
      isAgentAccountPlatform(session.agent) &&
      session.origin === "interactive-native" &&
      session.owner?.kind !== "coordinator" &&
      coordinatorIdFromRuntimeId(session.environmentId) === null
    );
  }

  /** A retained candidate keeps its group from settling as idle, so it is looked at again. */
  hasCandidate(key: string): boolean {
    return this.candidates.has(key);
  }

  /** The queue holds its head back rather than parking it while a resend is decided. */
  isPending(key: string): boolean {
    return this.candidates.has(key) || this.tasks.has(key);
  }

  pendingTasks(): Promise<void>[] {
    return [...this.tasks.values()];
  }

  clear(): void {
    this.candidates.clear();
    this.seenRequests.clear();
    this.turnsSeen.clear();
  }

  noteActivity(
    session: PersistedNativeAgentSession,
    state: AgentActivityState,
    previous: AgentActivityState | undefined,
  ): void {
    const stops = this.deps.stops();
    if (!stops || !isAgentAccountPlatform(session.agent)) return;
    const turnEnded = isAgentTurnEndTransition({ previousState: previous, state });
    if (turnEnded) stops.noteTurnEnded(session.agent);
    if (!this.appliesTo(session)) return;
    const requestId = session.dispatchedRequestIds?.at(-1);
    if (requestId && this.turnsSeen.get(session.key)?.requestId !== requestId) {
      if (!this.turnsSeen.has(session.key) && this.turnsSeen.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.turnsSeen.keys().next().value;
        if (oldest !== undefined) this.turnsSeen.delete(oldest);
      }
      this.turnsSeen.set(session.key, { requestId, at: this.deps.now() });
    }
    if (state !== "idle") {
      this.candidates.delete(session.key);
      return;
    }
    const seen = this.seenRequests.get(session.key);
    if (requestId) {
      if (!seen && this.seenRequests.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.seenRequests.keys().next().value;
        if (oldest !== undefined) this.seenRequests.delete(oldest);
      }
      this.seenRequests.set(session.key, requestId);
    }
    // A first observation is a restart or an adopted session, not a turn ending
    // here. Its stop, whatever it was, stays stopped.
    const newRequest = previous !== undefined && seen !== undefined && requestId !== seen;
    if (requestId && (turnEnded || newRequest)) {
      if (!this.candidates.has(session.key) && this.candidates.size >= MAX_TRACKED_SESSIONS) {
        const oldest = this.candidates.keys().next().value;
        if (oldest !== undefined) this.candidates.delete(oldest);
      }
      this.candidates.set(session.key, {
        providerSessionId: session.providerSessionId,
        requestId,
        retryAt: 0,
        firstSeenAt: this.deps.now(),
      });
    }
    this.schedule(session);
  }

  private schedule(session: PersistedNativeAgentSession): void {
    const candidate = this.candidates.get(session.key);
    if (candidate && this.deps.now() - candidate.firstSeenAt >= USAGE_LIMIT_CANDIDATE_MAX_MS) {
      this.candidates.delete(session.key);
      return;
    }
    if (
      !candidate ||
      this.deps.isStopped() ||
      this.tasks.has(session.key) ||
      candidate.providerSessionId !== session.providerSessionId ||
      candidate.retryAt > this.deps.now()
    ) {
      return;
    }
    const task = this.pass(session, candidate)
      .then((result) => {
        if (this.candidates.get(session.key) !== candidate) return;
        if (result === "done") this.candidates.delete(session.key);
        else candidate.retryAt = this.deps.now() + RETRY_MS;
      })
      .catch(() => {
        // A failed decision or send leaves the turn as it stopped: the user sees
        // the provider's own error, and an unknown send stays in the journal.
        if (this.candidates.get(session.key) === candidate) this.candidates.delete(session.key);
        console.warn(
          `[native-agent] Resend after a usage limit in ${session.environmentId} failed`,
        );
      })
      .finally(() => {
        if (this.tasks.get(session.key) === task) this.tasks.delete(session.key);
      });
    this.tasks.set(session.key, task);
  }

  private async pass(
    session: PersistedNativeAgentSession,
    candidate: Candidate,
  ): Promise<"done" | "retry"> {
    const stops = this.deps.stops();
    const platform = session.agent;
    if (!stops || !isAgentAccountPlatform(platform) || this.deps.isStopped()) return "done";
    if (!(await stops.automatic(platform))) return "done";
    const { requestId } = candidate;
    const durable = await this.deps.storage.getNativeAgentSession(session.key);
    if (
      durable?.providerSessionId !== candidate.providerSessionId ||
      durable.dispatchedRequestIds?.at(-1) !== requestId
    ) {
      return "done";
    }
    const environment = await this.deps.storage.getEnvironment(session.environmentId);
    if (!environment || environment.deletionRequestedAt) return "done";

    const outcome = await this.deps.requestOutcome({
      environmentId: session.environmentId,
      agent: session.agent,
      logicalSessionKey: session.logicalSessionKey,
      requestId,
      expectedProviderSessionId: candidate.providerSessionId,
    });
    if (outcome.outcome === "pending") return "retry";
    if (outcome.outcome !== "failed") return "done";

    const turn = this.turnsSeen.get(session.key);
    const verdict = await stops.handleLimitStop({
      platform,
      environmentId: session.environmentId,
      requestId,
      error: outcome.error,
      resends: usageLimitResendCount(requestId),
      ...(turn?.requestId === requestId ? { turnStartedAt: new Date(turn.at).toISOString() } : {}),
    });
    if (verdict === "stop") return "done";
    if (verdict === "wait") return "retry";

    let disposition: "done" | "retry" = "done";
    await this.deps.dispatchPrompt(
      {
        environmentId: session.environmentId,
        agent: session.agent,
        logicalSessionKey: session.logicalSessionKey,
        origin: session.origin,
        interactionPolicy: session.interactionPolicy,
        prompt: usageLimitResendPrompt(),
        requestId: usageLimitResendRequestId(requestId),
      },
      // Inside the session's mutation fence, so a prompt or Stop the user sent
      // meanwhile has already landed in what these read.
      async (locked) => {
        if (
          this.deps.isStopped() ||
          locked.providerSessionId !== candidate.providerSessionId ||
          locked.dispatchedRequestIds?.at(-1) !== requestId ||
          locked.interruptedRequestIds?.includes(requestId)
        ) {
          return { dispatch: false };
        }
        if (locked.pendingDispatch || locked.pendingSteer) {
          disposition = "retry";
          return { dispatch: false };
        }
        const observed = this.deps.observedActivity(locked.key);
        if (observed?.providerSessionId === locked.providerSessionId && observed.state !== "idle") {
          return { dispatch: false };
        }
        const queue = await this.deps.storage.getPromptQueue(
          `${locked.agent}\0${locked.logicalSessionKey}`,
        );
        if (queue && !queue.dispatchError && (queue.inFlight || queue.outstandingClaim)) {
          disposition = "retry";
          return { dispatch: false };
        }
        return { dispatch: true };
      },
    );
    return disposition;
  }
}
