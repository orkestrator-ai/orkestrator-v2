/**
 * The `mcp` domain on a `lib/backend` factory's client (plan item 7008):
 * `mcpOn(client)(machine).get_mcp_management_snapshot({ targetId })`.
 *
 * MCP management names the machine it manages (`AccountMachine`), as the
 * accounts functions do: `undefined` is the client's own node, which picks
 * the adapter from its negotiated `domains` (version 1 sends the envelope and
 * decodes results with the protocol's schemas); `null` (the command node over
 * the portal) and a node id (routed through the command node) carry no
 * negotiated range, so they use version 0, today's call. Calls on the
 * client's own node keep the arguments object `machineInvoke` always sent
 * (`withArgumentsObject`). See `lib/backend/domain-client.ts` (plan item 7003).
 */
import { mcpClient, type McpApi } from "@orkestrator/protocol/contract/domains/mcp";
import {
  backendDomainApi,
  machineBackendClient,
  withArgumentsObject,
} from "@/lib/backend/domain-client";
import type { AccountMachine, BackendClient } from "@/lib/backend/client";

export type { McpApi } from "@orkestrator/protocol/contract/domains/mcp";

/** The `mcp` API on `machine`, through `client`. The own-node client is made once. */
export function mcpOn(client: BackendClient): (machine?: AccountMachine) => McpApi {
  const own = backendDomainApi(withArgumentsObject(client), mcpClient);
  return (machine) =>
    machine === undefined
      ? own()
      : backendDomainApi(machineBackendClient(client, machine), mcpClient)();
}
