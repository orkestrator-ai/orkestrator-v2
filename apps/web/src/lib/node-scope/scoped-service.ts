/**
 * Per-node background services (report §7.4 and §10.3).
 *
 * A service is anything a scope runs on its own: a subscription, a poll, a
 * persistence writer. Its definition starts it for one scope and returns how
 * to stop it:
 *
 * ```ts
 * export const resourceSync = defineScopedService("resource-sync", (scope, signal) => {
 *   const stopListening = scope.client.listen(resourceChangedEvent, onChanged);
 *   const done = refreshLoop(scope, signal); // a promise that settles when the loop ends
 *   return { stop: stopListening, done };
 * });
 * scope.service(resourceSync); // starts it once; again returns the running handle
 * ```
 *
 * Lifecycle (each running service owns a child `Lifetime` of its node scope):
 *
 * - `scope.service(def)` starts the service if it is not running and returns
 *   its handle; while it runs, further calls return the same handle.
 * - `handle.stop()`, disposing the scope, or a failure ends the service's
 *   lifetime: its `stop()` runs, then its `AbortSignal` aborts. Both happen at
 *   most once.
 * - A failure is `start` throwing, or the optional `done` promise rejecting
 *   while the signal is not aborted. It stops only that service, records a
 *   content-free `web.node-scope service.failed` event (service name, scope
 *   role and error kind; never the message) and marks the scope `failed`.
 *   Other services and other scopes keep running. Starting the service again
 *   clears its failure; the scope is healthy once no service is failed.
 * - Every consumer of `signal` must handle the rejection an abort causes
 *   (AGENTS.md "Unhandled Rejections Are Fatal"). The scope attaches its own
 *   handler to `done`, so returning it is always safe.
 *
 * Unmounting a component never stops a service (invariant 2); only the
 * explicit stops above do, and tests call them in `afterEach` (invariant 15).
 */

import type { NodeScope } from "./node-scope";

/** What a service's `start` returns: its stop, an optional completion, and any API it offers. */
export interface ScopedServiceInstance {
  /** Stops everything the service scheduled. Called at most once. */
  stop(): void;
  /**
   * Settles when the service's own async work ends. A rejection while the
   * service is running fails it; one after stop or abort is ignored.
   */
  readonly done?: PromiseLike<unknown>;
}

export interface ScopedServiceDef<A extends ScopedServiceInstance = ScopedServiceInstance> {
  readonly kind: "scoped-service";
  /** Unique, bounded and stable: it names the service in logs. */
  readonly name: string;
  start(scope: NodeScope, signal: AbortSignal): A;
}

export function defineScopedService<A extends ScopedServiceInstance>(
  name: string,
  start: (scope: NodeScope, signal: AbortSignal) => A,
): ScopedServiceDef<A> {
  return Object.freeze({ kind: "scoped-service" as const, name, start });
}

export type ScopedServiceStatus = "running" | "stopped" | "failed";

export interface ScopedServiceHandle<A extends ScopedServiceInstance = ScopedServiceInstance> {
  readonly name: string;
  readonly status: ScopedServiceStatus;
  /** What `start` returned; `null` if `start` threw. */
  readonly instance: A | null;
  /** Aborts once the service stops, fails or its scope is disposed. */
  readonly signal: AbortSignal;
  /** Stops the service. Idempotent; a no-op once it has stopped or failed. */
  stop(): void;
}
