import { multiReviewFixIdentity } from "./multi-review-fix-identity.js";
import { resolveEnvironmentActionDefault } from "./action-default-selection.js";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { createPRPrompt, createResolveConflictsPrompt } from "@orkestrator/protocol/pr-prompt";
import type { CommandInvoker } from "./build-pipeline-service-helpers.js";
import type { StorageService } from "./storage.js";

/** Pane title of the PR tab, matching the action bar's Create PR launch. */
export const MULTI_REVIEW_AUTO_PR_TAB_TITLE = "PR";

export const MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE =
  "A pull request already exists for this environment, so no PR agent was launched.";

/** How the interactive Fix tab's handoff turn ended, as the native-agent layer records it. */
export type InteractiveFixTurnOutcome =
  "completed" | "failed" | "interrupted" | "superseded" | "pending" | "unknown";

const INTERACTIVE_FIX_AUTO_PR_SKIPPED: Record<
  Exclude<InteractiveFixTurnOutcome, "completed" | "pending">,
  string
> = {
  failed: "The Fix turn failed, so no PR agent was launched.",
  interrupted:
    "The Fix was stopped before it finished, so no PR agent was launched. Use the PR button when the changes are ready.",
  superseded:
    "The Fix conversation continued after the automatic request, so no PR agent was launched. Use the PR button when the changes are ready.",
  unknown:
    "Whether the Fix finished could not be confirmed, so no PR agent was launched. Use the PR button when the changes are ready.",
};

export const MULTI_REVIEW_AUTO_PR_MANUAL_FIX_MESSAGE =
  "Review the interactive Fix, then use the PR button to create a pull request.";

/**
 * Whether an interactive Fix can authorize an automatic PR at all: only the
 * standard handoff in its own interactive session. A custom instruction asks
 * for something narrower than "address the report", so its result is the
 * user's to judge.
 */
export function interactiveFixCanQueueAutoPr(workflow: MultiReviewWorkflow): boolean {
  const session = workflow.fixSession;
  return (
    workflow.autoPr === true &&
    workflow.fixLaunch?.kind !== "custom" &&
    session !== undefined &&
    session.requestIds.length > 0 &&
    session.sessionKey.startsWith(`multi-review:${workflow.id}:interactive`)
  );
}

/** Why a settled interactive Fix launched no PR, for an outcome that is not proof of completion. */
export function interactiveFixAutoPrSkipMessage(
  outcome: Exclude<InteractiveFixTurnOutcome, "completed" | "pending">,
): string {
  return INTERACTIVE_FIX_AUTO_PR_SKIPPED[outcome];
}

/**
 * Records the auto-PR intent in the same save as the proof that the Fix
 * completed: a complete structured result, or an interactive handoff turn
 * that finished on its own as the conversation's last turn.
 *
 * A launch that already reached the agent is never repeated. A skipped or
 * failed one may be retried by a later successful Fix, because the condition
 * that stopped it (an existing PR, a full tab strip) can have changed.
 */
export function queueAutoPr(workflow: MultiReviewWorkflow): void {
  if (workflow.autoPr !== true) return;
  const state = workflow.autoPrLaunch?.state;
  if (state === "pending" || state === "launched") return;
  workflow.autoPrLaunch = {
    state: "pending",
    requestId: `multi-review-pr:${workflow.id}`,
    fixIdentity: multiReviewFixIdentity(workflow.fixSession),
  };
}

/** Whether a consolidated report gives the Fix nothing to address. */
export function consolidatedReportIsClean(
  workflow: Pick<MultiReviewWorkflow, "consolidatedReport">,
): boolean {
  const report = workflow.consolidatedReport;
  return report !== undefined && report.issues.length === 0 && report.testCoverageGaps.length === 0;
}

/**
 * Whether consolidation hands its report to the Fix: auto-fix is on and the
 * report has issues or test coverage gaps. Otherwise the review is ready.
 */
export function multiReviewAutoFixDue(
  workflow: Pick<MultiReviewWorkflow, "autoFix" | "consolidatedReport">,
): boolean {
  return (
    workflow.autoFix === true &&
    workflow.consolidatedReport !== undefined &&
    !consolidatedReportIsClean(workflow)
  );
}

