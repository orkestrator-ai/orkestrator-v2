/**
 * The debug button's one-click pipeline environment: `create_debug_build`.
 *
 * The renderer sends what the user typed (Problem / objective, optional
 * Expected result), the environment they were looking at, an optional
 * screenshot of the window and an idempotency key. Everything else happens
 * here, where the state lives, so a window that closes mid-request cannot
 * leave a ticket without its build:
 *
 * 1. The ticket is written from the user's text and the source environment's
 *    details (`debugBuildTicket`), created once per `requestId`, together
 *    with each agent tab's transcript as ticket comments in the same commit
 *    (the tab in front first; tabs share one bound fairly). A ticket therefore
 *    never exists with only some of its transcripts.
 * 2. The screenshot is attached as a ticket image. Every stage of the
 *    pipeline quotes the ticket's comments and receives its images, which is
 *    what "pre-loaded" means here.
 * 3. One build pipeline is launched on the saved Build defaults, which
 *    creates the pipeline environment. Nothing else is started.
 *
 * A retry with the same key and request finds the same ticket, finishes the
 * screenshot if an earlier attempt stopped before it, and returns the
 * pipeline already linked to the ticket (whatever its phase) instead of
 * launching another. Overlapping attempts of one request share one run; the
 * same key with a different request is refused, overlapping or not.
 */
