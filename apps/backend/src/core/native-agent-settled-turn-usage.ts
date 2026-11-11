import type { NativeAgentContextUsage } from "@orkestrator/protocol/native-agent";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type {
  NativeAgentRuntimeProvider,
  PersistedNativeAgentSession,
} from "./native-agent-service-shared.js";

const log = createLogger("usage-history");

/** Settle-time usage reads in flight, one per session; bounds a burst of outcomes. */
export const SETTLED_USAGE_MAX_IN_FLIGHT = 64;
/** Sessions waiting for a read slot; beyond this the oldest becomes owed. */
export const SETTLED_USAGE_MAX_WAITING = 256;
/** Sessions whose settled read is owed a retry; beyond this the oldest is abandoned. */
export const SETTLED_USAGE_MAX_OWED = 256;
/** Failed reads of one session before its owed usage is abandoned. */
export const SETTLED_USAGE_MAX_ATTEMPTS = 3;

export type SettledTurnUsageSession = Pick<
  PersistedNativeAgentSession,
  "key" | "environmentId" | "agent" | "logicalSessionKey" | "providerSessionId"
>;

export type SettledTurnUsageProvider = Pick<
  NativeAgentRuntimeProvider,
  "sessionStateSnapshot" | "refreshUsage" | "recentTurnUsage"
>;

export interface SettledTurnUsageDeps {
  /** Hands a provider usage report to the usage-history recorder; never blocks. */
  observe(session: SettledTurnUsageSession, usage: NativeAgentContextUsage | undefined): void;
}

interface Request {
  session: SettledTurnUsageSession;
  provider: SettledTurnUsageProvider;
}

/**
 * Records a turn's usage at the moment the backend first records how it ended.
 *
 * Usage history is otherwise fed only by projection and session-state reads,
 * so a turn started and awaited through the CLI (`session start --wait`) that
 * nobody opens a tab for was never counted until a later dispatch refreshed
 * the projection. An outcome is recorded once per turn, so this costs at most
 * one lightweight provider usage read per turn, and none when the caller's
 * own observation already carried the per-turn usage (unless the provider's
 * lightweight reads carry only the newest response: `recentTurnUsage`).
 *
 * No request is silently lost:
 * - a turn that settles while its session's read is in flight marks that read
 *   for one fresh rerun, because the in-flight read may predate the turn;
 * - a request past the in-flight cap waits for a slot (bounded);
 * - a failed read, or a waiting request pushed out of the bounded queue, is
 *   owed: the session's next outcome or state read retries it, up to
 *   {@link SETTLED_USAGE_MAX_ATTEMPTS} failures, and abandoning one is a warning.
 *
 * Never blocks and never throws: usage history is a report, and the outcome
 * it rides on must not wait for it or fail because of it.
 */
export class SettledTurnUsage {
  /** Session key to the request to rerun once the current read finishes. */
  private readonly inFlight = new Map<string, { rerun?: Request }>();
  /** Requests waiting for a read slot, oldest first. */
  private readonly waiting = new Map<string, Request>();
  /** Sessions owed a retry, oldest first, with the failures so far. */
  private readonly owed = new Map<string, { request: Request; failures: number }>();

  constructor(private readonly deps: SettledTurnUsageDeps) {}

  record(
    session: SettledTurnUsageSession,
    provider: SettledTurnUsageProvider | undefined,
    observed?: NativeAgentContextUsage,
  ): void {
    if (observed?.turns?.length) {
      this.deps.observe(session, observed);
      // A lightweight observation is complete unless the provider says its
      // cheap reads carry only the newest response.
      if (!provider?.recentTurnUsage) return;
    }
    if (!provider || !session.providerSessionId || !usageReader(provider)) return;
    this.schedule({ session, provider });
  }

  /** Whether the session's settled usage is owed a retry. */
  owes(sessionKey: string): boolean {
    return this.owed.has(sessionKey);
  }

  /** Retries an owed read with the provider the caller just resolved. */
  retryOwed(
    session: SettledTurnUsageSession,
    provider: SettledTurnUsageProvider | undefined,
  ): void {
    const owed = this.owed.get(session.key);
    if (!owed || !provider || !usageReader(provider)) return;
    // The entry stays until a read succeeds or it is abandoned.
    this.schedule({ session, provider });
  }

  private schedule(request: Request): void {
    const key = request.session.key;
    const running = this.inFlight.get(key);
    if (running) {
      running.rerun = request;
      return;
    }
    if (this.inFlight.size >= SETTLED_USAGE_MAX_IN_FLIGHT) {
      this.waiting.delete(key);
      this.waiting.set(key, request);
      while (this.waiting.size > SETTLED_USAGE_MAX_WAITING) {
        const oldest = this.waiting.entries().next();
        if (oldest.done) break;
        this.waiting.delete(oldest.value[0]);
        this.owe(oldest.value[1], "queue-full");
      }
      return;
    }
    this.start(request);
  }

  private start(request: Request): void {
    const key = request.session.key;
    const read = usageReader(request.provider);
    if (!read) return;
    const slot: { rerun?: Request } = {};
    this.inFlight.set(key, slot);
    void read(request.session.providerSessionId)
      .then((usage) => {
        this.deps.observe(request.session, usage);
        this.owed.delete(key);
      })
      .catch((error: unknown) => {
        log.debug("settled-read.failed", {
          agent: request.session.agent,
          error: formatLogError(error),
        });
        this.owe(request, "read-failed");
      })
      .finally(() => {
        this.inFlight.delete(key);
        if (slot.rerun) this.start(slot.rerun);
        this.startWaiting();
      });
  }

  private startWaiting(): void {
    while (this.inFlight.size < SETTLED_USAGE_MAX_IN_FLIGHT && this.waiting.size > 0) {
      const next = this.waiting.entries().next();
      if (next.done) break;
      this.waiting.delete(next.value[0]);
      this.schedule(next.value[1]);
    }
  }

  private owe(request: Request, reason: "read-failed" | "queue-full"): void {
    const key = request.session.key;
    const previous = this.owed.get(key);
    const failures = (previous?.failures ?? 0) + (reason === "read-failed" ? 1 : 0);
    this.owed.delete(key);
    if (failures >= SETTLED_USAGE_MAX_ATTEMPTS) {
      log.warn("settled-read.abandoned", { agent: request.session.agent, reason, failures });
      return;
    }
    this.owed.set(key, { request, failures });
    while (this.owed.size > SETTLED_USAGE_MAX_OWED) {
      const oldest = this.owed.entries().next();
      if (oldest.done) break;
      this.owed.delete(oldest.value[0]);
      log.warn("settled-read.abandoned", {
        agent: oldest.value[1].request.session.agent,
        reason: "owed-full",
        failures: oldest.value[1].failures,
      });
    }
  }
}

/**
 * The cheapest read that lists every recent response's usage: OpenCode's
 * dedicated read, else the state snapshot (which carries recent turns on
 * every other provider), else the provider's usage refresh.
 */
function usageReader(
  provider: SettledTurnUsageProvider,
): ((sessionId: string) => Promise<NativeAgentContextUsage | undefined>) | undefined {
  if (provider.recentTurnUsage) return (id) => provider.recentTurnUsage!(id);
  if (provider.sessionStateSnapshot) {
    return (id) => provider.sessionStateSnapshot!(id).then((snapshot) => snapshot.contextUsage);
  }
  if (provider.refreshUsage) return (id) => provider.refreshUsage!(id);
  return undefined;
}
