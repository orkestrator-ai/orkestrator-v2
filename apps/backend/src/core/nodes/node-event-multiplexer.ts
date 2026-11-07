import type { IncomingMessage, ServerResponse } from "node:http";

import type { BackendId } from "@orkestrator/protocol/federation";
import {
  GATEWAY_CONNECTED_EVENT,
  GATEWAY_EVENT_CURSOR_PARAM,
  GATEWAY_RECONCILE_REQUIRED_EVENT,
  GATEWAY_RELAYED_EVENTS_PARAM,
  GATEWAY_STREAM_CONNECT_TIMEOUT_MS,
  GATEWAY_STREAM_SILENCE_LIMIT_MS,
  GatewayEventFrameTooLargeError,
  SseFrameDecoder,
  type GatewayRelayedEventsMode,
} from "@orkestrator/protocol/gateway-event-stream";
import {
  encodeMultiplexedControlFrame,
  encodeMultiplexedNodeFrame,
  MAX_MULTIPLEXED_FRAME_BYTES,
  MAX_MULTIPLEXED_QUEUED_BYTES,
  MAX_MULTIPLEXED_STREAMS,
  MULTIPLEXED_CONNECTED_EVENT,
  MULTIPLEXED_NODE_EVENT,
  parseMultiplexedEventsQuery,
  type MultiplexedNodeReason,
  type MultiplexedNodeRequest,
} from "@orkestrator/protocol/multiplexed-relay-events";
import { ReconnectBackoff } from "@orkestrator/protocol/reconnect-backoff";

import type { RelayTarget } from "./node-relay.js";

/**
 * `GET /__orkestrator/nodes/events?nodes=a,b` (plan item 5005): several
 * relayed leaves' main event streams on one long-lived response, so a
 * browser on HTTP/1.1 spends one of its six connections to the command node
 * on all of them. The wire format is in
 * `@orkestrator/protocol/multiplexed-relay-events`.
 *
 * Each node gets one upstream subscription to the leaf's own main stream,
 * over the same link and credential the per-node relay uses, with the cursor
 * the client sent. Leaf frames are forwarded unchanged, tagged with their
 * node, so each node keeps the main stream's replay contract by itself: the
 * leaf subscribes before it computes replay (invariant 7) and its
 * `gateway.connected` echoes the cursor it was given (invariant 8). This
 * response's own `mux.connected` echoes every cursor the client sent and
 * carries no `id`.
 *
 * A leaf stream that ends, fails or goes silent is reopened from the last
 * cursor forwarded for that node, so a gap is the leaf's to replay or
 * reconcile (invariant 4). `mux.node` says when a node goes down, comes back
 * or is refused.
 *
 * Bounds (invariant 11): at most `MAX_MULTIPLEXED_NODES` nodes per request
 * and `MAX_MULTIPLEXED_STREAMS` requests at once; a leaf frame is at most
 * `MAX_MULTIPLEXED_FRAME_BYTES`; leaf streams are not read while the response
 * is above its high-water mark, and a response holding more than
 * `MAX_MULTIPLEXED_QUEUED_BYTES` is closed (the client resumes each node from
 * its own cursor). Nothing is ever dropped silently (invariant 6).
 *
 * This is deliberately not `NodeEventRelay`, which leases event prefixes for
 * the portal and re-emits them on the command node's own stream.
 *
 * Every node needs a workspace the client opened for it here
 * (`open_node_workspace`), checked when its stream opens and on every
 * keepalive; a node without one is refused.
 */

/** The leaf's terminal output has its own streams; never on a main stream. */
const TERMINAL_OUTPUT_PREFIX = "terminal-output-";
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 16_000;
const RECONNECT_HEALTHY_AFTER_MS = 30_000;

export interface NodeEventMultiplexerOptions {
  /** Where a node's traffic goes (the relay's target); `null` while not connected. */
  relayTarget(nodeId: BackendId): RelayTarget | null;
  /** Whether `workspaceId` is an open workspace for `nodeId` on this command node. */
  workspaceOpen(workspaceId: string, nodeId: BackendId): boolean;
  fetchImpl?: typeof fetch;
  /** Keepalive comment and workspace check interval (the gateway's 25 s). */
  keepaliveMs: number;
  /** A leaf stream with no bytes this long is reopened. */
  silenceMs?: number;
  /** A leaf stream that has not answered after this long is retried. */
  connectTimeoutMs?: number;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxFrameBytes?: number;
  maxQueuedBytes?: number;
  maxStreams?: number;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** The event a leaf frame carries, read without decoding its payload. */
function frameEvent(data: string): string | null {
  const match = /^\{"event":"([^"\\]+)"/u.exec(data);
  if (match) return match[1]!;
  try {
    const parsed = JSON.parse(data) as { event?: unknown };
    return typeof parsed.event === "string" ? parsed.event : null;
  } catch {
    return null;
  }
}

export class NodeEventMultiplexer {
  private readonly streams = new Set<MultiplexedResponse>();

