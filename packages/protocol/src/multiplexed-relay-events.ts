/**
 * The multiplexed relay event stream (plan item 5005, report §6.2 "Connection
 * budget", §13.4 C): one long-lived request to the command node carries the
 * authoritative main event streams of several relayed leaves.
 *
 * Over plain HTTP/1.1 a browser holds at most six connections per origin, and
 * every relayed leaf's main stream is one of them on the command node's
 * origin. `GET /__orkestrator/nodes/events?nodes=a,b` merges those streams
 * into one response.
 *
 * Wire format (SSE):
 *
 * - **Node frames** name their node in the SSE `event:` field
 *   (`node:<nodeId>`), keep the leaf's own `id:` (that node's cursor) and
 *   carry the leaf's `data:` unchanged. Every leaf frame passes through,
 *   including its own `gateway.connected`, `gateway.cursor` and
 *   `gateway.reconcile-required`, so each node keeps the main stream's
 *   cursor, replay and reconcile contract on its own.
 * - **Control frames** have no `event:` field and no `id:`, and carry
 *   `{ event, payload }` like a gateway frame: `mux.connected` first, echoing
 *   the cursor the client sent for every node (invariant 8: nothing jumps a
 *   cursor), then `mux.node` whenever one node's leaf stream goes up, down or
 *   is refused.
 * - `: keepalive` comments keep the request alive on a quiet connection.
 *
 * A node whose leaf stream drops is reopened by the command node from the
 * last cursor it forwarded, so the leaf replays or reconciles that node only.
 * A node frame larger than {@link MAX_MULTIPLEXED_FRAME_BYTES} cannot be
 * forwarded: the command node reopens that node from the leaf's latest
 * revision and sends a `gateway.reconcile-required` node frame after the new
 * `gateway.connected`, so the gap is explicit (invariant 4) and the client
 * re-reads after it is subscribed again (invariant 7).
 *
 * The client names, for each node, the workspace it opened for it
 * (`open_node_workspace`); a node without an open workspace on this command
 * node is refused (`mux.node` `refused`) and the client reads it on its own
 * relayed stream instead. An older command node answers 404 (the path is
 * under the relay prefix, and `events` is no node), which the client reads as
 * "use per-node streams".
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isBackendId, type BackendId } from "./federation.js";

export const MULTIPLEXED_RELAY_EVENTS_PATH = "/__orkestrator/nodes/events";
/** Comma-separated node ids, in no particular order. */
export const MULTIPLEXED_NODES_PARAM = "nodes";
const CURSOR_PARAM_PREFIX = "since.";
const WORKSPACE_PARAM_PREFIX = "workspace.";
/** SSE `event:` value prefix of a node frame. */
export const MULTIPLEXED_NODE_FRAME_PREFIX = "node:";

/** Nodes one multiplexed request may carry. */
export const MAX_MULTIPLEXED_NODES = 8;
/** Concurrent multiplexed requests one command node serves. */
export const MAX_MULTIPLEXED_STREAMS = 32;
/** A cursor is `<generation>:<revision>`; anything longer is not one. */
export const MAX_MULTIPLEXED_CURSOR_LENGTH = 256;
export const MAX_MULTIPLEXED_WORKSPACE_ID_LENGTH = 128;
/**
 * Largest leaf frame forwarded. The gateway's own per-client hard buffer
 * (`SSE_CLIENT_HARD_BUFFER_BYTES`) and the client's frame bound
 * (`MAX_GATEWAY_EVENT_FRAME_BYTES`) are 8 MiB, so a leaf never sends a larger
 * one to a healthy reader.
 */
export const MAX_MULTIPLEXED_FRAME_BYTES = 8 * 1024 * 1024;
/**
 * Bytes the command node lets wait in one multiplexed response. Leaf streams
 * stop being read while the response is above its high-water mark, so this
 * is only reached by one oversized write; past it the request is closed and
 * the client resumes every node from its own cursor.
 */
export const MAX_MULTIPLEXED_QUEUED_BYTES = 16 * 1024 * 1024;

export const MULTIPLEXED_CONNECTED_EVENT = "mux.connected";
export const MULTIPLEXED_NODE_EVENT = "mux.node";

export type MultiplexedNodeState = "live" | "down" | "refused";
/** Why a node is down or refused. Fixed words only (invariant 12). */
export type MultiplexedNodeReason =
  | "not-connected"
  | "upstream-error"
  | "upstream-silent"
  | "upstream-ended"
  | "frame-too-large"
  | "no-workspace";

/** One node of a multiplexed request, as the client names it. */
export interface MultiplexedNodeRequest {
  readonly nodeId: BackendId;
  /** The workspace the client opened for this node on the command node. */
  readonly workspaceId: string;
  /** The node's main stream cursor, or `null` for a fresh subscription. */
  readonly cursor: string | null;
}

export const multiplexedCursorParam = (nodeId: string): string => `${CURSOR_PARAM_PREFIX}${nodeId}`;
export const multiplexedWorkspaceParam = (nodeId: string): string =>
  `${WORKSPACE_PARAM_PREFIX}${nodeId}`;

/** The query of a multiplexed request. */
export function multiplexedEventsQuery(nodes: readonly MultiplexedNodeRequest[]): string {
  const params = new URLSearchParams();
  params.set(MULTIPLEXED_NODES_PARAM, nodes.map((node) => node.nodeId).join(","));
  for (const node of nodes) {
    params.set(multiplexedWorkspaceParam(node.nodeId), node.workspaceId);
    if (node.cursor) params.set(multiplexedCursorParam(node.nodeId), node.cursor);
  }
  return params.toString();
}

