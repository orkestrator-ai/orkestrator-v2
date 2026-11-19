/**
 * The settings catalog's shapes: one `SettingDescriptor` per user-editable
 * setting Settings shows.
 *
 * The catalog describes settings; it stores nothing and resolves nothing.
 * Values are read from the config the section already shows
 * (`useSettingsConfig`), where they come from is read from the backend
 * (`get_global_setting_sources`), and each field keeps its own editor,
 * validation and save path.
 */
import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import type { GlobalConfig } from "@/types";

/** When a saved change takes effect. */
export type SettingTiming =
  /** Immediately, including for work already running. */
  | "immediately"
  /** For agent sessions started afterwards; running sessions keep what they started with. */
  | "new-sessions"
  /** For environments and containers created (or rebuilt) afterwards. */
  | "new-environments"
  /** For terminals opened afterwards. */
  | "new-terminals"
  /** After Orkestrator restarts on that machine. */
  | "restart"
  /** For windows opened afterwards. */
  | "new-windows";

/**
 * Who owns a setting that is not one of the global config keys, so search can
 * say which machine a change affects. Config-backed settings derive theirs
 * from the layering rules (`settingScope`).
 */
export type SettingOwner = "machine" | "command-node" | "window";

/** The scope search and the field explanation show. */
export type SettingScope =
  /** Stored on the selected machine, affects only it. */
  | "machine"
  /** Stored on the command node and inherited by every machine it controls. */
  | "inherited"
  /** Only the command node has it (its machines, its web client, its MCP server…). */
  | "command-node"
  /** Kept by this window only. */
  | "window";

/** A setting backed by one top-level global config key. */
export interface SettingValueBinding {
  /** The stored key; a reset removes this whole key. */
  readonly key: keyof GlobalConfig & string;
  /** The effective value, resolved the way the form resolves it. */
  readonly read: (global: GlobalConfig) => unknown;
  /** The value that applies when nothing is stored. */
  readonly defaultValue: unknown;
  /** Short display text; never called for a sensitive setting. */
  readonly format?: (value: unknown) => string;
}

/** What the availability check sees: the effective settings of the machine on screen. */
export interface SettingAvailabilityContext {
  readonly global: GlobalConfig;
  /** Whether the machine on screen is the one this window runs on. */
  readonly isWindowMachine: boolean;
}

/** A setting that only appears in some states. */
export interface SettingAvailability {
  readonly isAvailable: (context: SettingAvailabilityContext) => boolean;
  /** Why it is hidden, phrased as what to do: "Turn on Scheduling in Experimental." */
  readonly reason: string;
  /** The setting that makes it available; navigation goes there instead. */
  readonly via?: string;
}

/** How navigation finds a field that is not wrapped in a `SettingField` anchor. */
export interface SettingLocator {
  /** A control's element id. */
  readonly id?: string;
  /** A control's accessible name. */
  readonly ariaLabel?: string;
  /** A section heading's exact text. */
  readonly heading?: string;
}

export interface SettingDescriptor {
  /** Stable key, also the field's `data-setting-anchor`: `terminal.scrollback`. */
  readonly id: string;
  readonly section: GlobalSettingsSection;
  readonly label: string;
  /** What the setting does; searched, so never a value. */
  readonly description: string;
  /** Curated search terms: synonyms people type for it. */
  readonly aliases?: readonly string[];
  readonly appliesWhen: SettingTiming;
  /** A credential: shown only as configured or not, never searched for its value. */
  readonly sensitive?: boolean;
  /** For a credential, whether one is stored (from the redacted `*Configured` flags). */
  readonly configured?: (global: GlobalConfig) => boolean;
  /** Owner of a setting that has no `value` binding. */
  readonly owner?: SettingOwner;
  readonly value?: SettingValueBinding;
  readonly availability?: SettingAvailability;
  /** Fallbacks when the field has no anchor of its own. */
  readonly locate?: SettingLocator;
}
