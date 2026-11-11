import { randomUUID } from "node:crypto";
import { isEnvironmentReadyForAgents } from "@orkestrator/protocol/environment-readiness";
import {
  evaluatePrMergeReadiness,
  isPrReadingConfirmedByMonitor,
  type PrNotReadyReason,
} from "@orkestrator/protocol/pr-merge-readiness";
import type { PrMonitorEnvironmentState, PrMonitorEvent } from "@orkestrator/protocol/pr-monitor";
import { createResolveConflictsPrompt } from "@orkestrator/protocol/pr-prompt";
import { resolveEnvironmentActionDefault } from "./action-default-selection.js";
import type { CommandInvoker } from "./build-pipeline-service-helpers.js";
import type { Environment } from "./models.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import type { StorageService } from "./storage.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";

const log = createLogger("pull-request");

/**
 * Auto-merge: the backend merges an environment's open pull request as soon
 * as GitHub reports it ready, and launches the Resolve agent when it
 * conflicts.
 *
 * The switch is the environment's durable `autoMerge` flag, so it keeps
 * working with no window open and across a backend restart. Decisions are
 * driven by the PR monitor's announced readings, never by a renderer, and use
 * the same conservative readiness rule as the "ready to merge" shimmer
 * (`@orkestrator/protocol/pr-merge-readiness`): an unknown or stale signal
 * waits rather than merging. Failing or pending checks GitHub does not
 * require hold a merge back only while the machine's `autoMergeRequireChecks`
 * setting is on, and the shimmer follows the same setting; required checks
 * always do.
 *
 * Completed automatic Resolve turns can retry after a fresh conflict reading,
 * up to three attempts. Active or unconfirmed jobs retain the armed token.
 * Exhaustion turns integration off and stores an actionable error.
 *
 * There is one Resolve tab per environment. A later conflict episode sends
 * the prompt again to the open Resolve tab (manual or automatic) through the
 * job tab reuse path (`native-agent-job-tab-reuse.ts`): a settled tab runs it
 * now, a busy one queues it until its current work ends. A new tab opens only
 * when no Resolve tab is open or the open one cannot take a prompt.
 */

/**
 * First retry delay after a failed merge or launch; doubles per failure. Also
 * how long a successful attempt holds off repeating itself: a merge GitHub
 * accepted but has not completed (`pending`) still reads as open and clean.
 */
export const PR_AUTO_MERGE_RETRY_BASE_MS = 60_000;
/** Ceiling of the retry delay. */
export const PR_AUTO_MERGE_RETRY_MAX_MS = 15 * 60_000;
/** Pane title of an automatically launched Resolve, matching the button's. */
export const PR_AUTO_MERGE_RESOLVE_TAB_TITLE = "Resolve";

export type PrAutoMergeDecision =
  | { kind: "merge" }
  | { kind: "resolve" }
  | {
      kind: "wait";
      reason: PrNotReadyReason | "disabled" | "busy" | "resolve-pending";
    };

export interface PrAutoMergePolicy {
  /** Wait for checks GitHub does not require to pass. On by default. */
  requireChecks?: boolean;
}

/** What auto-merge should do for one environment given the monitor's reading. */
export function decideAutoMerge(
  environment: Environment,
  monitor: PrMonitorEnvironmentState | null,
  policy: PrAutoMergePolicy = {},
): PrAutoMergeDecision {
  if (environment.autoMerge !== true) return { kind: "wait", reason: "disabled" };
  if (environment.prState !== "open") return { kind: "wait", reason: "not-open" };
  if (environment.autoMergePrUrl !== environment.prUrl) return { kind: "wait", reason: "disabled" };
  const checkedAt = Date.parse(monitor?.lastSuccessfulCheckStartedAt ?? "");
  const enabledAt = Date.parse(environment.autoMergeEnabledAt ?? "");
  if (
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(enabledAt) ||
    checkedAt <= enabledAt ||
    Date.now() - checkedAt > PR_AUTO_MERGE_RETRY_BASE_MS
  ) {
    return { kind: "wait", reason: "stale" };
  }
  if (environment.deletionRequestedAt || environment.lifecycleOperation) {
    return { kind: "wait", reason: "busy" };
  }
  if ((monitor?.mergeability ?? null) !== (environment.prMergeability ?? null))
    return { kind: "wait", reason: "stale" };
  const readiness = evaluatePrMergeReadiness({
    prState: environment.prState,
    hasMergeConflicts: environment.hasMergeConflicts,
    mergeability: environment.prMergeability,
    checkSummary: monitor?.checkSummary ?? null,
    viewerCanMerge: monitor?.viewerCanMerge ?? null,
    fresh: isPrReadingConfirmedByMonitor(environment, monitor),
    requireChecks: policy.requireChecks !== false,
  });
  if (readiness.ready)
    return monitor?.headSha && /^[a-f0-9]{40}$/i.test(monitor.headSha)
      ? { kind: "merge" }
      : { kind: "wait", reason: "stale" };
  if (readiness.reason !== "conflicts") return { kind: "wait", reason: readiness.reason };
  // Only an explicit conflict reading arms the Resolve token below; a `dirty`
  // merge state alone would launch Resolve again on every attempt.
  if (environment.hasMergeConflicts !== true) return { kind: "wait", reason: "conflicts" };
  if (!isEnvironmentReadyForAgents(environment)) {
    return { kind: "wait", reason: "busy" };
  }
  return environment.prRecheckAfterAgentCompletionArmedAt
    ? { kind: "wait", reason: "resolve-pending" }
    : { kind: "resolve" };
}

