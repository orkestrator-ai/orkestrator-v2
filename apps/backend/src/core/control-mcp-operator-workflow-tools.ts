import type { McpServer } from "@modelcontextprotocol/server";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { PUBLIC_PR_MERGE_METHODS } from "@orkestrator/protocol/public-api-inputs-pr";
import { Schema } from "effect";
import { describe, list, str, strictObject, toolInput } from "./tool-schema.js";
import { onNode, type ControlMcpCaller } from "./control-mcp-caller.js";
import { operatorAction, operatorListNodes } from "./control-mcp-operator-tools.js";
import {
  AUTO_ADDRESS_FINDINGS_FIELD_DESCRIPTION,
  AUTO_PR_FIELD_DESCRIPTION,
  MULTI_REVIEW_AUTOMATION_DESCRIPTION,
} from "./control-mcp-review-actions.js";
import { nodeIdField, readAnnotations } from "./control-mcp-tool-support.js";

/**
 * Workflow tools for operator credentials, under the names a coordinator
 * already knows (`launch_multi_review`, `get_multi_review`, …), plus the
 * action bar's Create PR, Resolve Conflicts and Merge buttons and `list_nodes`.
 * Each is one public action (`review.*`, `pr.*`, `node.list`) under the
 * credential's authority, so its request key, receipt and error codes are
 * the CLI's, and `nodeId` runs it on a leaf node. `control-mcp-tools.ts`
 * lists each one only when the credential may call its action.
 */

const requestId = describe(
  str({ trim: true, min: 1, max: 256 }),
  "Idempotency key: new for each request, reused only to retry the same one.",
);
const workflowId = describe(
  str({ trim: true, min: 1, max: 200 }),
  "Multi Review workflow ID, from list_multi_reviews or a launch result.",
);
const selection = strictObject({
  agent: Schema.Literals(AGENT_PLATFORMS),
  model: str({ trim: true, min: 1, max: 512 }),
  reasoningEffort: Schema.optionalKey(str({ trim: true, min: 1, max: 128 })),
});
const agentFields = {
  agent: Schema.optionalKey(
    describe(
      Schema.Literals(AGENT_PLATFORMS),
      "Omit to use the action's configured default agent, as the button does.",
    ),
  ),
  model: Schema.optionalKey(describe(str({ trim: true, min: 1, max: 500 }), "Requires agent.")),
  reasoning: Schema.optionalKey(describe(str({ trim: true, min: 1, max: 100 }), "Requires model.")),
  fastMode: Schema.optionalKey(Schema.Boolean),
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
      inputSchema: toolInput(Schema.Struct({})),
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
          "The complete Multi Review button: reviewers, preparation/consolidation, then the optional Address Findings and PR, using saved defaults for what you omit; an active review is reused. Its root tab is created in the environment. Follow it with get_multi_review; reuse requestId only to retry. " +
          MULTI_REVIEW_AUTOMATION_DESCRIPTION,
        inputSchema: toolInput(
          strictObject({
            requestId,
            environmentId: str({ trim: true, min: 1, max: 200 }),
            reviewers: Schema.optionalKey(
              describe(list(selection, { min: 1, max: 32 }), "Omit for the saved reviewer rows."),
            ),
            reviewModel: Schema.optionalKey(
              describe(selection, "Omit for the saved consolidation model."),
            ),
            fixModel: Schema.optionalKey(
              describe(selection, "Omit for the saved Address Findings model."),
            ),
            autoFix: Schema.optionalKey(
              describe(Schema.Boolean, AUTO_ADDRESS_FINDINGS_FIELD_DESCRIPTION),
            ),
            autoPr: Schema.optionalKey(describe(Schema.Boolean, AUTO_PR_FIELD_DESCRIPTION)),
            targetBranch: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
            reviewInstruction: Schema.optionalKey(str({ max: 100_000 })),
            nodeId: nodeIdField,
          }),
        ),
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
      inputSchema: toolInput(
        Schema.Struct({
          environmentId: str({ trim: true, min: 1, max: 200 }),
          nodeId: nodeIdField,
        }),
      ),
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
        "One Multi Review's phase, error, Address Findings handoff and auto-address findings/auto-PR state. Check back with it rather than polling.",
      inputSchema: toolInput(Schema.Struct({ workflowId, nodeId: nodeIdField })),
      annotations: readAnnotations(),
    },
    async ({ workflowId: id, nodeId }) =>
      operatorAction(onNode(caller, nodeId), "review.get", { workflowId: id }, undefined),
  );

  for (const [name, surface, title] of [
    ["open_multi_review", "root", "Open or focus the Multi Review tab"],
    ["open_multi_review_fix", "fix", "Open or focus the Multi Review Address Findings tab"],
  ] as const) {
    server.registerTool(
      name,
      {
        title,
        description: `${title}. Starts no work.`,
        inputSchema: toolInput(Schema.Struct({ requestId, workflowId, nodeId: nodeIdField })),
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
        "The Address findings button: hand the consolidated findings to the review's Address Findings session. A pending result means queued; check get_multi_review.",
      inputSchema: toolInput(Schema.Struct({ requestId, workflowId, nodeId: nodeIdField })),
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
      inputSchema: toolInput(Schema.Struct({ requestId, workflowId, nodeId: nodeIdField })),
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
      "The Create PR button: a PR agent tab that commits, pushes and opens a pull request against targetBranch (default: the project's PR base branch). It never merges (merge_pr does). Refused when the environment already has a PR.",
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
        inputSchema: toolInput(
          strictObject({
            requestId,
            environmentId: str({ trim: true, min: 1, max: 200 }),
            targetBranch: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
            ...agentFields,
            confirmToken: Schema.optionalKey(
              describe(
                str({ trim: true, min: 1, max: 200 }),
                "confirmToken from a confirmation-required result (voice credentials).",
              ),
            ),
            nodeId: nodeIdField,
          }),
        ),
        annotations: WRITE,
      },
      async ({ requestId: key, nodeId, confirmToken, ...input }) =>
        operatorAction(onNode(caller, nodeId), action, input, key, confirmToken),
    );
  }

  server.registerTool(
    "merge_pr",
    {
      title: "Merge a pull request",
      description:
        "The Merge and Merge and Cleanup buttons (merge_environment_pr): merge the environment's pull request into its target branch. It cannot be undone, so the first call returns confirmation-required with a description: show it to the user, then repeat the call with confirmToken. A merge GitHub has accepted but not finished is a running receipt; follow it with run_status.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          environmentId: str({ trim: true, min: 1, max: 200 }),
          method: Schema.optionalKey(
            describe(
              Schema.Literals(PUBLIC_PR_MERGE_METHODS),
              "How to merge (default squash, as on the button).",
            ),
          ),
          deleteBranch: Schema.optionalKey(
            describe(Schema.Boolean, "Delete the head branch after merging (default true)."),
          ),
          cleanup: Schema.optionalKey(
            describe(
              Schema.Boolean,
              "Merge and Cleanup: also delete this environment and its worktree once the merge is confirmed. Cannot be combined with deleteBranch false.",
            ),
          ),
          expectedHeadSha: Schema.optionalKey(
            describe(
              str({ trim: true, length: 40 }),
              "headSha from pr_get. The merge is refused if the branch has moved since.",
            ),
          ),
          confirmToken: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 200 }),
              "confirmToken from a confirmation-required result, after the user agreed.",
            ),
          ),
          nodeId: nodeIdField,
        }),
      ),
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ requestId: key, nodeId, confirmToken, ...input }) =>
      operatorAction(onNode(caller, nodeId), "pr.merge", input, key, confirmToken),
  );
}
