import { BACKEND_CAPABILITIES, hasBackendCapability } from "@orkestrator/protocol/backend-profile";
import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";
import {
  isPublicActionName,
  isPublicActionResponse,
  isPublicAggregateAction,
  isPublicNodeTarget,
  PUBLIC_ACTIONS,
  PUBLIC_ALL_NODES,
  PUBLIC_API_LIMITS,
  PUBLIC_LOCAL_ONLY_ACTIONS,
  publicErrorEnvelope,
  publicSuccessEnvelope,
  type PublicActionName,
  type PublicActionResponse,
  type PublicNodeTag,
} from "@orkestrator/protocol/public-api";
import type {
  PublicAggregateAttentionPage,
  PublicAggregatePage,
  PublicAttentionItem,
  PublicAttentionPage,
  PublicNodeReadResult,
  PublicNodeTagged,
  PublicPage,
} from "@orkestrator/protocol/public-api-resources";
import type { CommandContext } from "../commands-context.js";
import { NodeUnavailableError } from "../nodes/node-link.js";
import type { NodeLink } from "../nodes/node-link.js";
import { boundedMessage, PublicActionError } from "./errors.js";
import type { PublicAuthority } from "./operation-ledger.js";

/**
 * `request.node`: run a public action on a leaf node this command node
 * controls (docs/architecture/control-mcp.md, "Leaf nodes").
 *
 * The command node forwards the same `public_action` request over its node
 * link. The leaf stays authoritative: it admits the request key, runs the
 * action and keeps the receipt. The command node adds only:
 * - node resolution with stable codes (`node-not-found`, `node-unavailable`,
 *   `node-unsupported`);
 * - the caller's authority, relayed so a Control MCP credential's operations
 *   on the leaf stay its own (`relayedAuthority`);
 * - `node-outcome-unknown` when the link lost the answer to a mutation. It is
 *   never resent; the same request key replays on the leaf.
 * - `node: "all"` for the aggregate reads, every item tagged with its node.
 */

/** Longest a leaf may take to answer one part of an aggregate read. */
export const AGGREGATE_NODE_TIMEOUT_MS = 15_000;

/** What the leaf receives from its command node beside the request. */
export interface RelayedAuthorityClaim {
  controllerId: BackendId;
  authority: PublicAuthority;
}

interface ResolvedNode {
  nodeId: BackendId;
  name: string;
  link: NodeLink;
}

type Local = (raw: Record<string, unknown>) => Promise<PublicActionResponse>;

export interface NodeDispatch {
  raw: Record<string, unknown>;
  command: CommandContext;
  authority: PublicAuthority;
  backend: { installationId: string; generation: string };
  /** Runs the request (without `node`) on this backend. */
  local: Local;
}

function failure(action: string, error: PublicActionError, node?: PublicNodeTag) {
  return {
    ...publicErrorEnvelope(action, {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    }),
    ...(node ? { node } : {}),
  } as PublicActionResponse;
}

function withoutNode(raw: Record<string, unknown>): Record<string, unknown> {
  const { node: _node, ...rest } = raw;
  return rest;
}

/** Why public actions cannot be routed to a node, or null when they can. */
export function nodeRoutingRefusal(link: NodeLink | null): string | null {
  if (!link?.connected) return "not connected";
  if (!hasBackendCapability(link.hello, BACKEND_CAPABILITIES.publicActionRelay)) {
    return `Orkestrator ${link.hello?.appVersion ?? "on that node"} is too old to run public actions for a command node; update it`;
  }
  return null;
}

