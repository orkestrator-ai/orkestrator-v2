import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { MAX_BUILD_PIPELINE_ITERATIONS } from "@orkestrator/protocol/build-pipeline";
import {
  isBuildStepInstructions,
  MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import { PUBLIC_BUILD_STEPS } from "@orkestrator/protocol/public-api-inputs-build";
import type {
  PublicBuildPipelineActionResult,
  PublicBuildPipelineDetail,
  PublicBuildPipelineSummary,
  PublicBuildStepSummary,
  PublicPage,
} from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { CommandContext, CommandSpec, OptionSpec } from "../spec.js";
import { oneOf, REQUEST_ID_OPTION, stringOption, submit } from "./common.js";
import { parseSelection, reviewerLenses, SELECTION_HELP } from "./workflows.js";

/**
 * The Build Pipeline: `build launch|list|get|cancel`. A launch is the Build
 * button on a Kanban ticket; what the caller leaves out runs the saved Build
 * defaults. Instructions and focus text are read here and sent once; the
 * backend's receipts and summaries report their sizes, never the text.
 */

/** `--step` and `--instructions` targets: the pipeline's steps and the review preparation. */
const STAGES = [...PUBLIC_BUILD_STEPS, "preparation"] as const;
type Stage = (typeof STAGES)[number];

interface StepInput {
  agent?: string;
  model?: string;
  reasoningEffort?: string;
  instructions?: string;
}

const PROJECT_OPTION: OptionSpec = {
  name: "project",
  kind: "string",
  valueName: "PROJECT_ID",
  description: "Project ID (project list).",
};

function isStage(value: string): value is Stage {
  return (STAGES as readonly string[]).includes(value);
}

/** `STAGE=AGENT[/MODEL[@EFFORT]]`, e.g. `verify=codex/gpt-5.5@high`. */
function parseStep(raw: string): { stage: Stage; step: StepInput } {
  const equals = raw.indexOf("=");
  const stage = raw.slice(0, equals);
  if (equals <= 0 || !isStage(stage)) {
    throw new CliError(
      "invalid-input",
      `--step expects STAGE=AGENT[/MODEL[@EFFORT]] with STAGE one of ${STAGES.join(", ")}`,
    );
  }
  const rest = raw.slice(equals + 1);
  const slash = rest.indexOf("/");
  const agent = slash < 0 ? rest : rest.slice(0, slash);
  if (!(AGENT_PLATFORMS as readonly string[]).includes(agent)) {
    throw new CliError(
      "invalid-input",
      `--step ${stage}= names agent ${JSON.stringify(agent)}; use one of ${AGENT_PLATFORMS.join(", ")}`,
    );
  }
  if (slash < 0) return { stage, step: { agent } };
  // Model IDs may contain "/" (provider/model); the effort follows the last "@".
  const modelPart = rest.slice(slash + 1);
  const at = modelPart.lastIndexOf("@");
  const model = at > 0 ? modelPart.slice(0, at) : modelPart;
  const reasoningEffort = at > 0 ? modelPart.slice(at + 1) : undefined;
  if (!model) throw new CliError("invalid-input", `--step ${stage}= needs a model after /`);
  return { stage, step: { agent, model, ...(reasoningEffort ? { reasoningEffort } : {}) } };
}

/** `TARGET=VALUE`: a stage name, or a 1-based `--reviewer` row. */
function parseTarget(raw: string, flag: string): { target: Stage | number; value: string } {
  const match = /^([a-z-]+|\d+)=([\s\S]*)$/.exec(raw);
  const name = match?.[1] ?? "";
  const position = /^\d+$/.test(name) ? Number(name) : null;
  if (
    !match ||
    !match[2] ||
    (position === null ? !isStage(name) : !Number.isSafeInteger(position) || position < 1)
  ) {
    throw new CliError(
      "invalid-input",
      `${flag} expects STAGE=VALUE or N=VALUE, with STAGE one of ${STAGES.join(", ")} or N a --reviewer row from 1`,
    );
  }
  return { target: position ?? (name as Stage), value: match[2] };
}

/** Each target's instructions from `--instructions` and `--instructions-file` (`-`: stdin). */
async function stepInstructions(
  context: CommandContext,
  options: Record<string, unknown>,
): Promise<Map<Stage | number, string>> {
  const entries = [
    ...((options.instructions as string[] | undefined) ?? []).map((raw) => ({
      flag: "--instructions",
      ...parseTarget(raw, "--instructions"),
      file: false,
    })),
    ...((options["instructions-file"] as string[] | undefined) ?? []).map((raw) => ({
      flag: "--instructions-file",
      ...parseTarget(raw, "--instructions-file"),
      file: true,
    })),
  ];
  if (entries.filter((entry) => entry.file && entry.value === "-").length > 1) {
    throw new CliError("invalid-input", "Only one --instructions-file may read stdin (-)");
  }
  const instructions = new Map<Stage | number, string>();
  for (const entry of entries) {
    const label =
      typeof entry.target === "number"
        ? `Reviewer ${entry.target} instructions`
        : `${entry.target} instructions`;
    if (instructions.has(entry.target)) {
      throw new CliError("invalid-input", `${label} were given more than once`);
    }
    const text = await readTextSource(context.io, {
      ...(entry.file
        ? entry.value === "-"
          ? { stdin: true }
          : { file: entry.value }
        : { inline: entry.value }),
      label,
      maxBytes: MAX_BUILD_STEP_INSTRUCTIONS_BYTES,
      names: {
        file: "--instructions-file",
        stdin: "--instructions-file -",
        inline: "--instructions",
      },
      required: true,
    });
    if (!isBuildStepInstructions(text)) {
      throw new CliError(
        "input-too-large",
        `${label} are larger than ${MAX_BUILD_STEP_INSTRUCTIONS_BYTES} bytes`,
      );
    }
    instructions.set(entry.target, text!);
  }
  return instructions;
}

/** The `build.launch` input the flags describe, refused here before anything is sent. */
export async function buildLaunchInput(
  context: CommandContext,
  ticketId: string,
  options: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const projectId = stringOption(options, "project");
  if (!projectId) throw new CliError("invalid-input", "--project is required");
  const environmentId = stringOption(options, "environment");
  const type =
    options.type !== undefined
      ? oneOf(options.type, ["local", "container"] as const, "--type")
      : undefined;
  if ((type ? 1 : 0) + (environmentId ? 1 : 0) !== 1) {
    throw new CliError(
      "invalid-input",
      "Pass --type local|container for a new environment, or --environment ENV to build in an existing one",
    );
  }
  const steps = new Map<Stage, StepInput>();
  for (const raw of (options.step as string[] | undefined) ?? []) {
    const { stage, step } = parseStep(raw);
    if (steps.has(stage)) throw new CliError("invalid-input", `--step ${stage} was given twice`);
    steps.set(stage, step);
  }
  const rows: Array<Record<string, unknown>> = (
    (options.reviewer as string[] | undefined) ?? []
  ).map((raw) => parseSelection(raw, "--reviewer"));
  const lenses = await reviewerLenses(context, options, rows.length);
  const instructions = await stepInstructions(context, options);
  if (rows.length > 0 && (steps.has("review") || instructions.has("review"))) {
    throw new CliError(
      "invalid-input",
      "With --reviewer rows, reviewer 1 is the review step: give its model there and its instructions as --instructions 1=TEXT",
    );
  }
  for (const [target, text] of instructions) {
    if (typeof target === "number") {
      if (target > rows.length) {
        throw new CliError(
          "invalid-input",
          `--instructions ${target}= names reviewer ${target}, but only ${rows.length} --reviewer rows were given`,
        );
      }
      rows[target - 1]!.instructions = text;
    } else {
      steps.set(target, { ...steps.get(target), instructions: text });
    }
  }
  const reviewers = rows.map((row, index) => {
    const lens = lenses.get(index + 1);
    return lens ? { ...row, lens } : row;
  });
  const preparation = steps.get("preparation");
  steps.delete("preparation");
  const maxIterations = options["max-iterations"] as number | undefined;
  if (
    maxIterations !== undefined &&
    (maxIterations < 1 || maxIterations > MAX_BUILD_PIPELINE_ITERATIONS)
  ) {
    throw new CliError(
      "invalid-input",
      `--max-iterations must be from 1 to ${MAX_BUILD_PIPELINE_ITERATIONS}, the Build Pipeline's iteration limit`,
    );
  }
  return {
    projectId,
    ticketId,
    ...(type ? { type } : {}),
    ...(environmentId ? { environmentId } : {}),
    ...(options["base-branch"] !== undefined ? { baseBranch: options["base-branch"] } : {}),
    ...(options["base-commit"] !== undefined ? { baseCommit: options["base-commit"] } : {}),
    ...(options.agent !== undefined ? { agent: options.agent } : {}),
    ...(steps.size > 0 ? { steps: Object.fromEntries(steps) } : {}),
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(preparation ? { reviewPreparation: preparation } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  };
}

function stepText(step: PublicBuildStepSummary | null | undefined): string {
  if (!step) return "";
  const selection = `${step.agent}${step.model ? `/${step.model}` : ""}${step.reasoningEffort ? `@${step.reasoningEffort}` : ""}`;
  const extras = [
    step.instructionsBytes > 0 ? `instructions ${step.instructionsBytes} B` : "",
    step.lens ? `focus ${step.lens.labelBytes + step.lens.instructionBytes} B` : "",
  ].filter(Boolean);
  return extras.length > 0 ? `${selection} (${extras.join(", ")})` : selection;
}

function summaryLines(build: PublicBuildPipelineSummary): Array<[string, unknown]> {
  return [
    ["build", build.id],
    ["project", build.projectId],
    ["ticket", build.taskId],
    ["environment", build.environmentId],
    ["phase", build.phase],
    ["iteration", `${build.iteration}/${build.maxIterations}`],
    ...(build.error ? ([["error", build.error]] as Array<[string, unknown]>) : []),
  ];
}

function actionLines(result: PublicBuildPipelineActionResult): string[] {
  return keyValues([
    ["build", result.pipelineId],
    ["ticket", result.taskId],
    ["environment", result.environmentId],
    ["phase", result.phase],
    ...(result.reused !== undefined
      ? ([["reused", result.reused ? "yes" : "no"]] as Array<[string, unknown]>)
      : []),
  ]);
}

export const buildCommands: CommandSpec[] = [
  {
    path: ["build", "launch"],
    action: "build.launch",
    summary:
      "Start a ticket's Build Pipeline, as the Build button does (its active build is reused).",
    description:
      "Builds the Kanban ticket in a new environment (--type) or an existing one (--environment): build, review, address, verify and PR. Omitted steps, reviewers and preparation use the saved Build defaults; a step named only by --instructions keeps its saved model. The pipeline continues in the backend; follow it with `build get`.",
    positionals: [
      { name: "ticket", required: true, description: "Kanban ticket ID (ticket list)." },
    ],
    options: [
      PROJECT_OPTION,
      {
        name: "type",
        kind: "string",
        valueName: "local|container",
        description: "Build in a new environment of this type.",
      },
      {
        name: "environment",
        kind: "string",
        valueName: "ENV",
        description: "Build in this existing environment instead.",
      },
      {
        name: "base-branch",
        kind: "string",
        valueName: "BRANCH",
        description: "New environment's base branch; with --base-commit.",
      },
      {
        name: "base-commit",
        kind: "string",
        valueName: "SHA",
        description: "New environment's base commit (40 hex).",
      },
      {
        name: "agent",
        kind: "string",
        valueName: "AGENT",
        description: "Build agent. Omitted: the saved build agent.",
      },
      {
        name: "step",
        kind: "list",
        valueName: "STAGE=AGENT[/MODEL[@EFFORT]]",
        description: `A step's agent and model (repeatable). STAGE: ${STAGES.join(", ")}.`,
      },
      {
        name: "instructions",
        kind: "list",
        valueName: "STAGE=TEXT",
        description: `Your instructions for a step (repeatable), at most ${MAX_BUILD_STEP_INSTRUCTIONS_BYTES} bytes; N=TEXT for --reviewer row N. Fix uses build's.`,
      },
      {
        name: "instructions-file",
        kind: "list",
        valueName: "STAGE=PATH",
        description:
          "Read a step's (or N=PATH, a reviewer's) instructions from a local file; - reads stdin.",
      },
      {
        name: "reviewer",
        kind: "list",
        valueName: "SELECTION",
        description: `Reviewer row (repeatable): ${SELECTION_HELP} Reviewer 1 is the review step.`,
      },
      {
        name: "focus",
        kind: "list",
        valueName: "N=TEXT",
        description:
          "Focus (lens) for --reviewer row N (repeatable): the first line is the label (at most 64 characters), the rest the instruction (at most 4 KiB); one line is both.",
      },
      {
        name: "focus-file",
        kind: "list",
        valueName: "N=PATH",
        description: "Read --reviewer row N's focus from a local file, laid out like --focus.",
      },
      {
        name: "max-iterations",
        kind: "integer",
        valueName: "N",
        description: `Review, fix and verify rounds, 1 to ${MAX_BUILD_PIPELINE_ITERATIONS} (default 3).`,
      },
      REQUEST_ID_OPTION,
    ],
    inputFields: {
      ticket: "ticketId",
      step: "steps",
      instructions: "steps",
      "instructions-file": "steps",
      reviewer: "reviewers",
      focus: "reviewers",
      "focus-file": "reviewers",
    },
    idOutput: "build pipeline ID",
    async run(context, parsed) {
      const input = await buildLaunchInput(
        context,
        parsed.positionals.ticket as string,
        parsed.options,
      );
      const { session, result, receipt, warnings } = await submit<PublicBuildPipelineActionResult>(
        context,
        "build.launch",
        input,
        parsed.options,
      );
      return {
        action: "build.launch",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.pipelineId],
        human: actionLines(result),
      };
    },
  },
  {
    path: ["build", "list"],
    action: "build.list",
    summary: "List a project's Build Pipelines, newest first.",
    positionals: [],
    options: [
      PROJECT_OPTION,
      { name: "limit", kind: "integer", valueName: "N", description: "Items per page (max 200)." },
      {
        name: "cursor",
        kind: "string",
        valueName: "CURSOR",
        description: "Continue from a previous page.",
      },
    ],
    idOutput: "build pipeline IDs, one per line",
    async run(context, parsed) {
      const projectId = stringOption(parsed.options, "project");
      if (!projectId) throw new CliError("invalid-input", "--project is required");
      const session = await context.session();
      const page = await session.read<PublicPage<PublicBuildPipelineSummary>>("build.list", {
        projectId,
        ...(parsed.options.limit !== undefined ? { limit: parsed.options.limit } : {}),
        ...(parsed.options.cursor !== undefined ? { cursor: parsed.options.cursor } : {}),
      });
      return {
        action: "build.list",
        result: page,
        connection: session.identity,
        ids: page.items.map((build) => build.id),
        human: [
          ...table(
            ["BUILD", "PHASE", "TICKET", "ENVIRONMENT", "CREATED"],
            page.items.map((build) => [
              build.id,
              build.phase,
              build.taskId,
              build.environmentId ?? "",
              build.createdAt,
            ]),
          ),
          ...(page.nextCursor ? [`more: --cursor ${page.nextCursor}`] : []),
        ],
      };
    },
  },
  {
    path: ["build", "get"],
    action: "build.get",
    summary:
      "Show one Build Pipeline: phase, and each step's model with the size of its instructions.",
    positionals: [{ name: "build", required: true, description: "Build pipeline ID." }],
    options: [],
    inputFields: { build: "pipelineId" },
    async run(context, parsed) {
      const session = await context.session();
      const build = await session.read<PublicBuildPipelineDetail>("build.get", {
        pipelineId: parsed.positionals.build,
      });
      return {
        action: "build.get",
        result: build,
        connection: session.identity,
        human: keyValues([
          ...summaryLines(build),
          ...PUBLIC_BUILD_STEPS.filter((key) => build.steps[key]).map((key): [string, unknown] => [
            key,
            stepText(build.steps[key]),
          ]),
          ...build.reviewers.map((reviewer, index): [string, unknown] => [
            `reviewer ${index + 1}`,
            stepText(reviewer),
          ]),
          ...(build.reviewPreparation
            ? ([["preparation", stepText(build.reviewPreparation)]] as Array<[string, unknown]>)
            : []),
        ]),
      };
    },
  },
  {
    path: ["build", "cancel"],
    action: "build.cancel",
    summary: "Cancel a running Build Pipeline; its record, environment and tabs are kept.",
    positionals: [{ name: "build", required: true, description: "Build pipeline ID." }],
    options: [REQUEST_ID_OPTION],
    inputFields: { build: "pipelineId" },
    idOutput: "build pipeline ID",
    async run(context, parsed) {
      const pipelineId = parsed.positionals.build as string;
      const { session, result, receipt, warnings } = await submit<PublicBuildPipelineActionResult>(
        context,
        "build.cancel",
        { pipelineId },
        parsed.options,
      );
      return {
        action: "build.cancel",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [pipelineId],
        human: actionLines(result),
      };
    },
  },
];
