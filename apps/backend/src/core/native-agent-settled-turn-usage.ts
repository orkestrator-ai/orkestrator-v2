import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type {
  NativeAgentRuntimeProvider,
  PersistedNativeAgentSession,
} from "./native-agent-service-shared.js";

const log = createLogger("usage-history");

/** Settle-time usage reads in flight, one per session; bounds a burst of outcomes. */
const MAX_IN_FLIGHT = 64;

export type SettledTurnUsageSession = Pick<
  PersistedNativeAgentSession,
  "key" | "environmentId" | "agent" | "logicalSessionKey" | "providerSessionId"
>;

export interface SettledTurnUsageDeps {
  /** Hands a provider usage report to the usage-history recorder; never blocks. */
  observe(session: SettledTurnUsageSession, usage: NativeAgentContextUsage | undefined): void;
}

/**
 * Records a turn's usage at the moment the backend first records how it ended.
 *
 * Usage history is otherwise fed only by projection and session-state reads,
 * so a turn started and awaited through the CLI (`session start --wait`) that
 * nobody opens a tab for was never counted until a later dispatch refreshed
 * the projection. An outcome is recorded once per turn, so this costs at most
 * one lightweight provider status read per turn, and none when the caller's
 * own observation already carried the per-turn usage.
 *
 * Never blocks and never throws: usage history is a report, and the outcome
 * it rides on must not wait for it or fail because of it.
 */
export class SettledTurnUsage {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: SettledTurnUsageDeps) {}

  record(
    session: SettledTurnUsageSession,
    provider: Pick<NativeAgentRuntimeProvider, "sessionStateSnapshot" | "refreshUsage"> | undefined,
    observed?: NativeAgentContextUsage,
  ): Promise<void> {
    if (observed?.turns?.length) {
      this.deps.observe(session, observed);
      return Promise.resolve();
    }
    if (!provider || !session.providerSessionId) return Promise.resolve();
    if (this.inFlight.has(session.key) || this.inFlight.size >= MAX_IN_FLIGHT) {
      return Promise.resolve();
    }
    const read = provider.sessionStateSnapshot
      ? () =>
          provider.sessionStateSnapshot!(session.providerSessionId).then(
            (snapshot) => snapshot.contextUsage,
          )
      : provider.refreshUsage
        ? () => provider.refreshUsage!(session.providerSessionId)
        : undefined;
    if (!read) return Promise.resolve();
    this.inFlight.add(session.key);
    return read()
      .then((usage) => this.deps.observe(session, usage))
      .catch((error: unknown) => {
        log.debug("settled-read.failed", { agent: session.agent, error: formatLogError(error) });
      })
      .finally(() => this.inFlight.delete(session.key));
  }
}
