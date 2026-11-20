// SSE Event broadcasting service
// Manages connections and broadcasts events to all subscribers

import type { SSEEvent } from "../types/index.js";
import { debugLog, isDebugLoggingEnabled } from "./logger.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { eventMovesSessionState, sessionStateRevisions } from "./state-revision.js";

const log = createLogger("bridge.claude");

type EventCallback = (event: SSEEvent, revision: number) => void;

class EventEmitter {
  private subscribers: Set<EventCallback> = new Set();
  /**
   * The observe stream's subscribers: every emitted event, plus the state
   * announcements of {@link announceState}, which the bridge's own listeners
   * (and tests that capture events) never see.
   */
  private observers: Set<EventCallback> = new Set();
  private revision = 0;
  /**
   * Revisions are process-local, so a cursor must also identify the process
   * generation that assigned it. Otherwise a reconnect after a bridge restart
   * can mistake an old, larger revision for a current cursor and silently skip
   * events emitted by the replacement process.
   */
  readonly generation = crypto.randomUUID();

  /**
   * Subscribe to SSE events
   */
  subscribe(callback: EventCallback): () => void {
    this.subscribers.add(callback);
    debugLog("[event-emitter] Subscriber added", { count: this.subscribers.size });
    return () => {
      this.subscribers.delete(callback);
      debugLog("[event-emitter] Subscriber removed", { count: this.subscribers.size });
    };
  }

  /** Subscribe the observe stream: events and state announcements alike. */
  subscribeObserver(callback: EventCallback): () => void {
    this.observers.add(callback);
    return () => {
      this.observers.delete(callback);
    };
  }

  /**
   * A session's state changed where no event is emitted (a status flip at
   * prompt admission, a settle, a close): move its state revision and tell the
   * observe stream, without an event for the bridge's own listeners.
   * Synchronous; safe in SDK listeners.
   */
  announceState(sessionId: string): void {
    const revision = ++this.revision;
    sessionStateRevisions.bump(sessionId);
    this.fanOut(this.observers, { type: "session.updated", sessionId }, revision);
  }

  /**
   * Broadcast an event to all subscribers
   */
  emit(event: SSEEvent): void {
    const revision = ++this.revision;
    // Before the fan-out, so the observe frame carries the moved revision.
    if (event.sessionId && eventMovesSessionState(event.type)) {
      sessionStateRevisions.bump(event.sessionId);
    }
    // Guarded rather than passed through `debugLog`: this runs on every
    // streamed frame, and the object literal would otherwise be allocated
    // per emit only to be dropped.
    if (isDebugLoggingEnabled()) {
      debugLog("[event-emitter] Emitting event", {
        type: event.type,
        sessionId: event.sessionId,
        subscribers: this.subscribers.size,
      });
    }
    this.fanOut(this.subscribers, event, revision);
    this.fanOut(this.observers, event, revision);
  }

  private fanOut(callbacks: Set<EventCallback>, event: SSEEvent, revision: number): void {
    for (const callback of callbacks) {
      try {
        callback(event, revision);
      } catch (error) {
        log.error("event-subscriber.failed", { error: formatLogError(error) });
      }
    }
  }

  /**
   * Get the number of active subscribers
   */
  get subscriberCount(): number {
    return this.subscribers.size + this.observers.size;
  }

  /** Monotonic cursor assigned before each synchronous fan-out. */
  get currentRevision(): number {
    return this.revision;
  }

  /** Opaque SSE cursor for the current process generation and revision. */
  get currentCursor(): string {
    return `${this.generation}:${this.revision}`;
  }
}

// Singleton instance
export const eventEmitter = new EventEmitter();
