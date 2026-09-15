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
 *
 * A blank title is filled immediately with a local fallback so creation is not
 * blocked on Codex. Model naming, when available, refines that ticket later.
 */
import {
  isCreateFeatureBuildInput,
  type CreateFeatureBuildInput,
  type CreateFeatureBuildResult,
} from "@orkestrator/protocol/feature-build";
import type { BuildStepConfigs } from "@orkestrator/protocol/build-pipeline";
import { createHash } from "node:crypto";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import type { StorageService } from "./storage.js";
import { resizeKanbanImage, type KanbanTask } from "./storage-shared.js";
import { assertValidPromptImages } from "./prompt-attachments.js";
import { generateEnvironmentNameWithCodexExec } from "./commands-agent-support.js";

export interface FeatureBuildContext {
  storage: StorageService;
  buildPipelines?: BuildPipelineService;
  appRoot?: string;
  resourceRoot?: string;
  toolchainBinDir?: string;
  /** Test seam for the same background naming task used by environments. */
  generateEnvironmentName?: (description: string) => Promise<string>;
}

const FALLBACK_FEATURE_TITLE = "New Feature";
const FALLBACK_TITLE_MAX_CHARS = 64;
const LEADING_STORY_PREFIX =
  /^(when i|whenever i|i would like to|i would like|i want to|i want|i need to|i need|as an|as a|the|an|a)\b[\s:,-]*/i;

const pendingTaskResolutions = new Map<string, Promise<KanbanTask>>();
const pendingFeatureTitleRefinements = new Map<string, Promise<void>>();

/** Wait for background title refinements scheduled by this process. */
export async function waitForPendingFeatureTitleRefinements(): Promise<void> {
  while (pendingFeatureTitleRefinements.size > 0) {
    await Promise.allSettled(pendingFeatureTitleRefinements.values());
  }
}

/** Turn a generated branch-style slug into the requested feature-title style. */
export function featureTitleFromGeneratedName(name: string): string {
  const words = name.split(/[-_\s]+/).filter(Boolean);
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

/**
 * Cheap, deterministic title used so a blank name never blocks creation.
 *
 * Story prefixes and leading articles are dropped so the fragment is about the
 * feature rather than the sentence that introduced it. Non-Latin descriptions
 * keep a readable prefix instead of collapsing to the constant floor.
 */
export function fallbackFeatureTitle(description: string): string {
  const trimmed = description.trim();
  if (!trimmed) return FALLBACK_FEATURE_TITLE;

  let remainder = trimmed;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = remainder.replace(LEADING_STORY_PREFIX, "").trim();
    if (next === remainder) break;
    remainder = next;
  }
  if (!remainder) remainder = trimmed;

  const fragment = capitalizeFirst(truncateOnWordBoundary(remainder, FALLBACK_TITLE_MAX_CHARS));
  return isMeaningfulTitle(fragment) ? fragment : FALLBACK_FEATURE_TITLE;
}

function capitalizeFirst(text: string): string {
  const match = text.match(/^(\s*)(\S)(.*)$/u);
  if (!match) return text;
  return `${match[1]}${match[2]!.toUpperCase()}${match[3]}`;
}

function truncateOnWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = slice.search(/\s+\S*$/u);
  const cut = boundary > maxChars / 2 ? slice.slice(0, boundary) : slice;
  return cut.trim();
}

function isMeaningfulTitle(title: string): boolean {
  return /\p{L}|\p{N}/u.test(title);
}

function canRefineFeatureTitle(context: FeatureBuildContext): boolean {
  return Boolean(context.generateEnvironmentName || (context.appRoot && context.resourceRoot));
}

