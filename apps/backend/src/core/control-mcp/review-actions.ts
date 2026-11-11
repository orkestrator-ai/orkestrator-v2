import type { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { describe, list, str, strictObject, toolInput } from "../tool-schema.js";
import { coordinatorReplayFields } from "./results.js";
import type { CoordinatorControlScope, ControlMcpInvoker } from "./server.js";
import { COORDINATOR_WORKFLOW_STATUS_WAKE } from "@orkestrator/protocol/coordinator";
import { workflowSummary } from "../control-workflow-summary.js";
import { reviewLensSchema, selectedLens } from "./tool-support.js";
import { normalizeAgentMessagingSettings } from "@orkestrator/protocol/agent-mail";
import type { MultiReviewActionResult } from "@orkestrator/protocol/multi-review";

const selectionFields = {
  agent: Schema.Literals(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
  model: str({ trim: true, min: 1, max: 512 }),
  reasoningEffort: Schema.optionalKey(str({ trim: true, min: 1, max: 128 })),
};

const selection = strictObject(selectionFields);

/** A reviewer row, which alone may carry a focus. */
const reviewerSelection = strictObject({
  ...selectionFields,
  lens: Schema.optionalKey(reviewLensSchema),
});

/** The async contract for a coordinator-started workflow; see `COORDINATOR_WORKFLOW_STATUS_WAKE`. */
export async function workflowStatusWakeResult(invoke: ControlMcpInvoker) {
  const config = await invoke<{ global: { agentMessaging?: unknown } }>("get_config");
  const mode = normalizeAgentMessagingSettings(config.global.agentMessaging).coordinatorStatusWakes;
  if (mode === "off")
    return {
      delivery: "async" as const,
      wake: "Only terminal workflow notices (completed, failed or cancelled) are enabled. Ready reviews, finished fix turns, stalls and pauses will not wake this conversation.",
      nextStep:
        "Finish your turn with a summary. For non-terminal work, tell the user to inspect get_multi_review or get_build_pipeline and return to continue; do not wait for a ready or fix-turn wake.",
    };
  return {
    delivery: "async" as const,
    wake: COORDINATOR_WORKFLOW_STATUS_WAKE,
    nextStep: "Finish your turn now. Do not poll.",
  };
}

type SelectionRow = {
  agent?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  lens?: unknown;
};

function selectionRow(row: SelectionRow | undefined) {
  if (!row) return null;
  return {
    agent: row.agent,
    model: row.model,
    ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
    ...selectedLens(row.lens),
  };
}

type ReviewLaunchInput = {
  reviewers?: unknown;
  reviewModel?: unknown;
  fixModel?: unknown;
  autoFix?: unknown;
  autoPr?: unknown;
};

/** The rows and auto-actions the saved review runs, and which ones the caller chose. */
export function reviewSelection(snapshot: object, input: ReviewLaunchInput) {
  const workflow = snapshot as {
    reviewers?: SelectionRow[];
    reviewModel?: SelectionRow;
    fixModel?: SelectionRow;
    autoFix?: unknown;
    autoPr?: unknown;
  };
  const source = (field: unknown) => (field === undefined ? "default" : "requested");
  return {
    reviewers: (workflow.reviewers ?? []).map((row) => selectionRow(row)),
    reviewModel: selectionRow(workflow.reviewModel),
    fixModel: selectionRow(workflow.fixModel),
    autoFix: workflow.autoFix === true,
    autoPr: workflow.autoPr === true,
    source: {
      reviewers: source(input.reviewers),
      reviewModel: source(input.reviewModel),
      fixModel: source(input.fixModel),
      // A requested auto-PR turns an omitted auto-address findings on with it.
      autoFix:
        input.autoFix === undefined && input.autoPr === true ? "implied" : source(input.autoFix),
      autoPr: source(input.autoPr),
    },
  };
}

export const AUTO_ADDRESS_FINDINGS_FIELD_DESCRIPTION =
  "Optional. Start the Address Findings session automatically when consolidation reports findings, as the button's Auto-address findings does. Omit to use the user's saved Auto-address findings setting; omitted with autoPr: true means on. Set only when the user asks.";

export const AUTO_PR_FIELD_DESCRIPTION =
  "Optional. Start the PR session (push the branch and open the pull request) automatically once Address Findings finishes, or straight after a consolidation that found nothing to fix, as the button's Auto-PR does. It never runs while an Address Findings run is pending or running; it never merges. Omit to use the user's saved Auto-PR setting. Set only when the user asks.";

/** Shared by both launch tools so they describe auto-address findings and auto-PR identically. */
export const MULTI_REVIEW_AUTOMATION_DESCRIPTION =
  "Omit autoFix and autoPr to use the user's saved Auto-address findings and Auto-PR settings, as the button does; set them only when the user asks. With both on the review runs end to end: consolidation, then Address Findings, then a PR session once Address Findings completes. With autoPr on, a consolidation with nothing to fix starts the PR session directly. A failed, stopped or stalled Address Findings starts no PR. autoPr: true alone also turns on autoFix unless autoFix is false, in which case the PR follows an Address Findings run started with address_multi_review.";

async function response(
  value: MultiReviewActionResult,
  invoke: ControlMcpInvoker,
  options: {
    startsWork?: boolean;
    launchInput?: ReviewLaunchInput;
    /** The review runs on another node. */
    nodeId?: string;
  } = {},
) {
  const summary = {
    ...value,
    workflow: workflowSummary(value.workflow as unknown as Record<string, unknown>),
    ...(options.nodeId ? { nodeId: options.nodeId } : {}),
    // Launching or addressing starts work the coordinator will hear back about.
    ...(options.startsWork && value.outcome !== "partial"
      ? await workflowStatusWakeResult(invoke)
      : {}),
    ...(options.launchInput && value.workflow
      ? { selection: reviewSelection(value.workflow, options.launchInput) }
      : {}),
    ...coordinatorReplayFields(value),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    structuredContent: summary,
    ...(value.outcome === "partial" ? { isError: true } : {}),
  };
}

const nodeId = Schema.optionalKey(
  describe(
    str({ trim: true, min: 1, max: 200 }),
    "Optional: a nodeId from list_nodes, for a review on that node's copy of this project. Omit for this node.",
  ),
);

export function registerControlReviewActions(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
) {
  /** `nodeId` when it names another node; this node's own ID acts locally. */
  const otherNode = async (value: string | undefined): Promise<string | null> => {
    if (!value) return null;
    const status = await invoke<{ nodeId?: unknown }>("get_node_status");
    return status?.nodeId === value ? null : value;
  };

  server.registerTool(
    "launch_multi_review",
    {
      title: "Launch and open environment Multi Review (preferred)",
      description:
        "Preferred complete Multi Review button action: accept the launch dialog's reviewer rows, preparation/consolidation model, and Address Findings model, use saved branch/instruction defaults when omitted, reuse an active review, start at most once, and durably create/focus its root tab in the selected pane even while the environment UI is inactive. No build pipeline prerequisite. Reuse requestId with the same payload on retry; inspect outcome/ui/recovery before claiming success. " +
        "Omit reviewers, reviewModel and fixModel to use the user's saved Multi Review defaults, exactly as the Multi Review button does; set them only when the user asks for specific models (get_launch_options lists them). " +
        MULTI_REVIEW_AUTOMATION_DESCRIPTION +
        " The result's selection reports the rows and auto-actions that will run and which were requested; a reused active review keeps its own.",
      inputSchema: toolInput(
        strictObject({
          requestId: str({ trim: true, min: 1, max: 256 }),
          environmentId: str({ trim: true, min: 1, max: 200 }),
          reviewers: Schema.optionalKey(
            describe(
              list(reviewerSelection, { min: 1, max: 32 }),
              "Optional. Omit to use the user's saved reviewer rows and their saved focus. Set only when the user asks for specific reviewers or a focus (lens) per reviewer.",
            ),
          ),
          reviewModel: Schema.optionalKey(
            describe(
              selection,
              "Optional. Omit to use the user's saved preparation/consolidation model. Set only when the user asks for one.",
            ),
          ),
          fixModel: Schema.optionalKey(
            describe(
              selection,
              "Optional. Omit to use the user's saved Address Findings model. Set only when the user asks for one.",
            ),
          ),
          autoFix: Schema.optionalKey(
            describe(Schema.Boolean, AUTO_ADDRESS_FINDINGS_FIELD_DESCRIPTION),
          ),
          autoPr: Schema.optionalKey(describe(Schema.Boolean, AUTO_PR_FIELD_DESCRIPTION)),
          targetBranch: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
          reviewInstruction: Schema.optionalKey(str({ max: 100_000 })),
          nodeId,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ nodeId: requestedNode, ...input }) => {
      const node = await otherNode(requestedNode);
      return response(
        node
          ? await invoke<MultiReviewActionResult>("launch_coordinator_node_multi_review", {
              scope,
              nodeId: node,
              input,
            })
          : await invoke<MultiReviewActionResult>("launch_coordinator_multi_review_action", {
              scope,
              input,
            }),
        invoke,
        { startsWork: true, launchInput: input, ...(node ? { nodeId: node } : {}) },
      );
    },
  );

  for (const [name, command, title] of [
    [
      "open_multi_review",
      "open_coordinator_multi_review",
      "Open or focus the saved Multi Review root tab",
    ],
    [
      "open_multi_review_fix",
      "open_coordinator_multi_review_fix",
      "Open or focus the saved Multi Review Address Findings session",
    ],
    [
      "address_multi_review",
      "address_coordinator_multi_review_action",
      "Address findings and present the durable Address Findings handoff",
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description:
          name === "address_multi_review"
            ? "Complete Address findings action: open the root review, persist an idempotent Address Findings handoff, then publish Address Findings after dispatch. The foreground action selects Address Findings, while background retry or restart recovery preserves current focus. A pending result means queued, not delivered; inspect get_multi_review for addressPromptPending/presentationError and use open_multi_review_fix for presentation recovery. Adopt another conversation's associated workflow first; unassociated workflows in this project remain addressable."
            : `${title}. Complete durable UI action; no workflow or turn is launched. Works in inactive environments and survives reload. Adopt workflows owned by another conversation first. Inspect outcome/ui/recovery for presentation failure.`,
        inputSchema: toolInput(
          strictObject({
            workflowId: str({ trim: true, min: 1, max: 200 }),
            ...(name === "open_multi_review"
              ? {
                  reviewerId: Schema.optionalKey(
                    describe(
                      str({ trim: true, min: 1, max: 200 }),
                      "Open this reviewer's read-only transcript tab instead of the review (reviewer IDs are in get_multi_review).",
                    ),
                  ),
                }
              : {}),
            nodeId,
          }),
        ),
        annotations: {
          readOnlyHint: false,
          destructiveHint: name === "address_multi_review",
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workflowId, nodeId: requestedNode, ...rest }) => {
        const reviewerId = (rest as { reviewerId?: string }).reviewerId;
        const node = await otherNode(requestedNode);
        const surface =
          name === "open_multi_review"
            ? reviewerId
              ? "reviewer"
              : "root"
            : name === "open_multi_review_fix"
              ? "fix"
              : "address";
        return response(
          node
            ? await invoke<MultiReviewActionResult>("coordinator_node_multi_review_surface", {
                scope,
                nodeId: node,
                workflowId,
                surface,
                ...(reviewerId ? { reviewerId } : {}),
              })
            : await invoke<MultiReviewActionResult>(command, {
                scope,
                workflowId,
                ...(reviewerId ? { reviewerId } : {}),
              }),
          invoke,
          { startsWork: name === "address_multi_review", ...(node ? { nodeId: node } : {}) },
        );
      },
    );
  }

  server.registerTool(
    "custom_fix_multi_review",
    {
      title: "Start a custom Address Findings for a ready Multi Review",
      description:
        "The review tab's Custom Address Findings prompt: start Address Findings with your instruction and, optionally, another model (fixModel, from get_launch_options) instead of address_multi_review's default fix. The review must be ready (consolidated). Omit fixModel to keep the review's own Address Findings model; set it only when the user asks for a different one. A custom Address Findings never starts an automatic PR. Reuse requestId only to retry the same call, including after a lost answer from another node; a pending outcome means queued, not delivered.",
      inputSchema: toolInput(
        strictObject({
          requestId: str({ trim: true, min: 1, max: 256 }),
          workflowId: str({ trim: true, min: 1, max: 200 }),
          instruction: str({ trim: true, min: 1, max: 100_000 }),
          fixModel: Schema.optionalKey(selection),
          nodeId,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ nodeId: requestedNode, ...input }) => {
      const node = await otherNode(requestedNode);
      return response(
        node
          ? await invoke<MultiReviewActionResult>("coordinator_node_multi_review_surface", {
              scope,
              nodeId: node,
              workflowId: input.workflowId,
              surface: "custom-fix",
              requestId: input.requestId,
              instruction: input.instruction,
              ...(input.fixModel ? { fixModel: input.fixModel } : {}),
            })
          : await invoke<MultiReviewActionResult>("custom_fix_coordinator_multi_review_action", {
              scope,
              input,
            }),
        invoke,
        { startsWork: true, ...(node ? { nodeId: node } : {}) },
      );
    },
  );
}
