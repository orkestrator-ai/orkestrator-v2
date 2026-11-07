/**
 * The smallest observable value: what `ReadableSignal` describes, plus a
 * setter for its owner. React reads one with `useSignal` (`providers.tsx`).
 */

import type { ReadableSignal, Unlisten } from "@orkestrator/protocol/node-client";

export interface WritableSignal<T> extends ReadableSignal<T> {
  /** Sets the value and notifies listeners, unless it is unchanged (`Object.is`). */
  set(value: T): void;
}

/**
 * A signal holding `initial`. `get` and `subscribe` are bound, so they can be
 * passed around (to `useSyncExternalStore`, say) without the object. A
 * listener that throws does not stop the others; the error is rethrown on a
 * microtask so it is still reported.
 */
export function createSignal<T>(initial: T): WritableSignal<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    subscribe(listener): Unlisten {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of Array.from(listeners)) {
        try {
          listener(next);
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    },
  };
}

/** A signal that never changes. */
export function constantSignal<T>(value: T): ReadableSignal<T> {
  return { get: () => value, subscribe: () => () => {} };
}
