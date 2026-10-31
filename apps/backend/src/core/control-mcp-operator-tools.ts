import { allPublicPages as allPages } from "./control-mcp-pages.js";
import { randomUUID } from "node:crypto";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { PUBLIC_ALL_NODES, type PublicActionName } from "@orkestrator/protocol/public-api";
import {
  encodePublicSessionId,
  type PublicNodeList,
  type PublicProjectSummary,
  type PublicSessionSummary,
  type PublicTicketDetail,
  type PublicTicketSummary,
} from "@orkestrator/protocol/public-api-resources";
import {
  allowed,
  dispatchAs,
  onNode,
  runPublicAction,
  type ControlMcpCaller,
} from "./control-mcp-caller.js";
import { envelopeToolResult, type ControlMcpEnvelope } from "./control-mcp-results.js";
import {
  launchOptions,
  launchSelectionReport,
  launchSettingsTiers,
  type ControlMcpInvoker,
} from "./control-shared-actions.js";

/**
 * The original operator tools, for operator credentials, as adapters over
 * public actions.
 *
 * Every mutation (`launch_environment`, `launch_job`, `send_prompt_to_tab`,
 * the ticket writes and `send_message`) is exactly one public action under
 * the credential's authority, so its request key, intent fingerprint, busy
 * rule and receipt are the CLI's. Reads with an exact mapping
 * (`list_projects`, `list_tickets`, `get_ticket`, `list_mailboxes`) read the
 * public action too. The tools keep their documented output shapes and add a
 * `receipt` for mutations. Coordinator credentials keep their own
 * implementations in `control-mcp-tools.ts`.
 *
 * Behaviour differences from the pre-public implementations are recorded in
 * docs/architecture/control-mcp.md ("Operator tools over public actions").
 */

/** Each operator tool and the public actions it uses; listed only when all are allowed. */
export const OPERATOR_TOOL_ACTIONS: Readonly<Record<string, readonly PublicActionName[]>> =
  Object.freeze({
    list_projects: ["project.list"],
    get_launch_options: ["agent.options"],
    list_environments: ["environment.list"],
    get_environment: ["environment.get"],
    list_tabs: ["session.list"],
    list_agents: ["session.list"],
    get_tab_state: ["session.get"],
    get_tab_transcript: ["session.transcript"],
    list_tickets: ["ticket.list"],
    get_ticket: ["ticket.get"],
    create_ticket: ["ticket.create", "ticket.get"],
    update_ticket: ["ticket.update", "ticket.get"],
    add_ticket_comment: ["ticket.comment", "ticket.get"],
    launch_environment: ["environment.launch"],
    launch_job: ["session.start"],
    send_prompt_to_tab: ["session.prompt"],
    list_mailboxes: ["mail.mailboxes"],
    send_message: ["mail.send"],
    list_nodes: ["node.list"],
    // The coordinator's Multi Review tools, by name, over review.*.
    launch_multi_review: ["review.launch"],
    start_multi_review: ["review.launch"],
    list_multi_reviews: ["review.list"],
    get_multi_review: ["review.get"],
    open_multi_review: ["review.open"],
    open_multi_review_fix: ["review.open"],
    address_multi_review: ["review.address"],
    cancel_multi_review: ["review.cancel"],
    // The action bar's PR, Resolve and Merge buttons.
    create_pr: ["pr.create"],
    resolve_conflicts: ["pr.resolve"],
    merge_pr: ["pr.merge"],
  });

/** A node refusal of a legacy tool, worded with its public error code. */
export class ControlMcpNodeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ControlMcpNodeError";
  }
}

export interface OperatorNode {
  /** The caller acting on that node: public actions and composed reads both go there. */
  caller: ControlMcpCaller;
  /** Raw registry reads on that node. */
  invoke: ControlMcpInvoker;
  /** `{nodeId, node}` for a result from another node; `{}` for this one. */
  tag: JsonRecord;
}

/**
 * The machine a legacy tool's `nodeId` names, checked against `node.list` so
 * the refusals carry the public codes (`node-not-found`, `node-unavailable`,
 * `node-unsupported`). Reads are routed with `invoke_on_node`; public actions
 * go through `request.node` under the caller's relayed authority.
 */
