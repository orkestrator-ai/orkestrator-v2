import { GatewayBase } from "./gateway-base.js";
import { formatGatewayCursor } from "./gateway-event-replay.js";
import type { GatewayEventReplay, GatewayCursorParseResult, GatewayReplayFrame } from "./gateway-event-replay.js";
import { DROPPABLE_EVENT_PREFIX, SSE_CLIENT_SOFT_BUFFER_BYTES, SSE_CLIENT_HARD_BUFFER_BYTES, GATEWAY_CONNECTED_EVENT, GATEWAY_RECONCILE_REQUIRED_EVENT, GATEWAY_CURSOR_EVENT, eventMatchesSubscription } from "./gateway-internals.js";
import type { EventClientWriter, GatewayEventClient, GatewayReconcileReason } from "./gateway-internals.js";

export abstract class GatewayEvents extends GatewayBase {
  emit(event: string, payload: unknown): void {
    this.terminalWebSocket.emit(event, payload);
    const droppable = event.startsWith(DROPPABLE_EVENT_PREFIX);
    // Authoritative state is revisioned and retained even while no renderer is
    // mounted. Terminal bytes have their own generation/revision snapshot
    // protocol and must never consume this replay ring.
    const replayFrame = droppable ? null : this.eventReplay.append(event, payload);
    if (this.clients.size === 0) return;
    let message = replayFrame?.message ?? null;
    let messageBytes = replayFrame?.encodedBytes ?? 0;
    for (const [client, state] of this.clients) {
      if (!eventMatchesSubscription(
        event,
        state.prefixes,
        state.includedPrefixes,
        state.excludedPrefixes,
      )) {
        // The revision still happened globally. Remember it so the keepalive can
        // advance this client's cursor; otherwise its next reconnect asks for a
        // window the ring has long since evicted and reconciles for nothing.
        if (replayFrame && state.tracksReplayCursor) {
          state.omittedRevision = replayFrame.revision;
        }
        continue;
      }
      // A matching authoritative frame carries a newer `id` than anything
      // omitted before it, so the pending cursor is already superseded.
      if (replayFrame) state.omittedRevision = null;
      if (message === null) {
        message = `data: ${JSON.stringify({ event, payload })}\n\n`;
        messageBytes = Buffer.byteLength(message);
      }

      if (state.handshake) {
        const projectedFrames = state.handshake.events.length + 1;
        const projectedBytes = state.handshake.bytes + messageBytes;
        if (
          projectedFrames > this.replayHandshakeFrameCapacity
          || projectedBytes > this.replayHandshakeMaxBytes
        ) {
          this.dropBufferedClient(client, event, projectedBytes);
          continue;
        }
        state.handshake.events.push({
          event,
          payload,
          message,
          messageBytes,
          droppable,
          revision: replayFrame?.revision ?? null,
        });
        state.handshake.bytes = projectedBytes;
        continue;
      }

      const written = this.writeEventToClient(
        client,
        state,
        event,
        payload,
        message,
        messageBytes,
        droppable,
      );
      if (written && replayFrame) state.sentRevision = replayFrame.revision;
    }
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
  protected flushOmittedCursor(client: EventClientWriter, state: GatewayEventClient): void {
    const omitted = state.omittedRevision;
    if (
      omitted === null
      || omitted === undefined
      || !state.tracksReplayCursor
      || state.handshake
      || omitted <= (state.sentRevision ?? 0)
    ) return;
    state.omittedRevision = null;
    if (!this.writeControlFrame(
      client,
      GATEWAY_CURSOR_EVENT,
      formatGatewayCursor(this.eventReplay.generation, omitted),
      null,
    )) return;
    state.sentRevision = omitted;
  }

  protected writeEventToClient(
    client: EventClientWriter,
    state: GatewayEventClient,
    event: string,
    payload: unknown,
    message: string,
    messageBytes: number,
    droppable: boolean,
  ): boolean {
    if (client.writableLength > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, client.writableLength);
      return false;
    }

    if (
      droppable
      && client.writableLength + messageBytes > SSE_CLIENT_SOFT_BUFFER_BYTES
    ) {
      this.markTerminalFrameDropped(client, state, event, message, payload);
      return true;
    }
    if (
      state.desyncedSessions.size > 0
      && !this.flushDesyncNotices(client, state)
    ) {
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
    client.write(message);
    this.metrics.recordEvent(event, messageBytes);
    return true;
  }

  protected writeControlFrame(
    client: EventClientWriter,
    event: string,
    cursor: string | null,
    payload: unknown,
  ): boolean {
    const message = `${cursor ? `id: ${cursor}\n` : ""}data: ${JSON.stringify({
      event,
      payload,
    })}\n\n`;
    const projectedBytes = client.writableLength + Buffer.byteLength(message);
    if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
      this.dropBufferedClient(client, event, projectedBytes);
      return false;
    }
    client.write(message);
    return true;
  }

