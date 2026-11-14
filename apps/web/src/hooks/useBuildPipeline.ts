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
import { useNodeScope } from "@/lib/node-scope/providers";
import {
  buildPipelineStore,
  useBuildPipelineStore,
  type BuildPipeline,
} from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { scheduleBuildPipelineTabActivation } from "@/lib/feature-build-activation";
import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";
import { legacyBuildPipelineStartInput } from "@/lib/build-pipeline-launch-compat";
import type { DefaultAgent, EnvironmentType, NetworkAccessMode } from "@/types";
import type { KanbanTask } from "@/lib/backend";
import type { PaneNode } from "@/types/paneLayout";
import type { LinearIssueDetail } from "@/types/linear";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useScopeBackend } from "@/hooks/useScopeBackend";
import { createLaunchesApi } from "@/lib/backend/launches";
import { machineBackendClient, scopeBackendClient } from "@/lib/backend/client";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import type { BuildLaunchMachineChoice } from "@/components/build/build-machines";

const log = createLogger("web.build-pipeline");

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
  /** The launch dialog's "When verified" choice. */
  deliveryPolicy?: DeliveryPolicy;
  /** The container's network access, when the launcher asked. */
  networkAccessMode?: NetworkAccessMode;
  /**
   * Run the pipeline on another machine that holds this repository's project,
   * instead of this tab's own. The pipeline then lives on that machine.
   */
  machine?: BuildLaunchMachineChoice;
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
  const nodeBackend = useScopeBackend();
  const config = useConfigStore((state) => state.config);
  const replacePipeline = useBuildPipelineStore((state) => state.replacePipeline);
  // This node's pipelines (plan item 3011).
  const scope = useNodeScope();
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
        const target = options.machine;
        const request: LaunchBuildPipelineInput = {
          taskId: ticket.id,
          // The other machine's own project for the same repository.
          projectId: target?.projectId ?? ticket.projectId,
          environmentType,
          ...(agentOverride ? { agentType: agentOverride } : {}),
          ...(options.steps ? { steps: options.steps } : {}),
          ...(options.reviewers ? { reviewers: options.reviewers } : {}),
          ...(options.reviewPreparation ? { reviewPreparation: options.reviewPreparation } : {}),
          ...(options.deliveryPolicy ? { deliveryPolicy: options.deliveryPolicy } : {}),
          // Applied only when the pipeline creates its environment. Without it
          // the backend creates a restricted container.
          ...(environmentType === "containerized" && options.networkAccessMode
            ? { environmentOptions: { networkAccessMode: options.networkAccessMode } }
            : {}),
          taskTitle: ticket.title,
          taskSnapshot: ticket.taskSnapshot,
          // Tickets sync between machines under one id, so the other machine
          // links the build to its copy and its lifecycle reaches this board.
          source: ticket.source,
          namingPrompt: ticket.namingPrompt,
          existingEnvironmentId: target ? undefined : (options.existingEnvironmentId ?? undefined),
          featurePlanId: target ? undefined : options.featurePlanId,
        };
        if (target) {
          const remote = await createLaunchesApi(
            machineBackendClient(scopeBackendClient(scope), target.machine),
          ).launchBuildPipeline(request);
          // The pipeline is that machine's: it is not added to this tab's store.
          toast.success(`Build pipeline started on ${target.name}`, {
            action: target.nodeId
              ? {
                  label: `Open on ${target.name}`,
                  onClick: () =>
                    openMachineWorkspace({
                      connectionId: target.nodeId!,
                      projectId: target.projectId,
                      ...(remote.environmentId ? { environmentId: remote.environmentId } : {}),
                      title: ticket.title,
                    }),
                }
              : undefined,
          });
          return remote.id;
        }
        const authoritative = await nodeBackend
          .launchBuildPipeline(request)
          .catch((error: unknown) => {
            if (incompatibility(error, "launch_build_pipeline")?.code !== "unknown-command")
              throw error;
            return nodeBackend.startBuildPipeline(legacyBuildPipelineStartInput(config, request));
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
          scope,
        );
        toast.success("Build pipeline started");
        return pipeline.id;
      } catch (error) {
        log.error("build.start-failed", {
          taskId: ticket.id,
          projectId: ticket.projectId,
          error: formatLogError(error),
        });
        toast.error("Failed to start build pipeline", {
          description: error instanceof Error ? error.message : "Unknown error",
        });
        return undefined;
      }
    },
    [config, replacePipeline, scope, nodeBackend],
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
              data: await nodeBackend.getKanbanImageData(image.id),
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
    [startBuildFromTicket, nodeBackend],
  );

  const navigateToPipeline = useCallback(
    async (
      pipeline: Pick<BuildPipeline, "environmentId" | "projectId" | "taskId"> &
        Partial<Pick<BuildPipeline, "id" | "environmentType">>,
    ) => {
      if (!pipeline.environmentId) return;
      setProjectCollapsed(pipeline.projectId, false);
      selectProjectAndEnvironment(pipeline.projectId, pipeline.environmentId);
      const panes = scope.store(paneLayoutStore).getState();
      const state = panes.environments.get(pipeline.environmentId);
      const tab = state && findBuildTabInTree(state.root, pipeline.taskId);
      if (tab) {
        panes.setActiveTab(tab.paneId, tab.tabId, pipeline.environmentId);
      }
    },
    [scope, selectProjectAndEnvironment, setProjectCollapsed],
  );

  const navigateToBuild = useCallback(
    async (task: KanbanTask) => {
      const pipeline = scope.store(buildPipelineStore).getState().getPipelineByTaskId(task.id);
      if (pipeline) await navigateToPipeline(pipeline);
    },
    [navigateToPipeline, scope],
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
