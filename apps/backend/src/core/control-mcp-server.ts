import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { resolveDefaultAgent } from "@orkestrator/protocol/agent-settings";
import {
  COORDINATOR_ASYNC_CONTRACT,
  COORDINATOR_LAUNCH_DEFAULTS_RULE,
  COORDINATOR_MAIL_ADDRESS,
} from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  COORDINATOR_JOB_DELEGATION_INSTRUCTION,
  createCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { canonicalJson } from "@orkestrator/protocol/public-api";
import { z } from "zod";
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
import {
  AUTO_FIX_FIELD_DESCRIPTION,
  AUTO_PR_FIELD_DESCRIPTION,
  MULTI_REVIEW_AUTOMATION_DESCRIPTION,
  registerControlReviewActions,
  reviewSelection,
  workflowStatusWakeResult,
} from "./control-mcp-review-actions.js";
import { normalizedWorkflow, workflowSummary } from "./control-workflow-summary.js";
import {
  createNodeTargets,
  NODE_TOOL_CAPABILITIES,
  registerNodeTools,
  type NodeTarget,
} from "./control-mcp-nodes.js";
import { NODE_FILE_TOOL_CAPABILITIES, registerNodeFileTools } from "./control-mcp-node-files.js";
import { withCoordinatorDelegationPresentation } from "./coordinator-delegation-authority.js";

const CONTROL_MCP_PATH = "/mcp";
const CONTROL_MCP_DESCRIPTOR = "control-mcp.json";
export const DEFAULT_CONTROL_MCP_PORT = 34_122;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PROMPT_LENGTH = 100_000;
/** The field every environment and workflow tool takes to act on another node. */
const nodeIdField = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .describe(
    "Coordinators only: a nodeId from list_nodes, to act on that node's copy of this project. Omit for this node.",
  );
const MAX_TERMINAL_OUTPUT_CHARS = 256 * 1024;
const COORDINATOR_CREDENTIAL_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_COORDINATOR_CREDENTIALS = 512;
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

const COORDINATOR_TOOL_CAPABILITY = new Map<string, string>([
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
  ["list_mailboxes", "mail"],
  ["send_message", "mail"],
  ["read_messages", "mail"],
  ["get_message", "mail"],
  ["get_message_status", "mail"],
  ["ack_message", "mail"],
  ...NODE_TOOL_CAPABILITIES,
  ...NODE_FILE_TOOL_CAPABILITIES,
]);
const COORDINATOR_CAPABILITIES = new Set(COORDINATOR_TOOL_CAPABILITY.values());

export type ControlMcpInfo = {
  url: string;
  descriptorFile: string;
};

export type ControlMcpSettings = {
  enabled: boolean;
  running: boolean;
  url: string;
  token: string;
  error: string | null;
};

export type ControlMcpServerOptions = {
  bindAddress?: string;
  port?: number;
};

export type CoordinatorControlScope = {
  role: "coordinator";
  projectId: string;
  coordinatorId: string;
  conversationId: string;
  mailboxIncarnationId: string;
  capabilities: readonly string[];
};

export type CoordinatorControlConnection = {
  url: string;
  token: string;
};

export type { ControlMcpInvoker } from "./control-shared-actions.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

function configuredControlMcpPort(): number {
  const configured = process.env.ORKESTRATOR_CONTROL_MCP_PORT?.trim();
  if (!configured) return DEFAULT_CONTROL_MCP_PORT;
  if (!/^\d+$/.test(configured)) throw new Error("ORKESTRATOR_CONTROL_MCP_PORT is invalid");
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ORKESTRATOR_CONTROL_MCP_PORT is invalid");
  }
  return port;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

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

/**
 * A coordinator launch must name a real branch that contains the commit.
 *
 * That admits the base branch's tip and the checkout's own HEAD alike, and
 * rejects a commit copied from somewhere else or a branch that has moved away
 * from it, instead of silently starting the worker somewhere unexpected.
 */
async function assertCoordinatorLaunchBaseOnBranch(
  invoke: ControlMcpInvoker,
  projectId: string,
  input: { baseBranch?: string; baseCommit?: string },
): Promise<void> {
  if (!input.baseBranch || !input.baseCommit) {
    throw new Error("Coordinator launches require an explicit baseBranch and baseCommit");
  }
  let verified: unknown;
  try {
    verified = await invoke<unknown>("verify_project_launch_base", {
      projectId,
      branch: input.baseBranch,
      commit: input.baseCommit,
    });
  } catch (error) {
    throw new Error(
      `Coordinator launch base could not be verified: ${
        error instanceof Error ? error.message : "git verification failed"
      }. Refresh get_launch_options and retry.`,
    );
  }
  if (!isRecord(verified) || verified.contained !== true) {
    const reason = isRecord(verified) ? nonEmptyString(verified.reason) : null;
    throw new Error(
      `Coordinator launch base ${input.baseBranch} @ ${input.baseCommit} is not valid${
        reason ? ` (${reason})` : ""
      }. Refresh get_launch_options and retry.`,
    );
  }
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
  return match?.[1] ?? null;
}

function tokenMatches(candidate: string | null, expected: string): boolean {
  if (!candidate || !expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.byteLength;
    if (bytes > MAX_REQUEST_BYTES) {
      request.resume();
      throw new Error("Control MCP request body is too large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new Error("Control MCP request body must be valid JSON");
  }
}

function jsonResponse(response: ServerResponse, status: number, body: JsonRecord): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function toolResult(value: JsonRecord, summary: JsonRecord = value) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(summary) }],
    structuredContent: value,
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
 * One build step's harness and model. Unlike a Multi Review row the model is
 * optional: naming only an agent runs that agent's own saved model.
 */
