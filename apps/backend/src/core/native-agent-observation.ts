import { randomUUID } from "node:crypto";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import type { BuildPipelineAgent } from "@orkestrator/protocol/build-pipeline";
import type { ViewRevisionStamp } from "@orkestrator/protocol/view-sync";
import { NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS } from "@orkestrator/protocol/native-agent-observation";

const quietClientBackoff = (agent: BuildPipelineAgent): boolean =>
  (NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS as readonly string[]).includes(agent);

/**
 * Shared, bounded agent observations and next-due provider groups.
 *
 * The backend's activity sweep is the one observer of provider activity
 * (recurring-processes step 07). Everything else that wants to know whether a
 * native session is busy — prompt-queue drains, agent-mail delivery, the
 * coordinator, a workflow waiting on a turn — reads the observation it
 * produced instead of issuing its own provider read. This module owns the
 * mechanics of that sharing:
 *
 * - **Records.** One bounded, content-free record per durable session: when it
 *   was observed, the activity, the readiness and pending-interaction
 *   indicators, the dispatch sequence it was read against, and the provider
 *   group generation. No transcript is retained to answer an activity
 *   question.
 * - **Dispatch fences.** A read that started before, or while, a prompt was
 *   being dispatched to a session cannot be applied to that session: its idle
 *   is the provider's answer from *before* the new turn, and applying it after
 *   the dispatch recorded `working` would manufacture a turn-end edge that
 *   drains the next queued prompt, wakes mail and probes for a PR. Cached
 *   pre-dispatch idle therefore never advances anything.
 * - **Generation fences.** Replacing a group's provider (a new bridge process,
 *   a new port or token, an evicted client) bumps the group generation. A read
 *   that began under the previous generation is discarded, so late results
 *   from an obsolete observer are inert.
 * - **Due groups.** Groups that are running, cancelling, recovering, blocked,
 *   failing or not yet known are due on every sweep, exactly as before. A
 *   group whose sessions are all stably idle may back off *only* when its
 *   provider has a qualified wakeup for work started elsewhere (see
 *   {@link NATIVE_AGENT_OBSERVATION_CAPABILITIES}); any dispatch, durable
 *   session mutation, provider generation change or provider event wakes it.
 * - **Stamps.** Every announced activity transition carries a
 *   {@link ViewRevisionStamp} (`generation` = this broker's lifetime,
 *   contiguous `revision`), so a client can detect a missed invalidation as a
 *   gap (docs/architecture/event-snapshot-recovery.md).
 *
 * Nothing here performs I/O. The service owns reads, storage and edges; this
 * owns only what may be reused, what must be fenced and what is due.
 */

/**
 * How long a confirmed observation may be shared with a consumer that asks
 * without a stricter demand. Shorter than one sweep (2 s): it exists to join
 * bursts — a mail drain, a presence refresh and a coordinator read in the same
 * tick — not to stretch the cadence. The step 01 baseline records one sweep
 * per 2 s and a mail presence TTL of 4 s; neither is lengthened by this.
 */
export const OBSERVATION_FRESHNESS_MS = 1_000;

/**
 * Oldest observation a prompt-queue drain may treat as "still busy" to skip
 * its own (liveness-touching) provider status read. Two sweeps: a group that
 * stops being observed — failing, backed off, no sweep running — falls back to
 * the authoritative read instead of waiting forever on a stale `working`.
 */
export const QUEUE_BUSY_OBSERVATION_MAX_AGE_MS = 4_000;

/**
 * Oldest idle observation mail delivery may trust without an authoritative
 * provider read. Matches the mail presence TTL (`OBSERVED_PRESENCE_TTL_MS`).
 */
export const MAIL_INJECT_OBSERVATION_MAX_AGE_MS = 4_000;

/** Consecutive settled-idle reads before a qualified group may back off. */
export const STABLE_IDLE_READS_BEFORE_BACKOFF = 3;

/**
 * Safety-read ladder for a qualified, stably idle group. The ceiling is short
 * on purpose: the wakeup path is the primary discovery channel, this is only
 * the repair path for a missed provider event.
 */
export const STABLE_IDLE_BACKOFF_MS: readonly number[] = [4_000, 8_000, 15_000];

export const MAX_OBSERVATION_RECORDS = 4_096;
export const MAX_OBSERVATION_GROUPS = 2_048;
export const MAX_OBSERVATION_DISPATCH_FENCES = 4_096;

