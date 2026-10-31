/**
 * The Control MCP tools every operator and coordinator credential shares
 * (projects, environments, tabs, tickets, launches, mail), and the
 * coordinator-only workflow tools. `control-mcp-server.ts` owns the listener
 * and authentication; it rebuilds this server for every request.
 */
import { coordinatorDeliverNowResult } from "./coordinator-deliver-now.js";
import { McpServer } from "@modelcontextprotocol/server";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { resolveDefaultAgent } from "@orkestrator/protocol/agent-settings";
import {
  COORDINATOR_ASYNC_CONTRACT,
  COORDINATOR_LAUNCH_DEFAULTS_RULE,
  COORDINATOR_PR_RULE,
  COORDINATOR_MAIL_ADDRESS,
  COORDINATOR_TIMERS_AND_ACCOUNTS_RULE,
  COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
} from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_JOB_DELEGATION_INSTRUCTION,
  createCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { z } from "zod";
import {
  ticketKindField,
  ticketSectionsField,
  ticketStructuredOutput,
} from "./ticket-tool-fields.js";
import {
  allEnvironments,
  compactMessages,
  environmentSummary,
  launchEnvironmentCreateInput,
  launchOptions,
  launchSelectionReport,
  launchSettingsTiers,
  MAX_TRANSCRIPT_MESSAGES,
  nativeTab,
  paneTabs,
  platformLaunchDefault,
  projectSummary,
  terminalSessionId,
  validateSelection,
} from "./control-shared-actions.js";
import { onNode as callerOnNode, type ControlMcpCaller } from "./control-mcp-caller.js";
import { PUBLIC_ALL_NODES } from "@orkestrator/protocol/public-api";
import { registerCoordinatorWorkflowTools } from "./control-mcp-coordinator-tools.js";
import {
  asArray,
  assertCoordinatorLaunchBaseOnBranch,
  isRecord,
  listNodeIdField,
  nodeIdField,
  nonEmptyString,
  readAnnotations,
  toolResult,
  type JsonRecord,
} from "./control-mcp-tool-support.js";
import { registerDirectTools } from "./control-mcp-direct-tools.js";
import { registerGatewayTools } from "./control-mcp-gateway.js";
import {
  ControlMcpNodeError,
  operatorAddTicketComment,
  operatorAllNodes,
  operatorCreateTicket,
  operatorGetTicket,
  operatorLaunchEnvironment,
  operatorLaunchJob,
  operatorListMailboxes,
  operatorListProjects,
  operatorListTickets,
  operatorNode,
  operatorSendMessage,
  operatorSendPrompt,
  operatorToolListed,
  operatorUpdateTicket,
} from "./control-mcp-operator-tools.js";
import { registerVoiceTools } from "./control-mcp-voice.js";
import { registerOperatorWorkflowTools } from "./control-mcp-operator-workflow-tools.js";
import { createNodeTargets, NODE_TOOL_CAPABILITIES, type NodeTarget } from "./control-mcp-nodes.js";
import { NODE_FILE_TOOL_CAPABILITIES } from "./control-mcp-node-files.js";
import { COORDINATOR_SURFACE_TOOL_CAPABILITIES } from "./control-mcp-coordinator-surfaces.js";
import { COORDINATOR_WORKER_TOOL_CAPABILITIES } from "./control-mcp-coordinator-worker-tools.js";
import { WORKER_TURN_TOOL_CAPABILITIES } from "./control-mcp-coordinator-worker-turns.js";
import { ACCOUNT_TOOL_CAPABILITIES } from "./control-mcp-account-tools.js";
import { withCoordinatorDelegationPresentation } from "./coordinator-delegation-authority.js";

const MAX_PROMPT_LENGTH = 100_000;
const MAX_TERMINAL_OUTPUT_CHARS = 256 * 1024;
const TERMINAL_TAB_TYPES = new Set([
  "plain",
  "claude",
  "opencode",
  "codex",
  "cursor",
  "grok",
  "pi",
  "root",
  "claude-tmux",
]);

export const COORDINATOR_TOOL_CAPABILITY = new Map<string, string>([
  ["list_projects", "discovery"],
  ["list_agents", "discovery"],
  ["get_launch_options", "discovery"],
  ["get_repository_context", "discovery"],
  ["list_workflows", "discovery"],
  ["adopt_workflow", "discovery"],
  ["list_environments", "environments"],
  ["get_environment", "environments"],
  ["list_tabs", "environments"],
  ["get_tab_state", "environments"],
  ["get_tab_transcript", "environments"],
  ["launch_environment", "environments"],
  ["start_environment", "environments"],
  ["stop_environment", "environments"],
  ["list_tickets", "tickets"],
  ["get_ticket", "tickets"],
  ["create_ticket", "tickets"],
  ["update_ticket", "tickets"],
  ["add_ticket_comment", "tickets"],
  ["launch_job", "jobs"],
  ["send_prompt_to_tab", "jobs"],
  ["start_build_pipeline", "build-pipelines"],
  ["get_build_pipeline", "build-pipelines"],
  ["pause_build_pipeline", "build-pipelines"],
  ["resume_build_pipeline", "build-pipelines"],
  ["cancel_build_pipeline", "build-pipelines"],
  ["start_multi_review", "multi-review"],
  ["launch_multi_review", "multi-review"],
  ["open_multi_review", "multi-review"],
  ["open_multi_review_fix", "multi-review"],
  ["get_multi_review", "multi-review"],
  ["cancel_multi_review", "multi-review"],
  ["address_multi_review", "multi-review"],
  ["custom_fix_multi_review", "multi-review"],
  // Saved graph templates (item 214, D6): run, never author.
  ["list_graph_templates", "graphs"],
  ["launch_graph", "graphs"],
  ["get_graph_run", "graphs"],
  ["cancel_graph_run", "graphs"],
  ["list_mailboxes", "mail"],
  ["send_message", "mail"],
  ["read_messages", "mail"],
  ["get_message", "mail"],
  ["get_message_status", "mail"],
  ["ack_message", "mail"],
  ["create_schedule", "schedules"],
  ["list_schedules", "schedules"],
  ["cancel_schedule", "schedules"],
  ["pause_schedule", "schedules"],
  ["resume_schedule", "schedules"],
  ["update_schedule", "schedules"],
  ...NODE_TOOL_CAPABILITIES,
  ...NODE_FILE_TOOL_CAPABILITIES,
  ...COORDINATOR_SURFACE_TOOL_CAPABILITIES,
  ...COORDINATOR_WORKER_TOOL_CAPABILITIES,
  ...WORKER_TURN_TOOL_CAPABILITIES,
  ...ACCOUNT_TOOL_CAPABILITIES,
]);
export const COORDINATOR_CAPABILITIES = new Set(COORDINATOR_TOOL_CAPABILITY.values());

/**
 * What a conversation's credential may do. A side agent reads the project,
 * talks to the main coordinator and schedules its own reminders; it launches
 * nothing, so every worker reports to one place.
 */
export function coordinatorRoleCapabilities(role: "main" | "side"): string[] {
  return role === "side"
    ? ["discovery", "mail", "schedules"]
    : [
        "discovery",
        "tickets",
        "environments",
        "jobs",
        "build-pipelines",
        "multi-review",
        "graphs",
        "mail",
        "schedules",
        "accounts",
      ];
}

/** Whether a coordinator scope may call `tool` (listed and granted). */
export function coordinatorToolGranted(
  scope: Pick<CoordinatorControlScope, "capabilities">,
  tool: string,
): boolean {
  const required = COORDINATOR_TOOL_CAPABILITY.get(tool);
  return Boolean(required && scope.capabilities.includes(required));
}

export type CoordinatorControlScope = {
  role: "coordinator";
  projectId: string;
  coordinatorId: string;
  conversationId: string;
  mailboxIncarnationId: string;
  capabilities: readonly string[];
};

import type { ControlMcpInvoker } from "./control-shared-actions.js";

/**
 * The default launch base: the newest commit of the repository's configured
 * base branch, which is what a normal environment launch starts from too.
 */
