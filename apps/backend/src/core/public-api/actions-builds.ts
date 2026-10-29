import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  isBuildPipeline,
  isStartBuildPipelineInput,
  MAX_BUILD_PIPELINE_ITERATIONS,
  type BuildPipeline,
  type BuildStepConfig,
  type BuildStepKey,
  type StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import {
  buildStepInstructionsBytes,
  isBuildStepInstructions,
  MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { PUBLIC_BUILD_STEPS } from "@orkestrator/protocol/public-api-inputs-build";
import type {
  PublicBuildPipelineActionResult,
  PublicBuildPipelineDetail,
  PublicBuildPipelineSummary,
  PublicBuildStepSummary,
} from "@orkestrator/protocol/public-api-resources";
import {
  reviewLensInstructionBytes,
  reviewLensInstructionError,
  reviewLensLabelError,
  type ReviewLens,
} from "@orkestrator/protocol/review-lens";
import { buildAdmissionKey } from "../build-pipeline-service-helpers.js";
import { conciseError } from "../commands-error-text.js";
import {
  buildPipelineInputWithDefaults,
  savedLaunchSettings,
} from "../coordinator-launch-defaults.js";
import { isProjectHomeEnvironment } from "../project-home-environment.js";
import type { PersistedBuildPipeline } from "../models.js";
import { paginate, requireEnvironment, requireProject } from "./actions-discovery.js";
import { validateCreateEnvironment } from "./actions-environments.js";
import { requireTicket } from "./actions-tickets.js";
import { runWithContinuation } from "./background.js";
import { BUILD_LAUNCH_SAVED_STAGE } from "./build-recovery.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyActionKeys,
  onlyKeys,
  optionalInteger,
  optionalString,
  requiredId,
} from "./input.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * The Build Pipeline as public actions (`build.*`), for the CLI and Control
 * MCP. `build.launch` is the Build button on a Kanban ticket, started through
 * the coordinator's path: the caller's choices layered over the saved Build
 * defaults (`buildPipelineInputWithDefaults`), the protocol's start guard, then
 * `BuildPipelineService.start`, whose own admission key returns the ticket's
 * active build instead of starting a second one.
 *
 * Instructions and reviewer focus are the caller's content. They reach the
 * pipeline record and its prompts, never a receipt, summary or log: those
 * report their UTF-8 sizes.
 */

const FULL_SHA = /^[0-9a-f]{40}$/i;
const MAX_REVIEWERS = 32;
const MAX_ERROR_CHARS = 500;

type StepInput = Partial<Omit<BuildStepConfig, "agent">> & { agent?: AgentPlatform };

