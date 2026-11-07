/**
 * Domain clients (docs/reports/unified-federation.md §11.2, "Client
 * adapters"; Decision 13.6).
 *
 * A domain client is one API with an adapter per domain version it can speak:
 *
 * ```ts
 * export const environmentsClient = domainClient(environments, {
 *   4: (call) => ({ list: (projectId: string) => call(listEnvironments, { projectId }) }),
 *   3: (call) => ({ list: async (projectId: string) => upgradeV3(await call(listEnvironmentsV3, { projectId })) }),
 *   0: (call) => legacyEnvironmentsApi(call),
 * });
 * ```
 *
 * The caller (a node scope, plan item 2011, or a backend sender, plan item
 * 1010) picks one adapter per connection generation with {@link pickVersion}
 * and never sees versions again. Building the client over a transport,
 * caching the choice and the coded `unsupported-version` refusal are plan item
 * 1009 (`createDomainClient`). This module is scope-agnostic and lives in
 * protocol because the pilot domains are called backend to backend.
 *
 * Version 0 is the legacy adapter: today's capability-gated behaviour for a
 * node that advertises no range for the domain, either because its hello has
 * no `domains` at all (a pre-contract node, §11.4) or because the domain has
 * no defined commands on it yet. An adapter for version `v` is deleted when
 * the support floor passes the first Stable release with `v + 1`.
 *
 * Browser-safe: types and plain functions only.
 */
import type { NegotiatedDomainRange } from "../node-client.js";
import type { AnyCommandDef, ArgsOf, ResultOf } from "./command.js";
import type { AnyDomainDef } from "./domain.js";

/** The legacy adapter version, used for a node with no range for the domain. */
export const LEGACY_DOMAIN_VERSION = 0;

/** The range a node with no contract information for a domain is treated as having. */
export const PRE_CONTRACT_RANGE: NegotiatedDomainRange = Object.freeze({ min: 0, max: 0 });

/** The transport an adapter calls through, typed by the command definition. */
export type CommandCall = <C extends AnyCommandDef>(
  def: C,
  args: ArgsOf<C>,
) => Promise<ResultOf<C>>;

/** Builds a domain's API for one version over a transport. */
export type DomainAdapter<Api> = (call: CommandCall) => Api;

/** A domain client definition. Create it with {@link domainClient}; it is frozen. */
export interface DomainClientDef<Domain extends AnyDomainDef = AnyDomainDef, Api = unknown> {
  readonly kind: "domain-client";
  readonly domain: Domain;
  /** One adapter per domain version, keyed by version. */
  readonly adapters: Readonly<Record<number, DomainAdapter<Api>>>;
  /** The adapter versions, highest first. */
  readonly versions: readonly number[];
}

/** The API a domain client gives, whichever version is picked. */
export type ApiOf<D extends DomainClientDef> =
  D extends DomainClientDef<AnyDomainDef, infer Api> ? Api : never;

/**
 * Defines a domain client. Every adapter must give the same `Api`. Throws on
 * a version key outside `0..domain.version`, or when the domain's current
 * version has no adapter (a build always speaks its own version).
 */
export function domainClient<const Domain extends AnyDomainDef, Api>(
  domain: Domain,
  adapters: Readonly<Record<number, DomainAdapter<Api>>>,
): DomainClientDef<Domain, Api> {
  const versions = Object.keys(adapters).map(Number);
  for (const version of versions) {
    if (!Number.isSafeInteger(version) || version < 0 || version > domain.version) {
      throw new Error(
        `Domain client ${domain.name}: adapter versions must be 0 to ${domain.version}.`,
      );
    }
    if (typeof adapters[version] !== "function") {
      throw new Error(`Domain client ${domain.name}: adapter ${version} is not a function.`);
    }
  }
  if (!versions.includes(domain.version)) {
    throw new Error(
      `Domain client ${domain.name}: no adapter for the current version ${domain.version}.`,
    );
  }
  versions.sort((a, b) => b - a);
  return Object.freeze({
    kind: "domain-client",
    domain,
    adapters: Object.freeze({ ...adapters }),
    versions: Object.freeze(versions),
  });
}

/**
 * The highest version in `clientVersions` that the node accepts, or `null`
 * when the ranges are disjoint.
 *
 * `negotiated` is the node's advertised `{ min, max }` for the domain. `null`
 * or `undefined` means the node gave no range for it (a pre-contract node, or
 * a domain it does not advertise), which is version 0 only: the legacy
 * adapter, when the client has one.
 */
export function pickVersion(
  clientVersions: Iterable<number>,
  negotiated: NegotiatedDomainRange | null | undefined,
): number | null {
  const range = negotiated ?? PRE_CONTRACT_RANGE;
  let picked: number | null = null;
  for (const version of clientVersions) {
    if (version >= range.min && version <= range.max && (picked === null || version > picked)) {
      picked = version;
    }
  }
  return picked;
}