function coordinatorLaunchBaseFromTip(tip: JsonRecord | null, failureReason?: string): JsonRecord {
  const branch = nonEmptyString(tip?.branch);
  const commit = nonEmptyString(tip?.commit);
  const available = Boolean(branch && commit);
  const unavailableReason =
    failureReason ??
    (available
      ? undefined
      : (nonEmptyString(tip?.unavailableReason) ?? "The base branch could not be resolved"));
  const fetchError = nonEmptyString(tip?.fetchError);
  return {
    baseBranch: branch,
    baseCommit: commit,
    available,
    source: "base-branch",
    ...(nonEmptyString(tip?.ref) ? { ref: tip?.ref } : {}),
    ...(available ? { remoteState: tip?.fetched === true ? "fresh" : "stale" } : {}),
    ...(fetchError ? { fetchError } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
    requiredFor: "launch_environment",
    guidance: available
      ? "Default launch base: the latest commit of the repository's base branch. Pass baseBranch and baseCommit unchanged to launch_environment and start_build_pipeline. Refresh launch options before retrying if a launch reports a stale base."
      : `The repository's base branch could not be resolved${unavailableReason ? ` (${unavailableReason})` : ""}. Report this blocked state instead of guessing; use checkoutBase only if the user asks to build on the current checkout.`,
  };
}

/** The coordinator's own checkout, offered only as an explicit alternative. */
function checkoutLaunchBaseFromStatus(
  status: JsonRecord | null,
  failureReason?: string,
): JsonRecord {
  const branch = nonEmptyString(status?.branch);
  const commit = nonEmptyString(status?.headCommit);
  const available = Boolean(branch && commit);
  let unavailableReason = failureReason;
  if (!unavailableReason && !available) {
    if (!status) unavailableReason = "Repository status is not available yet";
    else if (status.unborn === true) unavailableReason = "unborn repository";
    else if (status.detached === true || !branch) unavailableReason = "detached HEAD";
    else unavailableReason = "checkout has no HEAD commit";
  }
  return {
    baseBranch: branch,
    baseCommit: commit,
    available,
    source: "checkout",
    ...(unavailableReason ? { unavailableReason } : {}),
    guidance: available
      ? "The coordinator checkout's current branch and HEAD. Use it instead of coordinatorBase only when the user asks to build on the current checkout. Uncommitted changes are never included."
      : `The current checkout does not expose a launchable branch and commit${unavailableReason ? ` (${unavailableReason})` : ""}.`,
  };
}

function ticketSummary(task: JsonRecord): JsonRecord {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    order: task.order,
    createdAt: task.createdAt,
    commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    imageCount: Array.isArray(task.images) ? task.images.length : 0,
    environmentId: task.environmentId,
    prUrl: task.prUrl,
    prState: task.prState,
  };
}

function ticketDetail(task: JsonRecord): JsonRecord {
  return {
    ...ticketSummary(task),
    ...ticketStructuredOutput(task as Parameters<typeof ticketStructuredOutput>[0]),
    description: task.description,
    acceptanceCriteria: task.acceptanceCriteria,
    comments: Array.isArray(task.comments) ? task.comments.slice(-50) : [],
  };
}

/**
 * What every model and effort field says about leaving it out.
 *
 * Coordinators used to fill these from `get_launch_options` on every call, so
 * every worker ran a model and effort the user never chose. The schema text is
 * what the model reads at the moment it decides, so the rule lives here too.
 */
const LAUNCH_DEFAULTS_GUIDANCE =
  "Omit modelId and reasoningId to use the user's configured defaults; set them only when the user asks for a specific model or effort, or agrees to one the task needs.";
const MODEL_ID_DESCRIPTION =
  "Optional. Omit to use the user's configured default model. Set only when the user asks for a specific model.";
const REASONING_ID_DESCRIPTION =
  "Optional; requires modelId. Omit to use the user's configured default effort. Set only when the user asks for a specific effort.";
const FAST_MODE_DESCRIPTION =
  "Optional. Omit to use the user's configured speed. Set only when the user asks for one.";

/** Turns the per-agent defaults into lookups for marking catalogue rows. */
function launchDefaultsSummary(
  tiers: Parameters<typeof platformLaunchDefault>[0],
  enabledAgents: readonly AgentPlatform[],
  models: readonly AgentModel[],
): JsonRecord {
  const configuredAgent = resolveDefaultAgent(tiers);
  return {
    agent: enabledAgents.includes(configuredAgent) ? configuredAgent : (enabledAgents[0] ?? null),
    byAgent: Object.fromEntries(
      enabledAgents.map((agent) => [agent, platformLaunchDefault(tiers, agent, models)]),
    ),
    guidance: LAUNCH_DEFAULTS_GUIDANCE,
  };
}

/**
 * What every coordinator delegation tool says about what happens next.
 *
 * Carried on the result rather than left to the prompt because this is the
 * answer to the question the model is actually asking at that moment — "is it
 * done yet?" — and a tool that returns `accepted` with nothing else invites a
 * poll loop as the only obvious way to find out.
 */
function asyncDelegationResult(): JsonRecord {
  return {
    delivery: "async",
    wake: "This conversation will be woken with a message when the worker's turn ends. Progress the worker sends before then is held and delivered with that wake, so silence means it is still working.",
    nextStep: "Finish your turn now. Do not poll.",
  };
}

/** This coordinator conversation's own mailbox address, if it still has one. */
async function ownConversationMailbox(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
): Promise<{ environmentId: string; tabId: string } | null> {
  const snapshot = await invoke<unknown>("get_project_coordinator", { projectId: scope.projectId });
  const conversations =
    isRecord(snapshot) &&
    isRecord(snapshot.workspace) &&
    Array.isArray(snapshot.workspace.conversations)
      ? snapshot.workspace.conversations
      : [];
  const own = conversations.find((item) => isRecord(item) && item.id === scope.conversationId) as
    JsonRecord | undefined;
  return own && typeof own.tabId === "string"
    ? {
        environmentId: `coordinator:${scope.coordinatorId}:${scope.conversationId}`,
        tabId: own.tabId,
      }
    : null;
}