export interface BuildLaunchInput {
  projectId: string;
  ticketId: string;
  type?: "local" | "container";
  environmentId?: string;
  baseBranch?: string;
  baseCommit?: string;
  agent?: AgentPlatform;
  steps?: Partial<Record<BuildStepKey, StepInput>>;
  reviewers?: StepInput[];
  reviewPreparation?: StepInput;
  maxIterations?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stepLens(value: unknown, path: string): ReviewLens {
  if (!isObject(value)) throw invalid(`${path} must be an object with label and instruction`);
  onlyKeys(value, ["label", "instruction"]);
  const { label, instruction } = value;
  if (typeof label !== "string" || reviewLensLabelError(label) !== null) {
    throw invalid(`${path}.label must be one non-blank line of at most 64 characters`);
  }
  if (typeof instruction !== "string" || reviewLensInstructionError(instruction) !== null) {
    throw invalid(`${path}.instruction must be non-blank and at most 4096 bytes of UTF-8`);
  }
  return { label, instruction };
}

/**
 * One step, reviewer row or preparation step. Strict: unknown keys are
 * refused, a model needs its agent and an effort its model, and the text
 * bounds are the protocol's (006's instructions guard, 005's lens guard).
 */
function parseStep(
  value: unknown,
  path: string,
  options: { lens: boolean; requireSelection: boolean },
): StepInput {
  if (!isObject(value)) throw invalid(`${path} must be an object`);
  try {
    onlyKeys(value, [
      "agent",
      "model",
      "reasoningEffort",
      "fastMode",
      "instructions",
      ...(options.lens ? ["lens"] : []),
    ]);
  } catch (error) {
    throw invalid(`${path}: ${(error as Error).message}`);
  }
  const step: StepInput = {};
  if (value.agent !== undefined) {
    if (!AGENT_PLATFORMS.includes(value.agent as AgentPlatform)) {
      throw invalid(`${path}.agent must be one of: ${AGENT_PLATFORMS.join(", ")}`);
    }
    step.agent = value.agent as AgentPlatform;
  }
  const model = optionalString(value, "model", 500)?.trim();
  const reasoningEffort = optionalString(value, "reasoningEffort", 100)?.trim();
  if (options.requireSelection && (!step.agent || !model)) {
    throw invalid(`${path} needs agent and model`);
  }
  if (model) {
    if (!step.agent) throw invalid(`${path}.model requires agent`);
    step.model = model;
  }
  if (reasoningEffort) {
    if (!model) throw invalid(`${path}.reasoningEffort requires model`);
    step.reasoningEffort = reasoningEffort;
  }
  if (value.fastMode !== undefined) {
    if (typeof value.fastMode !== "boolean") throw invalid(`${path}.fastMode must be a boolean`);
    step.fastMode = value.fastMode;
  }
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== "string") {
      throw invalid(`${path}.instructions must be a string`);
    }
    if (!isBuildStepInstructions(value.instructions)) {
      throw new PublicActionError(
        "input-too-large",
        `${path}.instructions must be at most ${MAX_BUILD_STEP_INSTRUCTIONS_BYTES} bytes of UTF-8 (16 KiB)`,
      );
    }
    step.instructions = value.instructions;
  }
  if (value.lens !== undefined) step.lens = stepLens(value.lens, `${path}.lens`);
  return step;
}

