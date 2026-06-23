import { create } from "zustand";
import type { DefaultAgent, EnvironmentType } from "@/types";
import type { TaskSnapshot } from "@/prompts";

export type BuildPhase =
  | "creating-environment"
  | "starting-environment"
  | "waiting-for-setup"
  | "building"
  | "reviewing"
  | "addressing"
  | "verifying"
  | "fixing"
  | "creating-pr"
  | "resolving-conflicts"
  | "paused"
  | "complete"
  | "failed";

export type ResumableBuildPhase = Exclude<BuildPhase, "paused" | "complete" | "failed">;

export type PipelineSessionPhase = "build" | "review" | "verify" | "fix" | "pr" | "resolve-conflicts";

export interface PipelineSession {
  phase: PipelineSessionPhase;
  iteration: number;
  sessionKey: string;
  sdkSessionId: string;
  status: "running" | "idle" | "error";
  startedAt: string;
  label: string;
}

export interface BuildPipeline {
  id: string;
  taskId: string;
  projectId: string;
  environmentId: string;
  environmentType: EnvironmentType;
  agentType: DefaultAgent;
  phase: BuildPhase;
  sessions: PipelineSession[];
  currentSessionIndex: number;
  iteration: number;
  maxIterations: number;
  verificationResult?: "pass" | "fail";
  verificationFeedback?: string;
  pausedFromPhase?: ResumableBuildPhase;
  error?: string;
  createdAt: string;
  taskTitle: string;
  taskSnapshot: TaskSnapshot;
}

interface BuildPipelineState {
  pipelines: Map<string, BuildPipeline>;
  /** Derived set of environment IDs associated with any pipeline, for O(1) lookups */
  buildEnvironmentIds: Set<string>;

  // Actions
  createPipeline: (params: {
    taskId: string;
    projectId: string;
    environmentType: EnvironmentType;
    agentType: DefaultAgent;
    taskTitle: string;
    taskSnapshot: TaskSnapshot;
  }) => string;
  setPipelineEnvironment: (pipelineId: string, environmentId: string) => void;
  addSession: (pipelineId: string, session: PipelineSession) => void;
  setPhase: (pipelineId: string, phase: BuildPhase) => void;
  markSessionIdle: (pipelineId: string, sdkSessionId: string) => void;
  setCurrentSessionIndex: (pipelineId: string, index: number) => void;
  setVerificationResult: (pipelineId: string, result: "pass" | "fail", feedback: string) => void;
  incrementIteration: (pipelineId: string) => void;
  setPipelineError: (pipelineId: string, error: string) => void;
  pausePipeline: (pipelineId: string) => void;
  resumePipeline: (pipelineId: string, fallbackPhase?: ResumableBuildPhase) => ResumableBuildPhase | undefined;
  markSessionRunning: (pipelineId: string, sdkSessionId: string) => void;
  removePipeline: (pipelineId: string) => void;
  removePipelinesForTask: (taskId: string) => void;

  // Selectors
  getPipelineByTaskId: (taskId: string) => BuildPipeline | undefined;
  getPipelineById: (id: string) => BuildPipeline | undefined;
  getActivePipelineForEnvironment: (environmentId: string) => BuildPipeline | undefined;
  isBuildEnvironment: (environmentId: string) => boolean;
  /** Rebuild the buildEnvironmentIds set from current pipelines */
  _rebuildBuildEnvironmentIds: () => Set<string>;
}

/**
 * Whether a build phase represents an in-progress build (a running, abortable
 * pipeline) as opposed to a terminal ("complete"/"failed") or "paused" phase.
 * Active builds must be stopped before their status is cleared so the underlying
 * agent session can be aborted rather than orphaned.
 */
export function isActiveBuildPhase(phase: BuildPhase): boolean {
  return phase !== "paused" && phase !== "complete" && phase !== "failed";
}

function isResumableBuildPhase(phase: BuildPhase): phase is ResumableBuildPhase {
  return isActiveBuildPhase(phase);
}

