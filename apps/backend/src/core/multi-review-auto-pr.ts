import { resolveActionDefault } from "@orkestrator/protocol/action-defaults";
import { normalizeAgentPlatforms } from "@orkestrator/protocol/agent-platforms";
import {
  resolveActionDefaults,
  resolveDefaultAgent,
  type AgentSettingsTiers,
} from "@orkestrator/protocol/agent-settings";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { createPRPrompt } from "@orkestrator/protocol/pr-prompt";
import type { CommandInvoker } from "./build-pipeline-service-helpers.js";
import type { StorageService } from "./storage.js";

/** Pane title of the PR tab, matching the action bar's Create PR launch. */
export const MULTI_REVIEW_AUTO_PR_TAB_TITLE = "PR";

export const MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE =
  "A pull request already exists for this environment, so no PR agent was launched.";

/**
 * Records the auto-PR intent in the same save as a successful Fix settlement.
 *
 * A launch that already reached the agent is never repeated. A skipped or
 * failed one may be retried by a later successful Fix, because the condition
 * that stopped it (an existing PR, a full tab strip) can have changed.
 */
export function queueAutoPr(workflow: MultiReviewWorkflow): void {
  if (workflow.autoPr !== true) return;
  const state = workflow.autoPrLaunch?.state;
  if (state === "pending" || state === "launched") return;
  workflow.autoPrLaunch = { state: "pending", requestId: `multi-review-pr:${workflow.id}` };
}

/**
 * A new Fix turn supersedes an undelivered PR launch. Its own successful
 * completion queues the launch again, so the PR never races a running fix.
 */
export function supersedePendingAutoPr(workflow: MultiReviewWorkflow): void {
  if (workflow.autoPrLaunch?.state === "pending") delete workflow.autoPrLaunch;
}

export type AutoPrLaunchOutcome =
  | { kind: "launched"; tabId: string }
  | { kind: "skipped"; message: string }
  | { kind: "rejected"; message: string }
  | { kind: "retry"; message: string };

/**
 * Starts the ordinary PR agent for a workflow whose Fix completed.
 *
 * This is the backend twin of the action bar's Create PR click: the same
 * prompt, the same `PR` tab title, and the same `pr` action default, launched
 * through the durable native-agent job so the tab appears in every client.
 * The request id is stable, so a retry after a lost acknowledgement joins the
 * original job instead of creating a second PR agent.
 */
export async function launchMultiReviewAutoPr(
  invoke: CommandInvoker,
  storage: Pick<StorageService, "getEnvironment" | "loadConfig">,
  workflow: MultiReviewWorkflow,
  requestId: string,
): Promise<AutoPrLaunchOutcome> {
  const environment = await storage.getEnvironment(workflow.environmentId);
  if (!environment) return { kind: "rejected", message: "Review environment no longer exists" };
  if (environment.prUrl) return { kind: "skipped", message: MULTI_REVIEW_AUTO_PR_EXISTS_MESSAGE };

  const config = await storage.loadConfig();
  const tiers: AgentSettingsTiers = {
    environment: environment.agentSettings,
    repository: config.repositories?.[environment.projectId]?.agentSettings,
    global: config.global.agentSettings,
  };
  const enabled = normalizeAgentPlatforms(config.global.enabledAgentPlatforms);
  const configuredFallback = resolveDefaultAgent(tiers);
  const action = resolveActionDefault(resolveActionDefaults(tiers), "pr", {
    fallbackAgent: enabled.includes(configuredFallback)
      ? configuredFallback
      : (enabled[0] ?? configuredFallback),
    enabledAgents: enabled,
  });

  let result: { tabId?: unknown; status?: unknown; error?: unknown };
  try {
    result = await invoke("launch_native_agent_job", {
      requestId,
      environmentId: workflow.environmentId,
      agent: action.agent,
      // The review compared against this branch, so the PR targets it too.
      prompt: createPRPrompt(workflow.targetBranch),
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
    environmentId: workflow.environmentId,
    mode: "create-pending",
  }).catch((reason: unknown) => {
    console.warn(
      `[multi-review] Could not start PR monitoring for ${workflow.environmentId}:`,
      reason instanceof Error ? reason.message : reason,
    );
  });
  return { kind: "launched", tabId };
}
