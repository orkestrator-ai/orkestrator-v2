/**
 * The command node's domain clients for its peers (plan item 1010;
 * docs/reports/unified-federation.md §11.2 "Client adapters", §11.4).
 *
 * The pilot domains (`node-mail`, `node-files`, `ticket-sync`) are called
 * backend to backend, so their clients live here, on the sending side: one
 * client per peer and domain, which picks an adapter from the peer's hello
 * once per connection generation. A peer whose hello advertises the domain
 * gets version 1, with the contract envelope (`domain`, `version`,
 * `critical`); a pre-contract peer gets the legacy adapter, version 0, which
 * keeps today's capability gating and sends today's `{ command, args }`.
 * Calls through an adapter below the current version are counted as
 * `domain-adapter.backend.<domain>.v<version>` (`backendDomainAdapterUsage`).
 *
 * Two transports reach a peer: the node link itself (the mail collector and
 * ticket sync, {@link linkDomainApi}), and the portal's routing (`invoke_on_node`
 * with its outcome ledger, which the coordinator tools and file transfers use,
 * {@link routedDomainApi}). Both pass the picked envelope through.
 */
import {
  createDomainClient,
  type DomainCall,
  type DomainClient,
  type DomainClientDef,
  type LegacyInvoke,
} from "@orkestrator/protocol/contract/client";
import type { AnyDomainDef } from "@orkestrator/protocol/contract/domain";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";

import { backendDomainAdapterUsage } from "../domain-adapter-usage.js";
import type { ContractEnvelope } from "./node-link.js";

/** The parts of a peer's hello a domain client reads. */
export interface PeerHello {
  readonly capabilities?: Readonly<Record<string, number>>;
  readonly domains?: NegotiatedDomains;
}

const capabilitySets = new WeakMap<object, ReadonlySet<string>>();

/**
 * The hello's capabilities (those at version 1 or above) as a set, one set
 * per `capabilities` object, so a domain client's per-generation cache keeps
 * its choice while the hello is the same.
 */
export function helloCapabilitySet(
  hello: PeerHello | null | undefined,
): ReadonlySet<string> | null {
  const capabilities = hello?.capabilities;
  if (!capabilities) return null;
  let set = capabilitySets.get(capabilities);
  if (!set) {
    set = new Set(
      Object.entries(capabilities)
        .filter(([, version]) => typeof version === "number" && version >= 1)
        .map(([name]) => name),
    );
    capabilitySets.set(capabilities, set);
  }
  return set;
}

/** A domain client for one peer, over any transport that can carry an envelope. */
export function peerDomainClient<Api>(
  def: DomainClientDef<AnyDomainDef, Api>,
  peer: {
    hello(): PeerHello | null | undefined;
    call: DomainCall;
    invoke?: LegacyInvoke;
  },
): DomainClient<Api> {
  return createDomainClient(def, {
    call: peer.call,
    domains: () => peer.hello()?.domains,
    capabilities: () => helloCapabilitySet(peer.hello()),
    ...(peer.invoke ? { invoke: peer.invoke } : {}),
    usage: backendDomainAdapterUsage,
  });
}

/** A node link as the mail collector and ticket sync see it. */
export interface EnvelopeLink {
  readonly hello?: PeerHello | null;
  invoke<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: { envelope?: ContractEnvelope },
  ): Promise<T>;
}

const linkClients = new WeakMap<object, Map<string, DomainClient<unknown>>>();

/**
 * The domain's API on the peer behind `link`. The client is kept per link
 * and domain; it re-picks when the link's hello changes (a new generation).
 */
export function linkDomainApi<Api>(
  link: EnvelopeLink,
  def: DomainClientDef<AnyDomainDef, Api>,
): Api {
  let clients = linkClients.get(link);
  if (!clients) {
    clients = new Map();
    linkClients.set(link, clients);
  }
  let client = clients.get(def.domain.name) as DomainClient<Api> | undefined;
  if (!client) {
    client = peerDomainClient(def, {
      hello: () => link.hello,
      call: (command, args, envelope) =>
        envelope
          ? link.invoke(command.name, args as Record<string, unknown>, { envelope })
          : link.invoke(command.name, args as Record<string, unknown>),
      invoke: (command, args) => link.invoke(command, { ...args }),
    });
    clients.set(def.domain.name, client as DomainClient<unknown>);
  }
  return client.api();
}

/**
 * The domain's API on a peer reached through the portal's routing: `route`
 * runs one command there (with `invoke_on_node`'s outcome ledger) and answers
 * its result. Built per use, because the routed transport carries a request
 * key per call; selection is one identity check, so that costs nothing.
 */
export function routedDomainApi<Api>(
  def: DomainClientDef<AnyDomainDef, Api>,
  hello: () => PeerHello | null | undefined,
  route: (
    command: string,
    args: Record<string, unknown>,
    envelope: ContractEnvelope | undefined,
  ) => Promise<unknown>,
): Api {
  return peerDomainClient(def, {
    hello,
    call: (command, args, envelope) =>
      route(command.name, args as Record<string, unknown>, envelope),
    invoke: (command, args) => route(command, { ...args }, undefined),
  }).api();
}
