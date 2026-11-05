import type { GatewayContext } from "./gateway-context.js";
import { encodeGatewayFrame, formatGatewayCursor } from "./gateway-event-replay.js";
import type {
  GatewayEventReplay,
  GatewayCursorParseResult,
  GatewayReplayFrame,
} from "./gateway-event-replay.js";
import {
  DROPPABLE_EVENT_PREFIX,
  SSE_CLIENT_SOFT_BUFFER_BYTES,
  SSE_CLIENT_HARD_BUFFER_BYTES,
  GATEWAY_CONNECTED_EVENT,
  GATEWAY_RECONCILE_REQUIRED_EVENT,
  GATEWAY_CURSOR_EVENT,
  eventMatchesSubscription,
} from "./gateway-internals.js";
import type {
  EventClientWriter,
  GatewayEventClient,
  GatewayReconcileReason,
} from "./gateway-internals.js";
import {
  MAX_NODE_EVENT_WATCHES,
  RELAYED_NODE_EVENT,
  relayedNodeEventNodeId,
  type RelayedNodeEvent,
} from "@orkestrator/protocol/node-events";
import type { BackendId } from "@orkestrator/protocol/federation";
import { createLogger } from "@orkestrator/protocol/logger";
import { compatibilityPathUsage } from "./core/compatibility-path-usage.js";

const log = createLogger("gateway");

function formatControlFrame(event: string, cursor: string | null, payload: unknown): string {
  return `${cursor ? `id: ${cursor}\n` : ""}data: ${JSON.stringify({ event, payload })}\n\n`;
}

function encodeLegacyRelayedFrame(payload: unknown): Buffer {
  return encodeGatewayFrame(`data: ${JSON.stringify({ event: RELAYED_NODE_EVENT, payload })}\n\n`);
}

/** SSE fan-out, the replay handshake, and bounded per-client buffering. */
export class GatewayEvents {
  /**
   * The main revision at each node's newest relayed event, oldest first. Relayed
   * events are outside the window a main stream replays, so a reconnecting
   * older client is told which nodes it may have missed something from. A watch
   * names one node, so the bound on watches is also the most nodes that can be
   * relaying at once.
   */
  private readonly relayedNodes = new Map<BackendId, number>();

  constructor(private readonly ctx: GatewayContext) {}

  emit(event: string, payload: unknown): void {
    this.ctx.terminalWebSocket.emit(event, payload);
    const droppable = event.startsWith(DROPPABLE_EVENT_PREFIX);
    const relayedNode = relayedNodeEventNodeId(event);
    if (relayedNode) this.rememberRelayedNode(relayedNode);
    const ring = relayedNode ? this.ctx.relayedEventReplay : this.ctx.eventReplay;
    // Authoritative state is revisioned and retained even while no renderer is
    // mounted. Terminal bytes have their own generation/revision snapshot
    // protocol and must never consume this replay ring.
    const replayFrame = droppable ? null : ring.append(event, payload);
    if (this.ctx.clients.size === 0) return;
    let message = replayFrame?.message ?? null;
    let messageBytes = replayFrame?.encodedBytes ?? 0;
    let legacyMessage: Buffer | null = null;
    for (const [client, state] of this.ctx.clients) {
      if (relayedNode && !state.relayedStream) {
        if (!this.takesLegacyRelayedFrames(state)) continue;
        legacyMessage ??= encodeLegacyRelayedFrame(payload);
        if (!state.relayedEvents) compatibilityPathUsage.record("relayed-node-event.legacy-stream");
        this.deliverEvent(
          client,
          state,
          RELAYED_NODE_EVENT,
          payload,
          legacyMessage,
          legacyMessage.byteLength,
          false,
          null,
        );
        continue;
      }
      if (
        !eventMatchesSubscription(
          event,
          state.prefixes,
          state.includedPrefixes,
          state.excludedPrefixes,
        )
      ) {
        // The revision still happened globally. Remember it so the keepalive can
        // advance this client's cursor; otherwise its next reconnect asks for a
        // window the ring has long since evicted and reconciles for nothing.
        if (replayFrame && state.tracksReplayCursor && this.ringOf(state) === ring) {
          state.omittedRevision = replayFrame.revision;
        }
        continue;
      }
      // A matching authoritative frame carries a newer `id` than anything
      // omitted before it, so the pending cursor is already superseded.
      if (replayFrame) state.omittedRevision = null;
      if (message === null) {
        message = encodeGatewayFrame(`data: ${JSON.stringify({ event, payload })}\n\n`);
        messageBytes = message.byteLength;
      }

      const written = this.deliverEvent(
        client,
        state,
        event,
        payload,
        message,
        messageBytes,
        droppable,
        replayFrame?.revision ?? null,
      );
      if (written && replayFrame) state.sentRevision = replayFrame.revision;
    }
  }

