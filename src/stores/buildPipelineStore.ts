import { create } from "zustand";
import type { ClaudeSessionKey } from "@/lib/claude-client";
import type { EnvironmentType } from "@/types";

export type BuildPhase =
  | "creating-environment"
  | "starting-environment"
  | "building"
  | "reviewing"
  | "addressing"
  | "verifying"
  | "fixing"
  | "complete"
  | "failed";

export type PipelineSessionPhase = "build" | "review" | "verify" | "fix";

export interface PipelineSession {
  phase: PipelineSessionPhase;
  iteration: number;
  sessionKey: ClaudeSessionKey;
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
  phase: BuildPhase;
  sessions: PipelineSession[];
  currentSessionIndex: number;
  iteration: number;
  maxIterations: number;
  verificationResult?: "pass" | "fail";
  verificationFeedback?: string;
  error?: string;
  createdAt: string;
  taskTitle: string;
}

interface BuildPipelineState {
  pipelines: Map<string, BuildPipeline>;

  // Actions
  createPipeline: (params: {
    taskId: string;
    projectId: string;
    environmentType: EnvironmentType;
    taskTitle: string;
  }) => string;
  setPipelineEnvironment: (pipelineId: string, environmentId: string) => void;
  addSession: (pipelineId: string, session: PipelineSession) => void;
  setPhase: (pipelineId: string, phase: BuildPhase) => void;
  markSessionIdle: (pipelineId: string, sdkSessionId: string) => void;
  setCurrentSessionIndex: (pipelineId: string, index: number) => void;
  setVerificationResult: (pipelineId: string, result: "pass" | "fail", feedback: string) => void;
  incrementIteration: (pipelineId: string) => void;
  setPipelineError: (pipelineId: string, error: string) => void;

  // Selectors
  getPipelineByTaskId: (taskId: string) => BuildPipeline | undefined;
  getPipelineById: (id: string) => BuildPipeline | undefined;
  getActivePipelineForEnvironment: (environmentId: string) => BuildPipeline | undefined;
}

export const useBuildPipelineStore = create<BuildPipelineState>()((set, get) => ({
  pipelines: new Map(),

  createPipeline: ({ taskId, projectId, environmentType, taskTitle }) => {
    const id = crypto.randomUUID();
    const pipeline: BuildPipeline = {
      id,
      taskId,
      projectId,
      environmentId: "",
      environmentType,
      phase: "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: 3,
      createdAt: new Date().toISOString(),
      taskTitle,
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
      return { pipelines: newMap };
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
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, phase });
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
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, phase: "failed", error });
      return { pipelines: newMap };
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
}));
