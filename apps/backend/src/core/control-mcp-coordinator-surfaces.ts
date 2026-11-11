import type { McpServer } from "@modelcontextprotocol/server";
import { COORDINATOR_PR_STATUS_WAKE } from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_TAB_EDIT_OPERATIONS,
  COORDINATOR_TERMINAL_TAB_TYPES,
} from "@orkestrator/protocol/coordinator-surfaces";
import {
  MAX_AGENTS_MD_CHANGES,
  MAX_AGENTS_MD_ENTRY_CHARS,
  MAX_AGENTS_MD_REASON_CHARS,
} from "@orkestrator/protocol/agents-md-orkestrator";
import { Schema } from "effect";
import { describe, list, str, strictObject, toolInput, withDefault } from "./tool-schema.js";
import { createNodeTargets } from "./control-mcp-nodes.js";
import type { CoordinatorControlScope } from "./control-mcp-tools.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";
import { readAnnotations, toolResult, type JsonRecord } from "./control-mcp-tool-support.js";
import {
  registerWorkerQuestionTools,
  WORKER_QUESTION_TOOL_CAPABILITIES,
} from "./control-mcp-worker-questions.js";

/**
 * Coordinator tools for a worker's own surfaces (coordinator.md, "Worker surfaces"): a terminal or
 * tmux tab, a browser preview, tab editing, the PR and Resolve tabs,
 * feature-plan launch, the request to copy the checkout's uncommitted changes into a
 * worker, and the proposal to save decisions to AGENTS.md. None of them
 * reaches the project checkout; the last two only ask the user. Each calls one `*_coordinator_*` backend command with the
 * authenticated scope, which revalidates it and refuses the project home.
 * The terminal, browser, tab-edit, PR and Resolve tools take `nodeId` for a worker on
 * a connected node (todo 0395).
 */

const requestId = describe(
  str({ trim: true, min: 1, max: 256 }),
  "Stable key for this action; reuse it only to retry the same call.",
);
const environmentId = str({ trim: true, min: 1, max: 200 });
const workerNodeId = Schema.optionalKey(
  describe(
    str({ trim: true, min: 1, max: 200 }),
    "The worker's nodeId from list_nodes; omit for this node.",
  ),
);

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** A planning exchange wakes the coordinator when its reply is ready or it fails. */
const FEATURE_PLAN_STATUS_WAKE = {
  delivery: "async",
  wake: "This conversation is woken once when the planning reply is ready, and when planning fails. Read the reply with get_feature_plan then. A cancelled request sends nothing.",
  nextStep: "Finish your turn now. Do not poll.",
};

export const COORDINATOR_SURFACE_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["launch_terminal", "jobs"],
  ["open_worker_browser", "environments"],
  ["edit_worker_tab", "environments"],
  ["request_root_changes", "environments"],
  ...WORKER_QUESTION_TOOL_CAPABILITIES,
  // Main coordinator only: side agents' credentials lack `environments`.
  ["propose_agents_md_update", "environments"],
  ["create_pr", "multi-review"],
  ["resolve_conflicts", "multi-review"],
  ["launch_feature_plan", "tickets"],
  ["get_feature_plan", "tickets"],
];

