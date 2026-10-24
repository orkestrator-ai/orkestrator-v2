import { useState } from "react";
import { FederationProvider } from "../../apps/web/src/components/federation/FederationProvider";
import { SettingsPage } from "../../apps/web/src/components/settings/SettingsPage";
import { useAccountMachineStore } from "../../apps/web/src/components/settings/account-machine";
import { useConfigStore } from "../../apps/web/src/stores/configStore";
import { useRemoteWorkspaceStore } from "../../apps/web/src/stores/remoteWorkspaceStore";
import type { AppConfig, GlobalConfig } from "../../apps/web/src/types";

function install() {
  const base = useConfigStore.getState().config;
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
      case "update_global_config": {
        const saved = { ...read(owner), global: args.global as GlobalConfig };
        localStorage.setItem(`settings-machine:${owner}`, JSON.stringify(saved));
        return saved;
      }
      case "get_backend_profile":
        return { revision: 1, displayName: "Leaf", colorToken: "blue", updatedAt: "" };
      case "get_node_status":
        return { nodeId: "command" };
      case "get_node_summaries":
        return {
          selfId: "command",
          nodes,
          self: { nodeId: "command", displayName: "Command", projects: [], environments: [] },
        };
      case "get_agent_model_catalog_cache":
        return { schemaVersion: 1 };
      case "get_log_directory":
        return `/${owner}/logs`;
      default:
        return undefined;
    }
  };
  const native = window.orkestrator!;
  window.orkestrator = {
    ...native,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) =>
      answer("leaf", command, args) as T,
  };
  window.orkestratorPortal = {
    ...native,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) =>
      (command === "invoke_on_node"
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
  window.orkestratorWorkspaceTarget = { nodeId: "leaf", nodeName: "Leaf", path: "direct" };
  useRemoteWorkspaceStore.setState({ active: null });
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
