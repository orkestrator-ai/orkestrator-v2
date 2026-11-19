/**
 * The push event layer's wire contract (docs/architecture/push-events.md).
 *
 * A client subscribes to topic keys over its existing authoritative event
 * stream. The gateway then sends that connection `push.changed` frames: change
 * signals naming a topic, a key, the owner's stamp and which parts moved. The
 * client reads the data it needs with the conditional reads it already has, so
 * a frame never carries data (invariant 12) and a lost frame costs one read.
 *
 * - `gateway.connected` advertises the layer with `push: { versions, streamId }`.
 *   A backend that predates it sends no `push`, and the client keeps polling.
 * - `push_set_subscriptions` replaces the connection's whole set. It registers
 *   before it reads stamps (subscribe before snapshot, invariant 7) and answers
 *   `seqBase`, the last `seq` sent before the set took effect.
 * - `seq` is contiguous for the life of a connection, across set changes. A
 *   gap means the backend dropped frames for this connection; the client
 *   re-sends its set, and the answer's stamps say what moved.
 * - `push.resync` replaces frames the backend could not hold (its pending
 *   bound) and consumes a `seq` like any frame.
 * - Relayed nodes (design D10): a set with `nodeId` is for that node's keys,
 *   held by the command node's subscription controller, in its own
 *   namespace with its own `setRevision` order. Its changes carry `nodeId`,
 *   its resyncs name it, and the offer says `nodes: true` when it is taken.
 *
 * Browser-safe: no Node or Bun imports.
 */

export const PUSH_PROTOCOL_VERSION = 1;
export const PUSH_PROTOCOL_VERSIONS: readonly number[] = [PUSH_PROTOCOL_VERSION];

/** A batch of change signals for one connection. Never in the replay ring. */
export const PUSH_CHANGED_EVENT = "push.changed";
/** The backend could not hold this connection's pending changes. */
export const PUSH_RESYNC_EVENT = "push.resync";
/**
 * Synthesized by the client transport, never sent by the gateway: a
 * {@link PushStreamState} for every `gateway.connected` frame and every time
 * the main stream stops being connected. A listener that attaches while the
 * stream is up is told the current state at once.
 */
export const PUSH_STREAM_STATE_EVENT = "push-stream-state";

export type PushStreamState =
  /** `offer` is `null` from a backend that does not offer push on this stream. */
  { state: "connected"; offer: PushStreamOffer | null } | { state: "disconnected" };

export const PUSH_SET_SUBSCRIPTIONS_COMMAND = "push_set_subscriptions";

/** Topics this protocol version defines. A later surface adds one. */
export const PUSH_TOPICS = ["native-session", "environment", "tool-output", "workflow"] as const;
export type PushTopic = (typeof PUSH_TOPICS)[number];
export const NATIVE_SESSION_PUSH_TOPIC = "native-session" satisfies PushTopic;

/** Parts of a `native-session` key a frame can name. */
export const NATIVE_SESSION_PUSH_PARTS = ["transcript", "state", "discovery"] as const;
export type NativeSessionPushPart = (typeof NATIVE_SESSION_PUSH_PARTS)[number];

/**
 * One environment's lifecycle and attention summary; the key is the
 * environment id (docs/architecture/push-events.md, "The `environment` topic").
 */
export const ENVIRONMENT_PUSH_TOPIC = "environment" satisfies PushTopic;

/**
 * Parts of an `environment` key a frame can name:
 *
 * - `lifecycle`: the environment record's lifecycle (status, container,
 *   setup, deletion) or its container lifecycle snapshot's revision;
 * - `attention`: what waits on the user there (the agent registry's waiting
 *   tabs and their pending requests, the record's activity and unread fields);
 * - `sessions`: the agent registry's per-environment tab counts.
 */
export const ENVIRONMENT_PUSH_PARTS = ["lifecycle", "attention", "sessions"] as const;
export type EnvironmentPushPart = (typeof ENVIRONMENT_PUSH_PARTS)[number];

/** An environment id as an `environment` key: the id itself, at most 128 characters. */
export function isEnvironmentPushKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(key);
}

export interface PushLimits {
  maxSubscriptions: number;
  maxTopics: number;
  maxKeyBytes: number;
  maxPendingEntries: number;
  maxPendingBytes: number;
  maxFrameChanges: number;
  maxFrameBytes: number;
  maxParts: number;
  maxPartBytes: number;
}

