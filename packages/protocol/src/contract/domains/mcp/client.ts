/**
 * The `mcp` domain client (plan item 7008; §11.2 "Client adapters"): one
 * function per command (`commandApi`), keyed by command name.
 *
 * - Version 1 sends the envelope (no `mcp` key is critical) and decodes the
 *   result with the command's schema: the protocol's `McpTargetList`,
 *   `McpManagementSnapshot` (with its `protocolVersion`), operations and
 *   overlays, every undeclared field kept.
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
import { MCP_COMMANDS } from "./commands.js";
import { mcpDomain } from "./domain.js";

export type McpApi = CommandApi<typeof MCP_COMMANDS>;

const mcpApi = (call: CommandCall): McpApi => commandApi(call, MCP_COMMANDS);

export const mcpClient = domainClient(mcpDomain, {
  1: mcpApi,
});
