import {
  parseFleetUpdatePolicy,
  type FleetUpdatePolicy,
} from "@orkestrator/protocol/fleet-currency";
import type { HostUpdateChannel } from "@orkestrator/protocol/host-maintenance";
import { systemApi } from "@/lib/node-scope/domains/system";
import { commandScopeBackendClient } from "./command-scope";

/**
 * The command node's opt-in "keep leaves on this node's version" policy
 * (plan item 5006). It belongs to the command node, so it goes over the
 * window's command scope whichever machine the window shows.
 */
export async function getFleetUpdatePolicy(): Promise<FleetUpdatePolicy> {
  return parseFleetUpdatePolicy(
    await systemApi(commandScopeBackendClient).get_fleet_update_policy({}),
  );
}

export async function setFleetUpdatePolicyChannel(
  channel: HostUpdateChannel,
  enabled: boolean,
): Promise<FleetUpdatePolicy> {
  return parseFleetUpdatePolicy(
    await systemApi(commandScopeBackendClient).set_fleet_update_policy({ channel, enabled }),
  );
}
