/**
 * The web's one domain-client helper (plan items 7002 and 7010, report §11.2
 * "Client adapters"): `def`'s client over a `lib/backend` factory client.
 * Every binding in this folder (`terminals(client)`, `nativeSessions(client)`,
 * `projects(client)`, ...) and every `lib/backend` function that calls a
 * domain directly goes through {@link domainApi}. Before 7010 there were
 * three copies of this (7001's `nativeSessionsDomainClient`, 7002's
 * `domainApi`, 7003's `backendDomainApi` in `lib/backend/domain-client.ts`);
 * the client builders that file also held are `machineBackendClient` and
 * `withArgumentsObject` (`lib/backend/client.ts`) and `routedBackendClient`
 * (`lib/portal/routed-backend-client.ts`).
 *
 * The adapter is picked from the node's negotiated `domains`, which the
 * command-scope and per-scope factory clients carry (`lib/backend/client.ts`):
 *
 * - a node that advertises the domain gets its version: the envelope travels
 *   with the call (`invokeRaw(command, args, { envelope })`) and results are
 *   decoded with the command's schema, so callers get the protocol's types;
 * - any other node (pre-contract, or a client that carries no negotiation,
 *   such as a routed, machine or portal client) gets version 0, whose calls
 *   are exactly today's `invokeRaw(command, args)`, or `invokeRaw(command)`
 *   for a call without arguments (`undefined` or an empty object: every
 *   transport sends both as `args: {}`, so the two are the same call; a
 *   function that always sent `{}` keeps doing so over
 *   `withArgumentsObject(client)`). Suites that mock `invoke` see the same
 *   calls as before.
 *
 * Call {@link domainApi} per use: the client is made once per factory client
 * and definition (a `WeakMap`), and the API it answers is the adapter for the
 * current connection generation, so a node that reconnects to another build
 * picks again.
 *
 * `hotPath` results (terminal input, resize and output reads) are decoded
 * only in development and tests (`validateHotPathResults`), as the backend
 * validates results only there (plan item 1003): the keystroke path gains no
 * per-call validation in production.
 *
 * Version-0 calls are counted (`domain-adapter-usage-ring.ts`) only for a
 * client that carries the node's `domains`: one without negotiation cannot
 * tell the node's range, and counting it would keep the adapter alive.
 */
import {
  createDomainClient,
  type ApiOf,
  type ContractEnvelopeFields,
  type DomainClient,
  type DomainClientDef,
} from "@orkestrator/protocol/contract/client";
import type { BackendClient } from "@/lib/backend/client";
import { recordDomainAdapterUsage } from "@/lib/domain-adapter-usage-ring";

/** Whether this renderer decodes hot-path results: in development and tests only. */
export function rendererValidatesHotPathResults(
  env: Readonly<Record<string, unknown>> = import.meta.env as unknown as Record<string, unknown>,
): boolean {
  return env.DEV === true || env.MODE === "test" || env.NODE_ENV === "test";
}

const VALIDATE_HOT_PATH = rendererValidatesHotPathResults();

const bound = new WeakMap<BackendClient, Map<DomainClientDef, DomainClient<unknown>>>();

function isEmptyArgs(args: unknown): boolean {
  return (
    args === undefined ||
    (typeof args === "object" && args !== null && Object.keys(args).length === 0)
  );
}

/**
 * The wire call: with an envelope the arguments object is always sent; without
 * one (version 0) today's body, without an arguments object when there are none.
 */
function invokeWire(
  client: BackendClient,
  command: string,
  args: unknown,
  envelope: ContractEnvelopeFields | undefined,
): Promise<unknown> {
  const wire = args as Readonly<Record<string, unknown>> | undefined;
  if (envelope) return client.invokeRaw(command, wire ?? {}, { envelope });
  return isEmptyArgs(wire) ? client.invokeRaw(command) : client.invokeRaw(command, wire);
}

/** `def`'s client bound to `client`'s node, made once per client and domain. */
export function domainClientFor<D extends DomainClientDef>(
  client: BackendClient,
  def: D,
): DomainClient<ApiOf<D>> {
  let clients = bound.get(client);
  if (!clients) {
    clients = new Map();
    bound.set(client, clients);
  }
  const existing = clients.get(def);
  if (existing) return existing as DomainClient<ApiOf<D>>;
  const created = createDomainClient(def as DomainClientDef<D["domain"], ApiOf<D>>, {
    call: (command, args, envelope) => invokeWire(client, command.name, args, envelope),
    domains: () => client.domains?.get() ?? null,
    capabilities: () => client.capabilities?.get() ?? null,
    invoke: (command, args) => invokeWire(client, command, args, undefined),
    ...(client.domains ? { usage: recordDomainAdapterUsage } : {}),
    validateHotPathResults: VALIDATE_HOT_PATH,
  });
  clients.set(def, created as DomainClient<unknown>);
  return created;
}

/** `def`'s API on `client`'s node for the current connection generation. */
export function domainApi<D extends DomainClientDef>(client: BackendClient, def: D): ApiOf<D> {
  return domainClientFor(client, def).api();
}
