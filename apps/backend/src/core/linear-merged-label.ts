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
 * restart and the environment's deletion. On a machine with no Linear key they
 * stay due, and the attached command node lands them with its own key
 * (`linear-write-relay.ts`).
 *
 * Writers: the PR monitor's terminal follow-up (`git/pr-monitor-runtime.ts`), the
 * build finding its pull request already merged (`persistPullRequest`),
 * environment deletion when the environment recorded a merge
 * (`environments/delete.ts`), and the startup sweep, retried after incomplete
 * reads, which restarts the drain for records an earlier process left pending.
 *
 * Only builds whose source is a Linear issue are queued; a Kanban or GitHub
 * build, and a pull request closed without merging, never reach Linear.
 */
import {
  pipelineReachedPullRequestStage,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import { addLinearIssueLabelByName, type LinearIssueLabelResult } from "./linear-issue-labels.js";
import { sanitizeLinearError } from "./linear.js";
import {
  LINEAR_NOT_CONNECTED_HERE,
  LINEAR_WRITE_MAX_RETRY_MS,
  LinearDrainLoop,
  linearWriteRetryDelay,
  type LinearDrainClock,
} from "./linear-write-drain.js";
import type {
  Environment,
  PersistedBuildPipeline,
  LinearMergedLabelInput,
  LinearStorage,
} from "./storage/index.js";

const log = createLogger("linear");

/** The label a merged build's issue gets. */
export const LINEAR_MERGED_LABEL = "merged";

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
    | "noteLinearMergedLabelWaiting"
  >;
}

