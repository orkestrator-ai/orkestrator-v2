import { useCallback } from "react";
import { toast } from "sonner";
import type {
  BuildPipelineSource,
  BuildStepConfigs,
  StartBuildPipelineInput,
  TaskSnapshot,
} from "@orkestrator/protocol/build-pipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import * as backend from "@/lib/backend";
import { resolveBuildPipelineAgent } from "@/lib/build-pipeline-agent";
import type { DefaultAgent, EnvironmentType } from "@/types";
import type { KanbanTask } from "@/lib/backend";
import type { PaneNode } from "@/types/paneLayout";
import type { LinearIssueDetail } from "@/types/linear";

type BuildPipelineTicketInput = {
  id: string;
  projectId: string;
  title: string;
  taskSnapshot: TaskSnapshot;
  source: BuildPipelineSource;
  namingPrompt: string;
};

type StartBuildOptions = {
  existingEnvironmentId?: string | null;
  featurePlanId?: string;
  /** Per-step harness, model and reasoning chosen in the build launcher. */
  steps?: BuildStepConfigs;
};

export type GitHubIssueBuildComment = {
  id: string | number;
  body: string;
  authorLogin?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type GitHubIssueBuildInput = {
  repositoryOwner: string;
  repositoryName: string;
  number: number;
  url: string;
  title: string;
  body: string;
  labels: string[];
  status: string;
  comments: GitHubIssueBuildComment[];
  authorLogin?: string;
  assigneeLogins?: string[];
  createdAt?: string;
  updatedAt?: string;
};

function linearIssueToTicketInput(
  issue: LinearIssueDetail,
  projectId: string,
): BuildPipelineTicketInput {
  const comments = [
    { text: `Linear issue: ${issue.identifier}` },
    ...(issue.url ? [{ text: `URL: ${issue.url}` }] : []),
    ...(issue.status ? [{ text: `Status: ${issue.status}` }] : []),
    ...issue.comments.map((comment) => ({
      text: comment.authorName
        ? `${comment.authorName}: ${comment.body}`
        : comment.body,
    })),
  ];
  return {
    id: issue.id,
    projectId,
    title: `${issue.identifier}: ${issue.title}`,
    namingPrompt: [
      issue.identifier,
      issue.title,
      issue.description,
      issue.status,
    ].filter(Boolean).join("\n\n"),
    source: {
      type: "linear",
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      issueUrl: issue.url,
      status: issue.status,
      teamKey: issue.teamKey,
      updatedAt: issue.updatedAt,
    },
    taskSnapshot: {
      title: `${issue.identifier}: ${issue.title}`,
      description: issue.description,
      acceptanceCriteria: "",
      comments,
      images: [],
    },
  };
}

function githubIssueToTicketInput(
  issue: GitHubIssueBuildInput,
  projectId: string,
): BuildPipelineTicketInput {
  const repository = `${issue.repositoryOwner}/${issue.repositoryName}`;
  return {
    id: `github:${repository.toLowerCase()}#${issue.number}`,
    projectId,
    title: `#${issue.number}: ${issue.title}`,
    namingPrompt: [
      `GitHub issue ${repository}#${issue.number}`,
      issue.title,
      issue.body,
      issue.status,
    ].filter(Boolean).join("\n\n"),
    source: {
      type: "github",
      repositoryOwner: issue.repositoryOwner,
      repositoryName: issue.repositoryName,
      issueNumber: issue.number,
      issueUrl: issue.url,
      status: issue.status,
      updatedAt: issue.updatedAt,
    },
    taskSnapshot: {
      title: `#${issue.number}: ${issue.title}`,
      description: issue.body,
      acceptanceCriteria: "",
      comments: issue.comments.map((comment) => ({
        text: `${comment.authorLogin ? `@${comment.authorLogin}: ` : ""}${comment.body}`,
      })),
      images: [],
    },
  };
}

function findBuildTabInTree(
  node: PaneNode,
  taskId: string,
): { paneId: string; tabId: string } | null {
  if (node.kind === "leaf") {
    const tab = node.tabs.find(
      (candidate) =>
        candidate.type === "claude-build"
        && candidate.buildTabData?.taskId === taskId,
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
  const selectProjectAndEnvironment = useUIStore(
    (state) => state.selectProjectAndEnvironment,
  );
  const setProjectCollapsed = useUIStore((state) => state.setProjectCollapsed);

  const startBuildFromTicket = useCallback(async (
    ticket: BuildPipelineTicketInput,
    environmentType: EnvironmentType,
    agentOverride?: DefaultAgent,
    options: StartBuildOptions = {},
  ) => {
    try {
      const input: StartBuildPipelineInput = {
        taskId: ticket.id,
        projectId: ticket.projectId,
        environmentType,
        // The build step's harness is the pipeline agent when one was chosen;
        // the backend resolves it the same way, so both agree on the snapshot.
        agentType:
          options.steps?.build?.agent
          ?? agentOverride
          ?? resolveBuildPipelineAgent(config, ticket.projectId),
        steps: options.steps,
        taskTitle: ticket.title,
        taskSnapshot: ticket.taskSnapshot,
        source: ticket.source,
        namingPrompt: ticket.namingPrompt,
        existingEnvironmentId: options.existingEnvironmentId ?? undefined,
        featurePlanId: options.featurePlanId,
      };
      const authoritative = await backend.startBuildPipeline(input);
      const pipeline = authoritative as BuildPipeline;
      replacePipeline(pipeline);
      setProjectCollapsed(ticket.projectId, false);
      selectProjectAndEnvironment(ticket.projectId, pipeline.environmentId);
      toast.success("Build pipeline started");
      return pipeline.id;
    } catch (error) {
      console.error("[useBuildPipeline] Failed to start build:", error);
      toast.error("Failed to start build pipeline", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
      return undefined;
    }
  }, [
    config,
    replacePipeline,
    selectProjectAndEnvironment,
    setProjectCollapsed,
  ]);

  const startBuild = useCallback(async (
    task: KanbanTask,
    environmentType: EnvironmentType,
    agentOverride?: DefaultAgent,
    options?: StartBuildOptions,
  ) => {
    const images = await Promise.all((task.images ?? []).map(async (image) => {
      try {
        return {
          filename: image.filename,
          data: await backend.getKanbanImageData(image.id),
        };
      } catch {
        return null;
      }
    }));
    return startBuildFromTicket({
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      namingPrompt: [
        task.title,
        task.description,
        task.acceptanceCriteria,
      ].filter(Boolean).join("\n\n"),
      source: { type: "kanban", taskId: task.id },
      taskSnapshot: {
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        comments: task.comments.map((comment) => ({ text: comment.text })),
        images: images.filter(
          (image): image is { filename: string; data: string } => image !== null,
        ),
      },
    }, environmentType, agentOverride, options);
  }, [startBuildFromTicket]);

  const navigateToPipeline = useCallback(async (
    pipeline: Pick<
      BuildPipeline,
      "environmentId" | "projectId" | "taskId"
    > & Partial<Pick<BuildPipeline, "id" | "environmentType">>,
  ) => {
    if (!pipeline.environmentId) return;
    setProjectCollapsed(pipeline.projectId, false);
    selectProjectAndEnvironment(pipeline.projectId, pipeline.environmentId);
    const state = usePaneLayoutStore.getState().environments.get(
      pipeline.environmentId,
    );
    const tab = state && findBuildTabInTree(state.root, pipeline.taskId);
    if (tab) {
      usePaneLayoutStore.getState().setActiveTab(
        tab.paneId,
        tab.tabId,
        pipeline.environmentId,
      );
    }
  }, [selectProjectAndEnvironment, setProjectCollapsed]);

  const navigateToBuild = useCallback(async (task: KanbanTask) => {
    const pipeline = useBuildPipelineStore.getState().getPipelineByTaskId(task.id);
    if (pipeline) await navigateToPipeline(pipeline);
  }, [navigateToPipeline]);

  return {
    startBuild,
    startBuildFromLinearIssue: (
      issue: LinearIssueDetail,
      projectId: string,
      environmentType: EnvironmentType,
    ) => startBuildFromTicket(
      linearIssueToTicketInput(issue, projectId),
      environmentType,
    ),
    startBuildFromGitHubIssue: (
      issue: GitHubIssueBuildInput,
      projectId: string,
      environmentType: EnvironmentType,
      agentOverride?: DefaultAgent,
      options?: StartBuildOptions,
    ) => startBuildFromTicket(
      githubIssueToTicketInput(issue, projectId),
      environmentType,
      agentOverride,
      options,
    ),
    navigateToBuild,
    navigateToPipeline,
  };
}
