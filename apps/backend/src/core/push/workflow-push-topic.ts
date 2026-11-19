import { randomBytes } from "node:crypto";
import { RESOURCE_CHANGED_EVENT, type ResourceChange } from "@orkestrator/protocol/resource-events";
import {
  WORKFLOW_PUSH_PARTS,
  WORKFLOW_PUSH_TOPIC,
  formatWorkflowPushKey,
  isWorkflowPushKind,
  parseWorkflowPushKey,
  type PushStamp,
  type WorkflowPushKey,
  type WorkflowPushPart,
} from "@orkestrator/protocol/push-events";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { PushHubTimers, PushResolveAnswer, PushTopicProvider } from "./push-hub.js";

const log = createLogger("push");

export { WORKFLOW_PUSH_TOPIC };

/** After a failed summary read the key is read again after this, doubling. */
export const WORKFLOW_OBSERVE_ERROR_MS = 2_000;
export const WORKFLOW_OBSERVE_ERROR_MAX_MS = 30_000;

/**
 * What the topic compares, never what it sends: a frame carries only the key,
 * the topic's stamp and part names. `revision` is the record's own storage
 * revision; `status` its phase or status; `terminal` whether that phase ends
 * the run.
 */
export interface WorkflowPushSummary {
  revision: number;
  status: string;
  terminal: boolean;
}

export interface WorkflowPushTopicOptions {
  /** The run's current summary from its authoritative record; `null` when there is none. */
  readSummary(key: WorkflowPushKey): Promise<WorkflowPushSummary | null>;
  /** Announce a key's change to its subscribers. */
  publish(key: string, stamp: PushStamp, parts: readonly WorkflowPushPart[]): void;
  timers?: PushHubTimers;
}

interface Observed {
  key: string;
  parsed: WorkflowPushKey;
  generation: string;
  revision: number;
  /** `undefined` until the first successful read sets the baseline. */
  summary: WorkflowPushSummary | null | undefined;
  reading: Promise<void> | null;
  readAgain: boolean;
  retryTimer: unknown;
  retryMs: number;
  stopped: boolean;
}

export interface WorkflowPushTopicMetrics {
  observers: number;
  reads: number;
  readFailures: number;
  changes: number;
  wakes: number;
}

const defaultTimers: PushHubTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Which parts moved between two summaries of one run. */
export function workflowChangedParts(
  previous: WorkflowPushSummary | null,
  next: WorkflowPushSummary | null,
): WorkflowPushPart[] {
  if (previous === null && next === null) return [];
  // The run appeared or went away: everything a view shows moved.
  if (previous === null || next === null) return [...WORKFLOW_PUSH_PARTS];
  const parts: WorkflowPushPart[] = [];
  if (previous.status !== next.status) parts.push("status");
  if (
    previous.revision !== next.revision ||
    previous.status !== next.status ||
    previous.terminal !== next.terminal
  ) {
    parts.push("progress");
  }
  if (previous.terminal !== next.terminal) parts.push("result");
  return parts;
}

/**
 * The `workflow` topic: build pipelines, Multi Reviews and graph runs.
 *
 * Unlike `native-session` it runs no poller. Every save of a run's record
 * announces a `resource-changed` for its kind and id, and every backend event
 * passes through {@link observeEvent}; for a subscribed run that is a wake,
 * which reads the run's summary (one storage read, joined while one is in
 * flight) and, when it moved, bumps the key's revision and publishes the
 * parts that changed. A run nobody subscribes to costs one map lookup per
 * event. A failed read is retried with backoff while the key stays
 * subscribed, and the viewers' own 30 s recovery poll covers the rest.
 *
 * Frames never announce completion: `result` means "read again", and the
 * view's read decides whether the run finished.
 */
export class WorkflowPushTopic implements PushTopicProvider {
  readonly topic = WORKFLOW_PUSH_TOPIC;
  private readonly observed = new Map<string, Observed>();
  private readonly timers: PushHubTimers;
  private readonly processGeneration = randomBytes(6).toString("base64url");
  private generationCounter = 0;
  private readonly counters = { reads: 0, readFailures: 0, changes: 0, wakes: 0 };

  constructor(private readonly options: WorkflowPushTopicOptions) {
    this.timers = options.timers ?? defaultTimers;
  }

  validKey(key: string): boolean {
    return parseWorkflowPushKey(key) !== null;
  }

