/**
 * The client a `lib/backend` factory sends its commands through (plan item
 * 3002, report §7.4).
 *
 * Every `lib/backend/<x>.ts` exports `createXApi(client)`, which returns that
 * file's command functions bound to `client`'s node, and keeps its named
 * exports as `createXApi(commandBackendClient)`: the command-scope shim. A
 * scoped store or service passes its own node's client
 * (`createXApi(scope.client)`, or `scopeBackendClient(scope)` to keep the
 * scope's prefetched cache); code that has not said which node it means keeps
 * using the named exports, and the `lib-backend-command-default` source guard
 * counts those uses inside converted stores and services.
 *
 * Not part of the `@/lib/backend` barrel: import it from
 * `@/lib/backend/client`.
 */

import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeClient, NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import { invoke } from "@/lib/native/backend";
import { appCommandScope, isAppCommandScope } from "@/lib/node-scope-slots";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { invokeInScope } from "@/lib/node-scope/scope-transport";
import { commandScopeBackendClient, commandScopeInvoke } from "@/lib/portal/command-scope";
import { invokeOnMachine } from "@/lib/portal/machine-scope";

/**
 * What a factory needs of a node: its untyped command call. A `NodeClient` is
 * one. A client may also carry the node's negotiated `domains` and hello
 * `capabilities` (plan item 2011), which a domain client over it
 * (`@/lib/node-scope/domains/domain-api`) picks its adapter from; the command-scope and
 * per-scope clients below carry their scope client's.
 */
export type BackendClient = Pick<NodeClient, "invokeRaw"> &
  Partial<Pick<NodeClient, "domains" | "capabilities">>;

/** The `invoke` shape the factory bodies call. */
export type BackendInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

type InvokeCall = [command: string, args?: Record<string, unknown>, options?: NodeInvokeOptions];

/**
 * The window's command scope: `@/lib/native/backend` `invoke`, read at call
 * time, so its prefetched cache applies and suites that mock that module see
 * every call. The arguments are passed on exactly as given (a call without
 * args stays a one-argument call).
 */
export const commandBackendClient: BackendClient = {
  invokeRaw: <T>(...call: [string, Readonly<Record<string, unknown>>?, NodeInvokeOptions?]) =>
    invoke<T>(...(call as InvokeCall)),
  get domains() {
    return appCommandScope().client.domains;
  },
  get capabilities() {
    return appCommandScope().client.capabilities;
  },
};

/**
 * The window's command node for the portal APIs (`commandScopeBackendClient`,
 * plan item 5004): the command scope.
 * The shim client of `command-nodes.ts`.
 */
export const portalBackendClient: BackendClient = commandScopeBackendClient;

/** `client`'s command call in the `invoke` shape. */
export function clientInvoke(client: BackendClient): BackendInvoke {
  return <T>(...call: InvokeCall) => client.invokeRaw<T>(...call);
}

/**
 * `scope`'s node as a factory client. The app's command scope is
 * `commandBackendClient` (what suites mock); any other scope goes through
 * `invokeInScope`, so its prefetched cache applies.
 */
export function scopeBackendClient(scope: NodeScope): BackendClient {
  if (isAppCommandScope(scope)) return commandBackendClient;
  return {
    invokeRaw: <T>(
      command: string,
      args?: Readonly<Record<string, unknown>>,
      options?: NodeInvokeOptions,
    ) =>
      options
        ? invokeInScope<T>(scope, command, args as Record<string, unknown> | undefined, options)
        : invokeInScope<T>(scope, command, args as Record<string, unknown> | undefined),
    get domains() {
      return scope.client.domains;
    },
    get capabilities() {
      return scope.client.capabilities;
    },
  };
}

const scopeApis = new WeakMap<NodeScope, Map<unknown, unknown>>();

/**
 * One factory's functions for `scope`'s node: `command` (the file's named
 * exports, which suites mock) on the app's command scope, otherwise
 * `create(scopeBackendClient(scope))`, made once per scope.
 */
export function backendApiForScope<A extends object, K extends keyof A>(
  scope: NodeScope,
  create: (client: BackendClient) => A,
  command: Pick<A, K>,
): Pick<A, K> {
  if (isAppCommandScope(scope)) return command;
  let apis = scopeApis.get(scope);
  if (!apis) {
    apis = new Map();
    scopeApis.set(scope, apis);
  }
  let api = apis.get(create) as A | undefined;
  if (!api) {
    api = create(scopeBackendClient(scope));
    apis.set(create, api);
  }
  return api;
}

/**
 * Which machine a call is for. `null` selects the command node (the window's
 * command scope); `undefined` selects the factory's client (for the shim,
 * this view's backend: the leaf, inside a leaf's workspace); a node id asks
 * that node: on its own scope when the window holds it warm or live, else
 * through the command scope (`invokeOnMachine`, plan item 5004).
 */
export type AccountMachine = string | null | undefined;

export type MachineInvoke = <T>(
  machine: AccountMachine,
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

/** `machineInvoke` over `client`: `undefined` is `client`'s node. */
export function machineInvoker(client: BackendClient): MachineInvoke {
  return <T>(machine: AccountMachine, command: string, args: Record<string, unknown> = {}) => {
    if (machine === null) return commandScopeInvoke<T>(command, args);
    return machine === undefined
      ? client.invokeRaw<T>(command, args)
      : invokeOnMachine<T>(machine as BackendId, command, args);
  };
}

/**
 * `client` aimed at `machine` (`AccountMachine`): `undefined` is `client`'s
 * own node, `null` the window's command scope, a node id that node (its
 * scope, or through the command scope; see `machineInvoker`). Its calls carry no negotiated range, so a domain
 * client over it (`@/lib/node-scope/domains/domain-api`) uses the legacy
 * adapter.
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

const withArguments = new WeakMap<BackendClient, BackendClient>();

/**
 * `client`, sending `{}` where a call has no arguments: the shape
 * `machineInvoke` always sent, which the machine-aware functions keep for
 * their own node. The negotiation signals are the client's own. Made once per
 * client, so a domain client over it is too.
 */
export function withArgumentsObject(client: BackendClient): BackendClient {
  const existing = withArguments.get(client);
  if (existing) return existing;
  const wrapped: BackendClient = {
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
  withArguments.set(client, wrapped);
  return wrapped;
}