export function parseBuildLaunch(input: Record<string, unknown>): BuildLaunchInput {
  onlyActionKeys(input, "build.launch");
  const projectId = requiredId(input, "projectId");
  const ticketId = requiredId(input, "ticketId");
  const type = oneOf(input, "type", ["local", "container"] as const);
  const environmentId =
    input.environmentId === undefined ? undefined : requiredId(input, "environmentId");
  if ((type ? 1 : 0) + (environmentId ? 1 : 0) !== 1) {
    throw invalid("Give exactly one of type (a new environment) and environmentId");
  }
  const baseBranch = optionalString(input, "baseBranch", 500)?.trim();
  const baseCommit = optionalString(input, "baseCommit", 40)?.toLowerCase();
  if ((baseBranch ? 1 : 0) + (baseCommit ? 1 : 0) === 1) {
    throw invalid("baseBranch and baseCommit must be given together");
  }
  if (baseCommit && !FULL_SHA.test(baseCommit)) {
    throw invalid("baseCommit must be a full 40-character SHA");
  }
  if (baseBranch && environmentId) {
    throw invalid(
      "baseBranch and baseCommit choose a new environment's base; omit them with environmentId",
    );
  }
  const agent = oneOf(input, "agent", AGENT_PLATFORMS);
  let steps: BuildLaunchInput["steps"];
  if (input.steps !== undefined) {
    if (!isObject(input.steps)) throw invalid("steps must be an object");
    try {
      onlyKeys(input.steps, PUBLIC_BUILD_STEPS);
    } catch (error) {
      throw invalid(`steps: ${(error as Error).message}`);
    }
    steps = {};
    for (const key of PUBLIC_BUILD_STEPS) {
      if (input.steps[key] === undefined) continue;
      steps[key] = parseStep(input.steps[key], `steps.${key}`, {
        lens: key === "review",
        requireSelection: false,
      });
    }
  }
  let reviewers: StepInput[] | undefined;
  if (input.reviewers !== undefined) {
    if (
      !Array.isArray(input.reviewers) ||
      input.reviewers.length < 1 ||
      input.reviewers.length > MAX_REVIEWERS
    ) {
      throw invalid(`reviewers must be a list of 1 to ${MAX_REVIEWERS} rows`);
    }
    reviewers = input.reviewers.map((row, index) =>
      parseStep(row, `reviewers[${index}]`, { lens: true, requireSelection: true }),
    );
  }
  if (reviewers && steps?.review) {
    // Reviewer 1 is the review step: a separate review step would be dropped.
    throw invalid(
      "Give steps.review or reviewers, not both: with reviewers, reviewer 1 is the review step",
    );
  }
  const reviewPreparation =
    input.reviewPreparation === undefined
      ? undefined
      : parseStep(input.reviewPreparation, "reviewPreparation", {
          lens: false,
          requireSelection: false,
        });
  let maxIterations: number | undefined;
  try {
    maxIterations = optionalInteger(input, "maxIterations", 1, MAX_BUILD_PIPELINE_ITERATIONS);
  } catch {
    throw invalid(
      `maxIterations must be an integer from 1 to ${MAX_BUILD_PIPELINE_ITERATIONS}, the Build Pipeline's iteration limit`,
    );
  }
  return {
    projectId,
    ticketId,
    ...(type ? { type } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(baseBranch ? { baseBranch, baseCommit } : {}),
    ...(agent ? { agent } : {}),
    ...(steps ? { steps } : {}),
    ...(reviewers ? { reviewers } : {}),
    ...(reviewPreparation ? { reviewPreparation } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  };
}

function requireBuilds(context: PublicActionContext) {
  if (!context.command.buildPipelines) {
    throw new PublicActionError("capability-unavailable", "Build Pipelines are not available here");
  }
  return context.command.buildPipelines;
}

/** The start request the Build button sends for this ticket, before defaults. */
async function requestedStart(
  input: BuildLaunchInput,
  context: PublicActionContext,
): Promise<Record<string, unknown>> {
  const ticket = await requireTicket(context, input.projectId, input.ticketId);
  let environmentType: StartBuildPipelineInput["environmentType"] =
    input.type === "container" ? "containerized" : "local";
  if (input.environmentId) {
    const environment = await requireEnvironment(context, input.environmentId);
    if (environment.projectId !== input.projectId) {
      throw new PublicActionError("conflict", "The environment belongs to another project");
    }
    if (isProjectHomeEnvironment(environment)) {
      throw new PublicActionError(
        "unsupported",
        "The project checkout is not a worker environment; build in a new or worker environment",
      );
    }
    if (environment.deletionRequestedAt || environment.lifecycleOperation === "deleting") {
      throw new PublicActionError("conflict", "The environment is being deleted");
    }
    environmentType = environment.environmentType === "containerized" ? "containerized" : "local";
  } else {
    await validateCreateEnvironment(
      {
        projectId: input.projectId,
        type: input.type!,
        ...(input.baseBranch ? { baseBranch: input.baseBranch, baseCommit: input.baseCommit } : {}),
      },
      context,
    );
  }
  const images = await Promise.all(
    ticket.images.map(async (image) => {
      try {
        return {
          filename: image.filename,
          data: await context.command.storage.kanban.getKanbanImageData(image.id),
        };
      } catch {
        // As in the launcher: an unreadable image is left out of the snapshot.
        return null;
      }
    }),
  );
  return {
    taskId: ticket.id,
    projectId: input.projectId,
    environmentType,
    ...(input.agent ? { agentType: input.agent } : {}),
    ...(input.steps ? { steps: input.steps } : {}),
    ...(input.reviewers ? { reviewers: input.reviewers } : {}),
    ...(input.reviewPreparation ? { reviewPreparation: input.reviewPreparation } : {}),
    taskTitle: ticket.title,
    // The snapshot every stage prompt quotes, taken as the Build button takes it.
    taskSnapshot: {
      title: ticket.title,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptanceCriteria,
      comments: ticket.comments.map((comment) => ({ text: comment.text })),
      images: images.filter((image) => image !== null),
    },
    // Linking the source moves the ticket through its lifecycle and attaches
    // the environment to it.
    source: { type: "kanban", taskId: ticket.id },
    namingPrompt: [ticket.title, ticket.description, ticket.acceptanceCriteria]
      .filter(Boolean)
      .join("\n\n"),
    ...(input.environmentId ? { existingEnvironmentId: input.environmentId } : {}),
    ...(input.baseBranch
      ? { delegationBaseBranch: input.baseBranch, delegationBaseCommit: input.baseCommit }
      : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
  };
}

/** A launch or cancel result: IDs and states only. */
export function buildActionResult(
  pipeline: Pick<BuildPipeline, "id" | "projectId" | "environmentId" | "taskId" | "phase">,
  reused?: boolean,
): PublicBuildPipelineActionResult & Record<string, unknown> {
  return {
    pipelineId: pipeline.id,
    projectId: pipeline.projectId,
    environmentId: pipeline.environmentId || null,
    taskId: pipeline.taskId,
    phase: pipeline.phase,
    ...(reused !== undefined ? { reused } : {}),
  };
}

const buildLaunch: MutationActionHandler<BuildLaunchInput> = {
  kind: "mutation",
  action: "build.launch",
  parse(input) {
    const value = parseBuildLaunch(input);
    return { value, scope: `project:${value.projectId}`, intent: value };
  },
  async prepare(input, context) {
    const service = requireBuilds(context);
    await requireProject(context, input.projectId);
    const requested = await requestedStart(input, context);
    // The coordinator's layering: choices left out run the Build button's
    // saved defaults; a step naming only instructions keeps its saved model.
    const start = buildPipelineInputWithDefaults(
      requested,
      savedLaunchSettings(await context.command.storage.loadConfig(), input.projectId),
    );
    if (!isStartBuildPipelineInput(start)) {
      throw invalid(
        "Build Pipeline input is invalid: every step needs an agent (named, or from the saved Build defaults), and reviewers need agent and model",
      );
    }
    const admissionKey = buildAdmissionKey(start);
    return {
      resolved: { admissionKey, taskId: start.taskId },
      resources: {
        projectId: input.projectId,
        ...(input.environmentId ? { environmentId: input.environmentId } : {}),
      },
      async execute(operation) {
        // The ticket's active build, which start() returns instead of a new one.
        const active = (await context.command.storage.listBuildPipelines(input.projectId)).find(
          (record) => activeWithKey(record, admissionKey),
        );
        return runWithContinuation(operation, service.start(start), {
          runningStage: "launching",
          runningResult: { projectId: input.projectId, taskId: start.taskId },
          onSuccess: (pipeline): ExecuteOutcome => ({
            state: "succeeded",
            stage: BUILD_LAUNCH_SAVED_STAGE,
            result: buildActionResult(pipeline, pipeline.id === active?.id),
            resources: {
              projectId: pipeline.projectId,
              ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
            },
          }),
        });
      },
    };
  },
};

function activeWithKey(record: PersistedBuildPipeline, admissionKey: string): boolean {
  const snapshot = record.snapshot as Partial<BuildPipeline>;
  return (
    snapshot.admissionKey === admissionKey &&
    snapshot.phase !== "complete" &&
    snapshot.phase !== "failed"
  );
}

/*
 * Summaries: selections and sizes, never the text of instructions or focus.
 */

function stepSummary(step: unknown): PublicBuildStepSummary | null {
  if (!isObject(step) || typeof step.agent !== "string") return null;
  const lens = isObject(step.lens) ? step.lens : undefined;
  return {
    agent: step.agent,
    model: typeof step.model === "string" ? step.model : null,
    reasoningEffort: typeof step.reasoningEffort === "string" ? step.reasoningEffort : null,
    fastMode: typeof step.fastMode === "boolean" ? step.fastMode : null,
    instructionsBytes:
      typeof step.instructions === "string" ? buildStepInstructionsBytes(step.instructions) : 0,
    lens:
      lens && typeof lens.label === "string" && typeof lens.instruction === "string"
        ? {
            labelBytes: Buffer.byteLength(lens.label),
            instructionBytes: reviewLensInstructionBytes(lens.instruction),
          }
        : null,
  };
}

export function publicBuildPipelineSummary(
  record: PersistedBuildPipeline,
): PublicBuildPipelineSummary {
  const pipeline = record.snapshot as BuildPipeline;
  return {
    id: pipeline.id,
    projectId: pipeline.projectId,
    environmentId: pipeline.environmentId || null,
    taskId: pipeline.taskId,
    source: pipeline.source?.type ?? null,
    phase: pipeline.phase,
    iteration: pipeline.iteration,
    maxIterations: pipeline.maxIterations,
    agent: pipeline.agentType,
    error: pipeline.error ? pipeline.error.slice(0, MAX_ERROR_CHARS) : null,
    createdAt: pipeline.createdAt,
    updatedAt: record.updatedAt ?? null,
    revision: record.revision,
  };
}

export function publicBuildPipelineDetail(
  record: PersistedBuildPipeline,
): PublicBuildPipelineDetail {
  const pipeline = record.snapshot as BuildPipeline;
  const steps: PublicBuildPipelineDetail["steps"] = {};
  for (const key of PUBLIC_BUILD_STEPS) {
    const summary = stepSummary(pipeline.steps?.[key]);
    if (summary) steps[key] = summary;
  }
  return {
    ...publicBuildPipelineSummary(record),
    steps,
    reviewers: (pipeline.reviewers ?? [])
      .map(stepSummary)
      .filter((summary): summary is PublicBuildStepSummary => summary !== null),
    reviewPreparation: stepSummary(pipeline.reviewPreparation),
  };
}

async function requirePipeline(
  context: PublicActionContext,
  pipelineId: string,
): Promise<PersistedBuildPipeline> {
  const record = await context.command.storage.getBuildPipeline(pipelineId);
  if (!record || !isBuildPipeline(record.snapshot)) {
    throw new PublicActionError("not-found", `Build pipeline not found: ${pipelineId}`);
  }
  return record;
}

const buildList: ReadActionHandler<{ projectId: string; limit?: number; cursor?: string }> = {
  kind: "read",
  action: "build.list",
  parse(input) {
    onlyActionKeys(input, "build.list");
    return {
      projectId: requiredId(input, "projectId"),
      limit: optionalInteger(input, "limit", 1, PUBLIC_API_LIMITS.pageMaxItems),
      cursor: optionalString(input, "cursor", 512),
    };
  },
  async run(input, context) {
    await requireProject(context, input.projectId);
    const items = (await context.command.storage.listBuildPipelines(input.projectId))
      .filter((record) => isBuildPipeline(record.snapshot))
      .map(publicBuildPipelineSummary)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    return { result: paginate(items, input) };
  },
};

const buildGet: ReadActionHandler<{ pipelineId: string }> = {
  kind: "read",
  action: "build.get",
  parse(input) {
    onlyActionKeys(input, "build.get");
    return { pipelineId: requiredId(input, "pipelineId") };
  },
  async run(input, context) {
    return { result: publicBuildPipelineDetail(await requirePipeline(context, input.pipelineId)) };
  },
};

const buildCancel: MutationActionHandler<{ pipelineId: string }> = {
  kind: "mutation",
  action: "build.cancel",
  parse(input) {
    onlyActionKeys(input, "build.cancel");
    const pipelineId = requiredId(input, "pipelineId");
    return { value: { pipelineId }, scope: `build:${pipelineId}`, intent: { pipelineId } };
  },
  async prepare(input, context) {
    const service = requireBuilds(context);
    const record = await requirePipeline(context, input.pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    if (pipeline.phase === "complete" || pipeline.phase === "failed") {
      throw new PublicActionError(
        "conflict",
        `The build pipeline already ended (${pipeline.phase}); nothing was cancelled`,
        { details: { phase: pipeline.phase } },
      );
    }
    return {
      resources: {
        projectId: pipeline.projectId,
        ...(pipeline.environmentId ? { environmentId: pipeline.environmentId } : {}),
      },
      async execute() {
        try {
          return {
            state: "succeeded",
            result: buildActionResult(await service.cancel(input.pipelineId)),
          };
        } catch (error) {
          const message = conciseError(error).slice(0, MAX_ERROR_CHARS);
          // Cancel ends the pipeline before it stops the agents, so a failed
          // stop still leaves it cancelled: say so instead of a plain failure.
          const after = await context.command.storage.getBuildPipeline(input.pipelineId);
          const ended = after && isBuildPipeline(after.snapshot) ? after.snapshot : null;
          if (ended?.phase === "failed") {
            return {
              state: "partial",
              result: buildActionResult(ended),
              error: {
                code: "partial-failure",
                message:
                  `The build was cancelled, but stopping its agents could not be confirmed: ${message}`.slice(
                    0,
                    MAX_ERROR_CHARS,
                  ),
              },
            };
          }
          return { state: "failed", error: { code: "operation-failed", message } };
        }
      },
    };
  },
};

export const BUILD_HANDLERS: PublicActionHandler[] = [
  buildLaunch,
  buildList,
  buildGet,
  buildCancel,
];
