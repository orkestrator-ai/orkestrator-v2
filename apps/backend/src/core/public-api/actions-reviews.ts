import { reviewLaunchId } from "./review-recovery.js";
import { resolveActionDefault, type ActionDefaultKey } from "@orkestrator/protocol/action-defaults";
import { normalizeAgentPlatforms } from "@orkestrator/protocol/agent-platforms";
import { resolveActionDefaults, resolveDefaultAgent } from "@orkestrator/protocol/agent-settings";
import {
  isLaunchMultiReviewActionInput,
  isMultiReviewWorkflow,
  type LaunchMultiReviewActionInput,
  type MultiReviewActionResult,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { createPRPrompt, createResolveConflictsPrompt } from "@orkestrator/protocol/pr-prompt";
import { conciseError } from "../commands-error-text.js";
import { workflowSummary } from "../control-workflow-summary.js";
import type { Environment } from "../models.js";
import { MULTI_REVIEW_AUTO_PR_TAB_TITLE } from "../multi-review-auto-pr.js";
import { requireEnvironment } from "./actions-discovery.js";
import { parseAgentSelection, prepareSessionStart, type StartInput } from "./actions-sessions.js";
import { PublicActionError } from "./errors.js";
import {
  invalid,
  oneOf,
  onlyActionKeys,
  optionalBoolean,
  optionalString,
  requiredId,
} from "./input.js";
import type {
  ExecuteOutcome,
  MutationActionHandler,
  OperationHandle,
  PublicActionContext,
  PublicActionHandler,
  ReadActionHandler,
} from "./types.js";

/**
 * The environment buttons an agent could not reach before: Multi Review
 * (`review.*`), Create PR (`pr.create`) and Resolve Conflicts (`pr.resolve`).
 *
 * Each runs the backend twin of the button. A review launches through
 * `launch_controller_multi_review`, the unscoped Multi Review button a command
 * node's coordinator also uses, under an ID reserved from the operation, so a
 * retried request key reaches the same review. PR and Resolve open an agent
 * tab exactly as `session.start` does, with the button's prompt, tab title,
 * action default and completion hook, so they are runs with receipts.
 */

function reviewSummary(
  workflow: MultiReviewWorkflow & { backendRevision?: number },
): Record<string, unknown> {
  return {
    ...workflowSummary(workflow as unknown as Record<string, unknown>),
    targetBranch: workflow.targetBranch,
  };
}

async function requireWorkflow(context: PublicActionContext, workflowId: string) {
  const saved = await context.command.storage.getMultiReviewWorkflow(workflowId);
  if (!saved || !isMultiReviewWorkflow(saved.snapshot)) {
    throw new PublicActionError("not-found", `Multi Review not found: ${workflowId}`);
  }
  return { ...saved.snapshot, backendRevision: saved.revision };
}

function requireReviews(context: PublicActionContext) {
  if (!context.command.multiReviews) {
    throw new PublicActionError("capability-unavailable", "Multi Review is not available here");
  }
  return context.command.multiReviews;
}

/** A button action's result as an operation outcome: content-free IDs and states. */
function reviewOutcome(value: MultiReviewActionResult): ExecuteOutcome {
  const workflow = value.workflow as MultiReviewWorkflow;
  const result = {
    workflowId: workflow.id,
    environmentId: workflow.environmentId,
    phase: workflow.phase,
    reused: value.reused,
    outcome: value.outcome,
    ui: value.ui.status,
  };
  const resources = { environmentId: workflow.environmentId, projectId: workflow.projectId };
  if (value.outcome === "partial") {
    return {
      state: "partial",
      result,
      resources,
      error: {
        code: "partial-failure",
        message: (value.recovery ?? "The review tab could not be opened").slice(0, 500),
      },
    };
  }
  return { state: "succeeded", result, resources };
}

/** Keep the confirmed surface result available to restart recovery. */
async function saveReviewOutcome(operation: OperationHandle, value: MultiReviewActionResult) {
  const outcome = reviewOutcome(value);
  await operation.update({
    stage: outcome.state === "partial" ? "review-partial-saved" : "review-success-saved",
    result: outcome.result,
    resources: outcome.resources,
    ...("error" in outcome ? { error: outcome.error } : {}),
  });
  return outcome;
}

type LaunchInput = Omit<LaunchMultiReviewActionInput, "requestId">;

const reviewLaunch: MutationActionHandler<LaunchInput> = {
  kind: "mutation",
  action: "review.launch",
  parse(input) {
    onlyActionKeys(input, "review.launch");
    const environmentId = requiredId(input, "environmentId");
    const value = { ...input, environmentId } as LaunchInput;
    // The protocol's own validator of the button's request, as the
    // coordinator tool uses it.
    if (!isLaunchMultiReviewActionInput({ ...value, requestId: "validate" })) {
      throw invalid(
        "Multi Review input is invalid: reviewers take {agent, model, reasoningEffort?, lens?: {label, instruction}} (label at most 64 characters, instruction at most 4 KiB); reviewModel and fixModel take {agent, model, reasoningEffort?}",
      );
    }
    return { value, scope: `environment:${environmentId}`, intent: value };
  },
  async prepare(input, context) {
    const environment = await requireEnvironment(context, input.environmentId);
    requireReviews(context);
    return {
      resources: { environmentId: environment.id, projectId: environment.projectId },
      async execute(operation) {
        const reservedId = reviewLaunchId(operation.operationId);
        const launched = await context.invoke<MultiReviewActionResult>(
          "launch_controller_multi_review",
          { input: { ...input, requestId: operation.operationId }, reservedId },
        );
        return saveReviewOutcome(operation, launched);
      },
    };
  },
};

const reviewList: ReadActionHandler<{ environmentId: string }> = {
  kind: "read",
  action: "review.list",
  parse(input) {
    onlyActionKeys(input, "review.list");
    return { environmentId: requiredId(input, "environmentId") };
  },
  async run(input, context) {
    await requireEnvironment(context, input.environmentId);
    const records = await context.command.storage.listMultiReviewWorkflows(input.environmentId);
    const items = records
      .filter((record) => isMultiReviewWorkflow(record.snapshot))
      .map((record) =>
        reviewSummary({
          ...(record.snapshot as MultiReviewWorkflow),
          backendRevision: record.revision,
        }),
      )
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { result: { items, total: items.length } };
  },
};

const reviewGet: ReadActionHandler<{ workflowId: string }> = {
  kind: "read",
  action: "review.get",
  parse(input) {
    onlyActionKeys(input, "review.get");
    return { workflowId: requiredId(input, "workflowId") };
  },
  async run(input, context) {
    return { result: reviewSummary(await requireWorkflow(context, input.workflowId)) };
  },
};

/** `review.open` and `review.address`: the durable surface actions of a saved review. */
function surfaceHandler(
  action: "review.open" | "review.address",
): MutationActionHandler<{ workflowId: string; surface: "root" | "fix" | "address" }> {
  return {
    kind: "mutation",
    action,
    parse(input) {
      onlyActionKeys(input, action);
      const workflowId = requiredId(input, "workflowId");
      const surface =
        action === "review.address"
          ? ("address" as const)
          : (oneOf(input, "surface", ["root", "fix"] as const) ?? "root");
      const value = { workflowId, surface };
      return { value, scope: `review:${workflowId}`, intent: value };
    },
    async prepare(input, context) {
      const workflow = await requireWorkflow(context, input.workflowId);
      if (input.surface === "address") requireReviews(context);
      return {
        resources: { environmentId: workflow.environmentId, projectId: workflow.projectId },
        resolved: { workflowId: workflow.id, surface: input.surface },
        async execute(operation) {
          return saveReviewOutcome(
            operation,
            await context.invoke<MultiReviewActionResult>("controller_multi_review_surface", {
              workflowId: input.workflowId,
              surface: input.surface,
            }),
          );
        },
      };
    },
  };
}

const reviewCancel: MutationActionHandler<{ workflowId: string }> = {
  kind: "mutation",
  action: "review.cancel",
  parse(input) {
    onlyActionKeys(input, "review.cancel");
    const workflowId = requiredId(input, "workflowId");
    return { value: { workflowId }, scope: `review:${workflowId}`, intent: { workflowId } };
  },
  async prepare(input, context) {
    const workflow = await requireWorkflow(context, input.workflowId);
    const service = requireReviews(context);
    return {
      resources: { environmentId: workflow.environmentId, projectId: workflow.projectId },
      resolved: { workflowId: workflow.id },
      async execute() {
        try {
          const cancelled = await service.cancel(input.workflowId);
          return {
            state: "succeeded",
            result: { workflowId: cancelled.id, phase: cancelled.phase },
          };
        } catch (error) {
          return {
            state: "failed",
            error: { code: "operation-failed", message: conciseError(error).slice(0, 500) },
          };
        }
      },
    };
  },
};

/*
 * PR and Resolve
 */

interface ButtonInput {
  environmentId: string;
  targetBranch?: string;
  agent?: StartInput["agent"];
  model?: string;
  reasoning?: string;
  fastMode?: boolean;
}

/** The agent, model and effort the button would use: its action default, else the default agent. */
async function buttonSelection(
  context: PublicActionContext,
  environment: Environment,
  key: ActionDefaultKey,
  input: ButtonInput,
) {
  const config = await context.command.storage.loadConfig();
  const tiers = {
    environment: environment.agentSettings,
    repository: config.repositories?.[environment.projectId]?.agentSettings,
    global: config.global.agentSettings,
  };
  const enabled = normalizeAgentPlatforms(config.global.enabledAgentPlatforms);
  const fallback = resolveDefaultAgent(tiers);
  const action = resolveActionDefault(resolveActionDefaults(tiers), key, {
    fallbackAgent: enabled.includes(fallback) ? fallback : (enabled[0] ?? fallback),
    enabledAgents: enabled,
  });
  const agent = input.agent ?? action.agent;
  // The action's model applies only to its own agent, as on the button.
  const own = agent === action.agent ? action : undefined;
  const model = input.model ?? own?.model;
  const reasoning = input.reasoning ?? (input.model ? undefined : own?.reasoningEffort);
  const fastMode = input.fastMode ?? (input.model ? undefined : own?.fastMode);
  return {
    agent,
    ...(model ? { model } : {}),
    ...(model && reasoning ? { reasoning } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    repositoryBase: config.repositories?.[environment.projectId]?.prBaseBranch || undefined,
  };
}

function buttonHandler(action: "pr.create" | "pr.resolve"): MutationActionHandler<ButtonInput> {
  return {
    kind: "mutation",
    action,
    parse(input) {
      onlyActionKeys(input, action);
      const environmentId = requiredId(input, "environmentId");
      const targetBranch = optionalString(input, "targetBranch", 500)?.trim();
      const selection =
        input.agent !== undefined
          ? parseAgentSelection(input)
          : (() => {
              if (input.model !== undefined || input.reasoning !== undefined) {
                throw invalid("model and reasoning require agent");
              }
              return {};
            })();
      const fastMode = optionalBoolean(input, "fastMode");
      const value: ButtonInput = {
        environmentId,
        ...(targetBranch ? { targetBranch } : {}),
        ...selection,
        ...(fastMode !== undefined ? { fastMode } : {}),
      };
      return { value, scope: `environment:${environmentId}`, intent: value };
    },
    async prepare(input, context) {
      const environment = await requireEnvironment(context, input.environmentId);
      if (action === "pr.create" && environment.prUrl) {
        throw new PublicActionError(
          "conflict",
          "This environment already has a pull request; no PR agent was started",
          { details: { prUrl: environment.prUrl } },
        );
      }
      const { repositoryBase, ...selection } = await buttonSelection(
        context,
        environment,
        action === "pr.create" ? "pr" : "resolve",
        input,
      );
      const targetBranch =
        input.targetBranch ??
        (action === "pr.resolve" ? environment.prBaseBranch || undefined : undefined) ??
        repositoryBase ??
        "main";
      const start: StartInput = {
        environmentId: environment.id,
        ...selection,
        mode: "build",
        title: action === "pr.create" ? MULTI_REVIEW_AUTO_PR_TAB_TITLE : "Resolve",
        prompt:
          action === "pr.create"
            ? createPRPrompt(targetBranch)
            : createResolveConflictsPrompt(targetBranch),
      };
      const prepared = await prepareSessionStart(
        start,
        context,
        action === "pr.create"
          ? {
              // Poll faster until the PR appears, as the Create PR button does.
              afterAccepted: (target) =>
                context.invoke("pr_monitor_watch", {
                  environmentId: target.id,
                  mode: "create-pending",
                }),
            }
          : { completionAction: "refresh-pr-after-agent-completion" },
        environment,
      );
      return {
        ...prepared,
        resolved: { ...prepared.resolved, targetBranch },
      };
    },
  };
}

export const REVIEW_HANDLERS: PublicActionHandler[] = [
  reviewLaunch,
  reviewList,
  reviewGet,
  surfaceHandler("review.open"),
  surfaceHandler("review.address"),
  reviewCancel,
  buttonHandler("pr.create"),
  buttonHandler("pr.resolve"),
];
