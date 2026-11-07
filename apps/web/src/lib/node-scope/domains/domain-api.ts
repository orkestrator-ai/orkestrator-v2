/**
 * A domain client over a `lib/backend` factory's client (plan item 7002,
 * report §11.2 "Client adapters"), for domains whose API is their command
 * list (`commandApi`): `terminals`, `files` and `claude-tmux`.
 *
 * The adapter is picked from the node's negotiated `domains`, which the
 * command-scope and per-scope factory clients carry (`lib/backend/client.ts`):
 *
 * - a node that advertises the domain gets version 1: the envelope travels
 *   with the call (`invokeRaw(command, args, { envelope })`) and results are
 *   decoded with the command's schema, so callers get the protocol's types;
 * - any other node (pre-contract, or a client that carries no negotiation,
 *   such as the portal's) gets version 0, whose calls are exactly today's
 *   `invokeRaw(command, args)`. Suites that mock `invoke` see the same calls.
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

/** Today's call without an envelope; with one, the arguments object is always sent. */
function invokeWire(
  client: BackendClient,
  command: string,
  args: unknown,
  envelope: ContractEnvelopeFields | undefined,
): Promise<unknown> {
  const wire = args as Readonly<Record<string, unknown>> | undefined;
  if (envelope) return client.invokeRaw(command, wire ?? {}, { envelope });
  return wire === undefined ? client.invokeRaw(command) : client.invokeRaw(command, wire);
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
