import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { DeliveryPolicy } from "@orkestrator/protocol/ticket-sections";

import type { BuildPipelineContext } from "./build-pipeline-context.js";
import { buildPipelineKanbanUpdate } from "./build-pipeline-kanban-lifecycle.js";
import { BuildPipelineRecovery } from "./build-pipeline-service-recovery.js";
import type { StorageService } from "./storage.js";

/**
 * The build lifecycle's ticket writes as one machine's backend makes them: the
 * real `BuildPipelineRecovery` over a real storage service, with `invoke`
 * routed to that storage the way the command registry routes it. A test runs
 * it on a command node, or on a leaf whose ticket is a synced copy.
 */

export const PR_URL = "https://github.com/acme/repo/pull/7";

export interface LifecycleMachine {
  recovery: BuildPipelineRecovery;
  pipeline(taskId: string, overrides?: Partial<BuildPipeline>): BuildPipeline;
  /** Build start (also a restart): `startStage("build")` and the supervisor's reactivation. */
  started(pipeline: BuildPipeline): Promise<void>;
  /** Ship found the pull request in `state`. */
  prDetected(pipeline: BuildPipeline, state: "open" | "merged"): Promise<void>;
  /** The run ended: `complete` (with Notes) or `failed` (also a cancel). */
  ended(pipeline: BuildPipeline, phase: "complete" | "failed"): Promise<void>;
}

export async function lifecycleMachine(
  storage: StorageService,
  environmentId: string,
  projectId: string,
): Promise<LifecycleMachine> {
  if (!(await storage.getEnvironment(environmentId))) {
    await storage.addEnvironment({
      id: environmentId,
      projectId,
      name: "build",
      branch: "build",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "full",
      order: 0,
      environmentType: "local",
      worktreePath: "/tmp/build",
      setupScriptsComplete: true,
    });
  }
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const kanban = storage.kanban;
    switch (command) {
      case "get_kanban_tasks":
        return (await kanban.getKanbanTasks(String(args.projectId))) as T;
      case "update_kanban_task": {
        const { taskId, preserveDoneStatus, ...updates } = args;
        return (await kanban.updateKanbanTask(String(taskId), updates, undefined, {
          preserveDoneStatus: preserveDoneStatus === true,
        })) as T;
      }
      case "add_kanban_comment":
        return (await kanban.addKanbanComment(String(args.taskId), String(args.text))) as T;
      case "close_kanban_task_for_merged_pr": {
        const moved = await kanban.closeKanbanTasksForMergedPullRequests([
          { taskId: String(args.taskId), prUrl: String(args.prUrl) },
        ]);
        return { closed: moved.length > 0 } as T;
      }
      case "pr_monitor_watch":
        return undefined as T;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  };
  const ctx = {
    storage,
    invoke,
    save: async () => undefined,
    provisioningPrompts: new Map(),
    lastProviderAgent: new Map(),
  } as unknown as BuildPipelineContext;
  const recovery = new BuildPipelineRecovery(ctx, {} as never);
  return {
    recovery,
    pipeline: (taskId, overrides = {}) =>
      ({
        id: `pipeline-${taskId}`,
        projectId,
        environmentId,
        taskId,
        taskTitle: "Ticket",
        source: { type: "kanban", taskId },
        phase: "building",
        sessions: [],
        currentSessionIndex: 0,
        backendRevision: 0,
        createdAt: new Date(0).toISOString(),
        ...overrides,
      }) as unknown as BuildPipeline,
    started: (pipeline) =>
      recovery.updateKanbanLifecycle(pipeline, buildPipelineKanbanUpdate("build-started")),
    prDetected: async (pipeline, state) => {
      // Ship opened it: `pipelineReachedPullRequestStage`.
      pipeline.sessions.push({ phase: "pr", label: "PR Session", status: "idle" } as never);
      await recovery.persistPullRequest(pipeline, {
        url: PR_URL,
        state,
        hasMergeConflicts: false,
      });
    },
    ended: async (pipeline, phase) => {
      pipeline.phase = phase;
      delete pipeline.completionCommentStatus;
      await recovery.reconcileTerminalState(pipeline);
    },
  };
}

/** A delivery decision as Verify records it. */
export function delivery(policy: DeliveryPolicy): BuildPipeline["delivery"] {
  return { policy, decidedAt: new Date(0).toISOString() } as BuildPipeline["delivery"];
}
