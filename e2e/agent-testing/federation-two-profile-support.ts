/**
 * Pure helpers for `federation-two-profile.spec.ts` (to-dos 2190 (retired)
 * task 3 and 5840 (retired) tasks 1–2) and its loopback model
 * (`federation-two-profile-fake-model.ts`). Kept free of Playwright and
 * process state so `federation-two-profile-support.test.ts` can run them in
 * the default suite.
 *
 * Nothing here keeps a prompt, a payload body or a credential: frames are
 * reduced to event names, node ids and frame kinds.
 */
import { RELAYED_NODE_EVENT, RELAYED_NODE_EVENT_PREFIX } from "@orkestrator/protocol/node-events";

export const FAKE_MODEL_ID = "federation-hold-1";
export const PI_PROVIDER = "federation-fake";
export const MODEL_REF = `${PI_PROVIDER}/${FAKE_MODEL_ID}`;

/** A request whose latest user message carries this is parked until `POST /__release`. */
export const HOLD_MARKER = "[federation-two-profile:hold]";

/** The gateway's event stream path and its per-node opt-in (`GATEWAY_RELAYED_EVENTS_PARAM`). */
export const EVENTS_PATH = "/__orkestrator/events";
export const RELAYED_EVENTS_PARAM = "relayedEvents";

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

function latestUserText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | null;
    if (message?.role === "user") return messageText(message.content);
  }
  return undefined;
}

/** Whether the fake parks this request: its latest user message carries the hold marker. */
export function shouldHold(messages: unknown): boolean {
  return latestUserText(messages)?.includes(HOLD_MARKER) ?? false;
}

/** What a stream of the gateway is, by its URL. */
export type StreamKind = "main" | "relayed" | "terminal" | "other";

export interface StreamDescription {
  kind: StreamKind;
  /** The main stream asked for per-node relayed events. */
  perNode: boolean;
  /** Node ids a relayed stream's filter names, sorted. */
  relayedNodes: string[];
}

/**
 * Reads a stream URL the way the gateway does (`gateway-handlers.ts`): a
 * stream whose `includeEvents` are all per-node relayed names is a relayed
 * stream; one with no filter but `excludeEvents` is the main stream; one that
 * includes only `terminal-output-` names is a terminal stream.
 */
export function describeStream(url: string): StreamDescription {
  const parsed = new URL(url, "http://loopback.invalid");
  if (parsed.pathname !== EVENTS_PATH) return { kind: "other", perNode: false, relayedNodes: [] };
  const included = (parsed.searchParams.get("includeEvents") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const perNode = parsed.searchParams.get(RELAYED_EVENTS_PARAM) === "per-node";
  if (included.length === 0) return { kind: "main", perNode, relayedNodes: [] };
  if (included.every((name) => name.startsWith(RELAYED_NODE_EVENT_PREFIX))) {
    return {
      kind: "relayed",
      perNode: false,
      relayedNodes: included.map((name) => name.slice(RELAYED_NODE_EVENT_PREFIX.length)).sort(),
    };
  }
  if (included.every((name) => name.startsWith("terminal-output-"))) {
    return { kind: "terminal", perNode: false, relayedNodes: [] };
  }
  return { kind: "other", perNode, relayedNodes: [] };
}

/**
 * The main stream URL as a renderer from before per-node relayed names sends
 * it (no `relayedEvents`; `web-gateway.ts` at `1e6d56391`), or null when the
 * URL is not a main stream asking for per-node names. A command node from
 * before them ignores the parameter, so stripping it is also what an older
 * command node sees of a current renderer's request.
 */
export function legacyMainStreamUrl(url: string): string | null {
  const parsed = new URL(url);
  if (describeStream(url).kind !== "main" || !parsed.searchParams.has(RELAYED_EVENTS_PARAM)) {
    return null;
  }
  parsed.searchParams.delete(RELAYED_EVENTS_PARAM);
  return parsed.toString();
}

/**
 * A `watch_node_events` answer as a command node from before per-node names
 * gives it: no `perNodeEvents`. Any other invoke answer is returned as is.
 */
export function withoutPerNodeEvents(command: unknown, body: unknown): unknown {
  if (command !== "watch_node_events" || !body || typeof body !== "object") return body;
  const result = (body as { result?: unknown }).result;
  if (!result || typeof result !== "object") return body;
  const { perNodeEvents: _perNodeEvents, ...rest } = result as Record<string, unknown>;
  return { ...(body as Record<string, unknown>), result: rest };
}

/** One gateway frame, reduced to what evidence may hold. */
export interface FrameFacts {
  /** The frame's event name; `relayed-node-event:<id>` keeps its node id. */
  event: string;
  /** For a relayed frame (either name): the node it came from. */
  nodeId?: string;
  /** For a relayed frame: `event` or `resync`. */
  relayedKind?: string;
  /** For a relayed `event` frame: the leaf's own event name. */
  relayedEvent?: string;
}

/** Reads one SSE `data` field; null for anything that is not a gateway frame. */
export function frameFacts(data: string): FrameFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { event, payload } = parsed as { event?: unknown; payload?: unknown };
  if (typeof event !== "string") return null;
  const facts: FrameFacts = { event };
  if (event === RELAYED_NODE_EVENT || event.startsWith(RELAYED_NODE_EVENT_PREFIX)) {
    const relayed = (payload ?? {}) as { nodeId?: unknown; kind?: unknown; event?: unknown };
    if (typeof relayed.nodeId === "string") facts.nodeId = relayed.nodeId;
    if (typeof relayed.kind === "string") facts.relayedKind = relayed.kind;
    if (typeof relayed.event === "string") facts.relayedEvent = relayed.event;
  }
  return facts;
}

/** Whether a frame carries another node's event under either relayed name. */
export function isRelayedFrame(facts: FrameFacts): boolean {
  return facts.event === RELAYED_NODE_EVENT || facts.event.startsWith(RELAYED_NODE_EVENT_PREFIX);
}

/** How far behind one view was, per transition, in milliseconds. */
export interface LagSummary {
  count: number;
  minMs: number;
  medianMs: number;
  maxMs: number;
}

export function lagSummary(samples: readonly number[]): LagSummary {
  if (samples.length === 0) return { count: 0, minMs: 0, medianMs: 0, maxMs: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    count: sorted.length,
    minMs: sorted[0]!,
    medianMs: Math.round(median),
    maxMs: sorted[sorted.length - 1]!,
  };
}