export async function operatorNode(
  caller: ControlMcpCaller,
  nodeId: string | undefined,
): Promise<OperatorNode> {
  const local = onNode(caller, undefined);
  if (!nodeId) return { caller: local, invoke: local.invoke, tag: {} };
  if (nodeId === PUBLIC_ALL_NODES) {
    throw new ControlMcpNodeError(
      "invalid-input",
      "This tool acts on one machine; all is only for list_projects and list_environments",
    );
  }
  const listed = await dispatchAs<PublicNodeList>(local, "node.list", {});
  if (!listed.ok) throw new ControlMcpNodeError(listed.error.code, listed.error.message);
  const node = listed.result.items.find((item) => item.nodeId === nodeId);
  if (!node) {
    throw new ControlMcpNodeError(
      "node-not-found",
      listed.result.mode === "leaf"
        ? "This node is in leaf mode; act on other machines from its command node"
        : `No node has ID ${nodeId}; list_nodes names them`,
    );
  }
  if (node.self) return { caller: local, invoke: local.invoke, tag: {} };
  if (!node.available) {
    throw new ControlMcpNodeError(
      "node-unavailable",
      `${node.name} is not connected (${node.state})`,
    );
  }
  if (!node.publicActions) {
    throw new ControlMcpNodeError(
      "node-unsupported",
      `${node.name}: ${node.reason ?? "unsupported"}`,
    );
  }
  const routed: ControlMcpInvoker = async <T>(command: string, args: JsonRecord = {}) => {
    const answer = await local.invoke<{ outcome: string; result?: T }>("invoke_on_node", {
      nodeId,
      command,
      args,
    });
    if (answer.outcome !== "ok") {
      throw new ControlMcpNodeError(
        "node-outcome-unknown",
        `The connection to ${node.name} was lost before it answered`,
      );
    }
    return answer.result as T;
  };
  return {
    caller: { ...onNode(caller, nodeId), readInvoke: routed },
    invoke: routed,
    tag: { nodeId, node: node.name },
  };
}

/**
 * A Coordinator conversation has no pane layout, so the legacy tab tools read
 * it as the one-tab layout `session.list` describes. That also runs on a leaf,
 * and refuses a closed or unassigned conversation with its public code.
 */
export async function operatorCoordinatorLayout(
  node: OperatorNode,
  environmentId: string,
): Promise<JsonRecord> {
  const listed = await dispatchAs<{ items: PublicSessionSummary[] }>(node.caller, "session.list", {
    environmentId,
  });
  if (!listed.ok) throw new ControlMcpNodeError(listed.error.code, listed.error.message);
  return {
    root: {
      kind: "leaf",
      id: environmentId,
      tabs: listed.result.items.map((session) => ({
        id: session.tabId,
        type: "agent-native",
        displayTitle: session.title,
        nativeAgentData: {
          platform: session.agent,
          ...(session.hasProviderSession ? { sessionId: session.id } : {}),
        },
      })),
    },
  };
}

/** Every machine a legacy list reads with `nodeId: all`, and the ones it could not. */
export async function operatorAllNodes(caller: ControlMcpCaller) {
  const local = onNode(caller, undefined);
  const listed = await dispatchAs<PublicNodeList>(local, "node.list", {});
  if (!listed.ok) throw new ControlMcpNodeError(listed.error.code, listed.error.message);
  const reachable: OperatorNode[] = [];
  const unavailable: JsonRecord[] = [];
  for (const node of listed.result.items) {
    if (node.self) {
      reachable.push({
        caller: local,
        invoke: local.invoke,
        tag: { nodeId: node.nodeId, node: node.name },
      });
    } else if (node.available && node.publicActions) {
      try {
        reachable.push(await operatorNode(caller, node.nodeId));
      } catch (error) {
        unavailable.push({
          nodeId: node.nodeId,
          node: node.name,
          reason: error instanceof Error ? error.message : "Node resolution failed",
        });
      }
    } else {
      unavailable.push({
        nodeId: node.nodeId,
        node: node.name,
        reason: node.reason ?? node.state,
      });
    }
  }
  return { reachable, unavailable };
}

