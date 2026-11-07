/**
 * The workspace grant allow-list over the real command registry, for tests
 * that pin whether a workspace client (a client grant or the relay) may run a
 * command (plan item 7012).
 */
import type { CommandAccess } from "@orkestrator/protocol/contract/command";
import { createCommandRegistry, type CommandRegistry } from "../commands-registry.js";
import { isWorkspaceGrantCommand } from "./workspace-grant-scope.js";

let registry: CommandRegistry | undefined;

function realRegistry(): CommandRegistry {
  registry ??= createCommandRegistry();
  return registry;
}

/** The `access` the real registry's definition of `command` declares. */
export function registryCommandAccess(command: string): CommandAccess | undefined {
  return realRegistry().contracts.get(command)?.access;
}

/** Whether `command` is registered at all. */
export function registryHasCommand(command: string): boolean {
  return realRegistry().has(command);
}

/** Every registered command with its declared access, sorted by name. */
export function registryCommands(): Array<[string, CommandAccess | undefined]> {
  return [...realRegistry().keys()].sort().map((name) => [name, registryCommandAccess(name)]);
}

/** Whether a workspace grant, and the relay, run `command`. */
export function grantAdmits(command: string): boolean {
  return isWorkspaceGrantCommand(command, registryCommandAccess);
}
