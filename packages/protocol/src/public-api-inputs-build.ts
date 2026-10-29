/**
 * Input contracts of the Build Pipeline's public actions (`build.*`), and the
 * reviewer-focus schema they share with `review.launch`. Split from
 * `public-api-inputs.ts`, which composes them into `PUBLIC_ACTION_INPUTS`;
 * the same portable JSON Schema subset applies.
 */

import { AGENT_PLATFORMS } from "./agent-platforms.js";
import { BUILD_STEP_KEYS, MAX_BUILD_PIPELINE_ITERATIONS } from "./build-pipeline.js";
import { MAX_BUILD_STEP_INSTRUCTIONS_BYTES } from "./build-pipeline-stage-instructions.js";
import { PUBLIC_API_LIMITS } from "./public-api.js";
import type {
  PublicActionInputContract,
  PublicActionInputSchema,
  PublicJsonSchema,
} from "./public-api-inputs.js";
import { REVIEW_LENS_INSTRUCTION_MAX_BYTES, REVIEW_LENS_LABEL_MAX_CHARS } from "./review-lens.js";

/** A reviewer's focus, on a Multi Review reviewer row or a build's review rows. */
export const REVIEW_LENS_INPUT: PublicJsonSchema = {
  type: "object",
  description:
    "This reviewer's focus. The reviewer looks hardest at it and still reports critical issues outside it. The text is copied into the review, so later preset edits never change it.",
  properties: {
    label: {
      type: "string",
      minLength: 1,
      maxLength: REVIEW_LENS_LABEL_MAX_CHARS,
      description: "Short name of the focus, one line.",
    },
    instruction: {
      type: "string",
      minLength: 1,
      maxLength: REVIEW_LENS_INSTRUCTION_MAX_BYTES,
      description: `What to look at hardest; at most ${REVIEW_LENS_INSTRUCTION_MAX_BYTES} bytes of UTF-8.`,
    },
  },
  required: ["label", "instruction"],
  additionalProperties: false,
};

/** The Build Pipeline's steps, in launcher order. */
export const PUBLIC_BUILD_STEPS = BUILD_STEP_KEYS;

const instructions: PublicJsonSchema = {
  type: "string",
  maxLength: MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
  description: `The user's own instructions for this step, at most ${MAX_BUILD_STEP_INSTRUCTIONS_BYTES} bytes of UTF-8 (16 KiB). The step's prompt carries them after its own contract; Fix uses the build step's. Receipts and summaries report their size, never the text.`,
};

const stepFields: Record<string, PublicJsonSchema> = {
  agent: {
    type: "string",
    enum: AGENT_PLATFORMS,
    description: "Agent platform. Omitted: the step's saved agent and model.",
  },
  model: {
    type: "string",
    minLength: 1,
    maxLength: 500,
    description: "Model ID from agent.options; requires agent. Omitted: the agent's saved model.",
  },
  reasoningEffort: {
    type: "string",
    minLength: 1,
    maxLength: 100,
    description: "Reasoning level; requires model.",
  },
  fastMode: { type: "boolean", description: "Use the model's fast speed where supported." },
  instructions,
};

/** A named step: every field optional, so naming only instructions keeps the saved selection. */
function stepOverride(description: string, withLens = false): PublicJsonSchema {
  return {
    type: "object",
    description,
    properties: { ...stepFields, ...(withLens ? { lens: REVIEW_LENS_INPUT } : {}) },
    additionalProperties: false,
  };
}

/** One reviewer row: an agent and model, an optional focus and instructions. */
const reviewerRow: PublicJsonSchema = {
  type: "object",
  properties: {
    ...stepFields,
    agent: { type: "string", enum: AGENT_PLATFORMS, description: "Agent platform." },
    model: { type: "string", minLength: 1, maxLength: 500, description: "Model ID." },
    lens: REVIEW_LENS_INPUT,
  },
  required: ["agent", "model"],
  additionalProperties: false,
};

const pipelineId: PublicJsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.idMaxChars,
  description: "Build pipeline ID, from build.list or a build.launch receipt.",
};

function schema(
  properties: Record<string, PublicJsonSchema>,
  required: readonly string[] = [],
): PublicActionInputSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const id = (description: string): PublicJsonSchema => ({
  type: "string",
  minLength: 1,
  maxLength: PUBLIC_API_LIMITS.idMaxChars,
  description,
});

export const BUILD_ACTION_INPUTS: Readonly<
  Record<"build.launch" | "build.list" | "build.get" | "build.cancel", PublicActionInputContract>
