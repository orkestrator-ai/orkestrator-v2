import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CoordinatorControlScope, ControlMcpInvoker } from "./control-mcp-server.js";
import { workflowSummary } from "./control-workflow-summary.js";
import type { MultiReviewActionResult } from "@orkestrator/protocol/multi-review";

const selection = z
  .object({
    agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
    model: z.string().trim().min(1).max(512),
    reasoningEffort: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

function response(value: MultiReviewActionResult) {
  const summary = {
    ...value,
    workflow: workflowSummary(value.workflow as unknown as Record<string, unknown>),
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
        "Preferred complete Multi Review button action: accept the launch dialog's reviewer rows and fix model, use saved branch/instruction defaults when omitted, reuse an active review, start at most once, and durably create/focus its root tab in the selected pane even while the environment UI is inactive. No build pipeline prerequisite. Reuse requestId with the same payload on retry; inspect outcome/ui/recovery before claiming success. Use get_launch_options to choose models.",
      inputSchema: z
        .object({
          requestId: z.string().trim().min(1).max(256),
          environmentId: z.string().trim().min(1).max(200),
          reviewers: z.array(selection).min(1).max(32),
          fixModel: selection,
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
            ? "Complete Address findings action: open the root review, persist an idempotent fix handoff, then the backend publishes/selects Fix after dispatch. A pending result means queued, not delivered; inspect get_multi_review for addressPromptPending/presentationError and use open_multi_review_fix for presentation recovery. Adopt another conversation's workflow first."
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