  constructor(private readonly options: NodeEventMultiplexerOptions) {}

  /** Open multiplexed requests. */
  get size(): number {
    return this.streams.size;
  }

  serve(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    const query = parseMultiplexedEventsQuery(url.searchParams);
    if (!query.ok) {
      json(response, 400, { error: query.error });
      return;
    }
    if (this.streams.size >= (this.options.maxStreams ?? MAX_MULTIPLEXED_STREAMS)) {
      json(response, 503, { error: "Too many multiplexed event streams are open." });
      return;
    }
    const stream = new MultiplexedResponse(this.options, response, query.nodes, () =>
      this.streams.delete(stream),
    );
    this.streams.add(stream);
    request.once("close", () => stream.close());
    response.once("close", () => stream.close());
    stream.start();
  }

  /** Ends every open request (gateway stop). */
  closeAll(): void {
    for (const stream of Array.from(this.streams)) stream.close();
  }
}

class MultiplexedResponse {
  private closed = false;
  private readonly pumps = new Map<BackendId, NodePump>();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private drained: Promise<void> | null = null;
  private readonly maxQueuedBytes: number;

  constructor(
    private readonly options: NodeEventMultiplexerOptions,
    private readonly response: ServerResponse,
    private readonly nodes: readonly MultiplexedNodeRequest[],
    private readonly onClosed: () => void,
  ) {
    this.maxQueuedBytes = options.maxQueuedBytes ?? MAX_MULTIPLEXED_QUEUED_BYTES;
  }

  start(): void {
    this.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    this.response.write(": connected\n\n");
    // The cursors the client sent, unchanged: nothing here may move them.
    void this.write(
      encodeMultiplexedControlFrame({
        event: MULTIPLEXED_CONNECTED_EVENT,
        payload: { nodes: this.nodes.map((node) => ({ node: node.nodeId, cursor: node.cursor })) },
      }),
    );
    for (const node of this.nodes) {
      if (!this.options.workspaceOpen(node.workspaceId, node.nodeId)) {
        this.announce(node.nodeId, "refused", "no-workspace");
        continue;
      }
      const pump = new NodePump(this.options, node, this);
      this.pumps.set(node.nodeId, pump);
      pump.start();
    }
    this.keepalive = setInterval(() => this.tick(), this.options.keepaliveMs);
    this.keepalive.unref?.();
  }

  private tick(): void {
    if (this.closed) return;
    for (const [nodeId, pump] of Array.from(this.pumps)) {
      if (this.options.workspaceOpen(pump.workspaceId, nodeId)) continue;
      // The workspace was closed or lapsed: this client holds no grant for it.
      pump.stop();
      this.pumps.delete(nodeId);
      this.announce(nodeId, "refused", "no-workspace");
    }
    if (this.closed) return;
    void this.write(": keepalive\n\n");
  }

  announce(nodeId: BackendId, state: "live" | "down" | "refused", reason?: MultiplexedNodeReason) {
    return this.write(
      encodeMultiplexedControlFrame({
        event: MULTIPLEXED_NODE_EVENT,
        payload: { node: nodeId, state, ...(reason ? { reason } : {}) },
      }),
    );
  }

  /**
   * Writes one whole frame, after the response drained if it had to. Leaf
   * streams await this before reading on, so a slow client slows its leaves
   * rather than filling memory. Returns false once the response is closed.
   */
  async write(chunk: string): Promise<boolean> {
    if (this.closed) return false;
    while (this.response.writableNeedDrain) {
      // One wait for every writer, however many leaves are waiting.
      this.drained ??= new Promise<void>((resolve) => {
        const done = () => {
          this.response.off("drain", done);
          this.response.off("close", done);
          this.drained = null;
          resolve();
        };
        this.response.on("drain", done);
        this.response.on("close", done);
      });
      await this.drained;
      if (this.closed) return false;
    }
    if (this.response.writableLength + Buffer.byteLength(chunk) > this.maxQueuedBytes) {
      // Past every bound: drop the client, never a frame. It resumes each node
      // from its own cursor.
      this.close();
      return false;
    }
    this.response.write(chunk);
    return true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const pump of this.pumps.values()) pump.stop();
    this.pumps.clear();
    if (!this.response.writableEnded) this.response.end();
    this.response.destroy();
    this.onClosed();
  }
}

class NodePump {
  private readonly abort = new AbortController();
  /** The last cursor forwarded for this node: where a reopen resumes. */
  private cursor: string | null;
  private readonly backoff: ReconnectBackoff;
  private announced: "live" | "down" | null = null;
  /** The next leaf `gateway.connected` is followed by a reconcile frame. */
  private owesReconcile = false;

  constructor(
    private readonly options: NodeEventMultiplexerOptions,
    private readonly node: MultiplexedNodeRequest,
    private readonly out: MultiplexedResponse,
  ) {
    this.cursor = node.cursor;
    this.backoff = new ReconnectBackoff({
      initialDelayMs: options.reconnectInitialDelayMs ?? RECONNECT_INITIAL_DELAY_MS,
      maxDelayMs: options.reconnectMaxDelayMs ?? RECONNECT_MAX_DELAY_MS,
      healthyAfterMs: RECONNECT_HEALTHY_AFTER_MS,
    });
  }

