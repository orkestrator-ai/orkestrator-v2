import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "../commands.js";
import { isNodeRoutingExcludedCommand } from "./node-routing.js";
import { LEGACY_ONLY_ADMITTED, legacyWorkspaceAdmitted } from "./workspace-grant-legacy-check.js";
import {
  admitsWorkspaceCommand,
  isGlobalConfigEcho,
  isGlobalConfigWriteCommand,
  workspaceAllowList,
} from "./workspace-grant-scope.js";

/** The machine's administration, refused to workspace clients since security report I1. */
const MACHINE_ADMINISTRATION = [
  "public_action",
  "save_config",
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
  const isRegistered = (command: string) => registry.has(command);
  const admits = (command: string, path: "grant" | "relay" = "grant") =>
    admitsWorkspaceCommand(command, path, { accessOf, isRegistered });

  test("every registered command is defined, so every one has an access", () => {
    for (const command of registry.keys()) {
      expect({ command, defined: registry.contracts.has(command) }).toEqual({
        command,
        defined: true,
      });
    }
  });

  test("admits every workspace command and refuses every admin and internal one, on both paths", () => {
    const allowList = workspaceAllowList(registry.contracts);
    let workspace = 0;
    for (const [command, def] of registry.contracts) {
      if (def.access === "workspace") workspace += 1;
      for (const path of ["grant", "relay"] as const) {
        expect({ command, path, admitted: admits(command, path) }).toEqual({
          command,
          path,
          admitted: def.access === "workspace",
        });
      }
      expect(allowList.has(command)).toBe(def.access === "workspace");
    }
    expect(allowList.size).toBe(workspace);
    expect(workspace).toBeGreaterThan(0);
  });

  test("refuses an unregistered command and a name that is not one", () => {
    for (const command of ["no_such_command", "get_config ", "", "__proto__", "constructor"]) {
      expect(admits(command, "grant")).toBe(false);
      expect(admits(command, "relay")).toBe(false);
    }
  });

  test("fails closed without the registry's access", () => {
    expect(admitsWorkspaceCommand("get_config", "grant", {})).toBe(false);
    expect(admitsWorkspaceCommand("get_config", "relay", { isRegistered })).toBe(false);
    expect(admitsWorkspaceCommand("get_config", "grant", { accessOf })).toBe(true);
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
      "attach_terminal",
      "terminal_write",
      "terminal_resize",
      "dispatch_native_agent_prompt",
      "resolve_native_agent_interaction",
      "create_preview_attachment",
      "get_config",
      "get_global_config",
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

describe("the debug cross-check against the old deny-lists", () => {
  const registry = createCommandRegistry();

  test("names only registered commands the allow-list refuses", () => {
    for (const command of LEGACY_ONLY_ADMITTED) {
      expect({ command, registered: registry.has(command) }).toEqual({ command, registered: true });
      expect({ command, access: registry.contracts.get(command)?.access }).not.toEqual({
        command,
        access: "workspace",
      });
    }
  });

  test("the old verdict: the allow-list's, plus those names and every unknown name", () => {
    expect(legacyWorkspaceAdmitted("get_config", true, true)).toBe(true);
    expect(legacyWorkspaceAdmitted("update_global_config", false, true)).toBe(false);
    expect(legacyWorkspaceAdmitted("get_compatibility_path_usage", false, true)).toBe(true);
    expect(legacyWorkspaceAdmitted("no_such_command", false, false)).toBe(true);
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
    expect(isGlobalConfigWriteCommand("save_config")).toBe(false);
    expect(isGlobalConfigEcho("save_config", { config: current }, current)).toBe(false);
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
