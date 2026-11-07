/**
 * The `projects` and `config` definitions against the backend's own
 * classifiers (plan item 7005): a workspace grant runs exactly the commands
 * defined as `workspace` (the protocol test pins which are `admin`);
 * the real registry registers every one of them with its definition; and a
 * converted strict handler drops an unknown key instead of refusing it.
 */
import { describe, expect, test } from "bun:test";
import { CONFIG_COMMANDS } from "@orkestrator/protocol/contract/domains/config";
import { PROJECTS_COMMANDS } from "@orkestrator/protocol/contract/domains/projects";
import type { AnyCommandDef } from "@orkestrator/protocol/contract/command";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { CONTRACT_DOMAIN_MAP, type ContractDomainMap } from "./contract-domain-map.js";
import { grantAdmits } from "./nodes/workspace-grant-test-support.js";

const DEFINITIONS: readonly AnyCommandDef[] = [...PROJECTS_COMMANDS, ...CONFIG_COMMANDS];

describe("projects and config definitions", () => {
  test("a workspace grant runs exactly the commands defined as workspace", () => {
    for (const def of DEFINITIONS) {
      expect({ name: def.name, admitted: grantAdmits(def.name) }).toEqual({
        name: def.name,
        admitted: def.access === "workspace",
      });
    }
  });

  test("the real registry registers every command with its definition, and none is mapped", () => {
    const registry = createCommandRegistry();
    for (const def of DEFINITIONS) {
      expect(registry.contracts.get(def.name)).toBe(def);
    }
    const map: ContractDomainMap = CONTRACT_DOMAIN_MAP;
    expect(map.projects).toBeUndefined();
    expect(map.config).toBeUndefined();
  });

  test("a formerly strict handler drops an unknown key", async () => {
    const registry = createCommandRegistry();
    const context = {
      storage: {
        setGitHubCliReminderDismissed: async (dismissed: boolean) => ({
          version: "1",
          repositories: {},
          global: {
            containerResources: { cpuCores: 2, memoryGb: 4 },
            envFilePatterns: [],
            allowedDomains: [],
            codexMaxConcurrentThreads: 4,
            terminalAppearance: { fontFamily: "Menlo", fontSize: 13, backgroundColor: "#000" },
            terminalScrollback: 1000,
            githubCliReminderDismissed: dismissed,
          },
        }),
      },
    } as unknown as CommandContext;
    const saved = (await registry.get("set_github_cli_reminder_dismissed")!(
      { dismissed: true, future: "ignored" },
      context,
    )) as { global: Record<string, unknown> };
    expect(saved.global.githubCliReminderDismissed).toBe(true);
    expect(saved.global.githubTokenConfigured).toBe(false);
    await expect(
      Promise.resolve().then(() =>
        registry.get("set_github_cli_reminder_dismissed")!({ dismissed: "yes" }, context),
      ),
    ).rejects.toThrow("Expected dismissed to be a boolean");
  });
});
