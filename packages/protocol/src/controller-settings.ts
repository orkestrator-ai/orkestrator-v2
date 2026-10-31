/**
 * Settings a command node hands down to the nodes it controls.
 *
 * The user changes settings on the command node they are connected to, and
 * those settings apply to work on every node it controls. The command node
 * sends the inherited subset to each leaf when it attaches and whenever its
 * config changes (`sync_controller_settings`). The leaf keeps the copy from
 * every attached command node and lays the most recently changed one over its
 * own config, so a leaf-side launch that falls back to defaults uses the
 * command node's. The leaf's own values are kept underneath and come back
 * when the command node detaches.
 *
 * Only preferences travel. Machine-specific settings (paths, credentials,
 * installed platforms, container budgets, network policy) stay with each
 * machine. See `docs/architecture/command-nodes.md` ("Settings").
 */

import { isBackendId, type BackendId } from "./federation.js";

export const SYNC_CONTROLLER_SETTINGS_COMMAND = "sync_controller_settings";

/** Global config keys a command node's settings override on its leaves. */
export const INHERITED_GLOBAL_SETTING_KEYS = [
  "agentSettings",
  "favoriteModels",
  "reviewInstruction",
  "reviewLensPresets",
  "openCodeModelProviders",
  "codexMaxConcurrentThreads",
  "claudeBackgroundCommandLimitHours",
  "sessionTitleGeneration",
  "terminalAppearance",
  "terminalScrollback",
  "agentMessaging",
] as const;

export type InheritedGlobalSettingKey = (typeof INHERITED_GLOBAL_SETTING_KEYS)[number];

/** The inherited subset of a global config. Values are validated by the leaf's own normalizers. */
export type InheritedGlobalSettings = Partial<Record<InheritedGlobalSettingKey, unknown>>;

/** Bound on one command node's serialized settings. */
export const MAX_INHERITED_SETTINGS_BYTES = 256 * 1024;

const INHERITED_KEYS: ReadonlySet<string> = new Set(INHERITED_GLOBAL_SETTING_KEYS);

export function isInheritedGlobalSettingKey(key: string): key is InheritedGlobalSettingKey {
  return INHERITED_KEYS.has(key);
}

/** The inherited keys present in a global config. */
export function pickInheritedGlobalSettings(global: object): InheritedGlobalSettings {
  const source = global as Record<string, unknown>;
  const picked: InheritedGlobalSettings = {};
  for (const key of INHERITED_GLOBAL_SETTING_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

/**
 * Accept settings sent by a command node: a plain JSON object, inherited
 * keys only (others are dropped), within the size bound.
 */
export function parseInheritedGlobalSettings(value: unknown): InheritedGlobalSettings {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("Expected settings to be an object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Settings must be plain JSON.");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_INHERITED_SETTINGS_BYTES) {
    throw new Error("Settings are too large.");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected settings to be an object.");
  }
  return pickInheritedGlobalSettings(parsed);
}

/** One command node's settings, as a leaf keeps them. */
export interface ControllerSettingsEntry {
  controllerId: BackendId;
  settings: InheritedGlobalSettings;
  /** When the leaf last received a change to them. */
  changedAt: string;
}

export interface ControllerSettingsStore {
  version: 1;
  entries: ControllerSettingsEntry[];
}

export function emptyControllerSettingsStore(): ControllerSettingsStore {
  return { version: 1, entries: [] };
}

/** Read a stored copy, dropping entries that no longer parse. */
export function parseControllerSettingsStore(value: unknown): ControllerSettingsStore {
  if (!value || typeof value !== "object") return emptyControllerSettingsStore();
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return emptyControllerSettingsStore();
  const parsed: ControllerSettingsEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (
      !isBackendId(record.controllerId) ||
      typeof record.changedAt !== "string" ||
      !Number.isFinite(Date.parse(record.changedAt))
    )
      continue;
    try {
      parsed.push({
        controllerId: record.controllerId,
        settings: parseInheritedGlobalSettings(record.settings),
        changedAt: record.changedAt,
      });
    } catch {
      // A corrupt entry is dropped; the command node sends it again on its next attach.
    }
  }
  return { version: 1, entries: parsed };
}

/** Which command node's settings a leaf is using, for its own status. */
export interface InheritedSettingsSource {
  controllerId: BackendId;
  displayName: string;
  changedAt: string;
}
