import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
  coordinatorRuntimeId,
} from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_RESEARCH_MCP_ENV,
  COORDINATOR_WEB_RESEARCH_ENV,
} from "@orkestrator/protocol/coordinator-web-research";
import { PromptRejectedError } from "../agent-provider-contract.js";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";
import {
  OPENCODE2_COORDINATOR_GUARD_PLUGIN_ID,
  OPENCODE2_EXECUTION_POLICY_ENV,
} from "./coordinator-plugin.js";
import {
  MAX_OPENCODE2_COORDINATOR_RESEARCH_TOOLS,
  newOpenCodeCoordinatorSessionProtocol,
  openCode2CoordinatorConfigDir,
  openCode2CoordinatorLaunchEnv,
  openCode2CoordinatorPolicy,
  openCode2CoordinatorRules,
  openCode2CoordinatorSignature,
  writeOpenCode2CoordinatorConfig,
  type OpenCode2CoordinatorAuthority,
} from "./coordinator.js";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";
import { OPENCODE2_CREDENTIAL_PLUGIN_ID } from "./server.js";
import type { OpenCode2PermissionRule } from "./types.js";

const RUNTIME = coordinatorRuntimeId("c1", "conv-1");
const OWNER = { kind: "coordinator" as const, projectId: "p1", coordinatorId: "c1" };

function effect(rules: readonly OpenCode2PermissionRule[], action: string) {
  return rules.findLast((rule) => rule.action === action || rule.action === "*")?.effect;
}

describe("which coordinator sessions take OpenCode 2", () => {
  const trusted = {
    agent: "opencode",
    environmentId: RUNTIME,
    origin: "coordinator" as const,
    owner: OWNER,
    executionPolicy: "coordinator-read-only",
    policy: openCode2CoordinatorPolicy("off"),
  };

  test("a trusted coordinator session takes 2.x only under the preview switch with a 2.x host", () => {
    expect(newOpenCodeCoordinatorSessionProtocol(trusted, "v2", true)).toBe("v2");
    expect(newOpenCodeCoordinatorSessionProtocol(trusted, "legacy", true)).toBeUndefined();
    expect(newOpenCodeCoordinatorSessionProtocol(trusted, undefined, true)).toBeUndefined();
    expect(newOpenCodeCoordinatorSessionProtocol(trusted, "v2", false)).toBeUndefined();
  });

  test("anything but the exact trusted shape stays on 1.x", () => {
    const cases = [
      { ...trusted, agent: "claude" },
      { ...trusted, environmentId: "env-1" },
      { ...trusted, origin: "interactive-native" as const },
      { ...trusted, owner: { kind: "environment" as const, projectId: "p1", environmentId: "e" } },
      { ...trusted, owner: { ...OWNER, coordinatorId: "another" } },
      { ...trusted, executionPolicy: undefined },
      {
        ...trusted,
        policy: resolveNativeAgentExecutionPolicy(
          { environmentType: "local", networkAccessMode: "full" },
          "interactive-native",
        ),
      },
    ];
    for (const input of cases) {
      expect(newOpenCodeCoordinatorSessionProtocol(input as never, "v2", true)).toBeUndefined();
    }
  });
});

describe("a coordinator's 2.x rules", () => {
  test("deny everything, then allow reading, the control tools and research by exact id", () => {
    const rules = openCode2CoordinatorRules(openCode2CoordinatorPolicy("search-and-mcp"), [
      "context7_resolve",
    ]);
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    for (const tool of ["read", "glob", "grep", "skill", "subagent"]) {
      expect(effect(rules, tool)).toBe("allow");
    }
    expect(effect(rules, "orkestrator_launch_environment")).toBe("allow");
    expect(effect(rules, "context7_resolve")).toBe("allow");
    expect(effect(rules, "websearch")).toBe("allow");
    for (const tool of [
      "edit",
      "shell",
      "webfetch",
      "question",
      "opencode_worktree",
      "project_x",
    ]) {
      expect(effect(rules, tool)).toBe("deny");
    }
    // 1.x ids are renamed: nothing is left under `bash`, `write` or `task`.
    expect(rules.some((rule) => ["bash", "write", "patch", "task"].includes(rule.action))).toBe(
      false,
    );
  });

  test("keep search off when research is off, and bound the research tools", () => {
    const off = openCode2CoordinatorRules(openCode2CoordinatorPolicy("off"), []);
    expect(effect(off, "websearch")).toBe("deny");
    const many = Array.from({ length: 1_000 }, (_, index) => `lookup_tool_${index}`);
    const capped = openCode2CoordinatorRules(openCode2CoordinatorPolicy("search-and-mcp"), many);
    expect(capped.filter((rule) => rule.action.startsWith("lookup_tool_"))).toHaveLength(
      MAX_OPENCODE2_COORDINATOR_RESEARCH_TOOLS,
    );
  });

  test("refuse any other policy", () => {
    const wider = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "full" },
      "interactive-native",
    );
    expect(() => openCode2CoordinatorRules(wider, [])).toThrow(PromptRejectedError);
  });
});