/** Per-connection bounds (design D6). Every queue the layer keeps is bounded. */
export const PUSH_LIMITS: Readonly<PushLimits> = Object.freeze({
  maxSubscriptions: 512,
  maxTopics: 16,
  maxKeyBytes: 1_024,
  maxPendingEntries: 512,
  maxPendingBytes: 256 * 1024,
  maxFrameChanges: 64,
  maxFrameBytes: 16 * 1024,
  maxParts: 8,
  maxPartBytes: 32,
});

/** Wire budget for a complete set, including its command envelope. */
export const PUSH_SUBSCRIPTION_BODY_BYTES = 1024 * 1024;

/** Push frames are connection-local SSE control frames without a replay id. */
export function formatPushFrame(event: string, payload: unknown): string {
  return `data: ${JSON.stringify({ event, payload })}\n\n`;
}

/** Changes arriving together within this window share one frame. */
export const PUSH_COALESCE_MS = 50;
/**
 * A key that keeps changing is announced at most this often (leading edge).
 * The same spacing bounds how often a bridge hint may make the backend read
 * a session (`NATIVE_SESSION_BRIDGE_WAKE_FLOOR_MS`). The 250 ms p95 target for
 * a streamed delta (to-do 8102 task 7) set it: a delta waits up to one
 * spacing for the next read and frame, plus the frames' 50 ms offset from the
 * leading edge's coalescing window. 200 ms measured a p95 of 250.6 ms; 150 ms
 * keeps it near 200.
 */
export const PUSH_KEY_THROTTLE_MS = 150;
/** While its write buffer is over the soft limit a connection is retried this often. */
export const PUSH_BACKPRESSURE_RETRY_MS = 250;
/**
 * A view whose subscription is healthy still reads this often, as the safety
 * net for a change no frame announced (design D8).
 */
export const PUSH_RECOVERY_POLL_MS = 30_000;

export interface PushSubscriptionRequest {
  topic: string;
  key: string;
}

export interface PushSetSubscriptionsArgs {
  /** From the connection's `gateway.connected` frame. */
  streamId: string;
  /** Orders the client's set replacements; an older one is ignored. */
  setRevision: number;
  subscriptions: PushSubscriptionRequest[];
  /**
   * The node whose keys these are, reached through this command node's
   * subscription controller (design D10). Absent means this backend's own
   * keys. Each node id is its own namespace on the connection, with its own
   * `setRevision` order, so a window's local set and its per-node sets never
   * replace each other. Only sent to a stream whose offer says `nodes: true`.
   */
  nodeId?: string;
}

export type PushSubscriptionDenial = "limit" | "unknown-topic" | "invalid-key";

export interface PushStamp {
  /** The topic owner's lifetime for this key. Compared only for equality. */
  generation: string;
  /** Ordered within one generation of one key. */
  revision: number;
}

export type PushSubscriptionAnswer =
  | ({ topic: string; key: string; status: "ok" } & PushStamp)
  | { topic: string; key: string; status: "denied"; reason: PushSubscriptionDenial }
  | { topic: string; key: string; status: "missing" };

export type PushSetSubscriptionsResult =
  | {
      status: "applied";
      setRevision: number;
      /** The last `seq` this connection had been sent when the set took effect. */
      seqBase: number;
      subscriptions: PushSubscriptionAnswer[];
    }
  /** A newer `setRevision` was already applied; this answer changes nothing. */
  | { status: "superseded"; setRevision: number }
  /**
   * The stream is not this caller's, has closed, or this path cannot reach a
   * stream (an in-process caller). The client stays on its polling cadence.
   */
  | { status: "refused"; reason: "stream-unknown" | "unavailable" };

export interface PushChange extends PushStamp {
  topic: string;
  key: string;
  /** Which reads moved. Unknown or empty parts mean "read everything". */
  parts: string[];
  /**
   * The node the key belongs to, for a key subscribed with that `nodeId`
   * (design D10). Absent for the backend's own keys.
   */
  nodeId?: string;
}

export interface PushChangedPayload {
  seq: number;
  changes: PushChange[];
}

export type PushResyncReason = "pending-bound" | "topic-reset" | "node-reset";

export interface PushResyncPayload {
  seq: number;
  reason: PushResyncReason;
  /** The topics whose keys must all be re-read, or every subscribed key. */
  topics: string[] | "all";
  /**
   * Only that node's namespace must re-read (`node-reset`: the command node
   * lost frames from it). Absent: every namespace of the connection.
   */
  nodeId?: string;
}

/** What `gateway.connected` carries when the backend offers push on the stream. */
export interface PushStreamOffer {
  versions: number[];
  streamId: string;
  /**
   * The backend accepts `nodeId` sets for nodes it relays (design D10). A
   * client never sends one to a stream that does not say so.
   */
  nodes?: boolean;
}

