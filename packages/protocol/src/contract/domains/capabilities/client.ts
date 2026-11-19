/**
 * The `capabilities` domain client: one function per command
 * (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope and decodes results with the commands'
 *   schemas (open records: every undeclared field is kept).
 * - Version 0 (a node that advertises no `capabilities` range, which
 *   predates the feature) is the untyped call; such a node answers
 *   `unknown-command`, which the Capabilities page shows as "this machine's
 *   Orkestrator is too old to manage capabilities".
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `capabilities` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { CAPABILITIES_COMMANDS } from "./commands.js";
import { capabilitiesDomain } from "./domain.js";

export type CapabilitiesApi = CommandApi<typeof CAPABILITIES_COMMANDS>;

const capabilitiesApi = (call: CommandCall): CapabilitiesApi =>
  commandApi(call, CAPABILITIES_COMMANDS);
const legacyCapabilitiesApi = (
  _call: CommandCall,
  context: DomainAdapterContext,
): CapabilitiesApi => legacyCommandApi(context, CAPABILITIES_COMMANDS);

export const capabilitiesClient = domainClient(capabilitiesDomain, {
  1: capabilitiesApi,
  0: legacyCapabilitiesApi,
});
