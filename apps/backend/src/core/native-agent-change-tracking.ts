import {
  ProviderUnavailableError,
  type NativeAgentChangeTrackingHooks,
} from "./native-agent-service-shared.js";

export type ChangeTrackingDispatchOutcome = "accepted" | "rejected" | "uncertain";

/**
 * Capture a native-agent turn's start inside the at-most-once dispatch
 * window, before the provider can write, so an idle edit before dispatch is
 * preexisting state rather than this turn's work. Bounded; a failure is
 * recorded, never thrown, except in strict-checkpoint mode, which holds the
 * dispatch. Returns the callback that records how the dispatch settled.
 */
export async function beginChangeTrackingTurn(
  hooks: NativeAgentChangeTrackingHooks | null | undefined,
  session: {
    environmentId: string;
    logicalSessionKey: string;
    agent: string;
    providerSessionId: string;
  },
  requestId: string,
): Promise<(outcome: ChangeTrackingDispatchOutcome) => void> {
  if (!hooks) return () => undefined;
  const start = await hooks.prepareTurnStart({
    environmentId: session.environmentId,
    logicalSessionKey: session.logicalSessionKey,
    requestId,
    provider: session.agent,
    providerSessionId: session.providerSessionId,
  });
  if (start.kind === "held") {
    throw new ProviderUnavailableError(
      "Change tracking could not capture this turn's starting state (strict checkpoints are on).",
    );
  }
  return (outcome) =>
    hooks.markTurnDispatched(session.environmentId, session.logicalSessionKey, requestId, outcome);
}
