import { PERMISSION_RULE_HANDLERS } from "./actions-permission-rules.js";
import type { PublicActionName, PublicCapabilities } from "@orkestrator/protocol/public-api";
import type { CommandRegistrar, RegistryDependencies } from "../commands-registry-types.js";
import { ATTENTION_HANDLERS } from "./actions-attention.js";
import { BUILD_HANDLERS } from "./actions-builds.js";
import { CHANGE_HANDLERS } from "./actions-changes.js";
import { createCapabilitiesHandler, DISCOVERY_HANDLERS } from "./actions-discovery.js";
import { ENVIRONMENT_HANDLERS } from "./actions-environments.js";
import { EXEC_HANDLERS } from "./actions-exec.js";
import { HOST_HANDLERS } from "./actions-host.js";
import { LAUNCH_HANDLERS } from "./actions-launch.js";
import { MAIL_HANDLERS } from "./actions-mail.js";
import { NODE_HANDLERS } from "./actions-nodes.js";
import { PROJECT_HANDLERS } from "./actions-projects.js";
import { REVIEW_HANDLERS } from "./actions-reviews.js";
import { createRunReadHandlers, RUN_RECOVERY_HANDLERS } from "./actions-runs.js";
import { SCHEDULE_HANDLERS } from "./actions-schedules.js";
import { SESSION_COMMAND_HANDLERS } from "./actions-session-commands.js";
import { SESSION_CONTROL_HANDLERS } from "./actions-session-controls.js";
import { SESSION_HANDLERS } from "./actions-sessions.js";
import { SETTINGS_HANDLERS } from "./actions-settings.js";
import { TICKET_HANDLERS } from "./actions-tickets.js";
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
  const handlers: PublicActionHandler[] = [
    ...DISCOVERY_HANDLERS,
    ...PROJECT_HANDLERS,
    ...ENVIRONMENT_HANDLERS,
    ...SETTINGS_HANDLERS,
    ...LAUNCH_HANDLERS,
    ...SESSION_HANDLERS,
    ...SESSION_COMMAND_HANDLERS,
    ...SESSION_CONTROL_HANDLERS,
    ...TRANSCRIPT_HANDLERS,
    ...CHANGE_HANDLERS,
    ...REVIEW_HANDLERS,
    ...BUILD_HANDLERS,
    ...ATTENTION_HANDLERS,
    ...TICKET_HANDLERS,
    ...MAIL_HANDLERS,
    ...NODE_HANDLERS,
    ...SCHEDULE_HANDLERS,
    ...PERMISSION_RULE_HANDLERS,
    ...RUN_RECOVERY_HANDLERS,
    ...EXEC_HANDLERS,
    ...HOST_HANDLERS,
  ];
  handlers.push(
    ...createRunReadHandlers((action) => handlers.find((handler) => handler.action === action)),
  );
  return handlers;
}

/**
 * Optional features. Each names the action or input that carries it, and is
 * withdrawn by removing that handler or input, never by flipping this alone:
 * `project.remove` `cascade`, `project.init`, `attachments` on
 * `session.prompt`/`session.start`, `session.commands`/`session.command`
 * (with `literal` on prompts), and `enqueue`.
 */
export function publicFeatures(): PublicCapabilities["features"] {
  return {
    transcriptFollow: "poll",
    exec: { local: true, container: true },
    projectCascadeRemove: true,
    localProjectInit: true,
    promptAttachments: true,
    selectedSlashCommands: true,
    enqueue: true,
    nodeRouting: true,
  };
}

export function buildPublicHandlerTable(
  handlers: PublicActionHandler[] = publicActionHandlers(),
  features: () => PublicCapabilities["features"] = publicFeatures,
): Map<PublicActionName, PublicActionHandler> {
  const table = new Map<PublicActionName, PublicActionHandler>();
  const capabilities = createCapabilitiesHandler(() => table, features);
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
