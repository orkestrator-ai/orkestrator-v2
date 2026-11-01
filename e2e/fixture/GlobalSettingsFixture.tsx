import { PlanUsageFixture } from "./PlanUsageFixture";
import { useState } from "react";
import { GlobalSettings } from "../../apps/web/src/components/settings/GlobalSettings";
import { useConfigStore } from "../../apps/web/src/stores/configStore";
import type { GlobalSettingsSection } from "../../apps/web/src/lib/settings-navigation";
import type { AppConfig, GlobalConfig } from "../../apps/web/src/types";

function installGlobalSettingsFixture() {
  const config = useConfigStore.getState().config;
  const cursorDisabled = new URLSearchParams(window.location.search).has("cursor-disabled");
  const initialConfig: AppConfig = cursorDisabled
    ? { ...config, global: { ...config.global, enabledAgentPlatforms: ["claude"] } }
    : config;
  const readConfig = (): AppConfig =>
    JSON.parse(localStorage.getItem("global-settings-config") ?? JSON.stringify(initialConfig));
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
      switch (command) {
        case "get_config":
          return readConfig() as T;
        case "update_global_config": {
          // Match the backend's wholesale replacement contract. Capture the
          // received payload separately so omission at the default is observable.
          const global = args!.global as GlobalConfig;
          const config = { ...readConfig(), global };
          localStorage.setItem("global-settings-last-write", JSON.stringify(global));
          localStorage.setItem("global-settings-config", JSON.stringify(config));
          return config as T;
        }
        case "patch_global_config": {
          // Match the backend's merge of the changed keys onto current settings.
          const current = readConfig();
          const global = { ...current.global, ...(args!.patch as Partial<GlobalConfig>) };
          for (const key of (args!.unset as string[] | undefined) ?? []) {
            delete (global as unknown as Record<string, unknown>)[key];
          }
          const config = { ...current, global };
          localStorage.setItem("global-settings-last-write", JSON.stringify(global));
          localStorage.setItem("global-settings-config", JSON.stringify(config));
          return config as T;
        }
        case "get_app_version":
          return "2.34.4" as T;
        case "get_log_storage_stats":
          return {
            fileCount: 0,
            totalBytes: 0,
            oldestFile: null,
            newestFile: null,
            retentionDays: 7,
          } as T;
        case "get_log_directory":
          return "/fixture/logs" as T;
        case "list_agent_accounts":
          return { accounts: [], active: { claude: "host", codex: "host" } } as T;
        case "get_agent_account_login":
          return { state: "idle" } as T;
        case "cursor_sdk_login_status":
          return { state: "idle", auth: { authenticated: false, source: "none" } } as T;
        case "get_agent_sign_in_status":
          // An expired active Claude login, read without a session.
          return {
            state: "expired",
            account: { label: "Host login", plan: "max" },
            signIn: {
              kind: "terminal",
              hint: "Sign the active Claude account in again from this card.",
            },
            signOut: false,
          } as T;
        default:
          throw new Error(`Unexpected global settings fixture command: ${command}`);
      }
    },
  };
  useConfigStore.getState().setConfig(readConfig());
  return true;
}

export function GlobalSettingsFixture() {
  useState(installGlobalSettingsFixture);
  if (new URLSearchParams(window.location.search).has("plan-usage")) return <PlanUsageFixture />;
  return (
    <main className="p-4">
      <GlobalSettings
        activeSection={
          (new URLSearchParams(window.location.search).get(
            "section",
          ) as GlobalSettingsSection | null) ??
          (new URLSearchParams(window.location.search).has("cursor-disabled") ? "cursor" : "claude")
        }
      />
    </main>
  );
}
