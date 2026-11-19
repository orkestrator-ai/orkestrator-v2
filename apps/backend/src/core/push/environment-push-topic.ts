import { createHash, randomBytes } from "node:crypto";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import { CONTAINER_LIFECYCLE_EVENT } from "@orkestrator/protocol/container-lifecycle";
import { ENVIRONMENT_ATTENTION_EVENT } from "@orkestrator/protocol/environment-attention";
import {
  NATIVE_AGENT_ACTIVITY_EVENT,
  parseNativeAgentActivityAnnouncement,
} from "@orkestrator/protocol/native-agent-observation";
import {
  ENVIRONMENT_PUSH_TOPIC,
  isEnvironmentPushKey,
  type EnvironmentPushPart,
  type PushStamp,
} from "@orkestrator/protocol/push-events";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { PushHubTimers, PushResolveAnswer, PushTopicProvider } from "./push-hub.js";

const log = createLogger("push");

export { ENVIRONMENT_PUSH_TOPIC };

/** Events naming one environment arrive in bursts; one read covers a burst. */
export const ENVIRONMENT_OBSERVE_COALESCE_MS = 100;
/**
 * While a tab waits on the user, its pending request is re-read this often:
 * some providers publish no event when a waiting tab's request changes. The
 * cadence each sidebar row used to poll at, now once per environment.
 */
export const ENVIRONMENT_OBSERVE_PENDING_MS = 15_000;
/** A waiting tab whose request did not answer within the registry's deadline. */
export const ENVIRONMENT_OBSERVE_PARTIAL_LADDER_MS: readonly number[] = [1_000, 3_000, 10_000];
/** After a failed read. */
export const ENVIRONMENT_OBSERVE_ERROR_MS = 2_000;

const ALL_PARTS: readonly EnvironmentPushPart[] = ["lifecycle", "attention", "sessions"];
const REGISTRY_PARTS: readonly EnvironmentPushPart[] = ["attention", "sessions"];

/** An environment record, as storage holds it. Only lifecycle and attention fields are read. */
export type EnvironmentPushRecord = Readonly<Record<string, unknown>>;

export interface EnvironmentPushTopicOptions {
  /** The record `get_environment` reads, or `null` when there is no such environment. */
  readEnvironment(environmentId: string): Promise<EnvironmentPushRecord | null>;
  /** `get_agent_registry` for one environment with `includePending` (the sidebar's read). */
  readRegistry(environmentId: string): Promise<AgentRegistrySnapshot>;
  /** Announce a key's change to its subscribers. */
  publish(key: string, stamp: PushStamp, parts: readonly EnvironmentPushPart[]): void;
  timers?: PushHubTimers;
  /** Monotonic milliseconds, the same clock as `timers`. */
  now?: () => number;
}

export interface EnvironmentPushTopicMetrics {
  observers: number;
  reads: number;
  readFailures: number;
  changes: number;
  wakes: number;
  /** Reads no event asked for: a waiting tab's pending request, or a partial answer. */
  reconciles: number;
}

type Digests = Partial<Record<EnvironmentPushPart, string>>;

interface Observer {
  key: string;
  generation: string;
  revision: number;
  digests: Digests;
  /** Parts an event (or the first read) asked to read. */
  dirty: Set<EnvironmentPushPart>;
  timer: unknown;
  /** When the scheduled read runs, so a later wake never postpones it. */
  dueAt: number | null;
  reconcileAt: number | null;
  reading: boolean;
  wakeAgain: boolean;
  stopped: boolean;
  partialAttempt: number;
}

const defaultTimers: PushHubTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function digest(value: unknown): string {
  // Held in memory to compare reads; never logged or sent (invariant 12).
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 22);
}

