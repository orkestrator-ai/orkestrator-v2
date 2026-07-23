import { create } from "zustand";
import type { DefaultAgent, EnvironmentType } from "@/types";
import type { TaskSnapshot } from "@/prompts";
import { createUuid } from "@/lib/uuid";

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

export type BuildPipelineSource =
  | { type: "kanban"; taskId: string }
  | {
      type: "linear";
      issueId: string;
      issueIdentifier: string;
      issueUrl?: string;
      status?: string;
      teamKey?: string;
      updatedAt?: string;
    };

export type CompletionCommentStatus = "posting" | "posted" | "failed";

export type PipelineFailureKind = "prompt-dispatch" | "stage-transition";

export interface PipelineFailureContext {
  phase: ResumableBuildPhase;
  kind: PipelineFailureKind;
  sessionId?: string;
  prompt?: string;
  useTaskImages?: boolean;
  requestId?: string;
}

export interface PipelineReconnectAttempt {
  id: string;
  phase: ResumableBuildPhase;
  kind: PipelineFailureKind;
  sessionId?: string;
  prompt?: string;
  useTaskImages?: boolean;
  requestId?: string;
  startedAt: string;
}

export interface PipelinePromptAttempt {
  id: string;
  sessionId: string;
  requestId: string;
  phase: ResumableBuildPhase;
  prompt: string;
  useTaskImages: boolean;
  startedAt: string;
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
  failureContext?: PipelineFailureContext;
  reconnectAttempt?: PipelineReconnectAttempt;
  pendingPromptAttempt?: PipelinePromptAttempt;
  activePromptContext?: PipelineFailureContext;
  createdAt: string;
  taskTitle: string;
  taskSnapshot: TaskSnapshot;
  source?: BuildPipelineSource;
  completionCommentStatus?: CompletionCommentStatus;
  completionCommentError?: string;
  completionCommentId?: string;
  completionCommentPostedAt?: string;
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
    source?: BuildPipelineSource;
  }) => string;
  setPipelineEnvironment: (pipelineId: string, environmentId: string) => void;
  addSession: (pipelineId: string, session: PipelineSession) => void;
  setPhase: (pipelineId: string, phase: BuildPhase) => void;
  markSessionIdle: (pipelineId: string, sdkSessionId: string) => void;
  setCurrentSessionIndex: (pipelineId: string, index: number) => void;
  setVerificationResult: (pipelineId: string, result: "pass" | "fail", feedback: string) => void;
  incrementIteration: (pipelineId: string) => void;
  setPipelineError: (pipelineId: string, error: string, context?: PipelineFailureContext | null) => void;
  beginReconnect: (pipelineId: string, attempt: PipelineReconnectAttempt) => boolean;
  completeReconnect: (pipelineId: string, attemptId: string) => boolean;
  failReconnect: (pipelineId: string, attemptId: string, error: string) => boolean;
  beginPromptAttempt: (pipelineId: string, attempt: PipelinePromptAttempt) => boolean;
  completePromptAttempt: (pipelineId: string, attemptId: string) => boolean;
  pausePipeline: (pipelineId: string) => void;
  resumePipeline: (pipelineId: string, fallbackPhase?: ResumableBuildPhase) => ResumableBuildPhase | undefined;
  markSessionRunning: (pipelineId: string, sdkSessionId: string) => void;
  setCompletionCommentStatus: (
    pipelineId: string,
    status: CompletionCommentStatus,
    details?: { commentId?: string; postedAt?: string; error?: string },
  ) => void;
  clearCompletionCommentStatus: (pipelineId: string) => void;
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

  createPipeline: ({ taskId, projectId, environmentType, agentType, taskTitle, taskSnapshot, source }) => {
    const id = createUuid();
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
      source: source ?? { type: "kanban", taskId },
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
      const preservesReconnect = pipeline.reconnectAttempt?.phase === phase;
      const preservesFailureContext = pipeline.phase === phase || preservesReconnect;
      newMap.set(pipelineId, {
        ...pipeline,
        phase,
        pausedFromPhase,
        failureContext: preservesFailureContext ? pipeline.failureContext : undefined,
        reconnectAttempt: preservesReconnect ? pipeline.reconnectAttempt : undefined,
        pendingPromptAttempt: pipeline.pendingPromptAttempt?.phase === phase
          ? pipeline.pendingPromptAttempt
          : undefined,
        activePromptContext: pipeline.activePromptContext?.phase === phase
          ? pipeline.activePromptContext
          : undefined,
      });
      return { pipelines: newMap };
    }),

  markSessionIdle: (pipelineId, sdkSessionId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const session = pipeline.sessions.find((candidate) => candidate.sdkSessionId === sdkSessionId);
      if (!session) return state;
      const clearsPromptContext = pipeline.activePromptContext?.sessionId === sdkSessionId;
      const clearsPendingAttempt = pipeline.pendingPromptAttempt?.sessionId === sdkSessionId;
      const clearsFailureContext = pipeline.failureContext?.kind === "prompt-dispatch"
        && pipeline.failureContext.sessionId === sdkSessionId;
      if (session.status === "idle" && !clearsPromptContext && !clearsPendingAttempt && !clearsFailureContext) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      const sessions = pipeline.sessions.map((s) =>
        s.sdkSessionId === sdkSessionId ? { ...s, status: "idle" as const } : s
      );
      newMap.set(pipelineId, {
        ...pipeline,
        sessions,
        activePromptContext: pipeline.activePromptContext?.sessionId === sdkSessionId
          ? undefined
          : pipeline.activePromptContext,
        pendingPromptAttempt: clearsPendingAttempt ? undefined : pipeline.pendingPromptAttempt,
        failureContext: clearsFailureContext ? undefined : pipeline.failureContext,
      });
      return { pipelines: newMap };
    }),

  setCurrentSessionIndex: (pipelineId, index) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (pipeline.currentSessionIndex === index) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, { ...pipeline, currentSessionIndex: index });
      return { pipelines: newMap };
    }),

  setVerificationResult: (pipelineId, result, feedback) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (pipeline.verificationResult === result && pipeline.verificationFeedback === feedback) return state;
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

  setPipelineError: (pipelineId, error, context) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (
        pipeline.phase === "complete"
        || (pipeline.phase === "paused" && context !== null)
      ) {
        return state;
      }
      if (
        context
        && pipeline.phase !== "failed"
        && pipeline.phase !== context.phase
      ) {
        return state;
      }
      if (
        context
        && pipeline.phase === "failed"
        && pipeline.failureContext
        && (
          pipeline.failureContext.phase !== context.phase
          || pipeline.failureContext.kind !== context.kind
          || pipeline.failureContext.sessionId !== context.sessionId
          || pipeline.failureContext.prompt !== context.prompt
          || pipeline.failureContext.useTaskImages !== context.useTaskImages
          || pipeline.failureContext.requestId !== context.requestId
        )
      ) {
        return state;
      }
      const failureContext = context === null
        ? undefined
        : context
          ?? pipeline.activePromptContext
          ?? (isResumableBuildPhase(pipeline.phase)
            ? { phase: pipeline.phase, kind: "stage-transition" as const }
            : pipeline.failureContext);
      // No-op if already failed with the same error, so subscribers don't
      // re-render in a loop (prevents "Maximum update depth exceeded").
      if (
        pipeline.phase === "failed"
        && pipeline.error === error
        && pipeline.failureContext?.phase === failureContext?.phase
        && pipeline.failureContext?.kind === failureContext?.kind
        && pipeline.failureContext?.sessionId === failureContext?.sessionId
        && pipeline.failureContext?.prompt === failureContext?.prompt
        && pipeline.failureContext?.useTaskImages === failureContext?.useTaskImages
        && pipeline.failureContext?.requestId === failureContext?.requestId
        && !pipeline.reconnectAttempt
        && !pipeline.pendingPromptAttempt
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...pipeline,
        phase: "failed",
        error,
        pausedFromPhase: undefined,
        failureContext,
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
      });
      return { pipelines: newMap };
    }),

  beginReconnect: (pipelineId, attempt) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (
      !pipeline
      || pipeline.phase !== "failed"
      || pipeline.reconnectAttempt
      || !pipeline.failureContext
      || pipeline.failureContext.phase !== attempt.phase
      || pipeline.failureContext.kind !== attempt.kind
      || pipeline.failureContext.sessionId !== attempt.sessionId
      || pipeline.failureContext.prompt !== attempt.prompt
      || pipeline.failureContext.useTaskImages !== attempt.useTaskImages
      || pipeline.failureContext.requestId !== attempt.requestId
    ) {
      return false;
    }

    let started = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (
        !latest
        || latest.phase !== "failed"
        || latest.reconnectAttempt
        || !latest.failureContext
        || latest.failureContext.phase !== attempt.phase
        || latest.failureContext.kind !== attempt.kind
        || latest.failureContext.sessionId !== attempt.sessionId
        || latest.failureContext.prompt !== attempt.prompt
        || latest.failureContext.useTaskImages !== attempt.useTaskImages
        || latest.failureContext.requestId !== attempt.requestId
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        phase: attempt.phase,
        error: undefined,
        pausedFromPhase: undefined,
        reconnectAttempt: attempt,
        activePromptContext: attempt.kind === "prompt-dispatch"
          ? {
              phase: attempt.phase,
              kind: attempt.kind,
              sessionId: attempt.sessionId,
              prompt: attempt.prompt,
              useTaskImages: attempt.useTaskImages,
              requestId: attempt.requestId,
            }
          : undefined,
      });
      started = true;
      return { pipelines: newMap };
    });

    return started;
  },

  completeReconnect: (pipelineId, attemptId) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.reconnectAttempt?.id !== attemptId) return false;

    let completed = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.reconnectAttempt?.id !== attemptId) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        reconnectAttempt: undefined,
      });
      completed = true;
      return { pipelines: newMap };
    });

    return completed;
  },

  failReconnect: (pipelineId, attemptId, error) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.reconnectAttempt?.id !== attemptId) return false;

    let failed = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.reconnectAttempt?.id !== attemptId) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        phase: "failed",
        error,
        pausedFromPhase: undefined,
        failureContext: latest.activePromptContext ?? latest.failureContext ?? {
          phase: latest.reconnectAttempt.phase,
          kind: latest.reconnectAttempt.kind,
          sessionId: latest.reconnectAttempt.sessionId,
          prompt: latest.reconnectAttempt.prompt,
          useTaskImages: latest.reconnectAttempt.useTaskImages,
          requestId: latest.reconnectAttempt.requestId,
        },
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
      });
      failed = true;
      return { pipelines: newMap };
    });

    return failed;
  },

  beginPromptAttempt: (pipelineId, attempt) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (
      !pipeline
      || pipeline.phase !== attempt.phase
      || pipeline.pendingPromptAttempt
    ) {
      return false;
    }

    let started = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (
        !latest
        || latest.phase !== attempt.phase
        || latest.pendingPromptAttempt
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        pendingPromptAttempt: attempt,
        failureContext: undefined,
        activePromptContext: {
          phase: attempt.phase,
          kind: "prompt-dispatch",
          sessionId: attempt.sessionId,
          prompt: attempt.prompt,
          useTaskImages: attempt.useTaskImages,
          requestId: attempt.requestId,
        },
      });
      started = true;
      return { pipelines: newMap };
    });

    return started;
  },

  completePromptAttempt: (pipelineId, attemptId) => {
    const pipeline = get().pipelines.get(pipelineId);
    if (!pipeline || pipeline.pendingPromptAttempt?.id !== attemptId) return false;

    let completed = false;
    set((state) => {
      const latest = state.pipelines.get(pipelineId);
      if (!latest || latest.pendingPromptAttempt?.id !== attemptId) return state;
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...latest,
        pendingPromptAttempt: undefined,
      });
      completed = true;
      return { pipelines: newMap };
    });

    return completed;
  },

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
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
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
        failureContext: undefined,
        reconnectAttempt: undefined,
        pendingPromptAttempt: undefined,
        activePromptContext: undefined,
      });
      return { pipelines: newMap };
    });

    return resumePhase;
  },

  markSessionRunning: (pipelineId, sdkSessionId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const session = pipeline.sessions.find((candidate) => candidate.sdkSessionId === sdkSessionId);
      if (!session || session.status === "running") return state;
      const newMap = new Map(state.pipelines);
      const sessions = pipeline.sessions.map((s) =>
        s.sdkSessionId === sdkSessionId ? { ...s, status: "running" as const } : s
      );
      newMap.set(pipelineId, { ...pipeline, sessions });
      return { pipelines: newMap };
    }),

  setCompletionCommentStatus: (pipelineId, status, details) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      const completionCommentId = details?.commentId ?? pipeline.completionCommentId;
      const completionCommentPostedAt = details?.postedAt ?? pipeline.completionCommentPostedAt;
      const completionCommentError = status === "failed" ? details?.error : undefined;
      if (
        pipeline.completionCommentStatus === status
        && pipeline.completionCommentId === completionCommentId
        && pipeline.completionCommentPostedAt === completionCommentPostedAt
        && pipeline.completionCommentError === completionCommentError
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      newMap.set(pipelineId, {
        ...pipeline,
        completionCommentStatus: status,
        completionCommentId,
        completionCommentPostedAt,
        completionCommentError,
      });
      return { pipelines: newMap };
    }),

  clearCompletionCommentStatus: (pipelineId) =>
    set((state) => {
      const pipeline = state.pipelines.get(pipelineId);
      if (!pipeline) return state;
      if (
        pipeline.completionCommentStatus === undefined
        && pipeline.completionCommentError === undefined
        && pipeline.completionCommentId === undefined
        && pipeline.completionCommentPostedAt === undefined
      ) {
        return state;
      }
      const newMap = new Map(state.pipelines);
      const nextPipeline = { ...pipeline };
      delete nextPipeline.completionCommentStatus;
      delete nextPipeline.completionCommentError;
      delete nextPipeline.completionCommentId;
      delete nextPipeline.completionCommentPostedAt;
      newMap.set(pipelineId, nextPipeline);
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