  protected writeReplayFrame(
    client: EventClientWriter,
    state: GatewayEventClient,
    frame: GatewayReplayFrame,
  ): boolean {
    if (eventMatchesSubscription(
      frame.event,
      state.prefixes,
      state.includedPrefixes,
      state.excludedPrefixes,
    )) {
      return this.writeEventToClient(
        client,
        state,
        frame.event,
        undefined,
        frame.message,
        frame.encodedBytes,
        false,
      );
    }
    // A scoped stream still has to advance through global revisions it omitted,
    // otherwise every reconnect would request the same irrelevant frames.
    return this.writeControlFrame(client, GATEWAY_CURSOR_EVENT, frame.cursor, null);
  }

  /**
   * Whether the whole replay window can be written without tripping the hard
   * buffer limit.
   *
   * Replay is one synchronous loop and neither writer's `writableLength` can
   * fall during it, so the window's bytes accumulate against whatever the socket
   * has not absorbed. Checking up front turns a silent mid-replay destroy into
   * an explicit reconciliation.
   */
  protected replayFitsClientBudget(
    client: EventClientWriter,
    frames: readonly GatewayReplayFrame[],
  ): boolean {
    let projected = client.writableLength;
    for (const frame of frames) {
      projected += frame.encodedBytes;
      if (projected > SSE_CLIENT_HARD_BUFFER_BYTES) return false;
    }
    return true;
  }

