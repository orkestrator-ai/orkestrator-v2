import { useState } from "react";
import { FederationProvider } from "../../apps/web/src/components/federation/FederationProvider";
import { SettingsPage } from "../../apps/web/src/components/settings/SettingsPage";
import { useAccountMachineStore } from "../../apps/web/src/components/settings/account-machine";
import { useConfigStore } from "../../apps/web/src/stores/configStore";
import type { GlobalSettingsSection } from "../../apps/web/src/lib/settings-navigation";
import type { AppConfig, GlobalConfig } from "../../apps/web/src/types";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

/**
 * Settings on one machine with a few stored settings: two that differ from
 * their defaults (debug logging, session titles), one stored at its default
 * (auto-steer), and the rest following defaults. `?reset-conflict` makes the
 * first reset find the value moved. Resets are recorded in localStorage.
 */
function install() {
  const base = appCommandStore(useConfigStore.def).getState().config;
  let config: AppConfig = {
    ...base,
    global: {
      ...base.global,
      debugLogging: true,
      autoSteer: false,
      sessionTitleGeneration: "off",
      terminalHistoryEnabled: false,
    } as GlobalConfig,
  };
  let storedKeys = [
    "autoSteer",
    "debugLogging",
    "sessionTitleGeneration",
    "terminalHistoryEnabled",
  ];
  let conflictOnce = new URLSearchParams(window.location.search).has("reset-conflict");
  const answer = (command: string, args: Record<string, unknown> = {}): unknown => {
    switch (command) {
      case "get_config":
        return config;
      case "get_global_setting_sources":
        return { storedKeys, inheritedKeys: null };
      case "patch_global_config": {
        const global = { ...config.global, ...(args.patch as Partial<GlobalConfig>) };
        for (const key of (args.unset as string[] | undefined) ?? []) {
          delete (global as unknown as Record<string, unknown>)[key];
        }
        storedKeys = [
          ...new Set([...storedKeys, ...Object.keys((args.patch as object) ?? {})]),
        ].filter((key) => !((args.unset as string[] | undefined) ?? []).includes(key));
        config = { ...config, global };
        return config;
      }
      case "reset_global_settings": {
        const keys = args.keys as string[];
        localStorage.setItem("settings-search:resets", JSON.stringify(args));
        if (conflictOnce) {
          conflictOnce = false;
          return { status: "conflict", conflicts: keys, config };
        }
        const global = { ...config.global } as unknown as Record<string, unknown>;
        for (const key of keys) delete global[key];
        config = { ...config, global: global as unknown as GlobalConfig };
        storedKeys = storedKeys.filter((key) => !keys.includes(key));
        return { status: "reset", conflicts: [], config };
      }
      case "get_backend_profile":
        return { revision: 1, displayName: "Studio", colorToken: "violet", updatedAt: "" };
      case "get_node_status":
        return { nodeId: "command" };
      case "get_node_summaries":
        return { selfId: "command", nodes: [] };
      case "get_agent_model_catalog_cache":
        return { schemaVersion: 1 };
      case "get_log_directory":
        return "/studio/logs";
      case "get_log_storage_stats":
        return {
          fileCount: 0,
          totalBytes: 0,
          oldestFile: null,
          newestFile: null,
          retentionDays: 7,
        };
      case "get_app_version":
        return "2.39.8-beta";
      default:
        return undefined;
    }
  };
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) =>
      answer(command, args) as T,
  };
  appCommandStore(useConfigStore.def).getState().setConfig(config);
  useAccountMachineStore.getState().choose(undefined);
  return true;
}

export function SettingsSearchFixture() {
  useState(install);
  const section =
    (new URLSearchParams(window.location.search).get("section") as GlobalSettingsSection | null) ??
    "general";
  return (
    <FederationProvider>
      <SettingsPage open onOpenChange={() => {}} defaultSection={section} />
    </FederationProvider>
  );
}