export type MultiplexedQueryResult =
  | { readonly ok: true; readonly nodes: readonly MultiplexedNodeRequest[] }
  | { readonly ok: false; readonly error: string };

/** Reads a multiplexed request's query. Errors name the problem, never a value. */
export function parseMultiplexedEventsQuery(params: URLSearchParams): MultiplexedQueryResult {
  const raw = params.get(MULTIPLEXED_NODES_PARAM)?.trim() ?? "";
  if (!raw) return { ok: false, error: "Expected nodes." };
  const ids = raw.split(",").map((id) => id.trim());
  if (ids.length > MAX_MULTIPLEXED_NODES) {
    return { ok: false, error: `At most ${MAX_MULTIPLEXED_NODES} nodes per stream.` };
  }
  if (new Set(ids).size !== ids.length) return { ok: false, error: "Each node may appear once." };
  const nodes: MultiplexedNodeRequest[] = [];
  for (const nodeId of ids) {
    if (!isBackendId(nodeId)) return { ok: false, error: "Expected node identities." };
    const workspaceId = params.get(multiplexedWorkspaceParam(nodeId))?.trim() ?? "";
    if (!workspaceId || workspaceId.length > MAX_MULTIPLEXED_WORKSPACE_ID_LENGTH) {
      return { ok: false, error: "Expected a workspace for every node." };
    }
    const cursor = params.get(multiplexedCursorParam(nodeId))?.trim() || null;
    if (cursor !== null && cursor.length > MAX_MULTIPLEXED_CURSOR_LENGTH) {
      return { ok: false, error: "A cursor is too long." };
    }
    nodes.push({ nodeId, workspaceId, cursor });
  }
  return { ok: true, nodes };
}

/** The node a node frame's SSE `event:` value names, or `null`. */
export function multiplexedFrameNode(event: string | undefined): BackendId | null {
  if (!event?.startsWith(MULTIPLEXED_NODE_FRAME_PREFIX)) return null;
  const nodeId = event.slice(MULTIPLEXED_NODE_FRAME_PREFIX.length);
  return isBackendId(nodeId) ? nodeId : null;
}

/**
 * One SSE block. Each line of `data` becomes its own `data:` line, so a
 * reader that joins them with `\n` gets `data` back unchanged.
 */
export function encodeSseFrame(frame: {
  readonly event?: string;
  readonly id?: string | null;
  readonly data: string;
}): string {
  let block = "";
  if (frame.event) block += `event: ${frame.event}\n`;
  if (frame.id) block += `id: ${frame.id}\n`;
  for (const line of frame.data.split(/\r?\n/)) block += `data: ${line}\n`;
  return `${block}\n`;
}

export function encodeMultiplexedNodeFrame(
  nodeId: BackendId,
  id: string | null,
  data: string,
): string {
  return encodeSseFrame({ event: `${MULTIPLEXED_NODE_FRAME_PREFIX}${nodeId}`, id, data });
}

const NodeIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

export const MultiplexedConnectedPayloadSchema = Schema.Struct({
  nodes: Schema.Array(
    Schema.Struct({
      node: NodeIdSchema,
      /** The cursor the client sent for this node, unchanged. */
      cursor: Schema.NullOr(Schema.String),
    }),
  ),
});
export type MultiplexedConnectedPayload = typeof MultiplexedConnectedPayloadSchema.Type;

export const MultiplexedNodePayloadSchema = Schema.Struct({
  node: NodeIdSchema,
  state: Schema.Literals(["live", "down", "refused"]),
  /** A newer command node may name a reason this client does not know. */
  reason: Schema.optionalKey(Schema.String),
});
export type MultiplexedNodePayload = typeof MultiplexedNodePayloadSchema.Type;

export type MultiplexedControlFrame =
  | { readonly kind: "connected"; readonly payload: MultiplexedConnectedPayload }
  | { readonly kind: "node"; readonly payload: MultiplexedNodePayload }
  /** A control frame this client does not know (a newer command node). */
  | { readonly kind: "unknown" };

const decodeConnected = Schema.decodeUnknownOption(MultiplexedConnectedPayloadSchema);
const decodeNode = Schema.decodeUnknownOption(MultiplexedNodePayloadSchema);

/** Reads a control frame's `data`; `null` when it is not a `{ event, payload }` frame. */
export function parseMultiplexedControlFrame(data: string): MultiplexedControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { event, payload } = parsed as { event?: unknown; payload?: unknown };
  if (typeof event !== "string") return null;
  if (event === MULTIPLEXED_CONNECTED_EVENT) {
    const decoded = decodeConnected(payload);
    return Option.isSome(decoded) ? { kind: "connected", payload: decoded.value } : null;
  }
  if (event === MULTIPLEXED_NODE_EVENT) {
    const decoded = decodeNode(payload);
    return Option.isSome(decoded) ? { kind: "node", payload: decoded.value } : null;
  }
  return { kind: "unknown" };
}

export function encodeMultiplexedControlFrame(
  frame:
    | {
        readonly event: typeof MULTIPLEXED_CONNECTED_EVENT;
        readonly payload: MultiplexedConnectedPayload;
      }
    | { readonly event: typeof MULTIPLEXED_NODE_EVENT; readonly payload: MultiplexedNodePayload },
): string {
  return encodeSseFrame({ data: JSON.stringify(frame) });
}