/** Whether a structured Fix result proves completion: it may queue the pull request. */
export function fixResultCompletes(result: { complete: boolean }): boolean {
  return result.complete === true;
}

/**
 * Records the auto-PR intent in the same save as a consolidated report with
 * nothing to fix. No Fix runs, so the reviewed branch goes straight to the PR,
 * whether the review was started by the button, a coordinator, or any other
 * caller that turned auto-PR on.
 */
export function queueCleanReviewAutoPr(workflow: MultiReviewWorkflow): void {
  if (workflow.autoPr !== true || !consolidatedReportIsClean(workflow)) return;
  const state = workflow.autoPrLaunch?.state;
  if (state === "pending" || state === "launched") return;
  workflow.autoPrLaunch = {
    basis: "clean-review",
    state: "pending",
    requestId: `multi-review-pr:${workflow.id}`,
  };
}

/** Records why a settled Fix launched no PR, unless a launch is already queued or delivered. */
export function skipAutoPr(workflow: MultiReviewWorkflow, message: string): void {
  if (workflow.autoPr !== true) return;
  const state = workflow.autoPrLaunch?.state;
  if (state === "pending" || state === "launched") return;
  workflow.autoPrLaunch = {
    state: "skipped",
    fixIdentity: multiReviewFixIdentity(workflow.fixSession),
    requestId: `multi-review-pr:${workflow.id}`,
    message,
  };
}

/**
 * A new Fix turn supersedes an undelivered PR launch. A later complete
 * structured result may queue it again, so the PR never races a running fix.
 */
export function supersedePendingAutoPr(workflow: MultiReviewWorkflow): void {
  if (workflow.autoPrLaunch?.state === "pending") delete workflow.autoPrLaunch;
}

/** Pane title of the Resolve tab, matching the action bar's Resolve Conflicts launch. */
export const RESOLVE_CONFLICTS_TAB_TITLE = "Resolve";

export type ResolveConflictsLaunchOutcome =
  | { kind: "launched"; tabId: string; refreshArmed: boolean }
  | { kind: "rejected"; message: string }
  | { kind: "retry"; message: string };

/**
 * The backend twin of the action bar's Resolve Conflicts click: the same
 * prompt, `Resolve` tab title and `resolve` action default, launched through
 * the durable native-agent job with the button's completion action, so the
 * PR monitor rechecks the pull request when the agent finishes. The request
 * id is stable, so a retry after a lost acknowledgement joins the same job.
 */
export async function launchResolveConflictsAgent(
  invoke: CommandInvoker,
  storage: Pick<StorageService, "getEnvironment" | "loadConfig">,
  input: { environmentId: string; targetBranch: string; requestId: string },
): Promise<ResolveConflictsLaunchOutcome> {
  const environment = await storage.getEnvironment(input.environmentId);
  if (!environment) return { kind: "rejected", message: "Environment no longer exists" };
  const action = await resolveEnvironmentActionDefault(storage, environment, "resolve");
  let result: {
    tabId?: unknown;
    status?: unknown;
    error?: unknown;
    completionActionArmed?: unknown;
  };
  try {
    result = await invoke("launch_native_agent_job", {
      requestId: input.requestId,
      environmentId: input.environmentId,
      agent: action.agent,
      prompt: createResolveConflictsPrompt(input.targetBranch),
      title: RESOLVE_CONFLICTS_TAB_TITLE,
      conversationMode: "build",
      completionAction: "refresh-pr-after-agent-completion",
      // A coordinator's launch never takes the user's focus.
      activateTab: false,
      ...(action.model ? { modelId: action.model } : {}),
      ...(action.reasoningEffort ? { reasoningId: action.reasoningEffort } : {}),
      ...(typeof action.fastMode === "boolean" ? { fastMode: action.fastMode } : {}),
    });
  } catch (error) {
    return { kind: "retry", message: error instanceof Error ? error.message : String(error) };
  }
  const tabId = typeof result.tabId === "string" ? result.tabId : undefined;
  const error = typeof result.error === "string" ? result.error : undefined;
  if (result.status === "rejected")
    return { kind: "rejected", message: error || "The agent rejected the conflict resolution" };
  if (result.status !== "accepted" || !tabId)
    return {
      kind: "retry",
      message: error || "The conflict-resolution agent did not acknowledge the launch",
    };
  return { kind: "launched", tabId, refreshArmed: result.completionActionArmed !== false };
}