export function operatorToolListed(caller: ControlMcpCaller, tool: string): boolean {
  const actions = OPERATOR_TOOL_ACTIONS[tool];
  return Boolean(actions) && actions!.every((action) => allowed(caller, action));
}

type JsonRecord = Record<string, unknown>;

function legacyResult(value: JsonRecord) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(envelope: ControlMcpEnvelope) {
  return envelopeToolResult(envelope, "full");
}

function legacyTicketSummary(ticket: PublicTicketSummary): JsonRecord {
  return {
    id: ticket.id,
    projectId: ticket.projectId,
    title: ticket.title,
    status: ticket.status,
    order: ticket.order,
    createdAt: ticket.createdAt,
    commentCount: ticket.commentCount,
    imageCount: ticket.imageCount,
    environmentId: ticket.environmentId ?? undefined,
    prUrl: ticket.pr.url ?? undefined,
    prState: ticket.pr.state ?? undefined,
  };
}

function legacyTicketDetail(ticket: PublicTicketDetail): JsonRecord {
  return {
    ...legacyTicketSummary(ticket),
    kind: ticket.kind ?? "feature",
    ...(ticket.criteria?.length ? { criteria: ticket.criteria } : {}),
    ...(ticket.deliveryPolicy ? { deliveryPolicy: ticket.deliveryPolicy } : {}),
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    comments: ticket.comments,
  };
}

export async function operatorListProjects(caller: ControlMcpCaller) {
  const pages = await allPages<PublicProjectSummary>(caller, "project.list", {});
  if ("envelope" in pages) return failure(pages.envelope);
  const projects = pages.items.map((project) => {
    const tagged = project as PublicProjectSummary & { nodeId?: string; nodeName?: string };
    return {
      id: project.id,
      name: project.name,
      addedAt: project.addedAt,
      order: project.order,
      hasLocalCheckout: typeof project.localPath === "string" && project.localPath.length > 0,
      ...(tagged.nodeId ? { nodeId: tagged.nodeId, node: tagged.nodeName } : {}),
    };
  });
  return legacyResult({
    projects,
    total: projects.length,
    ...(pages.nodes.length
      ? {
          nodes: pages.nodes,
          unavailableNodes: pages.nodes
            .filter((node) => !node.ok)
            .map((node) => ({ nodeId: node.nodeId, node: node.name, reason: node.error?.message })),
        }
      : {}),
    ...(pages.warnings.length ? { warnings: pages.warnings } : {}),
  });
}

export async function operatorListTickets(
  caller: ControlMcpCaller,
  input: { projectId: string; status?: string },
) {
  const pages = await allPages<PublicTicketSummary>(caller, "ticket.list", input);
  if ("envelope" in pages) return failure(pages.envelope);
  const tickets = pages.items.map(legacyTicketSummary);
  return legacyResult({ tickets, total: tickets.length });
}