  get workspaceId(): string {
    return this.node.workspaceId;
  }

  start(): void {
    void this.run();
  }

  stop(): void {
    this.abort.abort();
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted || this.out.isClosed;
  }

  private async down(reason: MultiplexedNodeReason): Promise<void> {
    if (this.announced === "down") return;
    this.announced = "down";
    await this.out.announce(this.node.nodeId, "down", reason);
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const reason = await this.connectOnce();
      if (this.stopped) return;
      if (reason) await this.down(reason);
      if (this.stopped) return;
      await this.wait(this.backoff.nextDelayMs());
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.abort.signal;
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /** One leaf connection; resolves with why it ended (null when stopped). */
  private async connectOnce(): Promise<MultiplexedNodeReason | null> {
    const target = this.options.relayTarget(this.node.nodeId);
    if (!target) return "not-connected";
    const connection = new AbortController();
    const end = () => connection.abort();
    this.abort.signal.addEventListener("abort", end, { once: true });
    const silenceMs = this.options.silenceMs ?? GATEWAY_STREAM_SILENCE_LIMIT_MS;
    let deadline =
      Date.now() + (this.options.connectTimeoutMs ?? GATEWAY_STREAM_CONNECT_TIMEOUT_MS);
    let silent = false;
    const watchdog = setInterval(
      () => {
        if (Date.now() < deadline) return;
        silent = true;
        connection.abort();
      },
      Math.max(5, Math.floor(Math.min(silenceMs, this.options.connectTimeoutMs ?? silenceMs) / 4)),
    );
    watchdog.unref?.();
    try {
      const url = new URL("/__orkestrator/events", target.baseUrl);
      url.searchParams.set("excludeEvents", TERMINAL_OUTPUT_PREFIX);
      url.searchParams.set(
        GATEWAY_RELAYED_EVENTS_PARAM,
        "per-node" satisfies GatewayRelayedEventsMode,
      );
      if (this.cursor) url.searchParams.set(GATEWAY_EVENT_CURSOR_PARAM, this.cursor);
      let response: Response;
      try {
        response = await (this.options.fetchImpl ?? fetch)(url, {
          headers: { ...target.headers, accept: "text/event-stream" },
          redirect: "manual",
          signal: connection.signal,
        });
      } catch {
        return this.stopped ? null : silent ? "upstream-silent" : "upstream-error";
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return "upstream-error";
      }
      this.backoff.connected();
      deadline = Date.now() + silenceMs;
      if (this.announced !== "live") {
        this.announced = "live";
        if (!(await this.out.announce(this.node.nodeId, "live"))) return null;
      }
      return await this.forward(response.body, connection.signal, () => {
        deadline = Date.now() + silenceMs;
      }).then((reason) => (silent ? "upstream-silent" : reason));
    } finally {
      clearInterval(watchdog);
      this.abort.signal.removeEventListener("abort", end);
      connection.abort();
    }
  }

  private async forward(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    alive: () => void,
  ): Promise<MultiplexedNodeReason | null> {
    const reader = body.getReader();
    const text = new TextDecoder();
    const frames = new SseFrameDecoder(this.options.maxFrameBytes ?? MAX_MULTIPLEXED_FRAME_BYTES);
    const cancel = () => void reader.cancel().catch(() => undefined);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) return this.stopped ? null : "upstream-silent";
        alive();
        for (const frame of frames.push(text.decode(value, { stream: !done }))) {
          if (!frame.data) continue;
          if (
            !(await this.out.write(
              encodeMultiplexedNodeFrame(this.node.nodeId, frame.id, frame.data),
            ))
          ) {
            return null;
          }
          // Written: a reopen resumes after it. An empty id is no id.
          if (frame.id) this.cursor = frame.id;
          if (this.owesReconcile && frameEvent(frame.data) === GATEWAY_CONNECTED_EVENT) {
            this.owesReconcile = false;
            const reconcile = JSON.stringify({
              event: GATEWAY_RECONCILE_REQUIRED_EVENT,
              payload: { reason: "frame-too-large" },
            });
            if (
              !(await this.out.write(encodeMultiplexedNodeFrame(this.node.nodeId, null, reconcile)))
            ) {
              return null;
            }
          }
        }
        if (done) return "upstream-ended";
      }
    } catch (error) {
      if (error instanceof GatewayEventFrameTooLargeError) {
        // The frame cannot be forwarded, and replaying from here would meet it
        // again. Start this node afresh and tell the client to re-read it once
        // the new subscription is live.
        this.cursor = null;
        this.owesReconcile = true;
        return "frame-too-large";
      }
      return this.stopped ? null : "upstream-error";
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => undefined);
    }
  }
}
