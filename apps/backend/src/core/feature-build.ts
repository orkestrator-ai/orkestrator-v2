/**
 * "Create a feature" — one ticket and the build that implements it.
 *
 * The create-environment dialog's feature option collects a title, description
 * and acceptance criteria alongside the models each stage should run on, and
 * then wants a Kanban ticket, an environment and a running pipeline. Doing that
 * from the renderer would make the browser tab the thing that has to survive
 * between the three calls; a reload half-way through would leave an orphan
 * ticket and no build. So the renderer sends one request and the backend owns
 * every step after it.
 *
 * The whole command is idempotent under `requestId`. A create whose response
 * was lost is indistinguishable from one that never arrived, and the natural
 * user response — click again — must not produce a second ticket and a second
 * environment.
 */
import {
  isCreateFeatureBuildInput,
  type CreateFeatureBuildInput,
  type CreateFeatureBuildResult,
} from "@orkestrator/protocol/feature-build";
import { createHash } from "node:crypto";
import type { BuildStepConfigs } from "@orkestrator/protocol/build-pipeline";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import type { StorageService } from "./storage.js";
import type { KanbanTask } from "./storage-shared.js";
import { assertValidPromptImages } from "./prompt-attachments.js";

export interface FeatureBuildContext {
  storage: StorageService;
  buildPipelines?: BuildPipelineService;
}

export async function createFeatureBuild(
  input: unknown,
  context: FeatureBuildContext,
): Promise<CreateFeatureBuildResult> {
  if (!isCreateFeatureBuildInput(input)) {
    throw new Error("Invalid feature build request");
  }
  const { buildPipelines, storage } = context;
  if (!buildPipelines) throw new Error("Build pipeline supervisor is unavailable");

  const projectId = input.projectId.trim();
  const project = await storage.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (input.environmentType === "local" && !project.localPath) {
    throw new Error("Project has no local path - cannot create a local worktree");
  }

  const title = input.title.trim();
  const description = input.description?.trim() ?? "";
  const acceptanceCriteria = input.acceptanceCriteria?.trim() ?? "";
  const images = assertValidPromptImages(input.images ?? []);
  const requestId = input.requestId?.trim();
  const requestHash = requestId
    ? featureBuildRequestHash({
        ...input,
        projectId,
        title,
        description,
        acceptanceCriteria,
        requestId: undefined,
      })
    : undefined;

  const task = await resolveTask(storage, {
    projectId,
    title,
    description,
    acceptanceCriteria,
    requestId,
    requestHash,
  });

  const pipeline = await buildPipelines.start({
    taskId: task.id,
    projectId,
    environmentType: input.environmentType,
    ...(input.environmentOptions ? { environmentOptions: input.environmentOptions } : {}),
    agentType: input.agentType,
    ...(input.steps ? { steps: withVerifyFromAddress(input.steps) } : {}),
    ...(input.reviewers ? { reviewers: input.reviewers } : {}),
    taskTitle: task.title,
    // The snapshot is what every stage prompt quotes. It is taken here rather
    // than read back later so the build works from the ticket as submitted,
    // even if someone edits the ticket while the environment is provisioning.
    taskSnapshot: {
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      comments: [],
      images,
    },
    // Linking the source is what makes the pipeline move this ticket through
    // its lifecycle and attach the environment to it.
    source: { type: "kanban", taskId: task.id },
    namingPrompt: [title, description].filter(Boolean).join("\n\n"),
  });

  return {
    taskId: task.id,
    pipelineId: pipeline.id,
    ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
  };
}

/**
 * Verification runs on whichever model addressed the review.
 *
 * The verify stage re-checks the committed branch against the ticket directly
 * after the address stage changed it. Splitting those across two models adds a
 * decision without adding a choice worth making, so the feature launcher does
 * not offer a verify picker and this fills it in. An explicit `verify` still
 * wins: this only supplies what the caller left unset.
 */
function withVerifyFromAddress(steps: BuildStepConfigs): BuildStepConfigs {
  if (steps.verify || !steps.address) return steps;
  return { ...steps, verify: steps.address };
}

/**
 * The ticket this request owns, creating it only on the first attempt.
 *
 * `addKanbanTask` is itself idempotent under a `requestId`, but only while the
 * stored row still matches what it was created with — and a ticket that started
 * a build has usually moved status and gained an environment by the time a
 * caller retries. Looking first is what makes the retry return the same ticket
 * instead of failing on that comparison.
 */
async function resolveTask(
  storage: StorageService,
  fields: {
    projectId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    requestId?: string;
    requestHash?: string;
  },
): Promise<KanbanTask> {
  if (fields.requestId) {
    const existing = await storage.findKanbanTaskByRequestId(fields.projectId, fields.requestId);
    if (existing) {
      if (existing.featureBuildRequestHash !== fields.requestHash) {
        throw new Error("Feature build requestId was already used with different arguments");
      }
      return existing;
    }
  }
  return storage.addKanbanTask(fields.projectId, fields.title, fields.description, {
    ...(fields.acceptanceCriteria ? { acceptanceCriteria: fields.acceptanceCriteria } : {}),
    // The build starts immediately, so the column reflects what is happening.
    // The pipeline's own lifecycle updates then move it on from here.
    status: "in-progress",
    ...(fields.requestId ? { requestId: fields.requestId } : {}),
    ...(fields.requestHash ? { featureBuildRequestHash: fields.requestHash } : {}),
  });
}

/** Stable JSON used to bind an idempotency key to the request it first owned. */
function featureBuildRequestHash(input: CreateFeatureBuildInput): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
}
