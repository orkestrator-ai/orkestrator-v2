import { useState } from "react";
import { builtInResourceDefault } from "@orkestrator/protocol/container-resources";
import { FederationProvider } from "../../apps/web/src/components/federation/FederationProvider";
import { SettingsPage } from "../../apps/web/src/components/settings/SettingsPage";
import { useAccountMachineStore } from "../../apps/web/src/components/settings/account-machine";
import { useConfigStore } from "../../apps/web/src/stores/configStore";
import { useRemoteWorkspaceStore } from "../../apps/web/src/stores/remoteWorkspaceStore";
import type { AppConfig, GlobalConfig } from "../../apps/web/src/types";
import { appCommandStore } from "../../apps/web/src/test/app-command-store";

function install() {
  const base = appCommandStore(useConfigStore.def).getState().config;
  const directLeaf = new URLSearchParams(window.location.search).has("direct-leaf");
  const read = (owner: string): AppConfig =>
    JSON.parse(
      localStorage.getItem(`settings-machine:${owner}`) ??
        JSON.stringify({
          ...base,
          repositories: { [owner]: { defaultBranch: "main", prBaseBranch: "main" } },
          global: {
            ...base.global,
            defaultProjectsDirectory: `/${owner}/projects`,
            allowedDomains: [`${owner}.test`],
            useHostGitHubCredentials: false,
          },
        }),
    );
  // StrictMode probes a newly mounted config effect twice. Fail both reads
  // so the error remains visible until the user explicitly retries.
  let failedReadsRemaining = new URLSearchParams(window.location.search).has("retry") ? 2 : 0;
  const nodes = ["leaf", "other"].map((nodeId) => ({
    nodeId,
    view: { displayName: nodeId === "leaf" ? "Leaf" : "Other", connection: { state: "connected" } },
    projects: [],
    environments: [],
    freshness: "current",
  }));
  const answer = (owner: string, command: string, args: Record<string, unknown> = {}): unknown => {
    switch (command) {
      case "get_config":
        if (owner === "other" && failedReadsRemaining > 0) {
          failedReadsRemaining -= 1;
          throw new Error("Fixture machine offline");
        }
        return read(owner);
      case "get_docker_capacity": {
        const daemon = {
          scope: "docker-daemon",
          cpus: 8,
          memoryBytes: 16 * 1024 ** 3,
          operatingSystem: "Linux",
          rootless: false,
          cgroupVersion: "2",
          support: { cpuQuota: true, memoryLimit: true, pidsLimit: true },
        };
        return { ...daemon, builtInDefault: builtInResourceDefault(daemon) };
      }
      case "set_container_resource_limits": {
        const config = read(owner);
        if (args.limits)
          config.global.containerResourceLimits = args.limits as NonNullable<
            GlobalConfig["containerResourceLimits"]
          >;
        else delete config.global.containerResourceLimits;
        localStorage.setItem(`settings-machine:${owner}`, JSON.stringify(config));
        return { limits: args.limits };
      }
      case "update_global_config": {
        const saved = { ...read(owner), global: args.global as GlobalConfig };
        localStorage.setItem(`settings-machine:${owner}`, JSON.stringify(saved));
        return saved;
      }
      case "patch_global_config": {
        const current = read(owner);
        const global = { ...current.global, ...(args.patch as Partial<GlobalConfig>) };
        for (const key of (args.unset as string[] | undefined) ?? []) {
          delete (global as unknown as Record<string, unknown>)[key];
        }
        // A leaf opened directly saves locally, then receives the inherited
        // command-node value in the effective config returned by the backend.
        if (directLeaf && owner === "leaf") delete global.autoSteer;
        const saved = { ...current, global };
        if (directLeaf) {
          const key = "settings-machine:patch-count";
          localStorage.setItem(key, String(Number(localStorage.getItem(key) ?? 0) + 1));
        }
        localStorage.setItem(`settings-machine:${owner}`, JSON.stringify(saved));
        return saved;
      }
      case "get_backend_profile":
        return {
          revision: 1,
          displayName: owner === "command" ? "Command" : owner === "leaf" ? "Leaf" : "Other",
          colorToken: "blue",
          updatedAt: "",
        };
      case "get_node_status":
        return { nodeId: "command" };
      case "get_node_summaries":
        return { selfId: "command", nodes };
      case "get_agent_model_catalog_cache":
        return { schemaVersion: 1 };
      case "get_log_directory":
        return `/${owner}/logs`;
      default:
        return undefined;
    }
  };
  const native = window.orkestrator!;
  // A directly opened leaf is its own window's node; otherwise the window is
  // the command node's, reaching the other machines through it, with the
  // leaf's workspace shown in its tree.
  window.orkestrator = {
    ...native,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) =>
      (directLeaf
        ? answer("leaf", command, args)
        : command === "invoke_on_node"
          ? {
              outcome: "ok",
              result: answer(
                String(args?.nodeId),
                String(args?.command),
                args?.args as Record<string, unknown>,
              ),
            }
          : answer("command", command, args)) as T,
  };
  useRemoteWorkspaceStore.setState({
    active: directLeaf ? null : { nodeId: "leaf", projectId: null, environmentId: null },
  });
  useAccountMachineStore.getState().choose(undefined);
  return true;
}

export function SettingsMachineFixture() {
  useState(install);
  return (
    <FederationProvider>
      <SettingsPage open onOpenChange={() => {}} defaultSection="general" />
    </FederationProvider>
  );
}
