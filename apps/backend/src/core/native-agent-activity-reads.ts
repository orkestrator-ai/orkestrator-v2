import {
  isBatchableSessionId,
  SESSION_ACTIVITY_BATCH_LIMITS,
} from "@orkestrator/protocol/session-activity-batch";
import {
  type NativeAgentRuntimeProvider,
  type ProviderActivityObservation,
  type ProviderActivityState,
  ProviderUnavailableError,
  readProviderStatus,
} from "./agent-provider-contract.js";

/**
 * Reads in flight at once for one provider group: batch chunks and individual
 * fallback reads alike. Small, because every group already runs on one of the
 * sweep's `ACTIVITY_STATUS_CONCURRENCY` workers and they all share a bridge.
 */
export const ACTIVITY_GROUP_READ_CONCURRENCY = 4;

export interface ActivityGroupRead {
  state: ProviderActivityState;
  /** Present when the provider answered with a full observation. */
  observation?: ProviderActivityObservation;
}

/** One session's read through the provider's best single-session contract. */
async function readOne(
  provider: NativeAgentRuntimeProvider,
  sessionId: string,
): Promise<ActivityGroupRead> {
  if (provider.observeActivity) {
    const observation = await provider.observeActivity(sessionId);
    return { state: observation.state, observation };
  }
  if (provider.activity) return { state: await provider.activity(sessionId) };
  const { status } = await readProviderStatus(provider, sessionId);
  return {
    state:
      status === "missing"
        ? "missing"
        : status === "running"
          ? "working"
          : status === "blocked"
            ? "waiting"
            : "idle",
  };
}

type Unit<S> =
  | { kind: "batch"; sessions: S[]; sessionIds: string[] }
  | { kind: "single"; session: S };

/**
 * Read every session of one activity group and hand each answer to `apply`.
 *
 * - A provider with a group-wide `activityBatch` snapshot (OpenCode) is read
 *   exactly as before: one call, applied in group order.
 * - A provider with `observeActivityBatch` is read in chunks of at most
 *   `SESSION_ACTIVITY_BATCH_LIMITS.maxSessions` ids. `unsupported`, a rejected
 *   chunk and `deferred` ids fall back to individual reads for this sweep;
 *   an id the bridge answered `unavailable` is a failed read of that session.
 * - Everything else is read one session at a time, as before.
 *
 * Reads run with bounded concurrency, so one stalled session no longer holds
 * every later session of its group behind it. `apply` calls are serialized
 * (never concurrent) in completion order; each is independent per session.
 * After the first failure no new read starts — the group is going to back off
 * anyway, and continuing would only load an unhealthy bridge — but reads
 * already in flight still settle, and their successful answers are applied.
 * The first failure is then rethrown, which the caller handles exactly like a
 * failed per-session read: the group's observations stay uncertain.
 */
export async function readActivityGroup<S extends { providerSessionId: string }>(options: {
  provider: NativeAgentRuntimeProvider;
  sessions: readonly S[];
  apply: (session: S, read: ActivityGroupRead) => Promise<void>;
  concurrency?: number;
  chunkSize?: number;
}): Promise<void> {
  const { provider, sessions, apply } = options;
  if (provider.activityBatch) {
    const states = await provider.activityBatch(
      sessions.map((session) => session.providerSessionId),
    );
    for (const session of sessions) {
      const state = states.get(session.providerSessionId);
      if (!state) {
        throw new ProviderUnavailableError(
          `Provider activity snapshot omitted ${session.providerSessionId}`,
        );
      }
      await apply(session, { state });
    }
    return;
  }

  const queue: Unit<S>[] = [];
  if (provider.observeActivityBatch) {
    const chunkSize = Math.max(
      1,
      Math.min(
        options.chunkSize ?? SESSION_ACTIVITY_BATCH_LIMITS.maxSessions,
        SESSION_ACTIVITY_BATCH_LIMITS.maxSessions,
      ),
    );
    // Sessions sharing a provider session id are asked for once.
    const byId = new Map<string, S[]>();
    for (const session of sessions) {
      if (!isBatchableSessionId(session.providerSessionId)) {
        queue.push({ kind: "single", session });
        continue;
      }
      const sharing = byId.get(session.providerSessionId);
      if (sharing) sharing.push(session);
      else byId.set(session.providerSessionId, [session]);
    }
    const ids = [...byId.keys()];
    for (let start = 0; start < ids.length; start += chunkSize) {
      const sessionIds = ids.slice(start, start + chunkSize);
      queue.push({
        kind: "batch",
        sessionIds,
        sessions: sessionIds.flatMap((sessionId) => byId.get(sessionId)!),
      });
    }
  } else {
    for (const session of sessions) queue.push({ kind: "single", session });
  }

  let failure: { error: unknown } | undefined;
  const fail = (error: unknown): void => {
    failure ??= { error };
  };
  let applying: Promise<void> = Promise.resolve();
  const deliver = (session: S, read: ActivityGroupRead): void => {
    applying = applying.then(() => apply(session, read).catch(fail));
  };

  const run = async (unit: Unit<S>): Promise<void> => {
    try {
      if (unit.kind === "single") {
        deliver(unit.session, await readOne(provider, unit.session.providerSessionId));
        return;
      }
      let entries: Awaited<ReturnType<NonNullable<typeof provider.observeActivityBatch>>>;
      try {
        entries = await provider.observeActivityBatch!(unit.sessionIds);
      } catch {
        // Not evidence about any session, nor that the route is absent: read
        // this chunk individually for this sweep only.
        entries = "unsupported";
      }
      if (entries === "unsupported") {
        for (const session of unit.sessions) queue.push({ kind: "single", session });
        return;
      }
      for (const session of unit.sessions) {
        const entry = entries.get(session.providerSessionId);
        if (entry === "deferred") {
          queue.push({ kind: "single", session });
        } else if (entry === undefined || entry === "unavailable") {
          fail(
            new ProviderUnavailableError(
              `Provider activity unavailable for ${session.providerSessionId}`,
            ),
          );
        } else {
          deliver(session, { state: entry.state, observation: entry });
        }
      }
    } catch (error) {
      fail(error);
    }
  };

  const concurrency = Math.max(1, options.concurrency ?? ACTIVITY_GROUP_READ_CONCURRENCY);
  await new Promise<void>((resolve) => {
    let next = 0;
    let inFlight = 0;
    const launch = (): void => {
      while (!failure && inFlight < concurrency && next < queue.length) {
        const unit = queue[next++]!;
        inFlight += 1;
        // `run` never rejects: every failure is recorded through `fail`.
        void run(unit).then(() => {
          inFlight -= 1;
          launch();
        });
      }
      if (inFlight === 0) resolve();
    };
    launch();
  });
  await applying;
  if (failure) throw failure.error;
}
