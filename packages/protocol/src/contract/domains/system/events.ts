/**
 * `system` events: committed resource changes, the machine profile, host
 * maintenance and the Control MCP server's state.
 *
 * Payload schemas pin the fields receivers route on; model-shaped parts stay
 * `ObjectKeyword` until their models converge on protocol schemas (7010).
 * Receivers decode tolerantly (unknown keys ignored). Browser-safe.
 */
import * as Schema from "effect/Schema";
import { BACKEND_PROFILE_CHANGED_EVENT } from "../../../backend-profile.js";
import { HOST_MAINTENANCE_EVENT } from "../../../host-maintenance.js";
import { RESOURCE_CHANGED_EVENT } from "../../../resource-events.js";
import { defineEvent } from "../../event.js";
import { systemDomain } from "./domain.js";

/**
 * Every committed storage mutation (`ResourceChange`). `resource` stays a
 * string: a newer backend may announce a kind this client does not know
 * (`isResourceKind` narrows it), and `cause` is open-ended.
 */
export const resourceChangedEvent = defineEvent({
  domain: systemDomain,
  name: RESOURCE_CHANGED_EVENT,
  payload: Schema.Struct({
    resource: Schema.String,
    id: Schema.String,
    projectId: Schema.optional(Schema.String),
    agent: Schema.optional(Schema.String),
    logicalSessionKey: Schema.optional(Schema.String),
    deleted: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.String),
    revision: Schema.Finite,
  }),
});

/** The backend's machine profile after an accepted edit (`BackendProfile`). */
export const backendProfileChangedEvent = defineEvent({
  domain: systemDomain,
  name: BACKEND_PROFILE_CHANGED_EVENT,
  payload: Schema.Struct({
    revision: Schema.Finite,
    displayName: Schema.String,
    colorToken: Schema.String,
    updatedAt: Schema.String,
  }),
});

/** The host maintenance snapshot (`HostMaintenanceSnapshot`). */
export const hostMaintenanceUpdatedEvent = defineEvent({
  domain: systemDomain,
  name: HOST_MAINTENANCE_EVENT,
  payload: Schema.Struct({
    revision: Schema.Finite,
    version: Schema.String,
  }),
});

/** The Control MCP server bound or rebound; clients re-read its state. Empty payload. */
export const controlMcpStateChangedEvent = defineEvent({
  domain: systemDomain,
  name: "control-mcp-state-changed",
  payload: Schema.Struct({}),
});

export const SYSTEM_EVENTS = [
  resourceChangedEvent,
  backendProfileChangedEvent,
  hostMaintenanceUpdatedEvent,
  controlMcpStateChangedEvent,
] as const;