// ---------------------------------------------------------------------------
// Provider capability matrix
// ---------------------------------------------------------------------------

/**
 * What each provider adapter actually offers the backend observer, derived
 * from the current adapters and bridges (see the step 07 completion notes for
 * the evidence). Only two columns drive policy today:
 *
 * - `idleBackoffWakeup`: a stably idle group may back off only when the
 *   backend holds a push path that reports work started by anyone else.
 * - `quietClientBackoff`: derived from the protocol's
 *   `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`, which the renderer also reads;
 *   an idle view of this provider cannot change without an activity
 *   transition the backend announces.
 *
 * The other columns are recorded so a later step does not assume an event
 * from one provider has the same completeness on every provider.
 */
export interface NativeAgentObservationCapabilities {
  /** How the no-touch activity answer is produced. */
  activitySnapshot: "bridge-activity-route" | "sdk-event-fed-batch";
  /** Whether input parked on a person reads as `waiting` (vs `working`). */
  parkedInputReportsWaiting: boolean;
  /** `readyForInput` separates a free composer from background work. */
  readyForInput: boolean;
  /** Content-free async-question attention ids on the activity read. */
  asyncQuestionAttention: boolean;
  /** Conditional transcript reads: bridge revision, or a backend stream revision. */
  transcriptRevision: "bridge-revision" | "bridge-generation-only" | "backend-stream-revision";
  /** Authoritative pending-interaction read and whether it touches liveness. */
  pendingInteractions: "no-touch" | "touches-liveness" | "always-empty" | "sdk-list";
  /** The backend receives pushed turn/interaction events from this provider. */
  backendTurnEvents: boolean;
  /** How background children affect activity. */
  backgroundChildren:
    | "working-while-live-readiness-split"
    | "working-while-live"
    | "async-attention-only"
    | "not-modelled";
  /** What identifies a provider generation to the backend. */
  generationIdentity: "bridge-connection" | "sdk-connection";
  /** The activity read never touches liveness, hydrates or re-attaches. */
  noTouchActivity: true;
  /** Qualified wakeup for externally started work; null keeps every sweep. */
  idleBackoffWakeup: "provider-event-stream" | null;
  /** Qualified for the renderer's quiet idle-view backoff. */
  quietClientBackoff: boolean;
}

export const NATIVE_AGENT_OBSERVATION_CAPABILITIES: Readonly<
  Record<BuildPipelineAgent, NativeAgentObservationCapabilities>
> = Object.freeze({
  claude: {
    activitySnapshot: "bridge-activity-route",
    parkedInputReportsWaiting: true,
    readyForInput: true,
    asyncQuestionAttention: false,
    transcriptRevision: "bridge-generation-only",
    pendingInteractions: "touches-liveness",
    backendTurnEvents: false,
    backgroundChildren: "working-while-live-readiness-split",
    generationIdentity: "bridge-connection",
    noTouchActivity: true,
    idleBackoffWakeup: null,
    // Background task output can change an idle view while the backend keeps
    // reporting `working` with a released composer: no transition to announce.
    quietClientBackoff: quietClientBackoff("claude"),
  },
  codex: {
    activitySnapshot: "bridge-activity-route",
    parkedInputReportsWaiting: true,
    readyForInput: false,
    asyncQuestionAttention: true,
    transcriptRevision: "bridge-revision",
    pendingInteractions: "no-touch",
    backendTurnEvents: false,
    backgroundChildren: "async-attention-only",
    generationIdentity: "bridge-connection",
    noTouchActivity: true,
    idleBackoffWakeup: null,
    // Async questions and background terminals surface on an idle thread
    // without an activity transition.
    quietClientBackoff: quietClientBackoff("codex"),
  },
  cursor: {
    activitySnapshot: "bridge-activity-route",
    parkedInputReportsWaiting: false,
    readyForInput: false,
    asyncQuestionAttention: false,
    transcriptRevision: "bridge-revision",
    pendingInteractions: "always-empty",
    backendTurnEvents: false,
    backgroundChildren: "working-while-live",
    generationIdentity: "bridge-connection",
    noTouchActivity: true,
    idleBackoffWakeup: null,
    quietClientBackoff: quietClientBackoff("cursor"),
  },
  pi: {
    activitySnapshot: "bridge-activity-route",
    // Pi answers `blocked`; the backend normalizes it to `waiting`.
    parkedInputReportsWaiting: true,
    readyForInput: false,
    asyncQuestionAttention: false,
    transcriptRevision: "bridge-revision",
    pendingInteractions: "touches-liveness",
    backendTurnEvents: false,
    backgroundChildren: "not-modelled",
    generationIdentity: "bridge-connection",
    noTouchActivity: true,
    idleBackoffWakeup: null,
    quietClientBackoff: quietClientBackoff("pi"),
  },
  grok: {
    activitySnapshot: "bridge-activity-route",
    // A parked ACP approval reads as `working`; only an idle view is quiet.
    parkedInputReportsWaiting: false,
    readyForInput: false,
    asyncQuestionAttention: false,
    transcriptRevision: "bridge-revision",
    pendingInteractions: "no-touch",
    backendTurnEvents: false,
    backgroundChildren: "working-while-live",
    generationIdentity: "bridge-connection",
    noTouchActivity: true,
    idleBackoffWakeup: null,
    quietClientBackoff: quietClientBackoff("grok"),
  },
  opencode: {
    activitySnapshot: "sdk-event-fed-batch",
    parkedInputReportsWaiting: true,
    readyForInput: false,
    asyncQuestionAttention: false,
    transcriptRevision: "backend-stream-revision",
    pendingInteractions: "sdk-list",
    backendTurnEvents: true,
    backgroundChildren: "not-modelled",
    generationIdentity: "sdk-connection",
    noTouchActivity: true,
    idleBackoffWakeup: "provider-event-stream",
    quietClientBackoff: quietClientBackoff("opencode"),
  },
} satisfies Record<BuildPipelineAgent, NativeAgentObservationCapabilities>);

