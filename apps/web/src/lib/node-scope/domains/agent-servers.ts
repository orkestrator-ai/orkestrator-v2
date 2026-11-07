/**
 * The `agent-servers` domain on a `lib/backend` factory's client (plan item 7009):
 * `agentServersApi(client).<command>(args)`. See `./domain-api.ts` for the adapter
 * choice (version 1 with the envelope for a node that advertises the domain,
 * today's untyped call otherwise).
 */
import {
  agentServersClient,
  type AgentServersApi,
} from "@orkestrator/protocol/contract/domains/agent-servers";
import type { BackendClient } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { AgentServersApi } from "@orkestrator/protocol/contract/domains/agent-servers";

export function agentServersApi(client: BackendClient): AgentServersApi {
  return domainApi(client, agentServersClient);
}
