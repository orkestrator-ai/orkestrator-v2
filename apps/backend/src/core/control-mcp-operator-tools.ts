import { createHash } from "node:crypto";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { canonicalJson, type PublicActionName } from "@orkestrator/protocol/public-api";
import {
  encodePublicSessionId,
  type PublicProjectSummary,
  type PublicTicketDetail,
  type PublicTicketSummary,
} from "@orkestrator/protocol/public-api-resources";
import {
  allowed,
  dispatchAs,
  runPublicAction,
  type ControlMcpCaller,
} from "./control-mcp-caller.js";
import { envelopeToolResult, type ControlMcpEnvelope } from "./control-mcp-results.js";
import {
  launchOptions,
  launchSelectionReport,
  launchSettingsTiers,
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
  });

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

async function allPages<T>(
  caller: ControlMcpCaller,
  action: PublicActionName,
  input: JsonRecord,
): Promise<{ items: T[] } | { envelope: ControlMcpEnvelope }> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const envelope = await runPublicAction(
      caller,
      action,
      { ...input, limit: 200, ...(cursor ? { cursor } : {}) },
      undefined,
      undefined,
    );
    if (!envelope.ok) return { envelope };
    const result = envelope.result as { items: T[]; nextCursor?: string };
    items.push(...result.items);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return { items };
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
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria,
    comments: ticket.comments,
  };
}

export async function operatorListProjects(caller: ControlMcpCaller) {
  const pages = await allPages<PublicProjectSummary>(caller, "project.list", {});
  if ("envelope" in pages) return failure(pages.envelope);
  const projects = pages.items.map((project) => ({
    id: project.id,
    name: project.name,
    addedAt: project.addedAt,
    order: project.order,
    hasLocalCheckout: typeof project.localPath === "string" && project.localPath.length > 0,
  }));
  return legacyResult({ projects, total: projects.length });
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
  },
) {
  const { requestId, ...fields } = input;
  const envelope = await runPublicAction(caller, "ticket.create", fields, requestId, undefined);
  if (!envelope.ok) return failure(envelope);
  const created = envelope.result as { ticketId: string };
  return ticketDetail(caller, input.projectId, created.ticketId, envelope.receipt);
}

/**
 * `update_ticket` never took a requestId: replacing fields is naturally
 * idempotent. Its request key is derived from the update itself, so a retry
 * replays and a different update is a different request.
 */
export function updateTicketRequestId(input: JsonRecord): string {
  return `update-ticket-${createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 40)}`;
}

export async function operatorUpdateTicket(
  caller: ControlMcpCaller,
  input: { projectId: string; ticketId: string } & JsonRecord,
) {
  const fields = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  const envelope = await runPublicAction(
    caller,
    "ticket.update",
    fields,
    updateTicketRequestId(fields),
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
    const [options, environment] = await Promise.all([
      launchOptions(caller.invoke, projectId, environmentId),
      environmentId
        ? caller.invoke<unknown>("get_environment", { environmentId })
        : Promise.resolve(undefined),
    ]);
    const tiers = await launchSettingsTiers(
      caller.invoke,
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
  const result = envelope.result as { environmentId: string; sessionId: string; runId: string };
  return legacyResult({
    environmentId: result.environmentId,
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
