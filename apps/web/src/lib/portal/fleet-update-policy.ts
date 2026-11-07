import {
  parseFleetUpdatePolicy,
  type FleetUpdatePolicy,
} from "@orkestrator/protocol/fleet-currency";
import type { HostUpdateChannel } from "@orkestrator/protocol/host-maintenance";
import { portalInvoke } from "./portal-transport";

/**
 * The command node's opt-in "keep leaves on this node's version" policy
 * (plan item 5006). It belongs to the command node, so it goes over the
 * portal channel whichever machine the window works on.
 */
export async function getFleetUpdatePolicy(): Promise<FleetUpdatePolicy> {
  return parseFleetUpdatePolicy(await portalInvoke<unknown>("get_fleet_update_policy", {}));
}

export async function setFleetUpdatePolicyChannel(
  channel: HostUpdateChannel,
  enabled: boolean,
): Promise<FleetUpdatePolicy> {
  return parseFleetUpdatePolicy(
    await portalInvoke<unknown>("set_fleet_update_policy", { channel, enabled }),
  );
}