export const useBuildPipelineStore = create<BuildPipelineState>()((set, get) => ({
  pipelines: new Map(),
  buildEnvironmentIds: new Set<string>(),

  createPipeline: ({ taskId, projectId, environmentType, agentType, taskTitle, taskSnapshot }) => {
    const id = crypto.randomUUID();
    const pipeline: BuildPipeline = {
      id,
      taskId,
      projectId,
      environmentId: "",
      environmentType,
      agentType,
      phase: "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: new Date().toISOString(),
      taskTitle,
      taskSnapshot,
    };

    set((state) => {
      const newMap = new Map(state.pipelines);
      newMap.set(id, pipeline);
      return { pipelines: newMap };
    });

    return id;
  },

  setPipelineEnvironment: (pipelineId, environmentId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, environmentId });
      // Rebuild from the NEW map — get() still points at the old state inside set()
      const ids = new Set<string>();
      for (const p of newMap.values()) {
        if (p.environmentId) {
          ids.add(p.environmentId);
        }
      }
      return { pipelines: newMap, buildEnvironmentIds: ids };
    }),

  addSession: (pipelineId, session) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...pipeline,
        sessions: [...pipeline.sessions, session],
        currentSessionIndex: pipeline.sessions.length,
      });
      return { pipelines: newMap };
    }),

  setPhase: (pipelineId, phase) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      // A paused pipeline is intentionally locked for user intervention. Normal
      // stage detection must not move it forward until resumePipeline unlocks it.
      if (pipeline.phase === "paused" && phase !== "paused") return state;
      const newMap = new Map(state.pipelines);
      const pausedFromPhase = phase === "paused"
        ? isResumableBuildPhase(pipeline.phase)
          ? pipeline.phase
          : pipeline.pausedFromPhase
        : undefined;
      newMap.set(pipelineId, {
        ...pipeline,
        phase,
        pausedFromPhase,
      });
      return { pipelines: newMap };
    }),

  markSessionIdle: (pipelineId, sdkSessionId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      const sessions = pipeline.sessions.map((s) =>
        s.sdkSessionId === sdkSessionId ? { ...s, status: "idle" as const } : s
      );
      newMap.set(pipelineId, { ...pipeline, sessions });
      return { pipelines: newMap };
    }),

  setCurrentSessionIndex: (pipelineId, index) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, currentSessionIndex: index });
      return { pipelines: newMap };
    }),

  setVerificationResult: (pipelineId, result, feedback) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, verificationResult: result, verificationFeedback: feedback });
      return { pipelines: newMap };
    }),

  incrementIteration: (pipelineId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, iteration: pipeline.iteration + 1 });
      return { pipelines: newMap };
    }),

  setPipelineError: (pipelineId, error) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      // No-op if already failed with the same error, so subscribers don't
      // re-render in a loop (prevents "Maximum update depth exceeded").
      if (pipeline.phase === "failed" && pipeline.error === error) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, phase: "failed", error, pausedFromPhase: undefined });
      return { pipelines: newMap };
    }),

  pausePipeline: (pipelineId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      const pausedFromPhase = isResumableBuildPhase(pipeline.phase)
        ? pipeline.phase
        : pipeline.pausedFromPhase;
      newMap.set(pipelineId, {
        ...pipeline,
        phase: "paused",
        pausedFromPhase,
        error: undefined,
      });
      return { pipelines: newMap };
    }),

  resumePipeline: (pipelineId, fallbackPhase) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.phase !== "paused") return undefined;

    const resumePhase = pipeline.pausedFromPhase ?? fallbackPhase;
    if (!resumePhase) return undefined;

    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.phase !== "paused") return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        phase: resumePhase,
        pausedFromPhase: undefined,
        error: undefined,
      });
      return { pipelines: newMap };
    });

    return resumePhase;
  },

  markSessionRunning: (pipelineId, sdkSessionId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const newMap = new Map(state.pipelines);
      const sessions = pipeline.sessions.map((s) =>
        s.sdkSessionId === sdkSessionId ? { ...s, status: "running" as const } : s
      );
      newMap.set(pipelineId, { ...pipeline, sessions });
      return { pipelines: newMap };
    }),

  removePipeline: (pipelineId) =>
    set((state) => {
      if (!state.pipelines.has(pipelineId)) return state;
      const newMap = new Map(state.pipelines);
      newMap.delete(pipelineId);
      const ids = new Set<string>();
      for (const pipeline of newMap.values()) {
        if (pipeline.environmentId) {
          ids.add(pipeline.environmentId);
        }
      }
      return { pipelines: newMap, buildEnvironmentIds: ids };
    }),

  removePipelinesForTask: (taskId) =>
    set((state) => {
      const newMap = new Map(state.pipelines);
      let removed = false;
      for (const [pipelineId, pipeline] of newMap.entries()) {
        if (pipeline.taskId === taskId) {
          newMap.delete(pipelineId);
          removed = true;
        }
      }
      if (!removed) return state;

      const ids = new Set<string>();
      for (const pipeline of newMap.values()) {
        if (pipeline.environmentId) {
          ids.add(pipeline.environmentId);
        }
      }
      return { pipelines: newMap, buildEnvironmentIds: ids };
    }),

  getPipelineByTaskId: (taskId) => {
    for (const pipeline of get().pipelines.values()) {
      if (pipeline.taskId === taskId) return pipeline;
    }
    return undefined;
  },

  getPipelineById: (id) => get().pipelines.get(id),

  getActivePipelineForEnvironment: (environmentId) => {
    for (const pipeline of get().pipelines.values()) {
      if (pipeline.environmentId === environmentId && pipeline.phase !== "complete" && pipeline.phase !== "failed") {
        return pipeline;
      }
    }
    return undefined;
  },

  isBuildEnvironment: (environmentId) => get().buildEnvironmentIds.has(environmentId),

  _rebuildBuildEnvironmentIds: () => {
    const ids = new Set<string>();
    for (const pipeline of get().pipelines.values()) {
      if (pipeline.environmentId) {
        ids.add(pipeline.environmentId);
      }
    }
    return ids;
  },
}));
