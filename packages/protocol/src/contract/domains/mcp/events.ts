/** `mcp` events. Browser-safe. */
import * as Schema from "effect/Schema";
import { MCP_MANAGEMENT_CHANGED_EVENT } from "../../../mcp-management.js";
import { defineEvent } from "../../event.js";
import { mcpDomain } from "./domain.js";

/** MCP targets or operations changed (`McpManagementChangedEvent`). */
export const mcpManagementChangedEvent = defineEvent({
  domain: mcpDomain,
  name: MCP_MANAGEMENT_CHANGED_EVENT,
  payload: Schema.Struct({
    revision: Schema.Finite,
    targetIds: Schema.Array(Schema.String),
    operationIds: Schema.Array(Schema.String),
  }),
});

export const MCP_EVENTS = [mcpManagementChangedEvent] as const;