const STREAM_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export function parsePushStreamState(value: unknown): PushStreamState | null {
  if (!isRecord(value)) return null;
  if (value.state === "disconnected") return { state: "disconnected" };
  if (value.state !== "connected") return null;
  // An offer this client cannot use is the same as none: it keeps polling.
  return { state: "connected", offer: parsePushStreamOffer({ push: value.offer }) };
}

export function isPushStreamId(value: unknown): value is string {
  return typeof value === "string" && STREAM_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** UTF-8 byte length, browser-safe. */
export function pushUtf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** The push offer in a `gateway.connected` payload, or `null` if there is none we speak. */
export function parsePushStreamOffer(connectedPayload: unknown): PushStreamOffer | null {
  if (!isRecord(connectedPayload)) return null;
  const push = connectedPayload.push;
  if (!isRecord(push) || !isPushStreamId(push.streamId) || !Array.isArray(push.versions)) {
    return null;
  }
  const versions = push.versions.filter(isNonNegativeInteger);
  if (!versions.includes(PUSH_PROTOCOL_VERSION)) return null;
  return { versions, streamId: push.streamId, ...(push.nodes === true ? { nodes: true } : {}) };
}

/** A node id on a push frame or set: the shape of a backend identity (`federation.ts`). */
const PUSH_NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u;

export function isPushNodeId(value: unknown): value is string {
  return typeof value === "string" && PUSH_NODE_ID_PATTERN.test(value);
}

function parseChange(value: unknown): PushChange | null {
  if (!isRecord(value)) return null;
  const { topic, key, generation, revision, parts, nodeId } = value;
  if (nodeId !== undefined && !isPushNodeId(nodeId)) return null;
  if (typeof topic !== "string" || typeof key !== "string" || typeof generation !== "string") {
    return null;
  }
  if (!isNonNegativeInteger(revision)) return null;
  const partList = Array.isArray(parts)
    ? parts
        .filter((part): part is string => typeof part === "string")
        .slice(0, PUSH_LIMITS.maxParts)
    : [];
  return {
    topic,
    key,
    generation,
    revision,
    parts: partList,
    ...(nodeId === undefined ? {} : { nodeId }),
  };
}

export function parsePushChangedPayload(value: unknown): PushChangedPayload | null {
  if (!isRecord(value) || !isNonNegativeInteger(value.seq) || value.seq < 1) return null;
  if (!Array.isArray(value.changes)) return null;
  const changes: PushChange[] = [];
  for (const raw of value.changes.slice(0, PUSH_LIMITS.maxFrameChanges)) {
    const change = parseChange(raw);
    if (change) changes.push(change);
  }
  return { seq: value.seq, changes };
}

export function parsePushResyncPayload(value: unknown): PushResyncPayload | null {
  if (!isRecord(value) || !isNonNegativeInteger(value.seq) || value.seq < 1) return null;
  const reason: PushResyncReason =
    value.reason === "topic-reset" || value.reason === "node-reset"
      ? value.reason
      : "pending-bound";
  const topics =
    value.topics === "all" || !Array.isArray(value.topics)
      ? ("all" as const)
      : value.topics.filter((topic): topic is string => typeof topic === "string");
  // A resync naming a node this client cannot read applies to every
  // namespace: re-reading too much is safe, missing one is not.
  const nodeId = isPushNodeId(value.nodeId) ? value.nodeId : undefined;
  return { seq: value.seq, reason, topics, ...(nodeId === undefined ? {} : { nodeId }) };
}

/** The compound map key of a subscription. Topic names contain no NUL. */
export function pushSubscriptionId(topic: string, key: string): string {
  return `${topic}\u0000${key}`;
}

// ---------------------------------------------------------------------------
// The `native-session` topic
// ---------------------------------------------------------------------------

export interface NativeSessionPushKey {
  environmentId: string;
  agent: string;
  logicalSessionKey: string;
}

/**
 * `<environmentId>/<agent>/<logicalSessionKey>`. The environment id and the
 * agent never contain `/`; the logical session key is everything after the
 * second one.
 */
export function formatNativeSessionPushKey(key: NativeSessionPushKey): string {
  return `${key.environmentId}/${key.agent}/${key.logicalSessionKey}`;
}

export function parseNativeSessionPushKey(key: string): NativeSessionPushKey | null {
  if (pushUtf8Bytes(key) > PUSH_LIMITS.maxKeyBytes) return null;
  const first = key.indexOf("/");
  if (first <= 0) return null;
  const second = key.indexOf("/", first + 1);
  if (second <= first + 1 || second === key.length - 1) return null;
  const environmentId = key.slice(0, first);
  const agent = key.slice(first + 1, second);
  const logicalSessionKey = key.slice(second + 1);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(agent)) return null;
  if (environmentId.trim() !== environmentId || logicalSessionKey.trim().length === 0) return null;
  return { environmentId, agent, logicalSessionKey };
}

