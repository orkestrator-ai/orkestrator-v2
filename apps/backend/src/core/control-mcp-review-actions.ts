import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinatorControlScope, ControlMcpInvoker } from "./control-mcp-server.js";
import { workflowSummary } from "./control-workflow-summary.js";
import type { MultiReviewActionResult } from "@orkestrator/protocol/multi-review";

const selection = z
  .object({
    agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
    model: z.string().trim().min(1).max(512),
    reasoningEffort: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

type SelectionRow = { agent?: unknown; model?: unknown; reasoningEffort?: unknown };

function selectionRow(row: SelectionRow | undefined) {
  if (!row) return null;
  return {
    agent: row.agent,
    model: row.model,
    ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
  };
}

/** The rows the saved review runs, and which ones the caller chose. */
function reviewSelection(
  value: MultiReviewActionResult,
  input: { reviewers?: unknown; reviewModel?: unknown; fixModel?: unknown },
) {
  const source = (field: unknown) => (field === undefined ? "default" : "requested");
  const workflow = value.workflow;
  return {
    reviewers: (workflow.reviewers ?? []).map((row) => selectionRow(row)),
    reviewModel: selectionRow(workflow.reviewModel),
    fixModel: selectionRow(workflow.fixModel),
    source: {
      reviewers: source(input.reviewers),
      reviewModel: source(input.reviewModel),
      fixModel: source(input.fixModel),
    },
  };
}

function response(
  value: MultiReviewActionResult,
  launchInput?: { reviewers?: unknown; reviewModel?: unknown; fixModel?: unknown },
) {
  const summary = {
    ...value,
    workflow: workflowSummary(value.workflow as unknown as Record<string, unknown>),
    ...(launchInput && value.workflow ? { selection: reviewSelection(value, launchInput) } : {}),
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    structuredContent: summary,
    ...(value.outcome === "partial" ? { isError: true } : {}),
  };
}

export function registerControlReviewActions(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
) {
  server.registerTool(
    "launch_multi_review",
    {
      title: "Launch and open environment Multi Review (preferred)",
      description:
        "Preferred complete Multi Review button action: accept the launch dialog's reviewer rows, preparation/consolidation model, and fix model, use saved branch/instruction defaults when omitted, reuse an active review, start at most once, and durably create/focus its root tab in the selected pane even while the environment UI is inactive. No build pipeline prerequisite. Reuse requestId with the same payload on retry; inspect outcome/ui/recovery before claiming success. " +
        "Omit reviewers, reviewModel and fixModel to use the user's saved Multi Review defaults, exactly as the Multi Review button does; set them only when the user asks for specific models (get_launch_options lists them). The result's selection reports the rows that will run and which were requested.",
      inputSchema: z
        .object({
          requestId: z.string().trim().min(1).max(256),
          environmentId: z.string().trim().min(1).max(200),
          reviewers: z
            .array(selection)
            .min(1)
            .max(32)
            .optional()
            .describe(
              "Optional. Omit to use the user's saved reviewer rows. Set only when the user asks for specific reviewers.",
            ),
          reviewModel: selection
            .optional()
            .describe(
              "Optional. Omit to use the user's saved preparation/consolidation model. Set only when the user asks for one.",
            ),
          fixModel: selection
            .optional()
            .describe(
              "Optional. Omit to use the user's saved fix model. Set only when the user asks for one.",
            ),
          targetBranch: z.string().trim().min(1).max(500).optional(),
          reviewInstruction: z.string().max(100_000).optional(),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      response(
        await invoke<MultiReviewActionResult>("launch_coordinator_multi_review_action", {
          scope,
          input,
        }),
        input,
      ),
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
      "Open or focus the saved Multi Review Fix session",
    ],
    [
      "address_multi_review",
      "address_coordinator_multi_review_action",
      "Address findings and present the durable Fix handoff",
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description:
          name === "address_multi_review"
            ? "Complete Address findings action: open the root review, persist an idempotent fix handoff, then publish Fix after dispatch. The foreground action selects Fix, while background retry or restart recovery preserves current focus. A pending result means queued, not delivered; inspect get_multi_review for addressPromptPending/presentationError and use open_multi_review_fix for presentation recovery. Adopt another conversation's associated workflow first; unassociated workflows in this project remain addressable."
            : `${title}. Complete durable UI action; no workflow or turn is launched. Works in inactive environments and survives reload. Adopt workflows owned by another conversation first. Inspect outcome/ui/recovery for presentation failure.`,
        inputSchema: z.object({ workflowId: z.string().trim().min(1).max(200) }).strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: name === "address_multi_review",
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ workflowId }) =>
        response(await invoke<MultiReviewActionResult>(command, { scope, workflowId })),
    );
  }
}