export interface PrAutoMergeOptions {
  storage: Pick<
    StorageService,
    | "getEnvironment"
    | "loadConfig"
    | "getRepositoryConfig"
    | "loadEnvironments"
    | "updateEnvironment"
  >;
  invoke: CommandInvoker;
  resumeMonitoring?: () => Promise<void>;
  /** In-process PR monitor events; returns an unsubscribe function. */
  subscribe: (listener: (event: PrMonitorEvent) => void) => () => void;
  /** The monitor's announced state for one environment, or null. */
  monitorState: (environmentId: string) => PrMonitorEnvironmentState | null;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  onWarning?: (warning: PrAutoMergeWarning, error: unknown) => void;
}

/** A failed step. `event` is a `pull-request` log event; the environment is the only detail. */
export interface PrAutoMergeWarning {
  event: "auto-merge.evaluation-failed" | "auto-merge.merge-failed" | "auto-merge.resolve-failed";
  environmentId: string;
}

interface RetryState {
  /** `kind\0prUrl` of the last attempt; a different attempt is not delayed. */
  key: string;
  /** Consecutive failures of this attempt; 0 after a success. */
  failures: number;
  /** True until the retry timer fires. */
  waiting: boolean;
  timer: unknown;
}

export class PrAutoMergeController {
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly recheck = new Set<string>();
  private readonly retries = new Map<string, RetryState>();
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (timer: unknown) => void;

