/**
 * The `projects` and `config` domains (plan item 7005): their definitions
 * classify reads as the routing classifier does and mark exactly the settings
 * writes `admin`; the settings records keep every key through a tolerant
 * decode (a whole-object save must never delete a setting a newer node sent);
 * and both clients send typed, enveloped calls to a node with the domain
 * while a pre-contract node gets today's untyped calls and capability read.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { isNodeReadCommand } from "../../command-nodes.js";
import { NO_CLIENT_STATE_CAPABILITIES } from "../../client-state.js";
import type { NegotiatedDomains } from "../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../client.js";
import { DOMAIN_CLIENTS } from "../client-adapters.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../command.js";
import {
  AppConfigSchema,
  CONFIG_CLIENT_STATE_CAPABILITIES,
  CONFIG_COMMANDS,
  configClient,
  configDomain,
  getConfigCommand,
  patchGlobalConfigCommand,
  RepositoryConfigSchema,
} from "./config/index.js";
import {
  addProjectCommand,
  getProjectsCommand,
  PROJECTS_COMMANDS,
  ProjectSchema,
  projectsClient,
  projectsDomain,
  updateProjectCommand,
} from "./projects/index.js";

/** The machine's settings writes a workspace grant never runs (plan items 7005, 7012). */
const CONFIG_ADMIN = new Set([
  "update_global_config",
  "patch_global_config",
  "update_notification_sound_settings",
  "save_desktop_connections",
  "set_github_token",
  "set_cursor_api_key",
  "set_anthropic_api_key",
  "set_opencode_zen_api_key",
]);

const PROJECTS_INTERNAL = new Set(["request_coordinator_agents_md_update"]);

const PROJECT = {
  id: "p1",
  name: "Alpha",
  gitUrl: "https://github.com/acme/alpha.git",
  localPath: "/work/alpha",
  addedAt: "2026-11-07T00:00:00.000Z",
  order: 0,
};

const CONFIG = {
  version: "1.0.0",
  global: {
    containerResources: { cpuCores: 2, memoryGb: 4 },
    envFilePatterns: [".env"],
    allowedDomains: ["github.com"],
    codexMaxConcurrentThreads: 4,
    terminalAppearance: { fontFamily: "Menlo", fontSize: 13, backgroundColor: "#000" },
    terminalScrollback: 10_000,
    githubTokenConfigured: false,
    anthropicApiKeyConfigured: true,
    anthropicApiKeySource: "config" as const,
    cursorApiKeyConfigured: false,
    cursorApiKeySource: "none" as const,
    openCodeZenApiKeyConfigured: false,
    openCodeZenApiKeySource: "none" as const,
    agentSettings: { defaultAgent: "codex" as const, futureTierField: { x: 1 } },
    // A setting a newer node added: it must survive the client's decode.
    futureSetting: { enabled: true },
  },
  repositories: {
    p1: { defaultBranch: "main", prBaseBranch: "main", futureRepoSetting: 3 },
  },
  futureTopLevel: "kept",
};

