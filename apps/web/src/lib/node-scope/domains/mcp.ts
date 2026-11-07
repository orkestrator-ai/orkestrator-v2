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
 * (`withArgumentsObject`). See `./domain-api.ts`.
 */
import { mcpClient, type McpApi } from "@orkestrator/protocol/contract/domains/mcp";
import type { AccountMachine, BackendClient } from "@/lib/backend/client";
import { machineBackendClient, withArgumentsObject } from "@/lib/backend/client";
import { domainApi } from "./domain-api";

export type { McpApi } from "@orkestrator/protocol/contract/domains/mcp";

/** The `mcp` API on `machine`, through `client`. The own-node client is made once. */
export function mcpOn(client: BackendClient): (machine?: AccountMachine) => McpApi {
  const own = () => domainApi(withArgumentsObject(client), mcpClient);
  return (machine) =>
    machine === undefined ? own() : domainApi(machineBackendClient(client, machine), mcpClient);
}
