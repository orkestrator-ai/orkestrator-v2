/**
 * The browser half of the multiplexed relay event stream (plan item 5005,
 * report §6.2 "Connection budget"; the wire format is in
 * `@orkestrator/protocol/multiplexed-relay-events`).
 *
 * Over plain HTTP/1.1 every relayed leaf's main stream holds one of the six
 * connections the browser allows to the command node's origin, and the
 * window's own streams already hold four (plan item 2013). With two or more
 * relayed leaves warm, their main streams share one request instead.
 *
 * Each relayed node's transport keeps its own main stream logic (cursor,
 * watchdog, backoff, credential probe, connection state); only the request
 * under it changes. `opener(nodeId, workspaceId)` is the transport's
 * `openMainStream`: it answers either the transport's own `fetch`, or a
 * `Response` whose body is that node's frames, taken off the shared request
 * and re-framed as the node sent them. The node's own replay contract is
 * unchanged, because each leaf frame (its `gateway.connected`, cursors and
 * reconcile frames included) reaches its transport as it left the leaf.
 *
 * - **When.** A node goes onto the shared request once at least
 *   {@link MIN_MULTIPLEXED_NODES} relayed nodes want a main stream at the same
 *   time (warm or live: a suspended scope has closed its streams). The nodes
 *   already on their own streams are then moved over (`reconnect`). A node
 *   stays on the shared request while it is open; one node costs one request
 *   either way.
 * - **Older command node.** A 404 or 405 means it predates the route: every
 *   node of that command node uses its own stream for the rest of the page
 *   (register row "Command nodes without the multiplexed relay stream").
 *   Another failure answer, or none (a blocked path, a connect timeout),
 *   falls back the same way for a while
 *   ({@link MULTIPLEXED_FALLBACK_COOLDOWN_MS}), then tries again.
 * - **Refused node.** A node the command node refuses (no workspace for it)
 *   uses its own stream until its workspace changes.
 * - **One node's trouble.** A node the command node reports `down` gets its
 *   stream failed, so its transport shows the outage and retries on its own
 *   backoff; it re-attaches to the same shared request.
 * - **Set changes** (a node joins, leaves after {@link DETACH_GRACE_MS}, or
 *   needs its own cursor sent again) reopen the shared request once, after
 *   {@link REOPEN_DELAY_MS}, with every node's cursor: the leaves replay what
 *   the switch missed. A frame that reaches a node between its transport's
 *   streams is held (bounded) and handed to the next one; past the bound the
 *   node's cursor is sent again instead, so nothing is lost silently
 *   (invariants 4 and 6).
 *
 * Bounds (invariant 11): at most `MAX_MULTIPLEXED_NODES` nodes per request,
 * the shared frame size (`MAX_MULTIPLEXED_FRAME_BYTES`), each node's unread
 * bytes ({@link MAX_NODE_QUEUED_BYTES}, past which that node's stream fails
 * and resumes from its cursor) and held frames ({@link MAX_HELD_BYTES},
 * {@link MAX_HELD_FRAMES}).
 *
 * Effect: not used. This is callback-driven stream plumbing under an existing
 * imperative transport, with its own single reconnect timer like every other
 * stream owner (`ReconnectBackoff`); a fiber per request would add a runtime
 * boundary with nothing to compose.
 */
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  GATEWAY_EVENT_CURSOR_PARAM,
  GATEWAY_STREAM_CONNECT_TIMEOUT_MS,
  GATEWAY_STREAM_SILENCE_LIMIT_MS,
  SseFrameDecoder,
} from "@orkestrator/protocol/gateway-event-stream";
import {
  encodeSseFrame,
  MAX_MULTIPLEXED_FRAME_BYTES,
  MAX_MULTIPLEXED_NODES,
  MULTIPLEXED_RELAY_EVENTS_PATH,
  multiplexedEventsQuery,
  multiplexedFrameNode,
  parseMultiplexedControlFrame,
} from "@orkestrator/protocol/multiplexed-relay-events";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";
import type { MainStreamControl, MainStreamOpener } from "@/lib/native/node-transport";