  async resolve(key: string): Promise<PushResolveAnswer> {
    if (!parseWorkflowPushKey(key)) return { status: "denied" };
    const entry = this.observed.get(key);
    // Registered before this read (the hub retains first); one that is gone
    // was released while this ran, and the hub drops the answer's key anyway.
    if (!entry) return { status: "missing" };
    // Events keep a baseline current, so only a key without one reads here.
    if (entry.summary === undefined) await this.refresh(entry);
    if (entry.stopped) return { status: "missing" };
    if (entry.summary === undefined) throw new Error("Workflow summary read failed");
    if (entry.summary === null) return { status: "missing" };
    return { status: "ok", generation: entry.generation, revision: entry.revision };
  }

  retain(key: string): void {
    const parsed = parseWorkflowPushKey(key);
    if (!parsed || this.observed.has(key)) return;
    this.generationCounter += 1;
    this.observed.set(key, {
      key,
      parsed,
      generation: `${this.processGeneration}.${this.generationCounter}`,
      revision: 0,
      summary: undefined,
      reading: null,
      readAgain: false,
      retryTimer: null,
      retryMs: WORKFLOW_OBSERVE_ERROR_MS,
      stopped: false,
    });
  }

  release(key: string): void {
    const entry = this.observed.get(key);
    if (!entry) return;
    entry.stopped = true;
    this.cancelRetry(entry);
    this.observed.delete(key);
  }

  /**
   * Every backend event passes through here (the backend's one emit). Only a
   * `resource-changed` naming a subscribed run wakes it; any other event
   * costs a string comparison.
   */
  observeEvent(event: string, payload: unknown): void {
    if (this.observed.size === 0 || event !== RESOURCE_CHANGED_EVENT) return;
    const change = payload as Partial<ResourceChange> | null;
    if (!change || !isWorkflowPushKind(change.resource) || typeof change.id !== "string") return;
    const entry = this.observed.get(
      formatWorkflowPushKey({ kind: change.resource, id: change.id }),
    );
    if (!entry) return;
    this.counters.wakes += 1;
    void this.refresh(entry);
  }

  /** Read one subscribed run now (tests, and callers that know it moved). */
  wake(key: WorkflowPushKey): void {
    const entry = this.observed.get(formatWorkflowPushKey(key));
    if (entry) void this.refresh(entry);
  }

  metrics(): WorkflowPushTopicMetrics {
    return { observers: this.observed.size, ...this.counters };
  }

  dispose(): void {
    for (const key of Array.from(this.observed.keys())) this.release(key);
  }

  /** One read at a time per run; a wake during it reads once more afterwards. */
  private refresh(entry: Observed): Promise<void> {
    if (entry.reading) {
      entry.readAgain = true;
      return entry.reading;
    }
    const reading = (async () => {
      try {
        do {
          entry.readAgain = false;
          await this.readOnce(entry);
        } while (entry.readAgain && !entry.stopped);
      } finally {
        entry.reading = null;
      }
    })();
    entry.reading = reading;
    return reading;
  }

  private async readOnce(entry: Observed): Promise<void> {
    this.cancelRetry(entry);
    this.counters.reads += 1;
    let next: WorkflowPushSummary | null;
    try {
      next = await this.options.readSummary(entry.parsed);
    } catch (error) {
      this.counters.readFailures += 1;
      log.warn("workflow.read-failed", { kind: entry.parsed.kind, error: formatLogError(error) });
      this.scheduleRetry(entry);
      return;
    }
    if (entry.stopped) return;
    entry.retryMs = WORKFLOW_OBSERVE_ERROR_MS;
    const previous = entry.summary;
    entry.summary = next;
    // The first answer is the baseline: the subscriber reads once on it anyway.
    if (previous === undefined) return;
    const parts = workflowChangedParts(previous, next);
    if (parts.length === 0) return;
    entry.revision += 1;
    this.counters.changes += 1;
    try {
      this.options.publish(
        entry.key,
        { generation: entry.generation, revision: entry.revision },
        parts,
      );
    } catch (error) {
      log.warn("workflow.publish-failed", { error: formatLogError(error) });
    }
  }

  private scheduleRetry(entry: Observed): void {
    if (entry.stopped || entry.retryTimer !== null) return;
    const delay = entry.retryMs;
    entry.retryMs = Math.min(entry.retryMs * 2, WORKFLOW_OBSERVE_ERROR_MAX_MS);
    entry.retryTimer = this.timers.setTimeout(() => {
      entry.retryTimer = null;
      if (!entry.stopped) void this.refresh(entry);
    }, delay);
  }

  private cancelRetry(entry: Observed): void {
    if (entry.retryTimer === null) return;
    this.timers.clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
}
