/**
 * `system` commands (plan item 7009): host, diagnostics, scheduled jobs, bug reports, resource manifests and host maintenance.
 *
 * Browser-safe.
 */
import { recordDomainAdapterUsageCommand } from "../../client-usage.js";
import { getFleetUpdatePolicyCommand, setFleetUpdatePolicyCommand } from "./fleet-update-policy.js";

export { recordDomainAdapterUsageCommand } from "../../client-usage.js";
export * from "./fleet-update-policy.js";

/** Every defined `system` command. */
export const SYSTEM_COMMANDS = [
  recordDomainAdapterUsageCommand,
  getFleetUpdatePolicyCommand,
  setFleetUpdatePolicyCommand,
] as const;
