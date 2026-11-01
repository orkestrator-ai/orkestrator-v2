import { randomUUID } from "node:crypto";
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
import type { StorageService } from "./storage.js";

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
 * waits rather than merging. Unlike the shimmer, failing or pending checks
 * GitHub does not require only hold a merge back while the machine's
 * `autoMergeRequireChecks` setting is on; required checks always do.
 *
 * Conflict resolution is launched at most once per conflict episode. The
 * Resolve job arms `prRecheckAfterAgentCompletionArmedAt`, which the monitor
 * clears only when GitHub stops reporting conflicts, so an armed token means
 * a Resolve (manual or automatic) already owns this episode. A Resolve that
 * finishes with conflicts still present is not relaunched; the user decides.
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
  if (
    environment.status !== "running" ||
    !(
      environment.setupPhase === "ready" ||
      environment.setupScriptsComplete ||
      environment.setupOverride
    )
  ) {
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
  onWarning?: (message: string, error: unknown) => void;
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
      .catch((error) => this.warn(`Auto-merge evaluation failed for ${environmentId}`, error))
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
      await this.recordError(environment, null);
      this.holdAttempt(environmentId, key, false);
    } catch (error) {
      if (this.closed) return;
      await this.recordError(environment, error instanceof Error ? error.message : String(error));
      this.holdAttempt(environmentId, key, true);
      this.warn(
        decision.kind === "merge"
          ? `Auto-merge could not merge the pull request of ${environmentId}`
          : `Auto-merge could not launch Resolve in ${environmentId}`,
        error,
      );
    }
  }

  /** Revalidate the decision after asynchronous preparation. */
  private async authorized(
    environment: Environment,
    kind: "merge" | "resolve",
    expectedHeadSha?: string,
  ): Promise<boolean> {
    const policy = await this.policy();
    const current = await this.options.storage.getEnvironment(environment.id);
    const reading = this.options.monitorState(environment.id);
    return (
      !this.closed &&
      !!current &&
      current.prUrl === environment.prUrl &&
      current.autoMergeEnabledAt === environment.autoMergeEnabledAt &&
      (expectedHeadSha === undefined || reading?.headSha === expectedHeadSha) &&
      decideAutoMerge(current, reading, policy).kind === kind
    );
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

  /** The Merge PR button's command, pinned to the observed PR and head. */
  private async merge(environment: Environment): Promise<boolean> {
    const headSha = this.options.monitorState(environment.id)?.headSha;
    if (!headSha || !(await this.authorized(environment, "merge", headSha)) || this.closed)
      return false;
    await this.options.invoke("merge_environment_pr", {
      environmentId: environment.id,
      method: "squash",
      deleteBranch: true,
      cleanupAfterMerge: false,
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

  private clearRetry(environmentId: string): void {
    const retry = this.retries.get(environmentId);
    if (!retry) return;
    this.cancel(retry.timer);
    this.retries.delete(environmentId);
  }

  private warn(message: string, error: unknown): void {
    if (this.options.onWarning) {
      this.options.onWarning(message, error);
      return;
    }
    console.warn(`[pr-auto-merge] ${message}:`, error instanceof Error ? error.message : error);
  }
}