export function registerCoordinatorSurfaceTools(
  server: McpServer,
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): void {
  const call = async (command: string, args: JsonRecord) =>
    invoke<JsonRecord>(command, {
      scope: {
        projectId: scope.projectId,
        coordinatorId: scope.coordinatorId,
        conversationId: scope.conversationId,
      },
      ...args,
    });

  server.registerTool(
    "launch_terminal",
    {
      title: "Open a terminal or tmux tab in a worker",
      description:
        "Open a terminal tab in a worker environment of this project and run one command in it (tabType plain), or start an agent CLI there (claude, codex, grok, opencode, pi, or claude-tmux for Claude under tmux, refused unless the worker's machine has the experimental Tmux mode setting on) with an optional prompt (grok supports a bare launch only; prompt, model and reasoningEffort are refused). The tab opens selected in the worker's active pane, as a terminal the user opened would. Never the project checkout. Read its output later with get_tab_transcript. Omit model and reasoningEffort to use the CLI's own defaults. Pass nodeId for a worker on another connected node; if its answer is lost, retry with the same requestId, which reattaches to the same terminal there.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          environmentId,
          tabType: withDefault(Schema.Literals(COORDINATOR_TERMINAL_TAB_TYPES), "plain"),
          command: Schema.optionalKey(
            describe(str({ min: 1, max: 100_000 }), "plain only: the shell command to run."),
          ),
          prompt: Schema.optionalKey(
            describe(str({ min: 1, max: 100_000 }), "Agent CLIs except grok: the first prompt."),
          ),
          model: Schema.optionalKey(str({ trim: true, min: 1, max: 512 })),
          reasoningEffort: Schema.optionalKey(str({ trim: true, min: 1, max: 128 })),
          title: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          nodeId: workerNodeId,
        }),
      ),
      annotations: { ...WRITE, destructiveHint: true, openWorldHint: true },
    },
    async (input) => toolResult(await call("launch_coordinator_terminal", { input })),
  );

  server.registerTool(
    "open_worker_browser",
    {
      title: "Open or navigate a worker's browser preview",
      description:
        "Open a browser tab in a worker environment at a loopback address of a service that worker runs (http://localhost:3000/path), or navigate the existing browser tab tabId there. The address resolves to the worker's own service, local or container. Only http(s) loopback addresses; this is not a way to browse the web. Works while the worker is not on screen. Pass nodeId for a worker on another connected node.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          environmentId,
          url: str({ trim: true, min: 1, max: 2048 }),
          tabId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 200 }),
              "An existing browser tab (list_tabs) to navigate instead of opening one.",
            ),
          ),
          title: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          nodeId: workerNodeId,
        }),
      ),
      annotations: WRITE,
    },
    async (input) => toolResult(await call("open_coordinator_browser", { input })),
  );

  server.registerTool(
    "edit_worker_tab",
    {
      title: "Focus, close or move a worker's tab",
      description:
        "Edit a worker environment's tabs: focus selects a tab, move puts it in another pane (pane IDs from list_tabs), close closes it. Closing a tab never deletes its conversation; it is refused while a native agent tab's turn is running or waiting on a person, and while a coordinator waits on that tab's report; a terminal tab closes with whatever it is running. Closing a tab that is already gone succeeds. Open tabs with launch_job, launch_terminal, open_worker_browser and open_multi_review. Pass nodeId for a worker on another connected node (list_tabs with the same nodeId gives its pane and tab IDs).",
      inputSchema: toolInput(
        strictObject({
          environmentId,
          tabId: str({ trim: true, min: 1, max: 200 }),
          operation: Schema.Literals(COORDINATOR_TAB_EDIT_OPERATIONS),
          toPaneId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
          nodeId: workerNodeId,
        }),
      ),
      annotations: { ...WRITE, destructiveHint: true },
    },
    async (input) => toolResult(await call("edit_coordinator_worker_tab", { input })),
  );

  server.registerTool(
    "request_root_changes",
    {
      title: "Ask the user to copy uncommitted checkout changes into a worker",
      description:
        "Ask the user to apply some of the project checkout's uncommitted changes (edits, new and deleted files) to a worker environment on this node, for when the user wants a worker to start from work they have not committed. The user picks the files in Orkestrator; files you name are only pre-selected. Nothing is read or copied until they approve. The patch applies whole or not at all, and you are woken by mail with the outcome.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          environmentId,
          files: Schema.optionalKey(
            describe(
              list(str({ trim: true, min: 1, max: 512 }), { max: 200 }),
              "Checkout-relative paths to pre-select.",
            ),
          ),
          reason: describe(str({ trim: true, min: 1, max: 500 }), "Why, in the user's words."),
        }),
      ),
      annotations: WRITE,
    },
    async (input) =>
      toolResult({
        ...(await call("request_coordinator_root_changes", { input })),
        delivery: "async",
        wake: "You will be woken by mail when the user approves or declines. Nothing has changed yet.",
        nextStep: "Finish your turn now. Do not poll.",
      }),
  );

  registerWorkerQuestionTools(server, call);

  const entryText = str({ min: 1, max: MAX_AGENTS_MD_ENTRY_CHARS });
  server.registerTool(
    "propose_agents_md_update",
    {
      title: "Propose saving decisions to AGENTS.md (## Orkestrator)",
      description:
        "Propose adding, replacing or removing entries in the ## Orkestrator section of the project's root AGENTS.md: durable decisions, rules and preferences the user agreed that future workers and conversations must follow. Ask the user first, naming any pattern noticed in repeated steering or an explicit standing preference and quoting the exact entries you suggest. Call only after the user agrees, using any wording they changed, and batch every decision into one call. You write nothing: the user sees the change as a diff against the base branch, may edit it, and approves or declines; only an approval makes Orkestrator open a pull request (never merged automatically). Each entry is one plain line; headings, lists, fences, HTML and line breaks are refused, and only that section of AGENTS.md can change. You are woken by mail with the outcome and the pull request URL. If the user declines, do not propose those entries again in this conversation unless they ask.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          changes: list(
            strictObject({
              action: Schema.Literals(["add", "replace", "remove"]),
              text: describe(
                entryText,
                "The entry (one line, no leading bullet), or for replace the new text.",
              ),
              replaces: Schema.optionalKey(
                describe(entryText, "replace only: the existing entry's text, as it appears now."),
              ),
            }),
            { min: 1, max: MAX_AGENTS_MD_CHANGES },
          ),
          reason: describe(
            str({ trim: true, min: 1, max: MAX_AGENTS_MD_REASON_CHARS }),
            "Why, in the user's words; shown to the user and in the pull request.",
          ),
          nodeId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 200 }),
              "Only for the project's copy on another node (from list_nodes); the pull request is opened there. Omit for this node.",
            ),
          ),
        }),
      ),
      annotations: WRITE,
    },
    async ({ nodeId, ...input }) => {
      // A copy on another node: the node owning it reads AGENTS.md and opens the PR.
      const remote = nodeId ? await createNodeTargets(invoke, scope).targetOrSelf(nodeId) : null;
      return toolResult({
        ...(await call("request_coordinator_agents_md_update", {
          input,
          ...(remote
            ? {
                target: {
                  nodeId: remote.nodeId,
                  nodeName: remote.nodeName,
                  projectId: remote.projectId,
                },
              }
            : {}),
        })),
        delivery: "async",
        wake: "You will be woken by mail when the user approves or declines, with the pull request URL. Nothing has changed yet.",
        nextStep: "Finish your turn now. Do not poll.",
      });
    },
  );

  server.registerTool(
    "create_pr",
    {
      title: "Raise a worker's pull request (PR tab)",
      description:
        "The Create PR button: open the worker's PR tab, whose agent commits, pushes and opens a pull request against targetBranch (default: the repository's PR base branch). It never merges. This is how a coordinator raises a pull request: call it only after the review and its fix have finished, and only when the review did not run with auto-PR. Refused while the worker's build pipeline still owns publication; skipped when the worker already has a pull request. You are woken when the pull request opens and when it later conflicts, fails its checks, becomes ready to merge, or is merged or closed. Omit targetBranch to use the owning node's PR base branch. Pass nodeId for a worker on another connected node.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          environmentId,
          nodeId: workerNodeId,
          targetBranch: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
        }),
      ),
      annotations: { ...WRITE, destructiveHint: true, openWorldHint: true },
    },
    async (input) => {
      const result = await call("create_coordinator_pr", { input });
      return toolResult({
        ...result,
        delivery: "async",
        // A skipped request raised nothing, so nothing is followed.
        wake:
          result.status === "launched"
            ? COORDINATOR_PR_STATUS_WAKE
            : "No PR tab was opened, so this request is not followed. Read the worker's pull request state with get_environment.",
        nextStep: "Finish your turn now. Do not poll.",
      });
    },
  );

  server.registerTool(
    "resolve_conflicts",
    {
      title: "Resolve a worker's pull request conflicts (Resolve tab)",
      description:
        "The Resolve Conflicts button: open the worker's Resolve tab, whose agent merges the pull request's base branch into the worker's branch, resolves the conflicts, validates, commits and pushes. It never merges the pull request. Only for a worker whose pull request is open and conflicts with its base, or whose mergeability GitHub has not computed yet; refused when the worker has no pull request, when it is merged or closed, when GitHub reports no conflicts, or while the worker's build pipeline owns it. Omit targetBranch to use the pull request's own base branch, else the repository's PR base branch. You are woken once when the Resolve tab finishes, with the refreshed pull request state. Pass nodeId for a worker on another connected node.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          environmentId,
          nodeId: workerNodeId,
          targetBranch: Schema.optionalKey(str({ trim: true, min: 1, max: 500 })),
        }),
      ),
      annotations: { ...WRITE, destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      toolResult({
        ...(await call("resolve_coordinator_conflicts", { input })),
        delivery: "async",
        wake: COORDINATOR_PR_STATUS_WAKE,
        nextStep: "Finish your turn now. Do not poll.",
      }),
  );

  server.registerTool(
    "launch_feature_plan",
    {
      title: "Plan a feature",
      description:
        "Start feature planning, as New feature and Send on the Features board do: a planning agent in its own environment turns the message into a feature summary and stories. Omit featureId to start a new plan, or name one (from get_feature_plan) to send it another message. This conversation is woken when the reply is ready or planning fails. It never writes the project checkout. Building from a plan stays the user's Build button.",
      inputSchema: toolInput(
        strictObject({
          requestId,
          message: str({ trim: true, min: 1, max: 100_000 }),
          featureId: Schema.optionalKey(str({ trim: true, min: 1, max: 200 })),
        }),
      ),
      annotations: { ...WRITE, openWorldHint: true },
    },
    async (input) =>
      toolResult({
        ...(await call("launch_coordinator_feature_plan", { input })),
        ...FEATURE_PLAN_STATUS_WAKE,
      }),
  );

  server.registerTool(
    "get_feature_plan",
    {
      title: "Get a feature plan",
      description:
        "Read a feature plan's title, status, summary, stories, planning phase and latest reply.",
      inputSchema: toolInput(strictObject({ featureId: str({ trim: true, min: 1, max: 200 }) })),
      annotations: readAnnotations(),
    },
    async ({ featureId }) => toolResult(await call("get_coordinator_feature_plan", { featureId })),
  );
}