async function ticketDetail(
  caller: ControlMcpCaller,
  projectId: string,
  ticketId: string,
  receipt?: ControlMcpEnvelope["receipt"],
) {
  const envelope = await runPublicAction(
    caller,
    "ticket.get",
    { projectId, ticketId },
    undefined,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  return legacyResult({
    ticket: legacyTicketDetail(envelope.result as PublicTicketDetail),
    ...(receipt ? { receipt } : {}),
  });
}

export function operatorGetTicket(
  caller: ControlMcpCaller,
  input: { projectId: string; ticketId: string },
) {
  return ticketDetail(caller, input.projectId, input.ticketId);
}

export async function operatorCreateTicket(
  caller: ControlMcpCaller,
  input: {
    requestId: string;
    projectId: string;
    title: string;
    description: string;
    acceptanceCriteria: string;
    status: string;
    kind?: string;
    sections?: JsonRecord;
  },
) {
  const { requestId, ...fields } = input;
  const envelope = await runPublicAction(caller, "ticket.create", fields, requestId, undefined);
  if (!envelope.ok) return failure(envelope);
  const created = envelope.result as { ticketId: string };
  return ticketDetail(caller, input.projectId, created.ticketId, envelope.receipt);
}

/** New edits get a fresh identity; callers may supply a key for explicit retries. */
export async function operatorUpdateTicket(
  caller: ControlMcpCaller,
  input: { projectId: string; ticketId: string } & JsonRecord,
) {
  const { requestId, ...updates } = input;
  const fields = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );
  const envelope = await runPublicAction(
    caller,
    "ticket.update",
    fields,
    typeof requestId === "string" ? requestId : `update-ticket-${randomUUID()}`,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  return ticketDetail(caller, input.projectId, input.ticketId, envelope.receipt);
}

export async function operatorAddTicketComment(
  caller: ControlMcpCaller,
  input: { requestId: string; projectId: string; ticketId: string; text: string },
) {
  const { requestId, ...fields } = input;
  const envelope = await runPublicAction(caller, "ticket.comment", fields, requestId, undefined);
  if (!envelope.ok) return failure(envelope);
  return ticketDetail(caller, input.projectId, input.ticketId, envelope.receipt);
}

/** What the launch runs, reported as advisory: the public action resolves it at admission. */
async function selectionFor(
  caller: ControlMcpCaller,
  projectId: string,
  environmentId: string | undefined,
  input: { agent: AgentPlatform; modelId?: string; reasoningId?: string },
): Promise<JsonRecord> {
  try {
    const read = caller.readInvoke ?? caller.invoke;
    const [options, environment] = await Promise.all([
      launchOptions(read, projectId, environmentId),
      environmentId
        ? read<unknown>("get_environment", { environmentId })
        : Promise.resolve(undefined),
    ]);
    const tiers = await launchSettingsTiers(
      read,
      projectId,
      environment && typeof environment === "object" ? (environment as JsonRecord) : undefined,
    );
    return {
      selection: { ...launchSelectionReport(tiers, options.models, input), advisory: true },
    };
  } catch {
    return {};
  }
}

interface LaunchInput {
  requestId: string;
  projectId: string;
  environmentType: "local" | "containerized";
  name?: string;
  agent: AgentPlatform;
  modelId?: string;
  reasoningId?: string;
  fastMode?: boolean;
  conversationMode: "plan" | "build";
  prompt: string;
  networkAccessMode?: "restricted" | "full";
  baseBranch?: string;
  baseCommit?: string;
}

export async function operatorLaunchEnvironment(caller: ControlMcpCaller, input: LaunchInput) {
  const envelope = await runPublicAction(
    caller,
    "environment.launch",
    {
      projectId: input.projectId,
      type: input.environmentType === "containerized" ? "container" : "local",
      agent: input.agent,
      prompt: input.prompt,
      mode: input.conversationMode,
      ...(input.name ? { name: input.name } : {}),
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(input.reasoningId ? { reasoning: input.reasoningId } : {}),
      ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
      ...(input.networkAccessMode ? { networkAccessMode: input.networkAccessMode } : {}),
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    },
    input.requestId,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  const result = envelope.result as {
    environment?: { id: string };
    environmentId?: string;
    sessionId: string;
    runId: string;
  };
  return legacyResult({
    environmentId:
      result.environment?.id ?? result.environmentId ?? envelope.receipt?.resources.environmentId,
    tabId: "startup-agent",
    sessionId: result.sessionId,
    runId: result.runId,
    status: "accepted",
    ...(await selectionFor(caller, input.projectId, undefined, input)),
    receipt: envelope.receipt,
  });
}

interface JobInput {
  requestId: string;
  environmentId: string;
  agent: AgentPlatform;
  modelId?: string;
  reasoningId?: string;
  fastMode?: boolean;
  conversationMode: "plan" | "build";
  title?: string;
  prompt: string;
}

export async function operatorLaunchJob(caller: ControlMcpCaller, input: JobInput) {
  const environment = await dispatchAs<{ projectId: string }>(caller, "environment.get", {
    environmentId: input.environmentId,
  });
  const envelope = await runPublicAction(
    caller,
    "session.start",
    {
      environmentId: input.environmentId,
      agent: input.agent,
      prompt: input.prompt,
      mode: input.conversationMode,
      ...(input.title ? { title: input.title } : {}),
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(input.reasoningId ? { reasoning: input.reasoningId } : {}),
      ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
    },
    input.requestId,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  const result = envelope.result as { sessionId: string; tabId: string; runId: string };
  return legacyResult({
    jobId: result.tabId.replace(/^agent-job-/, ""),
    environmentId: input.environmentId,
    tabId: result.tabId,
    sessionId: result.sessionId,
    runId: result.runId,
    status: "accepted",
    ...(environment.ok
      ? await selectionFor(caller, environment.result.projectId, input.environmentId, input)
      : {}),
    receipt: envelope.receipt,
  });
}

export async function operatorSendPrompt(
  caller: ControlMcpCaller,
  input: {
    requestId: string;
    environmentId: string;
    tabId: string;
    prompt: string;
    conversationMode?: "plan" | "build";
  },
) {
  const sessionId = encodePublicSessionId(input.environmentId, input.tabId);
  const envelope = await runPublicAction(
    caller,
    "session.prompt",
    {
      sessionId,
      prompt: input.prompt,
      ...(input.conversationMode ? { mode: input.conversationMode } : {}),
    },
    input.requestId,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  const result = envelope.result as { runId: string };
  return legacyResult({
    environmentId: input.environmentId,
    tabId: input.tabId,
    sessionId,
    runId: result.runId,
    outcome: envelope.receipt?.dispatch?.state ?? "accepted",
    receipt: envelope.receipt,
  });
}

export async function operatorListMailboxes(
  caller: ControlMcpCaller,
  input: { q?: string; offset: number; limit: number },
) {
  const envelope = await runPublicAction(
    caller,
    "mail.mailboxes",
    { ...(input.q ? { q: input.q } : {}), offset: input.offset, limit: input.limit },
    undefined,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  return legacyResult(envelope.result as JsonRecord);
}

export async function operatorSendMessage(
  caller: ControlMcpCaller,
  input: {
    requestId: string;
    toEnvironmentId: string;
    toTabId?: string;
    subject?: string;
    body: string;
  },
) {
  const envelope = await runPublicAction(
    caller,
    "mail.send",
    {
      toEnvironmentId: input.toEnvironmentId,
      toTabId: input.toTabId,
      body: input.body,
      ...(input.subject ? { subject: input.subject } : {}),
    },
    input.requestId,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  const result = envelope.result as JsonRecord;
  return legacyResult({
    message: {
      id: result.messageId,
      toEnvironmentId: result.toEnvironmentId,
      toTabId: result.toTabId,
      placement: result.placement,
    },
    receipt: envelope.receipt,
  });
}

export async function operatorListNodes(caller: ControlMcpCaller) {
  const envelope = await runPublicAction(
    onNode(caller, undefined),
    "node.list",
    {},
    undefined,
    undefined,
  );
  if (!envelope.ok) return failure(envelope);
  const list = envelope.result as PublicNodeList;
  const self = list.items.find((item) => item.self);
  return legacyResult({
    self: self ? { nodeId: self.nodeId, name: self.name, mode: list.mode } : null,
    nodes: list.items
      .filter((item) => !item.self)
      .map((item) => ({
        nodeId: item.nodeId,
        name: item.name,
        available: item.available,
        state: item.state,
        mode: item.mode,
        version: item.version,
        publicActions: item.publicActions,
        ...(item.reason ? { reason: item.reason } : {}),
      })),
    controlledBy: list.controlledBy,
    total: list.items.length - (self ? 1 : 0),
  });
}

/** One public action as a legacy-named tool: the public envelope, or the legacy error. */
export async function operatorAction(
  caller: ControlMcpCaller,
  action: PublicActionName,
  input: JsonRecord,
  requestId: string | undefined,
  confirmToken?: unknown,
) {
  const envelope = await runPublicAction(caller, action, input, requestId, confirmToken);
  if (!envelope.ok) return failure(envelope);
  return legacyResult({
    ...(envelope.result as JsonRecord),
    ...(envelope.receipt ? { receipt: envelope.receipt } : {}),
    ...(envelope.node ? { nodeId: envelope.node.nodeId, node: envelope.node.name } : {}),
  });
}
