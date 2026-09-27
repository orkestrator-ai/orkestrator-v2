import { PR_MONITOR_CHANGED_EVENT, type PrState } from "@orkestrator/protocol/pr-monitor";
import {
  PR_CLOSED_COMMENT,
  PR_MERGED_COMMENT,
  PrMonitorService,
  type PrDetection,
  type PrMonitorDetectionOptions,
  type PrMonitorServiceOptions,
  type PrMonitorTarget,
} from "../../../apps/backend/src/core/pr-monitor";
import { ManualTime, flushMicrotasks } from "../../../apps/backend/src/core/recurring-test-support";
import { RecurringWorkMetrics } from "../../../apps/backend/src/core/recurring-work-metrics";
import { WorkAdmissionPool } from "../../../apps/backend/src/core/work-admission";

/**
 * Deterministic harness for lifecycle/admission tests of the backend PR
 * monitor: one manual clock drives the service's monotonic time and timers,
 * GitHub and storage are in-memory maps, and every effect is recorded.
 */

export const PR1 = "https://github.com/org/repo/pull/1";
export const PR2 = "https://github.com/org/repo/pull/2";

export interface FakeTask {
  taskId: string;
  status: string | null;
  prUrl: string | null;
  prState: PrState | null;
  prMergeCommented: boolean;
  comments: string[];
}

export interface GithubPr {
  url: string;
  state: PrState;
  hasMergeConflicts?: boolean | null;
  checkSummaryStatus?: PrDetection["checkSummaryStatus"];
}

type Detector = (
  target: PrMonitorTarget,
  options: PrMonitorDetectionOptions,
) => Promise<PrDetection | null>;

export interface LifecycleHarnessOptions {
  random?: () => number;
  admission?: WorkAdmissionPool;
  cooldownScope?: PrMonitorServiceOptions["cooldownScope"];
  policy?: PrMonitorServiceOptions["policy"];
  /** Omit the durable reread effect (older composition roots). */
  withoutReadTarget?: boolean;
}

export function terminalComment(state: "merged" | "closed", url = PR1): string {
  return `${state === "merged" ? PR_MERGED_COMMENT : PR_CLOSED_COMMENT}: ${url}`;
}

export function localTarget(
  environmentId: string,
  overrides: Partial<PrMonitorTarget> = {},
): PrMonitorTarget {
  return {
    environmentId,
    branch: `feature/${environmentId}`,
    kind: "local",
    worktreePath: `/tmp/${environmentId}`,
    ready: true,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    ...overrides,
  };
}

export function inProgressTask(overrides: Partial<FakeTask> = {}): FakeTask {
  return {
    taskId: "task-1",
    status: "in-progress",
    prUrl: null,
    prState: null,
    prMergeCommented: false,
    comments: [],
    ...overrides,
  };
}

