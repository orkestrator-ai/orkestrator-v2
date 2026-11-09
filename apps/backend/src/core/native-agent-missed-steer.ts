import type {
  DispatchNativeAgentPromptInput,
  NativeAgentDispatchOutcome,
  NativeAgentRuntimeProvider,
  NativeAgentSessionActionOutcome,
  PersistedNativeAgentSession,
  PromptDispatchPreparation,
  StorageService,
} from "./native-agent-service-shared.js";
import { readProviderStatus } from "./native-agent-service-shared.js";

/**
 * A steer that misses its turn starts a new turn (todo 0005, task 10).
 *
 * `idle` (no turn is running) and `mismatch` (a different turn is) are
 * definitive "not sent" answers: the backend's own pre-check sends nothing,
 * and a bridge clears its steer record before giving either. So the text can
 * go out again, once, under a request id of its own through the ordinary
 * at-most-once dispatch journal:
 *
 * - `idle`: an ordinary turn now, on the session's persisted controls, the way
 *   agent mail is delivered when no turn is running after all.
 * - `mismatch`, or a busy session or queue backlog found under the dispatch
 *   fence: the session's prompt queue, which sends it when that work is done.
 *   It is never steered into a turn it was not written for.
 *
 * An ambiguous steer (`unknown`) never comes here: it stays parked for its
 * own reconciliation, because its text may already be in a turn.
 */
export interface MissedSteerHost {
  storage: Pick<
    StorageService,
    "getNativeAgentSession" | "getPromptQueue" | "enqueuePromptQueueMessageIfAbsent"
  >;
  /** The ordinary prompt dispatch, with an admission check under its fence. */
  dispatchIntent(
    input: DispatchNativeAgentPromptInput,
    prepare: (
      session: PersistedNativeAgentSession,
      provider: NativeAgentRuntimeProvider,
    ) => Promise<PromptDispatchPreparation>,
  ): Promise<NativeAgentDispatchOutcome>;
  notifyPromptQueueChanged(queueKey: string): void;
}

export interface MissedSteer {
  session: Pick<
    PersistedNativeAgentSession,
    "environmentId" | "agent" | "logicalSessionKey" | "origin" | "interactionPolicy"
  >;
  key: string;
  text: string;
  /** What the steer met instead of its turn. */
  missed: "idle" | "mismatch";
  /** The new turn's id; never the steer's own, which the bridge has seen. */
  requestId: string;
}

/**
 * The outcome reported for a delivered miss is `applied`, so a renderer or
 * peer that predates `deliveredAs` still reads success. A dispatch refusal
 * (nothing sent) throws its reason; an ambiguous one is `unknown` and parked
 * like any other prompt.
 */
export async function deliverMissedSteer(
  host: MissedSteerHost,
  steer: MissedSteer,
): Promise<NativeAgentSessionActionOutcome> {
  const queueKey = `${steer.session.agent}\0${steer.session.logicalSessionKey}`;
  if (steer.missed === "mismatch") return enqueueMissedSteer(host, steer, queueKey);
  let held = false;
  const outcome = await host.dispatchIntent(
    {
      environmentId: steer.session.environmentId,
      agent: steer.session.agent,
      logicalSessionKey: steer.session.logicalSessionKey,
      origin: steer.session.origin,
      interactionPolicy: steer.session.interactionPolicy,
      prompt: steer.text,
      requestId: steer.requestId,
      // Steering text is literal, exactly as mail is: never a provider command.
      allowProviderCommands: false,
    },
    async (session, provider) => {
      // Under the dispatch fence, so whichever send entered first wins. A
      // queued prompt the user sent first keeps its place; a turn that started
      // since the miss is not interrupted by this one.
      const queue = await host.storage.getPromptQueue(queueKey);
      if (
        queue &&
        (queue.outstandingClaim !== undefined ||
          queue.inFlight !== undefined ||
          queue.messages.length > 0)
      ) {
        held = true;
        return { dispatch: false };
      }
      if ((await readProviderStatus(provider, session.providerSessionId)).status !== "idle") {
        held = true;
        return { dispatch: false };
      }
      return { dispatch: true };
    },
  );
  // A held admission opened no journal entry, so the id is still unsent.
  if (held) return enqueueMissedSteer(host, steer, queueKey);
  if (outcome.outcome === "accepted") {
    return { outcome: "applied", deliveredAs: "new-turn", requestId: steer.requestId };
  }
  if (outcome.outcome === "unknown") return { outcome: "unknown", requestId: steer.requestId };
  throw new Error(outcome.error);
}

async function enqueueMissedSteer(
  host: MissedSteerHost,
  steer: MissedSteer,
  queueKey: string,
): Promise<NativeAgentSessionActionOutcome> {
  const { status } = await host.storage.enqueuePromptQueueMessageIfAbsent(
    queueKey,
    steer.session.environmentId,
    {
      id: steer.requestId,
      requestId: steer.requestId,
      text: steer.text,
      // A carrier of literal text that leaves the session's own mode alone,
      // as a goal continuation does.
      command: { kind: "literal" },
      preserveSessionMode: true,
    },
  );
  try {
    host.notifyPromptQueueChanged(queueKey);
  } catch {
    // The drainer's periodic sweep is the safety net for a missed wake-up.
  }
  // `consumed`: a replay of an id that already left the queue.
  const sent =
    status === "consumed" &&
    (await host.storage.getNativeAgentSession(steer.key))?.dispatchedRequestIds?.includes(
      steer.requestId,
    );
  return {
    outcome: "applied",
    deliveredAs: sent ? "new-turn" : "queued",
    requestId: steer.requestId,
  };
}
