import { useCallback } from "react";
import { toast } from "sonner";
import type { BuildStepConfig, BuildStepConfigs } from "@orkestrator/protocol/build-pipeline";
import type { LaunchBuildPipelineInput } from "@orkestrator/protocol/build-pipeline-defaults";
import {
  githubIssueBuildTicket,
  kanbanTaskBuildTicket,
  linearIssueBuildTicket,
  type BuildPipelineTicket,
  type GitHubIssueBuildInput,
} from "@orkestrator/protocol/build-pipeline-tickets";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import * as backend from "@/lib/backend";
import { isUnsupportedBackendCommand } from "@/lib/backend/shared";
import { scheduleBuildPipelineTabActivation } from "@/lib/feature-build-activation";
import { legacyBuildPipelineStartInput } from "@/lib/build-pipeline-launch-compat";
import type { DefaultAgent, EnvironmentType } from "@/types";
import type { KanbanTask } from "@/lib/backend";
import type { PaneNode } from "@/types/paneLayout";
import type { LinearIssueDetail } from "@/types/linear";

export type { GitHubIssueBuildInput };

type StartBuildOptions = {
  existingEnvironmentId?: string | null;
  featurePlanId?: string;
  /** Per-step harness, model and reasoning chosen in the build launcher. */
  steps?: BuildStepConfigs;
  /** Explicit per-launch fan-out. Missing uses the configured Multi Review defaults. */
  reviewers?: BuildStepConfig[];
  /** Explicit preparation/consolidation model. Missing uses its action default. */
  reviewPreparation?: BuildStepConfig;
  /** Whether source-ticket comments should be copied into the task snapshot. */
  includeComments?: boolean;
};

function findBuildTabInTree(
  node: PaneNode,
  taskId: string,
): { paneId: string; tabId: string } | null {
  if (node.kind === "leaf") {
    const tab = node.tabs.find(
      (candidate) => candidate.type === "claude-build" && candidate.buildTabData?.taskId === taskId,
    );
    return tab ? { paneId: node.id, tabId: tab.id } : null;
  }
  for (const child of node.children) {
    const result = findBuildTabInTree(child, taskId);
    if (result) return result;
  }
  return null;
}

export function useBuildPipeline() {
  const config = useConfigStore((state) => state.config);
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  const selectProjectAndEnvironment = useUIStore((state) => state.selectProjectAndEnvironment);
  const setProjectCollapsed = useUIStore((state) => state.setProjectCollapsed);

  const startBuildFromTicket = useCallback(
    async (
      ticket: BuildPipelineTicket,
      environmentType: EnvironmentType,
      agentOverride?: DefaultAgent,
      options: StartBuildOptions = {},
    ) => {
      try {
        // Only what this launch explicitly chose. The backend fills everything
        // else from the saved Build defaults, in one implementation every
        // client shares (`launch_build_pipeline`).
        const request: LaunchBuildPipelineInput = {
          taskId: ticket.id,
          projectId: ticket.projectId,
          environmentType,
          ...(agentOverride ? { agentType: agentOverride } : {}),
          ...(options.steps ? { steps: options.steps } : {}),
          ...(options.reviewers ? { reviewers: options.reviewers } : {}),
          ...(options.reviewPreparation ? { reviewPreparation: options.reviewPreparation } : {}),
          taskTitle: ticket.title,
          taskSnapshot: ticket.taskSnapshot,
          source: ticket.source,
          namingPrompt: ticket.namingPrompt,
          existingEnvironmentId: options.existingEnvironmentId ?? undefined,
          featurePlanId: options.featurePlanId,
        };
        const authoritative = await backend.launchBuildPipeline(request).catch((error: unknown) => {
          if (!isUnsupportedBackendCommand(error, "launch_build_pipeline")) throw error;
          return backend.startBuildPipeline(legacyBuildPipelineStartInput(config, request));
        });
        const pipeline = authoritative as BuildPipeline;
        replacePipeline(pipeline);
        // An idempotent admission can return a pipeline whose environment is
        // still being provisioned. Defer the tab handoff until that id arrives,
        // the same way the create-feature dialog does.
        scheduleBuildPipelineTabActivation(
          ticket.projectId,
          pipeline.id,
          pipeline.environmentId || undefined,
        );
        toast.success("Build pipeline started");
        return pipeline.id;
      } catch (error) {
        console.error("[useBuildPipeline] Failed to start build:", error);
        toast.error("Failed to start build pipeline", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
        return undefined;
      }
    },
    [config, replacePipeline],
  );

  const startBuild = useCallback(
    async (
      task: KanbanTask,
      environmentType: EnvironmentType,
      agentOverride?: DefaultAgent,
      options?: StartBuildOptions,
    ) => {
      const images = await Promise.all(
        (task.images ?? []).map(async (image) => {
          try {
            return {
              filename: image.filename,
              data: await backend.getKanbanImageData(image.id),
            };
          } catch {
            return null;
          }
        }),
      );
      return startBuildFromTicket(
        kanbanTaskBuildTicket(
          task,
          images.filter((image): image is { filename: string; data: string } => image !== null),
        ),
        environmentType,
        agentOverride,
        options,
      );
    },
    [startBuildFromTicket],
  );

  const navigateToPipeline = useCallback(
    async (
      pipeline: Pick<BuildPipeline, "environmentId" | "projectId" | "taskId"> &
        Partial<Pick<BuildPipeline, "id" | "environmentType">>,
    ) => {
      if (!pipeline.environmentId) return;
      setProjectCollapsed(pipeline.projectId, false);
      selectProjectAndEnvironment(pipeline.projectId, pipeline.environmentId);
      const state = usePaneLayoutStore.getState().environments.get(pipeline.environmentId);
      const tab = state && findBuildTabInTree(state.root, pipeline.taskId);
      if (tab) {
        usePaneLayoutStore.getState().setActiveTab(tab.paneId, tab.tabId, pipeline.environmentId);
      }
    },
    [selectProjectAndEnvironment, setProjectCollapsed],
  );

  const navigateToBuild = useCallback(
    async (task: KanbanTask) => {
      const pipeline = useBuildPipelineStore.getState().getPipelineByTaskId(task.id);
      if (pipeline) await navigateToPipeline(pipeline);
    },
    [navigateToPipeline],
  );

  return {
    startBuild,
    startBuildFromLinearIssue: (
      issue: LinearIssueDetail,
      projectId: string,
      environmentType: EnvironmentType,
      options: StartBuildOptions = {},
    ) =>
      startBuildFromTicket(
        linearIssueBuildTicket(issue, projectId, options.includeComments ?? true),
        environmentType,
        undefined,
        options,
      ),
    startBuildFromGitHubIssue: (
      issue: GitHubIssueBuildInput,
      projectId: string,
      environmentType: EnvironmentType,
      agentOverride?: DefaultAgent,
      options?: StartBuildOptions,
    ) =>
      startBuildFromTicket(
        githubIssueBuildTicket(issue, projectId),
        environmentType,
        agentOverride,
        options,
      ),
    navigateToBuild,
    navigateToPipeline,
  };
}