  /** Writes the frame now, or buffers it while the stream's replay is draining. */
  private deliverEvent(
    client: EventClientWriter,
    state: GatewayEventClient,
    event: string,
    payload: unknown,
    message: Buffer,
    messageBytes: number,
    droppable: boolean,
    revision: number | null,
  ): boolean {
    if (state.handshake) {
      const projectedFrames = state.handshake.events.length + 1;
      const projectedBytes = state.handshake.bytes + messageBytes;
      if (
        projectedFrames > this.ctx.replayHandshakeFrameCapacity ||
        projectedBytes > this.ctx.replayHandshakeMaxBytes
      ) {
        this.dropBufferedClient(client, event, projectedBytes);
        return false;
      }
      state.handshake.events.push({ event, payload, message, messageBytes, droppable, revision });
      state.handshake.bytes = projectedBytes;
      return false;
    }
    return this.writeEventToClient(client, state, event, payload, message, messageBytes, droppable);
  }

  private ringOf(state: GatewayEventClient): GatewayEventReplay {
    return state.relayedStream ? this.ctx.relayedEventReplay : this.ctx.eventReplay;
  }

  private takesLegacyRelayedFrames(state: GatewayEventClient): boolean {
    return (
      state.relayedEvents !== "per-node" &&
      !state.relayedStream &&
      eventMatchesSubscription(
        RELAYED_NODE_EVENT,
        state.prefixes,
        state.includedPrefixes,
        state.excludedPrefixes,
      )
    );
  }

  private rememberRelayedNode(nodeId: BackendId): void {
    this.relayedNodes.delete(nodeId);
    this.relayedNodes.set(nodeId, this.ctx.eventReplay.latestRevision);
    if (this.relayedNodes.size > MAX_NODE_EVENT_WATCHES) {
      const oldest = this.relayedNodes.keys().next().value;
      if (oldest !== undefined) this.relayedNodes.delete(oldest);
    }
  }

  /**
   * A main stream's replay covers everything except relayed events, so an older
   * client coming back is told to re-read the nodes that relayed something since
   * its cursor. A relayed event at the cursor's own revision may have come after
   * the client left, so it counts.
   */
  private writeLegacyRelayedResyncs(
    client: EventClientWriter,
    state: GatewayEventClient,
    sinceRevision: number,
  ): boolean {
    if (!this.takesLegacyRelayedFrames(state)) return true;
    for (const [nodeId, revision] of this.relayedNodes) {
      if (revision < sinceRevision) continue;
      const frame: RelayedNodeEvent = { nodeId, kind: "resync" };
      const message = encodeLegacyRelayedFrame(frame);
      if (!state.relayedEvents) compatibilityPathUsage.record("relayed-node-event.legacy-stream");
      if (
        !this.writeEventToClient(
          client,
          state,
          RELAYED_NODE_EVENT,
          frame,
          message,
          message.byteLength,
          false,
        ) ||
        !this.ctx.clients.has(client)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Advances a client that has only seen revisions its filter omitted.
   *
   * A scoped subscription receives no `id` for events it filtered out, so under
   * sustained unrelated traffic its cursor would freeze while the ring moved on,
   * and every reconnect would reconcile a gap it never actually missed. Flushing
   * on the keepalive tick bounds that drift to one keepalive interval and costs
   * one small frame instead of one per omitted event.
   */
  flushOmittedCursor(client: EventClientWriter, state: GatewayEventClient): void {
    const omitted = state.omittedRevision;
    if (
      omitted === null ||
      omitted === undefined ||
      !state.tracksReplayCursor ||
      state.handshake ||
      omitted <= (state.sentRevision ?? 0)
    )
      return;
    state.omittedRevision = null;
    if (
      !this.writeControlFrame(
        client,
        GATEWAY_CURSOR_EVENT,
        formatGatewayCursor(this.ringOf(state).generation, omitted),
        null,
      )
    )
      return;
    state.sentRevision = omitted;
  }

  writeEventToClient(
    client: EventClientWriter,
    state: GatewayEventClient,
    event: string,
    payload: unknown,
    message: Buffer,
    messageBytes: number,
    droppable: boolean,
  ): boolean {
    if (client.writableLength > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, client.writableLength);
      return false;
    }

    if (droppable && client.writableLength + messageBytes > SSE_CLIENT_SOFT_BUFFER_BYTES) {
      this.markTerminalFrameDropped(client, state, event, message, payload);
      return true;
    }
    if (state.desyncedSessions.size > 0 && !this.flushDesyncNotices(client, state)) {
      return false;
    }

    const projectedBytes = client.writableLength + messageBytes;
    if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, projectedBytes);
      return false;
    }
    // A desync notice may itself consume the last available soft-limit
    // space. Re-check droppable frames after flushing it.
    if (droppable && projectedBytes > SSE_CLIENT_SOFT_BUFFER_BYTES) {
      this.markTerminalFrameDropped(client, state, event, message, payload);
      return true;
    }
    client.write(message, messageBytes);
    this.ctx.metrics.recordEvent(event, messageBytes);
    return true;
  }

