import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "../commands.js";
import { isNodeRoutingExcludedCommand } from "./node-routing.js";
import {
  admitsWorkspaceCommand,
  isGlobalConfigEcho,
  isGlobalConfigWriteCommand,
  workspaceAllowList,
} from "./workspace-grant-scope.js";

/** The machine's administration, refused to workspace clients since security report I1. */
const MACHINE_ADMINISTRATION = [
  "public_action",
  "update_global_config",
  "patch_global_config",
  "update_notification_sound_settings",
  "set_workflow_result_tools_rollout",
  "web_annotations_rollout_set",
  "save_desktop_connections",
  "set_container_resource_limits",
  "docker_cleanup_preview",
  "docker_cleanup_execute",
  "set_github_token",
  "set_cursor_api_key",
  "set_anthropic_api_key",
  "set_opencode_zen_api_key",
  "update_backend_profile",
  "update_worktree_locations",
  "update_preview_settings",
  "cleanup_logs",
  "get_database_stats",
  "plan_diagnostics_bundle",
  "plan_diagnostics_bundle_with_container_logs",
  "read_diagnostics_bundle",
  "record_renderer_errors",
  "record_domain_adapter_usage",
  "graph_capability_ceiling_set",
  "request_host_update_check",
  "request_host_update",
  "cancel_host_update",
  "start_host_toolchain_repair",
  "start_host_image_update",
  "set_host_update_channel",
  "set_host_gh_channel",
];

describe("the workspace grant allow-list (plan item 7012)", () => {
  const registry = createCommandRegistry();
  const accessOf = (command: string) => registry.contracts.get(command)?.access;
  const admits = (command: string) => admitsWorkspaceCommand(command, { accessOf });

  test("every registered command is defined, so every one has an access", () => {
    for (const command of registry.keys()) {
      expect({ command, defined: registry.contracts.has(command) }).toEqual({
        command,
        defined: true,
      });
    }
  });

  test("admits every workspace command and refuses every admin and internal one", () => {
    const allowList = workspaceAllowList(registry.contracts);
    let workspace = 0;
    for (const [command, def] of registry.contracts) {
      if (def.access === "workspace") workspace += 1;
      expect({ command, admitted: admits(command) }).toEqual({
        command,
        admitted: def.access === "workspace",
      });
      expect(allowList.has(command)).toBe(def.access === "workspace");
    }
    expect(allowList.size).toBe(workspace);
    expect(workspace).toBeGreaterThan(0);
  });

  test("refuses an unregistered command and a name that is not one", () => {
    for (const command of ["no_such_command", "get_config ", "", "__proto__", "constructor"]) {
      expect(admits(command)).toBe(false);
    }
  });

  test("fails closed without the registry's access", () => {
    expect(admitsWorkspaceCommand("get_config", {})).toBe(false);
    expect(admitsWorkspaceCommand("get_config", { accessOf })).toBe(true);
  });

  test.each(MACHINE_ADMINISTRATION)(
    "%s is registered, refused to a workspace client and still routed to a node",
    (command) => {
      expect(registry.has(command)).toBe(true);
      expect(admits(command)).toBe(false);
      // Settings reaches another machine's settings over the node link.
      expect(isNodeRoutingExcludedCommand(command)).toBe(false);
    },
  );

  test("a workspace keeps its terminals, agent chat, previews and reads", () => {
    for (const command of [
      "start_local_terminal_session",
      "local_terminal_write",
      "local_terminal_resize",
      "close_local_terminal_session",
      "start_terminal_session",
      "terminal_write",
      "terminal_resize",
      "dispatch_native_agent_prompt",
      "resolve_native_agent_interaction",
      "create_preview_attachment",
      "get_config",
      "get_host_maintenance",
      "get_projects",
      "approve_environment_setup",
      "get_ticket_sync_status",
    ]) {
      expect(registry.has(command)).toBe(true);
      expect(admits(command)).toBe(true);
    }
  });
});