/** The same as `tryOpenCoordinatorDelegation`, for a worker on another node. */
async function tryOpenNodeDelegation(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
  worker: { nodeId: string; environmentId: string; tabId: string; requestId: string },
): Promise<boolean> {
  try {
    const result = await invoke<unknown>("open_coordinator_node_delegation", {
      scope,
      ...worker,
    });
    return isRecord(result) && result.opened === true;
  } catch (error) {
    console.warn(
      "[control-mcp] Could not open a delegation on another node:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function tryOpenCoordinatorDelegation(
  invoke: ControlMcpInvoker,
  scope: CoordinatorControlScope,
  input: { environmentId: string; tabId: string; requestId: string },
): Promise<boolean> {
  try {
    const result = await invoke<unknown>("open_coordinator_delegation", { scope, ...input });
    return isRecord(result) && result.opened === true;
  } catch (error) {
    console.warn(
      "[control-mcp] Failed to open coordinator delegation:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/**
 * A stable summary of what a mailbox page actually said.
 *
 * Identity and delivery state only: two reads that return the same messages in
 * the same states are the same answer, however the page was paginated or how
 * unread counts happened to render.
 */
function mailboxFingerprint(page: JsonRecord): string {
  const messages = Array.isArray(page.messages) ? page.messages : [];
  return JSON.stringify(
    messages.map((message) =>
      isRecord(message) ? [message.id, message.placement, message.ackedAt ?? null] : message,
    ),
  );
}

/**
 * What a worker-status poll would be watching for. `lastActivityAt` moves on
 * every turn event, so it is left out: a coordinator re-listing while a worker
 * is still `working` asks the same question each time.
 */
function environmentListFingerprint(result: {
  environments: JsonRecord[];
  otherNodes?: JsonRecord[];
}): string {
  return JSON.stringify([
    result.environments.map((environment) => [
      environment.id,
      environment.nodeId ?? null,
      environment.status,
      environment.setupPhase ?? null,
      environment.lifecycleOperation ?? null,
      environment.agentActivityState ?? null,
      environment.prState ?? null,
    ]),
    (result.otherNodes ?? []).map((node) => [
      node.nodeId,
      node.available,
      (Array.isArray(node.environments) ? node.environments : []).map((environment: JsonRecord) => [
        environment.environmentId,
        environment.status,
        environment.activity ?? null,
      ]),
    ]),
  ]);
}

/** The worker's half of the contract: one report, at the end, then stop. */
function workerAsyncContract(): string {
  return (
    `The coordinator is idle while you work and is woken once, when your turn ends. Send exactly one report — use reply_message for the message that assigned this work, or send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}" (no toTabId needed) — and then end your turn. ` +
    `Do not send progress updates: any message you send before your turn ends is held and delivered together with your final report.`
  );
}

/**
 * Whether this read is a poll: the same answer, asked again, too many times.
 *
 * Returns the refusal to send back instead of the page, or null to answer
 * normally. Deliberately fingerprint-based rather than time-based — a model
 * that reads its inbox once at the start of a turn and once before finishing is
 * doing the right thing however fast it does it, while one asking the same
 * unchanged question a fifth time is waiting, which is the thing this design
 * removed the need for.
 */
export type CoordinatorPollGuard = (key: string, fingerprint: string) => JsonRecord | null;

/**
 * Registers only the tools a credential may use, so `tools/list` never offers
 * a tool its `tools/call` would refuse. Coordinator tools are granted by
 * their capability; operator tools by the public actions they use and the
 * credential's profile.
 */
/** Tickets, mailboxes and projects of a coordinator are its own node's. */
function coordinatorNodeRefused(nodeId: string | undefined): void {
  if (nodeId) {
    throw new Error(
      "This tool acts on the coordinator's own node; other nodes take mail and launches.",
    );
  }
}

/** A legacy result from another machine names it. */
function withNodeTag<T extends { structuredContent?: unknown; content: unknown[] }>(
  result: T,
  tag: JsonRecord,
): T {
  if (!("nodeId" in tag) || !isRecord(result.structuredContent) || "isError" in result)
    return result;
  const structuredContent = { ...result.structuredContent, ...tag };
  return {
    ...result,
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  };
}

function filteredToolServer(server: McpServer, listed: (tool: string) => boolean): McpServer {
  return {
    registerTool: ((name: string, ...rest: unknown[]) =>
      listed(name)
        ? (server.registerTool as (...args: unknown[]) => unknown)(name, ...rest)
        : undefined) as McpServer["registerTool"],
  } as McpServer;
}

const OPERATOR_INSTRUCTIONS =
  "Control Orkestrator through public actions. overview says what is going on; resolve_target turns spoken names into IDs and never guesses. " +
  "Every mutation needs a new requestId; reuse one only to retry after an ambiguous response. " +
  "When a result is confirmation-required, read its description aloud, get explicit confirmation, then repeat the identical call with confirmToken. " +
  "Report that work started and check back later with run_status rather than waiting. find_actions and describe_action reveal every other action; run_action runs one.";

/** A coordinator's worker prompts ask for commits, never a pull request (see COORDINATOR_PR_RULE). */
const COORDINATOR_WORKER_PROMPT_NOTE =
  "Never ask the worker to open a pull request: ask it to commit and report back; the pull request comes from a PR tab after review.";

export async function createControlMcp(
  invoke: ControlMcpInvoker,
  coordinatorScope?: CoordinatorControlScope,
  pollGuard?: CoordinatorPollGuard,
  operatorCaller?: (messagingEnabled: boolean) => ControlMcpCaller,
): Promise<McpServer> {
  const config = await invoke<unknown>("get_config");
  const messagingEnabled =
    isRecord(config) &&
    isRecord(config.global) &&
    isRecord(config.global.agentMessaging) &&
    config.global.agentMessaging.enabled === true;
  // Scheduling is experimental; its tools are listed only while it is on.
  const schedulingEnabled =
    isRecord(config) && isRecord(config.global) && config.global.experimentalScheduling === true;
  const operator = coordinatorScope ? undefined : operatorCaller?.(messagingEnabled);
  const mcp = new McpServer(
    { name: "orkestrator-control", version: "1.0.0" },
    {
      instructions:
        "Control Orkestrator through project IDs returned by list_projects. " +
        "Use launch_environment for a new workspace and launch_job for an independent " +
        "agent tab in an existing ready environment. " +
        (coordinatorScope
          ? "Every launch_environment call requires baseBranch and baseCommit; copy coordinatorBase from get_launch_options, the latest commit of the repository's base branch, unless the user asks to build on the current checkout (checkoutBase). Prefer launch_multi_review for the complete environment Multi Review button action; start_multi_review is a backend-only recovery primitive. Use open_multi_review or open_multi_review_fix to focus saved work. "
          : "") +
        "Reuse requestId when retrying mutations. " +
        (coordinatorScope ? COORDINATOR_LAUNCH_DEFAULTS_RULE : LAUNCH_DEFAULTS_GUIDANCE) +
        // Side agents launch nothing, so the PR rule is the main coordinator's.
        (coordinatorScope?.capabilities.includes("environments") ? ` ${COORDINATOR_PR_RULE}` : "") +
        (coordinatorScope?.capabilities.includes("accounts") && schedulingEnabled
          ? ` ${COORDINATOR_TIMERS_AND_ACCOUNTS_RULE}`
          : "") +
        (coordinatorScope ? ` ${COORDINATOR_ASYNC_CONTRACT}` : "") +
        (operator ? ` ${OPERATOR_INSTRUCTIONS}` : ""),
    },
  );
  const server = filteredToolServer(mcp, (tool) => {
    if (coordinatorScope) {
      const capability = COORDINATOR_TOOL_CAPABILITY.get(tool);
      if (capability === "schedules" && !schedulingEnabled) return false;
      return capability !== undefined && coordinatorScope.capabilities.includes(capability);
    }
    // Operator credentials: the original tools are part of every profile
    // except voice, and each needs the public actions it runs.
    if (!operator) return true;
    return operator.profile !== "voice" && operatorToolListed(operator, tool);
  });

  /**
   * Launch options plus what an omitted model and effort resolve to.
   *
   * The defaults are advisory, so a settings read that fails returns the
   * options unchanged instead of failing discovery.
   */
  const launchOptionsWithDefaults = async (
    projectId: string,
    environmentId?: string,
    inv: ControlMcpInvoker = invoke,
  ): Promise<JsonRecord> => {
    const options = await launchOptions(inv, projectId, environmentId);
    let defaults: JsonRecord;
    try {
      const environment = environmentId
        ? await inv<unknown>("get_environment", { environmentId })
        : undefined;
      const tiers = await launchSettingsTiers(
        inv,
        projectId,
        isRecord(environment) ? environment : undefined,
      );
      defaults = launchDefaultsSummary(tiers, options.enabledAgents, options.models);
    } catch {
      return options as unknown as JsonRecord;
    }
    const byAgent = defaults.byAgent as Partial<Record<AgentPlatform, { modelId: string | null }>>;
    const models = options.models.map((model) => {
      const defaultId = byAgent[model.platform]?.modelId;
      return defaultId && (model.id === defaultId || model.aliases?.includes(defaultId))
        ? { ...model, isDefault: true }
        : model;
    });
    return { ...options, models, defaults };
  };

  /** The selection a launch will run, reported so an override is never silent. */
  const selectionReport = async (
    projectId: string,
    environment: JsonRecord | undefined,
    models: readonly AgentModel[],
    input: { agent: AgentPlatform; modelId?: string; reasoningId?: string },
    filterInheritedEffort = true,
    inv: ControlMcpInvoker = invoke,
  ): Promise<JsonRecord> => {
    try {
      const tiers = await launchSettingsTiers(inv, projectId, environment);
      return { selection: launchSelectionReport(tiers, models, input, filterInheritedEffort) };
    } catch {
      return {};
    }
  };

  /**
   * The node a coordinator's call names, with a routed invoker for that
   * node's copy of this project; `null` for this node. Only coordinators act
   * across nodes: any other credential is refused a `nodeId`.
   */
  const nodes = coordinatorScope
    ? createNodeTargets(invoke, {
        projectId: coordinatorScope.projectId,
        coordinatorId: coordinatorScope.coordinatorId,
        conversationId: coordinatorScope.conversationId,
      })
    : null;
  const onNode = async (nodeId: string | undefined): Promise<NodeTarget | null> => {
    if (!nodeId) return null;
    if (!nodes) throw new Error("nodeId is available to coordinators only.");
    return nodes.targetOrSelf(nodeId);
  };
  const onNodeResult = (target: NodeTarget | null): JsonRecord =>
    target ? { nodeId: target.nodeId, node: target.nodeName } : {};
  /** The invoker for one environment's node, after checking it is this project's worker there. */
  const environmentInvoker = async (
    nodeId: string | undefined,
    environmentId: string,
  ): Promise<{ inv: ControlMcpInvoker; target: NodeTarget | null; where: JsonRecord }> => {
    if (operator) {
      // An operator's nodeId names any machine; no project scope applies.
      const node = await operatorNode(operator, nodeId);
      return { inv: node.invoke, target: null, where: node.tag };
    }
    const target = await onNode(nodeId);
    if (!target) return { inv: invoke, target: null, where: {} };
    await target.environment(environmentId);
    return { inv: target.invoke, target, where: onNodeResult(target) };
  };

  server.registerTool(
    "list_projects",
    {
      title: "List Orkestrator projects",
      description: "List safe summaries of the projects configured in Orkestrator.",
      inputSchema: z.object({ nodeId: operator ? listNodeIdField : nodeIdField }),
      annotations: readAnnotations(),
    },
    async ({ nodeId }) => {
      if (operator) return operatorListProjects(callerOnNode(operator, nodeId));
      coordinatorNodeRefused(nodeId);
      const projects = asArray(await invoke("get_projects"))
        .filter((project) => !coordinatorScope || project.id === coordinatorScope.projectId)
        .map(projectSummary);
      return toolResult({ projects, total: projects.length });
    },
  );

  server.registerTool(
    "get_launch_options",
    {
      title: "Get agent launch options",
      description:
        "List enabled agents and validated model choices for a project. defaults names what a launch runs when modelId and reasoningId are omitted, and isDefault marks each agent's default model. Omit them to use these defaults.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        environmentId: z.string().trim().min(1).max(200).optional(),
        nodeId: nodeIdField,
      }),
      annotations: coordinatorScope
        ? { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
        : readAnnotations(),
    },
    async ({ projectId, environmentId, nodeId }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        return toolResult({
          ...(await launchOptionsWithDefaults(projectId, environmentId, node.invoke)),
          ...node.tag,
        });
      }
      const target = await onNode(nodeId);
      if (target) {
        // That node's agents and models, its defaults, and its copy's base branch.
        if (environmentId) await target.environment(environmentId);
        const options = await launchOptionsWithDefaults(
          target.projectId,
          environmentId,
          target.invoke,
        );
        const [coordinatorBase, checkoutBase] = await Promise.all([
          target
            .call<unknown>("get_project_base_branch_tip", { projectId: target.projectId })
            .then((tip) => coordinatorLaunchBaseFromTip(isRecord(tip) ? tip : null))
            .catch((error: unknown) =>
              coordinatorLaunchBaseFromTip(
                null,
                `Base branch is unavailable on ${target.nodeName}: ${
                  error instanceof Error ? error.message : "base branch read failed"
                }`,
              ),
            ),
          target
            .call<unknown>("get_project_git_status", { projectId: target.projectId })
            .then((status) => checkoutLaunchBaseFromStatus(isRecord(status) ? status : null))
            .catch((error: unknown) =>
              checkoutLaunchBaseFromStatus(
                null,
                `Repository status is unavailable on ${target.nodeName}: ${
                  error instanceof Error ? error.message : "status read failed"
                }`,
              ),
            ),
        ]);
        return toolResult({ ...options, coordinatorBase, checkoutBase, ...onNodeResult(target) });
      }
      const options = await launchOptionsWithDefaults(projectId, environmentId);
      if (!coordinatorScope) return toolResult(options);
      // Fetching the base branch moves remote-tracking refs only. The checkout
      // side stays read-only: reuse the persisted coordinator snapshot rather
      // than running a lock-serialized, workspace-mutating git status.
      const [coordinatorBase, checkoutBase] = await Promise.all([
        invoke<unknown>("get_project_base_branch_tip", { projectId: coordinatorScope.projectId })
          .then((tip) => coordinatorLaunchBaseFromTip(isRecord(tip) ? tip : null))
          .catch((error: unknown) =>
            coordinatorLaunchBaseFromTip(
              null,
              `Base branch is unavailable: ${
                error instanceof Error ? error.message : "base branch read failed"
              }`,
            ),
          ),
        invoke<unknown>("get_project_coordinator", { projectId: coordinatorScope.projectId })
          .then((snapshot) => {
            const workspace =
              isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
            return checkoutLaunchBaseFromStatus(
              workspace && isRecord(workspace.repositoryStatus) ? workspace.repositoryStatus : null,
            );
          })
          .catch((error: unknown) =>
            checkoutLaunchBaseFromStatus(
              null,
              `Repository status is unavailable: ${
                error instanceof Error ? error.message : "coordinator snapshot failed"
              }`,
            ),
          ),
      ]);
      return toolResult({ ...options, coordinatorBase, checkoutBase });
    },
  );

  server.registerTool(
    "list_environments",
    {
      title: "List Orkestrator environments",
      description: "List environment lifecycle and agent activity summaries.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200).optional(),
        status: z.enum(["running", "stopped", "error", "creating", "stopping"]).optional(),
        nodeId: operator ? listNodeIdField : nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, status, nodeId }) => {
      if (operator) {
        if (nodeId === PUBLIC_ALL_NODES && projectId) {
          throw new ControlMcpNodeError(
            "invalid-input",
            "A projectId belongs to one machine: pass its nodeId instead of all",
          );
        }
        const { reachable, unavailable } =
          nodeId === PUBLIC_ALL_NODES
            ? await operatorAllNodes(operator)
            : { reachable: [await operatorNode(operator, nodeId)], unavailable: [] };
        const failed: JsonRecord[] = [...unavailable];
        const groups = await Promise.all(
          reachable.map((node) =>
            allEnvironments(node.invoke, projectId)
              .then((all) =>
                all
                  .filter((environment) => !status || environment.status === status)
                  .map((environment) => ({ ...environmentSummary(environment), ...node.tag })),
              )
              .catch((error: unknown) => {
                // One machine failing must not hide the others' environments.
                if (nodeId !== PUBLIC_ALL_NODES) throw error;
                failed.push({
                  ...node.tag,
                  reason: error instanceof Error ? error.message.slice(0, 300) : "read failed",
                });
                return [];
              }),
          ),
        );
        const environments = groups.flat();
        return toolResult({
          environments,
          total: environments.length,
          ...(failed.length > 0 ? { unavailableNodes: failed } : {}),
        });
      }
      const target = await onNode(nodeId);
      const all = target
        ? await allEnvironments(target.invoke, target.projectId)
        : await allEnvironments(invoke, projectId ?? coordinatorScope?.projectId);
      const environments = all
        .filter((environment) => !status || environment.status === status)
        .filter((environment) => !target || environment.projectHome !== true)
        .map((environment) => ({ ...environmentSummary(environment), ...onNodeResult(target) }));
      // A coordinator also sees where else this project runs (names and state
      // only); nodeId on any environment tool acts there.
      const otherNodes =
        nodes && !nodeId
          ? await invoke<unknown>("get_node_summaries")
              .then(async (summaries) => {
                const hint = await nodes.ownRepository();
                const list =
                  isRecord(summaries) && Array.isArray(summaries.nodes) ? summaries.nodes : [];
                return list.flatMap((node: JsonRecord) => {
                  const project = (Array.isArray(node.projects) ? node.projects : []).find(
                    (entry: JsonRecord) => hint && entry.repositoryHint === hint,
                  ) as JsonRecord | undefined;
                  const ref = project && isRecord(project.ref) ? project.ref : null;
                  if (!ref) return [];
                  const rows = (Array.isArray(node.environments) ? node.environments : [])
                    .filter(
                      (environment: JsonRecord) =>
                        environment.projectId === ref.projectId &&
                        !environment.isProjectHome &&
                        (!status || environment.status === status),
                    )
                    .map((environment: JsonRecord) => ({
                      environmentId: isRecord(environment.ref)
                        ? environment.ref.environmentId
                        : undefined,
                      name: environment.name,
                      status: environment.status,
                      activity: environment.activity,
                      ...(environment.branch ? { branch: environment.branch } : {}),
                    }));
                  return [
                    {
                      nodeId: node.nodeId,
                      node: isRecord(node.view) ? node.view.displayName : node.nodeId,
                      available: node.available === true,
                      environments: rows,
                    },
                  ];
                });
              })
              .catch(() => [])
          : [];
      const result = {
        environments,
        total: environments.length,
        ...(otherNodes.length > 0 ? { otherNodes } : {}),
      };
      // A coordinator re-listing unchanged environments is polling its workers.
      const guidance = pollGuard?.(
        `list_environments:${JSON.stringify({ projectId, status, nodeId })}`,
        environmentListFingerprint(result),
      );
      return toolResult(guidance ? { ...result, ...guidance } : result);
    },
  );

  server.registerTool(
    "get_environment",
    {
      title: "Get an Orkestrator environment",
      description: "Read the authoritative lifecycle and activity state of one environment.",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, nodeId }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        const environment = await node.invoke<unknown>("get_environment", { environmentId });
        if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
        return toolResult({ environment: { ...environmentSummary(environment), ...node.tag } });
      }
      const target = await onNode(nodeId);
      const environment = target
        ? await target.environment(environmentId)
        : await invoke<unknown>("get_environment", { environmentId });
      if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
      return toolResult({
        environment: { ...environmentSummary(environment), ...onNodeResult(target) },
      });
    },
  );

  server.registerTool(
    "list_tabs",
    {
      title: "List environment tabs",
      description: "List tabs from the backend-owned pane layout of an environment.",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, nodeId }) => {
      const { inv, where } = await environmentInvoker(nodeId, environmentId);
      const layout = await inv<unknown>("get_pane_layout", { environmentId });
      const tabs = paneTabs(layout);
      return toolResult({ environmentId, ...where, tabs, total: tabs.length });
    },
  );

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description:
        "Every agent tab in the project's environments, and its coordinator conversations, with what each is doing now: working, waiting (on a person), idle, stopped (its environment is not running) or unknown. Includes per-environment counts. Read this instead of polling tabs one by one.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200).optional(),
        environmentId: z.string().trim().min(1).max(200).optional(),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, environmentId, nodeId }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        const snapshot = await node.invoke<unknown>("get_agent_registry", {
          ...(projectId ? { projectId } : {}),
          ...(environmentId ? { environmentId } : {}),
        });
        if (!isRecord(snapshot)) throw new Error("Agent registry returned no result");
        return toolResult({ ...snapshot, ...node.tag });
      }
      const target = await onNode(nodeId);
      if (target) {
        if (environmentId) await target.environment(environmentId);
        const remote = await target.call<unknown>("get_agent_registry", {
          projectId: target.projectId,
          ...(environmentId ? { environmentId } : {}),
        });
        if (!isRecord(remote)) throw new Error("Agent registry returned no result");
        // That node's own coordinator conversations are not this coordinator's agents.
        const entries = asArray(remote.entries).filter(
          (entry) => entry.ownerKind !== "coordinator",
        );
        return toolResult({ ...remote, entries, ...onNodeResult(target) });
      }
      const snapshot = await invoke<unknown>("get_agent_registry", {
        ...(coordinatorScope
          ? { projectId: coordinatorScope.projectId }
          : projectId
            ? { projectId }
            : {}),
        ...(environmentId ? { environmentId } : {}),
      });
      if (!isRecord(snapshot)) throw new Error("Agent registry returned no result");
      return toolResult(snapshot);
    },
  );

  server.registerTool(
    "get_tab_state",
    {
      title: "Get tab state",
      description:
        "Read native-agent state for a tab without returning its transcript. state.interactions lists what the tab is waiting on: each pending question or approval with its id, kind, questions and options (a coordinator may propose an answer to a question with answer_worker_question).",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, tabId, nodeId }) => {
      const { inv, where: node } = await environmentInvoker(nodeId, environmentId);
      const where = { environmentId, tabId, ...node };
      const [layout, environment] = await Promise.all([
        inv<unknown>("get_pane_layout", { environmentId }),
        inv<unknown>("get_environment", { environmentId }),
      ]);
      const tab = paneTabs(layout).find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`Tab not found: ${tabId}`);
      const native = nativeTab(layout, tabId);
      if (!native) {
        if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
        if (typeof tab.type !== "string" || !TERMINAL_TAB_TYPES.has(tab.type)) {
          return toolResult({ ...where, tab, state: { kind: "persisted" } });
        }
        const state = await inv<unknown>("get_terminal_session", {
          sessionId: terminalSessionId(environment, environmentId, tabId),
        });
        return toolResult({ ...where, tab, state });
      }
      const projection = await inv<unknown>("get_native_agent_projection", {
        environmentId,
        agent: native.agent,
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        messageLimit: 1,
      });
      if (!isRecord(projection)) {
        return toolResult({ ...where, agent: native.agent, connection: "connecting" });
      }
      const { messages: _messages, ...state } = projection;
      return toolResult({ ...where, agent: native.agent, state });
    },
  );

  server.registerTool(
    "get_tab_transcript",
    {
      title: "Read a tab transcript",
      description:
        "Read a bounded normalized transcript for a native tab, or a bounded terminal-output tail for a terminal tab.",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        limit: z.number().int().min(1).max(MAX_TRANSCRIPT_MESSAGES).default(50),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, tabId, limit, nodeId }) => {
      const { inv, where } = await environmentInvoker(nodeId, environmentId);
      const [layout, environment] = await Promise.all([
        inv<unknown>("get_pane_layout", { environmentId }),
        inv<unknown>("get_environment", { environmentId }),
      ]);
      const native = nativeTab(layout, tabId);
      if (native) {
        const projection = await inv<unknown>("get_native_agent_projection", {
          environmentId,
          agent: native.agent,
          logicalSessionKey: `env-${environmentId}:${tabId}`,
          messageLimit: limit,
        });
        if (!isRecord(projection)) {
          return toolResult({
            environmentId,
            tabId,
            ...where,
            agent: native.agent,
            messages: [],
          });
        }
        const compact = compactMessages(
          Array.isArray(projection.messages) ? projection.messages : [],
        );
        return toolResult({
          environmentId,
          tabId,
          ...where,
          agent: native.agent,
          ...compact,
          messageWindow: projection.messageWindow,
          revision: projection.revision,
          generation: projection.generation,
        });
      }
      if (!isRecord(environment)) throw new Error(`Environment not found: ${environmentId}`);
      const tab = paneTabs(layout).find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error(`Tab not found: ${tabId}`);
      if (typeof tab.type !== "string" || !TERMINAL_TAB_TYPES.has(tab.type)) {
        throw new Error(`Transcript is unavailable for tab type: ${String(tab.type)}`);
      }
      const sessionId = terminalSessionId(environment, environmentId, tabId);
      const snapshot = await inv<unknown>("get_terminal_output_snapshot", { sessionId });
      const output =
        isRecord(snapshot) && typeof snapshot.output === "string" ? snapshot.output : "";
      const stripped = output.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
      return toolResult({
        environmentId,
        tabId,
        ...where,
        kind: "terminal-output",
        output: stripped.slice(-MAX_TERMINAL_OUTPUT_CHARS),
        truncated:
          stripped.length > MAX_TERMINAL_OUTPUT_CHARS ||
          (isRecord(snapshot) && snapshot.truncated === true),
        revision: isRecord(snapshot) ? snapshot.revision : undefined,
        generation: isRecord(snapshot) ? snapshot.generation : undefined,
      });
    },
  );

  server.registerTool(
    "list_tickets",
    {
      title: "List Kanban tickets",
      description: "List Kanban tickets for one configured project.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, status, nodeId }) => {
      if (operator)
        return operatorListTickets(callerOnNode(operator, nodeId), {
          projectId,
          ...(status ? { status } : {}),
        });
      coordinatorNodeRefused(nodeId);
      const tasks = asArray(await invoke("get_kanban_tasks", { projectId }))
        .filter((task) => !status || task.status === status)
        .map(ticketSummary);
      return toolResult({ tickets: tasks, total: tasks.length });
    },
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Read a Kanban ticket",
      description: "Read one ticket after verifying it belongs to the selected project.",
      inputSchema: z.object({
        projectId: z.string().trim().min(1).max(200),
        ticketId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, ticketId, nodeId }) => {
      if (operator)
        return operatorGetTicket(callerOnNode(operator, nodeId), { projectId, ticketId });
      coordinatorNodeRefused(nodeId);
      const task = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!task) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create a Kanban ticket",
      description:
        "Create a ticket in one configured project. Give either sections (structured) or description and acceptanceCriteria (plain text); both forms are kept in step.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(500),
        kind: ticketKindField,
        sections: ticketSectionsField,
        description: z.string().max(100_000).default(""),
        acceptanceCriteria: z.string().max(100_000).default(""),
        status: z.enum(["backlog", "in-progress", "review", "done"]).default("backlog"),
        nodeId: nodeIdField,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      requestId,
      projectId,
      title,
      kind,
      sections,
      description,
      acceptanceCriteria,
      status,
      nodeId,
    }) => {
      const structured = { ...(kind ? { kind } : {}), ...(sections ? { sections } : {}) };
      if (operator) {
        return operatorCreateTicket(callerOnNode(operator, nodeId), {
          requestId,
          projectId,
          title,
          description,
          acceptanceCriteria,
          status,
          ...structured,
        });
      }
      coordinatorNodeRefused(nodeId);
      const project = await invoke<unknown>("get_project", { projectId });
      if (!isRecord(project)) throw new Error(`Project not found: ${projectId}`);
      const task = await invoke<unknown>("add_kanban_task", {
        projectId,
        title,
        description,
        acceptanceCriteria,
        status,
        requestId,
        ...structured,
      });
      if (!isRecord(task)) throw new Error("Kanban ticket creation returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update a Kanban ticket",
      description:
        "Update specified editable fields of a ticket in one project; sections replaces only the sections it names.",
      inputSchema: z
        .object({
          requestId: z.string().trim().min(1).max(256).optional(),
          projectId: z.string().trim().min(1).max(200),
          ticketId: z.string().trim().min(1).max(200),
          title: z.string().trim().min(1).max(500).optional(),
          kind: ticketKindField,
          sections: ticketSectionsField,
          description: z.string().max(100_000).optional(),
          acceptanceCriteria: z.string().max(100_000).optional(),
          status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
          nodeId: nodeIdField,
        })
        .refine(
          ({ title, kind, sections, description, acceptanceCriteria, status }) =>
            title !== undefined ||
            kind !== undefined ||
            sections !== undefined ||
            description !== undefined ||
            acceptanceCriteria !== undefined ||
            status !== undefined,
          "Provide at least one field to update",
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectId, ticketId, requestId, ...fields }) => {
      const { nodeId, ...updates } = fields;
      if (operator)
        return operatorUpdateTicket(callerOnNode(operator, nodeId), {
          projectId,
          ticketId,
          requestId,
          ...updates,
        });
      coordinatorNodeRefused(nodeId);
      const existing = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!existing) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      const task = await invoke<unknown>("update_kanban_task", { taskId: ticketId, ...updates });
      if (!isRecord(task)) throw new Error("Kanban ticket update returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "add_ticket_comment",
    {
      title: "Add a Kanban ticket comment",
      description: "Append a durable comment to a ticket in one project.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        ticketId: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(20_000),
        nodeId: nodeIdField,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, ticketId, text, nodeId }) => {
      if (operator)
        return operatorAddTicketComment(callerOnNode(operator, nodeId), {
          requestId,
          projectId,
          ticketId,
          text,
        });
      coordinatorNodeRefused(nodeId);
      const existing = asArray(await invoke("get_kanban_tasks", { projectId })).find(
        (candidate) => candidate.id === ticketId,
      );
      if (!existing) throw new Error(`Kanban ticket not found in project: ${ticketId}`);
      const task = await invoke<unknown>("add_kanban_comment", {
        taskId: ticketId,
        text,
        projectId,
        requestId,
      });
      if (!isRecord(task)) throw new Error("Kanban comment creation returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "launch_environment",
    {
      title: "Launch an agent environment",
      description:
        "Create, configure, and start an autonomous coding agent that can execute commands, modify workspace files, and use allowed network access. " +
        `${LAUNCH_DEFAULTS_GUIDANCE} The result's selection reports the model and effort; advisory selections are pending startup. ` +
        (coordinatorScope
          ? `Coordinator launches require baseBranch and baseCommit from get_launch_options. ${COORDINATOR_WORKER_PROMPT_NOTE} `
          : "") +
        "Reuse requestId when retrying.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        environmentType: z.enum(["local", "containerized"]).default("local"),
        name: z.string().trim().min(1).max(200).optional(),
        agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
        modelId: z.string().trim().min(1).max(500).optional().describe(MODEL_ID_DESCRIPTION),
        reasoningId: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(REASONING_ID_DESCRIPTION),
        fastMode: z.boolean().optional().describe(FAST_MODE_DESCRIPTION),
        conversationMode: z.enum(["plan", "build"]).default("build"),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(MAX_PROMPT_LENGTH)
          .describe(COORDINATOR_WORKER_PROMPT_FORMAT_RULE),
        networkAccessMode: z.enum(["restricted", "full"]).optional(),
        baseBranch: (coordinatorScope
          ? z.string().trim().min(1).max(500)
          : z.string().trim().min(1).max(500).optional()
        ).describe(
          coordinatorScope
            ? "Required coordinator base branch; copy coordinatorBase.baseBranch from get_launch_options (checkoutBase.baseBranch only when the user asks to build on the current checkout)."
            : "Optional branch to use as the environment base.",
        ),
        baseCommit: (coordinatorScope
          ? z.string().regex(/^[0-9a-f]{40}$/i)
          : z
              .string()
              .regex(/^[0-9a-f]{40}$/i)
              .optional()
        ).describe(
          coordinatorScope
            ? "Required coordinator base commit; copy coordinatorBase.baseCommit from get_launch_options (checkoutBase.baseCommit only when the user asks to build on the current checkout)."
            : "Optional 40-character commit to use as the environment base.",
        ),
        nodeId: nodeIdField.describe(
          coordinatorScope
            ? "Launch on that node's copy of this project (a nodeId from list_nodes); take baseBranch and baseCommit from get_launch_options with the same nodeId. Omit for this node."
            : "Launch on that machine (a nodeId from list_nodes); projectId is that machine's project, from list_projects with the same nodeId. Omit for this machine.",
        ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      if (operator) {
        const { nodeId, ...launch } = input;
        const node = await operatorNode(operator, nodeId);
        return withNodeTag(await operatorLaunchEnvironment(node.caller, launch), node.tag);
      }
      // Operator credentials launch through environment.launch above.
      if (!coordinatorScope) throw new Error("launch_environment needs a credential");
      if (!input.baseBranch || !input.baseCommit) {
        throw new Error("Coordinator launches require an explicit baseBranch and baseCommit");
      }
      const target = await onNode(input.nodeId);
      if (target && coordinatorScope) {
        // The base, the agent and the model are checked against that node's copy.
        await assertCoordinatorLaunchBaseOnBranch(target.invoke, target.projectId, input);
        const options = await validateSelection(target.invoke, {
          ...input,
          projectId: target.projectId,
        });
        const { nodeId: _nodeId, ...launchInput } = input;
        const launch = await invoke<unknown>("launch_coordinator_node_environment", {
          scope: coordinatorScope,
          requestId: input.requestId,
          nodeId: target.nodeId,
          input: launchEnvironmentCreateInput(launchInput),
        });
        const environment = isRecord(launch) ? launch.environment : null;
        if (!isRecord(environment) || typeof environment.id !== "string") {
          throw new Error("Environment creation returned no environment");
        }
        const selection = await selectionReport(
          target.projectId,
          environment,
          options.models,
          input,
          false,
          target.invoke,
        );
        if (isRecord(selection.selection)) selection.selection.advisory = true;
        const startError =
          isRecord(launch) && typeof launch.startError === "string" ? launch.startError : undefined;
        const delegationOpened =
          !startError && isRecord(launch) && launch.coordinatorDelegationOpened === true;
        return toolResult({
          environmentId: environment.id,
          ...onNodeResult(target),
          tabId: "startup-agent",
          status: startError ? "created" : "accepted",
          ...selection,
          ...(delegationOpened ? asyncDelegationResult() : {}),
          delegationBaseBranch: input.baseBranch,
          delegationBaseCommit: input.baseCommit,
          ...(startError ? { error: startError } : {}),
        });
      }
      // Only a launch from the checkout's own HEAD can miss its uncommitted
      // changes; for that case the result says whether there are any.
      let checkoutHasUncommittedChanges: boolean | undefined;
      if (coordinatorScope) {
        await assertCoordinatorLaunchBaseOnBranch(invoke, coordinatorScope.projectId, input);
        const repository = await invoke<unknown>("get_project_git_status", {
          projectId: coordinatorScope.projectId,
        }).catch(() => null);
        if (
          isRecord(repository) &&
          nonEmptyString(repository.headCommit)?.toLowerCase() === input.baseCommit?.toLowerCase()
        ) {
          checkoutHasUncommittedChanges =
            Number(repository.trackedChanges ?? 0) + Number(repository.untrackedChanges ?? 0) > 0;
        }
      }
      const options = await validateSelection(invoke, input);
      // A new environment's own tier pins no model, so repository and app
      // settings decide, exactly as the startup launch reads them.
      const createInput = launchEnvironmentCreateInput(input);
      const launch = await invoke<unknown>("launch_coordinator_environment", {
        scope: coordinatorScope,
        requestId: input.requestId,
        input: createInput,
      });
      const environment = isRecord(launch) ? launch.environment : null;
      if (!isRecord(environment) || typeof environment.id !== "string") {
        throw new Error("Environment creation returned no environment");
      }
      // Startup publishes the accepted controls durably. Replays report those
      // controls, rather than resolving the current settings again. Until then
      // defaults are advisory because reconciliation has not selected them yet.
      let startup = isRecord(environment.startupAgentSession)
        ? environment.startupAgentSession
        : undefined;
      if (!startup) {
        try {
          const session = await invoke<unknown>("get_native_agent_session", {
            environmentId: environment.id,
            agent: input.agent,
            logicalSessionKey: `env-${environment.id}:startup-agent`,
          });
          if (isRecord(session) && isRecord(session.controls)) {
            startup = {
              agent: session.agent,
              model: session.controls.modelId,
              reasoningEffort: session.controls.reasoningId,
            };
          }
        } catch {
          // A pending startup may not have published a native session yet.
        }
      }
      const selection = startup
        ? {
            selection: {
              agent: startup.agent,
              model: startup.model ?? null,
              reasoning: startup.reasoningEffort ?? null,
              source: input.modelId || input.reasoningId ? "requested" : "default",
            },
          }
        : await selectionReport(
            input.projectId,
            environment,
            options.models,
            {
              ...input,
              modelId:
                typeof environment.initialAgentModel === "string"
                  ? environment.initialAgentModel
                  : input.modelId,
              reasoningId:
                typeof environment.initialReasoningEffort === "string"
                  ? environment.initialReasoningEffort
                  : input.reasoningId,
            },
            false,
          );
      if (!startup && isRecord(selection.selection)) selection.selection.advisory = true;
      const startError =
        isRecord(launch) && typeof launch.startError === "string" ? launch.startError : undefined;
      const delegationOpened =
        coordinatorScope &&
        !startError &&
        isRecord(launch) &&
        launch.coordinatorDelegationOpened === true;
      return toolResult({
        environmentId: environment.id,
        tabId: "startup-agent",
        status: startError ? "created" : "accepted",
        ...selection,
        ...(delegationOpened ? asyncDelegationResult() : {}),
        ...(coordinatorScope
          ? {
              delegationBaseBranch: input.baseBranch,
              delegationBaseCommit: input.baseCommit,
              ...(checkoutHasUncommittedChanges === undefined
                ? {}
                : { liveCheckoutHasUncommittedChanges: checkoutHasUncommittedChanges }),
            }
          : {}),
        ...(startError ? { error: startError } : {}),
      });
    },
  );

  server.registerTool(
    "launch_job",
    {
      title: "Launch a job in an existing environment",
      description:
        "Create a native-agent tab and exactly-once initial turn that can execute commands, modify workspace files, and use configured network access. " +
        `${LAUNCH_DEFAULTS_GUIDANCE} The result's selection reports the model and effort that will run.` +
        (coordinatorScope ? ` ${COORDINATOR_WORKER_PROMPT_NOTE}` : ""),
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        environmentId: z.string().trim().min(1).max(200),
        agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
        modelId: z.string().trim().min(1).max(500).optional().describe(MODEL_ID_DESCRIPTION),
        reasoningId: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(REASONING_ID_DESCRIPTION),
        fastMode: z.boolean().optional().describe(FAST_MODE_DESCRIPTION),
        conversationMode: z.enum(["plan", "build"]).default("build"),
        title: z.string().trim().min(1).max(200).optional(),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(MAX_PROMPT_LENGTH)
          .describe(COORDINATOR_WORKER_PROMPT_FORMAT_RULE),
        nodeId: nodeIdField,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ nodeId, ...input }) => {
      if (operator) {
        const node = await operatorNode(operator, nodeId);
        return withNodeTag(await operatorLaunchJob(node.caller, input), node.tag);
      }
      const { inv, target } = await environmentInvoker(nodeId, input.environmentId);
      const environment = await inv<unknown>("get_environment", {
        environmentId: input.environmentId,
      });
      if (!isRecord(environment) || typeof environment.projectId !== "string") {
        throw new Error(`Environment not found: ${input.environmentId}`);
      }
      const options = await validateSelection(inv, {
        projectId: environment.projectId,
        environmentId: input.environmentId,
        agent: input.agent,
        modelId: input.modelId,
        reasoningId: input.reasoningId,
        fastMode: input.fastMode,
      });
      const selection = await selectionReport(
        environment.projectId,
        environment,
        options.models,
        input,
        true,
        inv,
      );
      const delegation = coordinatorScope
        ? createCoordinatorDelegatedPrompt(
            {
              projectId: coordinatorScope.projectId,
              coordinatorId: coordinatorScope.coordinatorId,
              conversationId: coordinatorScope.conversationId,
              instruction: `${COORDINATOR_JOB_DELEGATION_INSTRUCTION}\n` + workerAsyncContract(),
            },
            input.prompt,
          )
        : null;
      const launchArgs = delegation
        ? withCoordinatorDelegationPresentation(
            { ...input, prompt: delegation.source, activateTab: true },
            {
              kind: COORDINATOR_DELEGATION_PRESENTATION,
              frame: delegation.frame,
            },
          )
        : { ...input, activateTab: true };
      const job = target
        ? await target.call<unknown>("launch_control_job", launchArgs, `job:${input.requestId}`)
        : await invoke<unknown>("launch_control_job", launchArgs);
      if (!isRecord(job)) throw new Error("Job launch returned no result");
      // Only against the tab the job actually landed in. A guessed tab id would
      // open a delegation nothing can ever close, leaving the conversation
      // shown as waiting on a worker that does not exist.
      const delegationOpened =
        coordinatorScope && typeof job.tabId === "string"
          ? target
            ? await tryOpenNodeDelegation(invoke, coordinatorScope, {
                nodeId: target.nodeId,
                environmentId: input.environmentId,
                tabId: job.tabId,
                requestId: input.requestId,
              })
            : await tryOpenCoordinatorDelegation(invoke, coordinatorScope, {
                environmentId: input.environmentId,
                tabId: job.tabId,
                requestId: input.requestId,
              })
          : false;
      return toolResult({
        ...job,
        ...onNodeResult(target),
        ...selection,
        ...(delegationOpened ? asyncDelegationResult() : {}),
      });
    },
  );

  server.registerTool(
    "send_prompt_to_tab",
    {
      title: "Send a prompt to an existing agent tab",
      description:
        "Dispatch an exactly-once prompt to an autonomous coding agent that can execute commands, modify workspace files, and use configured network access." +
        (coordinatorScope ? ` ${COORDINATOR_WORKER_PROMPT_NOTE}` : ""),
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(MAX_PROMPT_LENGTH)
          .describe(COORDINATOR_WORKER_PROMPT_FORMAT_RULE),
        conversationMode: z.enum(["plan", "build"]).optional(),
        nodeId: nodeIdField,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ requestId, environmentId, tabId, prompt, conversationMode, nodeId }) => {
      if (operator) {
        return operatorSendPrompt(callerOnNode(operator, nodeId), {
          requestId,
          environmentId,
          tabId,
          prompt,
          ...(conversationMode ? { conversationMode } : {}),
        });
      }
      const { inv, target } = await environmentInvoker(nodeId, environmentId);
      if (coordinatorScope) {
        await invoke(
          target
            ? "assert_coordinator_node_delegation_available"
            : "assert_coordinator_delegation_available",
          {
            scope: coordinatorScope,
            ...(target ? { nodeId: target.nodeId } : {}),
            environmentId,
            tabId,
            requestId,
          },
        );
      }
      const layout = await inv<unknown>("get_pane_layout", { environmentId });
      const native = nativeTab(layout, tabId);
      if (!native) throw new Error(`Native agent tab not found: ${tabId}`);
      const intent = {
        environmentId,
        agent: native.agent,
        logicalSessionKey: `env-${environmentId}:${tabId}`,
        requestId,
        prompt,
        ...(conversationMode ? { mode: conversationMode } : {}),
      };
      const outcome = target
        ? await target.call<unknown>("dispatch_native_agent_intent", intent, `prompt:${requestId}`)
        : await invoke<unknown>("dispatch_native_agent_intent", intent);
      if (!isRecord(outcome)) throw new Error("Prompt dispatch returned no result");
      const delegationOpened = !coordinatorScope
        ? false
        : target
          ? await tryOpenNodeDelegation(invoke, coordinatorScope, {
              nodeId: target.nodeId,
              environmentId,
              tabId,
              requestId,
            })
          : await tryOpenCoordinatorDelegation(invoke, coordinatorScope, {
              environmentId,
              tabId,
              requestId,
            });
      return toolResult({
        environmentId,
        tabId,
        ...onNodeResult(target),
        ...outcome,
        ...(delegationOpened ? asyncDelegationResult() : {}),
      });
    },
  );

  if (coordinatorScope) {
    registerCoordinatorWorkflowTools(server, {
      invoke,
      coordinatorScope,
      onNode,
      environmentInvoker,
      onNodeResult,
    });
  }

  if (messagingEnabled) {
    server.registerTool(
      "list_mailboxes",
      {
        title: "List agent mailboxes",
        description:
          "List durable agent-message destinations without transcript or filesystem content.",
        inputSchema: z.object({
          q: z.string().trim().max(200).optional(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(200).default(100),
          nodeId: nodeIdField,
        }),
        annotations: readAnnotations(),
      },
      async ({ q, offset, limit, nodeId }) => {
        if (operator)
          return operatorListMailboxes(callerOnNode(operator, nodeId), { q, offset, limit });
        coordinatorNodeRefused(nodeId);
        const page = await invoke<unknown>("list_agent_mailboxes", {
          q,
          offset,
          limit,
          ...(coordinatorScope
            ? { projectId: coordinatorScope.projectId, strictProjectScope: true }
            : {}),
        });
        if (!isRecord(page)) throw new Error("Mailbox directory returned no result");
        return toolResult(page);
      },
    );

    server.registerTool(
      "send_message",
      {
        title: coordinatorScope ? "Send a coordinator message" : "Send an external agent message",
        description: coordinatorScope
          ? 'Durably send an authenticated same-project delegation or reply from this coordinator conversation. toTabId may be omitted: an environment resolves to the tab you are waiting on or its only agent tab. Side agents and the main coordinator reach each other through toEnvironmentId "coordinator" (to the main) or the side agent\'s environment id from list_mailboxes. A busy worker normally receives mail when its turn ends. Set deliverNow only for a course correction the worker must see mid-turn ("add this to your task", "stop, the requirement changed"), not for routine follow-ups or replies: if the worker\'s agent can steer, the message is steered into its running turn. The result\'s deliverNow says what happened: steered, delivered (worker was idle), queued until idle, unsupported, queued (agent cannot take mail mid-turn), verifying (steer handed off, being confirmed; never sent twice), or not queued.'
          : "Durably place text in one Orkestrator tab inbox. External messages are never auto-injected into an agent turn.",
        inputSchema: z.object({
          requestId: z.string().trim().min(1).max(256),
          toEnvironmentId: z.string().trim().min(1).max(200),
          toTabId: coordinatorScope
            ? z.string().trim().min(1).max(200).optional()
            : z.string().trim().min(1).max(200),
          subject: z.string().trim().max(200).optional(),
          body: z
            .string()
            .min(1)
            .refine(
              (value) => Buffer.byteLength(value, "utf8") <= 32 * 1024,
              "body must be at most 32 KiB UTF-8",
            ),
          replyToMessageId: z.string().trim().min(1).max(300).optional(),
          ...(coordinatorScope
            ? {
                deliverNow: z
                  .boolean()
                  .optional()
                  .describe(
                    "Steer this message into the worker's running turn instead of waiting for it to end. For course corrections only. Default false.",
                  ),
              }
            : {}),
          nodeId: nodeIdField.describe(
            coordinatorScope
              ? "Message an agent on that node (a nodeId from list_nodes); toEnvironmentId is that node's environment. A reply to mail from another node goes back to it without nodeId."
              : "Message an agent on that machine (a nodeId from list_nodes); toEnvironmentId is that machine's environment. Omit for this machine.",
          ),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ nodeId, deliverNow, ...input }) => {
        if (operator) {
          return operatorSendMessage(callerOnNode(operator, nodeId), input);
        }
        const target = await onNode(nodeId);
        if (coordinatorScope) {
          let remote: { nodeId: string; toEnvironmentId: string; toTabId?: string } | null = target
            ? {
                nodeId: target.nodeId,
                toEnvironmentId: input.toEnvironmentId,
                ...(input.toTabId ? { toTabId: input.toTabId } : {}),
              }
            : null;
          if (!remote && input.replyToMessageId) {
            // A reply to an agent on another node goes back across the node link.
            const own = await ownConversationMailbox(invoke, coordinatorScope);
            const parent = own
              ? await invoke<unknown>("get_agent_mail_message", {
                  ...own,
                  messageId: input.replyToMessageId,
                }).catch(() => null)
              : null;
            const from = isRecord(parent) && isRecord(parent.from) ? parent.from : null;
            if (
              from?.kind === "node" &&
              typeof from.nodeId === "string" &&
              typeof from.environmentId === "string" &&
              typeof from.tabId === "string"
            ) {
              remote = {
                nodeId: from.nodeId,
                toEnvironmentId: from.environmentId,
                toTabId: from.tabId,
              };
            }
          }
          if (remote) {
            const sent = await invoke<unknown>("send_coordinator_node_mail", {
              scope: coordinatorScope,
              ...remote,
              requestId: input.requestId,
              ...(input.subject ? { subject: input.subject } : {}),
              body: input.body,
              ...(deliverNow === true ? { deliverNow: true } : {}),
            });
            if (!isRecord(sent)) throw new Error("Message send returned no result");
            const {
              coordinatorDelegationOpened,
              deliverNow: remoteOutcome,
              deliverNowNote: remoteNote,
              ...summary
            } = sent;
            return toolResult({
              message: summary,
              // The leaf's outcome when it could steer; an older leaf cannot.
              ...(deliverNow !== true
                ? {}
                : remoteOutcome !== undefined
                  ? { deliverNow: remoteOutcome, deliverNowNote: remoteNote }
                  : coordinatorDeliverNowResult(summary, { unsupported: true })),
              ...(coordinatorDelegationOpened === true ? asyncDelegationResult() : {}),
            });
          }
        }
        const message = await invoke<unknown>("send_coordinator_agent_mail", {
          ...input,
          ...coordinatorScope,
          ...(coordinatorScope && deliverNow === true ? { deliverNow: true } : {}),
        });
        if (!isRecord(message)) throw new Error("Message send returned no result");
        const {
          body: _body,
          coordinatorDelegationOpened: delegationOpened,
          deliverNow: deliverNowOutcome,
          deliverNowNote,
          ...summary
        } = message;
        return toolResult({
          message: summary,
          ...(deliverNowOutcome !== undefined
            ? { deliverNow: deliverNowOutcome, deliverNowNote }
            : {}),
          ...(coordinatorScope && delegationOpened === true ? asyncDelegationResult() : {}),
        });
      },
    );

    if (coordinatorScope)
      server.registerTool(
        "read_messages",
        {
          title: "Read mailbox messages",
          description:
            "Read a bounded mailbox page. Coordinator credentials may only read their own conversation mailbox.",
          inputSchema: z.object({
            environmentId: z.string().trim().min(1).max(200),
            tabId: z.string().trim().min(1).max(200),
            unreadOnly: z.boolean().default(false),
            offset: z.number().int().min(0).default(0),
            limit: z.number().int().min(1).max(200).default(100),
          }),
          annotations: readAnnotations(),
        },
        async (input) => {
          if (coordinatorScope) {
            const ownEnvironmentId = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
            const workspace = await invoke<unknown>("get_project_coordinator", {
              projectId: coordinatorScope.projectId,
            });
            const conversations =
              isRecord(workspace) &&
              isRecord(workspace.workspace) &&
              Array.isArray(workspace.workspace.conversations)
                ? workspace.workspace.conversations
                : [];
            const own = conversations.find(
              (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
            );
            if (
              input.environmentId !== ownEnvironmentId ||
              !isRecord(own) ||
              input.tabId !== own.tabId
            ) {
              throw new Error("Coordinator credential may only read its own mailbox");
            }
          }
          const page = await invoke<unknown>("get_agent_mail_mailbox", input);
          if (!isRecord(page)) throw new Error("Mailbox returned no result");
          const guidance = pollGuard?.(
            `read_messages:${JSON.stringify(input)}`,
            mailboxFingerprint(page),
          );
          return toolResult(guidance ? { ...page, ...guidance } : page);
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "get_message",
        {
          title: "Get a mailbox message",
          description: "Read one message body from this coordinator conversation's own mailbox.",
          inputSchema: z.object({
            environmentId: z.string().trim().min(1).max(200),
            tabId: z.string().trim().min(1).max(200),
            messageId: z.string().trim().min(1).max(300),
          }),
          annotations: readAnnotations(),
        },
        async (input) => {
          const ownEnvironmentId = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
          const workspace = await invoke<unknown>("get_project_coordinator", {
            projectId: coordinatorScope.projectId,
          });
          const conversations =
            isRecord(workspace) &&
            isRecord(workspace.workspace) &&
            Array.isArray(workspace.workspace.conversations)
              ? workspace.workspace.conversations
              : [];
          const own = conversations.find(
            (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
          );
          if (
            input.environmentId !== ownEnvironmentId ||
            !isRecord(own) ||
            input.tabId !== own.tabId
          ) {
            throw new Error("Coordinator credential may only read its own mailbox");
          }
          const message = await invoke<unknown>("get_agent_mail_message", input);
          if (!isRecord(message)) throw new Error("Mailbox message was not found");
          return toolResult({ message });
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "get_message_status",
        {
          title: "Get message delivery status",
          description:
            "Inspect durable stored, pending, injected, acknowledged, and seen state without returning the message body.",
          inputSchema: z.object({ messageId: z.string().trim().min(1).max(300) }),
          annotations: readAnnotations(),
        },
        async ({ messageId }) => {
          const status = await invoke<unknown>("get_agent_mail_status", { messageId });
          if (!isRecord(status)) throw new Error("Message status was not found");
          const ownRuntime = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
          const from = isRecord(status.from) ? status.from : null;
          const allowedBySender = from?.projectId === coordinatorScope.projectId;
          const destination =
            typeof status.toEnvironmentId === "string" ? status.toEnvironmentId : "";
          if (!allowedBySender && destination !== ownRuntime) {
            const environment = await invoke<unknown>("get_environment", {
              environmentId: destination,
            });
            if (!isRecord(environment) || environment.projectId !== coordinatorScope.projectId) {
              throw new Error("Coordinator credential cannot inspect that message");
            }
          }
          // Guarded only after authorization, so a refusal can never answer for
          // a message this credential was not allowed to look at.
          const statusRefusal = pollGuard?.(
            `get_message_status:${messageId}`,
            JSON.stringify({
              placement: status.placement,
              injectedAt: status.injectedAt,
              ackedAt: status.ackedAt,
              revision: status.revision,
            }),
          );
          return toolResult({ message: status, ...statusRefusal });
        },
      );

    if (coordinatorScope)
      server.registerTool(
        "ack_message",
        {
          title: "Acknowledge a mailbox message",
          description: "Mark a message handled without claiming that its task succeeded.",
          inputSchema: z.object({
            environmentId: z.string().trim().min(1).max(200),
            tabId: z.string().trim().min(1).max(200),
            messageId: z.string().trim().min(1).max(300),
          }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async (input) => {
          if (coordinatorScope) {
            const ownEnvironmentId = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
            const workspace = await invoke<unknown>("get_project_coordinator", {
              projectId: coordinatorScope.projectId,
            });
            const conversations =
              isRecord(workspace) &&
              isRecord(workspace.workspace) &&
              Array.isArray(workspace.workspace.conversations)
                ? workspace.workspace.conversations
                : [];
            const own = conversations.find(
              (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
            );
            if (
              input.environmentId !== ownEnvironmentId ||
              !isRecord(own) ||
              input.tabId !== own.tabId
            ) {
              throw new Error("Coordinator credential may only acknowledge its own mailbox");
            }
          }
          const result = await invoke<unknown>("ack_agent_mail", input);
          if (!isRecord(result)) throw new Error("Message acknowledgement returned no result");
          const { body: _body, ...summary } = result;
          return toolResult({ message: summary });
        },
      );
  }

  if (operator) {
    // Tier 0 and 1 for every operator profile; tier 2 direct tools for all
    // but voice, whose clients load a fixed list at session start.
    registerOperatorWorkflowTools(server, operator);
    registerVoiceTools(mcp, operator);
    registerGatewayTools(mcp, operator);
    if (operator.profile !== "voice") registerDirectTools(mcp, operator);
  }

  return mcp;
}
