/**
 * The `merged` label on a Linear issue whose build's pull request merged
 * (docs/architecture/tickets.md, "Linear", "Merged builds label their issue").
 *
 * Merge handling only queues: every writer that sees a merge calls
 * `recordEnvironmentMerge` or `recordPipelineMerge`, which read the build
 * pipelines and store one pending record per Linear-sourced build's issue and
 * pull request (`linear-merged-labels`). Nothing there waits on Linear, so a
 * Linear outage never delays merge handling or environment deletion. The
 * drain then adds the label (`linear-issue-labels.ts`) and retries a failure
 * with backoff, capped at an hour, until it lands; pending records survive a
 * restart and the environment's deletion.
 *
 * Writers: the PR monitor's terminal follow-up (`pr-monitor-runtime.ts`), the
 * build finding its pull request already merged (`persistPullRequest`),
 * environment deletion when the environment recorded a merge
 * (`environment-delete.ts`), and the once-per-process sweep, which also
 * restarts the drain for records left pending by an earlier process.
 *
 * Only builds whose source is a Linear issue are queued; a Kanban or GitHub
 * build, and a pull request closed without merging, never reach Linear.
 */
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import { addLinearIssueLabelByName, type LinearIssueLabelResult } from "./linear-issue-labels.js";
import { sanitizeLinearError } from "./linear.js";
import type { Environment, PersistedBuildPipeline } from "./storage-shared.js";
import type { LinearMergedLabelInput, LinearStorage } from "./storage-linear.js";

const log = createLogger("linear");

/** The label a merged build's issue gets. */
export const LINEAR_MERGED_LABEL = "merged";
/** First retry after a failure; doubles per attempt. */
export const LINEAR_MERGED_LABEL_RETRY_MS = 60_000;
/** The longest wait between attempts. */
export const LINEAR_MERGED_LABEL_MAX_RETRY_MS = 60 * 60_000;

export interface LinearMergedLabelStorage {
  getEnvironment(environmentId: string): Promise<Environment | null>;
  listBuildPipelinesForEnvironment(
    projectId: string,
    environmentId: string,
  ): Promise<PersistedBuildPipeline[]>;
  listAllBuildPipelines(): Promise<PersistedBuildPipeline[]>;
  kanban: { getLinearAuth(): Promise<{ apiKey: string } | null> };
  linear: Pick<
    LinearStorage,
    | "listLinearMergedLabels"
    | "enqueueLinearMergedLabel"
    | "settleLinearMergedLabel"
    | "deferLinearMergedLabel"
  >;
}

export type LinearMergedLabelsOptions = {
  /** Test seam: the Linear call. Defaults to the real GraphQL client. */
  addLabel?: (apiKey: string, issueId: string, name: string) => Promise<LinearIssueLabelResult>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
};

/** The Linear issue a pipeline record was built from, or null for any other source. */
function linearSourceOf(
  record: Pick<PersistedBuildPipeline, "snapshot">,
): { issueId: string; issueIdentifier?: string } | null {
  const snapshot = record.snapshot as Partial<BuildPipeline> | undefined;
  const source = snapshot?.source;
  if (!source || source.type !== "linear") return null;
  const issueId = typeof source.issueId === "string" ? source.issueId.trim() : "";
  if (!issueId) return null;
  const identifier =
    typeof source.issueIdentifier === "string" && source.issueIdentifier
      ? source.issueIdentifier
      : undefined;
  return { issueId, ...(identifier ? { issueIdentifier: identifier } : {}) };
}

export function linearMergedLabelRetryDelay(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 16);
  return Math.min(LINEAR_MERGED_LABEL_RETRY_MS * 2 ** exponent, LINEAR_MERGED_LABEL_MAX_RETRY_MS);
}

/**
 * One backend's merged-label queue and its drain timer. Owned by
 * `BackendRuntime` as `linearMergedLabels`; `shutdown()` stops the timer.
 */