/** Relayed nodes that must want a main stream at once before they share one. */
export const MIN_MULTIPLEXED_NODES = 2;
/** Joins and leaves within this long cost one reopen of the shared request. */
export const REOPEN_DELAY_MS = 50;
/** A node whose transport closed its stream stays on the request this long. */
export const DETACH_GRACE_MS = 5_000;
/** After a failure answer other than 404/405, nodes use their own streams this long. */
export const MULTIPLEXED_FALLBACK_COOLDOWN_MS = 60_000;
/** Unread bytes one node's stream may hold before it fails and resumes. */
export const MAX_NODE_QUEUED_BYTES = 8 * 1024 * 1024;
/** Frames held for a node between its transport's streams. */
export const MAX_HELD_BYTES = 256 * 1024;
export const MAX_HELD_FRAMES = 512;

const RELAY_SEGMENT = "/__orkestrator/nodes/";
const KEEPALIVE_CHUNK = ": keepalive\n\n";

export interface MultiplexedRelayStreamsOptions {
  readonly fetch?: typeof fetch;
  readonly minNodes?: number;
  readonly maxNodes?: number;
  readonly reopenDelayMs?: number;
  readonly detachGraceMs?: number;
  readonly fallbackCooldownMs?: number;
  readonly maxNodeQueuedBytes?: number;
  readonly maxHeldBytes?: number;
  readonly maxHeldFrames?: number;
  readonly connectTimeoutMs?: number;
  readonly silenceMs?: number;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface MultiplexedRelayStreamsSnapshot {
  readonly groups: ReadonlyArray<{
    readonly base: string;
    readonly unsupported: boolean;
    readonly open: boolean;
    readonly requests: number;
    readonly nodes: ReadonlyArray<{
      readonly nodeId: BackendId;
      readonly mode: "own" | "shared" | "idle";
      readonly state: "pending" | "live" | "down" | "refused";
    }>;
  }>;
}

export interface MultiplexedRelayStreams {
  /**
   * The `openMainStream` for one relayed node's transport. `workspaceId` is
   * read on every open: the workspace this window holds for the node, or
   * `null` when it holds none (the node then uses its own stream).
   */
  opener(nodeId: BackendId, workspaceId: () => string | null): MainStreamOpener;
  /** The node's workspace changed: send it on the shared request again. */
  refresh(nodeId: BackendId): void;
  snapshot(): MultiplexedRelayStreamsSnapshot;
  /** Ends the shared requests and every node stream on them. Idempotent. */
  dispose(): void;
}

interface Attachment {
  readonly url: string;
  readonly init: RequestInit;
  stream: ReadableStream<Uint8Array> | null;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** Resolves the transport's open; null once answered. */
  answer: ((response: Response | Error) => void) | null;
  ended: boolean;
}

interface Member {
  readonly nodeId: BackendId;
  workspaceId: () => string | null;
  /** The node's transport, to move its own stream onto the shared request. */
  control: MainStreamControl | null;
  /** The node's own stream is open (not shared). */
  ownActive: number;
  attachment: Attachment | null;
  /** On the wanted set of the shared request (attached, or in its grace). */
  wanted: boolean;
  /** Where the node resumes: the last cursor its transport was given. */
  cursor: string | null;
  /** The workspace sent on the current shared request, if it carries the node. */
  sentWorkspace: string | null;
  /** The current request must be reopened to send this node's cursor again. */
  resubscribe: boolean;
  state: "pending" | "live" | "down" | "refused";
  refusedWorkspace: string | null;
  held: string[];
  heldBytes: number;
  /** The cursor of the last held frame, the node's once they are handed over. */
  pendingCursor: string | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
}

interface SharedRequest {
  readonly abort: AbortController;
  readonly nodes: ReadonlySet<BackendId>;
  open: boolean;
  planned: boolean;
}

interface Group {
  readonly base: string;
  readonly members: Map<BackendId, Member>;
  unsupported: boolean;
  cooldownUntil: number;
  shared: SharedRequest | null;
  reopenTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  readonly backoff: ReconnectBackoff;
  init: RequestInit;
  requests: number;
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** The command node's base of a relayed URL (`<base>/__orkestrator/nodes/<id>/…`), or null. */
function relayGroupBase(url: string): string | null {
  const index = url.indexOf(RELAY_SEGMENT);
  if (index < 0) return null;
  const rest = url.slice(index + RELAY_SEGMENT.length);
  if (!rest.includes("/")) return null;
  return url.slice(0, index);
}

function cursorOf(url: string): string | null {
  try {
    return (
      new URL(url, "http://relay.invalid").searchParams.get(GATEWAY_EVENT_CURSOR_PARAM) || null
    );
  } catch {
    return null;
  }
}

export function createMultiplexedRelayStreams(
  options: MultiplexedRelayStreamsOptions = {},
): MultiplexedRelayStreams {
  const fetchImpl = (...args: Parameters<typeof fetch>) => (options.fetch ?? fetch)(...args);
  const minNodes = options.minNodes ?? MIN_MULTIPLEXED_NODES;
  const maxNodes = Math.min(options.maxNodes ?? MAX_MULTIPLEXED_NODES, MAX_MULTIPLEXED_NODES);
  const reopenDelayMs = options.reopenDelayMs ?? REOPEN_DELAY_MS;
  const detachGraceMs = options.detachGraceMs ?? DETACH_GRACE_MS;
  const fallbackCooldownMs = options.fallbackCooldownMs ?? MULTIPLEXED_FALLBACK_COOLDOWN_MS;
  const maxNodeQueuedBytes = options.maxNodeQueuedBytes ?? MAX_NODE_QUEUED_BYTES;
  const maxHeldBytes = options.maxHeldBytes ?? MAX_HELD_BYTES;
  const maxHeldFrames = options.maxHeldFrames ?? MAX_HELD_FRAMES;
  const connectTimeoutMs = options.connectTimeoutMs ?? GATEWAY_STREAM_CONNECT_TIMEOUT_MS;
  const silenceMs = options.silenceMs ?? GATEWAY_STREAM_SILENCE_LIMIT_MS;
  const now = options.now ?? Date.now;
  const encoder = new TextEncoder();
  const groups = new Map<string, Group>();
  let disposed = false;

  const groupFor = (base: string, init: RequestInit): Group => {
    let group = groups.get(base);
    if (!group) {
      group = {
        base,
        members: new Map(),
        unsupported: false,
        cooldownUntil: 0,
        shared: null,
        reopenTimer: null,
        retryTimer: null,
        backoff: new ReconnectBackoff(
          {
            initialDelayMs: options.reconnectInitialDelayMs ?? 1_000,
            maxDelayMs: options.reconnectMaxDelayMs ?? 16_000,
            healthyAfterMs: 30_000,
          },
          { random: options.random, now },
        ),
        init,
        requests: 0,
      };
      groups.set(base, group);
    }
    return group;
  };

  const memberFor = (
    group: Group,
    nodeId: BackendId,
    workspaceId: () => string | null,
    control: MainStreamControl,
  ) => {
    let member = group.members.get(nodeId);
    if (!member) {
      member = {
        nodeId,
        workspaceId,
        control,
        ownActive: 0,
        attachment: null,
        wanted: false,
        cursor: null,
        sentWorkspace: null,
        resubscribe: false,
        state: "pending",
        refusedWorkspace: null,
        held: [],
        heldBytes: 0,
        pendingCursor: null,
        graceTimer: null,
      };
      group.members.set(nodeId, member);
    }
    member.workspaceId = workspaceId;
    member.control = control;
    return member;
  };

  const sharedUsable = (group: Group) =>
    !disposed && !group.unsupported && now() >= group.cooldownUntil;

  /** Nodes wanting a main stream right now, on either path. */
  const activeNodes = (group: Group) =>
    Array.from(group.members.values()).filter((member) => member.ownActive > 0 || member.wanted);

  const clearHeld = (member: Member) => {
    member.held = [];
    member.heldBytes = 0;
    member.pendingCursor = null;
  };

  const clearGrace = (member: Member) => {
    if (member.graceTimer) clearTimeout(member.graceTimer);
    member.graceTimer = null;
  };

  /** Ends an attachment's stream; an unanswered open is answered with `failure`. */
  const endAttachment = (member: Member, attachment: Attachment, failure: Error | null) => {
    if (attachment.ended) return;
    attachment.ended = true;
    if (member.attachment === attachment) member.attachment = null;
    if (attachment.answer) {
      const answer = attachment.answer;
      attachment.answer = null;
      answer(failure ?? abortError());
    }
    try {
      if (failure) attachment.controller?.error(failure);
      else attachment.controller?.close();
    } catch {
      // Already closed or errored by its reader.
    }
  };

  /** Hands a node's frame to its transport, or holds it between streams. */
  const deliver = (group: Group, member: Member, chunk: string, id: string | null) => {
    const attachment = member.attachment;
    if (!attachment || attachment.answer || !attachment.controller) {
      // Not attached (or not yet answered): hold, bounded. Past the bound the
      // node is sent again from its cursor instead.
      if (member.resubscribe) return;
      const bytes = chunk.length * 3;
      if (member.held.length >= maxHeldFrames || member.heldBytes + bytes > maxHeldBytes) {
        clearHeld(member);
        member.resubscribe = true;
        if (member.attachment) scheduleReopen(group);
        return;
      }
      member.held.push(chunk);
      member.heldBytes += bytes;
      if (id) member.pendingCursor = id;
      return;
    }
    const controller = attachment.controller;
    if ((controller.desiredSize ?? 0) <= 0) {
      // The transport is not reading: fail its stream; it resumes from the
      // cursor it last read, which differs from ours, so it is sent again.
      endAttachment(member, attachment, new Error("The node's stream fell behind."));
      return;
    }
    controller.enqueue(encoder.encode(chunk));
    if (id) member.cursor = id;
  };

  const flushHeld = (member: Member) => {
    const attachment = member.attachment;
    if (!attachment?.controller || attachment.answer) return;
    for (const chunk of member.held) attachment.controller.enqueue(encoder.encode(chunk));
    if (member.pendingCursor) member.cursor = member.pendingCursor;
    clearHeld(member);
  };

  /** Answers a node's open once the shared request carries it live. */
  const answerIfLive = (group: Group, member: Member) => {
    const attachment = member.attachment;
    const shared = group.shared;
    if (!attachment?.answer || !attachment.stream) return;
    if (!shared?.open || !shared.nodes.has(member.nodeId)) return;
    if (member.state !== "live" || member.resubscribe) return;
    const answer = attachment.answer;
    attachment.answer = null;
    answer(
      new Response(attachment.stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    flushHeld(member);
  };

  /** The node's open goes to its own `fetch` after all. */
  const answerWithOwnStream = (member: Member, attachment: Attachment) => {
    if (!attachment.answer) {
      endAttachment(
        member,
        attachment,
        new Error("The shared stream no longer carries this node."),
      );
      return;
    }
    const answer = attachment.answer;
    attachment.answer = null;
    attachment.ended = true;
    if (member.attachment === attachment) member.attachment = null;
    member.wanted = false;
    clearHeld(member);
    openOwn(member, attachment.url, attachment.init).then(answer, answer);
  };

  const openOwn = (member: Member, url: string, init: RequestInit): Promise<Response> => {
    member.ownActive += 1;
    const signal = init.signal;
    let counted = true;
    const uncount = () => {
      if (!counted) return;
      counted = false;
      member.ownActive -= 1;
    };
    // The transport aborts its signal whenever the stream ends, so this is
    // also how a stream that answered and later ended stops counting.
    if (signal?.aborted) uncount();
    else signal?.addEventListener("abort", uncount, { once: true });
    return fetchImpl(url, init).catch((error: unknown) => {
      uncount();
      throw error;
    });
  };

  const fallBackAll = (group: Group) => {
    for (const member of group.members.values()) {
      clearGrace(member);
      member.sentWorkspace = null;
      member.state = "pending";
      if (member.attachment) answerWithOwnStream(member, member.attachment);
      member.wanted = false;
      clearHeld(member);
    }
  };

  const closeShared = (group: Group) => {
    const shared = group.shared;
    if (!shared) return;
    group.shared = null;
    shared.planned = true;
    shared.abort.abort();
    for (const member of group.members.values()) {
      member.sentWorkspace = null;
      if (member.state !== "refused") member.state = "pending";
    }
  };

  const scheduleReopen = (group: Group) => {
    if (disposed || group.reopenTimer || group.retryTimer) return;
    group.reopenTimer = setTimeout(() => {
      group.reopenTimer = null;
      openShared(group);
    }, reopenDelayMs);
  };

  const scheduleRetry = (group: Group) => {
    if (disposed || group.retryTimer) return;
    if (group.reopenTimer) clearTimeout(group.reopenTimer);
    group.reopenTimer = null;
    group.retryTimer = setTimeout(() => {
      group.retryTimer = null;
      openShared(group);
    }, group.backoff.nextDelayMs());
  };

  /** A failure of the shared request: every node on it sees its stream fail. */
  const sharedFailed = (group: Group, shared: SharedRequest, error: Error) => {
    if (group.shared !== shared) return;
    group.shared = null;
    shared.abort.abort();
    for (const member of group.members.values()) {
      member.sentWorkspace = null;
      if (member.state !== "refused") member.state = "pending";
      if (member.attachment?.answer) continue;
      if (member.attachment) endAttachment(member, member.attachment, error);
    }
    if (activeNodes(group).some((member) => member.wanted)) scheduleRetry(group);
  };

  const handleControl = (group: Group, shared: SharedRequest, data: string) => {
    const frame = parseMultiplexedControlFrame(data);
    if (frame?.kind !== "node") return;
    const member = group.members.get(frame.payload.node as BackendId);
    if (!member || !shared.nodes.has(member.nodeId)) return;
    if (frame.payload.state === "live") {
      member.state = "live";
      answerIfLive(group, member);
      return;
    }
    if (frame.payload.state === "down") {
      member.state = "down";
      // Its transport shows the outage and retries on its own backoff; the
      // node stays on this request and re-attaches when the leaf is back.
      if (member.attachment && !member.attachment.answer) {
        endAttachment(member, member.attachment, new Error("The node's stream is down."));
      }
      return;
    }
    // Refused: no workspace for it here. Its own stream from now on.
    member.state = "refused";
    member.refusedWorkspace = member.sentWorkspace;
    member.sentWorkspace = null;
    member.wanted = false;
    clearGrace(member);
    clearHeld(member);
    if (member.attachment) answerWithOwnStream(member, member.attachment);
  };

  const readShared = async (
    group: Group,
    shared: SharedRequest,
    body: ReadableStream<Uint8Array>,
  ) => {
    const reader = body.getReader();
    const text = new TextDecoder();
    const frames = new SseFrameDecoder(MAX_MULTIPLEXED_FRAME_BYTES);
    let deadline = now() + silenceMs;
    const watchdog = setInterval(
      () => {
        if (now() >= deadline) shared.abort.abort();
      },
      Math.max(10, Math.floor(silenceMs / 4)),
    );
    const cancel = () => void reader.cancel().catch(() => undefined);
    shared.abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        // Replaced or closed on purpose: the new request owns every node now.
        if (group.shared !== shared) return;
        if (shared.abort.signal.aborted) {
          // The watchdog: nothing arrived for `silenceMs`, so the link is gone.
          sharedFailed(group, shared, new Error("The shared event stream went silent."));
          return;
        }
        deadline = now() + silenceMs;
        for (const frame of frames.push(text.decode(value, { stream: !done }))) {
          if (group.shared !== shared) return;
          if (!frame.data) {
            // A keepalive: every node's watchdog hears the shared request is alive.
            for (const member of group.members.values()) {
              if (member.attachment?.controller && !member.attachment.answer) {
                member.attachment.controller.enqueue(encoder.encode(KEEPALIVE_CHUNK));
              }
            }
            continue;
          }
          const nodeId = multiplexedFrameNode(frame.event);
          if (!nodeId) {
            handleControl(group, shared, frame.data);
            continue;
          }
          const member = group.members.get(nodeId);
          if (!member || !shared.nodes.has(nodeId)) continue;
          deliver(group, member, encodeSseFrame({ id: frame.id, data: frame.data }), frame.id);
        }
        if (done) break;
      }
      sharedFailed(group, shared, new Error("The shared event stream ended."));
    } catch (error) {
      if (!shared.planned) {
        sharedFailed(
          group,
          shared,
          error instanceof Error ? error : new Error("The shared event stream failed."),
        );
      }
    } finally {
      clearInterval(watchdog);
      shared.abort.signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
    }
  };

  const openShared = (group: Group) => {
    if (disposed) return;
    closeShared(group);
    if (!sharedUsable(group)) {
      fallBackAll(group);
      return;
    }
    const nodes = Array.from(group.members.values())
      .filter((member) => member.wanted)
      .flatMap((member) => {
        const workspaceId = member.workspaceId();
        if (!workspaceId) {
          if (member.attachment) answerWithOwnStream(member, member.attachment);
          return [];
        }
        return [{ member, workspaceId }];
      })
      .slice(0, maxNodes);
    if (nodes.length === 0) return;
    const abort = new AbortController();
    const shared: SharedRequest = {
      abort,
      nodes: new Set(nodes.map(({ member }) => member.nodeId)),
      open: false,
      planned: false,
    };
    group.shared = shared;
    group.requests += 1;
    for (const { member, workspaceId } of nodes) {
      member.sentWorkspace = workspaceId;
      member.resubscribe = false;
      member.state = "pending";
      // Held frames were for the previous request; this one resends from the cursor.
      clearHeld(member);
    }
    const query = multiplexedEventsQuery(
      nodes.map(({ member, workspaceId }) => ({
        nodeId: member.nodeId,
        workspaceId,
        cursor: member.cursor,
      })),
    );
    const connectTimer = setTimeout(() => abort.abort(), connectTimeoutMs);
    void (async () => {
      let response: Response;
      try {
        response = await fetchImpl(`${group.base}${MULTIPLEXED_RELAY_EVENTS_PATH}?${query}`, {
          credentials: group.init.credentials ?? "same-origin",
          ...(group.init.headers ? { headers: group.init.headers } : {}),
          signal: abort.signal,
        });
      } catch {
        clearTimeout(connectTimer);
        if (shared.planned || group.shared !== shared) return;
        // No answer at all (the path is blocked, or the command node is down):
        // the nodes' own streams find out which, on their own backoff, and the
        // shared request is tried again after the cooldown.
        group.shared = null;
        group.cooldownUntil = now() + fallbackCooldownMs;
        fallBackAll(group);
        return;
      }
      clearTimeout(connectTimer);
      if (group.shared !== shared) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        // 404/405: an older command node; anything else: not now.
        if (response.status === 404 || response.status === 405) group.unsupported = true;
        else group.cooldownUntil = now() + fallbackCooldownMs;
        group.shared = null;
        fallBackAll(group);
        return;
      }
      shared.open = true;
      group.backoff.connected();
      await readShared(group, shared, response.body);
    })();
  };

