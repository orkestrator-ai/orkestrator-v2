/**
 * The command node's opt-in update policy (plan item 5006, report §11.6):
 * per update channel, whether the leaves on it are kept on the command
 * node's version. In `system` with the host-maintenance commands it drives.
 * Both are the command node's own: never routed to a node, never reachable
 * by a workspace grant (`node-routing.ts`).
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { FleetUpdatePolicyWireSchema } from "../../../fleet-currency.js";
import { HOST_UPDATE_CHANNELS } from "../../../host-maintenance.js";
import { defineCommand } from "../../command.js";
import { systemDomain } from "./domain.js";

export const getFleetUpdatePolicyCommand = defineCommand({
  domain: systemDomain,
  name: "get_fleet_update_policy",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({}),
  result: FleetUpdatePolicyWireSchema,
  critical: [],
});

/** Turns the policy on or off for one channel; answers the whole policy. */
export const setFleetUpdatePolicyCommand = defineCommand({
  domain: systemDomain,
  name: "set_fleet_update_policy",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    channel: Schema.Literals(HOST_UPDATE_CHANNELS),
    enabled: Schema.Boolean,
  }),
  result: FleetUpdatePolicyWireSchema,
  critical: [],
});
