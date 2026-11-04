import { multiReviewAddressFindingsIdentity } from "./multi-review-address-findings-identity.js";
import { resolveEnvironmentActionDefault } from "./action-default-selection.js";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { createPRPrompt, createResolveConflictsPrompt } from "@orkestrator/protocol/pr-prompt";
import type { CommandInvoker } from "./build-pipeline-service-helpers.js";
import type { StorageService } from "./storage.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("pull-request");

/** Pane title of the PR tab, matching the action bar's Create PR launch. */
export const MULTI_REVIEW_AUTO_PR_TAB_TITLE = "PR";

export const MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE =
  "A pull request already exists for this environment, so no PR agent was launched.";

/** How the interactive Address Findings tab's handoff turn ended, as the native-agent layer records it. */
export type InteractiveAddressFindingsTurnOutcome =
  "completed" | "failed" | "interrupted" | "superseded" | "pending" | "unknown";

const INTERACTIVE_ADDRESS_FINDINGS_AUTO_PR_SKIPPED: Record<
  Exclude<InteractiveAddressFindingsTurnOutcome, "completed" | "pending">,
  string
> = {
  failed: "The Address Findings turn failed, so no PR agent was launched.",
  interrupted:
    "Address Findings was stopped before it finished, so no PR agent was launched. Use the PR button when the changes are ready.",
  superseded:
    "The Address Findings conversation continued after the automatic request, so no PR agent was launched. Use the PR button when the changes are ready.",
  unknown:
    "Whether Address Findings finished could not be confirmed, so no PR agent was launched. Use the PR button when the changes are ready.",
};

export const MULTI_REVIEW_AUTO_PR_MANUAL_ADDRESS_FINDINGS_MESSAGE =
  "Review the interactive Address Findings, then use the PR button to create a pull request.";

/**
 * Whether an interactive Address Findings can authorize an automatic PR at all: only the
 * standard handoff in its own interactive session. A custom instruction asks
 * for something narrower than "address the report", so its result is the
 * user's to judge.
 */
export function interactiveAddressFindingsCanQueueAutoPr(workflow: MultiReviewWorkflow): boolean {
  const session = workflow.fixSession;
  return (
    workflow.autoPr === true &&
    workflow.fixLaunch?.kind !== "custom" &&
    session !== undefined &&
    session.requestIds.length > 0 &&
    session.sessionKey.startsWith(`multi-review:${workflow.id}:interactive`)
  );
}

/** Why a settled interactive Address Findings launched no PR, for an outcome that is not proof of completion. */
export function interactiveAddressFindingsAutoPrSkipMessage(
  outcome: Exclude<InteractiveAddressFindingsTurnOutcome, "completed" | "pending">,
): string {
  return INTERACTIVE_ADDRESS_FINDINGS_AUTO_PR_SKIPPED[outcome];
}

/**
 * Records the auto-PR intent in the same save as the proof that Address Findings
 * completed: a complete structured result, or an interactive handoff turn
 * that finished on its own as the conversation's last turn.
 *
 * A launch that already reached the agent is never repeated. A skipped or
 * failed one may be retried by a later successful Address Findings, because the condition
 * that stopped it (an existing PR, a full tab strip) can have changed.
 */
export function queueAutoPr(workflow: MultiReviewWorkflow): void {
  if (workflow.autoPr !== true) return;
  const state = workflow.autoPrLaunch?.state;
  if (state === "pending" || state === "launched") return;
  workflow.autoPrLaunch = {
    state: "pending",
    requestId: `multi-review-pr:${workflow.id}`,
    fixIdentity: multiReviewAddressFindingsIdentity(workflow.fixSession),
  };
}

/** Whether a consolidated report gives Address Findings nothing to address. */
export function consolidatedReportIsClean(
  workflow: Pick<MultiReviewWorkflow, "consolidatedReport">,
): boolean {
  const report = workflow.consolidatedReport;
  return report !== undefined && report.issues.length === 0 && report.testCoverageGaps.length === 0;
}

/**
 * Whether consolidation hands its report to Address Findings: auto-address findings is on and the
 * report has issues or test coverage gaps. Otherwise the review is ready.
 */
export function multiReviewAutoAddressFindingsDue(
  workflow: Pick<MultiReviewWorkflow, "autoFix" | "consolidatedReport">,
): boolean {
  return (
    workflow.autoFix === true &&
    workflow.consolidatedReport !== undefined &&
    !consolidatedReportIsClean(workflow)
  );
}

/** Whether a structured Fix result proves completion: it may queue the pull request. */
export function addressFindingsResultCompletes(result: { complete: boolean }): boolean {
  return result.complete === true;
}

/**
 * Records the auto-PR intent in the same save as a consolidated report with
 * nothing to fix. No Address Findings runs, so the reviewed branch goes straight to the PR,
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

/** Records why a settled Address Findings launched no PR, unless a launch is already queued or delivered. */
export function skipAutoPr(workflow: MultiReviewWorkflow, message: string): void {
  if (workflow.autoPr !== true) return;
  const state = workflow.autoPrLaunch?.state;
  if (state === "pending" || state === "launched") return;
  workflow.autoPrLaunch = {
    state: "skipped",
    fixIdentity: multiReviewAddressFindingsIdentity(workflow.fixSession),
    requestId: `multi-review-pr:${workflow.id}`,
    message,
  };
}

/**
 * A new Address Findings turn supersedes an undelivered PR launch. A later complete
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
 * Starts the ordinary PR agent for a workflow whose Address Findings completed, or whose
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
    log.warn("monitor.start-failed", { environmentId, error: formatLogError(reason) });
  });
  return { kind: "launched", tabId };
}