export type LinearMergedLabelsOptions = LinearDrainClock & {
  /** Test seam: the Linear call. Defaults to the real GraphQL client. */
  addLabel?: (
    apiKey: string,
    issueId: string,
    name: string,
    signal?: AbortSignal,
  ) => Promise<LinearIssueLabelResult>;
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

/**
 * One backend's merged-label queue and its drain timer. Owned by
 * `BackendRuntime` as `linearMergedLabels`; `shutdown()` stops the timer.
 */
export class LinearMergedLabels {
  private storage: LinearMergedLabelStorage | null = null;
  private readonly addLabel: NonNullable<LinearMergedLabelsOptions["addLabel"]>;
  private readonly loop: LinearDrainLoop;
  private swept = false;
  private sweeping: Promise<void> | null = null;

  constructor(options: LinearMergedLabelsOptions = {}) {
    this.addLabel = options.addLabel ?? addLinearIssueLabelByName;
    this.loop = new LinearDrainLoop(
      () => this.drain(),
      (error) => log.warn("merged-label.record-failed", { error: formatLogError(error) }),
      options,
    );
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
    if (this.loop.closed || !prUrl) return;
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
    if (this.loop.closed) return;
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
    pipeline: Pick<
      BuildPipeline,
      "id" | "projectId" | "source" | "sessions" | "shippedPullRequestUrl"
    >,
    prUrl: string,
  ): void {
    if (this.loop.closed || !prUrl) return;
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
   * Once per successful sweep: queues merges recorded on environments that
   * still hold a Linear build with matching Ship evidence (including a merge
   * seen while the backend was down), and restarts the drain for records
   * an earlier process left pending. Never throws.
   */
  sweepOnce(storage: LinearMergedLabelStorage): void {
    if (this.loop.closed || this.swept || this.sweeping) return;
    this.swept = true;
    this.bind(storage);
    this.sweeping = (async () => {
      let failed = false;
      const environments = new Map<string, Environment | null>();
      for (const record of await storage.listAllBuildPipelines()) {
        if (this.loop.closed) return;
        if (!linearSourceOf(record) || !record.environmentId) continue;
        try {
          if (!environments.has(record.environmentId)) {
            environments.set(
              record.environmentId,
              await storage.getEnvironment(record.environmentId),
            );
          }
          const environment = environments.get(record.environmentId);
          if (environment?.prState !== "merged" || !environment.prUrl) continue;
          this.enqueue(storage, [record], environment.prUrl);
        } catch (error) {
          failed = true;
          log.warn("merged-label.record-failed", {
            environmentId: record.environmentId,
            error: formatLogError(error),
          });
        }
      }
      if (failed) this.swept = false;
    })()
      .catch((error: unknown) => {
        this.swept = false;
        log.warn("merged-label.record-failed", { error: formatLogError(error) });
      })
      .finally(() => {
        this.sweeping = null;
        this.requestDrain();
      });
  }

  /** Stops the drain timer; later calls do nothing. */
  shutdown(): void {
    this.loop.stop("Merged label queue stopped");
  }

  /** Resolves once the current drain (and any it queued) settles. Tests use it. */
  async idle(): Promise<void> {
    while (this.sweeping || this.loop.running) {
      if (this.sweeping) await this.sweeping;
      if (this.loop.running) await this.loop.running;
    }
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
      const snapshot = record.snapshot as Partial<BuildPipeline> | undefined;
      if (
        !source ||
        !Array.isArray(snapshot?.sessions) ||
        !pipelineReachedPullRequestStage({ sessions: snapshot.sessions }) ||
        snapshot.shippedPullRequestUrl !== prUrl
      )
        continue;
      const input: LinearMergedLabelInput = {
        ...source,
        pipelineId: record.id,
        projectId: record.projectId,
        prUrl,
      };
      storage.linear.enqueueLinearMergedLabel(input, new Date(this.loop.now()));
    }
  }

  /** Starts a drain now, or once the running one finishes. */
  requestDrain(): void {
    if (this.storage) this.loop.request();
  }

  private async drain(): Promise<number> {
    const storage = this.storage;
    if (!storage) return Number.POSITIVE_INFINITY;
    const pending = (await storage.linear.listLinearMergedLabels()).filter(
      (record) => record.status === "pending",
    );
    const now = this.loop.now();
    const due = pending.filter((record) => Date.parse(record.nextAttemptAt) <= now);
    const apiKey = due.length > 0 ? (await storage.kanban.getLinearAuth())?.apiKey : undefined;
    let nextDue = Number.POSITIVE_INFINITY;
    for (const record of pending) {
      if (this.loop.closed) return Number.POSITIVE_INFINITY;
      if (!due.includes(record)) {
        nextDue = Math.min(nextDue, Date.parse(record.nextAttemptAt));
        continue;
      }
      if (!apiKey) {
        // Left due, not deferred: the attached command node may claim it
        // (`linear-write-relay.ts`), and connecting here drains at once.
        if (storage.linear.noteLinearMergedLabelWaiting(record.key, LINEAR_NOT_CONNECTED_HERE)) {
          log.info("merged-label.waiting", {
            pipelineId: record.pipelineId,
            issue: record.issueIdentifier ?? record.issueId,
          });
        }
        nextDue = Math.min(nextDue, now + LINEAR_WRITE_MAX_RETRY_MS);
        continue;
      }
      try {
        const result = await this.loop.bounded(
          (signal) => this.addLabel(apiKey, record.issueId, LINEAR_MERGED_LABEL, signal),
          "Linear label attempt timed out",
        );
        storage.linear.settleLinearMergedLabel(
          record.key,
          result.outcome,
          new Date(this.loop.now()),
        );
        log.info("merged-label.applied", {
          pipelineId: record.pipelineId,
          issue: record.issueIdentifier ?? record.issueId,
          outcome: result.outcome,
        });
      } catch (error) {
        if (this.loop.closed) return Number.POSITIVE_INFINITY;
        const attempts = record.attempts + 1;
        const delay = linearWriteRetryDelay(attempts);
        const reason = sanitizeLinearError(error, apiKey);
        const nextAttemptAt = this.loop.now() + delay;
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
    return nextDue;
  }
}
