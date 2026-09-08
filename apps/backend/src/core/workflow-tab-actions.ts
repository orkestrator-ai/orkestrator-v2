import {
  MAX_TABS_PER_ENVIRONMENT,
  PANE_LAYOUT_VERSION,
  isPaneLayoutRevisionConflict,
} from "@orkestrator/protocol/pane-layout";
import type { PaneLayoutMergeInput } from "@orkestrator/protocol/pane-layout-merge";
import type {
  MultiReviewWorkflow,
  MultiReviewActionResult,
} from "@orkestrator/protocol/multi-review";
import type { StorageService } from "./storage.js";
import {
  paneLayoutLeaves,
  isRecord,
  assertPaneLayoutRootWithinBounds,
} from "./storage-shared-core.js";

/** Compare, recompute the semantic intent on the latest tree, and retry.
 * A stale renderer save merges against this write through applyPaneLayoutIntent.
 * No caller-owned tree is ever used as a replacement for the authoritative tree.
 */
export async function openMultiReviewTab(
  storage: StorageService,
  workflow: Pick<
    MultiReviewWorkflow,
    "id" | "projectId" | "environmentId" | "fixTabId" | "fixSession" | "addressPromptPending"
  >,
  surface: "root" | "fix" = "root",
  checkOnly = false,
): Promise<MultiReviewActionResult["ui"]> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const environment = await storage.getEnvironment(workflow.environmentId);
    if (
      !environment ||
      environment.projectId !== workflow.projectId ||
      environment.deletionRequestedAt ||
      environment.lifecycleOperation === "deleting"
    ) {
      throw new Error("The review environment is unavailable");
    }
    if (
      environment.status !== "running" ||
      !(
        environment.setupPhase === "ready" ||
        environment.setupScriptsComplete === true ||
        environment.setupOverride === true
      )
    ) {
      throw new Error("Start the environment and finish setup before opening Multi Review");
    }
    const containerId = environment.environmentType === "local" ? null : environment.containerId;
    if (environment.environmentType !== "local" && !containerId)
      throw new Error("The environment container is unavailable");
    const previous = await storage.getPaneLayout(environment.id);
    if (previous && previous.version !== PANE_LAYOUT_VERSION)
      throw new Error("Reopen the environment to migrate its saved pane layout first");
    if (previous && previous.containerId !== containerId)
      throw new Error(
        "The pane layout belongs to an earlier container; reopen the environment first",
      );
    const desired: PaneLayoutMergeInput = previous
      ? (structuredClone(previous) as PaneLayoutMergeInput)
      : {
          version: PANE_LAYOUT_VERSION,
          containerId,
          activePaneId: "default",
          root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
        };
    assertPaneLayoutRootWithinBounds(desired.root);
    const panes = paneLayoutLeaves(desired.root);
    const matches = (tab: Record<string, unknown>) => {
      const data = isRecord(tab.multiReviewTabData) ? tab.multiReviewTabData : undefined;
      return surface === "root"
        ? tab.type === "multi-review" &&
            data?.workflowId === workflow.id &&
            data.reviewerId === undefined
        : tab.id === (workflow.fixTabId ?? `multi-review-fix:${workflow.id}`);
    };
    const existingPane = panes.find((pane) => pane.tabs.some(matches));
    const existing = existingPane?.tabs.find(matches);
    if (
      !existing &&
      panes.reduce((sum, pane) => sum + pane.tabs.length, 0) >= MAX_TABS_PER_ENVIRONMENT
    )
      throw new Error("Close a tab before opening Multi Review (maximum 9 tabs)");
    const pane = existingPane ?? panes.find((pane) => pane.id === desired.activePaneId) ?? panes[0];
    if (!pane) throw new Error("The saved layout has no pane");
    const tabId =
      (typeof existing?.id === "string" ? existing.id : undefined) ??
      (surface === "root"
        ? `multi-review:${workflow.id}`
        : (workflow.fixTabId ?? `multi-review-fix:${workflow.id}`));
    if (!existing && panes.some((pane) => pane.tabs.some((tab) => tab.id === tabId)))
      throw new Error("The reserved tab ID is already in use");
    if (surface === "fix" && !workflow.fixSession)
      throw new Error("The fix session is not available yet");
    if (surface === "fix" && workflow.addressPromptPending)
      throw new Error("The fix handoff is still pending; retry after dispatch is confirmed");
    if (existing && surface === "fix" && existing.type !== "agent-native")
      throw new Error("The fix tab ID is already in use");
    if (existing && surface === "fix") {
      const data = isRecord(existing.nativeAgentData) ? existing.nativeAgentData : {};
      if (data.environmentId !== environment.id || data.platform !== workflow.fixSession!.agent)
        throw new Error("The fix tab belongs to a different session identity");
      existing.nativeAgentData = {
        ...data,
        sessionId: workflow.fixSession!.providerSessionId,
        requireExistingResumeSession: true,
      };
    }
    if (!existing)
      pane.tabs.push(
        surface === "root"
          ? {
              id: tabId,
              type: "multi-review",
              displayTitle: "Multi Review",
              multiReviewTabData: {
                environmentId: environment.id,
                workflowId: workflow.id,
                isLocal: environment.environmentType === "local",
              },
            }
          : {
              id: tabId,
              type: "agent-native",
              displayTitle: "Fix",
              isReviewTab: true,
              nativeAgentData: {
                platform: workflow.fixSession!.agent,
                environmentId: environment.id,
                isLocal: environment.environmentType === "local",
                ...(containerId ? { containerId } : {}),
                sessionId: workflow.fixSession!.providerSessionId,
                requireExistingResumeSession: true,
              },
            },
      );
    pane.activeTabId = tabId;
    desired.activePaneId = pane.id;
    desired.version = PANE_LAYOUT_VERSION;
    if (checkOnly) return { status: "unavailable" };
    try {
      const saved = await storage.savePaneLayout(environment.id, desired, previous?.revision ?? 0);
      return { status: "opened", tabId, paneId: pane.id, layoutRevision: saved.revision };
    } catch (error) {
      if (!isPaneLayoutRevisionConflict(error)) throw error;
    }
  }
  throw new Error("The layout kept changing; retry this same action request");
}
