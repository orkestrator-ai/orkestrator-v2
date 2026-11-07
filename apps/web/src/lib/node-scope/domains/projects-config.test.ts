/**
 * The `projects` and `config` domains over a `lib/backend` client (plan item
 * 7005), and the config layering's saves through them: a node that
 * advertises a domain gets typed calls with the envelope and decoded results
 * (settings keep every key), any other node today's calls.
 */
import { describe, expect, mock, test } from "bun:test";
import type { NegotiatedDomains } from "@orkestrator/protocol/node-client";
import type { BackendClient } from "@/lib/backend/client";
import { runConfigCommand } from "@/lib/portal/command-node-config";
import { createSignal } from "@/lib/node-scope/signal";
import { config } from "./config";
import { projects } from "./projects";

function fakeClient(
  domains: NegotiatedDomains | null,
  answer: (command: string) => unknown = () => null,
): BackendClient & { invokeRaw: ReturnType<typeof mock> } {
  return {
    invokeRaw: mock(async (command: string) => answer(command)) as never,
    domains: createSignal<NegotiatedDomains | null>(domains),
    capabilities: createSignal<ReadonlySet<string> | null>(null),
  };
}

const CURRENT = { projects: { min: 1, max: 1 }, config: { min: 1, max: 1 } };

const PROJECT = {
  id: "p1",
  name: "Alpha",
  gitUrl: "https://github.com/acme/alpha.git",
  localPath: null,
  addedAt: "2026-11-07T00:00:00.000Z",
  order: 0,
};

function appConfig(global: Record<string, unknown> = {}) {
  return {
    version: "1",
    repositories: {},
    global: {
      containerResources: { cpuCores: 2, memoryGb: 4 },
      envFilePatterns: [],
      allowedDomains: [],
      codexMaxConcurrentThreads: 4,
      terminalAppearance: { fontFamily: "Menlo", fontSize: 13, backgroundColor: "#000" },
      terminalScrollback: 1000,
      githubTokenConfigured: false,
      anthropicApiKeyConfigured: false,
      anthropicApiKeySource: "none" as const,
      cursorApiKeyConfigured: false,
      cursorApiKeySource: "none" as const,
      openCodeZenApiKeyConfigured: false,
      openCodeZenApiKeySource: "none" as const,
      ...global,
    },
  };
}

describe("projects over a lib/backend client", () => {
  test("a node with the domain gets typed calls with the envelope and decoded results", async () => {
    const client = fakeClient(CURRENT, () => ({ ...PROJECT, extra: "dropped" }));
    await expect(
      projects(client)().add_project({ gitUrl: PROJECT.gitUrl, cloneOnly: true }),
    ).resolves.toEqual(PROJECT);
    expect(client.invokeRaw).toHaveBeenCalledWith(
      "add_project",
      { gitUrl: PROJECT.gitUrl, cloneOnly: true },
      { envelope: { domain: "projects", version: 1, critical: ["cloneOnly"] } },
    );
  });

  test("a pre-contract node gets today's calls, without arguments where there are none", async () => {
    const answer = [{ id: "p1", older: true }];
    const client = fakeClient(null, () => answer);
    await expect(projects(client)().get_projects({})).resolves.toBe(answer as never);
    expect(client.invokeRaw.mock.calls).toEqual([["get_projects"]] as never);
  });
});

describe("config over a lib/backend client", () => {
  test("version 1 keeps every setting and answers the client-state capabilities itself", async () => {
    const stored = appConfig({ futureSetting: { on: true } });
    const client = fakeClient(CURRENT, () => stored);
    await expect(config(client)().get_config({})).resolves.toEqual(stored);
    await config(client)().clientStateCapabilities();
    expect(client.invokeRaw.mock.calls).toEqual([
      ["get_config", {}, { envelope: { domain: "config", version: 1 } }],
    ] as never);
  });

  test("the layering's split save sends each node its part, with the critical flag declared", async () => {
    const commandNode = fakeClient(CURRENT, () => appConfig({ autoSteer: true }));
    const node = fakeClient(null, () => appConfig({ autoSteer: false }));
    await runConfigCommand({ commandNode, node }, "update_global_config", {
      global: appConfig({ autoSteer: true }).global,
    });
    const commandWrite = commandNode.invokeRaw.mock.calls.find(
      (call: unknown[]) => call[0] === "update_global_config",
    );
    expect(commandWrite?.[2]).toEqual({ envelope: { domain: "config", version: 1 } });
    // The machine is pre-contract here: today's call, `preserveInheritedSettings` and all.
    const nodeWrite = node.invokeRaw.mock.calls.find(
      (call: unknown[]) => call[0] === "update_global_config",
    );
    expect(nodeWrite?.length).toBe(2);
    const nodeArgs = nodeWrite?.[1] as { preserveInheritedSettings?: boolean } | undefined;
    expect(nodeArgs?.preserveInheritedSettings).toBe(true);
    expect(node.invokeRaw.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      "get_config",
      "update_global_config",
    ]);
  });
});