import { createHash } from "node:crypto";
import {
  DEBUG_BUILD_SCREENSHOT_FILENAME,
  DEBUG_BUILD_TRANSCRIPT_MAX_CHARS,
  allocateDebugTranscriptBudgets,
  debugBuildRequestIdentity,
  debugBuildTicket,
  debugTranscriptComments,
  debugTranscriptSize,
  isCreateDebugBuildInput,
  type CreateDebugBuildInput,
  type CreateDebugBuildResult,
  type DebugBuildSourceTab,
} from "@orkestrator/protocol/debug-build";
import { kanbanTaskBuildTicket } from "@orkestrator/protocol/build-pipeline-tickets";
import type { TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import { errorCode } from "@orkestrator/protocol/contract/ipc-error";
import { createLogger } from "@orkestrator/protocol/logger";
import { encodePublicSessionId } from "@orkestrator/protocol/public-api-resources";
import { launchBuildPipeline } from "../build-pipeline-launch.js";
import { assertValidPromptImages } from "../prompt-attachments.js";
import type { Environment } from "../models.js";
import type { KanbanTask } from "../storage-shared.js";
import {
  normalizeFeatureImages,
  refineProvisionalTicketTitle,
  type FeatureBuildContext,
} from "./build.js";
import type { DebugSourceTab, DebugTabTranscript } from "./debug-build-transcript.js";

const log = createLogger("feature");

/** What the handler needs besides storage and the supervisor. */
export interface DebugBuildPorts {
  /** The environment's agent tabs, the one in front first. */
  sourceTabs(environmentId: string): Promise<DebugSourceTab[]>;
  /** One tab's transcript, reading back until about `stopAfterChars` characters. */
  readTranscript(
    environmentId: string,
    tabId: string,
    stopAfterChars: number,
  ): Promise<DebugTabTranscript>;
  now?(): Date;
}

export type DebugBuildContext = FeatureBuildContext;

function requestHash(input: CreateDebugBuildInput): string {
  return createHash("sha256")
    .update(`debug-build:${debugBuildRequestIdentity(input)}`)
    .digest("hex");
}

const REUSED_KEY = "Debug build requestId was already used with different arguments";

function isConflict(error: unknown): boolean {
  return errorCode(error) === "kanban-request-id-conflict";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The type the pipeline environment is created as: the project's last choice, else the source's. */
async function pipelineEnvironmentType(
  context: DebugBuildContext,
  environment: Environment,
  projectLocalPath: string | null | undefined,
): Promise<"local" | "containerized"> {
  const config = await context.storage.loadConfig();
  const preferred =
    config.repositories[environment.projectId]?.lastEnvironmentType ??
    (environment.environmentType === "local" ? "local" : "containerized");
  if (preferred === "local" && !projectLocalPath) return "containerized";
  return preferred;
}

interface TranscriptComment {
  key: string;
  text: string;
}

/**
 * Attempts in flight per `projectId:requestId`, with the request hash each
 * stands for. An overlapping attempt of the same request joins the first; one
 * with a different request is refused before it writes anything. Process
 * local: a restart ends any in flight, and the stored ticket's `requestId`
 * (and the pipeline linked to it) is what a later retry finds.
 */
const inFlight = new Map<string, { hash: string; result: Promise<CreateDebugBuildResult> }>();

/** Below this a tab's share cannot hold a useful excerpt, so it is left out (and said so). */
const MIN_TAB_TRANSCRIPT_CHARS = 1_000;

function publicSessionId(environmentId: string, tabId: string): string | undefined {
  try {
    return encodePublicSessionId(environmentId, tabId);
  } catch {
    return undefined;
  }
}

/**
 * Each tab's state for the ticket's Context, and the comments that carry its
 * transcript. Every tab is read first, then the total bound is shared fairly
 * (`allocateDebugTranscriptBudgets`): a tab that fits its share is attached
 * whole, and only the longest are cut.
 */
export async function collectDebugTranscripts(
  ports: DebugBuildPorts,
  environmentId: string,
): Promise<{ tabs: DebugBuildSourceTab[]; comments: TranscriptComment[] }> {
  const sourceTabs = await ports.sourceTabs(environmentId).catch(() => []);
  const reads: DebugTabTranscript[] = [];
  for (const tab of sourceTabs) {
    reads.push(
      await ports
        .readTranscript(environmentId, tab.tabId, DEBUG_BUILD_TRANSCRIPT_MAX_CHARS)
        .catch((): DebugTabTranscript => ({ status: "unavailable" })),
    );
  }
  const sizes = reads.map((read) =>
    read.status === "read" && read.messages.length > 0 ? debugTranscriptSize(read.messages) : 0,
  );
  const budgets = allocateDebugTranscriptBudgets(sizes, DEBUG_BUILD_TRANSCRIPT_MAX_CHARS);
  const tabs: DebugBuildSourceTab[] = [];
  const comments: TranscriptComment[] = [];
  sourceTabs.forEach((tab, index) => {
    const read = reads[index]!;
    if (read.status !== "read") {
      tabs.push({ ...tab, transcript: read.status === "empty" ? "empty" : "unavailable" });
      return;
    }
    if (read.messages.length === 0) {
      tabs.push({ ...tab, transcript: "empty" });
      return;
    }
    const budget = budgets[index]!;
    if (budget < Math.min(MIN_TAB_TRANSCRIPT_CHARS, sizes[index]!)) {
      tabs.push({ ...tab, transcript: "omitted" });
      return;
    }
    const sessionId = publicSessionId(environmentId, tab.tabId);
    const texts = debugTranscriptComments({
      tab,
      environmentId,
      ...(sessionId ? { sessionId } : {}),
      messages: read.messages,
      complete: read.complete,
      maxChars: budget,
    });
    tabs.push({ ...tab, transcript: "attached" });
    texts.forEach((text, part) => {
      comments.push({ key: `debug-build:transcript:${tab.tabId}:${part + 1}`, text });
    });
  });
  return { tabs, comments };
}

/** The ticket for this request: the one an earlier attempt created, or a new one. */
async function resolveDebugTicket(
  context: DebugBuildContext,
  ports: DebugBuildPorts,
  input: CreateDebugBuildInput,
  environment: Environment,
  projectName: string | undefined,
  hash: string,
): Promise<{ task: KanbanTask; transcripts: number }> {
  const { storage } = context;
  const projectId = environment.projectId;
  const requestId = input.requestId.trim();
  const existing = await storage.kanban.findKanbanTaskByRequestId(projectId, requestId);
  if (existing) {
    if (existing.featureBuildRequestHash !== hash) throw new Error(REUSED_KEY);
    // Its transcripts were written with it, in one commit.
    return { task: existing, transcripts: 0 };
  }

  const transcripts = await collectDebugTranscripts(ports, environment.id);
  const capturedAt = (ports.now?.() ?? new Date()).toISOString();
  const ticket = debugBuildTicket({
    problem: input.problem,
    ...(input.expectedResult ? { expectedResult: input.expectedResult } : {}),
    screenshotAttached: Boolean(input.screenshot),
    source: {
      environmentId: environment.id,
      name: environment.name,
      projectId,
      ...(projectName ? { projectName } : {}),
      environmentType: environment.environmentType,
      status: environment.status,
      ...(environment.branch ? { branch: environment.branch } : {}),
      ...(environment.worktreePath ? { worktreePath: environment.worktreePath } : {}),
      prUrl: environment.prUrl,
      createdAt: environment.createdAt,
      capturedAt,
      tabs: transcripts.tabs,
    },
  });
  let task: KanbanTask;
  try {
    task = await storage.kanban.addKanbanTask(projectId, ticket.title, ticket.description, {
      acceptanceCriteria: ticket.acceptanceCriteria,
      // The build starts at once, so the column says what is happening.
      status: "in-progress",
      requestId,
      featureBuildRequestHash: hash,
      comments: transcripts.comments.map((comment) => ({
        requestId: comment.key,
        text: comment.text,
      })),
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    // Another process's attempt created it first (its capture time differs),
    // with its own transcripts in the same commit.
    const winner = await storage.kanban.findKanbanTaskByRequestId(projectId, requestId);
    if (!winner) throw error;
    if (winner.featureBuildRequestHash !== hash) throw new Error(REUSED_KEY);
    return { task: winner, transcripts: 0 };
  }
  refineProvisionalTicketTitle(storage, task.id, input.problem, task.title, context);
  return { task, transcripts: transcripts.comments.length };
}

/**
 * The pipeline an earlier attempt launched for this ticket, in any phase.
 * The ticket exists only for this request, so the oldest pipeline linked to
 * it is the one the request started; a later build the user started on the
 * ticket from the board is theirs and is not returned.
 */
async function launchedDebugPipeline(
  context: DebugBuildContext,
  projectId: string,
  taskId: string,
): Promise<{ id: string; environmentId: string } | null> {
  const linked = (await context.storage.listBuildPipelines(projectId))
    .map((record) => {
      const snapshot = isRecord(record.snapshot) ? record.snapshot : {};
      const source = isRecord(snapshot.source) ? snapshot.source : {};
      const createdAt = typeof snapshot.createdAt === "string" ? snapshot.createdAt : "";
      const environmentId =
        record.environmentId ||
        (typeof snapshot.environmentId === "string" ? snapshot.environmentId : "");
      const forTask =
        (source.type === "kanban" && source.taskId === taskId) ||
        (source.type === undefined && snapshot.taskId === taskId);
      return forTask ? { id: record.id, environmentId, createdAt } : null;
    })
    .filter((entry): entry is { id: string; environmentId: string; createdAt: string } =>
      Boolean(entry),
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const first = linked[0];
  return first ? { id: first.id, environmentId: first.environmentId } : null;
}

async function runDebugBuild(
  args: CreateDebugBuildInput,
  context: DebugBuildContext & { buildPipelines: NonNullable<DebugBuildContext["buildPipelines"]> },
  ports: DebugBuildPorts,
  environment: Environment,
  project: { name?: string; localPath?: string | null },
  hash: string,
): Promise<CreateDebugBuildResult> {
  const { storage } = context;
  // Checked and normalised before anything is written, so a bad image fails
  // the request instead of leaving a ticket behind.
  const screenshots = args.screenshot
    ? await normalizeFeatureImages(
        assertValidPromptImages([
          { filename: DEBUG_BUILD_SCREENSHOT_FILENAME, data: args.screenshot },
        ]),
      )
    : [];

  const resolved = await resolveDebugTicket(context, ports, args, environment, project.name, hash);
  let task: KanbanTask = resolved.task;

  const launched = await launchedDebugPipeline(context, environment.projectId, task.id);
  if (launched) {
    // A replay of a request whose pipeline already exists, running or not.
    return {
      taskId: task.id,
      pipelineId: launched.id,
      projectId: environment.projectId,
      ...(launched.environmentId ? { environmentId: launched.environmentId } : {}),
    };
  }

  const snapshotImages: TaskSnapshotImage[] = [];
  for (const image of screenshots) {
    const persisted = await storage.kanban.addNormalizedKanbanImageForRequest(
      task.id,
      image.filename,
      image.data,
      "debug-build:screenshot",
    );
    task = persisted.task;
    snapshotImages.push({
      filename: persisted.image.filename,
      data: await storage.kanban.getKanbanImageData(persisted.image.id),
    });
  }

  const current = (await storage.kanban.getKanbanTask(task.id)) ?? task;
  const ticket = kanbanTaskBuildTicket(current, snapshotImages);
  const pipeline = await launchBuildPipeline(
    {
      taskId: ticket.id,
      projectId: ticket.projectId,
      environmentType: await pipelineEnvironmentType(context, environment, project.localPath),
      taskTitle: ticket.title,
      taskSnapshot: ticket.taskSnapshot,
      source: ticket.source,
      namingPrompt: ticket.namingPrompt,
    },
    { storage, buildPipelines: context.buildPipelines },
  );
  log.info("debug-build.launched", {
    pipelineId: pipeline.id,
    transcripts: resolved.transcripts,
    screenshot: snapshotImages.length > 0,
  });
  return {
    taskId: current.id,
    pipelineId: pipeline.id,
    projectId: environment.projectId,
    ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
  };
}

export async function createDebugBuild(
  args: unknown,
  context: DebugBuildContext,
  ports: DebugBuildPorts,
): Promise<CreateDebugBuildResult> {
  if (!isCreateDebugBuildInput(args)) throw new Error("Invalid debug build request");
  const { storage, buildPipelines } = context;
  if (!buildPipelines) throw new Error("Build pipeline supervisor is unavailable");

  const environment = await storage.getEnvironment(args.environmentId.trim());
  if (!environment) throw new Error(`Environment not found: ${args.environmentId}`);
  const project = await storage.getProject(environment.projectId);
  if (!project) throw new Error(`Project not found: ${environment.projectId}`);

  const hash = requestHash(args);
  const key = `${environment.projectId}:${args.requestId.trim()}`;
  const running = inFlight.get(key);
  if (running) {
    // Joining is only for the same request; any other is refused before it writes.
    if (running.hash !== hash) throw new Error(REUSED_KEY);
    return running.result;
  }
  const result: Promise<CreateDebugBuildResult> = runDebugBuild(
    args,
    { ...context, buildPipelines },
    ports,
    environment,
    project,
    hash,
  ).finally(() => {
    if (inFlight.get(key)?.result === result) inFlight.delete(key);
  });
  inFlight.set(key, { hash, result });
  return result;
}
