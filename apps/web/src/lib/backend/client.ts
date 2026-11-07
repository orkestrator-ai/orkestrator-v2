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
import { portalStore } from "@/lib/portal/portal-store";
import { portalInvoke } from "@/lib/portal/portal-transport";

/**
 * What a factory needs of a node: its untyped command call. A `NodeClient` is
 * one. A client may also carry the node's negotiated `domains` and hello
 * `capabilities` (plan item 2011), which a domain client over it
 * (`./domain-client.ts`) picks its adapter from; the command-scope and
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
 * The command node over the portal channel (`portalInvoke`), which reaches it
 * even while the window's workspace is on a leaf. The shim client of
 * `command-nodes.ts`.
 */
export const portalBackendClient: BackendClient = {
  invokeRaw: <T>(...call: [string, Readonly<Record<string, unknown>>?]) =>
    portalInvoke<T>(...(call as [command: string, args?: Record<string, unknown>])),
};

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
 * Which machine a call is for. `null` selects the command node; `undefined`
 * selects the factory's client (for the shim, this view's backend: the leaf,
 * inside a leaf's workspace); a node id asks that node through the command
 * node.
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
    if (machine === null) return portalInvoke<T>(command, args);
    return machine === undefined
      ? client.invokeRaw<T>(command, args)
      : portalStore.invokeOnNode<T>(machine as BackendId, command, args);
  };
}