/** The record fields that say where the environment is in its lifecycle. */
export function environmentLifecycleDigest(record: EnvironmentPushRecord | null): string {
  if (!record) return "missing";
  const lifecycle = record.containerLifecycle as { revision?: unknown } | null | undefined;
  return digest([
    record.status ?? null,
    record.containerId ?? null,
    record.setupPhase ?? null,
    record.setupScriptsComplete ?? null,
    record.setupApprovalRequired ?? null,
    record.setupOverride ?? null,
    record.setupSessionId ?? null,
    record.deletionRequestedAt ?? null,
    record.lifecycleRemedy ?? null,
    record.pendingAgentLaunch ?? null,
    lifecycle && typeof lifecycle === "object" ? (lifecycle.revision ?? null) : null,
  ]);
}

/** What waits on the user in the environment: its waiting tabs and the record's attention. */
export function environmentAttentionDigest(
  environmentId: string,
  record: EnvironmentPushRecord | null,
  registry: AgentRegistrySnapshot | null,
): string {
  if (!record) return "missing";
  const waiting = (registry?.entries ?? [])
    .filter((entry) => entry.environmentId === environmentId && entry.state === "waiting")
    .map((entry) => [
      entry.ownerKind,
      entry.tabId,
      entry.tabOrdinal,
      entry.kind,
      entry.pending
        ? [
            entry.pending.interactionId,
            entry.pending.kind,
            entry.pending.label,
            entry.pending.detail ?? null,
            entry.pending.since,
            entry.pending.count,
          ]
        : null,
    ]);
  return digest([
    record.agentActivityState ?? null,
    record.hasWaitingNativeTab ?? null,
    record.hasUnreadWork ?? null,
    record.unreadReason ?? null,
    record.unreadRevision ?? null,
    record.lastActivityAt ?? null,
    waiting,
  ]);
}

/** The registry's tab counts for the environment. */
export function environmentSessionsDigest(
  environmentId: string,
  record: EnvironmentPushRecord | null,
  registry: AgentRegistrySnapshot | null,
): string {
  if (!record) return "missing";
  const summary = registry?.environments.find((item) => item.environmentId === environmentId);
  return digest(
    summary
      ? [
          summary.tabs,
          summary.working,
          summary.waiting,
          summary.idle,
          summary.stopped,
          summary.unknown,
        ]
      : null,
  );
}

