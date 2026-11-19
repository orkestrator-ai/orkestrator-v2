import { randomBytes } from "node:crypto";
import {
  BUILD_PIPELINE_AGENTS,
  type BuildPipelineAgent,
} from "@orkestrator/protocol/build-pipeline";
import {
  DEFAULT_NATIVE_AGENT_LIVE_WINDOW,
  NATIVE_AGENT_LIVE_UPDATE_VERSION,
  type NativeAgentLiveUpdate,
} from "@orkestrator/protocol/native-agent";
import {
  NATIVE_AGENT_ACTIVITY_EVENT,
  NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS,
  NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS,
  parseNativeAgentActivityAnnouncement,
} from "@orkestrator/protocol/native-agent-observation";
import {
  NATIVE_SESSION_PUSH_TOPIC,
  formatNativeSessionPushKey,
  parseNativeSessionPushKey,
  type NativeSessionPushKey,
  type NativeSessionPushPart,
  type PushStamp,
} from "@orkestrator/protocol/push-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { PushHubTimers, PushResolveAnswer, PushTopicProvider } from "./push-hub.js";

const log = createLogger("push");

export { NATIVE_SESSION_PUSH_TOPIC };

/**
 * Observation cadence of one subscribed session. These are the cadences each
 * viewer polled at before push (recurring-work C01), now paid once per
 * session on the backend however many viewers there are, and never on the
 * wire unless something moved.
 */
export const NATIVE_SESSION_OBSERVE_RESPONSIVE_MS = 500;
export const NATIVE_SESSION_OBSERVE_IDLE_MS = 1_500;
/** The idle ladder a qualified provider backs off through (as the view's quiet backoff). */
export const NATIVE_SESSION_OBSERVE_QUIET_LADDER_MS: readonly number[] = [
  3_000, 5_000, 10_000, 15_000,
];
/** A part answered `pending` (the combined read's deadline passed): look again soon. */
export const NATIVE_SESSION_OBSERVE_PENDING_MS = 250;
/** After a failed read. */
export const NATIVE_SESSION_OBSERVE_ERROR_MS = 2_000;

/** Reconcile independently of wake delivery while an idle bridge is known observable. */
const NATIVE_SESSION_BRIDGE_BACKSTOP_MS = 30_000;

const RESPONSIVE_PHASES = new Set(["running", "blocked", "cancelling", "recovering"]);

export interface NativeSessionLiveRead {
  environmentId: string;
  agent: string;
  logicalSessionKey: string;
  transcriptToken?: string;
  stateToken?: string;
}

export interface NativeSessionPushTopicOptions {
  /** The same combined read the live view sends, with the observer's own tokens. */
  readLiveUpdate(input: NativeSessionLiveRead): Promise<NativeAgentLiveUpdate>;
  /** Whether the session exists: the same lookup `get_native_agent_session` uses. */
  sessionExists(key: NativeSessionPushKey): Promise<boolean>;
  /** Announce a key's change to its subscribers. */
  publish(key: string, stamp: PushStamp, parts: readonly NativeSessionPushPart[]): void;
  /**
   * Something outside the observer says the session moved. Shared settled
   * reads of it must not answer the next read.
   */
  onWake?(key: NativeSessionPushKey): void;
  canWakeFromBridge?(key: NativeSessionPushKey): boolean;
  /** The session is observed from now until the returned stop is called. */
  observeSession?(key: NativeSessionPushKey): () => void;
  timers?: PushHubTimers;
}

type PartStatus = "ok" | "missing" | "unavailable" | "pending" | "unknown";

interface Observer {
  key: string;
  parsed: NativeSessionPushKey;
  generation: string;
  revision: number;
  transcriptToken: string | undefined;
  stateToken: string | undefined;
  transcriptStatus: PartStatus;
  stateStatus: PartStatus;
  phase: string | undefined;
  quietObservation: boolean;
  providerSessionId?: string;
  quietIndex: number;
  timer: unknown;
  reading: boolean;
  wakeAgain: boolean;
  stopped: boolean;
  stopObserving: (() => void) | null;
}

