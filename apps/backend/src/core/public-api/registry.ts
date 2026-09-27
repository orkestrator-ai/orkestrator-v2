import type { PublicActionName, PublicCapabilities } from "@orkestrator/protocol/public-api";
import type { CommandRegistrar, RegistryDependencies } from "../commands-registry-types.js";
import { createCapabilitiesHandler, DISCOVERY_HANDLERS } from "./actions-discovery.js";
import { ENVIRONMENT_HANDLERS } from "./actions-environments.js";
import { EXEC_HANDLERS } from "./actions-exec.js";
import { LAUNCH_HANDLERS } from "./actions-launch.js";
import { PROJECT_HANDLERS } from "./actions-projects.js";
import { RUN_READ_HANDLERS, RUN_RECOVERY_HANDLERS } from "./actions-runs.js";
import { SESSION_CONTROL_HANDLERS } from "./actions-session-controls.js";
import { SESSION_HANDLERS } from "./actions-sessions.js";
import { SETTINGS_HANDLERS } from "./actions-settings.js";
import { TRANSCRIPT_HANDLERS } from "./actions-transcript.js";
import { registerPublicActionCommand } from "./dispatch.js";
// Side-effect import: registers the prompt-run reconcilers.
import "./run-observer.js";
import type { PublicActionHandler } from "./types.js";

/**
 * Every handler the backend offers through `public_action`. Capabilities are
 * derived from this table, so an action is advertised if and only if a
 * handler at the catalogue's version is registered here. To withdraw one
 * action, remove its handler: receipts, reconciliation and cancellation of
 * already-accepted operations keep working through `run.*`.
 */
export function publicActionHandlers(): PublicActionHandler[] {
  return [
    ...DISCOVERY_HANDLERS,
    ...PROJECT_HANDLERS,
    ...ENVIRONMENT_HANDLERS,
    ...SETTINGS_HANDLERS,
    ...LAUNCH_HANDLERS,
    ...SESSION_HANDLERS,
    ...SESSION_CONTROL_HANDLERS,
    ...TRANSCRIPT_HANDLERS,
    ...RUN_READ_HANDLERS,
    ...RUN_RECOVERY_HANDLERS,
    ...EXEC_HANDLERS,
  ];
}

export function publicFeatures(): PublicCapabilities["features"] {
  return {
    transcriptFollow: "poll",
    exec: { local: true, container: true },
    projectCascadeRemove: false,
    localProjectInit: false,
    promptAttachments: false,
    selectedSlashCommands: false,
    enqueue: false,
  };
}

export function buildPublicHandlerTable(
  handlers: PublicActionHandler[] = publicActionHandlers(),
  features: () => PublicCapabilities["features"] = publicFeatures,
): Map<PublicActionName, PublicActionHandler> {
  const table = new Map<PublicActionName, PublicActionHandler>();
  const capabilities = createCapabilitiesHandler(() => new Set(table.keys()), features);
  for (const handler of [capabilities, ...handlers]) {
    if (table.has(handler.action))
      throw new Error(`Duplicate public action handler: ${handler.action}`);
    table.set(handler.action, handler);
  }
  return table;
}

export function registerPublicApiCommands(
  register: CommandRegistrar,
  dependencies: RegistryDependencies,
): void {
  registerPublicActionCommand(register, dependencies, buildPublicHandlerTable());
}