export class LinearMergedLabels {
  private storage: LinearMergedLabelStorage | null = null;
  private readonly addLabel: NonNullable<LinearMergedLabelsOptions["addLabel"]>;
  private readonly now: () => number;
  private readonly schedule: NonNullable<LinearMergedLabelsOptions["schedule"]>;
  private readonly cancel: NonNullable<LinearMergedLabelsOptions["cancel"]>;
  private timer: unknown = null;
  private timerDueAt = Number.POSITIVE_INFINITY;
  private draining: Promise<void> | null = null;
  private drainAgain = false;
  private swept = false;
  private closed = false;

  constructor(options: LinearMergedLabelsOptions = {}) {
    this.addLabel = options.addLabel ?? addLinearIssueLabelByName;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        (timer as { unref?: () => void }).unref?.();
        return timer;
      });
    this.cancel =
      options.cancel ?? ((timer) => clearTimeout(timer as Parameters<typeof clearTimeout>[0]));
  }

  /**
   * The environment's pull request merged: queues the label for each of its
   * Linear-sourced builds. Never throws; a failure to read or queue is logged.
   */
  async recordEnvironmentMerge(
    storage: LinearMergedLabelStorage,
    environment: Pick<Environment, "id" | "projectId">,
    prUrl: string,
  ): Promise<void> {
    if (this.closed || !prUrl) return;
    this.bind(storage);
    try {
      const records = await storage.listBuildPipelinesForEnvironment(
        environment.projectId,
        environment.id,
      );
      this.enqueue(storage, records, prUrl);
    } catch (error) {
      log.warn("merged-label.record-failed", {
        environmentId: environment.id,
        error: formatLogError(error),
      });
    }
    this.requestDrain();
  }

  /** As `recordEnvironmentMerge`, for an environment known only by id (the PR monitor). */
  async recordEnvironmentMergeById(
    storage: LinearMergedLabelStorage,
    environmentId: string,
    prUrl: string,
  ): Promise<void> {
    if (this.closed) return;
    let environment: Environment | null;
    try {
      environment = await storage.getEnvironment(environmentId);
    } catch (error) {
      log.warn("merged-label.record-failed", { environmentId, error: formatLogError(error) });
      return;
    }
    if (environment) await this.recordEnvironmentMerge(storage, environment, prUrl);
  }

  /** One pipeline's pull request merged (the build found it merged itself). Never throws. */
  recordPipelineMerge(
    storage: LinearMergedLabelStorage,
    pipeline: Pick<BuildPipeline, "id" | "projectId" | "source">,
    prUrl: string,
  ): void {
    if (this.closed || !prUrl) return;
    this.bind(storage);
    try {
      this.enqueue(
        storage,
        [{ id: pipeline.id, projectId: pipeline.projectId, snapshot: pipeline }],
        prUrl,
      );
    } catch (error) {
      log.warn("merged-label.record-failed", {
        pipelineId: pipeline.id,
        error: formatLogError(error),
      });
    }
    this.requestDrain();
  }

  /**
   * Once per process: queues merges recorded on environments that still hold
   * a Linear-sourced build (one the monitor applied before this feature, or a
   * merge seen while the backend was down), and restarts the drain for records
   * an earlier process left pending. Never throws.
   */
  sweepOnce(storage: LinearMergedLabelStorage): void {
    if (this.closed || this.swept) return;
    this.swept = true;
    this.bind(storage);
    void (async () => {
      const environments = new Map<string, Environment | null>();
      for (const record of await storage.listAllBuildPipelines()) {
        if (!linearSourceOf(record) || !record.environmentId) continue;
        if (!environments.has(record.environmentId)) {
          environments.set(
            record.environmentId,
            await storage.getEnvironment(record.environmentId),
          );
        }
        const environment = environments.get(record.environmentId);
        if (environment?.prState !== "merged" || !environment.prUrl) continue;
        this.enqueue(storage, [record], environment.prUrl);
      }
    })()
      .catch((error: unknown) => {
        log.warn("merged-label.record-failed", { error: formatLogError(error) });
      })
      .finally(() => this.requestDrain());
  }

  /** Stops the drain timer; later calls do nothing. */
  shutdown(): void {
    this.closed = true;
    this.clearTimer();
  }

  /** Resolves once the current drain (and any it queued) settles. Tests use it. */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private bind(storage: LinearMergedLabelStorage): void {
    this.storage = storage;
  }

  private enqueue(
    storage: LinearMergedLabelStorage,
    records: ReadonlyArray<Pick<PersistedBuildPipeline, "id" | "projectId" | "snapshot">>,
    prUrl: string,
  ): void {
    for (const record of records) {
      const source = linearSourceOf(record);
      if (!source) continue;
      const input: LinearMergedLabelInput = {
        ...source,
        pipelineId: record.id,
        projectId: record.projectId,
        prUrl,
      };
      const result = storage.linear.enqueueLinearMergedLabel(input, new Date(this.now()));
      if (result === "full") {
        log.warn("merged-label.queue-full", { pipelineId: record.id });
      }
    }
  }

  /** Starts a drain now, or once the running one finishes. */
  requestDrain(): void {
    if (this.closed || !this.storage) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.clearTimer();
    this.draining = this.drain()
      .catch((error: unknown) => {
        log.warn("merged-label.record-failed", { error: formatLogError(error) });
      })
      .finally(() => {
        this.draining = null;
        if (this.drainAgain) {
          this.drainAgain = false;
          this.requestDrain();
        }
      });
  }

  private async drain(): Promise<void> {
    const storage = this.storage;
    if (!storage) return;
    const pending = (await storage.linear.listLinearMergedLabels()).filter(
      (record) => record.status === "pending",
    );
    const now = this.now();
    const due = pending.filter((record) => Date.parse(record.nextAttemptAt) <= now);
    let apiKey: string | undefined;
    if (due.length > 0) {
      try {
        apiKey = (await storage.kanban.getLinearAuth())?.apiKey;
      } catch {
        apiKey = undefined;
      }
    }
    let nextDue = Number.POSITIVE_INFINITY;
    for (const record of pending) {
      if (this.closed) return;
      if (!due.includes(record)) {
        nextDue = Math.min(nextDue, Date.parse(record.nextAttemptAt));
        continue;
      }
      try {
        if (!apiKey) throw new Error("Linear is not connected on this machine");
        const result = await this.addLabel(apiKey, record.issueId, LINEAR_MERGED_LABEL);
        storage.linear.settleLinearMergedLabel(record.key, result.outcome, new Date(this.now()));
        log.info("merged-label.applied", {
          pipelineId: record.pipelineId,
          issue: record.issueIdentifier ?? record.issueId,
          outcome: result.outcome,
        });
      } catch (error) {
        const attempts = record.attempts + 1;
        const delay = linearMergedLabelRetryDelay(attempts);
        const reason = sanitizeLinearError(error, apiKey);
        const nextAttemptAt = this.now() + delay;
        storage.linear.deferLinearMergedLabel(record.key, {
          error: reason,
          nextAttemptAt: new Date(nextAttemptAt),
        });
        nextDue = Math.min(nextDue, nextAttemptAt);
        log.warn("merged-label.failed", {
          pipelineId: record.pipelineId,
          issue: record.issueIdentifier ?? record.issueId,
          attempts,
          retryInMs: delay,
          reason,
        });
      }
    }
    if (Number.isFinite(nextDue)) this.armTimer(nextDue);
  }

  private armTimer(dueAt: number): void {
    if (this.closed) return;
    if (this.timer !== null && this.timerDueAt <= dueAt) return;
    this.clearTimer();
    this.timerDueAt = dueAt;
    this.timer = this.schedule(
      () => {
        this.timer = null;
        this.timerDueAt = Number.POSITIVE_INFINITY;
        this.requestDrain();
      },
      Math.max(0, dueAt - this.now()),
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.timerDueAt = Number.POSITIVE_INFINITY;
  }
}