export function nativeAgentObservationCapabilities(
  agent: BuildPipelineAgent,
): NativeAgentObservationCapabilities | undefined {
  return Object.hasOwn(NATIVE_AGENT_OBSERVATION_CAPABILITIES, agent)
    ? NATIVE_AGENT_OBSERVATION_CAPABILITIES[agent]
    : undefined;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type NativeAgentObservationSource = "provider" | "dispatch" | "absent-bridge";

/** One bounded, content-free observation of one durable session. */
export interface NativeAgentObservationRecord {
  readonly sessionKey: string;
  readonly groupKey: string;
  readonly providerSessionId: string;
  /** Group generation the read ran under. */
  readonly generation: number;
  /** `now()` when the read that produced this started. */
  readonly observedAt: number;
  readonly activity: AgentActivityState;
  readonly readyForInput?: boolean;
  /** A question, approval or async question needs a person. */
  readonly pendingInteraction: boolean;
  /** Dispatch sequence the read was taken against. */
  readonly dispatchSequence: number;
  readonly source: NativeAgentObservationSource;
}

/**
 * `fresh` — within the caller's age bound; `stale` — older; `recovering` —
 * the group's last read failed and is backing off; `unknown` — never observed
 * (or observed under a replaced provider session).
 */
export type NativeAgentObservationFreshness = "fresh" | "stale" | "recovering" | "unknown";

export interface NativeAgentObservationView {
  readonly record?: NativeAgentObservationRecord;
  readonly freshness: NativeAgentObservationFreshness;
  readonly ageMs?: number;
  /**
   * No dispatch started since the record's read began, and none is in flight.
   * Only a post-dispatch observation may release work that waits for idle.
   */
  readonly postDispatch: boolean;
}

export interface NativeAgentObservationDemand {
  /** Oldest acceptable observation. Defaults to {@link OBSERVATION_FRESHNESS_MS}. */
  maxAgeMs?: number;
  /** Require an observation read after every dispatch to the session. */
  requirePostDispatch?: boolean;
}

/** Whether a view satisfies a consumer's demand without a new read. */
export function observationSatisfies(
  view: NativeAgentObservationView,
  demand: NativeAgentObservationDemand = {},
): boolean {
  if (!view.record || view.freshness === "recovering" || view.ageMs === undefined) return false;
  if (view.ageMs > (demand.maxAgeMs ?? OBSERVATION_FRESHNESS_MS)) return false;
  return demand.requirePostDispatch ? view.postDispatch : true;
}

/** Captured at the start of one group read; decides what may be applied. */
export interface NativeAgentObservationTicket {
  readonly groupKey: string;
  readonly generation: number;
  readonly startedAt: number;
  readonly sequences: ReadonlyMap<string, number>;
  readonly dispatchesInFlight: ReadonlySet<string>;
}

export type NativeAgentObservationWakeReason =
  | "dispatch"
  | "session-mutation"
  | "provider-generation"
  | "provider-event"
  | "projection-read"
  | "demand";

interface GroupState {
  generation: number;
  nextDueAt: number;
  stableIdleReads: number;
  failing: boolean;
}

interface DispatchFence {
  sequence: number;
  inFlight: number;
}

export interface NativeAgentObservationStatus {
  records: number;
  groups: number;
  backedOffGroups: number;
  failingGroups: number;
  dispatchFences: number;
  fencedResults: number;
  generationFencedResults: number;
  wakes: Record<NativeAgentObservationWakeReason, number>;
}

function groupKeyEnvironmentId(groupKey: string): string {
  const separator = groupKey.indexOf("\0");
  return separator < 0 ? groupKey : groupKey.slice(0, separator);
}

export function nativeAgentObservationGroupKey(
  environmentId: string,
  agent: BuildPipelineAgent,
): string {
  return `${environmentId}\0${agent}`;
}

export class NativeAgentObservationBroker {
  /** One lifetime of this observer; stamps are comparable only within it. */
  readonly generation: string;
  private revision = 0;
  private readonly records = new Map<string, NativeAgentObservationRecord>();
  private readonly groups = new Map<string, GroupState>();
  private readonly dispatches = new Map<string, DispatchFence>();
  private fencedResults = 0;
  private generationFencedResults = 0;
  private readonly wakes: Record<NativeAgentObservationWakeReason, number> = {
    dispatch: 0,
    "session-mutation": 0,
    "provider-generation": 0,
    "provider-event": 0,
    "projection-read": 0,
    demand: 0,
  };

  constructor(
    private readonly now: () => number,
    options: { generation?: string } = {},
  ) {
    this.generation = options.generation ?? randomUUID();
  }

  // -- stamps ---------------------------------------------------------------

  /** Allocate the stamp for one announced change. Contiguous per generation. */
  nextStamp(): ViewRevisionStamp {
    this.revision += 1;
    return { generation: this.generation, revision: this.revision };
  }

  /** Current position, for a client to anchor gap detection. */
  stamp(): ViewRevisionStamp {
    return { generation: this.generation, revision: this.revision };
  }

  // -- dispatch fences ------------------------------------------------------

  /**
   * Open a dispatch window for one session. Any observation read that started
   * before the returned release runs is refused for that session. Call the
   * release exactly once, whether the dispatch was accepted or failed.
   */
  beginDispatch(sessionKey: string, groupKey?: string): () => void {
    const fence = this.dispatches.get(sessionKey) ?? { sequence: 0, inFlight: 0 };
    fence.sequence += 1;
    fence.inFlight += 1;
    this.dispatches.delete(sessionKey);
    this.dispatches.set(sessionKey, fence);
    this.trimDispatchFences();
    if (groupKey) this.wakeGroup(groupKey, "dispatch");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.dispatches.get(sessionKey);
      if (!current) return;
      current.inFlight = Math.max(0, current.inFlight - 1);
      // The settle also advances the sequence, so a read captured while the
      // dispatch was in flight can never be mistaken for a post-dispatch one.
      current.sequence += 1;
    };
  }

  dispatchSequence(sessionKey: string): number {
    return this.dispatches.get(sessionKey)?.sequence ?? 0;
  }

  dispatchInFlight(sessionKey: string): boolean {
    return (this.dispatches.get(sessionKey)?.inFlight ?? 0) > 0;
  }

  private trimDispatchFences(): void {
    while (this.dispatches.size > MAX_OBSERVATION_DISPATCH_FENCES) {
      // Oldest idle fence first; an in-flight fence is never dropped.
      let evicted = false;
      for (const [key, fence] of this.dispatches) {
        if (fence.inFlight === 0) {
          this.dispatches.delete(key);
          // Its records were taken against a sequence that no longer exists.
          this.records.delete(key);
          evicted = true;
          break;
        }
      }
      if (!evicted) return;
    }
  }

  // -- reads ----------------------------------------------------------------

  beginRead(groupKey: string, sessionKeys: readonly string[]): NativeAgentObservationTicket {
    const sequences = new Map<string, number>();
    const dispatchesInFlight = new Set<string>();
    for (const key of sessionKeys) {
      sequences.set(key, this.dispatchSequence(key));
      if (this.dispatchInFlight(key)) dispatchesInFlight.add(key);
    }
    return {
      groupKey,
      generation: this.groupGeneration(groupKey),
      startedAt: this.now(),
      sequences,
      dispatchesInFlight,
    };
  }

  /**
   * Re-anchor a ticket to the provider generation actually being read from.
   * Dispatch sequences stay as captured: they must predate every read.
   */
  withCurrentGeneration(ticket: NativeAgentObservationTicket): NativeAgentObservationTicket {
    return { ...ticket, generation: this.groupGeneration(ticket.groupKey) };
  }

  /**
   * Whether this ticket's result may be applied to one session: same group
   * generation, no dispatch started or settled since, none in flight at start.
   */
  accepts(ticket: NativeAgentObservationTicket, sessionKey: string): boolean {
    if (ticket.generation !== this.groupGeneration(ticket.groupKey)) {
      this.generationFencedResults += 1;
      return false;
    }
    if (
      ticket.dispatchesInFlight.has(sessionKey) ||
      (ticket.sequences.get(sessionKey) ?? 0) !== this.dispatchSequence(sessionKey)
    ) {
      this.fencedResults += 1;
      return false;
    }
    return true;
  }

  record(
    ticket: NativeAgentObservationTicket,
    input: {
      sessionKey: string;
      providerSessionId: string;
      activity: AgentActivityState;
      readyForInput?: boolean;
      pendingInteraction?: boolean;
      source?: NativeAgentObservationSource;
    },
  ): NativeAgentObservationRecord {
    const record: NativeAgentObservationRecord = {
      sessionKey: input.sessionKey,
      groupKey: ticket.groupKey,
      providerSessionId: input.providerSessionId,
      generation: ticket.generation,
      observedAt: ticket.startedAt,
      activity: input.activity,
      ...(input.readyForInput !== undefined ? { readyForInput: input.readyForInput } : {}),
      pendingInteraction: input.pendingInteraction ?? input.activity === "waiting",
      dispatchSequence: ticket.sequences.get(input.sessionKey) ?? 0,
      source: input.source ?? "provider",
    };
    this.store(record);
    return record;
  }

  /** Provider acceptance of a prompt is itself an authoritative `working`. */
  recordDispatchAccepted(input: {
    sessionKey: string;
    groupKey: string;
    providerSessionId: string;
  }): void {
    this.store({
      sessionKey: input.sessionKey,
      groupKey: input.groupKey,
      providerSessionId: input.providerSessionId,
      generation: this.groupGeneration(input.groupKey),
      observedAt: this.now(),
      activity: "working",
      pendingInteraction: false,
      // Taken inside the window: never post-dispatch, which is exactly right
      // for a `working` that must not release anything waiting for idle.
      dispatchSequence: this.dispatchSequence(input.sessionKey),
      source: "dispatch",
    });
  }

  private store(record: NativeAgentObservationRecord): void {
    this.records.delete(record.sessionKey);
    this.records.set(record.sessionKey, record);
    while (this.records.size > MAX_OBSERVATION_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  view(sessionKey: string, providerSessionId?: string): NativeAgentObservationView {
    const record = this.records.get(sessionKey);
    if (
      !record ||
      (providerSessionId !== undefined && record.providerSessionId !== providerSessionId)
    ) {
      return { freshness: "unknown", postDispatch: false };
    }
    const ageMs = Math.max(0, this.now() - record.observedAt);
    const postDispatch =
      record.source !== "dispatch" &&
      !this.dispatchInFlight(sessionKey) &&
      record.dispatchSequence === this.dispatchSequence(sessionKey);
    const failing = this.groups.get(record.groupKey)?.failing === true;
    return {
      record,
      ageMs,
      postDispatch,
      freshness: failing ? "recovering" : ageMs <= OBSERVATION_FRESHNESS_MS ? "fresh" : "stale",
    };
  }

  forget(sessionKey: string): void {
    this.records.delete(sessionKey);
  }

  /** Drop records for sessions that are gone or whose provider id rotated. */
  retainSessions(live: ReadonlyMap<string, string>): void {
    for (const [key, record] of Array.from(this.records)) {
      if (live.get(key) !== record.providerSessionId) this.records.delete(key);
    }
    for (const [key, fence] of Array.from(this.dispatches)) {
      if (fence.inFlight === 0 && !live.has(key)) this.dispatches.delete(key);
    }
  }

  // -- groups ---------------------------------------------------------------

  private group(groupKey: string): GroupState {
    let state = this.groups.get(groupKey);
    if (!state) {
      state = { generation: 0, nextDueAt: 0, stableIdleReads: 0, failing: false };
      this.groups.set(groupKey, state);
      while (this.groups.size > MAX_OBSERVATION_GROUPS) {
        const oldest = this.groups.keys().next().value;
        if (oldest === undefined || oldest === groupKey) break;
        this.groups.delete(oldest);
      }
    }
    return state;
  }

  groupGeneration(groupKey: string): number {
    return this.groups.get(groupKey)?.generation ?? 0;
  }

  /**
   * The group's provider was replaced or dropped. Reads in flight against the
   * previous provider become inert and the group is due immediately.
   */
  replaceGroupGeneration(groupKey: string): void {
    const state = this.group(groupKey);
    state.generation += 1;
    state.stableIdleReads = 0;
    state.nextDueAt = 0;
    this.wakes["provider-generation"] += 1;
  }

  isGroupDue(groupKey: string): boolean {
    const state = this.groups.get(groupKey);
    return !state || state.nextDueAt <= this.now();
  }

  wakeGroup(groupKey: string, reason: NativeAgentObservationWakeReason): void {
    const state = this.groups.get(groupKey);
    this.wakes[reason] += 1;
    if (!state) return; // never observed: already due
    state.stableIdleReads = 0;
    state.nextDueAt = 0;
  }

  /** Wake every group of an environment, or only one agent's group. */
  wakeEnvironment(
    environmentId: string,
    reason: NativeAgentObservationWakeReason,
    agent?: string,
  ): void {
    this.wakes[reason] += 1;
    for (const [groupKey, state] of this.groups) {
      if (groupKeyEnvironmentId(groupKey) !== environmentId) continue;
      if (agent !== undefined && groupKey !== `${environmentId}\0${agent}`) continue;
      state.stableIdleReads = 0;
      state.nextDueAt = 0;
    }
  }

  /**
   * Schedule a group after a successful read. Only a group whose every
   * session was accepted and settled idle, whose provider holds a qualified
   * wakeup path that is live right now, may back off — and only after
   * {@link STABLE_IDLE_READS_BEFORE_BACKOFF} consecutive such reads.
   */
  noteGroupObserved(
    groupKey: string,
    outcome: { settledIdle: boolean; wakeupQualified: boolean },
  ): void {
    const state = this.group(groupKey);
    state.failing = false;
    if (!outcome.settledIdle || !outcome.wakeupQualified) {
      state.stableIdleReads = 0;
      state.nextDueAt = 0;
      return;
    }
    state.stableIdleReads += 1;
    const step = state.stableIdleReads - STABLE_IDLE_READS_BEFORE_BACKOFF;
    state.nextDueAt =
      step < 0
        ? 0
        : this.now() + STABLE_IDLE_BACKOFF_MS[Math.min(step, STABLE_IDLE_BACKOFF_MS.length - 1)]!;
  }

  /** A failed read: recovering until the next success; backoff stays the caller's. */
  noteGroupFailed(groupKey: string): void {
    const state = this.group(groupKey);
    state.failing = true;
    state.stableIdleReads = 0;
    state.nextDueAt = 0;
  }

  retainGroups(live: ReadonlySet<string>): void {
    for (const groupKey of Array.from(this.groups.keys())) {
      if (!live.has(groupKey)) this.groups.delete(groupKey);
    }
  }

  status(): NativeAgentObservationStatus {
    const now = this.now();
    let backedOffGroups = 0;
    let failingGroups = 0;
    for (const state of this.groups.values()) {
      if (state.nextDueAt > now) backedOffGroups += 1;
      if (state.failing) failingGroups += 1;
    }
    return {
      records: this.records.size,
      groups: this.groups.size,
      backedOffGroups,
      failingGroups,
      dispatchFences: this.dispatches.size,
      fencedResults: this.fencedResults,
      generationFencedResults: this.generationFencedResults,
      wakes: { ...this.wakes },
    };
  }

  clear(): void {
    this.records.clear();
    this.groups.clear();
    this.dispatches.clear();
  }
}