const buildStepSchema = z
  .object({
    agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
    model: z.string().trim().min(1).max(500).optional(),
    reasoningEffort: z.string().trim().min(1).max(100).optional(),
    fastMode: z.boolean().optional(),
  })
  .strict();

/** What a started build runs, and which choices the caller made. */
function buildPipelineSelection(
  record: JsonRecord,
  input: {
    agentType?: unknown;
    steps?: Record<string, unknown>;
    reviewers?: unknown;
    reviewPreparation?: unknown;
  },
): JsonRecord {
  const source = (requested: boolean) => (requested ? "requested" : "default");
  const steps = isRecord(record.steps) ? record.steps : {};
  return {
    agentType: record.agentType ?? null,
    steps,
    reviewers: Array.isArray(record.reviewers) ? record.reviewers : [],
    reviewPreparation: record.reviewPreparation ?? null,
    source: {
      agentType: source(input.agentType !== undefined || input.steps?.build !== undefined),
      steps: Object.fromEntries(
        Object.keys(steps).map((key) => [key, source(input.steps?.[key] !== undefined)]),
      ),
      reviewers: source(input.reviewers !== undefined),
      reviewPreparation: source(input.reviewPreparation !== undefined),
    },
  };
}

const agentSelectionSchema = z.object({
  agent: z.enum(["claude", "codex", "cursor", "grok", "opencode", "pi"]),
  model: z.string().trim().min(1).max(500),
  reasoningEffort: z.string().trim().min(1).max(100).optional(),
});

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
    | JsonRecord
    | undefined;
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

/** The worker's half of the contract: one report, at the end, then stop. */
function workerAsyncContract(): string {
  return (
    `The coordinator is idle while you work and is woken once, when your turn ends. Send exactly one report — use reply_message for the message that assigned this work, or send_message to toEnvironmentId "${COORDINATOR_MAIL_ADDRESS}" (no toTabId needed) — and then end your turn. ` +
    `Do not send progress updates: any message you send before your turn ends is held and delivered together with your final report.`
  );
}

function readAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
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
type CoordinatorPollGuard = (key: string, fingerprint: string) => JsonRecord | null;

/**
 * How many identical answers a conversation may collect before it is told to
 * stop asking, and how long that judgement stands.
 */
const COORDINATOR_POLL_BUDGET = 3;
const COORDINATOR_POLL_WINDOW_MS = 120_000;
const MAX_COORDINATOR_POLL_ENTRIES = 256;