async function resolveNode(command: CommandContext, nodeId: string): Promise<ResolvedNode> {
  const nodes = command.nodes;
  if (!nodes) {
    throw new PublicActionError("node-unsupported", "This backend cannot reach other nodes");
  }
  if (nodes.isLeaf()) {
    const controllers = nodes.listControllers().map((entry) => entry.displayName);
    throw new PublicActionError(
      "node-unsupported",
      `This node is in leaf mode, controlled by ${controllers.join(", ") || "a command node"}; act on other nodes from there`,
      { details: { mode: "leaf" } },
    );
  }
  if (!isBackendId(nodeId)) {
    throw new PublicActionError("node-not-found", `No node has ID ${nodeId}; node.list names them`);
  }
  const view = await nodes.getNode(nodeId).catch(() => null);
  if (!view) {
    throw new PublicActionError(
      "node-not-found",
      `No node with ID ${nodeId} is registered here; node.list names them`,
      { details: { nodeId } },
    );
  }
  const name = view.displayName || view.fallbackName || nodeId;
  if (!view.enabled) {
    throw new PublicActionError("node-unavailable", `${name} is disabled on this command node`, {
      details: { nodeId, state: "disabled" },
    });
  }
  const link = nodes.link(nodeId);
  if (!link?.connected) {
    throw new PublicActionError(
      "node-unavailable",
      `${name} is not connected (${view.connection.state}); nothing was sent to it`,
      { details: { nodeId, state: view.connection.state }, retryable: true },
    );
  }
  const refusal = nodeRoutingRefusal(link);
  if (refusal) {
    throw new PublicActionError("node-unsupported", `${name}: ${refusal}`, {
      details: { nodeId, version: link.hello?.appVersion ?? null },
    });
  }
  return { nodeId, name, link };
}

async function selfTag(command: CommandContext, nodeId: string): Promise<PublicNodeTag> {
  const profile = await command.nodes?.selfProfile().catch(() => null);
  return { nodeId, name: profile?.displayName ?? nodeId };
}

