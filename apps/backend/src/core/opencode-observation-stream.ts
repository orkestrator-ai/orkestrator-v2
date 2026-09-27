import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AGENT_INTERACTION_LIMITS } from "@orkestrator/protocol/agent-interactions";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import { ProviderUnavailableError, type ProviderActivityState } from "./agent-provider-contract.js";
import { assertSdkResponse, serializedByteLength } from "./agent-provider-runtime.js";
import { boundedOwnedOpenCodeCollection } from "./opencode-snapshots.js";
import type { OpenCodeSessionLifecycle } from "./opencode-session-lifecycle.js";
import {
  DEFAULT_MONITOR_RETRY_MS,
  MONITOR_HEALTHY_AFTER_MS,
  MONITOR_RETRY_CAP_FACTOR,
  type OpenCodeProviderDependencies,
} from "./opencode-provider-helpers.js";

/**
 * Reconnect policy for the OpenCode event monitor.
 *
 * Every provider watching an OpenCode server loses its stream when that
 * server restarts. A constant retry kept them all in lock-step for the whole
 * outage; consecutive failures now back off with jitter, and only a stream
 * that stayed up resets the ladder. The first retry is no slower.
 */
export function createOpenCodeMonitorBackoff(
  dependencies: OpenCodeProviderDependencies,
  now: () => number,
): ReconnectBackoff {
  const retryMs = Math.max(1, dependencies.monitorRetryMs ?? DEFAULT_MONITOR_RETRY_MS);
  return new ReconnectBackoff(
    {
      initialDelayMs: retryMs,
      maxDelayMs: Math.max(
        retryMs,
        dependencies.monitorRetryMaxMs ?? retryMs * MONITOR_RETRY_CAP_FACTOR,
      ),
      healthyAfterMs: MONITOR_HEALTHY_AFTER_MS,
    },
    {
      now,
      ...(dependencies.monitorRetryRandom ? { random: dependencies.monitorRetryRandom } : {}),
    },
  );
}

/**
 * Owned-session events after which the backend observer should re-read the
 * session: a new, answered or withdrawn question/approval, or an error. Status
 * changes are hinted where the provider applies them.
 */
const OBSERVATION_HINT_EVENTS: ReadonlySet<string> = new Set([
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "session.error",
]);

/**
 * The OpenCode provider's side of the backend observer's wakeup contract
 * (recurring-processes step 07): whether its event stream is live, and
 * content-free hints that an owned session may have changed.
 *
 * `live` is false from construction until the first connect and from every
 * gap until the next one, so the observer keeps its full cadence whenever a
 * turn started by another client could go unreported. Hints never throw into
 * the stream loop and are never applied as activity themselves.
 */
export class OpenCodeObservationStream {
  private live = false;
  private closed = false;

  constructor(private readonly hint?: (sessionId: string | undefined) => void) {}

  get isLive(): boolean {
    return this.live && !this.closed;
  }

  /** Connected: anything missed while disconnected needs a fresh read. */
  connected(): void {
    this.live = true;
    this.notify(undefined);
  }

  /** A gap: not live, and every owned session needs a fresh read. */
  lost(): void {
    this.live = false;
    this.notify(undefined);
  }

  /** An owned session's lifecycle status changed. */
  changed(sessionId: string): void {
    this.notify(sessionId);
  }

  /** Any owned-session event; hints only those that change pending input. */
  ownedEvent(type: string, sessionId: string): void {
    if (OBSERVATION_HINT_EVENTS.has(type)) this.notify(sessionId);
  }

  close(): void {
    this.closed = true;
    this.live = false;
  }

  private notify(sessionId: string | undefined): void {
    if (this.closed || !this.hint) return;
    try {
      this.hint(sessionId);
    } catch {
      // A failed hint only costs latency; the observer's sweep still runs.
    }
  }
}

/**
 * OpenCode's no-touch activity read for several sessions at once: lifecycle
 * from the event-fed status map (authoritative existence reads only for gaps),
 * and pending questions/approvals only when some session is running.
 */
export async function readOpenCodeActivityBatch(
  sessionIds: readonly string[],
  sources: {
    blockedSessions: ReadonlySet<string>;
    lifecycle: Pick<OpenCodeSessionLifecycle, "readSessionLifecycle">;
    client: OpencodeClient;
    directory: string | undefined;
    requestOptions: () => { signal: AbortSignal };
  },
): Promise<Map<string, ProviderActivityState>> {
  try {
    const activity = new Map<string, ProviderActivityState>();
    const sessionIdsToRead = [...new Set(sessionIds)].filter((sessionId) => {
      if (!sources.blockedSessions.has(sessionId)) return true;
      // A blocked session asked a question this provider will not answer, so
      // it is parked on a human. `status()` calls that `error` because a
      // pipeline must stop advancing on it; for the sidebar the honest
      // answer is `waiting`. `idle` is the one answer that is certainly
      // wrong — it retires the indicator on a turn nobody has resolved.
      activity.set(sessionId, "waiting");
      return false;
    });
    if (sessionIdsToRead.length === 0) return activity;

    const lifecycle = await sources.lifecycle.readSessionLifecycle(sessionIdsToRead, true);

    const runningSessionIds = new Set<string>();
    for (const sessionId of sessionIdsToRead) {
      const state = lifecycle.get(sessionId);
      if (state === "missing") {
        activity.set(sessionId, "missing");
      } else if (state === "running") {
        runningSessionIds.add(sessionId);
      } else if (state) {
        activity.set(sessionId, "idle");
      } else {
        throw new ProviderUnavailableError(`OpenCode lifecycle snapshot omitted ${sessionId}`);
      }
    }
    if (runningSessionIds.size === 0) return activity;

    const [questions, permissions] = await Promise.all([
      sources.client.question.list({ directory: sources.directory }, sources.requestOptions()),
      sources.client.permission.list({ directory: sources.directory }, sources.requestOptions()),
    ]);
    assertSdkResponse(questions, "OpenCode pending question read");
    assertSdkResponse(permissions, "OpenCode pending permission read");
    const pendingQuestions = boundedOwnedOpenCodeCollection(
      questions.data,
      runningSessionIds,
      "OpenCode pending question read",
    );
    const pendingPermissions = boundedOwnedOpenCodeCollection(
      permissions.data,
      runningSessionIds,
      "OpenCode pending permission read",
    );
    if (
      serializedByteLength([pendingQuestions, pendingPermissions]) >
      AGENT_INTERACTION_LIMITS.maxSerializedPayloadBytes
    ) {
      throw new ProviderUnavailableError("OpenCode interaction snapshot is oversized");
    }
    const waitingSessionIds = new Set<string>();
    for (const request of [...pendingQuestions, ...pendingPermissions]) {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        continue;
      }
      const sessionId = (request as { sessionID?: unknown }).sessionID;
      if (typeof sessionId === "string" && runningSessionIds.has(sessionId)) {
        waitingSessionIds.add(sessionId);
      }
    }
    for (const sessionId of runningSessionIds) {
      activity.set(sessionId, waitingSessionIds.has(sessionId) ? "waiting" : "working");
    }
    return activity;
  } catch (error) {
    if (error instanceof ProviderUnavailableError) throw error;
    throw new ProviderUnavailableError("OpenCode activity is unavailable", {
      cause: error,
    });
  }
}
