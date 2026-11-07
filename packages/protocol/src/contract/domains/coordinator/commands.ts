/**
 * `coordinator` commands (plan item 7009): project coordinators and the controller: conversations, worker surfaces, delegation, Control MCP credentials and launches.
 * The definitions are split by registering area; this list is the domain's.
 *
 * Browser-safe.
 */
import { COORDINATOR_PROJECT_COMMANDS } from "./commands-project.js";
import { COORDINATOR_CONTROLLER_COMMANDS } from "./commands-controller.js";

export * from "./commands-project.js";
export * from "./commands-controller.js";

/** Every defined `coordinator` command. */
export const COORDINATOR_COMMANDS = [
  ...COORDINATOR_PROJECT_COMMANDS,
  ...COORDINATOR_CONTROLLER_COMMANDS,
] as const;
