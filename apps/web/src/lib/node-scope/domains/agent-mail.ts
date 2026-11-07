/**
 * The `agent-mail` domain on a `lib/backend` factory's client (plan item
 * 7008): `agentMail(client)().send_agent_mail({ … })`.
 *
 * The client's own node picks the adapter from its negotiated `domains`
 * (version 1 sends the envelope and decodes results with the protocol's mail
 * schemas); a pre-contract node, or a client without negotiation, uses
 * version 0, today's call (`invokeRaw(command, args)`, or `invokeRaw(command)`
 * for a call without arguments). See `./domain-api.ts` for the
 * adapter choice.
 *
 * `commandNodeAgentMail` is the same domain over `invokeCommandNodeSetting`
 * (the messaging settings are the command node's, which its leaves inherit),
 * also version 0.
 */
import {
  agentMailClient,
  type AgentMailApi,
} from "@orkestrator/protocol/contract/domains/agent-mail";
import type { BackendClient } from "@/lib/backend/client";
import { commandNodeSettingClient } from "./accounts";
import { domainApi } from "./domain-api";

export type { AgentMailApi } from "@orkestrator/protocol/contract/domains/agent-mail";

/** The `agent-mail` API on `client`'s node; the getter picks per connection generation. */
export function agentMail(client: BackendClient): () => AgentMailApi {
  return () => domainApi(client, agentMailClient);
}

/** The `agent-mail` API on the command node's settings target (version 0, today's calls). */
export const commandNodeAgentMail: () => AgentMailApi = () =>
  domainApi(commandNodeSettingClient, agentMailClient);
