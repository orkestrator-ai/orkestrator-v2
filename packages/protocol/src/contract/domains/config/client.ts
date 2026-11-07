/**
 * The `config` domain client (plan item 7005; §11.2 "Client adapters",
 * §11.4): one function per command, keyed by the command's name
 * (`api.get_config(args)`), plus the domain's capability read. The web binds
 * it per `lib/backend` client (`apps/web/src/lib/node-scope/domains/config.ts`),
 * and the config layering (`lib/portal/command-node-config.ts`) sends its
 * reads and split saves through it on both nodes.
 *
 * - **Version 1** (a node whose hello advertises `config`): calls carry the
 *   envelope and results are decoded with the command's schema. The settings
 *   records are open (`config/models.ts`), so a decode keeps every setting a
 *   newer node sends and a whole-object save never deletes one.
 *   `get_client_state_capabilities` is folded into the version: every build
 *   that advertises the domain owns the shared client state this build knows
 *   ({@link CONFIG_CLIENT_STATE_CAPABILITIES}), so `clientStateCapabilities()`
 *   answers without a round trip.
 * - **Version 0** (a pre-contract node): today's untyped call by name, without
 *   an envelope, answered as sent; `clientStateCapabilities()` asks the
 *   command and reads the answer with `parseClientStateCapabilities` on every
 *   call, as before (anything unreadable is "every capability off"; a node
 *   that predates the command answers `unknown-command`, thrown to the caller
 *   as before).
 *
 * The config-echo compatibility path (`isGlobalConfigEcho`, counter
 * `workspace-grant.config-echo`) is the receiving node's and is unchanged: an
 * older realm's unchanged settings write is still answered with the current
 * settings.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `config` domain; `get_client_state_capabilities`
 * stays registered for pre-contract clients until its register row retires.
 *
 * Browser-safe.
 */
import {
  CLIENT_STATE_CAPABILITIES_COMMAND,
  parseClientStateCapabilities,
} from "../../../client-state.js";
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import type { ArgsOf, ResultOf } from "../../command.js";
import { CONFIG_COMMANDS } from "./commands.js";
import { configDomain } from "./domain.js";
import type { ClientStateCapabilities } from "./models.js";

/** Every `config` command definition. */
export type ConfigCommand = (typeof CONFIG_COMMANDS)[number];

/** One function per command, keyed by the command's name. */
export type ConfigCommandApi = {
  readonly [C in ConfigCommand as C["name"]]: (args: ArgsOf<C>) => Promise<ResultOf<C>>;
};

/**
 * The shared client state `config` version 1 includes, and what
 * `get_client_state_capabilities` answers on this build. The "always merge"
 * setting is retired: every mergeable checkout is merged.
 */
export const CONFIG_CLIENT_STATE_CAPABILITIES: Readonly<ClientStateCapabilities> = Object.freeze({
  coordinatorPaneLayouts: true,
  coordinatorUpstreamMerge: true,
  coordinatorUpstreamAutoMerge: false,
  noticeDismissals: true,
  environmentAttention: true,
});

export interface ConfigApi extends ConfigCommandApi {
  /** Which shared client state the node owns. */
  clientStateCapabilities(): Promise<ClientStateCapabilities>;
}

function commandApi(
  run: (command: ConfigCommand, args: unknown) => Promise<unknown>,
): ConfigCommandApi {
  const api: Record<string, (args: unknown) => Promise<unknown>> = {};
  for (const command of CONFIG_COMMANDS) api[command.name] = (args) => run(command, args);
  return api as ConfigCommandApi;
}

function currentApi(call: CommandCall): ConfigApi {
  return Object.freeze({
    ...commandApi((command, args) => call(command, args as ArgsOf<typeof command>)),
    clientStateCapabilities: async () => ({ ...CONFIG_CLIENT_STATE_CAPABILITIES }),
  });
}

function legacyApi(_call: CommandCall, context: DomainAdapterContext): ConfigApi {
  return Object.freeze({
    ...commandApi((command, args) =>
      context.invoke(command.name, args as Readonly<Record<string, unknown>> | undefined),
    ),
    clientStateCapabilities: async () =>
      parseClientStateCapabilities(await context.invoke(CLIENT_STATE_CAPABILITIES_COMMAND)),
  });
}

export const configClient = domainClient(configDomain, { 1: currentApi, 0: legacyApi });
