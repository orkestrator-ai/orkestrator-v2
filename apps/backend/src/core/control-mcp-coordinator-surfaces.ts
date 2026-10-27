import type { McpServer } from "@modelcontextprotocol/server";
import {
  COORDINATOR_TAB_EDIT_OPERATIONS,
  COORDINATOR_TERMINAL_TAB_TYPES,
} from "@orkestrator/protocol/coordinator-surfaces";
import { z } from "zod";
import type { CoordinatorControlScope } from "./control-mcp-tools.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";
import { readAnnotations, toolResult, type JsonRecord } from "./control-mcp-tool-support.js";

/**
 * Coordinator tools for a worker's own surfaces (todo 0142): a terminal or
 * tmux tab, a browser preview, tab editing, looped review, feature-plan
 * launch, and the request to copy the checkout's uncommitted changes into a
 * worker. None of them reaches the project checkout; the last one only asks
 * the user. Each calls one `*_coordinator_*` backend command with the
 * authenticated scope, which revalidates it and refuses the project home.
 */

const requestId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe("Stable key for this action; reuse it only to retry the same call.");
const environmentId = z.string().trim().min(1).max(200);

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/** Looped reviews and feature plans settle without waking the coordinator. */
const NO_STATUS_WAKE = {
  delivery: "async",
  wake: "This conversation is not woken when it settles. Finish your turn and tell the user it is running; if you need to act on the result, schedule a check with create_schedule rather than waiting.",
  nextStep: "Finish your turn now. Do not poll.",
};

