/**
 * Which machine a setting belongs to, from the same rules the config layering
 * uses (`INHERITED_GLOBAL_SETTING_KEYS`), so the catalog cannot drift from
 * where a save actually goes.
 */
import { INHERITED_GLOBAL_SETTING_KEYS } from "@orkestrator/protocol/controller-settings";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import type { SettingDescriptor, SettingScope, SettingTiming } from "./types";

/**
 * Sections only the command node has: its machines, the preferences every
 * machine inherits from it, this client's own web server, and the Control
 * MCP server, whose credentials never cross to another node.
 */
export const COMMAND_NODE_SECTIONS: ReadonlySet<GlobalSettingsSection | ""> = new Set([
  "machines",
  "capabilities",
  "review",
  "messaging",
  "schedules",
  "web-client",
  "mcp",
]);

const INHERITED_KEYS: ReadonlySet<string> = new Set(INHERITED_GLOBAL_SETTING_KEYS);

export function isInheritedSettingKey(key: string): boolean {
  return INHERITED_KEYS.has(key);
}

export function settingScope(descriptor: SettingDescriptor): SettingScope {
  if (descriptor.owner === "window") return "window";
  if (descriptor.value && isInheritedSettingKey(descriptor.value.key)) return "inherited";
  if (descriptor.owner === "command-node" || COMMAND_NODE_SECTIONS.has(descriptor.section)) {
    return "command-node";
  }
  return "machine";
}

export const SETTING_SCOPE_LABELS: Record<SettingScope, string> = {
  machine: "This machine",
  inherited: "Command node · inherited",
  "command-node": "Command node",
  window: "This window",
};

export const SETTING_TIMING_LABELS: Record<SettingTiming, string> = {
  immediately: "Applies immediately",
  "new-sessions": "Applies to new agent sessions; running sessions keep theirs",
  "new-environments": "Applies to new or rebuilt environments",
  "new-terminals": "Applies to terminals opened afterwards",
  restart: "Applies after Orkestrator restarts",
  "new-windows": "Applies to windows opened afterwards",
};

/** Short form for save feedback: "applies to new agent sessions". */
export const SETTING_TIMING_SHORT: Record<SettingTiming, string> = {
  immediately: "applies immediately",
  "new-sessions": "applies to new agent sessions",
  "new-environments": "applies to new or rebuilt environments",
  "new-terminals": "applies to new terminals",
  restart: "applies after a restart",
  "new-windows": "applies to new windows",
};

/**
 * Sections drawn by their own components rather than the shared auto-saving
 * form. Moving to one unmounts the form, which saves a pending edit but loses
 * one that cannot be saved yet (a validation failure), so search asks first.
 */
export const SECTIONS_OUTSIDE_SHARED_FORM: ReadonlySet<GlobalSettingsSection> = new Set([
  "machines",
  "disk-usage",
  "usage",
  "capabilities",
  "mcp",
  "mcp-servers",
  "messaging",
  "schedules",
  "self-improvement",
  "permissions",
  "credentials",
  "docker",
  "sounds",
]);
