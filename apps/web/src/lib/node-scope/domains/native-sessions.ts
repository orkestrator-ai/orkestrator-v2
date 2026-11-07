/**
 * The `native-sessions` domain client over a `lib/backend` factory's client
 * (plan item 7001, report §11.2 "Client adapters"). `createWorkflowsApi`,
 * `createFilesSessionsApi`, `createAgentHandoffsApi` and the other factories
 * whose commands are in this domain call `nativeSessions(client)`.
 *
 * The adapter is picked from the node's negotiated `domains`, which the
 * command-scope and per-scope factory clients carry (`lib/backend/client.ts`):
 *
 * - a node that advertises `native-sessions` gets version 1: typed calls with
 *   the envelope (`invokeRaw(command, args, { envelope })`), results decoded
 *   with the command's schema, and both capability commands answered by the
 *   version without a round trip;
 * - any other node (a pre-contract one, or a client that carries no
 *   negotiation, such as the portal's) gets version 0, whose calls are
 *   exactly today's: `invokeRaw(command, args)`, or `invokeRaw(command)` for a
 *   call without arguments, answered as sent. Suites that mock `invoke` see
 *   the same calls as before.
 *
 * Calls through version 0 are counted (`domain-adapter-usage-ring.ts`) only
 * for a client that carries the node's `domains`: a client without
 * negotiation cannot tell the node's range, and counting it would keep the
 * adapter alive for ever.
 */
import {
  createDomainClient,
  type ContractEnvelopeFields,
  type DomainClient,
} from "@orkestrator/protocol/contract/client";
import {
  nativeSessionsClient,
  type NativeSessionsApi,
} from "@orkestrator/protocol/contract/domains/native-sessions";
import type { BackendClient } from "@/lib/backend/client";
import { recordDomainAdapterUsage } from "@/lib/domain-adapter-usage-ring";

export type { NativeSessionsApi } from "@orkestrator/protocol/contract/domains/native-sessions";

const clients = new WeakMap<BackendClient, DomainClient<NativeSessionsApi>>();

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

/** The domain client bound to `client`'s node, made once per client. */
export function nativeSessionsDomainClient(client: BackendClient): DomainClient<NativeSessionsApi> {
  let bound = clients.get(client);
  if (bound) return bound;
  bound = createDomainClient(nativeSessionsClient, {
    call: (command, args, envelope) => invokeWire(client, command.name, args, envelope),
    domains: () => client.domains?.get() ?? null,
    capabilities: () => client.capabilities?.get() ?? null,
    invoke: (command, args) => invokeWire(client, command, args, undefined),
    ...(client.domains ? { usage: recordDomainAdapterUsage } : {}),
  });
  clients.set(client, bound);
  return bound;
}

/**
 * The `native-sessions` API on `client`'s node, for the current connection
 * generation. Call it per use: a reconnect to another build picks again.
 */
export function nativeSessions(client: BackendClient): NativeSessionsApi {
  return nativeSessionsDomainClient(client).api();
}

/**
 * A decoded result as the web's own model type. The protocol schemas
 * describe the fields every reader routes on and keep the rest
 * (`openStruct`); the web's types are richer (transcript row generics,
 * literal unions) until plan item 7010 converges them.
 */
export function asWebModel<T>(result: Promise<unknown>): Promise<T> {
  return result as Promise<T>;
}
