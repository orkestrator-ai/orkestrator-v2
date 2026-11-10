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
import { OPENCODE_HEARTBEAT_EVENT } from "./opencode-events.js";

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
 * Longest silence an OpenCode event stream may have once it has proved it
 * heartbeats. `opencode serve` writes `server.heartbeat` every 10 s (observed
 * against 1.19.5), so this is three missed heartbeats plus slack for a busy
 * event loop on either side.
 */
export const OPENCODE_EVENT_STREAM_SILENCE_MS = 35_000;

/** Whether a raw `/event` frame is OpenCode's idle keepalive. */
export function isOpenCodeHeartbeat(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    (raw as { type?: unknown }).type === OPENCODE_HEARTBEAT_EVENT
  );
}

/** The time source and timers a silence watchdog runs on; tests substitute a fake. */
export interface OpenCodeSilenceClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface OpenCodeSilenceOptions {
  silenceMs?: number;
  clock?: OpenCodeSilenceClock;
}

const REAL_SILENCE_CLOCK: OpenCodeSilenceClock = {
  now: () => performance.now(),
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    // A deadline must never hold the process open on its own.
    (timer as { unref?: () => void }).unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Notices an OpenCode event stream that stays open but goes quiet, so the
 * monitor replaces it instead of trusting frozen activity until TCP gives up.
 *
 * One watchdog per connection. It is armed by the first `server.heartbeat`:
 * a server that never heartbeats (an OpenCode that predates the frame) is
 * legitimately silent while idle, and a deadline there would reconnect it
 * forever. Once armed, any frame counts as life. The timer re-checks the
 * elapsed silence rather than restarting on every frame, so a busy stream
 * costs no timer churn. `stop()` is the owner's explicit cancel (AGENTS.md
 * invariant 15); the monitor calls it whenever the connection ends.
 */
export class OpenCodeStreamSilenceWatchdog {
  private lastFrameAt = 0;
  private armed = false;
  private stopped = false;
  private timer: unknown;
  private readonly silenceMs: number;
  private readonly clock: OpenCodeSilenceClock;

  constructor(
    private readonly onSilent: (silenceMs: number) => void,
    options: OpenCodeSilenceOptions = {},
  ) {
    this.silenceMs = Math.max(1, options.silenceMs ?? OPENCODE_EVENT_STREAM_SILENCE_MS);
    this.clock = options.clock ?? REAL_SILENCE_CLOCK;
  }

  get isArmed(): boolean {
    return this.armed && !this.stopped;
  }

  /** A frame arrived; a heartbeat arms the deadline. */
  frame(heartbeat: boolean): void {
    if (this.stopped) return;
    this.lastFrameAt = this.clock.now();
    if (heartbeat && !this.armed) {
      this.armed = true;
      this.schedule(this.silenceMs);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) this.clock.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    this.timer = this.clock.setTimer(() => this.check(), delayMs);
  }

  private check(): void {
    this.timer = undefined;
    if (this.stopped) return;
    const silentFor = this.clock.now() - this.lastFrameAt;
    if (silentFor < this.silenceMs) {
      this.schedule(this.silenceMs - silentFor);
      return;
    }
    this.stop();
    this.onSilent(this.silenceMs);
  }
}

/** What {@link consumeOpenCodeEventStream} reports to the monitor that owns the connection. */
export interface OpenCodeEventStreamHandlers {
  disposed(): boolean;
  /** The first frame of this connection arrived. */
  connected(): void;
  /** A frame that is not a heartbeat; heartbeats are liveness only. */
  frame(raw: unknown): void;
  /** The connection heartbeated and then went quiet; the owner replaces it. */
  silent(silenceMs: number): void;
}

/**
 * Reads one `/event` connection until it ends. Open but silent is a loss too
 * (#2052), so a watchdog asks the owner to replace a stream
 * that stopped heartbeating; it is stopped whenever the connection ends.
 */
export async function consumeOpenCodeEventStream(
  stream: AsyncIterable<unknown>,
  handlers: OpenCodeEventStreamHandlers,
  options: OpenCodeSilenceOptions = {},
): Promise<"ended" | "disposed"> {
  const watchdog = new OpenCodeStreamSilenceWatchdog(handlers.silent, options);
  let receivedFrame = false;
  try {
    for await (const raw of stream) {
      if (handlers.disposed()) return "disposed";
      if (!receivedFrame) {
        receivedFrame = true;
        handlers.connected();
      }
      const heartbeat = isOpenCodeHeartbeat(raw);
      watchdog.frame(heartbeat);
      if (!heartbeat) handlers.frame(raw);
    }
    return "ended";
  } finally {
    watchdog.stop();
  }
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
    lifecycle: Pick<OpenCodeSessionLifecycle, "readSessionLifecycle">;
    client: OpencodeClient;
    directory: string | undefined;
    requestOptions: () => { signal: AbortSignal };
  },
): Promise<Map<string, ProviderActivityState>> {
  try {
    const activity = new Map<string, ProviderActivityState>();
    const sessionIdsToRead = [...new Set(sessionIds)];
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