  protected initializeEventReplay(
    client: EventClientWriter,
    state: GatewayEventClient,
    cursor: GatewayCursorParseResult,
  ): void {
    const latestAtSubscribe = this.eventReplay.latestRevision;
    let replay:
      | ReturnType<GatewayEventReplay["since"]>
      | null = null;
    // An invalid cursor is not safe to echo as an SSE id, and advancing to the
    // latest revision here could make a disconnect before reconcile-required
    // permanently skip the snapshot recovery signal.
    let connectedCursor: string | null = cursor.kind === "invalid"
      ? null
      : this.eventReplay.latestCursor;
    let replayStatus: "fresh" | "caught-up" | "replayed" | "reconcile" = "fresh";
    let reconcileReason: GatewayReconcileReason | null = null;
    let requestedRevision: number | null = null;

    if (cursor.kind === "invalid") {
      replayStatus = "reconcile";
      reconcileReason = "invalid-cursor";
    } else if (cursor.kind === "valid") {
      connectedCursor = cursor.raw;
      requestedRevision = cursor.revision;
      if (cursor.generation !== this.eventReplay.generation) {
        replayStatus = "reconcile";
        reconcileReason = "prior-generation";
      } else if (cursor.revision > this.eventReplay.latestRevision) {
        // Ahead of the server is the opposite of expired. Both reconcile, but
        // conflating them hides a corrupt cursor behind a routine ring overrun.
        replayStatus = "reconcile";
        reconcileReason = "cursor-ahead";
      } else {
        replay = this.eventReplay.since(cursor.revision);
        if (!replay.complete) {
          replayStatus = "reconcile";
          reconcileReason = "cursor-expired";
        } else if (!this.replayFitsClientBudget(client, replay.frames)) {
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
    this.metrics.recordReplayHandshake(replayStatus, reconcileReason, replayedFrames);
    if (!this.writeControlFrame(client, GATEWAY_CONNECTED_EVENT, connectedCursor, {
      generation: this.eventReplay.generation,
      revision: latestAtSubscribe,
      status: replayStatus,
      replayed: replayedFrames,
    })) return;
    if (!this.clients.has(client)) return;

    let highestSent = cursor.kind === "valid" ? cursor.revision : latestAtSubscribe;
    if (reconcileReason) {
      const currentCursor = this.eventReplay.latestCursor;
      if (!this.writeControlFrame(
        client,
        GATEWAY_RECONCILE_REQUIRED_EVENT,
        currentCursor,
        {
          reason: reconcileReason,
          requestedCursor: cursor.kind === "absent" ? null : cursor.raw,
          requestedRevision,
          oldestAvailableRevision: this.eventReplay.oldestRevision,
          latestRevision: this.eventReplay.latestRevision,
          generation: this.eventReplay.generation,
        },
      )) return;
      if (!this.clients.has(client)) return;
      highestSent = this.eventReplay.latestRevision;
    } else if (replay) {
      for (const frame of replay.frames) {
        if (!this.clients.has(client)) return;
        if (!this.writeReplayFrame(client, state, frame)) return;
        highestSent = Math.max(highestSent, frame.revision);
      }
    }

    // Stay in buffered mode until the dynamic end of the array. A write can
    // synchronously cause another backend event, and that later event must not
    // overtake an earlier buffered one.
    let index = 0;
    while (state.handshake && index < state.handshake.events.length) {
      const buffered = state.handshake.events[index]!;
      index += 1;
      if (buffered.revision !== null && buffered.revision <= highestSent) continue;
      if (!this.writeEventToClient(
        client,
        state,
        buffered.event,
        buffered.payload,
        buffered.message,
        buffered.messageBytes,
        buffered.droppable,
      )) return;
      if (buffered.revision !== null) highestSent = buffered.revision;
    }
    state.handshake = null;
    // Everything up to `highestSent` now carries an `id` this client has seen,
    // so any cursor omitted during the handshake is already superseded.
    state.sentRevision = highestSent;
    state.omittedRevision = null;
  }

  protected markTerminalFrameDropped(
    client: EventClientWriter,
    state: GatewayEventClient,
    event: string,
    message: string,
    payload: unknown,
  ): void {
    const sessionId = event.slice(DROPPABLE_EVENT_PREFIX.length);
    const streamAlreadyStalled = state.desyncedSessions.size > 0;
    state.desyncedSessions.add(sessionId);
    this.metrics.recordDroppedEventFrame(event);
    this.metrics.recordSoftDesync();
    if (!streamAlreadyStalled) this.metrics.recordStreamStalled();
    if (
      !sessionId.startsWith("tmux:")
      || !state.includedPrefixes?.includes(event)
    ) return;
    let frames = this.droppedTmuxFrames.get(client);
    if (!frames) {
      frames = new Map();
      this.droppedTmuxFrames.set(client, frames);
    }
    // A filtered terminal SSE can subscribe to several mounted sessions, so
    // retain at most the newest full-pane frame for each subscribed tmux
    // session. Broader/legacy streams receive the ordinary desync notice
    // instead of accumulating panes for terminals they are not displaying.
    if (
      payload
      && typeof payload === "object"
      && (payload as { full?: unknown }).full === true
    ) {
      frames.set(sessionId, message);
    } else {
      // A line patch cannot recover earlier dropped patches. Force the client
      // through the explicit desync path instead of replaying an incomplete pane.
      frames.delete(sessionId);
    }
  }

  protected dropBufferedClient(client: EventClientWriter, event: string, projectedBytes: number): void {
    this.logger.warn(
      `[RemoteGateway] Dropping an event-stream client buffering ${projectedBytes} bytes; it will reconnect and refetch`,
    );
    this.clients.delete(client);
    this.metrics.recordDroppedEventClient(event);
    this.metrics.recordStreamDropped();
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
  protected flushDesyncNotices(
    client: EventClientWriter,
    state: GatewayEventClient,
  ): boolean {
    for (const sessionId of [...state.desyncedSessions]) {
      const event = `${DROPPABLE_EVENT_PREFIX}${sessionId}`;
      const retainedTmuxFrame = this.droppedTmuxFrames.get(client)?.get(sessionId);
      const recoveryFrame = retainedTmuxFrame
        ?? `data: ${JSON.stringify({ event, payload: { desynced: true } })}\n\n`;
      const projectedBytes = client.writableLength + Buffer.byteLength(recoveryFrame);
      if (projectedBytes > SSE_CLIENT_HARD_BUFFER_BYTES) {
        this.dropBufferedClient(client, event, projectedBytes);
        return false;
      }
      // Retire the session before writing it. A write can emit "drain"
      // synchronously, and the drain handler re-enters here: leaving the session
      // pending across the write recurses on the same frame until the stack dies,
      // taking the recovery path down with it.
      if (retainedTmuxFrame) {
        const retained = this.droppedTmuxFrames.get(client);
        retained?.delete(sessionId);
        if (retained?.size === 0) this.droppedTmuxFrames.delete(client);
      }
      state.desyncedSessions.delete(sessionId);
      client.write(recoveryFrame);
      this.metrics.recordEvent(event, Buffer.byteLength(recoveryFrame));
    }
    return true;
  }

}
