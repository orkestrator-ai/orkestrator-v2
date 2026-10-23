/**
 * Another node's events, relayed by the command node on request.
 *
 * Reads of another node's state are already generic: any command that is not
 * administrative can be routed to its owner (`invoke_on_node`). This is the
 * matching channel for its events. A client asks the command node to watch a
 * node for some event prefixes (`watch_node_events`), renews that lease while
 * it still shows the data, and receives each matching event as
 * {@link RELAYED_NODE_EVENT}, qualified by the node it came from.
 *
 * Relayed events are increments over what the client read through
 * `invoke_on_node`, never the only source of truth. A `resync` frame means
 * events from that node may have been missed (a new or reconnected stream, a
 * gap the node could not replay, a lease the command node no longer had):
 * re-read everything shown from that node.
 */

import { isBackendId, type BackendId } from "./federation.js";

export const RELAYED_NODE_EVENT = "relayed-node-event";

/** A lease lasts this long unless renewed. */
export const NODE_EVENT_WATCH_TTL_MS = 90_000;
/** Clients renew well inside the lease. */
export const NODE_EVENT_WATCH_RENEW_MS = 30_000;
export const MAX_NODE_EVENT_WATCHES = 256;
export const MAX_NODE_EVENT_PREFIXES = 32;
export const MAX_NODE_EVENT_PREFIX_LENGTH = 128;
const MAX_WATCH_ID_LENGTH = 64;

/**
 * Never relayed. Terminal output has its own snapshot protocol and volume,
 * and relaying the relay would loop through a command node acting as a leaf.
 */
export const UNRELAYABLE_EVENT_PREFIXES: readonly string[] = [
  "terminal-output-",
  RELAYED_NODE_EVENT,
];

export type RelayedNodeEvent =
  | { nodeId: BackendId; kind: "event"; event: string; payload: unknown }
  | { nodeId: BackendId; kind: "resync" };

export interface NodeEventWatchResult {
  watchId: string;
  expiresAt: number;
  /** False when the command node did not hold this lease (for example after a restart). */
  renewed: boolean;
}

export function isRelayableEvent(event: string): boolean {
  return !UNRELAYABLE_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix));
}

/** A prefix that could match an unrelayable event (`terminal` would) is refused. */
function isRelayablePrefix(prefix: string): boolean {
  return !UNRELAYABLE_EVENT_PREFIXES.some(
    (denied) => denied.startsWith(prefix) || prefix.startsWith(denied),
  );
}

/** Validated, de-duplicated and sorted, or a thrown message naming the problem. */
export function parseNodeEventPrefixes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Expected prefixes to be a non-empty list of event names or prefixes.");
  }
  if (value.length > MAX_NODE_EVENT_PREFIXES) {
    throw new Error(`At most ${MAX_NODE_EVENT_PREFIXES} event prefixes can be watched at once.`);
  }
  const prefixes = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_NODE_EVENT_PREFIX_LENGTH ||
      !/^[\w.:/-]+$/.test(entry)
    ) {
      throw new Error("Expected each event prefix to be a short event name.");
    }
    if (!isRelayablePrefix(entry)) {
      throw new Error(`Events starting with "${entry}" are not relayed from other nodes.`);
    }
    prefixes.add(entry);
  }
  return [...prefixes].sort();
}

export function isNodeEventWatchId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_WATCH_ID_LENGTH &&
    /^[\w-]+$/.test(value)
  );
}

export function isRelayedNodeEvent(value: unknown): value is RelayedNodeEvent {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  if (!isBackendId(frame.nodeId)) return false;
  if (frame.kind === "resync") return true;
  return (
    frame.kind === "event" &&
    typeof frame.event === "string" &&
    frame.event.length > 0 &&
    frame.event.length <= MAX_NODE_EVENT_PREFIX_LENGTH &&
    /^[\w.:/-]+$/.test(frame.event) &&
    isRelayableEvent(frame.event) &&
    "payload" in frame
  );
}
