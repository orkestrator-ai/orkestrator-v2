/**
 * Build pipeline workers inside a `MailWorld`: a pipeline environment whose
 * record the test edits, and the real pipeline side of delivery
 * (`BuildPipelineWorkerMail`, `dispatchWorkerMailTurn`) over a scripted
 * provider. Nothing here starts an agent.
 */
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  BUILD_PIPELINE_VERSION,
  type BuildPipeline,
  type PipelineSession,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import {
  pipelineWorkerTabId,
  type PipelineWorker,
} from "@orkestrator/protocol/pipeline-worker-mail";
import type { NativeAgentSessionActionOutcome } from "@orkestrator/protocol/native-agent";
import { BuildPipelineContext } from "./build-pipeline-context.js";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import type { BuildPipelineAgents } from "./build-pipeline-service-agents.js";
import { BuildPipelineWorkerMail, dispatchWorkerMailTurn } from "./build-pipeline-worker-mail.js";
import type { MailWorld } from "./agent-mail-world-test-support.js";
import { createEnvironment, type StorageService } from "./storage.js";

export const PIPELINE_ID = "11111111-2222-4333-8444-555555555555";

export function stageSession(
  phase: PipelineSessionPhase,
  options: {
    key: string;
    label?: string;
    iteration?: number;
    status?: PipelineSession["status"];
    messages?: unknown[];
  },
): PipelineSession {
  return {
    phase,
    agent: "codex",
    model: "gpt-test",
    iteration: options.iteration ?? 0,
    sessionKey: `${PIPELINE_ID}:${phase}:${options.iteration ?? 0}:${options.key}`,
    sdkSessionId: `sdk-${options.key}`,
    status: options.status ?? "running",
    startedAt: "2026-11-03T00:00:00.000Z",
    label: options.label ?? `${phase} session`,
    ...(options.messages ? { messages: options.messages, messageRevision: 1 } : {}),
  };
}

export function pipelineSnapshot(
  environmentId: string,
  projectId: string,
  sessions: PipelineSession[],
  overrides: Partial<BuildPipeline> = {},
): BuildPipeline {
  return {
    id: PIPELINE_ID,
    taskId: "task-1",
    projectId,
    environmentId,
    environmentType: "local",
    agentType: "codex",
    phase: "building",
    sessions,
    currentSessionIndex: sessions.length - 1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-11-03T00:00:00.000Z",
    taskTitle: "Task",
    taskSnapshot: {
      title: "Task",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 0,
    controller: "backend",
    ...overrides,
  };
}

/** A scripted provider: records steers and answers as the test sets it up. */
export class ScriptedSteerProvider {
  steerable = true;
  activeRun: "running" | "idle" = "running";
  nextOutcome: NativeAgentSessionActionOutcome["outcome"] = "applied";
  readonly steers: Array<{ sessionId: string; text: string; requestId: string }> = [];

  provider(): BuildPipelineProvider {
    return {
      steerSupported: async () => this.steerable,
      activeSteerRun: async () =>
        this.activeRun === "running" ? { state: "running", runId: "run-1" } : { state: "idle" },
      steerStatus: async () => "unknown",
      performSessionAction: async (
        sessionId: string,
        action: { kind: string; text: string; requestId: string },
      ) => {
        if (action.kind !== "steer") throw new Error("unexpected action");
        this.steers.push({ sessionId, text: action.text, requestId: action.requestId });
        return { outcome: this.nextOutcome } as NativeAgentSessionActionOutcome;
      },
    } as unknown as BuildPipelineProvider;
  }
}

/** The pipeline's side of worker mail over `storage`, as the backend wires it. */
export function pipelineWorkerPort(
  storage: StorageService,
  provider: ScriptedSteerProvider,
): { ctx: BuildPipelineContext; workerMail: BuildPipelineWorkerMail } {
  const ctx = new BuildPipelineContext(
    storage,
    async () => {
      throw new Error("no backend commands in this test");
    },
    { keyedScheduling: false },
  );
  const agents = { provider: async () => provider.provider() } as unknown as BuildPipelineAgents;
  return { ctx, workerMail: new BuildPipelineWorkerMail(ctx, agents) };
}

/** A pipeline environment in `world`'s project, with only the pipeline's own tab. */
export async function addPipelineEnvironment(world: MailWorld): Promise<string> {
  const environment = createEnvironment(world.projectId, {
    name: "pipeline",
    environmentType: "local",
  });
  environment.status = "running";
  environment.setupPhase = "ready";
  environment.setupScriptsComplete = true;
  await world.storage.addEnvironment(environment);
  await world.storage.savePaneLayout(
    environment.id,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [{ id: "build", type: "claude-build" }],
        activeTabId: "build",
      },
    },
    0,
  );
  return environment.id;
}

/** Write the pipeline record and let the mailbox directory see it. */
export async function savePipeline(
  storage: StorageService,
  pipeline: BuildPipeline,
): Promise<void> {
  const current = await storage.getBuildPipeline(pipeline.id);
  await storage.saveBuildPipeline(
    pipeline.id,
    pipeline.projectId,
    pipeline.environmentId,
    BUILD_PIPELINE_VERSION,
    { ...pipeline, backendRevision: (current?.revision ?? 0) + 1 },
    current?.revision,
  );
  await storage.synchronizeAgentMailboxes();
}

export function workerAddress(session: PipelineSession): { tabId: string } {
  return { tabId: pipelineWorkerTabId(session.sessionKey) };
}

/**
 * The worker's turn ends: the supervisor's turn-end step, with the prompt
 * attempt it journals returned instead of sent.
 */
export async function endWorkerTurn(
  storage: StorageService,
  ctx: BuildPipelineContext,
  session: PipelineSession,
): Promise<{ started: boolean; pipeline: BuildPipeline; sent: string[] }> {
  const record = await storage.getBuildPipeline(PIPELINE_ID);
  const pipeline = record!.snapshot as BuildPipeline;
  pipeline.backendRevision = record!.revision;
  const current = pipeline.sessions.find((item) => item.sessionKey === session.sessionKey)!;
  current.status = "idle";
  const sent: string[] = [];
  const started = await dispatchWorkerMailTurn(ctx, pipeline, current, async () => {
    sent.push(pipeline.pendingPromptAttempt!.prompt);
  });
  return { started, pipeline, sent };
}

export type WorkerRow = Pick<PipelineWorker, "address" | "step" | "round" | "slot" | "status">;
