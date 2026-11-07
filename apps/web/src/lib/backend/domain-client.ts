/**
 * A domain client (`@orkestrator/protocol/contract/client`) over a
 * `lib/backend` factory's client (plan item 7003, report §11.2 "Client
 * adapters").
 *
 * `createXApi(client)` builds its domain functions on `backendDomainApi(client,
 * def)`: the adapter is picked from the node's negotiated `domains`, and the
 * result is decoded with the command's schema, so the functions return the
 * protocol's typed results instead of `invoke<T>` casts.
 *
 * - A client that carries the node's `domains` and `capabilities` signals
 *   (the command-scope and per-scope factory clients, `./client.ts`) gets the
 *   adapter for the node's range; above version 0 its calls carry the
 *   envelope (`invokeRaw(command, args, { envelope })`).
 * - A node without a range for the domain (pre-contract, or not advertising
 *   it), and a client without negotiation (a routed or portal call), use the
 *   legacy version-0 adapter, whose calls are exactly today's:
 *   `invokeRaw(command, args)`, or `invokeRaw(command)` for a command sent
 *   without arguments, so suites that mock `invoke` see the same calls as
 *   before. Version-0 calls are counted as adapter usage only for a client
 *   that carries `domains`: one without cannot tell the node's range.
 *
 * `machineBackendClient`, `routedBackendClient` and `withArgumentsObject`
 * aim a factory client at another node or keep the `machineInvoke` call
 * shape.
 *
 * Not part of the `@/lib/backend` barrel.
 */
import {
  createDomainClient,
  type ContractEnvelopeFields,
  type DomainClientDef,
} from "@orkestrator/protocol/contract/client";
import type { AnyDomainDef } from "@orkestrator/protocol/contract/domain";
import type { NegotiatedDomains, ReadableSignal } from "@orkestrator/protocol/node-client";
import type { BackendId } from "@orkestrator/protocol/federation";
import { recordDomainAdapterUsage } from "@/lib/domain-adapter-usage-ring";
import type { PortalStore } from "@/lib/portal/portal-store";
import { machineInvoker, type AccountMachine, type BackendClient } from "./client";

type NegotiatingClient = BackendClient & {
  readonly domains?: ReadableSignal<NegotiatedDomains | null>;
  readonly capabilities?: ReadableSignal<ReadonlySet<string> | null>;
};

function signalValue<T>(signal: ReadableSignal<T> | undefined): T | null {
  return signal && typeof signal.get === "function" ? signal.get() : null;
}

function isEmptyArgs(args: unknown): boolean {
  return (
    args === undefined ||
    (typeof args === "object" && args !== null && Object.keys(args).length === 0)
  );
}

/**
 * The wire call: no envelope (the legacy adapter) sends today's body, without
 * an arguments object when there are none.
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

/**
 * `def`'s API on `client`'s node. The returned getter picks the adapter on
 * each call (cheap: an identity check per connection generation) so a client
 * whose node reconnects to a newer build picks again.
 */
export function backendDomainApi<Api>(
  client: BackendClient,
  def: DomainClientDef<AnyDomainDef, Api>,
): () => Api {
  const negotiating = client as NegotiatingClient;
  const domainClient = createDomainClient(def, {
    call: (command, args, envelope) => invokeWire(client, command.name, args, envelope),
    domains: () => signalValue(negotiating.domains),
    capabilities: () => signalValue(negotiating.capabilities),
    invoke: (command, args) => invokeWire(client, command, args, undefined),
    // Counted only where the node's range is known: a shim client without
    // negotiation uses version 0 because it cannot tell, not because the
    // node is older, and counting it would keep the adapter alive forever.
    ...(negotiating.domains ? { usage: recordDomainAdapterUsage } : {}),
  });
  return () => domainClient.api();
}

/**
 * `client` aimed at `machine` (`AccountMachine`): `undefined` is `client`'s
 * own node, `null` the command node over the portal, a node id that node
 * through the command node. Its calls carry no negotiated range, so a domain
 * client over it uses the legacy adapter.
 */
export function machineBackendClient(
  client: BackendClient,
  machine: AccountMachine,
): BackendClient {
  if (machine === undefined) return client;
  const invoke = machineInvoker(client);
  return {
    invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
      invoke<T>(machine, command, args as Record<string, unknown> | undefined),
  };
}

/**
 * `backendId`'s node through the command node (`PortalStore.invokeOnNode`):
 * a routed call, which carries no negotiated range, so a domain client over
 * it uses the legacy adapter (today's command and arguments).
 */
export function routedBackendClient(
  portal: Pick<PortalStore, "invokeOnNode">,
  backendId: BackendId,
): BackendClient {
  return {
    invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
      portal.invokeOnNode<T>(backendId, command, args as Record<string, unknown> | undefined),
  };
}

/**
 * `client`, sending `{}` where a call has no arguments: the shape
 * `machineInvoke` always sent, which the machine-aware functions keep for
 * their own node. The negotiation signals are the client's own.
 */
export function withArgumentsObject(client: BackendClient): BackendClient {
  return {
    invokeRaw: <T>(
      command: string,
      args?: Readonly<Record<string, unknown>>,
      options?: Parameters<BackendClient["invokeRaw"]>[2],
    ) =>
      options === undefined
        ? client.invokeRaw<T>(command, args ?? {})
        : client.invokeRaw<T>(command, args ?? {}, options),
    get domains() {
      return client.domains;
    },
    get capabilities() {
      return client.capabilities;
    },
  };
}
