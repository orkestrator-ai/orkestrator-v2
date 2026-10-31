/**
 * The fixed per-user ports. Only the default data directory's backend may hold
 * them (`isDefaultDataDir`): remote machines reach it on the gateway port and
 * external MCP clients on the Control MCP port.
 *
 * Its own module, free of the gateway and the Control MCP, so each of them and
 * the standalone CLI can name both ports without importing the other.
 */
export const DEFAULT_GATEWAY_PORT = 34121;
export const DEFAULT_CONTROL_MCP_PORT = 34_122;