function stringField(payload: unknown, field: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

/**
 * The `environment` topic: one environment's lifecycle and attention summary
 * (docs/architecture/push-events.md).
 *
 * While at least one connection subscribes to an environment, one observer
 * holds content-free digests of what the environment's readers show: the
 * record's lifecycle fields and container lifecycle revision (`lifecycle`),
 * its waiting tabs, their pending requests and the record's activity and
 * unread fields (`attention`), and the registry's tab counts (`sessions`).
 *
 * It does not poll. The backend's one emit passes every event here, and an
 * event that names the environment marks the parts it can move; one read
 * after a short coalescing window (the record, plus the agent registry when
 * `attention` or `sessions` is due) compares the digests, and only a part
 * whose digest moved is announced. The one exception is a tab waiting on the
 * user: its pending request is re-read every 15 s (and through 1, 3 and 10 s
 * when the registry's deadline left it unread), because some providers
 * announce no change to it. That reconcile is per retained key and stops with
 * the last subscriber.
 */
export class EnvironmentPushTopic implements PushTopicProvider {
  readonly topic = ENVIRONMENT_PUSH_TOPIC;
  /** An approval or question must not wait behind the key's throttle. */
  readonly urgentParts: readonly EnvironmentPushPart[] = ["attention"];
  private readonly observers = new Map<string, Observer>();
  private readonly timers: PushHubTimers;
  private readonly now: () => number;
  private readonly processGeneration = randomBytes(6).toString("base64url");
  private generationCounter = 0;
  private readonly counters = { reads: 0, readFailures: 0, changes: 0, wakes: 0, reconciles: 0 };

  constructor(private readonly options: EnvironmentPushTopicOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.now = options.now ?? (() => performance.now());
  }

  validKey(key: string): boolean {
    return isEnvironmentPushKey(key);
  }

  /** The same lookup `get_environment` and `get_container_lifecycle_snapshot` use. */
  async resolve(key: string): Promise<PushResolveAnswer> {
    if (!isEnvironmentPushKey(key)) return { status: "denied" };
    if (!(await this.options.readEnvironment(key))) return { status: "missing" };
    const observer = this.observers.get(key);
    if (!observer) return { status: "missing" };
    return { status: "ok", generation: observer.generation, revision: observer.revision };
  }

  retain(key: string): void {
    if (!isEnvironmentPushKey(key) || this.observers.has(key)) return;
    this.generationCounter += 1;
    const observer: Observer = {
      key,
      generation: `${this.processGeneration}.${this.generationCounter}`,
      revision: 0,
      digests: {},
      dirty: new Set(ALL_PARTS),
      timer: null,
      dueAt: null,
      reconcileAt: null,
      reading: false,
      wakeAgain: false,
      stopped: false,
      partialAttempt: 0,
    };
    this.observers.set(key, observer);
    this.schedule(observer, 0);
  }

  release(key: string): void {
    const observer = this.observers.get(key);
    if (!observer) return;
    observer.stopped = true;
    this.cancel(observer);
    this.observers.delete(key);
  }

  /**
   * Every backend event passes through here (the backend's one emit). Only an
   * event that names an observed environment marks parts; any other event
   * costs a string comparison and, at most, one map lookup.
   */
  observeEvent(event: string, payload: unknown): void {
    if (this.observers.size === 0) return;
    switch (event) {
      case NATIVE_AGENT_ACTIVITY_EVENT: {
        const announcement = parseNativeAgentActivityAnnouncement(payload);
        if (announcement) this.wake(announcement.environmentId, REGISTRY_PARTS);
        return;
      }
      case RESOURCE_CHANGED_EVENT: {
        const resource = stringField(payload, "resource");
        const id = stringField(payload, "id");
        if (!id) return;
        if (resource === "environment") this.wake(id, ALL_PARTS);
        else if (resource === "native-agent-session" || resource === "pane-layout") {
          this.wake(id, REGISTRY_PARTS);
        }
        return;
      }
      case ENVIRONMENT_ATTENTION_EVENT: {
        const id = stringField(payload, "environmentId");
        if (id) this.wake(id, ["attention"]);
        return;
      }
      case "native-agent-async-question": {
        const id = stringField(payload, "environment_id");
        if (id) this.wake(id, ["attention"]);
        return;
      }
      case CONTAINER_LIFECYCLE_EVENT: {
        const id = stringField(payload, "environmentId");
        if (id) this.wake(id, ["lifecycle"]);
        return;
      }
      case "environment-setup-started":
      case "environment-setup-complete": {
        const id = stringField(payload, "environment_id");
        if (id) this.wake(id, ["lifecycle"]);
        return;
      }
      default:
    }
  }

  /** Something says the environment moved: read the named parts soon. */
  wake(environmentId: string, parts: readonly EnvironmentPushPart[] = ALL_PARTS): void {
    const observer = this.observers.get(environmentId);
    if (!observer || observer.stopped) return;
    this.counters.wakes += 1;
    for (const part of parts) observer.dirty.add(part);
    if (observer.reading) {
      observer.wakeAgain = true;
      return;
    }
    this.scheduleNoLaterThan(observer, ENVIRONMENT_OBSERVE_COALESCE_MS);
  }

  isObserving(environmentId: string): boolean {
    return this.observers.has(environmentId);
  }

  metrics(): EnvironmentPushTopicMetrics {
    return { observers: this.observers.size, ...this.counters };
  }

  dispose(): void {
    for (const key of Array.from(this.observers.keys())) this.release(key);
  }

  // -------------------------------------------------------------------------

  private cancel(observer: Observer): void {
    if (observer.timer !== null) this.timers.clearTimeout(observer.timer);
    observer.timer = null;
    observer.dueAt = null;
  }

  private schedule(observer: Observer, delayMs: number): void {
    if (observer.stopped) return;
    this.cancel(observer);
    observer.dueAt = this.now() + delayMs;
    observer.timer = this.timers.setTimeout(() => {
      observer.timer = null;
      observer.dueAt = null;
      void this.read(observer);
    }, delayMs);
  }

  /** A burst of events shares one read: a later wake never postpones an earlier one. */
  private scheduleNoLaterThan(observer: Observer, delayMs: number): void {
    if (observer.timer !== null && observer.dueAt !== null) {
      if (observer.dueAt <= this.now() + delayMs) return;
    }
    this.schedule(observer, delayMs);
  }

  private async read(observer: Observer): Promise<void> {
    if (observer.stopped) return;
    if (observer.reading) {
      observer.wakeAgain = true;
      return;
    }
    // Include the reconcile in an event read if its deadline has arrived.
    if (observer.reconcileAt !== null && observer.reconcileAt <= this.now()) {
      this.counters.reconciles += 1;
      for (const part of REGISTRY_PARTS) observer.dirty.add(part);
    }
    const parts = Array.from(observer.dirty);
    observer.dirty.clear();
    observer.reading = true;
    observer.wakeAgain = false;
    this.counters.reads += 1;
    const environmentId = observer.key;
    const needsRegistry = parts.some((part) => part !== "lifecycle");
    let record: EnvironmentPushRecord | null = null;
    let registry: AgentRegistrySnapshot | null = null;
    let failed = false;
    try {
      record = await this.options.readEnvironment(environmentId);
      if (record && needsRegistry) registry = await this.options.readRegistry(environmentId);
    } catch (error) {
      failed = true;
      this.counters.readFailures += 1;
      log.debug("environment.read-failed", { error: formatLogError(error) });
    }
    observer.reading = false;
    if (observer.stopped) return;
    if (failed) {
      for (const part of parts) observer.dirty.add(part);
      this.schedule(observer, observer.wakeAgain ? 0 : ENVIRONMENT_OBSERVE_ERROR_MS);
      return;
    }

    const next: Digests = {};
    for (const part of parts) {
      next[part] =
        part === "lifecycle"
          ? environmentLifecycleDigest(record)
          : part === "attention"
            ? environmentAttentionDigest(environmentId, record, registry)
            : environmentSessionsDigest(environmentId, record, registry);
    }
    // A missing environment moves every part once, whichever was read.
    if (!record) for (const part of ALL_PARTS) next[part] = "missing";
    const moved = (Object.keys(next) as EnvironmentPushPart[]).filter(
      (part) => next[part] !== observer.digests[part],
    );
    Object.assign(observer.digests, next);
    // The first read starts from no digests, so it always publishes: the
    // subscriber's mount read and this baseline can race (as `native-session`).
    if (moved.length > 0) {
      observer.revision += 1;
      this.counters.changes += 1;
      this.options.publish(
        observer.key,
        { generation: observer.generation, revision: observer.revision },
        moved,
      );
    }
    if (registry || !record) {
      const delay = registry ? this.reconcileDelay(observer, environmentId, registry) : null;
      observer.reconcileAt = delay === null ? null : this.now() + delay;
    }
    if (observer.wakeAgain || observer.dirty.size > 0) {
      this.scheduleNoLaterThan(observer, ENVIRONMENT_OBSERVE_COALESCE_MS);
    }
    if (observer.reconcileAt !== null) {
      this.scheduleNoLaterThan(observer, Math.max(0, observer.reconcileAt - this.now()));
    }
  }

  /** When to look at a waiting tab again with no event, or `null` for never. */
  private reconcileDelay(
    observer: Observer,
    environmentId: string,
    registry: AgentRegistrySnapshot,
  ): number | null {
    const waiting = registry.entries.filter(
      (entry) =>
        entry.environmentId === environmentId &&
        entry.state === "waiting" &&
        entry.kind === "native",
    );
    if (waiting.length === 0) {
      observer.partialAttempt = 0;
      return null;
    }
    if (waiting.some((entry) => !entry.pending)) {
      const ladder = ENVIRONMENT_OBSERVE_PARTIAL_LADDER_MS;
      const delay = ladder[observer.partialAttempt];
      observer.partialAttempt += 1;
      if (delay !== undefined) return delay;
    } else {
      observer.partialAttempt = 0;
    }
    return ENVIRONMENT_OBSERVE_PENDING_MS;
  }
}