/** Forward one request to a resolved node and re-envelope its answer. */
async function routeOne(
  dispatch: NodeDispatch,
  action: PublicActionName,
  target: ResolvedNode,
  selfId: BackendId,
  timeoutMs?: number,
): Promise<PublicActionResponse> {
  const portal = dispatch.command.nodePortal;
  const tag: PublicNodeTag = { nodeId: target.nodeId, name: target.name };
  if (!portal) {
    return failure(
      action,
      new PublicActionError("node-unsupported", "This backend cannot reach other nodes"),
      tag,
    );
  }
  const read = !PUBLIC_ACTIONS[action].mutation;
  const request = dispatch.raw.request as { requestId?: unknown } | undefined;
  const forwarded: Record<string, unknown> = {
    ...withoutNode(dispatch.raw),
    ...(dispatch.authority !== "operator"
      ? {
          relayedAuthority: {
            controllerId: selfId,
            authority: dispatch.authority,
          } satisfies RelayedAuthorityClaim,
        }
      : {}),
  };
  let routed: Awaited<ReturnType<typeof portal.routePublicAction>>;
  try {
    routed = await portal.routePublicAction(target.nodeId, forwarded, {
      read,
      ...(typeof request?.requestId === "string" ? { requestKey: request.requestId } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (error) {
    return failure(
      action,
      new PublicActionError(
        "node-unavailable",
        error instanceof NodeUnavailableError
          ? `${target.name} is not connected; nothing was sent to it`
          : `${target.name} could not take the request: ${boundedMessage(error)}`,
        { details: { nodeId: target.nodeId }, retryable: true },
      ),
      tag,
    );
  }
  if (routed.outcome !== "ok") {
    const requestId = typeof request?.requestId === "string" ? request.requestId : undefined;
    return failure(
      action,
      new PublicActionError(
        "node-outcome-unknown",
        `The connection to ${target.name} was lost before it answered ${action}. It may or may not have run there and was not resent; repeat the identical request with the same requestId to learn its outcome.`,
        {
          details: {
            nodeId: target.nodeId,
            ...(requestId ? { requestId } : {}),
            outcomeId: routed.outcomeId,
          },
          retryable: true,
        },
      ),
      tag,
    );
  }
  const response = routed.result;
  if (!isPublicActionResponse(response)) {
    return failure(
      action,
      new PublicActionError(
        "internal-error",
        `${target.name} answered with a response outside the public contract`,
      ),
      tag,
    );
  }
  return {
    ...response,
    node: {
      ...tag,
      ...(response.backend?.generation ? { generation: response.backend.generation } : {}),
    },
    backend: dispatch.backend,
  };
}

/** Entry point for a `public_action` request that names a node. */
export async function dispatchToNode(dispatch: NodeDispatch): Promise<PublicActionResponse> {
  const raw = dispatch.raw;
  const actionName = typeof raw.action === "string" ? raw.action.slice(0, 100) : "unknown";
  const node = raw.node;
  if (!isPublicActionName(raw.action)) return dispatch.local(withoutNode(raw));
  const action = raw.action;
  if (!isPublicNodeTarget(node)) {
    return failure(
      actionName,
      new PublicActionError("invalid-input", "node must be a nodeId from node.list, or all"),
    );
  }
  if (PUBLIC_LOCAL_ONLY_ACTIONS.includes(action)) {
    return failure(
      action,
      new PublicActionError(
        "invalid-input",
        `${action} always runs on the node you are connected to; omit node`,
      ),
    );
  }
  const selfId = (await dispatch.command.nodes?.selfIdentity().catch(() => null)) ?? null;
  if (selfId && node === selfId) {
    const response = await dispatch.local(withoutNode(raw));
    return { ...response, node: await selfTag(dispatch.command, selfId) };
  }
  if (node === PUBLIC_ALL_NODES) {
    if (!isPublicAggregateAction(action)) {
      return failure(
        action,
        new PublicActionError(
          "invalid-input",
          `${action} runs on one node; node all is only for project.list, environment.list and attention.list`,
        ),
      );
    }
    return aggregate(dispatch, action, selfId);
  }
  try {
    const target = await resolveNode(dispatch.command, node);
    return await routeOne(dispatch, action, target, selfId!);
  } catch (error) {
    if (error instanceof PublicActionError) {
      return failure(action, error, { nodeId: node, name: node });
    }
    return failure(action, new PublicActionError("internal-error", boundedMessage(error)), {
      nodeId: node,
      name: node,
    });
  }
}

/*
 * Aggregate reads (`node: "all"`)
 */

interface NodeAnswer {
  nodeId: string;
  name: string;
  self: boolean;
  response: PublicActionResponse;
}

async function everyNode(
  dispatch: NodeDispatch,
  action: PublicActionName,
  selfId: BackendId | null,
): Promise<NodeAnswer[]> {
  const raw = withoutNode(dispatch.raw);
  const self = selfId
    ? await selfTag(dispatch.command, selfId)
    : { nodeId: dispatch.backend.installationId, name: "This node" };
  const local: Promise<NodeAnswer> = dispatch
    .local(raw)
    .then((response) => ({ ...self, self: true, response }));
  const nodes = dispatch.command.nodes;
  // A leaf's own registry is suspended: only its own items are listed.
  if (!nodes || nodes.isLeaf() || !selfId) return [await local];
  const registry = await nodes.listNodes();
  const remote = registry.nodes.map(async (view): Promise<NodeAnswer> => {
    const name = view.displayName || view.fallbackName || view.nodeId;
    try {
      const target = await resolveNode(dispatch.command, view.nodeId);
      return {
        nodeId: view.nodeId,
        name,
        self: false,
        response: await routeOne(dispatch, action, target, selfId, AGGREGATE_NODE_TIMEOUT_MS),
      };
    } catch (error) {
      const refusal =
        error instanceof PublicActionError
          ? error
          : new PublicActionError("internal-error", boundedMessage(error));
      return { nodeId: view.nodeId, name, self: false, response: failure(action, refusal) };
    }
  });
  return Promise.all([local, ...remote]);
}

function nodeResult(answer: NodeAnswer, extra: Partial<PublicNodeReadResult> = {}) {
  return {
    nodeId: answer.nodeId,
    name: answer.name,
    self: answer.self,
    ok: answer.response.ok,
    ...(answer.response.ok
      ? extra
      : { error: { code: answer.response.error.code, message: answer.response.error.message } }),
  } satisfies PublicNodeReadResult;
}

function tagged<T extends object>(items: readonly T[], answer: NodeAnswer): PublicNodeTagged<T>[] {
  return items.map((item) => ({ ...item, nodeId: answer.nodeId, nodeName: answer.name }));
}

/** Blocking interactions first, then newest first: the order of one node's page. */
function attentionOrder(a: PublicAttentionItem, b: PublicAttentionItem): number {
  const blocking = (item: PublicAttentionItem) =>
    item.kind === "interaction" && item.blocking ? 1 : 0;
  return blocking(b) - blocking(a) || b.at.localeCompare(a.at);
}

async function aggregate(
  dispatch: NodeDispatch,
  action: PublicActionName,
  selfId: BackendId | null,
): Promise<PublicActionResponse> {
  const input = (dispatch.raw.input ?? {}) as Record<string, unknown>;
  if (input.cursor !== undefined) {
    return failure(
      action,
      new PublicActionError(
        "invalid-input",
        "With node all, cursors are per node: pass that node's nodeId with its cursor from nodes",
      ),
    );
  }
  if (action === "environment.list" && input.projectId !== undefined) {
    return failure(
      action,
      new PublicActionError(
        "invalid-input",
        "A projectId belongs to one node: pass that node's nodeId instead of all",
      ),
    );
  }
  const answers = await everyNode(dispatch, action, selfId);
  const own = answers.find((answer) => answer.self)!;
  // This node's own refusal (invalid input, a credential rule) is the answer.
  if (!own.response.ok) return own.response;
  const warnings = answers
    .filter((answer) => !answer.response.ok)
    .map((answer) =>
      answer.response.ok ? "" : `${answer.name}: ${answer.response.error.message}`,
    );
  if (action === "attention.list") {
    const limit =
      typeof input.limit === "number" ? input.limit : PUBLIC_API_LIMITS.attentionDefaultItems;
    const items: PublicNodeTagged<PublicAttentionItem>[] = [];
    const counts = { interactions: 0, runs: 0, setups: 0 };
    let more = 0;
    const nodes: PublicNodeReadResult[] = [];
    for (const answer of answers) {
      if (!answer.response.ok) {
        nodes.push(nodeResult(answer));
        continue;
      }
      const page = answer.response.result as PublicAttentionPage;
      items.push(...tagged(page.items, answer));
      counts.interactions += page.counts.interactions;
      counts.runs += page.counts.runs;
      counts.setups += page.counts.setups;
      more += page.more;
      nodes.push(
        nodeResult(answer, {
          total: page.items.length + page.more,
          cursor: page.cursor,
        }),
      );
    }
    items.sort(attentionOrder);
    const result: PublicAggregateAttentionPage = {
      items: items.slice(0, limit),
      more: more + Math.max(0, items.length - limit),
      counts,
      nodes,
    };
    return {
      ...publicSuccessEnvelope(action, result, undefined, warnings),
      backend: dispatch.backend,
    };
  }
  const items: PublicNodeTagged<{ id: string }>[] = [];
  let total = 0;
  const nodes: PublicNodeReadResult[] = [];
  for (const answer of answers) {
    if (!answer.response.ok) {
      nodes.push(nodeResult(answer));
      continue;
    }
    const page = answer.response.result as PublicPage<{ id: string }>;
    items.push(...tagged(page.items, answer));
    total += page.total;
    nodes.push(
      nodeResult(answer, {
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      }),
    );
  }
  const result: PublicAggregatePage<{ id: string }> = { items, total, nodes };
  return {
    ...publicSuccessEnvelope(action, result, undefined, warnings),
    backend: dispatch.backend,
  };
}

/**
 * Leaf side: the authority a command node relays for its caller, after
 * checking that the command node is attached here. Null when the claim is
 * absent; throws when it is present but not acceptable.
 */
export function parseRelayedAuthorityClaim(
  value: unknown,
  command: CommandContext,
): RelayedAuthorityClaim | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicActionError("invalid-input", "relayedAuthority is invalid");
  }
  const claim = value as Record<string, unknown>;
  if (!isBackendId(claim.controllerId) || typeof claim.authority !== "string") {
    throw new PublicActionError("invalid-input", "relayedAuthority is invalid");
  }
  const controllerId = claim.controllerId;
  const attached = command.nodes
    ?.listControllers()
    .some((entry) => entry.controllerId === controllerId);
  if (!attached) {
    throw new PublicActionError(
      "capability-unavailable",
      "Only a command node attached to this node can relay a credential",
    );
  }
  return { controllerId, authority: claim.authority as PublicAuthority };
}