export const COORDINATOR_SURFACE_TOOL_CAPABILITIES: ReadonlyArray<readonly [string, string]> = [
  ["launch_terminal", "jobs"],
  ["open_worker_browser", "environments"],
  ["edit_worker_tab", "environments"],
  ["request_root_changes", "environments"],
  ["start_looped_review", "multi-review"],
  ["get_looped_review", "multi-review"],
  ["cancel_looped_review", "multi-review"],
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
        "Open a terminal tab in a worker environment of this project and run one command in it (tabType plain), or start an agent CLI there (claude, codex, grok, opencode, pi, or claude-tmux for Claude under tmux) with an optional prompt. The tab opens selected in the worker's active pane, as a terminal the user opened would. Never the project checkout. Read its output later with get_tab_transcript. Omit model and reasoningEffort to use the CLI's own defaults.",
      inputSchema: z
        .object({
          requestId,
          environmentId,
          tabType: z.enum(COORDINATOR_TERMINAL_TAB_TYPES).default("plain"),
          command: z
            .string()
            .min(1)
            .max(100_000)
            .optional()
            .describe("plain only: the shell command to run."),
          prompt: z
            .string()
            .min(1)
            .max(100_000)
            .optional()
            .describe("Agent CLIs only: the first prompt."),
          model: z.string().trim().min(1).max(512).optional(),
          reasoningEffort: z.string().trim().min(1).max(128).optional(),
          title: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
      annotations: { ...WRITE, destructiveHint: true, openWorldHint: true },
    },
    async (input) => toolResult(await call("launch_coordinator_terminal", { input })),
  );

  server.registerTool(
    "open_worker_browser",
    {
      title: "Open or navigate a worker's browser preview",
      description:
        "Open a browser tab in a worker environment at a loopback address of a service that worker runs (http://localhost:3000/path), or navigate the existing browser tab tabId there. The address resolves to the worker's own service, local or container. Only http(s) loopback addresses; this is not a way to browse the web. Works while the worker is not on screen.",
      inputSchema: z
        .object({
          requestId,
          environmentId,
          url: z.string().trim().min(1).max(2048),
          tabId: z
            .string()
            .trim()
            .min(1)
            .max(200)
            .optional()
            .describe("An existing browser tab (list_tabs) to navigate instead of opening one."),
          title: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
      annotations: WRITE,
    },
    async (input) => toolResult(await call("open_coordinator_browser", { input })),
  );

  server.registerTool(
    "edit_worker_tab",
    {
      title: "Focus, close or move a worker's tab",
      description:
        "Edit a worker environment's tabs: focus selects a tab, move puts it in another pane (pane IDs from list_tabs), close closes it. Closing a tab never deletes its conversation; it is refused while the tab's agent is working or waiting on a person, and while a coordinator waits on that tab's report. Closing a tab that is already gone succeeds. Open tabs with launch_job, launch_terminal, open_worker_browser and open_multi_review.",
      inputSchema: z
        .object({
          environmentId,
          tabId: z.string().trim().min(1).max(200),
          operation: z.enum(COORDINATOR_TAB_EDIT_OPERATIONS),
          toPaneId: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
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
      inputSchema: z
        .object({
          requestId,
          environmentId,
          files: z
            .array(z.string().trim().min(1).max(512))
            .max(200)
            .optional()
            .describe("Checkout-relative paths to pre-select."),
          reason: z.string().trim().min(1).max(500).describe("Why, in the user's words."),
        })
        .strict(),
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

  server.registerTool(
    "start_looped_review",
    {
      title: "Start a looped review in a worker",
      description:
        "The Looped review button: one agent reviews the worker's branch, fixes what it finds, and repeats until it is clean or the pass allowance is spent, then opens a PR. It commits in the worker, never merges, and opens its tab in the worker. One per worker at a time. Omit agent, model and reasoningEffort to use the Review action's saved default, and targetBranch and reviewInstruction to use the repository's PR base branch and the saved review instruction.",
      inputSchema: z
        .object({
          requestId,
          environmentId,
          agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]).optional(),
          model: z.string().trim().min(1).max(512).optional(),
          reasoningEffort: z.string().trim().min(1).max(128).optional(),
          targetBranch: z.string().trim().min(1).max(500).optional(),
          reviewInstruction: z.string().max(100_000).optional(),
          allowance: z.number().int().min(1).max(20).optional(),
        })
        .strict(),
      annotations: { ...WRITE, destructiveHint: true, openWorldHint: true },
    },
    async (input) =>
      toolResult({
        ...(await call("start_coordinator_looped_review", { input })),
        ...NO_STATUS_WAKE,
      }),
  );

  server.registerTool(
    "get_looped_review",
    {
      title: "Get a looped review",
      description: "Read a looped review's phase, round count and PR state.",
      inputSchema: z.object({ workflowId: z.string().trim().min(1).max(200) }).strict(),
      annotations: readAnnotations(),
    },
    async ({ workflowId }) =>
      toolResult(await call("get_coordinator_looped_review", { workflowId })),
  );

  server.registerTool(
    "cancel_looped_review",
    {
      title: "Cancel a looped review",
      description: "Cancel a looped review in a worker of this project. Commits it made stay.",
      inputSchema: z.object({ workflowId: z.string().trim().min(1).max(200) }).strict(),
      annotations: { ...WRITE, destructiveHint: true },
    },
    async ({ workflowId }) =>
      toolResult(await call("cancel_coordinator_looped_review", { workflowId })),
  );

  server.registerTool(
    "launch_feature_plan",
    {
      title: "Plan a feature",
      description:
        "Start feature planning, as New feature and Send on the Features board do: a planning agent in its own environment turns the message into a feature summary and stories. Omit featureId to start a new plan, or name one (from get_feature_plan) to send it another message. It never writes the project checkout. Building from a plan stays the user's Build button.",
      inputSchema: z
        .object({
          requestId,
          message: z.string().trim().min(1).max(100_000),
          featureId: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
      annotations: { ...WRITE, openWorldHint: true },
    },
    async (input) =>
      toolResult({
        ...(await call("launch_coordinator_feature_plan", { input })),
        ...NO_STATUS_WAKE,
      }),
  );

  server.registerTool(
    "get_feature_plan",
    {
      title: "Get a feature plan",
      description:
        "Read a feature plan's title, status, summary, stories, planning phase and latest reply.",
      inputSchema: z.object({ featureId: z.string().trim().min(1).max(200) }).strict(),
      annotations: readAnnotations(),
    },
    async ({ featureId }) => toolResult(await call("get_coordinator_feature_plan", { featureId })),
  );
}