describe("isGlobalConfigEcho", () => {
  const current = {
    global: {
      terminalHistoryEnabled: true,
      allowedDomains: ["github.com"],
      favoriteModels: [{ platform: "claude", modelId: "leaf-model" }],
      githubTokenConfigured: true,
      anthropicApiKeySource: "none",
    },
    repositories: {},
  };

  test("only the two settings writes are checked", () => {
    expect(isGlobalConfigWriteCommand("update_global_config")).toBe(true);
    expect(isGlobalConfigWriteCommand("patch_global_config")).toBe(true);
  });

  test("an older realm's favourite save sends the leaf's settings back unchanged", () => {
    expect(
      isGlobalConfigEcho(
        "update_global_config",
        {
          global: {
            // Key order differs; inherited settings come from the command node.
            allowedDomains: ["github.com"],
            terminalHistoryEnabled: true,
            favoriteModels: [{ platform: "claude", modelId: "command-node-model" }],
            agentSettings: { defaultAgent: "codex" },
            // Derived credential fields the renderer echoes are ignored.
            githubTokenConfigured: false,
            cursorApiKeyConfigured: true,
          },
          preserveInheritedSettings: true,
        },
        current,
      ),
    ).toBe(true);
  });

  test("a write that changes, adds or removes a machine setting is not an echo", () => {
    const base = { ...current.global };
    for (const global of [
      { ...base, allowedDomains: ["github.com", "example.com"] },
      { ...base, defaultNetworkMode: "full" },
      { favoriteModels: base.favoriteModels, terminalHistoryEnabled: true },
    ]) {
      expect(
        isGlobalConfigEcho(
          "update_global_config",
          { global, preserveInheritedSettings: true },
          current,
        ),
      ).toBe(false);
    }
  });

  test("the retired Codex raw event logging key says nothing about a change", () => {
    const retired = "experimentalCodexRawEventLogging";
    // An older client's form sends it whatever this machine stores.
    expect(
      isGlobalConfigEcho(
        "update_global_config",
        { global: { ...current.global, [retired]: true } },
        current,
      ),
    ).toBe(true);
    // A machine that stored it, saved by a client that no longer sends it.
    expect(
      isGlobalConfigEcho(
        "update_global_config",
        { global: { ...current.global } },
        { ...current, global: { ...current.global, [retired]: true } },
      ),
    ).toBe(true);
    expect(
      isGlobalConfigEcho("patch_global_config", { patch: { [retired]: false } }, current),
    ).toBe(true);
    // It does not excuse a real change sent beside it.
    expect(
      isGlobalConfigEcho(
        "update_global_config",
        { global: { ...current.global, [retired]: true, allowedDomains: [] } },
        current,
      ),
    ).toBe(false);
    expect(
      isGlobalConfigEcho(
        "patch_global_config",
        { patch: { [retired]: false, allowedDomains: [] } },
        current,
      ),
    ).toBe(false);
  });

  test("without preserveInheritedSettings, inherited settings count too", () => {
    const global = { ...current.global, favoriteModels: [] };
    expect(isGlobalConfigEcho("update_global_config", { global }, current)).toBe(false);
    expect(
      isGlobalConfigEcho("update_global_config", { global: { ...current.global } }, current),
    ).toBe(true);
  });

  test("a patch is an echo only when every key already has its value", () => {
    expect(isGlobalConfigEcho("patch_global_config", { patch: {} }, current)).toBe(true);
    expect(
      isGlobalConfigEcho(
        "patch_global_config",
        { patch: { allowedDomains: ["github.com"], githubToken: "ignored" } },
        current,
      ),
    ).toBe(true);
    expect(
      isGlobalConfigEcho("patch_global_config", { patch: { allowedDomains: [] } }, current),
    ).toBe(false);
    expect(
      isGlobalConfigEcho(
        "patch_global_config",
        { patch: {}, unset: ["terminalHistoryEnabled"] },
        current,
      ),
    ).toBe(false);
    expect(
      isGlobalConfigEcho("patch_global_config", { patch: {}, unset: ["notSet"] }, current),
    ).toBe(true);
  });

  test("malformed input is never an echo", () => {
    for (const args of [null, [], { global: "x" }, { global: [] }]) {
      expect(isGlobalConfigEcho("update_global_config", args, current)).toBe(false);
    }
    expect(isGlobalConfigEcho("patch_global_config", { patch: [] }, current)).toBe(false);
    expect(isGlobalConfigEcho("patch_global_config", { unset: "x" }, current)).toBe(false);
    expect(isGlobalConfigEcho("update_global_config", { global: {} }, null)).toBe(false);
  });
});
