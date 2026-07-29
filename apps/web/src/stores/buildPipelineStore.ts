import { create } from "zustand";
import {
  BUILD_PIPELINE_VERSION,
  isActiveBuildPhase,
  isBuildPipeline,
  type BuildPhase,
  type BuildPipeline,
  type BuildPipelineSource,
  type CompletionCommentStatus,
  type PipelineFailureContext,
  type PipelineFailureKind,
  type PipelinePromptAttempt,
  type PipelineReconnectAttempt,
  type PipelineSession,
  type PipelineSessionPhase,
  type ResumableBuildPhase,
} from "@orkestrator/protocol/build-pipeline";

export {
  BUILD_PIPELINE_VERSION,
  isActiveBuildPhase,
  isBuildPipeline,
};
export type {
  BuildPhase,
  BuildPipeline,
  BuildPipelineSource,
  CompletionCommentStatus,
  PipelineFailureContext,
  PipelineFailureKind,
  PipelinePromptAttempt,
  PipelineReconnectAttempt,
  PipelineSession,
  PipelineSessionPhase,
  ResumableBuildPhase,
};

interface BuildPipelineState {
  /** Backend snapshots cached for rendering; never authored by this store. */
  pipelines: Map<string, BuildPipeline>;
  buildEnvironmentIds: Set<string>;

  /** The only insertion/update path: replace with an authoritative snapshot. */
  replacePipeline: (pipeline: BuildPipeline) => void;
  /** Projection cleanup after an authoritative delete/resource reconciliation. */
  removePipeline: (pipelineId: string) => void;
  removePipelinesForTask: (taskId: string) => void;
  removePipelinesForEnvironment: (environmentId: string) => void;

  getPipelineByTaskId: (taskId: string) => BuildPipeline | undefined;
  getPipelineForGitHubIssue: (
    repositoryOwner: string,
    repositoryName: string,
    issueNumber: number,
    activeOnly?: boolean,
  ) => BuildPipeline | undefined;
  getPipelineById: (id: string) => BuildPipeline | undefined;
  getActivePipelineForEnvironment: (
    environmentId: string,
  ) => BuildPipeline | undefined;
  isBuildEnvironment: (environmentId: string) => boolean;
}

function environmentIds(
  pipelines: ReadonlyMap<string, BuildPipeline>,
): Set<string> {
  const ids = new Set<string>();
  for (const pipeline of pipelines.values()) {
    if (pipeline.environmentId) ids.add(pipeline.environmentId);
  }
  return ids;
}

function without(
  pipelines: ReadonlyMap<string, BuildPipeline>,
  predicate: (pipeline: BuildPipeline) => boolean,
): Map<string, BuildPipeline> {
  return new Map(
    Array.from(pipelines).filter(([, pipeline]) => !predicate(pipeline)),
  );
}

export const useBuildPipelineStore = create<BuildPipelineState>()((set, get) => ({
  pipelines: new Map(),
  buildEnvironmentIds: new Set(),

  replacePipeline: (pipeline) => {
    if (!isBuildPipeline(pipeline)) {
      throw new Error("Invalid backend build pipeline snapshot");
    }
    set((state) => {
      const current = state.pipelines.get(pipeline.id);
      if (current && current.backendRevision > pipeline.backendRevision) {
        return state;
      }
      const pipelines = new Map(state.pipelines);
      pipelines.set(pipeline.id, pipeline);
      return {
        pipelines,
        buildEnvironmentIds: environmentIds(pipelines),
      };
    });
  },

  removePipeline: (pipelineId) =>
    set((state) => {
      if (!state.pipelines.has(pipelineId)) return state;
      const pipelines = new Map(state.pipelines);
      pipelines.delete(pipelineId);
      return {
        pipelines,
        buildEnvironmentIds: environmentIds(pipelines),
      };
    }),

  removePipelinesForTask: (taskId) =>
    set((state) => {
      const pipelines = without(
        state.pipelines,
        (pipeline) => pipeline.taskId === taskId,
      );
      if (pipelines.size === state.pipelines.size) return state;
      return {
        pipelines,
        buildEnvironmentIds: environmentIds(pipelines),
      };
    }),

  removePipelinesForEnvironment: (environmentId) =>
    set((state) => {
      const pipelines = without(
        state.pipelines,
        (pipeline) => pipeline.environmentId === environmentId,
      );
      if (pipelines.size === state.pipelines.size) return state;
      return {
        pipelines,
        buildEnvironmentIds: environmentIds(pipelines),
      };
    }),

  getPipelineByTaskId: (taskId) =>
    Array.from(get().pipelines.values()).find(
      (pipeline) => pipeline.taskId === taskId,
    ),

  getPipelineForGitHubIssue: (
    repositoryOwner,
    repositoryName,
    issueNumber,
    activeOnly = false,
  ) =>
    Array.from(get().pipelines.values()).find((pipeline) =>
      pipeline.source?.type === "github"
      && pipeline.source.repositoryOwner === repositoryOwner
      && pipeline.source.repositoryName === repositoryName
      && pipeline.source.issueNumber === issueNumber
      && (!activeOnly || isActiveBuildPhase(pipeline.phase))
    ),

  getPipelineById: (id) => get().pipelines.get(id),

  getActivePipelineForEnvironment: (environmentId) =>
    Array.from(get().pipelines.values()).find(
      (pipeline) =>
        pipeline.environmentId === environmentId
        && isActiveBuildPhase(pipeline.phase),
    ),

  isBuildEnvironment: (environmentId) =>
    get().buildEnvironmentIds.has(environmentId),
}));