export interface NativeSessionPushTopicMetrics {
  observers: number;
  reads: number;
  readFailures: number;
  changes: number;
  wakes: number;
}

const defaultTimers: PushHubTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The `native-session` topic (design D4, D7 and D9 step 3).
 *
 * While at least one connection subscribes to a session, one observer reads
 * that session's live update with tokens of its own, at the cadence a single
 * viewer used to poll at, and wakes at once on the session's activity
 * announcements and invalidations. When the transcript or state token moves
 * (or a part becomes missing or unavailable) the key's revision moves and the
 * hub announces it with the parts that changed. Viewers then read through the
 * same conditional read, which the progressive reads serve from the
 * observer's settled answer (`NativeAgentProgressiveReads.observedSettled`),
 * so N viewers cost one provider read per change, not N.
 *
 * The observer stops when the last subscriber lets go: an inactive or hidden
 * view is not subscribed, so nothing here keeps a session observed that no
 * one is looking at.
 */
export class NativeSessionPushTopic implements PushTopicProvider {
  readonly topic = NATIVE_SESSION_PUSH_TOPIC;
  private readonly observers = new Map<string, Observer>();
  private readonly timers: PushHubTimers;
  private readonly processGeneration = randomBytes(6).toString("base64url");
  private generationCounter = 0;
  private readonly counters = { reads: 0, readFailures: 0, changes: 0, wakes: 0 };

  constructor(private readonly options: NativeSessionPushTopicOptions) {
    this.timers = options.timers ?? defaultTimers;
  }

  validKey(key: string): boolean {
    const parsed = parseNativeSessionPushKey(key);
    return parsed !== null && (BUILD_PIPELINE_AGENTS as readonly string[]).includes(parsed.agent);
  }

  async resolve(key: string): Promise<PushResolveAnswer> {
    const parsed = parseNativeSessionPushKey(key);
    if (!parsed) return { status: "denied" };
    if (!(await this.options.sessionExists(parsed))) return { status: "missing" };
    const observer = this.observers.get(key);
    // Registered before this read (the hub retains first); one that is gone
    // was released while this ran, and the hub drops the answer's key anyway.
    if (!observer) return { status: "missing" };
    return { status: "ok", generation: observer.generation, revision: observer.revision };
  }

  retain(key: string): void {
    const parsed = parseNativeSessionPushKey(key);
    if (!parsed || this.observers.has(key)) return;
    this.generationCounter += 1;
    const observer: Observer = {
      key,
      parsed,
      generation: `${this.processGeneration}.${this.generationCounter}`,
      revision: 0,
      transcriptToken: undefined,
      stateToken: undefined,
      transcriptStatus: "unknown",
      stateStatus: "unknown",
      phase: undefined,
      quietObservation: false,
      quietIndex: 0,
      timer: null,
      reading: false,
      wakeAgain: false,
      stopped: false,
      stopObserving: null,
    };
    try {
      observer.stopObserving = this.options.observeSession?.(parsed) ?? null;
    } catch (error) {
      log.warn("native-session.observe-hook-failed", { error: formatLogError(error) });
    }
    this.observers.set(key, observer);
    this.schedule(observer, 0);
  }

  release(key: string): void {
    const observer = this.observers.get(key);
    if (!observer) return;
    observer.stopped = true;
    this.cancel(observer);
    this.observers.delete(key);
    observer.stopObserving?.();
    observer.stopObserving = null;
  }

  /**
   * Every backend event passes through here (the backend's one emit). Only a
   * session's activity announcement or invalidation wakes its observer; any
   * other event costs a string comparison.
   */
  observeEvent(event: string, payload: unknown): void {
    if (this.observers.size === 0) return;
    if (event === NATIVE_AGENT_ACTIVITY_EVENT) {
      const announcement = parseNativeAgentActivityAnnouncement(payload);
      if (!announcement) return;
      this.wakeMatching(
        announcement.environmentId,
        announcement.agent,
        announcement.logicalSessionKey,
      );
      return;
    }
    if (event === "resource-changed") {
      const change = payload as {
        resource?: unknown;
        id?: unknown;
        agent?: unknown;
        logicalSessionKey?: unknown;
      } | null;
      if (!change || change.resource !== "native-agent-session" || typeof change.id !== "string") {
        return;
      }
      this.wakeMatching(
        change.id,
        typeof change.agent === "string" ? change.agent : undefined,
        typeof change.logicalSessionKey === "string" ? change.logicalSessionKey : undefined,
      );
    }
  }

