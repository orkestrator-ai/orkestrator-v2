import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import {
  REVIEW_LENS_INSTRUCTION_MAX_BYTES,
  reviewLensFromText,
  type ReviewLens,
} from "@orkestrator/protocol/review-lens";
import type { PublicReceipt } from "@orkestrator/protocol/public-api";
import type { PublicNodeList } from "@orkestrator/protocol/public-api-resources";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import { readTextSource } from "../inputs.js";
import type { CommandContext, CommandSpec } from "../spec.js";
import { optionalBoolean, REQUEST_ID_OPTION, stringOption, submit } from "./common.js";
import { finishRun, submitRun, validateWaitOptions, WAIT_OPTIONS } from "./session.js";

/**
 * Nodes, Multi Review and the action bar's PR buttons: `node list`,
 * `review …` and `pr create|resolve`. Like every command they take the
 * global `--node` to run on a leaf node.
 */

interface ReviewSummary {
  id: string;
  environmentId: string;
  phase: string;
  targetBranch?: string;
  createdAt?: string;
  error?: string;
}

interface ReviewActionResult {
  workflowId: string;
  phase?: string;
  outcome?: string;
  reused?: boolean;
}

/** `AGENT=MODEL[@EFFORT]`, e.g. `codex=gpt-5.5@high`. */
function parseSelection(raw: string, flag: string) {
  const equals = raw.indexOf("=");
  const agent = raw.slice(0, equals);
  if (equals <= 0 || !(AGENT_PLATFORMS as readonly string[]).includes(agent)) {
    throw new CliError(
      "invalid-input",
      `${flag} expects AGENT=MODEL[@EFFORT] with AGENT one of ${AGENT_PLATFORMS.join(", ")}`,
    );
  }
  const rest = raw.slice(equals + 1);
  const at = rest.lastIndexOf("@");
  const model = at > 0 ? rest.slice(0, at) : rest;
  const reasoningEffort = at > 0 ? rest.slice(at + 1) : undefined;
  if (!model) throw new CliError("invalid-input", `${flag} needs a model`);
  return { agent, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
}

const SELECTION_HELP = "AGENT=MODEL[@EFFORT], e.g. codex=gpt-5.5@high.";

/** `N=VALUE`: a 1-based reviewer position and the text or path for its focus. */
function parsePositioned(raw: string, flag: string): { position: number; value: string } {
  const match = /^(\d+)=([\s\S]*)$/.exec(raw);
  const position = match ? Number(match[1]) : 0;
  if (!match || !Number.isSafeInteger(position) || position < 1 || !match[2]) {
    throw new CliError(
      "invalid-input",
      `${flag} expects N=VALUE with N a reviewer position from 1`,
    );
  }
  return { position, value: match[2] };
}

/**
 * Each reviewer's focus from `--focus N=TEXT` and `--focus-file N=PATH`. The
 * first line is the label and the rest the instruction (a single line is
 * both), so a file reads like a commit message. Positions name `--reviewer`
 * rows, which a focus therefore requires.
 */
async function reviewerLenses(
  context: CommandContext,
  options: Record<string, unknown>,
  reviewerCount: number,
): Promise<Map<number, ReviewLens>> {
  const entries = [
    ...((options.focus as string[] | undefined) ?? []).map((raw) => ({
      flag: "--focus",
      ...parsePositioned(raw, "--focus"),
      file: false,
    })),
    ...((options["focus-file"] as string[] | undefined) ?? []).map((raw) => ({
      flag: "--focus-file",
      ...parsePositioned(raw, "--focus-file"),
      file: true,
    })),
  ];
  const lenses = new Map<number, ReviewLens>();
  if (entries.length > 0 && reviewerCount === 0) {
    throw new CliError(
      "invalid-input",
      "--focus and --focus-file name --reviewer rows by position; pass the reviewers too",
    );
  }
  for (const entry of entries) {
    if (entry.position > reviewerCount) {
      throw new CliError(
        "invalid-input",
        `${entry.flag} ${entry.position}= names reviewer ${entry.position}, but only ${reviewerCount} --reviewer rows were given`,
      );
    }
    if (lenses.has(entry.position)) {
      throw new CliError("invalid-input", `Reviewer ${entry.position} has more than one focus`);
    }
    const text = entry.file
      ? await readTextSource(context.io, {
          file: entry.value,
          label: `Reviewer ${entry.position} focus`,
          // The label line and its separator ride on top of the instruction.
          maxBytes: REVIEW_LENS_INSTRUCTION_MAX_BYTES + 512,
          names: { file: "--focus-file", stdin: "--focus-file -" },
          required: true,
        })
      : entry.value;
    try {
      lenses.set(entry.position, reviewLensFromText(text ?? ""));
    } catch (error) {
      throw new CliError(
        "invalid-input",
        `${entry.flag} for reviewer ${entry.position}: ${(error as Error).message}`,
      );
    }
  }
  return lenses;
}

const AGENT_OPTIONS = [
  {
    name: "agent",
    kind: "string" as const,
    valueName: "AGENT",
    description: "Agent platform. Omitted: the action's configured default.",
  },
  { name: "model", kind: "string" as const, valueName: "MODEL", description: "Requires --agent." },
  {
    name: "reasoning",
    kind: "string" as const,
    valueName: "LEVEL",
    description: "Reasoning level; requires --model.",
  },
  {
    name: "fast",
    kind: "boolean" as const,
    negatable: true,
    description: "Fast speed where supported.",
  },
];

function reviewLines(review: ReviewSummary): string[] {
  return keyValues([
    ["review", review.id],
    ["environment", review.environmentId],
    ["phase", review.phase],
    ...(review.targetBranch ? ([["target", review.targetBranch]] as Array<[string, unknown]>) : []),
    ...(review.error ? ([["error", review.error]] as Array<[string, unknown]>) : []),
  ]);
}

function reviewMutation(
  path: string,
  action: "review.address" | "review.cancel",
  summary: string,
): CommandSpec {
  return {
    path: ["review", path],
    action,
    summary,
    positionals: [{ name: "workflow", required: true, description: "Multi Review ID." }],
    options: [REQUEST_ID_OPTION],
    inputFields: { workflow: "workflowId" },
    idOutput: "workflow ID",
    async run(context, parsed) {
      const workflowId = parsed.positionals.workflow as string;
      const { session, result, receipt, warnings } = await submit<ReviewActionResult>(
        context,
        action,
        { workflowId },
        parsed.options,
      );
      return {
        action,
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [workflowId],
        human: keyValues([
          ["review", workflowId],
          ["phase", result.phase ?? receipt?.state ?? ""],
        ]),
      };
    },
  };
}

function prCommand(verb: "create" | "resolve"): CommandSpec {
  const action = verb === "create" ? "pr.create" : "pr.resolve";
  return {
    path: ["pr", verb],
    action,
    summary:
      verb === "create"
        ? "Start the Create PR agent: commit, push and open a pull request (never merges)."
        : "Start the Resolve Conflicts agent: merge the target branch, resolve, validate and push.",
    description:
      "Opens the same agent tab as the environment's button, without focusing it. The response is a run receipt; add --wait (or `run wait`) to observe it.",
    positionals: [{ name: "environment", required: true, description: "Ready environment." }],
    options: [
      {
        name: "target-branch",
        kind: "string",
        valueName: "BRANCH",
        description:
          verb === "create"
            ? "Pull request base. Omitted: the project's PR base branch."
            : "Branch to merge in. Omitted: the environment's PR base branch.",
      },
      ...AGENT_OPTIONS,
      ...WAIT_OPTIONS,
      REQUEST_ID_OPTION,
    ],
    idOutput: "session ID",
    async run(context, parsed) {
      const options = parsed.options;
      validateWaitOptions(options);
      const fast = optionalBoolean(options, "fast");
      const input = {
        environmentId: parsed.positionals.environment as string,
        ...(options["target-branch"] !== undefined
          ? { targetBranch: options["target-branch"] }
          : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
        ...(fast !== undefined ? { fastMode: fast } : {}),
      };
      const { session, result, receipt, warnings, recoveryDeadline } = await submitRun<{
        sessionId: string;
        tabId: string;
        runId: string;
      }>(context, action, input, options);
      const fromReceipt = (final: PublicReceipt) => ({
        result: {
          sessionId: final.resources.sessionId ?? null,
          tabId: final.resources.tabId ?? null,
          runId: final.operationId,
        },
        ids: final.resources.sessionId ? [final.resources.sessionId] : [],
      });
      return finishRun(
        context,
        parsed,
        {
          action,
          ...(result ? { result, ids: [result.sessionId] } : fromReceipt(receipt!)),
          receipt,
          warnings,
          connection: session.identity,
          human: result
            ? keyValues([
                ["session", result.sessionId],
                ["run", result.runId],
              ])
            : [],
        },
        recoveryDeadline,
        result ? undefined : fromReceipt,
      );
    },
  };
}

export const workflowCommands: CommandSpec[] = [
  {
    path: ["node", "list"],
    action: "node.list",
    summary: "List this node and the leaf nodes it controls; pass a node's ID with --node.",
    positionals: [],
    options: [],
    idOutput: "node IDs",
    async run(context) {
      if (context.global.node) {
        throw new CliError(
          "invalid-input",
          "node list always lists the connected node; omit --node",
        );
      }
      const session = await context.session();
      const list = await session.read<PublicNodeList>("node.list", {});
      return {
        action: "node.list",
        result: list,
        connection: session.identity,
        ids: list.items.map((node) => node.nodeId),
        human: table(
          ["NODE", "NAME", "STATE", "VERSION", "ACTIONS"],
          list.items.map((node) => [
            node.nodeId,
            node.self ? `${node.name} (this node)` : node.name,
            node.state,
            node.version ?? "",
            node.publicActions ? "yes" : (node.reason ?? "no"),
          ]),
        ),
      };
    },
  },
  {
    path: ["review", "launch"],
    action: "review.launch",
    summary: "Start an environment's Multi Review, as its button does (an active one is reused).",
    description:
      "Omitted reviewers, models and auto-actions use the saved Multi Review settings. The review continues in the backend; follow it with `review get`.",
    positionals: [{ name: "environment", required: true, description: "Environment to review." }],
    options: [
      {
        name: "reviewer",
        kind: "list",
        valueName: "SELECTION",
        description: `Reviewer row (repeatable): ${SELECTION_HELP}`,
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
        description:
          "Read --reviewer row N's focus from a local file, laid out like --focus (repeatable).",
      },
      {
        name: "review-model",
        kind: "string",
        valueName: "SELECTION",
        description: `Preparation and consolidation model: ${SELECTION_HELP}`,
      },
      {
        name: "fix-model",
        kind: "string",
        valueName: "SELECTION",
        description: `Fix model: ${SELECTION_HELP}`,
      },
      {
        name: "auto-fix",
        kind: "boolean",
        negatable: true,
        description: "Start the Fix when consolidation reports findings.",
      },
      {
        name: "auto-pr",
        kind: "boolean",
        negatable: true,
        description: "Open the pull request after the Fix (never merges).",
      },
      {
        name: "target-branch",
        kind: "string",
        valueName: "BRANCH",
        description: "Branch to review against. Omitted: the project's PR base branch.",
      },
      {
        name: "instruction-file",
        kind: "string",
        valueName: "PATH",
        description: "Read the review instruction from a local file (empty: none).",
      },
      REQUEST_ID_OPTION,
    ],
    inputFields: {
      reviewer: "reviewers",
      focus: "reviewers",
      "focus-file": "reviewers",
      "instruction-file": "reviewInstruction",
    },
    idOutput: "workflow ID",
    async run(context, parsed) {
      const options = parsed.options;
      const rows = ((options.reviewer as string[] | undefined) ?? []).map((raw) =>
        parseSelection(raw, "--reviewer"),
      );
      const lenses = await reviewerLenses(context, options, rows.length);
      const reviewers = rows.map((row, index) => {
        const lens = lenses.get(index + 1);
        return lens ? { ...row, lens } : row;
      });
      const reviewModel = stringOption(options, "review-model");
      const fixModel = stringOption(options, "fix-model");
      const autoFix = optionalBoolean(options, "auto-fix");
      const autoPr = optionalBoolean(options, "auto-pr");
      const instructionFile = stringOption(options, "instruction-file");
      const reviewInstruction =
        instructionFile !== undefined
          ? await readTextSource(context.io, {
              file: instructionFile,
              label: "Review instruction",
              maxBytes: 100_000,
              names: { file: "--instruction-file", stdin: "--instruction-file -" },
              required: false,
            })
          : undefined;
      const { session, result, receipt, warnings } = await submit<ReviewActionResult>(
        context,
        "review.launch",
        {
          environmentId: parsed.positionals.environment,
          ...(reviewers.length ? { reviewers } : {}),
          ...(reviewModel ? { reviewModel: parseSelection(reviewModel, "--review-model") } : {}),
          ...(fixModel ? { fixModel: parseSelection(fixModel, "--fix-model") } : {}),
          ...(autoFix !== undefined ? { autoFix } : {}),
          ...(autoPr !== undefined ? { autoPr } : {}),
          ...(options["target-branch"] !== undefined
            ? { targetBranch: options["target-branch"] }
            : {}),
          ...(reviewInstruction !== undefined ? { reviewInstruction } : {}),
        },
        options,
      );
      return {
        action: "review.launch",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [result.workflowId],
        human: keyValues([
          ["review", result.workflowId],
          ["phase", result.phase ?? ""],
          ["reused", result.reused ? "yes" : "no"],
        ]),
      };
    },
  },
  {
    path: ["review", "list"],
    action: "review.list",
    summary: "List an environment's Multi Reviews, newest first.",
    positionals: [{ name: "environment", required: true }],
    options: [],
    idOutput: "workflow IDs",
    async run(context, parsed) {
      const session = await context.session();
      const page = await session.read<{ items: ReviewSummary[]; total: number }>("review.list", {
        environmentId: parsed.positionals.environment,
      });
      return {
        action: "review.list",
        result: page,
        connection: session.identity,
        ids: page.items.map((review) => review.id),
        human: table(
          ["REVIEW", "PHASE", "TARGET", "CREATED"],
          page.items.map((review) => [
            review.id,
            review.phase,
            review.targetBranch ?? "",
            review.createdAt ?? "",
          ]),
        ),
      };
    },
  },
  {
    path: ["review", "get"],
    action: "review.get",
    summary: "Read one Multi Review.",
    positionals: [{ name: "workflow", required: true, description: "Multi Review ID." }],
    options: [],
    inputFields: { workflow: "workflowId" },
    async run(context, parsed) {
      const session = await context.session();
      const review = await session.read<ReviewSummary>("review.get", {
        workflowId: parsed.positionals.workflow,
      });
      return {
        action: "review.get",
        result: review,
        connection: session.identity,
        human: reviewLines(review),
      };
    },
  },
  {
    path: ["review", "open"],
    action: "review.open",
    summary: "Open or focus a Multi Review's tab (--fix: its Fix tab); starts no work.",
    positionals: [{ name: "workflow", required: true, description: "Multi Review ID." }],
    options: [
      { name: "fix", kind: "boolean", description: "Open the Fix session tab instead." },
      REQUEST_ID_OPTION,
    ],
    inputFields: { workflow: "workflowId", fix: "surface" },
    idOutput: "workflow ID",
    async run(context, parsed) {
      const workflowId = parsed.positionals.workflow as string;
      const { session, result, receipt, warnings } = await submit<ReviewActionResult>(
        context,
        "review.open",
        { workflowId, ...(parsed.options.fix === true ? { surface: "fix" } : {}) },
        parsed.options,
      );
      return {
        action: "review.open",
        result,
        receipt,
        warnings,
        connection: session.identity,
        ids: [workflowId],
        human: [`opened review ${workflowId}`],
      };
    },
  },
  reviewMutation(
    "address",
    "review.address",
    "Address a Multi Review's findings: hand them to its Fix session.",
  ),
  reviewMutation("cancel", "review.cancel", "Cancel a running Multi Review; its record is kept."),
  prCommand("create"),
  prCommand("resolve"),
];
