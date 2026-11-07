/**
 * The `accounts` domain on a `lib/backend` factory's client (plan item 7008):
 * `accountsOn(client)(machine).list_agent_accounts({})`.
 *
 * Every account, sign-in and usage function names the machine it asks
 * (`AccountMachine`): `undefined` is the client's own node, which picks the
 * adapter from its negotiated `domains` (version 1 sends the envelope and
 * decodes results); `null` (the command node over the portal) and a node id
 * (routed through the command node) carry no negotiated range, so they use
 * version 0, today's call. Calls on the client's own node keep the
 * arguments object `machineInvoke` always sent (`withArgumentsObject`).
 *
 * `commandNodeSettingClient` is the same domain over
 * `invokeCommandNodeSetting` (the overview, the preferred login and the
 * command node's automatic-switching ticks), also version 0.
 *
 * See `./domain-api.ts` for the adapter choice.
 */
import { accountsClient, type AccountsApi } from "@orkestrator/protocol/contract/domains/accounts";
import type { AccountMachine, BackendClient } from "@/lib/backend/client";
import { invokeCommandNodeSetting } from "@/lib/portal/command-node-config";
import { machineBackendClient, withArgumentsObject } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { AccountsApi } from "@orkestrator/protocol/contract/domains/accounts";

/** The `accounts` API on `machine`, through `client`. The own-node client is made once. */
export function accountsOn(client: BackendClient): (machine?: AccountMachine) => AccountsApi {
  const own = () => domainApi(withArgumentsObject(client), accountsClient);
  return (machine) =>
    machine === undefined
      ? own()
      : domainApi(machineBackendClient(client, machine), accountsClient);
}

/** The command node's settings target (`invokeCommandNodeSetting`) as a factory client. */
export const commandNodeSettingClient: BackendClient = {
  invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
    args === undefined
      ? invokeCommandNodeSetting<T>(command)
      : invokeCommandNodeSetting<T>(command, args as Record<string, unknown>),
};

/** The `accounts` API on the command node's settings target (version 0, today's calls). */
export const commandNodeAccounts: () => AccountsApi = () =>
  domainApi(commandNodeSettingClient, accountsClient);
