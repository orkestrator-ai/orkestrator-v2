import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { z } from "zod";
import { onNode, type ControlMcpCaller } from "./control-mcp-caller.js";
import { operatorAction, operatorListNodes } from "./control-mcp-operator-tools.js";
import {
  AUTO_FIX_FIELD_DESCRIPTION,
  AUTO_PR_FIELD_DESCRIPTION,
  MULTI_REVIEW_AUTOMATION_DESCRIPTION,
} from "./control-mcp-review-actions.js";
import { nodeIdField, readAnnotations } from "./control-mcp-tool-support.js";

/**
 * Workflow tools for operator credentials, under the names a coordinator
 * already knows (`launch_multi_review`, `get_multi_review`, …), plus the
 * action bar's Create PR and Resolve Conflicts buttons and `list_nodes`.
 * Each is one public action (`review.*`, `pr.*`, `node.list`) under the
 * credential's authority, so its request key, receipt and error codes are
 * the CLI's, and `nodeId` runs it on a leaf node. `control-mcp-tools.ts`
 * lists each one only when the credential may call its action.
 */

const requestId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe("Idempotency key: new for each request, reused only to retry the same one.");
const workflowId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("Multi Review workflow ID, from list_multi_reviews or a launch result.");
const selection = z
  .object({
    agent: z.enum(AGENT_PLATFORMS),
    model: z.string().trim().min(1).max(512),
    reasoningEffort: z.string().trim().min(1).max(128).optional(),
  })
  .strict();
const agentFields = {
  agent: z
    .enum(AGENT_PLATFORMS)
    .optional()
    .describe("Omit to use the action's configured default agent, as the button does."),
  model: z.string().trim().min(1).max(500).optional().describe("Requires agent."),
  reasoning: z.string().trim().min(1).max(100).optional().describe("Requires model."),
  fastMode: z.boolean().optional(),
};

const WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function registerOperatorWorkflowTools(server: McpServer, caller: ControlMcpCaller): void {
  server.registerTool(
    "list_nodes",
    {
      title: "List machines",
      description:
        "This machine and the leaf nodes it controls, with whether each is connected and can run actions. Pass a nodeId to any other tool to act on that machine.",
      inputSchema: z.object({}),
      annotations: readAnnotations(),
    },
    async () => operatorListNodes(caller),
  );

  const launch = (name: "launch_multi_review" | "start_multi_review") =>
    server.registerTool(
      name,
      {
        title:
          name === "launch_multi_review"
            ? "Launch environment Multi Review"
            : "Start environment Multi Review",
        description:
          (name === "start_multi_review"
            ? "Same as launch_multi_review for this credential (prefer that name). "
            : "") +
          "The complete Multi Review button: reviewers, preparation/consolidation, then the optional Fix and PR, using saved defaults for what you omit; an active review is reused. Its root tab is created in the environment. Follow it with get_multi_review; reuse requestId only to retry. " +
          MULTI_REVIEW_AUTOMATION_DESCRIPTION,
        inputSchema: z
          .object({
            requestId,
            environmentId: z.string().trim().min(1).max(200),
            reviewers: z
              .array(selection)
              .min(1)
              .max(32)
              .optional()
              .describe("Omit for the saved reviewer rows."),
            reviewModel: selection.optional().describe("Omit for the saved consolidation model."),
            fixModel: selection.optional().describe("Omit for the saved fix model."),
            autoFix: z.boolean().optional().describe(AUTO_FIX_FIELD_DESCRIPTION),
            autoPr: z.boolean().optional().describe(AUTO_PR_FIELD_DESCRIPTION),
            targetBranch: z.string().trim().min(1).max(500).optional(),
            reviewInstruction: z.string().max(100_000).optional(),
            nodeId: nodeIdField,
          })
          .strict(),
        annotations: WRITE,
      },
      async ({ requestId: key, nodeId, ...input }) =>
        operatorAction(onNode(caller, nodeId), "review.launch", input, key),
    );
  launch("launch_multi_review");
  launch("start_multi_review");

  server.registerTool(
    "list_multi_reviews",
    {
      title: "List an environment's Multi Reviews",
      description: "Multi Reviews of one environment, newest first, with their phase.",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, nodeId }) =>
      operatorAction(onNode(caller, nodeId), "review.list", { environmentId }, undefined),
  );

  server.registerTool(
    "get_multi_review",
    {
      title: "Read a Multi Review",
      description:
        "One Multi Review's phase, error, Fix handoff and auto-fix/auto-PR state. Check back with it rather than polling.",
      inputSchema: z.object({ workflowId, nodeId: nodeIdField }),
      annotations: readAnnotations(),
    },
    async ({ workflowId: id, nodeId }) =>
      operatorAction(onNode(caller, nodeId), "review.get", { workflowId: id }, undefined),
  );

  for (const [name, surface, title] of [
    ["open_multi_review", "root", "Open or focus the Multi Review tab"],
    ["open_multi_review_fix", "fix", "Open or focus the Multi Review Fix tab"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `${title}. Starts no work.`,
        inputSchema: z.object({ requestId, workflowId, nodeId: nodeIdField }),
        annotations: { ...WRITE, destructiveHint: false, openWorldHint: false },
      },
      async ({ requestId: key, workflowId: id, nodeId }) =>
        operatorAction(onNode(caller, nodeId), "review.open", { workflowId: id, surface }, key),
    );
  }

  server.registerTool(
    "address_multi_review",
    {
      title: "Address Multi Review findings",
      description:
        "The Address findings button: hand the consolidated findings to the review's Fix session. A pending result means queued; check get_multi_review.",
      inputSchema: z.object({ requestId, workflowId, nodeId: nodeIdField }),
      annotations: WRITE,
    },
    async ({ requestId: key, workflowId: id, nodeId }) =>
      operatorAction(onNode(caller, nodeId), "review.address", { workflowId: id }, key),
  );

  server.registerTool(
    "cancel_multi_review",
    {
      title: "Cancel a Multi Review",
      description: "Cancel a running Multi Review. Its record and tabs are kept.",
      inputSchema: z.object({ requestId, workflowId, nodeId: nodeIdField }),
      annotations: WRITE,
    },
    async ({ requestId: key, workflowId: id, nodeId }) =>
      operatorAction(onNode(caller, nodeId), "review.cancel", { workflowId: id }, key),
  );

  for (const [name, action, title, description] of [
    [
      "create_pr",
      "pr.create",
      "Create a pull request (PR tab)",
      "The Create PR button: a PR agent tab that commits, pushes and opens a pull request against targetBranch (default: the project's PR base branch). It never merges. Refused when the environment already has a PR.",
    ],
    [
      "resolve_conflicts",
      "pr.resolve",
      "Resolve merge conflicts (Resolve tab)",
      "The Resolve Conflicts button: an agent tab that merges targetBranch (default: the PR base branch), resolves and validates conflicts, commits and pushes, then refreshes the PR status.",
    ],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `${description} Returns a run; follow it with run_status.`,
        inputSchema: z
          .object({
            requestId,
            environmentId: z.string().trim().min(1).max(200),
            targetBranch: z.string().trim().min(1).max(500).optional(),
            ...agentFields,
            confirmToken: z
              .string()
              .trim()
              .min(1)
              .max(200)
              .optional()
              .describe("confirmToken from a confirmation-required result (voice credentials)."),
            nodeId: nodeIdField,
          })
          .strict(),
        annotations: WRITE,
      },
      async ({ requestId: key, nodeId, confirmToken, ...input }) =>
        operatorAction(onNode(caller, nodeId), action, input, key, confirmToken),
    );
  }
}
