/**
 * The `agent-mail` domain client (plan item 7008; §11.2 "Client adapters"):
 * one function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (`requestId` on the sends, `now` on Deliver
 *   now and `strictProjectScope` on the directory are critical) and decodes
 *   the result with the command's schema: the protocol's mail records, every
 *   undeclared field kept.
 * - Version 0 (a pre-contract node) is today's untyped call, answered as sent
 *   (`legacyCommandApi`). No agent-mail command was ever capability-gated:
 *   a node that lacks a newer one (conversations, the inbox snapshot)
 *   answers `unknown-command`, which callers read with `incompatibility()`.
 *
 * Retirement: adapter 0 goes when the support floor passes the first Stable
 * release that advertises the `agent-mail` domain.
 *
 * Browser-safe.
 */
import { domainClient, type CommandCall, type DomainAdapterContext } from "../../client.js";
import { commandApi, legacyCommandApi, type CommandApi } from "../command-api.js";
import { AGENT_MAIL_COMMANDS } from "./commands.js";
import { agentMailDomain } from "./domain.js";

export type AgentMailApi = CommandApi<typeof AGENT_MAIL_COMMANDS>;

const agentMailApi = (call: CommandCall): AgentMailApi => commandApi(call, AGENT_MAIL_COMMANDS);
const legacyAgentMailApi = (_call: CommandCall, context: DomainAdapterContext): AgentMailApi =>
  legacyCommandApi(context, AGENT_MAIL_COMMANDS);

export const agentMailClient = domainClient(agentMailDomain, {
  2: agentMailApi,
  // Version 2 only removed commands nothing called (2026-11-10), so version 1
  // peers take the same API. Adapter 1 goes when the support floor passes the
  // first Stable release with version 2.
  1: agentMailApi,
  0: legacyAgentMailApi,
});
