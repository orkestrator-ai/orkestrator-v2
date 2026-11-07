/**
 * The per-node transport contract a renderer scope talks through
 * (docs/reports/unified-federation.md §6.1).
 *
 * One `NodeClient` exists per node a window has opened: the command node the
 * window is connected to, and every leaf it shows in-tree. Every listener is
 * registered on one client, so event delivery is per node by construction
 * (§6.4); nothing here is global.
 *
 * Types only and browser-safe: this module has no runtime code, imports
 * nothing Node- or Bun-specific, and is safe to import from the renderer,
 * desktop main and the backend alike. Implementations live with their host:
 * the browser and iOS client over the node transport (plan item 2010), the
 * desktop client over the preload's `node(nodeId)` API (2007), and the
 * command-scope adapter over today's `window.orkestrator` in
 * `apps/web/src/lib/node-scope/command-client.ts` (2001).
 *
 * The typed `listen(def, handler)` over `@orkestrator/protocol/contract`
 * event definitions came with plan item 7011; the typed `invoke(def, args)`,
 * the negotiated `domains` and the hello's `capabilities` with plan item 2011.
 * The untyped migration members `invokeRaw` and `listenRaw` stay until every
 * call site is typed.
 */

import type { ContractEnvelopeFields } from "./contract/client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "./contract/command.js";
import type { AnyEventDef, PayloadOf } from "./contract/event.js";
import type { BackendId } from "./federation.js";

/** Stops a listener or subscription. Calling it again does nothing. */
export type Unlisten = () => void;

/**
 * A value that changes over time and can be observed without a framework.
 *
 * The shape matches React's `useSyncExternalStore(subscribe, get)`: `get` must
 * return the same value (by `Object.is`) until the value changes, and
 * `subscribe` returns its own unsubscribe. A listener is called with the new
 * value after it changed, never for the value current at subscription time.
 */
export interface ReadableSignal<T> {
  get(): T;
  subscribe(listener: (value: T) => void): Unlisten;
}

/**
 * How a node's connection stands, as the scope's stores and the title bar see it.
 *
 * - `connecting`: no authoritative stream yet (first open, or reconnecting).
 * - `live`: the event stream is up and stores may trust incremental events.
 * - `resyncing`: the stream is up again after a gap (expired cursor, new
 *   generation); stores are re-reading authoritative snapshots (invariants 3, 4).
 * - `lapsed`: the grant expired or was revoked; the registry is reopening it.
 * - `failed`: the node cannot be reached or refused the grant; a retry is
 *   user-initiated.
 */
export type NodeConnectionState = "connecting" | "live" | "resyncing" | "lapsed" | "failed";

/** A domain's accepted version range, as a node's hello advertises it (plan item 1004). */
export interface NegotiatedDomainRange {
  readonly min: number;
  readonly max: number;
}

/**
 * The domain versions negotiated with a node for its current connection
 * generation (§11), keyed by domain name. Unknown domain names are kept.
 */
export type NegotiatedDomains = Readonly<Record<string, NegotiatedDomainRange>>;

/**
 * The terminal half of a node transport.
 *
 * Terminal input is ordered by the transport's input sequencer and travels as
 * an ordinary `invokeRaw` (`terminal_write`, `terminal_resize`, ...), so only
 * the output side needs its own surface: per session it may arrive over the
 * main stream (desktop IPC), a filtered SSE stream or the multiplexed terminal
 * WebSocket, and the client picks. Payloads stay opaque until the terminals
 * domain is typed (plan item 7002).
 */
export interface NodeTerminalTransport {
  /** Subscribes to one terminal session's output frames on this node. */
  listenOutput(sessionId: string, handler: (payload: unknown) => void): Unlisten;
  /**
   * Resolves once that session's output stream is live. It may stay pending
   * while the transport retries, so callers bound their wait.
   */
  outputReady(sessionId: string): Promise<void>;
}

/** Options of an untyped call. */
export interface NodeInvokeOptions {
  /**
   * The invoke envelope's contract fields (`domain`, `version`, `critical`),
   * sent next to `command` and `args`. Never the arguments themselves: over
   * desktop IPC they travel positionally and the envelope is bounded (plan
   * item 1003). Absent for a legacy call, which is today's `{ command, args }`.
   */
  readonly envelope?: ContractEnvelopeFields;
}

export interface NodeClient {
  /**
   * The node's installation identity, or a provisional one until it is
   * proven. The command scope's client may replace a provisional id with the
   * one its hello proves (plan item 2011); no other client's id changes.
   */
  readonly nodeId: BackendId;
  /**
   * Typed command call (plan item 2011): sends `def` with the envelope for
   * this build's version of its domain (`domain`, `version`, and the
   * `critical` keys `args` carries) and answers the result decoded against the
   * definition's schema (tolerantly; a mismatch throws the
   * `InvalidCommandResultError`). A node whose range excludes that version
   * refuses with a typed `unsupported-version`; code that must also speak to
   * older nodes calls through a domain client (`scope.domain(def)`), whose
   * adapters pick the version.
   */
  invoke<C extends AnyCommandDef>(def: C, args: ArgsOf<C>): Promise<ResultOf<C>>;
  /**
   * Untyped command call, for migration only: the typed `invoke(def, args)`
   * replaces it domain by domain (2011, Phase 7). The result is not validated;
   * the type argument is the caller's assertion. `options.envelope` is how
   * `invoke` and domain clients send the contract fields.
   */
  invokeRaw<T = unknown>(
    command: string,
    args?: Readonly<Record<string, unknown>>,
    options?: NodeInvokeOptions,
  ): Promise<T>;
  /** Untyped event subscription, for migration only: `listen(def, handler)` replaces it. */
  listenRaw<T = unknown>(event: string, handler: (payload: T) => void): Unlisten;
  /**
   * Typed event subscription (plan item 7011): `def` is a backend event from
   * `@orkestrator/protocol/contract/domains/events` (a family member through
   * `family.at(key)`). The handler receives payloads that decode against the
   * definition's schema, as sent; a payload that does not decode is dropped
   * and reported content-free. Implementations build it with `listenEvent`
   * over `listenRaw`.
   */
  listen<E extends AnyEventDef>(def: E, handler: (payload: PayloadOf<E>) => void): Unlisten;
  /**
   * Resolves once the stream that carries `event` is live; without an event,
   * once the node's main event stream is. It may stay pending while the
   * transport retries, so callers bound their wait.
   */
  eventStreamReady(event?: string): Promise<void>;
  readonly terminal: NodeTerminalTransport;
  readonly connection: ReadableSignal<NodeConnectionState>;
  /**
   * The domain ranges the node's hello advertised for the current connection
   * generation (§11.2 "Negotiation"). `null` while unknown, and for a
   * pre-contract node (§11.4): both get the legacy version-0 adapters. The
   * hello is read once per connection generation; the value is a new object
   * exactly when a new generation's hello was read, so a domain client keyed
   * on its identity picks again then and only then.
   */
  readonly domains: ReadableSignal<NegotiatedDomains | null>;
  /**
   * The capability names of that same hello, which legacy adapters gate on.
   * `null` while unknown and for a node that answered no hello. Changes
   * together with `domains`.
   */
  readonly capabilities: ReadableSignal<ReadonlySet<string> | null>;
  /** Closes this client's streams but keeps their cursors (a suspended scope, §8.1). */
  suspend(): void;
  /** Reopens the streams from their cursors; a gap yields a resync frame. */
  resume(): void;
  /** Revokes the grant and closes everything. Idempotent. */
  dispose(): void;
}