async function createControlMcp(
  invoke: ControlMcpInvoker,
  coordinatorScope?: CoordinatorControlScope,
  pollGuard?: CoordinatorPollGuard,
): Promise<McpServer> {
  const config = await invoke<unknown>("get_config");
  const messagingEnabled =
    isRecord(config) &&
    isRecord(config.global) &&
    isRecord(config.global.agentMessaging) &&
    config.global.agentMessaging.enabled === true;
  const server = new McpServer(
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
        (coordinatorScope ? ` ${COORDINATOR_ASYNC_CONTRACT}` : ""),
    },
  );

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
  /** The invoker for one environment's node, after checking it is this project's worker there. */
  const environmentInvoker = async (
    nodeId: string | undefined,
    environmentId: string,
  ): Promise<{ inv: ControlMcpInvoker; target: NodeTarget | null }> => {
    const target = await onNode(nodeId);
    if (!target) return { inv: invoke, target: null };
    await target.environment(environmentId);
    return { inv: target.invoke, target };
  };
  const onNodeResult = (target: NodeTarget | null): JsonRecord =>
    target ? { nodeId: target.nodeId, node: target.nodeName } : {};

  server.registerTool(
    "list_projects",
    {
      title: "List Orkestrator projects",
      description: "List safe summaries of the projects configured in Orkestrator.",
      inputSchema: z.object({}),
      annotations: readAnnotations(),
    },
    async () => {
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
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, status, nodeId }) => {
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
      return toolResult({
        environments,
        total: environments.length,
        ...(otherNodes.length > 0 ? { otherNodes } : {}),
      });
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
      const { inv, target } = await environmentInvoker(nodeId, environmentId);
      const layout = await inv<unknown>("get_pane_layout", { environmentId });
      const tabs = paneTabs(layout);
      return toolResult({ environmentId, ...onNodeResult(target), tabs, total: tabs.length });
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
      description: "Read native-agent state for a tab without returning its transcript.",
      inputSchema: z.object({
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        nodeId: nodeIdField,
      }),
      annotations: readAnnotations(),
    },
    async ({ environmentId, tabId, nodeId }) => {
      const { inv, target } = await environmentInvoker(nodeId, environmentId);
      const where = { environmentId, tabId, ...onNodeResult(target) };
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
      const { inv, target } = await environmentInvoker(nodeId, environmentId);
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
            ...onNodeResult(target),
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
          ...onNodeResult(target),
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
        ...onNodeResult(target),
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
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, status }) => {
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
      }),
      annotations: readAnnotations(),
    },
    async ({ projectId, ticketId }) => {
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
      description: "Create a ticket in one configured project.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        projectId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(500),
        description: z.string().max(100_000).default(""),
        acceptanceCriteria: z.string().max(100_000).default(""),
        status: z.enum(["backlog", "in-progress", "review", "done"]).default("backlog"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, title, description, acceptanceCriteria, status }) => {
      const project = await invoke<unknown>("get_project", { projectId });
      if (!isRecord(project)) throw new Error(`Project not found: ${projectId}`);
      const task = await invoke<unknown>("add_kanban_task", {
        projectId,
        title,
        description,
        acceptanceCriteria,
        status,
        requestId,
      });
      if (!isRecord(task)) throw new Error("Kanban ticket creation returned no ticket");
      return toolResult({ ticket: ticketDetail(task) });
    },
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update a Kanban ticket",
      description: "Update specified editable fields of a ticket in one project.",
      inputSchema: z
        .object({
          projectId: z.string().trim().min(1).max(200),
          ticketId: z.string().trim().min(1).max(200),
          title: z.string().trim().min(1).max(500).optional(),
          description: z.string().max(100_000).optional(),
          acceptanceCriteria: z.string().max(100_000).optional(),
          status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
        })
        .refine(
          ({ title, description, acceptanceCriteria, status }) =>
            title !== undefined ||
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
    async ({ projectId, ticketId, ...updates }) => {
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
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ requestId, projectId, ticketId, text }) => {
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
          ? "Coordinator launches require baseBranch and baseCommit from get_launch_options. "
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
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
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
          "Coordinators only: launch on that node's copy of this project (a nodeId from list_nodes); take baseBranch and baseCommit from get_launch_options with the same nodeId. Omit for this node.",
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
      if (coordinatorScope && (!input.baseBranch || !input.baseCommit)) {
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
      const launch = coordinatorScope
        ? await invoke<unknown>("launch_coordinator_environment", {
            scope: coordinatorScope,
            requestId: input.requestId,
            input: createInput,
          })
        : {
            environment: await invoke<unknown>("create_environment", {
              ...createInput,
              controlRequestId: input.requestId,
              // Reusing a requestId with a different launch is a caller
              // mistake; the fingerprint turns it into a conflict instead of
              // silently returning the first environment.
              controlRequestFingerprint: createHash("sha256")
                .update(canonicalJson(createInput))
                .digest("hex"),
            }),
          };
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
      let startError =
        isRecord(launch) && typeof launch.startError === "string" ? launch.startError : undefined;
      if (
        !coordinatorScope &&
        environment.status !== "running" &&
        environment.status !== "creating"
      ) {
        try {
          await invoke("start_environment_background", { environmentId: environment.id });
        } catch (error) {
          startError = error instanceof Error ? error.message : "Environment start failed";
        }
      }
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
        `${LAUNCH_DEFAULTS_GUIDANCE} The result's selection reports the model and effort that will run.`,
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
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
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
        "Dispatch an exactly-once prompt to an autonomous coding agent that can execute commands, modify workspace files, and use configured network access.",
      inputSchema: z.object({
        requestId: z.string().trim().min(1).max(256),
        environmentId: z.string().trim().min(1).max(200),
        tabId: z.string().trim().min(1).max(200),
        prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
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
    registerControlReviewActions(server, invoke, coordinatorScope);
    const nodeToolScope = {
      projectId: coordinatorScope.projectId,
      coordinatorId: coordinatorScope.coordinatorId,
      conversationId: coordinatorScope.conversationId,
    };
    registerNodeTools(server, invoke, nodeToolScope);
    registerNodeFileTools(server, invoke, nodeToolScope);
    server.registerTool(
      "get_repository_context",
      {
        title: "Get project repository context",
        description:
          "Read current branch, immutable HEAD commit, dirty state, and upstream freshness. This tool cannot mutate Git. With nodeId, of that node's copy of the project.",
        inputSchema: z.object({ nodeId: nodeIdField }),
        annotations: readAnnotations(),
      },
      async ({ nodeId }) => {
        const target = await onNode(nodeId);
        const status = target
          ? await target.call<unknown>("get_project_git_status", { projectId: target.projectId })
          : await invoke<unknown>("get_project_git_status", {
              projectId: coordinatorScope.projectId,
            });
        if (!isRecord(status)) throw new Error("Repository status returned no result");
        return toolResult({ repository: status, ...onNodeResult(target) });
      },
    );
    server.registerTool(
      "list_workflows",
      {
        title: "List coordinator workflows",
        description:
          "List durable worker, build-pipeline, and multi-review associations for this project with bounded authoritative summaries.",
        inputSchema: z.object({}),
        annotations: readAnnotations(),
      },
      async () => {
        const snapshot = await invoke<unknown>("get_project_coordinator", {
          projectId: coordinatorScope.projectId,
        });
        const associations = isRecord(snapshot) ? asArray(snapshot.workflows).slice(-200) : [];
        // One resolution per node, shared by that node's workflows.
        const invokers = new Map<string, Promise<ControlMcpInvoker | null>>();
        const invokerOn = (nodeId: string | undefined): Promise<ControlMcpInvoker | null> => {
          if (!nodeId) return Promise.resolve(invoke);
          let resolved = invokers.get(nodeId);
          if (!resolved) {
            resolved = onNode(nodeId)
              .then((target) => (target ? target.invoke : invoke))
              .catch(() => null);
            invokers.set(nodeId, resolved);
          }
          return resolved;
        };
        const workflows = await Promise.all(
          associations.map(async (association) => {
            const kind = association.kind;
            const resourceId =
              typeof association.resourceId === "string" ? association.resourceId : "";
            const nodeId = typeof association.nodeId === "string" ? association.nodeId : undefined;
            let resource: JsonRecord | null = null;
            try {
              const inv = await invokerOn(nodeId);
              if (association.pending === true || resourceId.startsWith("pending:")) {
                resource = { id: resourceId, status: "pending" };
              } else if (!inv) {
                resource = { id: resourceId, status: "unavailable" };
              } else if (kind === "environment") {
                const environment = await inv<unknown>("get_environment", {
                  environmentId: resourceId,
                });
                resource = isRecord(environment) ? environmentSummary(environment) : null;
              } else if (kind === "build-pipeline") {
                const workflow = await inv<unknown>("get_build_pipeline", {
                  pipelineId: resourceId,
                });
                const record = normalizedWorkflow(workflow);
                resource = record ? workflowSummary(record) : null;
              } else if (kind === "multi-review") {
                const workflow = await inv<unknown>("get_multi_review_workflow", {
                  workflowId: resourceId,
                });
                const record = normalizedWorkflow(workflow);
                resource = record ? workflowSummary(record) : null;
              }
            } catch {
              resource = { id: resourceId, status: "unavailable" };
            }
            return {
              id: association.id,
              kind,
              resourceId,
              ...(nodeId ? { nodeId } : {}),
              requestId: association.requestId,
              baseBranch: association.baseBranch,
              baseCommit: association.baseCommit,
              createdAt: association.createdAt,
              resource,
            };
          }),
        );
        return toolResult({ workflows, total: workflows.length });
      },
    );
    server.registerTool(
      "adopt_workflow",
      {
        title: "Adopt a coordinator workflow",
        description:
          "Associate an orphaned or closed-tab workflow with this conversation so terminal notifications can be delivered here.",
        inputSchema: z.object({ associationId: z.string().trim().min(1).max(200) }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ associationId }) => {
        const association = await invoke<unknown>("adopt_coordinator_workflow", {
          ...coordinatorScope,
          associationId,
        });
        if (!isRecord(association)) throw new Error("Workflow adoption returned no result");
        return toolResult({ association });
      },
    );
    const scopedWorkflow = async (
      kind: "build" | "review",
      workflowId: string,
      target: NodeTarget | null = null,
    ) => {
      const inv = target ? target.invoke : invoke;
      const raw = await inv<unknown>(
        kind === "build" ? "get_build_pipeline" : "get_multi_review_workflow",
        kind === "build" ? { pipelineId: workflowId } : { workflowId },
      );
      const record = normalizedWorkflow(raw);
      if (
        !record ||
        record.projectId !== (target ? target.projectId : coordinatorScope.projectId)
      ) {
        throw new Error(
          `${kind === "build" ? "Build pipeline" : "Multi-review"} not found in this project`,
        );
      }
      return record;
    };

    for (const [tool, command, title] of [
      ["start_environment", "start_environment_background", "Start a worker environment"],
      ["stop_environment", "stop_environment", "Stop a worker environment"],
    ] as const) {
      server.registerTool(
        tool,
        {
          title,
          description: `${title} that belongs to this coordinator's project.`,
          inputSchema: z.object({
            environmentId: z.string().trim().min(1).max(200),
            nodeId: nodeIdField,
          }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: tool === "stop_environment",
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ environmentId, nodeId }) => {
          const { inv, target } = await environmentInvoker(nodeId, environmentId);
          await inv("get_environment", { environmentId });
          await inv(command, { environmentId });
          return toolResult({ environmentId, ...onNodeResult(target), accepted: true });
        },
      );
    }

    server.registerTool(
      "start_build_pipeline",
      {
        title: "Start a structured build pipeline",
        description:
          "Start Orkestrator's durable build/review/verify/PR workflow in a disposable worker environment. Omit agentType, steps, reviewers and reviewPreparation to run the Build button's saved defaults: the same build agent, Multi Review reviewers, preparation/consolidation, fix, verify, PR and conflict-resolution models. Override one only when the user has asked for a specific agent, model, effort or reviewer set; any field you leave out keeps its saved default.",
        inputSchema: z.object({
          requestId: z.string().trim().min(1).max(256),
          taskId: z.string().trim().min(1).max(200),
          environmentType: z.enum(["local", "containerized"]).default("local"),
          baseBranch: z.string().trim().min(1).max(500),
          baseCommit: z.string().regex(/^[0-9a-f]{40}$/i),
          agentType: z
            .enum(["claude", "codex", "cursor", "grok", "opencode", "pi"])
            .optional()
            .describe(
              "Optional. Omit to use the user's saved build agent. Set only when the user asks for a specific agent.",
            ),
          steps: z
            .object({
              build: buildStepSchema.optional(),
              review: buildStepSchema.optional(),
              address: buildStepSchema.optional(),
              verify: buildStepSchema.optional(),
              pr: buildStepSchema.optional(),
              "resolve-conflicts": buildStepSchema.optional(),
            })
            .strict()
            .optional()
            .describe(
              "Optional per-step overrides. Each step you name replaces only that step's saved default; omitted steps keep theirs. Set only when the user asks for a specific agent, model or effort for a step.",
            ),
          reviewers: z
            .array(buildStepSchema)
            .min(1)
            .max(32)
            .optional()
            .describe(
              "Optional. Replaces the saved Multi Review reviewer rows for the review step. Omit to use them. Set only when the user asks for specific reviewers.",
            ),
          reviewPreparation: buildStepSchema
            .optional()
            .describe(
              "Optional. Replaces the saved preparation/consolidation model for a multi-reviewer review step. Omit to use it. Set only when the user asks for one.",
            ),
          taskTitle: z.string().trim().min(1).max(500),
          taskSnapshot: z.object({
            title: z.string().max(500),
            description: z.string().max(100_000),
            acceptanceCriteria: z.string().max(100_000),
            comments: z
              .array(z.object({ text: z.string().max(20_000) }))
              .max(200)
              .default([]),
            images: z
              .array(z.object({ filename: z.string().max(500), data: z.string().max(5_000_000) }))
              .max(20)
              .default([]),
          }),
          existingEnvironmentId: z.string().trim().min(1).max(200).optional(),
          maxIterations: z.number().int().min(1).max(20).optional(),
          nodeId: nodeIdField.describe(
            "Optional: run the build on that node's copy of this project (a nodeId from list_nodes); take baseBranch and baseCommit from get_launch_options with the same nodeId. Omit for this node.",
          ),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ requestId, baseBranch, baseCommit, nodeId, ...input }) => {
        const target = await onNode(nodeId);
        await assertCoordinatorLaunchBaseOnBranch(
          target ? target.invoke : invoke,
          target ? target.projectId : coordinatorScope.projectId,
          { baseBranch, baseCommit },
        );
        if (input.existingEnvironmentId && !target) {
          await invoke("get_environment", { environmentId: input.existingEnvironmentId });
        }
        const scoped = {
          ...input,
          projectId: coordinatorScope.projectId,
          delegationBaseBranch: baseBranch,
          delegationBaseCommit: baseCommit,
        };
        const workflow = target
          ? await invoke<unknown>("start_coordinator_node_build_pipeline", {
              scope: coordinatorScope,
              requestId,
              nodeId: target.nodeId,
              input: scoped,
            })
          : await invoke<unknown>("start_coordinator_build_pipeline", {
              scope: coordinatorScope,
              requestId,
              input: scoped,
            });
        const record = normalizedWorkflow(workflow);
        if (!record) throw new Error("Build pipeline returned no result");
        return toolResult({
          workflow: workflowSummary(record),
          ...onNodeResult(target),
          ...(await workflowStatusWakeResult(invoke)),

          selection: buildPipelineSelection(record, input),
        });
      },
    );

    server.registerTool(
      "get_build_pipeline",
      {
        title: "Get a build pipeline",
        description: "Read authoritative state for a coordinator-associated build pipeline.",
        inputSchema: z.object({
          pipelineId: z.string().trim().min(1).max(200),
          nodeId: nodeIdField,
        }),
        annotations: readAnnotations(),
      },
      async ({ pipelineId, nodeId }) => {
        const target = await onNode(nodeId);
        return toolResult({
          workflow: workflowSummary(await scopedWorkflow("build", pipelineId, target)),
          ...onNodeResult(target),
        });
      },
    );

    for (const [tool, command, title] of [
      ["pause_build_pipeline", "pause_build_pipeline", "Pause a build pipeline"],
      ["resume_build_pipeline", "resume_build_pipeline", "Resume a build pipeline"],
      ["cancel_build_pipeline", "cancel_build_pipeline", "Cancel a build pipeline"],
    ] as const) {
      server.registerTool(
        tool,
        {
          title,
          description: `${title} in this coordinator's project.`,
          inputSchema: z.object({
            pipelineId: z.string().trim().min(1).max(200),
            nodeId: nodeIdField,
          }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: tool === "cancel_build_pipeline",
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ pipelineId, nodeId }) => {
          const target = await onNode(nodeId);
          await scopedWorkflow("build", pipelineId, target);
          const workflow = target
            ? await target.call<unknown>(command, { pipelineId }, `${command}:${pipelineId}`)
            : await invoke<unknown>(command, { pipelineId });
          const record = normalizedWorkflow(workflow);
          return toolResult({
            workflow: record ? workflowSummary(record) : { id: pipelineId },
            ...onNodeResult(target),
          });
        },
      );
    }

    server.registerTool(
      "start_multi_review",
      {
        title: "Start a multi-review",
        description:
          "Low-level build-gated recovery primitive: starts backend work only and does NOT create/select a root tab or reproduce the UI button. Prefer launch_multi_review for a complete environment-level Multi Review action. Omit reviewers, reviewModel and fixModel to use the user's saved Multi Review defaults; set them only when the user asks for specific models. " +
          MULTI_REVIEW_AUTOMATION_DESCRIPTION +
          " The result's selection reports the rows and auto-actions that will run and which were requested.",
        inputSchema: z.object({
          requestId: z.string().trim().min(1).max(256),
          buildPipelineId: z.string().trim().min(1).max(200),
          environmentId: z.string().trim().min(1).max(200),
          targetBranch: z.string().trim().min(1).max(500),
          reviewInstruction: z.string().max(100_000).optional(),
          reviewers: z
            .array(agentSelectionSchema)
            .min(1)
            .max(32)
            .optional()
            .describe(
              "Optional. Omit to use the user's saved reviewer rows. Set only when the user asks for specific reviewers.",
            ),
          reviewModel: agentSelectionSchema
            .optional()
            .describe(
              "Optional. Omit to use the user's saved preparation/consolidation model. Set only when the user asks for one.",
            ),
          fixModel: agentSelectionSchema
            .optional()
            .describe(
              "Optional. Omit to use the user's saved fix model. Set only when the user asks for one.",
            ),
          autoFix: z.boolean().optional().describe(AUTO_FIX_FIELD_DESCRIPTION),
          autoPr: z.boolean().optional().describe(AUTO_PR_FIELD_DESCRIPTION),
          nodeId: nodeIdField,
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ requestId, buildPipelineId, nodeId, ...input }) => {
        const target = await onNode(nodeId);
        if (!target) await invoke("get_environment", { environmentId: input.environmentId });
        const workflow = target
          ? await invoke<unknown>("start_coordinator_node_multi_review", {
              scope: coordinatorScope,
              requestId,
              nodeId: target.nodeId,
              buildPipelineId,
              input: { ...input, projectId: coordinatorScope.projectId },
            })
          : await invoke<unknown>("start_coordinator_multi_review", {
              scope: coordinatorScope,
              requestId,
              buildPipelineId,
              input: { ...input, projectId: coordinatorScope.projectId },
            });
        const record = normalizedWorkflow(workflow);
        if (!record) throw new Error("Multi-review returned no result");
        return toolResult({
          workflow: workflowSummary(record),
          ...onNodeResult(target),
          selection: reviewSelection(record, input),
          ...(await workflowStatusWakeResult(invoke)),
        });
      },
    );

    server.registerTool(
      "get_multi_review",
      {
        title: "Get a multi-review",
        description: "Read authoritative state for a multi-review in this project.",
        inputSchema: z.object({
          workflowId: z.string().trim().min(1).max(200),
          nodeId: nodeIdField,
        }),
        annotations: readAnnotations(),
      },
      async ({ workflowId, nodeId }) => {
        const target = await onNode(nodeId);
        return toolResult({
          workflow: workflowSummary(await scopedWorkflow("review", workflowId, target)),
          ...onNodeResult(target),
        });
      },
    );

    for (const [tool, command, title] of [
      ["cancel_multi_review", "cancel_multi_review", "Cancel a multi-review"],
    ] as const) {
      server.registerTool(
        tool,
        {
          title,
          description: `${title} in the associated worker environment.`,
          inputSchema: z.object({
            workflowId: z.string().trim().min(1).max(200),
            nodeId: nodeIdField,
          }),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        async ({ workflowId, nodeId }) => {
          const target = await onNode(nodeId);
          await scopedWorkflow("review", workflowId, target);
          const workflow = target
            ? await target.call<unknown>(command, { workflowId }, `${command}:${workflowId}`)
            : await invoke<unknown>(command, { workflowId });
          const record = normalizedWorkflow(workflow);
          return toolResult({
            workflow: record ? workflowSummary(record) : { id: workflowId },
            ...onNodeResult(target),
          });
        },
      );
    }
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
        }),
        annotations: readAnnotations(),
      },
      async ({ q, offset, limit }) => {
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
          ? 'Durably send an authenticated same-project delegation or reply from this coordinator conversation. toTabId may be omitted: an environment resolves to the tab you are waiting on or its only agent tab. Side agents and the main coordinator reach each other through toEnvironmentId "coordinator" (to the main) or the side agent\'s environment id from list_mailboxes.'
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
          nodeId: nodeIdField.describe(
            "Coordinators only: message an agent on that node (a nodeId from list_nodes); toEnvironmentId is that node's environment. A reply to mail from another node goes back to it without nodeId.",
          ),
        }),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async ({ nodeId, ...input }) => {
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
            });
            if (!isRecord(sent)) throw new Error("Message send returned no result");
            const { coordinatorDelegationOpened, ...summary } = sent;
            return toolResult({
              message: summary,
              ...(coordinatorDelegationOpened === true ? asyncDelegationResult() : {}),
            });
          }
        }
        const message = await invoke<unknown>(
          coordinatorScope ? "send_coordinator_agent_mail" : "send_external_agent_mail",
          coordinatorScope ? { ...input, ...coordinatorScope } : input,
        );
        if (!isRecord(message)) throw new Error("Message send returned no result");
        const { body: _body, coordinatorDelegationOpened: delegationOpened, ...summary } = message;
        return toolResult({
          message: summary,
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

  return server;
}

export class ControlMcpServer {
  private server: Server | null = null;
  private token = "";
  private info: ControlMcpInfo | null = null;
  private startError: string | null = null;
  private lifecycle: Promise<void> = Promise.resolve();
  private readonly bindAddress: string;
  private readonly port: number;
  private readonly coordinatorCredentials = new Map<
    string,
    { scope: CoordinatorControlScope; expiresAt: number }
  >();
  /**
   * Repeated-unchanged-read counters, per conversation and read.
   *
   * Lives here rather than on the MCP server because that one is rebuilt for
   * every request — a counter kept there would reset on each call and never
   * observe a loop at all.
   */
  private readonly coordinatorPolls = new Map<
    string,
    { fingerprint: string; unchanged: number; windowStartedAt: number }
  >();

  constructor(
    private readonly dataDir: string,
    private readonly invoke: ControlMcpInvoker,
    options: ControlMcpServerOptions = {},
  ) {
    this.bindAddress = options.bindAddress ?? "127.0.0.1";
    this.port = options.port ?? configuredControlMcpPort();
  }

  getInfo(): ControlMcpInfo | null {
    return this.info;
  }

  getSettings(): ControlMcpSettings {
    const enabled = process.env.ORKESTRATOR_CONTROL_MCP_DISABLED !== "1";
    return {
      enabled,
      running: Boolean(this.server),
      url: this.info?.url ?? this.configuredUrl(),
      token: enabled ? this.token : "",
      error: this.startError,
    };
  }

  /**
   * The per-conversation poll guard handed to one request's MCP server.
   *
   * Bounded on both axes: one entry per conversation and exact read input, and
   * the whole table is dropped when a credential is revoked. The budget is small
   * on purpose — a turn legitimately reads its inbox once on entry and once
   * before it finishes, so the fourth identical answer in two minutes is a wait
   * loop, not work.
   */
  private coordinatorPollGuard(scope: CoordinatorControlScope): CoordinatorPollGuard {
    return (read, fingerprint) => {
      const key = `${scope.coordinatorId}:${scope.conversationId}:${read}`;
      const now = Date.now();
      const previous = this.coordinatorPolls.get(key);
      if (
        !previous ||
        previous.fingerprint !== fingerprint ||
        now - previous.windowStartedAt > COORDINATOR_POLL_WINDOW_MS
      ) {
        this.coordinatorPolls.set(key, { fingerprint, unchanged: 1, windowStartedAt: now });
        if (this.coordinatorPolls.size > MAX_COORDINATOR_POLL_ENTRIES) {
          const oldest = Array.from(this.coordinatorPolls.entries()).sort(
            (a, b) => a[1].windowStartedAt - b[1].windowStartedAt,
          )[0];
          if (oldest) this.coordinatorPolls.delete(oldest[0]);
        }
        return null;
      }
      previous.unchanged += 1;
      if (previous.unchanged <= COORDINATOR_POLL_BUDGET) return null;
      return {
        repeatedRead: true,
        instruction: COORDINATOR_ASYNC_CONTRACT,
      };
    };
  }

  issueCoordinatorCredential(scope: CoordinatorControlScope): CoordinatorControlConnection {
    if (!this.server || !this.info || process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
      throw new Error("Orkestrator control MCP is disabled or unavailable");
    }
    if (
      scope.capabilities.length === 0 ||
      scope.capabilities.some((capability) => !COORDINATOR_CAPABILITIES.has(capability))
    ) {
      throw new Error("Coordinator capabilities are invalid");
    }
    this.revokeCoordinatorCredentials(scope.coordinatorId, scope.conversationId);
    while (this.coordinatorCredentials.size >= MAX_COORDINATOR_CREDENTIALS) {
      const oldest = this.coordinatorCredentials.keys().next().value;
      if (!oldest) break;
      this.coordinatorCredentials.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.coordinatorCredentials.set(token, {
      scope: Object.freeze({ ...scope }),
      expiresAt: Date.now() + COORDINATOR_CREDENTIAL_TTL_MS,
    });
    return { url: this.info.url, token };
  }

  revokeCoordinatorCredentials(coordinatorId: string, conversationId?: string): void {
    for (const [token, credential] of this.coordinatorCredentials) {
      const scope = credential.scope;
      if (
        scope.coordinatorId === coordinatorId &&
        (conversationId === undefined || scope.conversationId === conversationId)
      ) {
        this.coordinatorCredentials.delete(token);
      }
    }
    // A conversation that lost its credential is starting over. Carrying its
    // poll history forward would refuse the first read of the next one.
    for (const key of this.coordinatorPolls.keys()) {
      if (
        key.startsWith(
          conversationId === undefined
            ? `${coordinatorId}:`
            : `${coordinatorId}:${conversationId}:`,
        )
      ) {
        this.coordinatorPolls.delete(key);
      }
    }
  }

  async start(): Promise<void> {
    const start = this.lifecycle.then(async () => {
      if (this.server) return;
      const descriptorFile = path.join(this.dataDir, CONTROL_MCP_DESCRIPTOR);
      if (process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
        this.startError = null;
        return;
      }
      this.token = await this.readPersistedToken(descriptorFile);
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            jsonResponse(response, 500, {
              error: error instanceof Error ? error.message : "Control MCP request failed",
            });
          } else {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.port, this.bindAddress, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error("Control MCP server did not receive a TCP port");
      }
      this.server = server;
      server.unref();
      this.startError = null;
      this.info = {
        url: `http://${this.bindAddress}:${address.port}${CONTROL_MCP_PATH}`,
        descriptorFile,
      };
      try {
        await this.writeDescriptor(descriptorFile, this.info.url);
      } catch (error) {
        this.server = null;
        this.info = null;
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw error;
      }
    });
    this.lifecycle = start.catch(() => undefined);
    try {
      await start;
    } catch (error) {
      this.startError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const stop = this.lifecycle.then(async () => {
      const server = this.server;
      this.server = null;
      this.info = null;
      this.coordinatorCredentials.clear();
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    });
    this.lifecycle = stop.catch(() => undefined);
    await stop;
  }

  async rotateToken(): Promise<ControlMcpSettings> {
    const rotate = this.lifecycle.then(async () => {
      if (process.env.ORKESTRATOR_CONTROL_MCP_DISABLED === "1") {
        throw new Error("Orkestrator control MCP is disabled");
      }
      const previousToken = this.token;
      this.token = randomBytes(32).toString("base64url");
      const descriptorFile =
        this.info?.descriptorFile ?? path.join(this.dataDir, CONTROL_MCP_DESCRIPTOR);
      try {
        await this.writeDescriptor(descriptorFile, this.info?.url ?? this.configuredUrl());
      } catch (error) {
        this.token = previousToken;
        throw error;
      }
    });
    this.lifecycle = rotate.catch(() => undefined);
    await rotate;
    return this.getSettings();
  }

  private configuredUrl(): string {
    const port = this.port === 0 ? "<dynamic>" : String(this.port);
    return `http://${this.bindAddress}:${port}${CONTROL_MCP_PATH}`;
  }

  private async readPersistedToken(descriptorFile: string): Promise<string> {
    try {
      const descriptor = await readControlMcpDescriptor(descriptorFile);
      return descriptor.token;
    } catch {
      return randomBytes(32).toString("base64url");
    }
  }

  private async writeDescriptor(descriptorFile: string, url: string): Promise<void> {
    await mkdir(path.dirname(descriptorFile), { recursive: true });
    const temporary = `${descriptorFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, url, token: this.token, pid: process.pid }, null, 2)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      await rename(temporary, descriptorFile);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://control-mcp.invalid");
    if (url.pathname !== CONTROL_MCP_PATH) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST", "cache-control": "no-store" });
      response.end();
      return;
    }
    const presentedToken = bearerToken(request);
    const coordinatorCredential = presentedToken
      ? this.coordinatorCredentials.get(presentedToken)
      : undefined;
    if (presentedToken && coordinatorCredential && coordinatorCredential.expiresAt <= Date.now()) {
      this.coordinatorCredentials.delete(presentedToken);
    }
    const coordinatorScope =
      coordinatorCredential && coordinatorCredential.expiresAt > Date.now()
        ? coordinatorCredential.scope
        : undefined;
    if (!tokenMatches(presentedToken, this.token) && !coordinatorScope) {
      response.setHeader("www-authenticate", 'Bearer realm="orkestrator-control"');
      jsonResponse(response, 401, { error: "Invalid control MCP credential" });
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      jsonResponse(response, 400, {
        error: error instanceof Error ? error.message : "Invalid request body",
      });
      return;
    }
    if (coordinatorScope) {
      const snapshot = await this.invoke<unknown>("get_project_coordinator", {
        projectId: coordinatorScope.projectId,
      });
      const workspace =
        isRecord(snapshot) && isRecord(snapshot.workspace) ? snapshot.workspace : null;
      const conversations =
        workspace && Array.isArray(workspace.conversations) ? workspace.conversations : [];
      const conversation = conversations.find(
        (item) => isRecord(item) && item.id === coordinatorScope.conversationId,
      );
      if (
        !workspace ||
        workspace.id !== coordinatorScope.coordinatorId ||
        !isRecord(conversation) ||
        conversation.closedAt !== undefined ||
        conversation.mailboxIncarnationId !== coordinatorScope.mailboxIncarnationId
      ) {
        this.coordinatorCredentials.delete(presentedToken!);
        jsonResponse(response, 401, { error: "Coordinator credential is no longer valid" });
        return;
      }
      if (workspace.lifecycleState !== "ready") {
        jsonResponse(response, 409, { error: "Coordinator is paused or unavailable" });
        return;
      }
      // Expire abandoned credentials without interrupting a healthy,
      // long-lived coordinator bridge that continues to revalidate normally.
      if (coordinatorCredential) {
        coordinatorCredential.expiresAt = Date.now() + COORDINATOR_CREDENTIAL_TTL_MS;
      }
      const messages = Array.isArray(body) ? body : [body];
      for (const message of messages) {
        if (!isRecord(message) || message.method !== "tools/call") continue;
        const requestedTool = isRecord(message.params) ? message.params.name : undefined;
        if (typeof requestedTool !== "string") {
          jsonResponse(response, 403, { error: "Coordinator capability denied" });
          return;
        }
        const required = COORDINATOR_TOOL_CAPABILITY.get(requestedTool);
        if (!required || !coordinatorScope.capabilities.includes(required)) {
          jsonResponse(response, 403, { error: "Coordinator capability denied" });
          return;
        }
      }
    }
    const scopedInvoke: ControlMcpInvoker = coordinatorScope
      ? async <T>(command: string, args: Record<string, unknown> = {}) => {
          const projectId = typeof args.projectId === "string" ? args.projectId : undefined;
          if (projectId && projectId !== coordinatorScope.projectId) {
            throw new Error("Coordinator credential cannot access another project");
          }
          if (typeof args.environmentId === "string") {
            const ownRuntime = `coordinator:${coordinatorScope.coordinatorId}:${coordinatorScope.conversationId}`;
            if (args.environmentId !== ownRuntime) {
              const environment = await this.invoke<unknown>("get_environment", {
                environmentId: args.environmentId,
              });
              if (!isRecord(environment) || environment.projectId !== coordinatorScope.projectId) {
                throw new Error("Coordinator credential cannot access that environment");
              }
              // The project home runs writable sessions in the checkout the
              // coordinator may only read. Delegating to it would bypass that
              // boundary, so it is never a worker.
              if (environment.projectHome === true) {
                throw new Error("Coordinator credential cannot act on the project checkout");
              }
            }
          }
          const denied = new Set([
            "update_config",
            "remove_project",
            "merge_environment",
            "delete_environment",
            "write_file",
            "move_file",
            // Only the user approves a request; a coordinator only creates one.
            "resolve_node_action_request",
          ]);
          if (denied.has(command)) throw new Error("Coordinator capability denied");
          return this.invoke<T>(command, args);
        }
      : this.invoke;
    const pollGuard = coordinatorScope ? this.coordinatorPollGuard(coordinatorScope) : undefined;
    const handler = createMcpHandler(
      () => createControlMcp(scopedInvoke, coordinatorScope, pollGuard),
      { legacy: "stateless" },
    );
    try {
      await toNodeHandler(handler)(request, response, body);
    } finally {
      await handler.close().catch(() => undefined);
    }
  }
}

export async function readControlMcpDescriptor(
  descriptorFile: string,
): Promise<{ version: 1; url: string; token: string; pid: number }> {
  const value = JSON.parse(await readFile(descriptorFile, "utf8")) as unknown;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.url !== "string" ||
    typeof value.token !== "string" ||
    typeof value.pid !== "number"
  ) {
    throw new Error("Control MCP descriptor is invalid");
  }
  return value as { version: 1; url: string; token: string; pid: number };
}