export type AutoPrLaunchOutcome =
  | { kind: "pending" }
  | { kind: "launched"; tabId: string }
  | { kind: "skipped"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "retry"; message: string };

/**
 * Starts the ordinary PR agent for a workflow whose Fix completed, or whose
 * consolidated report found nothing to fix.
 */
export async function launchMultiReviewAutoPr(
  invoke: CommandInvoker,
  storage: Pick<StorageService, "getEnvironment" | "loadConfig">,
  workflow: MultiReviewWorkflow,
  requestId: string,
  beforeLaunch?: () => Promise<AutoPrLaunchOutcome | undefined>,
): Promise<AutoPrLaunchOutcome> {
  return launchPrAgent(
    invoke,
    storage,
    {
      environmentId: workflow.environmentId,
      // The review compared against this branch, so the PR targets it too.
      targetBranch: workflow.targetBranch,
      requestId,
      missingEnvironmentMessage: "Review environment no longer exists",
    },
    beforeLaunch,
  );
}

/**
 * Starts the ordinary PR agent in an environment: the one way Orkestrator
 * raises a pull request outside a build pipeline.
 *
 * This is the backend twin of the action bar's Create PR click: the same
 * prompt, the same `PR` tab title, and the same `pr` action default, launched
 * through the durable native-agent job so the tab appears in every client.
 * The request id is stable, so a retry after a lost acknowledgement joins the
 * original job instead of creating a second PR agent.
 */
export async function launchPrAgent(
  invoke: CommandInvoker,
  storage: Pick<StorageService, "getEnvironment" | "loadConfig">,
  input: {
    environmentId: string;
    targetBranch: string;
    requestId: string;
    missingEnvironmentMessage?: string;
  },
  beforeLaunch?: () => Promise<AutoPrLaunchOutcome | undefined>,
): Promise<AutoPrLaunchOutcome> {
  const { environmentId, targetBranch, requestId } = input;
  const environment = await storage.getEnvironment(environmentId);
  if (!environment)
    return {
      kind: "rejected",
      message: input.missingEnvironmentMessage ?? "Environment no longer exists",
    };
  if (environment.prUrl) return { kind: "skipped", message: MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE };

  const action = await resolveEnvironmentActionDefault(storage, environment, "pr");

  // Settings reads can await; authorize at the final publication boundary.
  const admission = await beforeLaunch?.();
  if (admission) return admission;

  let result: { tabId?: unknown; status?: unknown; error?: unknown };
  try {
    result = await invoke("launch_native_agent_job", {
      requestId,
      environmentId,
      agent: action.agent,
      prompt: createPRPrompt(targetBranch),
      title: MULTI_REVIEW_AUTO_PR_TAB_TITLE,
      conversationMode: "build",
      // Automatic follow-ups never take focus; only a foreground click does.
      activateTab: false,
      ...(action.model ? { modelId: action.model } : {}),
      ...(action.reasoningEffort ? { reasoningId: action.reasoningEffort } : {}),
      ...(typeof action.fastMode === "boolean" ? { fastMode: action.fastMode } : {}),
    });
  } catch (error) {
    return { kind: "retry", message: error instanceof Error ? error.message : String(error) };
  }
  const tabId = typeof result.tabId === "string" ? result.tabId : undefined;
  const error = typeof result.error === "string" ? result.error : undefined;
  if (result.status === "rejected") {
    return { kind: "rejected", message: error || "The agent rejected the pull request request" };
  }
  if (result.status !== "accepted" || !tabId) {
    return {
      kind: "retry",
      message: error || "The pull request agent did not acknowledge the launch",
    };
  }
  // Poll faster until the PR appears, as the Create PR button does. Monitoring
  // is advisory: the agent-idle probe still discovers the PR if this fails.
  await invoke("pr_monitor_watch", {
    environmentId,
    mode: "create-pending",
  }).catch((reason: unknown) => {
    console.warn(
      `[pr] Could not start PR monitoring for ${environmentId}:`,
      reason instanceof Error ? reason.message : reason,
    );
  });
  return { kind: "launched", tabId };
}