export function createLifecycleHarness(options: LifecycleHarnessOptions = {}) {
  const time = new ManualTime(1_000_000);
  const metrics = new RecurringWorkMetrics({ now: time.now });
  const admission =
    options.admission ??
    new WorkAdmissionPool({ name: "external-pr", now: time.now, metrics, diagnostics: null });
  const emitted: Array<{ event: string; payload: any }> = [];
  const warnings: string[] = [];
  const scheduled: Array<{ environmentId: string | null; delayMs: number; at: number }> = [];

  /** What GitHub answers per environment; null means "no PR on this branch". */
  const github = new Map<string, GithubPr | null>();
  /** Durable environment PR fields, as `persistPr`/`clearPr` leave them. */
  const durable = new Map<string, { prUrl: string | null; prState: PrState | null }>();
  const tasks = new Map<string, FakeTask>();
  const detectors = new Map<string, Detector>();
  const failures = {
    comment: 0,
    metadata: 0,
    taskLookup: 0,
    resume: 0,
  };
  const calls = {
    detect: [] as Array<{ environmentId: string; at: number; options: PrMonitorDetectionOptions }>,
    persist: [] as Array<{ environmentId: string; detection: PrDetection }>,
    comments: [] as Array<{ taskId: string; text: string }>,
    metadata: [] as Array<{ taskId: string; updates: Record<string, unknown> }>,
    review: [] as string[],
    resume: [] as Array<{ environmentId: string; url: string; state: string }>,
    readTarget: [] as string[],
  };
  let inFlight = 0;
  let maxInFlight = 0;
  let resumeHook: ((environmentId: string) => void | Promise<void>) | null = null;
  let commentGate: Promise<void> | null = null;

  const defaultDetect: Detector = async (target, detectOptions) => {
    const pr = github.get(target.environmentId) ?? null;
    if (!pr) return null;
    const status =
      pr.checkSummaryStatus ??
      (pr.state === "open" && detectOptions.includeCheckSummary ? "succeeded" : "skipped");
    return {
      url: pr.url,
      state: pr.state,
      hasMergeConflicts: pr.hasMergeConflicts ?? false,
      checkSummary: status === "succeeded" ? { passed: 1, total: 1, pending: 0 } : null,
      checkSummaryStatus: status,
    };
  };

  const taskFor = (environmentId: string) => tasks.get(environmentId) ?? null;

  const service = new PrMonitorService({
    emit: (event, payload) => emitted.push({ event, payload }),
    onWarning: (message) => warnings.push(message),
    now: () => new Date(time.now()).toISOString(),
    monotonicNow: time.now,
    schedule: (callback, delayMs) => {
      scheduled.push({ environmentId: null, delayMs, at: time.now() });
      return time.setTimeout(callback, delayMs);
    },
    cancel: (handle) => time.clear(handle),
    random: options.random ?? (() => 0),
    metrics,
    admission,
    cooldownScope: options.cooldownScope,
    policy: options.policy,
    effects: {
      detect: async (target, detectOptions) => {
        calls.detect.push({
          environmentId: target.environmentId,
          at: time.now(),
          options: detectOptions,
        });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await (detectors.get(target.environmentId) ?? defaultDetect)(
            target,
            detectOptions,
          );
        } finally {
          inFlight -= 1;
        }
      },
      persistPr: async (environmentId, detection) => {
        calls.persist.push({ environmentId, detection });
        durable.set(environmentId, { prUrl: detection.url, prState: detection.state });
      },
      clearPr: async (environmentId) => {
        durable.set(environmentId, { prUrl: null, prState: null });
      },
      findTaskForEnvironment: async (environmentId) => {
        if (failures.taskLookup > 0) {
          failures.taskLookup -= 1;
          throw new Error("task storage unavailable");
        }
        const task = taskFor(environmentId);
        if (!task) return null;
        const snapshot = { ...task, comments: [...task.comments] };
        return {
          taskId: snapshot.taskId,
          status: snapshot.status,
          prUrl: snapshot.prUrl,
          prState: snapshot.prState,
          prMergeCommented: snapshot.prMergeCommented,
          hasCommentText: (text: string) => snapshot.comments.includes(text),
        };
      },
      moveTaskToReview: async (taskId) => {
        calls.review.push(taskId);
        for (const task of tasks.values()) if (task.taskId === taskId) task.status = "review";
      },
      addTaskComment: async (taskId, text) => {
        if (failures.comment > 0) {
          failures.comment -= 1;
          throw new Error("comment write failed");
        }
        if (commentGate) {
          const gate = commentGate;
          commentGate = null;
          await gate;
        }
        calls.comments.push({ taskId, text });
        for (const task of tasks.values()) if (task.taskId === taskId) task.comments.push(text);
      },
      updateTaskPrMetadata: async (taskId, updates) => {
        if (failures.metadata > 0) {
          failures.metadata -= 1;
          throw new Error("metadata write failed");
        }
        calls.metadata.push({ taskId, updates: updates as Record<string, unknown> });
        for (const task of tasks.values()) {
          if (task.taskId !== taskId) continue;
          if (updates.prUrl !== undefined) task.prUrl = updates.prUrl;
          if (updates.prState !== undefined) task.prState = updates.prState;
          if (updates.prMergeCommented !== undefined) {
            task.prMergeCommented = updates.prMergeCommented;
          }
        }
      },
      ...(options.withoutReadTarget
        ? {}
        : {
            readTarget: async (environmentId: string) => {
              calls.readTarget.push(environmentId);
              const stored = durable.get(environmentId);
              if (!stored) return null;
              return localTarget(environmentId, { ...stored, hasMergeConflicts: false });
            },
          }),
      resumeTerminalEffects: async (environmentId, observation) => {
        if (failures.resume > 0) {
          failures.resume -= 1;
          throw new Error("cleanup scheduler unavailable");
        }
        calls.resume.push({ environmentId, ...observation });
        await resumeHook?.(environmentId);
      },
    },
  });

  /** Registers an environment with durable PR fields and returns its target. */
  const addEnvironment = (
    environmentId: string,
    pr: { prUrl: string | null; prState: PrState | null } = { prUrl: null, prState: null },
    overrides: Partial<PrMonitorTarget> = {},
  ): PrMonitorTarget => {
    durable.set(environmentId, pr);
    return localTarget(environmentId, { ...pr, hasMergeConflicts: false, ...overrides });
  };

  /** Current durable targets, as `syncPrMonitorTracking` would build them. */
  const targets = (ids: string[], overrides: Partial<PrMonitorTarget> = {}) =>
    ids.map((id) =>
      localTarget(id, { ...durable.get(id), hasMergeConflicts: false, ...overrides }),
    );

  return {
    time,
    metrics,
    admission,
    service,
    github,
    durable,
    tasks,
    detectors,
    failures,
    calls,
    warnings,
    scheduled,
    addEnvironment,
    targets,
    advance: (ms: number) => time.advance(ms),
    flush: () => flushMicrotasks(),
    detections: (environmentId?: string) =>
      calls.detect.filter((call) => !environmentId || call.environmentId === environmentId).length,
    maxInFlight: () => maxInFlight,
    inFlight: () => inFlight,
    setResumeHook: (hook: typeof resumeHook) => {
      resumeHook = hook;
    },
    gateNextComment: () => {
      let release!: () => void;
      commentGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    events: () =>
      emitted.filter((entry) => entry.event === PR_MONITOR_CHANGED_EVENT).map((e) => e.payload),
    transitions: () =>
      emitted
        .filter((entry) => entry.event === PR_MONITOR_CHANGED_EVENT && entry.payload.transition)
        .map((entry) => entry.payload.transition),
    internals: (environmentId: string) =>
      (
        service as unknown as {
          entries: Map<string, { reconciliation: Map<string, unknown>; timer?: unknown }>;
        }
      ).entries.get(environmentId),
    reconciliationOperations: () =>
      (service as unknown as { reconciliationOperations: Map<string, unknown> })
        .reconciliationOperations.size,
  };
}

export type LifecycleHarness = ReturnType<typeof createLifecycleHarness>;