function namingErrorDiscriminator(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function generateRefinedFeatureTitle(
  description: string,
  context: FeatureBuildContext,
): Promise<string> {
  const generatedName = context.generateEnvironmentName
    ? await context.generateEnvironmentName(description)
    : context.appRoot && context.resourceRoot
      ? await generateEnvironmentNameWithCodexExec(description, {
          appRoot: context.appRoot,
          resourceRoot: context.resourceRoot,
          ...(context.toolchainBinDir ? { toolchainBinDir: context.toolchainBinDir } : {}),
        })
      : "";
  return featureTitleFromGeneratedName(generatedName);
}

async function refineFeatureTitle(
  storage: StorageService,
  taskId: string,
  description: string,
  provisionalTitle: string,
  context: FeatureBuildContext,
): Promise<void> {
  try {
    const title = await generateRefinedFeatureTitle(description, context);
    if (!title || title === provisionalTitle) return;
    const current = await storage.getKanbanTask(taskId);
    if (!current || current.title !== provisionalTitle) return;
    await storage.updateKanbanTask(taskId, { title });
  } catch (error) {
    // Naming is an enhancement, not a reason to reject an otherwise valid
    // feature. Log only a discriminator: the model body may echo the
    // user-supplied description, but the error class still tells spawn /
    // timeout / parse failures apart.
    console.warn(
      "[FeatureBuild] Automatic naming failed; using a local fallback",
      namingErrorDiscriminator(error),
    );
  }
}

function scheduleFeatureTitleRefinement(
  storage: StorageService,
  taskId: string,
  description: string,
  provisionalTitle: string,
  context: FeatureBuildContext,
): void {
  if (pendingFeatureTitleRefinements.has(taskId)) return;
  const work = refineFeatureTitle(storage, taskId, description, provisionalTitle, context).finally(
    () => {
      if (pendingFeatureTitleRefinements.get(taskId) === work) {
        pendingFeatureTitleRefinements.delete(taskId);
      }
    },
  );
  pendingFeatureTitleRefinements.set(taskId, work);
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

  const requestedTitle = input.title.trim();
  const description = input.description?.trim() ?? "";
  const acceptanceCriteria = input.acceptanceCriteria?.trim() ?? "";
  const images = await normalizeFeatureImages(assertValidPromptImages(input.images ?? []));
  const requestId = input.requestId?.trim();
  const requestHash = requestId
    ? featureBuildRequestHash({
        ...input,
        projectId,
        title: requestedTitle,
        description,
        acceptanceCriteria,
        requestId: undefined,
      })
    : undefined;

  const task = await resolveTask(storage, context, {
    projectId,
    title: requestedTitle,
    description,
    acceptanceCriteria,
    requestId,
    requestHash,
  });

  let resolvedTask = task;
  const snapshotImages = [];
  for (const [index, image] of images.entries()) {
    const persisted = await storage.addNormalizedKanbanImageForRequest(
      resolvedTask.id,
      image.filename,
      image.data,
      `feature-build:${index}`,
    );
    resolvedTask = persisted.task;
    snapshotImages.push({
      filename: persisted.image.filename,
      data: await storage.getKanbanImageData(persisted.image.id),
    });
  }

  const pipeline = await buildPipelines.start({
    taskId: resolvedTask.id,
    projectId,
    environmentType: input.environmentType,
    ...(input.environmentOptions ? { environmentOptions: input.environmentOptions } : {}),
    agentType: input.agentType,
    ...(input.steps ? { steps: withVerifyFromAddress(input.steps) } : {}),
    ...(input.reviewers ? { reviewers: input.reviewers } : {}),
    ...(input.reviewPreparation ? { reviewPreparation: input.reviewPreparation } : {}),
    taskTitle: resolvedTask.title,
    // The snapshot is what every stage prompt quotes. It is taken here rather
    // than read back later so the build works from the ticket as submitted,
    // even if someone edits the ticket while the environment is provisioning.
    taskSnapshot: {
      title: resolvedTask.title,
      description: resolvedTask.description,
      acceptanceCriteria: resolvedTask.acceptanceCriteria,
      comments: resolvedTask.comments.map((comment) => ({ text: comment.text })),
      images: snapshotImages,
    },
    // Linking the source is what makes the pipeline move this ticket through
    // its lifecycle and attach the environment to it.
    source: { type: "kanban", taskId: resolvedTask.id },
    namingPrompt: [resolvedTask.title, description].filter(Boolean).join("\n\n"),
  });

  return {
    taskId: resolvedTask.id,
    pipelineId: pipeline.id,
    ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
  };
}

/**
 * Callers that pin address but omit verify used to inherit the address model
 * for the verification stage. Keep that inference so older or external clients
 * do not silently move verify onto the pipeline agent after the dedicated
 * verify action was introduced.
 */
function withVerifyFromAddress(steps: BuildStepConfigs): BuildStepConfigs {
  if (steps.verify || !steps.address) return steps;
  return { ...steps, verify: { ...steps.address } };
}

async function normalizeFeatureImages(
  images: Array<{ filename: string; data: string }>,
): Promise<Array<{ filename: string; data: string }>> {
  const normalized = [];
  for (const image of images) {
    try {
      const webp = await resizeKanbanImage(Buffer.from(image.data, "base64"));
      normalized.push({
        filename: image.filename,
        data: webp.toString("base64"),
      });
    } catch (error) {
      throw new Error(`Feature image is not a supported image: ${image.filename}`, {
        cause: error,
      });
    }
  }
  return normalized;
}

/**
 * The ticket this request owns, creating it only on the first attempt.
 *
 * `addKanbanTask` is itself idempotent under a `requestId`, but only while the
 * stored row still matches what it was created with — and a ticket that started
 * a build has usually moved status and gained an environment by the time a
 * caller retries. Looking first is what makes the retry return the same ticket
 * instead of failing on that comparison.
 *
 * Blank titles use the local fallback before insert so overlapping retries
 * submit the same derived title. Codex refinement happens after the row exists.
 */
async function resolveTask(
  storage: StorageService,
  context: FeatureBuildContext,
  fields: {
    projectId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    requestId?: string;
    requestHash?: string;
  },
): Promise<KanbanTask> {
  const key = fields.requestId ? `${fields.projectId}:${fields.requestId}` : undefined;
  if (key) {
    const inflight = pendingTaskResolutions.get(key);
    if (inflight) return inflight;
  }

  const work = resolveTaskOnce(storage, context, fields);
  if (key) {
    pendingTaskResolutions.set(key, work);
    work
      .finally(() => {
        if (pendingTaskResolutions.get(key) === work) {
          pendingTaskResolutions.delete(key);
        }
      })
      .catch(() => undefined);
  }
  return work;
}

async function resolveTaskOnce(
  storage: StorageService,
  context: FeatureBuildContext,
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

  const title = fields.title || fallbackFeatureTitle(fields.description);
  const task = await addKanbanTaskForRequest(storage, title, fields);
  if (!fields.title && canRefineFeatureTitle(context)) {
    scheduleFeatureTitleRefinement(storage, task.id, fields.description, task.title, context);
  }
  return task;
}

async function addKanbanTaskForRequest(
  storage: StorageService,
  title: string,
  fields: {
    projectId: string;
    description: string;
    acceptanceCriteria: string;
    requestId?: string;
    requestHash?: string;
  },
): Promise<KanbanTask> {
  try {
    return await storage.addKanbanTask(fields.projectId, title, fields.description, {
      ...(fields.acceptanceCriteria ? { acceptanceCriteria: fields.acceptanceCriteria } : {}),
      // The build starts immediately, so the column reflects what is happening.
      // The pipeline's own lifecycle updates then move it on from here.
      status: "in-progress",
      ...(fields.requestId ? { requestId: fields.requestId } : {}),
      ...(fields.requestHash ? { featureBuildRequestHash: fields.requestHash } : {}),
    });
  } catch (error) {
    if (
      fields.requestId &&
      error instanceof Error &&
      error.message.includes("requestId was already used")
    ) {
      const existing = await storage.findKanbanTaskByRequestId(fields.projectId, fields.requestId);
      if (existing && existing.featureBuildRequestHash === fields.requestHash) {
        return existing;
      }
    }
    throw error;
  }
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