// ---------------------------------------------------------------------------
// The `tool-output` topic
// ---------------------------------------------------------------------------

/**
 * One tool call's output in a native session; an expanded, running row
 * subscribes to it (docs/architecture/push-events.md, "The `tool-output`
 * topic"). The frame says the output moved; the row reads it with the bounded
 * `get_native_agent_tool_output`.
 */
export const TOOL_OUTPUT_PUSH_TOPIC = "tool-output" satisfies PushTopic;
/** The only part a `tool-output` frame names. */
export const TOOL_OUTPUT_PUSH_PARTS = ["output"] as const;
export type ToolOutputPushPart = (typeof TOOL_OUTPUT_PUSH_PARTS)[number];
/** A tool call id longer than this (UTF-8) makes no key. */
export const TOOL_OUTPUT_PUSH_TOOL_ID_MAX_BYTES = 256;

export interface ToolOutputPushKey extends NativeSessionPushKey {
  toolUseId: string;
}

/**
 * `<environmentId>/<agent>/<logicalSessionKey>/<encoded toolUseId>`. The tool
 * call id is percent-encoded, so it holds no `/` and the last one splits it
 * from the session key (which may itself contain `/`).
 */
export function formatToolOutputPushKey(key: ToolOutputPushKey): string {
  return `${formatNativeSessionPushKey(key)}/${encodeURIComponent(key.toolUseId)}`;
}

export function parseToolOutputPushKey(key: string): ToolOutputPushKey | null {
  if (pushUtf8Bytes(key) > PUSH_LIMITS.maxKeyBytes) return null;
  const last = key.lastIndexOf("/");
  if (last <= 0 || last === key.length - 1) return null;
  const encoded = key.slice(last + 1);
  let toolUseId: string;
  try {
    toolUseId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  // One spelling per call, so two keys never name the same output.
  if (encodeURIComponent(toolUseId) !== encoded || toolUseId.trim().length === 0) return null;
  if (pushUtf8Bytes(toolUseId) > TOOL_OUTPUT_PUSH_TOOL_ID_MAX_BYTES) return null;
  const session = parseNativeSessionPushKey(key.slice(0, last));
  return session ? { ...session, toolUseId } : null;
}

// ---------------------------------------------------------------------------
// The `workflow` topic
// ---------------------------------------------------------------------------

/**
 * One workflow run's status summary: a build pipeline, a Multi Review or a
 * graph run (docs/architecture/push-events.md, "The `workflow` topic"). The
 * frame says the run's record moved; the view reads it with the read it
 * already has. Completion is whatever that read says, never the frame.
 */
export const WORKFLOW_PUSH_TOPIC = "workflow" satisfies PushTopic;
/** The workflow kinds a key can name; each is also its `resource-changed` kind. */
export const WORKFLOW_PUSH_KINDS = ["build-pipeline", "multi-review", "graph-run"] as const;
export type WorkflowPushKind = (typeof WORKFLOW_PUSH_KINDS)[number];
/**
 * `progress`: the run's record moved (every change names it). `status`: its
 * phase or status changed. `result`: it entered or left a terminal phase.
 */
export const WORKFLOW_PUSH_PARTS = ["status", "progress", "result"] as const;
export type WorkflowPushPart = (typeof WORKFLOW_PUSH_PARTS)[number];
/** A run id longer than this (UTF-8) makes no key. */
export const WORKFLOW_PUSH_ID_MAX_BYTES = 256;

export interface WorkflowPushKey {
  kind: WorkflowPushKind;
  id: string;
}

/** `<kind>/<id>`, e.g. `build-pipeline/<pipelineId>`. */
export function formatWorkflowPushKey(key: WorkflowPushKey): string {
  return `${key.kind}/${key.id}`;
}

export function isWorkflowPushKind(value: unknown): value is WorkflowPushKind {
  return (WORKFLOW_PUSH_KINDS as readonly unknown[]).includes(value);
}

export function parseWorkflowPushKey(key: string): WorkflowPushKey | null {
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const kind = key.slice(0, slash);
  const id = key.slice(slash + 1);
  if (!isWorkflowPushKind(kind)) return null;
  // One spelling per run: no separator, whitespace or control characters.
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  if (id.length === 0 || !/^[^\s/\u0000-\u001f\u007f]+$/u.test(id)) return null;
  if (pushUtf8Bytes(id) > WORKFLOW_PUSH_ID_MAX_BYTES) return null;
  return { kind, id };
}
