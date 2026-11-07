/**
 * A node client's own listener table over a transport: one transport
 * subscription per event name, however many handlers share it, so the client
 * can detach every subscription (`suspend`) and attach them again (`resume`)
 * without its callers re-registering anything.
 */

import type { Unlisten } from "@orkestrator/protocol/node-client";

type Handler = (payload: unknown) => void;

/** Subscribes `deliver` to `event` on the transport; returns its unsubscribe. */
export type AttachEvent = (event: string, deliver: Handler) => Unlisten;

export interface ListenerFanout {
  /** Registers `handler`; attaches the event unless suspended or closed. */
  add(event: string, handler: Handler): Unlisten;
  /** Detaches every transport subscription and keeps the handlers. */
  suspend(): void;
  /** Attaches every event that still has handlers. */
  resume(): void;
  /** Detaches everything and drops every handler; later `add`s register nothing. */
  close(): void;
  readonly suspended: boolean;
  /** Events with at least one handler. */
  events(): string[];
}

export function createListenerFanout(attach: AttachEvent): ListenerFanout {
  const handlers = new Map<string, Set<Handler>>();
  const attached = new Map<string, Unlisten>();
  let suspended = false;
  let closed = false;

  const deliver = (event: string) => (payload: unknown) => {
    for (const handler of Array.from(handlers.get(event) ?? [])) handler(payload);
  };
  const attachEvent = (event: string) => {
    if (suspended || closed || attached.has(event)) return;
    attached.set(event, attach(event, deliver(event)));
  };
  const detachEvent = (event: string) => {
    const stop = attached.get(event);
    if (!stop) return;
    attached.delete(event);
    stop();
  };
  const detachAll = () => {
    for (const event of Array.from(attached.keys())) detachEvent(event);
  };

  return {
    add(event, handler) {
      if (closed) return () => {};
      const set = handlers.get(event) ?? new Set<Handler>();
      handlers.set(event, set);
      set.add(handler);
      attachEvent(event);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        set.delete(handler);
        if (set.size > 0 || handlers.get(event) !== set) return;
        handlers.delete(event);
        detachEvent(event);
      };
    },
    suspend() {
      if (closed || suspended) return;
      suspended = true;
      detachAll();
    },
    resume() {
      if (closed || !suspended) return;
      suspended = false;
      for (const event of handlers.keys()) attachEvent(event);
    },
    close() {
      if (closed) return;
      closed = true;
      detachAll();
      handlers.clear();
    },
    get suspended() {
      return suspended;
    },
    events: () => Array.from(handlers.keys()),
  };
}