describe("projects and config definitions", () => {
  it("defines both domains at version 2 (min 1) with every command once", () => {
    expect(projectsDomain).toMatchObject({ name: "projects", version: 2, min: 1 });
    expect(configDomain).toMatchObject({ name: "config", version: 2, min: 1 });
    expect(PROJECTS_COMMANDS).toHaveLength(26);
    expect(CONFIG_COMMANDS).toHaveLength(29);
    for (const [domain, commands] of [
      [projectsDomain, PROJECTS_COMMANDS],
      [configDomain, CONFIG_COMMANDS],
    ] as const) {
      const names = commands.map((def) => def.name);
      expect(new Set(names).size).toBe(names.length);
      for (const def of commands) {
        expect(def.domain).toBe(domain);
        expect(def.since).toBe(1);
      }
    }
  });

  it("classifies reads with the routing classifier and access as today's deny-lists", () => {
    for (const def of [...PROJECTS_COMMANDS, ...CONFIG_COMMANDS] as readonly AnyCommandDef[]) {
      expect({ name: def.name, read: def.read }).toEqual({
        name: def.name,
        read: isNodeReadCommand(def.name),
      });
      const access = CONFIG_ADMIN.has(def.name)
        ? "admin"
        : PROJECTS_INTERNAL.has(def.name)
          ? "internal"
          : "workspace";
      expect({ name: def.name, access: def.access }).toEqual({ name: def.name, access });
    }
  });

  it("exports every schema as JSON Schema", () => {
    for (const def of [...PROJECTS_COMMANDS, ...CONFIG_COMMANDS] as readonly AnyCommandDef[]) {
      expect(() => Schema.toJsonSchemaDocument(def.args)).not.toThrow();
      expect(() => Schema.toJsonSchemaDocument(def.result)).not.toThrow();
    }
  });

  it("drops unknown argument keys and refuses an unknown critical one", () => {
    const decoded = decodeCommandArgs(updateProjectCommand, {
      projectId: "p1",
      updates: { name: "Beta" },
      future: true,
    });
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") {
      expect(decoded.success).toEqual({ projectId: "p1", updates: { name: "Beta" } });
    }
    const refused = decodeCommandArgs(
      updateProjectCommand,
      { projectId: "p1", future: true },
      { critical: ["future"] },
    );
    expect(refused._tag).toBe("Failure");
    expect(addProjectCommand.critical).toEqual(["cloneOnly"]);
    expect(patchGlobalConfigCommand.critical).toEqual(["unset"]);
  });

  it("decodes a project exactly and refuses a malformed one", () => {
    expect(Schema.decodeUnknownSync(ProjectSchema)({ ...PROJECT, folder: null })).toEqual({
      ...PROJECT,
      folder: null,
    });
    expect(Schema.decodeUnknownResult(ProjectSchema)({ ...PROJECT, order: "1" })._tag).toBe(
      "Failure",
    );
    const read = decodeCommandResult(getProjectsCommand, [{ ...PROJECT, defaultBranch: "main" }]);
    expect(read._tag).toBe("Success");
    const conditional = decodeCommandResult(getProjectsCommand, {
      status: "changed",
      generation: "g",
      revision: "r",
      snapshot: [PROJECT],
    });
    expect(conditional._tag).toBe("Success");
  });

  it("keeps every settings key through a tolerant decode, and checks the declared ones", () => {
    const decoded = decodeCommandResult(getConfigCommand, CONFIG);
    expect(decoded._tag).toBe("Success");
    if (decoded._tag === "Success") expect(decoded.success).toEqual(CONFIG);
    expect(
      Schema.decodeUnknownResult(AppConfigSchema)({
        ...CONFIG,
        global: { ...CONFIG.global, terminalScrollback: "many" },
      })._tag,
    ).toBe("Failure");
    expect(Schema.decodeUnknownResult(RepositoryConfigSchema)({ defaultBranch: "main" })._tag).toBe(
      "Failure",
    );
  });

  it("lists both clients in DOMAIN_CLIENTS with adapters 2, 1 and 0", () => {
    expect(DOMAIN_CLIENTS).toContain(projectsClient);
    expect(DOMAIN_CLIENTS).toContain(configClient);
    expect(projectsClient.versions).toEqual([2, 1, 0]);
    expect(configClient.versions).toEqual([2, 1, 0]);
  });
});

interface Sent {
  command: string;
  args: unknown;
  envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(
  domains: NegotiatedDomains | undefined,
  answer: (command: string) => unknown = () => ({}),
) {
  const sent: Sent[] = [];
  const invoked: Array<{ command: string; args: unknown }> = [];
  const usage: Array<[string, number]> = [];
  const options = {
    call: async (def: AnyCommandDef, args: unknown, envelope?: ContractEnvelopeFields) => {
      sent.push({ command: def.name, args, envelope });
      return answer(def.name);
    },
    invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
      invoked.push({ command, args });
      return answer(command);
    },
    domains,
    usage: (domain: string, version: number) => usage.push([domain, version]),
  };
  return { sent, invoked, usage, options };
}

