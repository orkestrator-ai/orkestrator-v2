/**
 * A node client's negotiated hello (report §11.2 "Negotiation", plan item
 * 2011): the `domains` and `capabilities` of the node's hello for the current
 * connection generation, and the installation id it proved.
 *
 * Each client reads the hello through its own transport when a connection
 * (re)opens and calls `refresh()`; the values change only when the hello is
 * of another generation (`installationId` and `generation` differ), so a
 * reconnect to the same backend process keeps every object's identity and a
 * domain client keeps its picked adapter. A reconnect to an upgraded or
 * restarted backend publishes new objects, and every domain client picks
 * again.
 *
 * - A node that answers without a hello (it predates the handshake), or with
 *   one that does not parse, is pre-contract: `domains` and `capabilities`
 *   are `null`, and its domain clients use the legacy version-0 adapters.
 * - A hello without `domains` is pre-contract too, but its `capabilities`
 *   still gate the legacy adapters.
 * - A read that cannot tell (unreachable, refused, timed out) changes
 *   nothing: a transient failure is never read as a pre-contract node, and
 *   the next connection reads again.
 */

import { parseBackendHello, type BackendHello } from "@orkestrator/protocol/backend-profile";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NegotiatedDomains, ReadableSignal } from "@orkestrator/protocol/node-client";
import { createSignal } from "./signal";

/**
 * Reads the node's hello. Answers the hello (any value `parseBackendHello`
 * accepts), `null` when the node answered without one, or `undefined` when
 * it is not known yet (nothing to change). Throws when it cannot tell.
 */
export type HelloSource = () => Promise<unknown>;

export interface HelloNegotiation {
  readonly domains: ReadableSignal<NegotiatedDomains | null>;
  readonly capabilities: ReadableSignal<ReadonlySet<string> | null>;
  /** The installation identity the current generation's hello proved, or `null`. */
  readonly installationId: ReadableSignal<BackendId | null>;
  /**
   * Reads the hello again. At most one read runs; a refresh asked for during
   * one runs once more after it. Never rejects.
   */
  refresh(): Promise<void>;
  /** Reads the hello unless one was answered already or a read is running. */
  ensure(): Promise<void>;
  /** Stops publishing; a read in flight is ignored. Idempotent. */
  dispose(): void;
}

/** The hello in `value`, or `null` when it is none (an older backend's answer). */
export function helloFrom(value: unknown): BackendHello | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  try {
    return parseBackendHello(value);
  } catch {
    return null;
  }
}

/** The capability names a hello advertises at version 1 or above. */
function capabilityNames(hello: BackendHello): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [name, version] of Object.entries(hello.capabilities)) {
    if (version >= 1) names.add(name);
  }
  return names;
}

export function createHelloNegotiation(source: HelloSource): HelloNegotiation {
  const domains = createSignal<NegotiatedDomains | null>(null);
  const capabilities = createSignal<ReadonlySet<string> | null>(null);
  const installationId = createSignal<BackendId | null>(null);
  /** The generation now published; `undefined` until the first answer. */
  let generation: string | undefined;
  let disposed = false;
  let running: Promise<void> | null = null;
  let again = false;

  const apply = (value: unknown) => {
    if (value === undefined) return;
    const hello = helloFrom(value);
    const next = hello ? `${hello.installationId}\u0000${hello.generation}` : "";
    if (next === generation) return;
    generation = next;
    // Capabilities first: a `domains` subscriber that reads them sees this
    // generation's.
    capabilities.set(hello ? capabilityNames(hello) : null);
    installationId.set(hello?.installationId ?? null);
    domains.set(hello?.domains ? Object.freeze({ ...hello.domains }) : null);
  };

  const run = async () => {
    do {
      again = false;
      try {
        const value = await source();
        if (!disposed) apply(value);
      } catch {
        // Not known this time; the next connection reads again.
      }
    } while (again && !disposed);
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
    });
    return running;
  };

  return {
    domains,
    capabilities,
    installationId,
    refresh,
    ensure() {
      if (disposed || generation !== undefined) return Promise.resolve();
      return running ?? refresh();
    },
    dispose() {
      disposed = true;
    },
  };
}
