import {
  BUILD_PIPELINE_AGENTS,
  type BuildPipelineAgent,
} from "@orkestrator/protocol/build-pipeline";
import type { PersistedPromptQueue } from "./models.js";
import { RecurringScheduler, type RecurringTimerFactory } from "./recurring-scheduler.js";
import {
  KeyedWorkflowSupervisor,
  type WorkflowDiscoveryResult,
  type WorkflowSupervisorStatus,
  type WorkflowWakeReason,
} from "./workflow-supervisor.js";

/**
 * Native launch intents and prompt queues as due keys (step 08, task 9).
 *
 * Replaces the 2 s timer that re-listed every environment and every prompt
 * queue. Each queue that owes a dispatch is its own key; the broad listings
 * become safety discovery. The drain, its per-queue coalescing, retry
 * backoff, durable reservation and dispatch journal are unchanged — this only
 * decides *when* the existing drain runs.
 *
 * | Obligation | Queue state | Why it is runnable |
 * | --- | --- | --- |
 * | `in-flight` | a reserved head (`inFlight`) | Reconcile a reservation after a crash or an ambiguous send, under the same request id; never a second dispatch. |
 * | `pending` | queued messages, no `dispatchError` | Dispatch once the session is idle and the environment ready. |
 *
 * A queue parked with `dispatchError` (including an ambiguous dispatch that
 * could not be reconciled) owes nothing until an explicit retry or discard,
 * which is a queue mutation and therefore a wakeup.
 *
 * Launch intent (`pendingAgentLaunch` on a creating/running environment) is
 * one recovery job: 2 s while any launch is pending (its own retry backoff
 * still applies), the safety cadence otherwise, and woken by every
 * environment change.
 */
export type NativeQueueObligation = "in-flight" | "pending";

export function nativeQueueObligation(
  queue: PersistedPromptQueue | null | undefined,
): NativeQueueObligation | null {
  if (!queue || queue.dispatchError !== undefined) return null;
  const agent = queue.queueKey.split("\0", 1)[0];
  if (!BUILD_PIPELINE_AGENTS.includes(agent as BuildPipelineAgent)) return null;
  if (queue.inFlight !== undefined) return "in-flight";
  return queue.messages.length > 0 ? "pending" : null;
}

export function discoverNativeQueues(
  queues: readonly PersistedPromptQueue[],
): WorkflowDiscoveryResult<NativeQueueObligation> {
  const entries: WorkflowDiscoveryResult<NativeQueueObligation>["entries"] = [];
  for (const queue of queues) {
    const obligation = nativeQueueObligation(queue);
    if (obligation) {
      entries.push({ key: queue.queueKey, obligation, target: queue.environmentId });
    }
  }
  return { entries, scanned: queues.length, complete: true };
}

export interface NativeQueueSchedulingHost {
  /** Runs the launch reconciliation; resolves with the pending launch count. */
  launchScan(): Promise<number>;
  listQueues(): Promise<PersistedPromptQueue[]>;
  /** The existing per-queue drain (coalesced, backoff-aware). */
  drainQueue(queueKey: string): Promise<void>;
  /** Monotonic ms until the queue's failure backoff ends (0 when not backing off). */
  queueRetryDelayMs(queueKey: string): number;
}

export interface NativeQueueSchedulingOptions {
  /** Fallback cadence for pending launches and pending queues (2 s). */
  progressIntervalMs: number;
  /** Safety discovery for launches and queues. */
  discoveryIntervalMs: number;
  now?: () => number;
  timers?: RecurringTimerFactory;
}

export class NativeQueueScheduling {
  private readonly queues: KeyedWorkflowSupervisor<NativeQueueObligation>;
  private launches: RecurringScheduler | null = null;

  constructor(
    private readonly host: NativeQueueSchedulingHost,
    private readonly options: NativeQueueSchedulingOptions,
  ) {
    this.queues = new KeyedWorkflowSupervisor<NativeQueueObligation>({
      domain: "native-queues",
      kind: "native-queue-scan",
      progressIntervalMs: options.progressIntervalMs,
      discoveryIntervalMs: options.discoveryIntervalMs,
      discover: async () => discoverNativeQueues(await host.listQueues()),
      advance: async (pass) => {
        // A backing-off queue waits out its backoff exactly as the old scan
        // filtered it; the next due time below lands on the backoff's end.
        if (host.queueRetryDelayMs(pass.key) > 0) return;
        await host.drainQueue(pass.key);
      },
      nextDelayMs: (key) => Math.max(options.progressIntervalMs, host.queueRetryDelayMs(key)),
      // The drain has its own per-queue coalescing and the provider reads it
      // performs are one status read per busy queue; bound them all the same.
      maxConcurrent: 8,
      ...(options.now ? { now: options.now } : {}),
      ...(options.timers ? { timers: options.timers } : {}),
    });
  }

  start(): void {
    if (this.launches) return;
    this.launches = new RecurringScheduler({
      owner: "agent-observation",
      limits: { maxConcurrent: 1, reservedConcurrency: 0, maxKeys: 8, reservedKeys: 1 },
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.timers ? { timers: this.options.timers } : {}),
    });
    this.launches.register({
      key: "launch",
      kind: "native-launch-scan",
      priority: "recovery",
      deadline: "hard",
      intervalMs: this.options.progressIntervalMs,
      initialDelayMs: this.options.progressIntervalMs,
      run: async () => {
        const pending = await this.host.launchScan();
        return {
          outcome: "success",
          nextDelayMs:
            pending > 0 ? this.options.progressIntervalMs : this.options.discoveryIntervalMs,
        };
      },
    });
    this.queues.start();
  }

  stop(): void {
    this.queues.stop();
    const launches = this.launches;
    this.launches = null;
    if (launches) void launches.dispose({ timeoutMs: 0 });
  }

  /** A queue was enqueued/changed or its session's turn ended. */
  wakeQueue(queueKey: string, reason: WorkflowWakeReason, environmentId?: string): void {
    this.queues.wake(queueKey, reason, environmentId);
  }

  /** Something about an environment changed: readiness, identity or launch intent. */
  wakeEnvironment(environmentId: string): void {
    this.launches?.requestSooner("launch");
    this.queues.wakeTarget(environmentId, "environment-change");
  }

  /**
   * A queue mutation for an environment. Known keys are woken; a queue the
   * index does not hold yet (another writer's enqueue) is found by a
   * discovery brought forward, which the listing makes authoritative.
   */
  queueChanged(environmentId: string): void {
    this.queues.wakeTarget(environmentId, "enqueue");
    this.queues.requestDiscovery();
  }

  note(queue: PersistedPromptQueue | null, queueKey: string): void {
    this.queues.note(queueKey, nativeQueueObligation(queue), queue?.environmentId);
  }

  status(): WorkflowSupervisorStatus {
    return this.queues.status();
  }
}