  writeControlFrame(
    client: EventClientWriter,
    event: string,
    cursor: string | null,
    payload: unknown,
  ): boolean {
    const message = formatControlFrame(event, cursor, payload);
    const messageBytes = Buffer.byteLength(message);
    const projectedBytes = client.writableLength + messageBytes;
    if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, projectedBytes);
      return false;
    }
    client.write(message, messageBytes);
    return true;
  }

  /**
   * Writes a replay window to one client.
   *
   * A scoped stream still has to advance through global revisions it omitted,
   * otherwise every reconnect would request the same irrelevant frames. Only the
   * newest of a run of omitted revisions matters, so each run costs one cursor
   * frame: just before the next matching frame, or at the end of the window.
   */
  writeReplayFrames(
    client: EventClientWriter,
    state: GatewayEventClient,
    frames: readonly GatewayReplayFrame[],
  ): boolean {
    let skippedCursor: string | null = null;
    const flushSkipped = (): boolean => {
      if (skippedCursor === null) return true;
      if (!this.ctx.clients.has(client)) return false;
      const cursor = skippedCursor;
      skippedCursor = null;
      return this.writeControlFrame(client, GATEWAY_CURSOR_EVENT, cursor, null);
    };
    for (const frame of frames) {
      if (
        !eventMatchesSubscription(
          frame.event,
          state.prefixes,
          state.includedPrefixes,
          state.excludedPrefixes,
        )
      ) {
        skippedCursor = frame.cursor;
        continue;
      }
      if (!flushSkipped() || !this.ctx.clients.has(client)) return false;
      if (
        !this.writeEventToClient(
          client,
          state,
          frame.event,
          undefined,
          frame.message,
          frame.encodedBytes,
          false,
        )
      )
        return false;
    }
    return flushSkipped();
  }

  /**
   * Whether the whole replay window can be written without tripping the hard
   * buffer limit.
   *
   * Replay is one synchronous loop and neither writer's `writableLength` can
   * fall during it, so the window's bytes accumulate against whatever the socket
   * has not absorbed. Checking up front turns a silent mid-replay destroy into
   * an explicit reconciliation.
   *
   * A scoped client is charged for what it will actually be written: matching
   * frames, and one cursor per run of skips. The newest cursor is the longest,
   * so charging it for every run keeps the figure an upper bound.
   */
  replayFitsClientBudget(
    client: EventClientWriter,
    state: GatewayEventClient,
    frames: readonly GatewayReplayFrame[],
  ): boolean {
    let cursorFrameBytes: number | null = null;
    let inSkippedRun = false;
    let projected = client.writableLength;
    for (const frame of frames) {
      if (
        eventMatchesSubscription(
          frame.event,
          state.prefixes,
          state.includedPrefixes,
          state.excludedPrefixes,
        )
      ) {
        inSkippedRun = false;
        projected += frame.encodedBytes;
      } else if (!inSkippedRun) {
        inSkippedRun = true;
        cursorFrameBytes ??= Buffer.byteLength(
          formatControlFrame(GATEWAY_CURSOR_EVENT, this.ringOf(state).latestCursor, null),
        );
        projected += cursorFrameBytes;
      }
      if (projected > SSE_CLIENT_HARD_BUFFER_BYTES) return false;
    }
    return true;
  }

  initializeEventReplay(
    client: EventClientWriter,
    state: GatewayEventClient,
    cursor: GatewayCursorParseResult,
  ): void {
    const ring = this.ringOf(state);
    const latestAtSubscribe = ring.latestRevision;
    let replay: ReturnType<GatewayEventReplay["since"]> | null = null;
    // An invalid cursor is not safe to echo as an SSE id, and advancing to the
    // latest revision here could make a disconnect before reconcile-required
    // permanently skip the snapshot recovery signal.
    let connectedCursor: string | null = cursor.kind === "invalid" ? null : ring.latestCursor;
    let replayStatus: "fresh" | "caught-up" | "replayed" | "reconcile" = "fresh";
    let reconcileReason: GatewayReconcileReason | null = null;
    let requestedRevision: number | null = null;

    if (cursor.kind === "invalid") {
      replayStatus = "reconcile";
      reconcileReason = "invalid-cursor";
    } else if (cursor.kind === "valid") {
      connectedCursor = cursor.raw;
      requestedRevision = cursor.revision;
      if (cursor.generation !== ring.generation) {
        replayStatus = "reconcile";
        reconcileReason = "prior-generation";
      } else if (cursor.revision > ring.latestRevision) {
        // Ahead of the server is the opposite of expired. Both reconcile, but
        // conflating them hides a corrupt cursor behind a routine ring overrun.
        replayStatus = "reconcile";
        reconcileReason = "cursor-ahead";
      } else {
        replay = ring.since(cursor.revision);
        if (!replay.complete) {
          replayStatus = "reconcile";
          reconcileReason = "cursor-expired";
        } else if (!this.replayFitsClientBudget(client, state, replay.frames)) {
          // Writing the window would overrun the hard buffer partway through and
          // destroy the client with no explanation. Reconciling costs one
          // snapshot instead of a drop/reconnect/drop loop.
          replay = null;
          replayStatus = "reconcile";
          reconcileReason = "replay-too-large";
        } else {
          replayStatus = replay.frames.length > 0 ? "replayed" : "caught-up";
        }
      }
    }

    const replayedFrames = replay?.complete ? replay.frames.length : 0;
    this.ctx.metrics.recordReplayHandshake(replayStatus, reconcileReason, replayedFrames);
    if (
      !this.writeControlFrame(client, GATEWAY_CONNECTED_EVENT, connectedCursor, {
        generation: ring.generation,
        revision: latestAtSubscribe,
        status: replayStatus,
        replayed: replayedFrames,
      })
    )
      return;
    if (!this.ctx.clients.has(client)) return;

    let highestSent = cursor.kind === "valid" ? cursor.revision : latestAtSubscribe;
    if (reconcileReason) {
      const currentCursor = ring.latestCursor;
      if (
        !this.writeControlFrame(client, GATEWAY_RECONCILE_REQUIRED_EVENT, currentCursor, {
          reason: reconcileReason,
          requestedCursor: cursor.kind === "absent" ? null : cursor.raw,
          requestedRevision,
          oldestAvailableRevision: ring.oldestRevision,
          latestRevision: ring.latestRevision,
          generation: ring.generation,
        })
      )
        return;
      if (!this.ctx.clients.has(client)) return;
      highestSent = ring.latestRevision;
    } else if (replay) {
      if (!this.writeReplayFrames(client, state, replay.frames)) return;
      highestSent = Math.max(highestSent, replay.frames.at(-1)?.revision ?? 0);
      if (!this.writeLegacyRelayedResyncs(client, state, requestedRevision ?? 0)) return;
    }

    // Stay in buffered mode until the dynamic end of the array. A write can
    // synchronously cause another backend event, and that later event must not
    // overtake an earlier buffered one.
    let index = 0;
    while (state.handshake && index < state.handshake.events.length) {
      const buffered = state.handshake.events[index]!;
      index += 1;
      if (buffered.revision !== null && buffered.revision <= highestSent) continue;
      if (
        !this.writeEventToClient(
          client,
          state,
          buffered.event,
          buffered.payload,
          buffered.message,
          buffered.messageBytes,
          buffered.droppable,
        )
      )
        return;
      if (buffered.revision !== null) highestSent = buffered.revision;
    }
    state.handshake = null;
    // Everything up to `highestSent` now carries an `id` this client has seen,
    // so any cursor omitted during the handshake is already superseded.
    state.sentRevision = highestSent;
    state.omittedRevision = null;
  }

  markTerminalFrameDropped(
    client: EventClientWriter,
    state: GatewayEventClient,
    event: string,
    message: Buffer,
    payload: unknown,
  ): void {
    const sessionId = event.slice(DROPPABLE_EVENT_PREFIX.length);
    const streamAlreadyStalled = state.desyncedSessions.size > 0;
    state.desyncedSessions.add(sessionId);
    this.ctx.metrics.recordDroppedEventFrame(event);
    this.ctx.metrics.recordSoftDesync();
    if (!streamAlreadyStalled) this.ctx.metrics.recordStreamStalled();
    if (!sessionId.startsWith("tmux:") || !state.includedPrefixes?.includes(event)) return;
    let frames = this.ctx.droppedTmuxFrames.get(client);
    if (!frames) {
      frames = new Map();
      this.ctx.droppedTmuxFrames.set(client, frames);
    }
    // A filtered terminal SSE can subscribe to several mounted sessions, so
    // retain at most the newest full-pane frame for each subscribed tmux
    // session. Broader/legacy streams receive the ordinary desync notice
    // instead of accumulating panes for terminals they are not displaying.
    if (payload && typeof payload === "object" && (payload as { full?: unknown }).full === true) {
      frames.set(sessionId, message);
    } else {
      // A line patch cannot recover earlier dropped patches. Force the client
      // through the explicit desync path instead of replaying an incomplete pane.
      frames.delete(sessionId);
    }
  }

  dropBufferedClient(client: EventClientWriter, event: string, projectedBytes: number): void {
    log.warn("events.client-dropped", { projectedBytes });
    this.ctx.clients.delete(client);
    this.ctx.metrics.recordDroppedEventClient(event);
    this.ctx.metrics.recordStreamDropped();
    client.destroy();
  }

  /**
   * Tells a recovered client which terminal sessions lost frames.
   *
   * Dropping is only defensible if the client learns about it, so this is the
   * other half of the soft-limit drop: the renderer reacts by replaying
   * `get_terminal_output_buffer`, which is the authoritative window. The notice
   * rides the session's own event rather than a second event name so consumers
   * need no extra subscription and existing filters keep working.
   */
  flushDesyncNotices(client: EventClientWriter, state: GatewayEventClient): boolean {
    for (const sessionId of Array.from(state.desyncedSessions)) {
      const event = `${DROPPABLE_EVENT_PREFIX}${sessionId}`;
      const retainedTmuxFrame = this.ctx.droppedTmuxFrames.get(client)?.get(sessionId);
      const recoveryFrame =
        retainedTmuxFrame ??
        encodeGatewayFrame(`data: ${JSON.stringify({ event, payload: { desynced: true } })}\n\n`);
      const recoveryBytes = recoveryFrame.byteLength;
      const projectedBytes = client.writableLength + recoveryBytes;
      if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
        this.dropBufferedClient(client, event, projectedBytes);
        return false;
      }
      // Retire the session before writing it. A write can emit "drain"
      // synchronously, and the drain handler re-enters here: leaving the session
      // pending across the write recurses on the same frame until the stack dies,
      // taking the recovery path down with it.
      if (retainedTmuxFrame) {
        const retained = this.ctx.droppedTmuxFrames.get(client);
        retained?.delete(sessionId);
        if (retained?.size === 0) this.ctx.droppedTmuxFrames.delete(client);
      }
      state.desyncedSessions.delete(sessionId);
      client.write(recoveryFrame, recoveryBytes);
      this.ctx.metrics.recordEvent(event, recoveryBytes);
    }
    return true;
  }
}