  /** Wake one observed session now (tests, and callers that know a session moved). */
  wake(key: NativeSessionPushKey): void {
    const observer = this.observers.get(formatNativeSessionPushKey(key));
    if (observer) this.wakeObserver(observer);
  }

  /** A bridge frame is a wake hint. Activity and projections still come from reads. */
  wakeProvider(environmentId: string, agent: string, providerSessionId?: string): void {
    for (const observer of this.observers.values()) {
      if (observer.parsed.environmentId !== environmentId || observer.parsed.agent !== agent)
        continue;
      if (providerSessionId !== undefined && observer.providerSessionId !== providerSessionId)
        continue;
      this.wakeObserver(observer);
    }
  }

  metrics(): NativeSessionPushTopicMetrics {
    return { observers: this.observers.size, ...this.counters };
  }

  dispose(): void {
    for (const key of Array.from(this.observers.keys())) this.release(key);
  }

  // -------------------------------------------------------------------------

  private wakeMatching(environmentId: string, agent?: string, logicalSessionKey?: string): void {
    for (const observer of Array.from(this.observers.values())) {
      if (observer.parsed.environmentId !== environmentId) continue;
      if (agent !== undefined && observer.parsed.agent !== agent) continue;
      if (
        logicalSessionKey !== undefined &&
        observer.parsed.logicalSessionKey !== logicalSessionKey
      )
        continue;
      this.wakeObserver(observer);
    }
  }

  private wakeObserver(observer: Observer): void {
    if (observer.stopped) return;
    this.counters.wakes += 1;
    observer.quietIndex = 0;
    try {
      this.options.onWake?.(observer.parsed);
    } catch (error) {
      log.warn("native-session.wake-hook-failed", { error: formatLogError(error) });
    }
    if (observer.reading) {
      observer.wakeAgain = true;
      return;
    }
    this.schedule(observer, 0);
  }

  private cancel(observer: Observer): void {
    if (observer.timer !== null) this.timers.clearTimeout(observer.timer);
    observer.timer = null;
  }

  private schedule(observer: Observer, delayMs: number): void {
    if (observer.stopped) return;
    this.cancel(observer);
    observer.timer = this.timers.setTimeout(() => {
      observer.timer = null;
      void this.read(observer);
    }, delayMs);
  }

  private async read(observer: Observer): Promise<void> {
    if (observer.stopped) return;
    if (observer.reading) {
      observer.wakeAgain = true;
      return;
    }
    observer.reading = true;
    observer.wakeAgain = false;
    this.counters.reads += 1;
    let update: NativeAgentLiveUpdate | null = null;
    try {
      update = await this.options.readLiveUpdate({
        ...observer.parsed,
        ...(observer.transcriptToken ? { transcriptToken: observer.transcriptToken } : {}),
        ...(observer.stateToken ? { stateToken: observer.stateToken } : {}),
      });
    } catch (error) {
      this.counters.readFailures += 1;
      log.debug("native-session.read-failed", { error: formatLogError(error) });
    }
    observer.reading = false;
    if (observer.stopped) return;
    if (!update) {
      this.schedule(observer, observer.wakeAgain ? 0 : NATIVE_SESSION_OBSERVE_ERROR_MS);
      return;
    }
    const parts = this.apply(observer, update);
    if (parts.length > 0) {
      observer.revision += 1;
      observer.quietIndex = 0;
      this.counters.changes += 1;
      this.options.publish(
        observer.key,
        { generation: observer.generation, revision: observer.revision },
        parts,
      );
    }
    this.schedule(
      observer,
      observer.wakeAgain ? 0 : this.nextDelay(observer, update, parts.length > 0),
    );
  }