  const detach = (group: Group, member: Member, attachment: Attachment) => {
    endAttachment(member, attachment, null);
    if (member.attachment) return;
    clearGrace(member);
    member.graceTimer = setTimeout(() => {
      member.graceTimer = null;
      if (member.attachment) return;
      member.wanted = false;
      clearHeld(member);
      if (group.shared?.nodes.has(member.nodeId)) {
        if (activeNodes(group).some((other) => other.wanted)) scheduleReopen(group);
        else closeShared(group);
      }
    }, detachGraceMs);
  };

  const attach = (
    group: Group,
    member: Member,
    url: string,
    init: RequestInit,
  ): Promise<Response> => {
    const signal = init.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    clearGrace(member);
    if (member.attachment) endAttachment(member, member.attachment, abortError());
    const cursor = cursorOf(url);
    const workspaceId = member.workspaceId();
    const shared = group.shared;
    const carried = shared !== null && shared.nodes.has(member.nodeId);
    // The transport's cursor is authoritative: anything else means the node
    // missed frames (or the workspace changed), so it is sent again.
    if (!carried || cursor !== member.cursor || member.sentWorkspace !== workspaceId) {
      member.resubscribe = true;
    }
    member.cursor = cursor;
    if (member.resubscribe) clearHeld(member);
    member.wanted = true;
    group.init = init;
    return new Promise<Response>((resolve, reject) => {
      const attachment: Attachment = {
        url,
        init,
        stream: null,
        controller: null,
        answer: (answer) => (answer instanceof Response ? resolve(answer) : reject(answer)),
        ended: false,
      };
      attachment.stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            attachment.controller = controller;
          },
          cancel() {
            if (!attachment.ended) detach(group, member, attachment);
          },
        },
        { highWaterMark: maxNodeQueuedBytes, size: (chunk) => chunk?.byteLength ?? 0 },
      );
      member.attachment = attachment;
      signal?.addEventListener("abort", () => detach(group, member, attachment), { once: true });
      if (member.resubscribe) {
        if (!group.retryTimer) scheduleReopen(group);
      } else {
        answerIfLive(group, member);
      }
    });
  };

  const opener =
    (nodeId: BackendId, workspaceId: () => string | null): MainStreamOpener =>
    (url, init, control) => {
      const base = relayGroupBase(url);
      if (disposed || !base) return fetchImpl(url, init);
      const group = groupFor(base, init);
      const member = memberFor(group, nodeId, workspaceId, control);
      const workspace = workspaceId();
      const eligible =
        sharedUsable(group) && workspace !== null && member.refusedWorkspace !== workspace;
      if (!eligible) return openOwn(member, url, init);
      if (member.wanted) return attach(group, member, url, init);
      const active = activeNodes(group).filter((other) => other !== member);
      const sharing = active.filter((other) => other.wanted).length;
      if (active.length + 1 < minNodes || sharing >= maxNodes) return openOwn(member, url, init);
      // Enough relayed nodes at once: this one shares, and those still on their
      // own streams move over (each reopens from its own cursor).
      for (const other of active) {
        const control = other.control;
        if (other.wanted || other.ownActive === 0 || !control) continue;
        if (other.refusedWorkspace !== null && other.refusedWorkspace === other.workspaceId()) {
          continue;
        }
        queueMicrotask(() => control.reconnect());
      }
      return attach(group, member, url, init);
    };

  return {
    opener,
    refresh(nodeId) {
      for (const group of groups.values()) {
        const member = group.members.get(nodeId);
        if (!member?.wanted) continue;
        member.resubscribe = true;
        scheduleReopen(group);
      }
    },
    snapshot: () => ({
      groups: Array.from(groups.values()).map((group) => ({
        base: group.base,
        unsupported: group.unsupported,
        open: group.shared?.open ?? false,
        requests: group.requests,
        nodes: Array.from(group.members.values()).map((member) => ({
          nodeId: member.nodeId,
          mode: member.wanted ? "shared" : member.ownActive > 0 ? "own" : "idle",
          state: member.state,
        })),
      })),
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const group of groups.values()) {
        if (group.reopenTimer) clearTimeout(group.reopenTimer);
        if (group.retryTimer) clearTimeout(group.retryTimer);
        group.reopenTimer = null;
        group.retryTimer = null;
        closeShared(group);
        for (const member of group.members.values()) {
          clearGrace(member);
          if (member.attachment) endAttachment(member, member.attachment, abortError());
        }
        group.members.clear();
      }
      groups.clear();
    },
  };
}