describe("a coordinator's 2.x launch", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  test("names the read-only policy, the data directory, research and no project configuration", () => {
    const research = {
      mode: "search-and-mcp" as const,
      servers: [{ name: "context7", url: "https://mcp.example.test/mcp" }],
    };
    const env = openCode2CoordinatorLaunchEnv({
      dataDir: "/data",
      attachmentRoot: "/data/attachments/c1/conv-1",
      research,
    });
    expect(env[OPENCODE2_EXECUTION_POLICY_ENV]).toBe("coordinator-read-only");
    expect(env[COORDINATOR_PROTECTED_DATA_DIR_ENV]).toBe("/data");
    expect(env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT).toBe("/data/attachments/c1/conv-1");
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    expect(env[COORDINATOR_WEB_RESEARCH_ENV]).toBe("search-and-mcp");
    expect(JSON.parse(env[COORDINATOR_RESEARCH_MCP_ENV]!)).toEqual(research.servers);
    expect(openCode2CoordinatorSignature(research)).not.toBe(
      openCode2CoordinatorSignature({ mode: "off", servers: [] }),
    );
  });

  test("writes its own configuration directory with the credential plugin and the guard", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ork-opencode2-coordinator-config-"));
    const dir = await writeOpenCode2CoordinatorConfig(root, {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "xdg"),
    });
    expect(dir).toBe(openCode2CoordinatorConfigDir(root));
    expect(dir).not.toBe(path.join(root, "opencode2", "config"));
    for (const id of [OPENCODE2_CREDENTIAL_PLUGIN_ID, OPENCODE2_COORDINATOR_GUARD_PLUGIN_ID]) {
      const source = await readFile(path.join(dir, "plugins", id, "index.ts"), "utf8");
      expect(source).toContain(JSON.stringify(id));
    }
  });

  test("mirrors the user's global configuration without their plugins", async () => {
    root = await mkdtemp(path.join(tmpdir(), "ork-opencode2-coordinator-config-"));
    const userDir = path.join(root, "xdg", "opencode");
    await mkdir(userDir, { recursive: true });
    await writeFile(
      path.join(userDir, "opencode.json"),
      JSON.stringify({ model: "custom/model-a", plugin: ["some-npm-plugin"] }),
    );
    const dir = await writeOpenCode2CoordinatorConfig(root, {
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, "xdg"),
    });
    const mirrored = await readFile(path.join(dir, "opencode.jsonc"), "utf8");
    expect(mirrored).toContain("custom/model-a");
    expect(mirrored).not.toContain("some-npm-plugin");
    // The guard is still the plugin that loads.
    await readFile(
      path.join(dir, "plugins", OPENCODE2_COORDINATOR_GUARD_PLUGIN_ID, "index.ts"),
      "utf8",
    );
  });
});

