// SSE Event broadcasting service
// Manages connections and broadcasts events to all subscribers

import type { SSEEvent } from "../types/index.js";
import { debugLog, isDebugLoggingEnabled } from "./logger.js";

type EventCallback = (event: SSEEvent) => void;

class EventEmitter {
  private subscribers: Set<EventCallback> = new Set();

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

  /**
   * Broadcast an event to all subscribers
   */
  emit(event: SSEEvent): void {
    // Guarded rather than passed through `debugLog`: this runs on every
    // streamed frame, and the object literal would otherwise be allocated
    // per emit only to be dropped.
    if (isDebugLoggingEnabled) {
      debugLog("[event-emitter] Emitting event", {
        type: event.type,
        sessionId: event.sessionId,
        subscribers: this.subscribers.size,
      });
    }
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch (error) {
        console.error("[event-emitter] Error in subscriber callback:", error);
      }
    }
  }

  /**
   * Get the number of active subscribers
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

// Singleton instance
export const eventEmitter = new EventEmitter();
