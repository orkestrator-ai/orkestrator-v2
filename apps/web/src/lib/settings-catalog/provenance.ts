/**
 * The field explanation's model: what value is in effect, where it comes
 * from, whether it is stored explicitly, and whether it differs from the
 * default. Values come from the config the section shows; sources from the
 * backend's stored-key read (`get_global_setting_sources`). Nothing here
 * guesses: a source the backend could not report stays `unknown`.
 */
import {
  isResettableGlobalSettingKey,
  settingValuesEqual,
} from "@orkestrator/protocol/setting-sources";
import type { GlobalConfig } from "@/types";
import type { SettingSourcesLayers, SettingSourcesRead } from "@/lib/portal/command-node-config";
import { isInheritedSettingKey, settingScope } from "./scope";
import type { SettingDescriptor } from "./types";

export type EffectiveSource =
  /** Stored on the machine on screen. */
  | { readonly kind: "machine" }
  /** Stored on the command node; the machine on screen inherits it. */
  | { readonly kind: "command-node" }
  /**
   * Stored on the command node, and the machine on screen is that command
   * node: every machine it controls inherits it.
   */
  | { readonly kind: "command-node-self" }
  /** Taken from a command node this machine follows outside this window. */
  | { readonly kind: "controller" }
  /** Nothing is stored: the product default applies. */
  | { readonly kind: "default" }
  | { readonly kind: "unknown"; readonly reason: "loading" | "unsupported" | "failed" };

export interface SettingPresentation {
  /** The value in effect, as stored settings resolve it. */
  readonly effective: unknown;
  readonly source: EffectiveSource;
  /** Whether a value is stored explicitly; `null` when the source is unknown. */
  readonly hasOverride: boolean | null;
  readonly isDifferentFromDefault: boolean;
  /** Whether removing the stored value is supported for this setting. */
  readonly resettable: boolean;
}

/** `null` while sources are loading. */
export type SourcesState = SettingSourcesLayers | null;

function storedIn(read: SettingSourcesRead, key: string): boolean | EffectiveSource {
  if (read.status === "unsupported") return { kind: "unknown", reason: "unsupported" };
  if (read.status === "failed") return { kind: "unknown", reason: "failed" };
  return read.sources.storedKeys.includes(key);
}

/** Where `key`'s value comes from for the machine on screen. */
export function resolveSettingSource(key: string, layers: SourcesState): EffectiveSource {
  if (!layers) return { kind: "unknown", reason: "loading" };
  const inherited = isInheritedSettingKey(key);
  if (layers.node) {
    // A separate machine: its inherited preferences are the command node's.
    if (inherited) {
      const onCommand = storedIn(layers.commandNode, key);
      if (typeof onCommand !== "boolean") return onCommand;
      return onCommand ? { kind: "command-node" } : { kind: "default" };
    }
    const onNode = storedIn(layers.node, key);
    if (typeof onNode !== "boolean") return onNode;
    return onNode ? { kind: "machine" } : { kind: "default" };
  }
  const read = layers.commandNode;
  if (inherited && read.status === "ok" && read.sources.inheritedKeys?.includes(key)) {
    return { kind: "controller" };
  }
  const own = storedIn(read, key);
  if (typeof own !== "boolean") return own;
  if (!own) return { kind: "default" };
  return inherited ? { kind: "command-node-self" } : { kind: "machine" };
}

export function presentSetting(
  descriptor: SettingDescriptor,
  global: GlobalConfig,
  layers: SourcesState,
): SettingPresentation | null {
  const binding = descriptor.value;
  if (!binding) return null;
  const effective = binding.read(global);
  const source = resolveSettingSource(binding.key, layers);
  const hasOverride = source.kind === "unknown" ? null : source.kind !== "default";
  return {
    effective,
    source,
    hasOverride,
    isDifferentFromDefault: !settingValuesEqual(effective, binding.defaultValue),
    resettable: isResettableGlobalSettingKey(binding.key) && !descriptor.sensitive,
  };
}

/** Every catalog entry that shares `descriptor`'s stored key: what one reset changes. */
export function settingsSharingKey(
  catalog: readonly SettingDescriptor[],
  descriptor: SettingDescriptor,
): SettingDescriptor[] {
  const key = descriptor.value?.key;
  return key ? catalog.filter((entry) => entry.value?.key === key) : [descriptor];
}

export interface SourceNames {
  /** The machine on screen. */
  readonly machine: string;
  /** The command node, when it is named. */
  readonly commandNode: string | null;
  /** Whether this window works with several machines; otherwise inheritance is not mentioned. */
  readonly federated?: boolean;
}

/** "Set on Studio", "Inherited from Studio", "Default · nothing stored on Studio"… */
export function describeSource(
  source: EffectiveSource,
  names: SourceNames,
  descriptor: SettingDescriptor,
): string {
  const commandNode = names.commandNode ?? "the command node";
  const owner = settingScope(descriptor) === "inherited" ? commandNode : names.machine;
  switch (source.kind) {
    case "machine":
      return `Set on ${names.machine}`;
    case "command-node":
      return `Inherited from ${commandNode}`;
    case "command-node-self":
      return names.federated
        ? `Set on ${names.machine}; machines it controls inherit it`
        : `Set on ${names.machine}`;
    case "controller":
      return "Inherited from the command node this machine follows";
    case "default":
      return `Default; nothing stored on ${owner}`;
    case "unknown":
      return source.reason === "loading"
        ? "Checking where this value comes from…"
        : source.reason === "unsupported"
          ? `Source unknown: ${owner} runs an older Orkestrator`
          : "Source unknown: stored settings could not be read";
  }
}

/** The value as text; a sensitive setting never shows one. */
export function formatSettingValue(descriptor: SettingDescriptor, value: unknown): string {
  if (descriptor.sensitive) return "Hidden";
  const format = descriptor.value?.format;
  if (format) return format(value);
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "Custom value";
}
