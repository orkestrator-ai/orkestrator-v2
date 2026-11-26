/**
 * The `agent-mail` domain client (plan item 7008; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 2 sends the envelope (`requestId` on the sends, `now` on Deliver
 *   now and `strictProjectScope` on the directory are critical) and decodes
 *   the result with the command's schema: the protocol's mail records, every
 *   undeclared field kept.
 *
 * Only the current version has an adapter: the older ones went with the
 * one-time support floor v2.39.1-beta (to-do 8304 (retired), 2026-11-26), so a node
 * that advertises no range for the domain is refused with
 * `unsupported-version`. Later bumps keep an adapter for every version a
 * release in the 60-day window speaks.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall } from "../../client.js";
import { commandApi, type CommandApi } from "../command-api.js";
import { AGENT_MAIL_COMMANDS } from "./commands.js";
import { agentMailDomain } from "./domain.js";

export type AgentMailApi = CommandApi<typeof AGENT_MAIL_COMMANDS>;

const agentMailApi = (call: CommandCall): AgentMailApi => commandApi(call, AGENT_MAIL_COMMANDS);

export const agentMailClient = domainClient(agentMailDomain, {
  2: agentMailApi,
});