  /** Applies one answer to the observer and returns the parts that moved. */
  private apply(observer: Observer, update: NativeAgentLiveUpdate): NativeSessionPushPart[] {
    const parts = new Set<NativeSessionPushPart>();

    const transcript = update.transcript;
    const transcriptStatus = partStatus(transcript.status);
    if (
      transcript.status === "unchanged" ||
      transcript.status === "delta" ||
      transcript.status === "snapshot"
    ) {
      if (transcript.token !== observer.transcriptToken) parts.add("transcript");
      observer.transcriptToken = transcript.token;
    } else if (transcript.status !== "pending") {
      if (transcriptStatus !== observer.transcriptStatus) parts.add("transcript");
      observer.transcriptToken = undefined;
    }
    if (transcriptStatus !== "pending") observer.transcriptStatus = transcriptStatus;

    const state = update.state;
    const stateStatus = partStatus(state.status);
    if (state.status === "unchanged" || state.status === "snapshot") {
      if (state.token !== observer.stateToken) parts.add("state");
      observer.stateToken = state.token;
      if (state.status === "snapshot") {
        const phase = state.value.turn?.phase;
        if (observer.phase !== undefined && phase !== observer.phase) parts.add("discovery");
        observer.phase = phase;
        observer.providerSessionId = state.value.identity?.providerSessionId;
        observer.quietObservation = state.value.turn?.quietObservation === true;
      }
    } else if (state.status !== "pending") {
      if (stateStatus !== observer.stateStatus) parts.add("state");
      observer.stateToken = undefined;
      observer.quietObservation = false;
      observer.providerSessionId = undefined;
    }
    if (stateStatus !== "pending") observer.stateStatus = stateStatus;

    // The mount read and the observer query can race. Publish even the first
    // settled answer so a viewer cannot miss a change absorbed by the baseline.
    return Array.from(parts);
  }

  private nextDelay(observer: Observer, update: NativeAgentLiveUpdate, changed: boolean): number {
    if (update.transcript.status === "pending" || update.state.status === "pending") {
      return NATIVE_SESSION_OBSERVE_PENDING_MS;
    }
    if (observer.phase !== undefined && RESPONSIVE_PHASES.has(observer.phase)) {
      return NATIVE_SESSION_OBSERVE_RESPONSIVE_MS;
    }
    const agent = observer.parsed.agent;
    const qualified =
      (NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS as readonly string[]).includes(agent) &&
      (!(NATIVE_QUIET_BACKOFF_CONTENT_REVISION_PLATFORMS as readonly string[]).includes(agent) ||
        observer.quietObservation);
    if (
      observer.phase === "idle" &&
      observer.quietObservation &&
      observer.providerSessionId !== undefined &&
      this.options.canWakeFromBridge?.(observer.parsed)
    )
      return NATIVE_SESSION_BRIDGE_BACKSTOP_MS;
    if (!qualified || changed) return NATIVE_SESSION_OBSERVE_IDLE_MS;
    const ladder = NATIVE_SESSION_OBSERVE_QUIET_LADDER_MS;
    const delay = ladder[Math.min(observer.quietIndex, ladder.length - 1)]!;
    observer.quietIndex += 1;
    return delay;
  }
}

function partStatus(status: string): PartStatus {
  switch (status) {
    case "unchanged":
    case "delta":
    case "snapshot":
      return "ok";
    case "missing":
      return "missing";
    case "pending":
      return "pending";
    default:
      return "unavailable";
  }
}

export function nativeSessionLiveReadInput(input: NativeSessionLiveRead) {
  return {
    environmentId: input.environmentId,
    // `validKey` admitted only a build pipeline agent.
    agent: input.agent as BuildPipelineAgent,
    logicalSessionKey: input.logicalSessionKey,
    viewVersion: NATIVE_AGENT_LIVE_UPDATE_VERSION,
    pushObservation: true,
    liveWindow: { ...DEFAULT_NATIVE_AGENT_LIVE_WINDOW },
    ...(input.transcriptToken === undefined ? {} : { transcriptToken: input.transcriptToken }),
    ...(input.stateToken === undefined ? {} : { stateToken: input.stateToken }),
  };
}
