/**
 * The `agent-servers` domain client (plan item 7009; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope and decodes results with the commands'
 *   schemas.
 * - Version 0 (a node that advertises no `agent-servers` range: a pre-contract
 *   node, or a client without negotiation) is today's untyped call,
 *   `{ command, args }`, answered as sent (`legacyCommandApi`).
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `agent-servers` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { AGENT_SERVERS_COMMANDS } from "./commands.js";
import { agentServersDomain } from "./domain.js";

export type AgentServersApi = CommandApi<typeof AGENT_SERVERS_COMMANDS>;

const agentServersApi = (call: CommandCall): AgentServersApi =>
  commandApi(call, AGENT_SERVERS_COMMANDS);
const legacyAgentServersApi = (
  _call: CommandCall,
  context: DomainAdapterContext,
): AgentServersApi => legacyCommandApi(context, AGENT_SERVERS_COMMANDS);

export const agentServersClient = domainClient(agentServersDomain, {
  2: agentServersApi,
  // Version 2 only removed commands nothing called (2026-11-10), so version 1
  // peers take the same API. Adapter 1 goes when the support floor passes the
  // first Stable release with version 2.
  1: agentServersApi,
  0: legacyAgentServersApi,
});