describe("the 2.x provider on a coordinator's server", () => {
  let server: FakeOpenCode2Server | undefined;
  let provider: OpenCode2Provider | undefined;
  afterEach(async () => {
    await provider?.dispose();
    server?.stop();
    provider = undefined;
    server = undefined;
  });

  function setup(control: { url: string; token: string } | undefined = undefined) {
    server = new FakeOpenCode2Server();
    const research = { mode: "off" as const, servers: [] };
    const authority: OpenCode2CoordinatorAuthority = {
      policy: openCode2CoordinatorPolicy("off"),
      research,
      signature: openCode2CoordinatorSignature(research),
      controlConnection: () => control,
    };
    provider = new OpenCode2Provider(server.client(), {
      monitorEvents: false,
      coordinator: authority,
      mcp: { connectTimeoutMs: 50, sleep: () => Bun.sleep(1) },
    });
    return { server, provider };
  }

  const rulesOf = (id: string) =>
    (server!.sessions.get(id)!.rules ?? []) as OpenCode2PermissionRule[];

  test("creates a session under the launch's rules as plan, whatever policy the request names", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("coordinator", "Coordinator", {
      policy: openCode2CoordinatorPolicy("search-and-mcp"),
      reviewerSession: true,
    });
    expect(server.sessions.get(id)!.agent).toBe("plan");
    const rules = rulesOf(id);
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    // The launch says research is off, so the request's search exception does not apply.
    expect(effect(rules, "websearch")).toBe("deny");
    const marker = server.sessions.get(id)!.metadata?.orkestrator as Record<string, unknown>;
    expect(marker.reviewer).toBeUndefined();

    const wider = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "full" },
      "interactive-native",
    );
    await expect(provider.createSession("x", "y", { policy: wider })).rejects.toThrow(
      "read-only policy",
    );
  });

  test("every turn restates the launch's rules and the plan agent over a widened record", async () => {
    const control = { url: "http://127.0.0.1:9/mcp", token: "coordinator-token" };
    const { server, provider } = setup(control);
    const id = await provider.createSession("coordinator", "Coordinator", {});
    const expected = rulesOf(id).slice(0, -2);
    // Widened behind the backend's back: stored rules, stored base and agent.
    const session = server.sessions.get(id)!;
    session.rules = [{ action: "*", resource: "*", effect: "allow" }];
    session.metadata = {
      orkestrator: { base: [{ action: "*", resource: "*", effect: "allow" }] },
    };
    session.agent = "build";

    await provider.send(id, "hello", { requestId: "r1", mode: "build" as never });
    const rules = rulesOf(id);
    expect(rules.slice(0, expected.length)).toEqual(expected);
    expect(effect(rules, "shell")).toBe("deny");
    expect(session.agent).toBe("plan");
    // The conversation's control credential is the location's `orkestrator` server.
    expect(server.mcp.get("orkestrator")?.config).toMatchObject({
      url: control.url,
      headers: { Authorization: "Bearer coordinator-token" },
    });
  });

  test("refuses a command selection, lists no commands, and runs typed slash text as text", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("coordinator", "Coordinator", {});
    await expect(
      provider.send(id, "/review", {
        requestId: "r1",
        command: { id: "review", name: "review", executionKind: "provider-command" } as never,
      }),
    ).rejects.toThrow(PromptRejectedError);
    expect(await provider.commandCatalogue()).toEqual({
      enhanced: true,
      commands: [],
      status: "unsupported",
    });
    expect(await provider.refreshCommands()).toEqual({ outcome: "unsupported" });
    await provider.send(id, "/review", { requestId: "r2", allowProviderCommands: true });
    expect(server.calls.some((call) => call.path.endsWith("/command"))).toBe(false);
  });

  test("synchronizes the coordinator policy by restating, and refuses any other", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("coordinator", "Coordinator", {});
    const steady = rulesOf(id);
    server.sessions.get(id)!.rules = [{ action: "*", resource: "*", effect: "allow" }];
    await provider.synchronizeSessionPolicy(id, openCode2CoordinatorPolicy("search"));
    expect(effect(rulesOf(id), "edit")).toBe("deny");
    expect(rulesOf(id).length).toBeGreaterThanOrEqual(steady.length);
    const wider = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "full" },
      "interactive-native",
    );
    await expect(provider.synchronizeSessionPolicy(id, wider)).rejects.toThrow("read-only policy");
  });

  test("a resume restates the launch's rules", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("coordinator", "Coordinator", {});
    server.sessions.get(id)!.rules = [{ action: "*", resource: "*", effect: "allow" }];
    await provider.resumeSession(id);
    expect(effect(rulesOf(id), "shell")).toBe("deny");
  });

  test("a widened write that does not persist refuses the turn", async () => {
    const { server, provider } = setup();
    const id = await provider.createSession("coordinator", "Coordinator", {});
    server.sessions.get(id)!.rules = [{ action: "*", resource: "*", effect: "allow" }];
    server.dropNextSessionUpdate = true;
    await expect(provider.send(id, "hello", { requestId: "r1" })).rejects.toThrow(
      "permissions are unavailable",
    );
    expect(server.calls.some((call) => call.path.endsWith("/prompt"))).toBe(false);
  });
});

describe("an ordinary 2.x server's policy synchronization", () => {
  let server: FakeOpenCode2Server | undefined;
  let provider: OpenCode2Provider | undefined;
  afterEach(async () => {
    await provider?.dispose();
    server?.stop();
  });

  test("rewrites the stored base and the session's steady rules", async () => {
    server = new FakeOpenCode2Server();
    provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
    const id = await provider.createSession("build", "tab", {});
    const policy = resolveNativeAgentExecutionPolicy(
      { environmentType: "local", networkAccessMode: "full" },
      "build-pipeline",
    );
    await provider.synchronizeSessionPolicy(id, { ...policy, approvals: "deny" });
    const session = server.sessions.get(id)!;
    const rules = (session.rules ?? []) as OpenCode2PermissionRule[];
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    const marker = session.metadata?.orkestrator as { base?: unknown[] };
    expect(marker.base?.[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
  });
});