> = Object.freeze({
  "build.launch": {
    capability: "environments.lifecycle",
    confirmation: "voice",
    input: schema(
      {
        projectId: id("Project ID, from project.list."),
        ticketId: id(
          "Kanban ticket to build, from ticket.list. Its title, description, criteria, comments and images are the task, as for the Build button.",
        ),
        type: {
          type: "string",
          enum: ["local", "container"],
          description:
            "Build in a new environment: local uses a Git worktree on the backend host; container uses Docker. Give exactly one of type and environmentId.",
        },
        environmentId: id(
          "Build in this existing environment of the project instead of a new one. Give exactly one of type and environmentId.",
        ),
        baseBranch: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description:
            "Branch the new environment starts from; give together with baseCommit, and only with type.",
        },
        baseCommit: {
          type: "string",
          minLength: 40,
          maxLength: 40,
          description: "Full 40-character commit SHA on baseBranch; give together with baseBranch.",
        },
        agent: {
          type: "string",
          enum: AGENT_PLATFORMS,
          description:
            "The pipeline's build agent. Omitted: the saved build agent (a steps.build agent wins).",
        },
        steps: {
          type: "object",
          description:
            "Per-step overrides. A step you name replaces only that step's saved selection; one that names only instructions keeps its saved agent and model. Omitted steps keep their saved defaults.",
          properties: Object.fromEntries(
            PUBLIC_BUILD_STEPS.map((step) => [
              step,
              stepOverride(
                step === "review"
                  ? "The review step (a single reviewer). With reviewers, reviewer 1 is the review step."
                  : `The ${step} step.`,
                step === "review",
              ),
            ]),
          ),
          additionalProperties: false,
        },
        reviewers: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          description:
            "Reviewer rows for the review step, each with an optional focus (lens) and instructions. Omitted: the saved Multi Review reviewers and their saved focus. More than one runs the reviewer panel.",
          items: reviewerRow,
        },
        reviewPreparation: stepOverride(
          "Preparation and consolidation of a multi-reviewer review. Omitted: the saved one; naming only instructions keeps the saved model.",
        ),
        maxIterations: {
          type: "integer",
          minimum: 1,
          maximum: MAX_BUILD_PIPELINE_ITERATIONS,
          description: `Review, fix and verify rounds before the pipeline gives up, from 1 to ${MAX_BUILD_PIPELINE_ITERATIONS}. Omitted: 3.`,
        },
      },
      ["projectId", "ticketId"],
    ),
    examples: [
      { projectId: "project-1", ticketId: "ticket-1", type: "local" },
      { projectId: "project-1", ticketId: "ticket-1", environmentId: "env-1", maxIterations: 2 },
      {
        projectId: "project-1",
        ticketId: "ticket-1",
        type: "container",
        baseBranch: "main",
        baseCommit: "0123456789abcdef0123456789abcdef01234567",
        agent: "claude",
        steps: {
          build: { agent: "codex", model: "gpt-5.5", reasoningEffort: "high" },
          verify: { instructions: "Run the CLI help and check the new flag is listed." },
        },
        reviewers: [
          {
            agent: "claude",
            model: "claude-opus-5",
            lens: { label: "Security", instruction: "Trace untrusted input to its sinks." },
            instructions: "Ignore generated files.",
          },
          { agent: "codex", model: "gpt-5.5" },
        ],
        reviewPreparation: { instructions: "Group findings by file." },
      },
    ],
  },
  "build.list": {
    capability: "sessions.read",
    confirmation: "never",
    input: schema(
      {
        projectId: id("Project ID, from project.list."),
        limit: {
          type: "integer",
          minimum: 1,
          maximum: PUBLIC_API_LIMITS.pageMaxItems,
          description: `Page size (default ${PUBLIC_API_LIMITS.pageDefaultItems}).`,
        },
        cursor: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "nextCursor from the previous page.",
        },
      },
      ["projectId"],
    ),
    examples: [{ projectId: "project-1" }, { projectId: "project-1", limit: 10 }],
  },
  "build.get": {
    capability: "sessions.read",
    confirmation: "never",
    input: schema({ pipelineId }, ["pipelineId"]),
    examples: [{ pipelineId: "pipeline-1" }],
  },
  "build.cancel": {
    capability: "sessions.control",
    confirmation: "never",
    input: schema({ pipelineId }, ["pipelineId"]),
    examples: [{ pipelineId: "pipeline-1" }],
  },
});