const CURRENT = { projects: { min: 1, max: 2 }, config: { min: 1, max: 2 } };

describe("projects client", () => {
  it("version 2: typed calls carry the envelope and the critical keys sent, results decode", async () => {
    const node = fakeNode(CURRENT, (command) =>
      command === "add_project" ? { ...PROJECT, extra: "dropped" } : [PROJECT],
    );
    const client = createDomainClient(projectsClient, node.options);
    expect(client.version()).toBe(2);
    const api = client.api();
    await expect(
      api.add_project({ gitUrl: PROJECT.gitUrl, localPath: "/work/alpha", cloneOnly: true }),
    ).resolves.toEqual(PROJECT);
    expect(node.sent[0]).toEqual({
      command: "add_project",
      args: { gitUrl: PROJECT.gitUrl, localPath: "/work/alpha", cloneOnly: true },
      envelope: { domain: "projects", version: 2, critical: ["cloneOnly"] },
    });
    await expect(api.get_projects({})).resolves.toEqual([PROJECT]);
    expect(node.sent[1]!.envelope).toEqual({ domain: "projects", version: 2 });
    expect(node.invoked).toEqual([]);
    expect(node.usage).toEqual([]);
  });

  it("version 2: a result that does not match its schema is refused", async () => {
    const node = fakeNode(CURRENT, () => ({ ...PROJECT, order: "first" }));
    const api = createDomainClient(projectsClient, node.options).api();
    await expect(api.get_project({ projectId: "p1" })).rejects.toThrow(
      "Invalid result from get_project",
    );
  });

  it("version 0: today's untyped call, no envelope, the answer as sent, counted", async () => {
    const older = [{ id: "p1", legacy: true }];
    const node = fakeNode(undefined, () => older);
    const client = createDomainClient(projectsClient, node.options);
    expect(client.version()).toBe(0);
    await expect(client.api().get_projects({})).resolves.toBe(older as never);
    expect(node.invoked).toEqual([{ command: "get_projects", args: {} }]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([["projects", 0]]);
  });
});

describe("config client", () => {
  it("version 2: settings keep every key, and the capability command is folded in", async () => {
    const node = fakeNode(CURRENT, () => CONFIG);
    const api = createDomainClient(configClient, node.options).api();
    await expect(api.get_config({})).resolves.toEqual(CONFIG);
    await expect(
      api.patch_global_config({ patch: { autoSteer: true }, unset: ["x"] }),
    ).resolves.toEqual(CONFIG);
    expect(node.sent[1]!.envelope).toEqual({ domain: "config", version: 2, critical: ["unset"] });
    await expect(api.clientStateCapabilities()).resolves.toEqual(CONFIG_CLIENT_STATE_CAPABILITIES);
    expect(node.sent.map((sent) => sent.command)).toEqual(["get_config", "patch_global_config"]);
    expect(node.invoked).toEqual([]);
  });

  it("version 0: today's calls, and the capability command asked and parsed each time", async () => {
    const node = fakeNode(undefined, (command) =>
      command === "get_client_state_capabilities"
        ? { coordinatorPaneLayouts: true, noticeDismissals: "yes" }
        : { older: true },
    );
    const api = createDomainClient(configClient, node.options).api();
    await expect(api.get_config({})).resolves.toEqual({ older: true } as never);
    await expect(api.clientStateCapabilities()).resolves.toEqual({
      ...NO_CLIENT_STATE_CAPABILITIES,
      coordinatorPaneLayouts: true,
    });
    await api.clientStateCapabilities();
    expect(node.invoked).toEqual([
      { command: "get_config", args: {} },
      { command: "get_client_state_capabilities", args: undefined },
      { command: "get_client_state_capabilities", args: undefined },
    ]);
    expect(node.sent).toEqual([]);
    expect(node.usage).toEqual([
      ["config", 0],
      ["config", 0],
      ["config", 0],
    ]);
  });
});
