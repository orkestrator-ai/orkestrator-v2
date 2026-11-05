import { describe, expect, test } from "bun:test";

import { createCommandRegistry } from "../commands.js";
import { isNodeExcludedCommand, isWorkspaceExcludedCommand } from "./node-routing.js";
import {
  isGlobalConfigEcho,
  isGlobalConfigWriteCommand,
  WORKSPACE_ADMINISTRATION_COMMANDS,
} from "./workspace-grant-scope.js";

describe("workspace administration commands", () => {
  const registry = createCommandRegistry();

  test.each([...WORKSPACE_ADMINISTRATION_COMMANDS])(
    "%s is registered, refused to a workspace client and still routed to a node",
    (command) => {
      expect(registry.has(command)).toBe(true);
      expect(isWorkspaceExcludedCommand(command)).toBe(true);
      // Settings reaches another machine's settings over the node link.
      expect(isNodeExcludedCommand(command)).toBe(false);
    },
  );

  test("global settings and host updates are refused (security report I1)", () => {
    for (const command of [
      "update_global_config",
      "patch_global_config",
      "save_config",
      "request_host_update",
      "cancel_host_update",
      "set_host_update_channel",
    ]) {
      expect(isWorkspaceExcludedCommand(command)).toBe(true);
    }
  });

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
    ]) {
      expect(registry.has(command)).toBe(true);
      expect(isWorkspaceExcludedCommand(command)).toBe(false);
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
