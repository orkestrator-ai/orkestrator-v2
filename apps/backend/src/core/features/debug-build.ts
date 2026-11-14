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
 *    details (`debugBuildTicket`), created once per `requestId`.
 * 2. Each agent tab's transcript is attached as a ticket comment (the tab in
 *    front first, bounded in total), and the screenshot as a ticket image.
 *    Every stage of the pipeline quotes the ticket's comments and receives its
 *    images, which is what "pre-loaded" means here.
 * 3. One build pipeline is launched on the saved Build defaults, which
 *    creates the pipeline environment. Nothing else is started.
 *
 * A retry with the same key and request finds the same ticket, skips the
 * attachments it already has, and gets the same pipeline back from the
 * supervisor's admission key. The same key with a different request is
 * refused.
 */
import { createHash } from "node:crypto";
import {
  DEBUG_BUILD_SCREENSHOT_FILENAME,
  DEBUG_BUILD_TAB_TRANSCRIPT_MAX_CHARS,
  DEBUG_BUILD_TRANSCRIPT_MAX_CHARS,
  debugBuildRequestIdentity,
  debugBuildTicket,
  debugTranscriptComment,
  isCreateDebugBuildInput,
  type CreateDebugBuildInput,
  type CreateDebugBuildResult,
  type DebugBuildSourceTab,
} from "@orkestrator/protocol/debug-build";
import { kanbanTaskBuildTicket } from "@orkestrator/protocol/build-pipeline-tickets";
import type { TaskSnapshotImage } from "@orkestrator/protocol/build-pipeline";
import { errorCode } from "@orkestrator/protocol/contract/ipc-error";
import { createLogger } from "@orkestrator/protocol/logger";
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
import { KeyedSingleFlight } from "../keyed-single-flight.js";

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

function isConflict(error: unknown): boolean {
  return errorCode(error) === "kanban-request-id-conflict";
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
 * Ticket resolution per `projectId:requestId`, so overlapping retries of one
 * request share one ticket and one transcript read. Process-local: a restart
 * ends any in flight, and the stored ticket's `requestId` is what a later
 * retry finds.
 */
const ticketResolutions = new KeyedSingleFlight<{
  task: KanbanTask;
  comments: TranscriptComment[];
}>();

/** Each tab's state for the ticket's Context, and the comments that carry its transcript. */
async function collectTranscripts(
  ports: DebugBuildPorts,
  environmentId: string,
): Promise<{ tabs: DebugBuildSourceTab[]; comments: TranscriptComment[] }> {
  const sourceTabs = await ports.sourceTabs(environmentId).catch(() => []);
  const tabs: DebugBuildSourceTab[] = [];
  const comments: TranscriptComment[] = [];
  let remaining = DEBUG_BUILD_TRANSCRIPT_MAX_CHARS;
  for (const tab of sourceTabs) {
    const budget = Math.min(remaining, DEBUG_BUILD_TAB_TRANSCRIPT_MAX_CHARS);
    if (budget < 2_000) {
      tabs.push({ ...tab, transcript: "omitted" });
      continue;
    }
    const read = await ports
      .readTranscript(environmentId, tab.tabId, budget * 2)
      .catch((): DebugTabTranscript => ({ status: "unavailable" }));
    if (read.status !== "read") {
      tabs.push({ ...tab, transcript: read.status === "empty" ? "empty" : "unavailable" });
      continue;
    }
    if (read.messages.length === 0) {
      tabs.push({ ...tab, transcript: "empty" });
      continue;
    }
    const text = debugTranscriptComment({
      tab,
      environmentId,
      messages: read.messages,
      complete: read.complete,
      maxChars: budget,
    });
    remaining -= text.length;
    tabs.push({ ...tab, transcript: "attached" });
    comments.push({ key: `debug-build:transcript:${tab.tabId}`, text });
  }
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
): Promise<{ task: KanbanTask; comments: TranscriptComment[] }> {
  const { storage } = context;
  const projectId = environment.projectId;
  const requestId = input.requestId.trim();
  const existing = await storage.kanban.findKanbanTaskByRequestId(projectId, requestId);
  if (existing) {
    if (existing.featureBuildRequestHash !== hash) {
      throw new Error("Debug build requestId was already used with different arguments");
    }
    // A retry. Once the first attempt got its transcripts onto the ticket the
    // ticket is left as it is, so a retry never adds what the conversation
    // said later; only a ticket that has none yet has them read again.
    if (existing.comments.length > 0) return { task: existing, comments: [] };
    const transcripts = await collectTranscripts(ports, environment.id);
    return { task: existing, comments: transcripts.comments };
  }

  const transcripts = await collectTranscripts(ports, environment.id);
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
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    // An overlapping attempt created it first (its capture time differs).
    const winner = await storage.kanban.findKanbanTaskByRequestId(projectId, requestId);
    if (!winner || winner.featureBuildRequestHash !== hash) throw error;
    return { task: winner, comments: transcripts.comments };
  }
  refineProvisionalTicketTitle(storage, task.id, input.problem, task.title, context);
  return { task, comments: transcripts.comments };
}

export async function createDebugBuild(
  args: unknown,
  context: DebugBuildContext,
  ports: DebugBuildPorts,
): Promise<CreateDebugBuildResult> {
  if (!isCreateDebugBuildInput(args)) throw new Error("Invalid debug build request");
  const { storage } = context;
  if (!context.buildPipelines) throw new Error("Build pipeline supervisor is unavailable");

  const environment = await storage.getEnvironment(args.environmentId.trim());
  if (!environment) throw new Error(`Environment not found: ${args.environmentId}`);
  const project = await storage.getProject(environment.projectId);
  if (!project) throw new Error(`Project not found: ${environment.projectId}`);

  // Checked and normalised before anything is written, so a bad image fails
  // the request instead of leaving a ticket behind.
  const screenshots = args.screenshot
    ? await normalizeFeatureImages(
        assertValidPromptImages([
          { filename: DEBUG_BUILD_SCREENSHOT_FILENAME, data: args.screenshot },
        ]),
      )
    : [];

  const hash = requestHash(args);
  const requestId = args.requestId.trim();
  const resolved = await ticketResolutions.run(`${environment.projectId}:${requestId}`, () =>
    resolveDebugTicket(context, ports, args, environment, project.name, hash),
  );
  let task: KanbanTask = resolved.task;
  const comments = resolved.comments;

  for (const comment of comments) {
    try {
      task = await storage.kanban.addKanbanComment(
        task.id,
        comment.text,
        environment.projectId,
        comment.key,
      );
    } catch (error) {
      // Already added by an earlier attempt, with the transcript as it was then.
      if (!isConflict(error)) throw error;
    }
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
    transcripts: comments.length,
    screenshot: snapshotImages.length > 0,
  });
  return {
    taskId: current.id,
    pipelineId: pipeline.id,
    projectId: environment.projectId,
    ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
  };
}