  constructor(private readonly options: PrAutoMergeOptions) {
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

  /** Starts acting on monitor events. Idempotent. */
  start(): void {
    if (this.closed || this.unsubscribe) return;
    this.unsubscribe = this.options.subscribe((event) => {
      if ("removed" in event) {
        this.clearRetry(event.environmentId);
        return;
      }
      void this.evaluate(event.environmentId);
    });
  }

  /** Resume persisted intent without a renderer request. Subscribe before hydration. */
  async resume(): Promise<void> {
    this.start();
    const environments = await this.options.storage.loadEnvironments();
    if (this.closed || !environments.some((environment) => environment.autoMerge)) return;
    for (const environment of environments) {
      if (environment.autoMerge && !environment.autoMergePrUrl) {
        await this.options.storage.updateEnvironment(
          environment.id,
          { autoMerge: true },
          (current) =>
            current.autoMerge === true &&
            !current.autoMergePrUrl &&
            current.prUrl === environment.prUrl,
        );
      }
    }
    if (this.closed) return;
    await this.options.resumeMonitoring?.();
    for (const environment of environments) {
      if (environment.autoMerge) await this.evaluate(environment.id);
    }
  }

  isActive(): boolean {
    return !this.closed;
  }

  /**
   * Re-evaluates one environment now. Serialised per environment: a request
   * that arrives while one runs is folded into a single follow-up pass.
   * Never rejects.
   */
  evaluate(environmentId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const running = this.inFlight.get(environmentId);
    if (running) {
      this.recheck.add(environmentId);
      return running;
    }
    const run = this.run(environmentId)
      .catch((error) => this.warn("auto-merge.evaluation-failed", environmentId, error))
      .finally(() => {
        this.inFlight.delete(environmentId);
        if (this.recheck.delete(environmentId)) void this.evaluate(environmentId);
      });
    this.inFlight.set(environmentId, run);
    return run;
  }

  dispose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const environmentId of Array.from(this.retries.keys())) this.clearRetry(environmentId);
    this.recheck.clear();
  }

  private async run(environmentId: string): Promise<void> {
    const environment = await this.options.storage.getEnvironment(environmentId);
    if (this.closed || !environment) return;
    // A conflict-free reading ends the Resolve episode, and with it the hold or
    // backoff of its launch, so the next conflict is acted on at once.
    if (environment.hasMergeConflicts === false) this.clearRetry(environmentId, "resolve");
    const completedAt = Date.parse(environment.autoMergeResolveCompletedAt ?? "");
    const checkedAt = Date.parse(
      this.options.monitorState(environmentId)?.lastSuccessfulCheckStartedAt ?? "",
    );
    const completionDecision = Number.isFinite(completedAt)
      ? decideAutoMerge(environment, this.options.monitorState(environmentId), await this.policy())
      : null;
    if (
      completionDecision?.kind === "wait" &&
      completionDecision.reason === "resolve-pending" &&
      environment.autoMerge &&
      environment.hasMergeConflicts === true &&
      environment.prRecheckAfterAgentCompletionArmedAt &&
      checkedAt > completedAt
    ) {
      const attempts = (environment.autoMergeResolveAttempts ?? 0) + 1;
      await this.options.storage.updateEnvironment(
        environmentId,
        {
          ...(attempts >= 3
            ? {
                autoMerge: false,
                autoMergeError:
                  "Resolve still reports conflicts after three attempts. Inspect the Resolve tab, then turn auto-merge on again to retry.",
              }
            : {}),
          autoMergeResolveAttempts: attempts,
          autoMergeResolveCompletedAt: undefined,
          prRecheckAfterAgentCompletionArmedAt: undefined,
        },
        (current) =>
          current.autoMergeEnabledAt === environment.autoMergeEnabledAt &&
          current.autoMergeResolveCompletedAt === environment.autoMergeResolveCompletedAt,
      );
      return;
    }
    const decision = decideAutoMerge(
      environment,
      this.options.monitorState(environmentId),
      await this.policy(),
    );
    if (decision.kind === "wait") {
      if (decision.reason === "disabled" || decision.reason === "not-open") {
        this.clearRetry(environmentId);
      }
      return;
    }
    const key = `${decision.kind}\0${environment.prUrl}`;
    const retry = this.retries.get(environmentId);
    if (retry?.waiting && retry.key === key) return;
    try {
      const attempted =
        decision.kind === "merge"
          ? await this.merge(environment)
          : await this.launchResolve(environment);
      if (!attempted || this.closed) return;
      // Merge cleanup can remove the environment before the command returns.
      if (!(await this.options.storage.getEnvironment(environmentId))) {
        this.clearRetry(environmentId);
        return;
      }
      await this.recordError(environment, null);
      this.holdAttempt(environmentId, key, false);
    } catch (error) {
      if (this.closed) return;
      await this.recordError(environment, error instanceof Error ? error.message : String(error));
      this.holdAttempt(environmentId, key, true);
      this.warn(
        decision.kind === "merge" ? "auto-merge.merge-failed" : "auto-merge.resolve-failed",
        environmentId,
        error,
      );
    }
  }

  /**
   * Revalidate the decision after asynchronous preparation, returning the
   * environment as stored now, or null when the decision no longer holds.
   */
  private async authorized(
    environment: Environment,
    kind: "merge" | "resolve",
    expectedHeadSha?: string,
  ): Promise<Environment | null> {
    const policy = await this.policy();
    const current = await this.options.storage.getEnvironment(environment.id);
    const reading = this.options.monitorState(environment.id);
    return !this.closed &&
      !!current &&
      current.prUrl === environment.prUrl &&
      current.autoMergeEnabledAt === environment.autoMergeEnabledAt &&
      (expectedHeadSha === undefined || reading?.headSha === expectedHeadSha) &&
      decideAutoMerge(current, reading, policy).kind === kind
      ? current
      : null;
  }

  /** Read per decision, so a settings change applies at the next reading. */
  private async policy(): Promise<PrAutoMergePolicy> {
    const config = await this.options.storage.loadConfig();
    return { requireChecks: config.global.autoMergeRequireChecks !== false };
  }

  private async recordError(environment: Environment, error: string | null): Promise<void> {
    await this.options.storage.updateEnvironment(
      environment.id,
      { autoMergeError: error },
      (current) =>
        current.autoMerge === true &&
        current.prUrl === environment.prUrl &&
        current.autoMergeEnabledAt === environment.autoMergeEnabledAt,
    );
  }

  /**
   * The Merge PR button's command, pinned to the observed PR and head. The
   * pin makes the command refuse effects that differ from the ones it would
   * apply, so ask for exactly those: a project's home checkout keeps its
   * branch, and a cleanup the user already requested, through Merge &
   * Cleanup or by turning auto-merge on with cleanup, still runs.
   */
  private async merge(environment: Environment): Promise<boolean> {
    const headSha = this.options.monitorState(environment.id)?.headSha;
    if (!headSha) return false;
    const current = await this.authorized(environment, "merge", headSha);
    if (!current || this.closed) return false;
    await this.options.invoke("merge_environment_pr", {
      environmentId: environment.id,
      method: "squash",
      deleteBranch: !isProjectHomeEnvironment(current),
      cleanupAfterMerge:
        Boolean(current.cleanupAfterMergeRequestedAt) || current.autoMergeCleanup === true,
      ...(current.autoMergeCleanup ? { autoMergeEnabledAt: current.autoMergeEnabledAt } : {}),
      expectedHeadSha: headSha,
      expectedPrUrl: environment.prUrl,
    });
    return true;
  }

  /** The Resolve button's launch, in the background and without taking focus. */
  private async launchResolve(environment: Environment): Promise<boolean> {
    const action = await resolveEnvironmentActionDefault(
      this.options.storage,
      environment,
      "resolve",
    );
    const repository = await this.options.storage.getRepositoryConfig(environment.projectId);
    if (!(await this.authorized(environment, "resolve"))) return false;
    const targetBranch = environment.prBaseBranch || repository.prBaseBranch?.trim() || "main";
    const result = await this.options.invoke<{ status?: unknown; error?: unknown }>(
      "launch_native_agent_job",
      {
        requestId: `auto-merge-resolve-${randomUUID()}`,
        environmentId: environment.id,
        autoMergePrUrl: environment.prUrl,
        autoMergeEnabledAt: environment.autoMergeEnabledAt,
        agent: action.agent,
        prompt: createResolveConflictsPrompt(targetBranch),
        title: PR_AUTO_MERGE_RESOLVE_TAB_TITLE,
        conversationMode: "build",
        completionAction: "refresh-pr-after-agent-completion",
        // A later episode reuses the open Resolve tab instead of adding one.
        tabReuse: "any-agent",
        activateTab: false,
        ...(action.model ? { modelId: action.model } : {}),
        ...(action.reasoningEffort ? { reasoningId: action.reasoningEffort } : {}),
        ...(typeof action.fastMode === "boolean" ? { fastMode: action.fastMode } : {}),
      },
    );
    if (result?.status === "skipped") return false;
    if (result?.status === "unknown")
      throw new Error("Resolve dispatch is unconfirmed; check the Resolve tab before retrying");
    if (result?.status === "rejected") {
      throw new Error(
        typeof result.error === "string" && result.error
          ? result.error
          : "The conflict-resolution agent rejected the prompt",
      );
    }
    return true;
  }

  /** Holds this attempt off until a timer re-evaluates, backing off on failure. */
  private holdAttempt(environmentId: string, key: string, failed: boolean): void {
    if (this.closed) return;
    const previous = this.retries.get(environmentId);
    if (previous) this.cancel(previous.timer);
    const failures = failed ? (previous?.key === key ? previous.failures : 0) + 1 : 0;
    const delayMs = Math.min(
      PR_AUTO_MERGE_RETRY_BASE_MS * 2 ** Math.max(failures - 1, 0),
      PR_AUTO_MERGE_RETRY_MAX_MS,
    );
    const state: RetryState = { key, failures, waiting: true, timer: undefined };
    state.timer = this.schedule(() => {
      if (this.retries.get(environmentId) !== state) return;
      state.waiting = false;
      void this.evaluate(environmentId);
    }, delayMs);
    this.retries.set(environmentId, state);
  }

  private clearRetry(environmentId: string, kind?: "merge" | "resolve"): void {
    const retry = this.retries.get(environmentId);
    if (!retry || (kind && !retry.key.startsWith(`${kind}\0`))) return;
    this.cancel(retry.timer);
    this.retries.delete(environmentId);
  }

  private warn(event: PrAutoMergeWarning["event"], environmentId: string, error: unknown): void {
    if (this.options.onWarning) {
      this.options.onWarning({ event, environmentId }, error);
      return;
    }
    log.warn(event, {
      environmentId,
      ...classifyCommandFailure(error, { tools: ["gh"] }),
      error: formatLogError(error),
    });
  }
}
