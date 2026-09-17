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

export { BUILD_PIPELINE_VERSION, isActiveBuildPhase, isBuildPipeline };
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
  /**
   * Environments whose pipeline is in an in-flight agent phase (not setup,
   * stalled, paused, or terminal). O(1) sidebar lookup; rebuilt with the
   * pipeline map so it cannot drift from replace/remove.
   */
  activeBuildEnvironmentIds: Set<string>;
  /**
   * Renderer-only stage selection shared by the build tab and shell info pane.
   * Agent stages use their SDK session id; backend validation uses a namespaced
   * synthetic id because it has no agent session.
   */
  viewedSessionIds: Map<string, string>;

  /** The only insertion/update path: replace with an authoritative snapshot. */
  replacePipeline: (pipeline: BuildPipeline) => void;
  /** Projection cleanup after an authoritative delete/resource reconciliation. */
  removePipeline: (pipelineId: string) => void;
  removePipelinesForTask: (taskId: string) => void;
  removePipelinesForEnvironment: (environmentId: string) => void;
  setViewedSessionId: (pipelineId: string, sessionId: string | null) => void;

  getPipelineByTaskId: (taskId: string) => BuildPipeline | undefined;
  getPipelineForGitHubIssue: (
    repositoryOwner: string,
    repositoryName: string,
    issueNumber: number,
    activeOnly?: boolean,
  ) => BuildPipeline | undefined;
  getPipelineById: (id: string) => BuildPipeline | undefined;
  getActivePipelineForEnvironment: (environmentId: string) => BuildPipeline | undefined;
  isBuildEnvironment: (environmentId: string) => boolean;
}

const SETUP_BUILD_PHASES = new Set<BuildPhase>([
  "creating-environment",
  "starting-environment",
  "waiting-for-setup",
]);

/** True when a pipeline should paint the environment icon as working. */
export function isWorkingBuildPipeline(pipeline: BuildPipeline): boolean {
  return (
    isActiveBuildPhase(pipeline.phase) &&
    !SETUP_BUILD_PHASES.has(pipeline.phase) &&
    pipeline.stallWarning === undefined
  );
}

function environmentIds(pipelines: ReadonlyMap<string, BuildPipeline>): Set<string> {
  const ids = new Set<string>();
  for (const pipeline of pipelines.values()) {
    if (pipeline.environmentId) ids.add(pipeline.environmentId);
  }
  return ids;
}

function activeEnvironmentIds(pipelines: ReadonlyMap<string, BuildPipeline>): Set<string> {
  const ids = new Set<string>();
  for (const pipeline of pipelines.values()) {
    if (pipeline.environmentId && isWorkingBuildPipeline(pipeline)) {
      ids.add(pipeline.environmentId);
    }
  }
  return ids;
}

function pipelineProjection(pipelines: Map<string, BuildPipeline>) {
  return {
    pipelines,
    buildEnvironmentIds: environmentIds(pipelines),
    activeBuildEnvironmentIds: activeEnvironmentIds(pipelines),
  };
}

function without(
  pipelines: ReadonlyMap<string, BuildPipeline>,
  predicate: (pipeline: BuildPipeline) => boolean,
): Map<string, BuildPipeline> {
  return new Map(Array.from(pipelines).filter(([, pipeline]) => !predicate(pipeline)));
}

export const useBuildPipelineStore = create<BuildPipelineState>()((set, get) => ({
  pipelines: new Map(),
  buildEnvironmentIds: new Set(),
  activeBuildEnvironmentIds: new Set(),
  viewedSessionIds: new Map(),

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
      return pipelineProjection(pipelines);
    });
  },

  removePipeline: (pipelineId) =>
    set((state) => {
      if (!state.pipelines.has(pipelineId)) return state;
      const pipelines = new Map(state.pipelines);
      pipelines.delete(pipelineId);
      const viewedSessionIds = new Map(state.viewedSessionIds);
      viewedSessionIds.delete(pipelineId);
      return {
        ...pipelineProjection(pipelines),
        viewedSessionIds,
      };
    }),

  removePipelinesForTask: (taskId) =>
    set((state) => {
      const pipelines = without(state.pipelines, (pipeline) => pipeline.taskId === taskId);
      if (pipelines.size === state.pipelines.size) return state;
      const viewedSessionIds = new Map(
        Array.from(state.viewedSessionIds).filter(([pipelineId]) => pipelines.has(pipelineId)),
      );
      return {
        ...pipelineProjection(pipelines),
        viewedSessionIds,
      };
    }),

  removePipelinesForEnvironment: (environmentId) =>
    set((state) => {
      const pipelines = without(
        state.pipelines,
        (pipeline) => pipeline.environmentId === environmentId,
      );
      if (pipelines.size === state.pipelines.size) return state;
      const viewedSessionIds = new Map(
        Array.from(state.viewedSessionIds).filter(([pipelineId]) => pipelines.has(pipelineId)),
      );
      return {
        ...pipelineProjection(pipelines),
        viewedSessionIds,
      };
    }),

  setViewedSessionId: (pipelineId, sessionId) =>
    set((state) => {
      if (state.viewedSessionIds.get(pipelineId) === sessionId) return state;
      const viewedSessionIds = new Map(state.viewedSessionIds);
      if (sessionId) viewedSessionIds.set(pipelineId, sessionId);
      else viewedSessionIds.delete(pipelineId);
      return { viewedSessionIds };
    }),

  getPipelineByTaskId: (taskId) =>
    Array.from(get().pipelines.values()).find((pipeline) => pipeline.taskId === taskId),

  getPipelineForGitHubIssue: (repositoryOwner, repositoryName, issueNumber, activeOnly = false) =>
    Array.from(get().pipelines.values()).find(
      (pipeline) =>
        pipeline.source?.type === "github" &&
        pipeline.source.repositoryOwner === repositoryOwner &&
        pipeline.source.repositoryName === repositoryName &&
        pipeline.source.issueNumber === issueNumber &&
        (!activeOnly || isActiveBuildPhase(pipeline.phase)),
    ),

  getPipelineById: (id) => get().pipelines.get(id),

  getActivePipelineForEnvironment: (environmentId) => {
    for (const pipeline of get().pipelines.values()) {
      if (pipeline.environmentId === environmentId && isActiveBuildPhase(pipeline.phase)) {
        return pipeline;
      }
    }
    return undefined;
  },

  isBuildEnvironment: (environmentId) => get().buildEnvironmentIds.has(environmentId),
}));
