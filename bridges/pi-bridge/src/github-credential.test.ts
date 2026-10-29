/**
 * Withholding the GitHub credential from a Pi session (graphs item 209).
 *
 * The bridge process keeps the credential; a session whose policy denies
 * `github.write` runs its shell commands through a spawn hook that strips it
 * and starts its MCP servers without it. `sdk-session.test.ts` runs the same
 * tools inside a real SDK session.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { newSessionState } from "./agent-session.js";
import {
  piWithheldGitHubCredential,
  withheldEnvironment,
  withheldShellToolDefinitions,
  withheldSpawnHook,
} from "./github-credential.js";
import {
  closePiMcp,
  mcpConnectionNeedsRefresh,
  preparePiMcp,
  publicPiMcpServers,
  setPiMcpTransportForTests,
  stdioEnvironment,
  type PiMcpConnectContext,
  type PiMcpTransport,
} from "./mcp.js";
import type { ResolvedMcpServer } from "./mcp-config.js";

const WITHHELD = { ghConfigDir: "/tmp/empty-gh" };

function policy(extendedDeny: string[] = []): NativeAgentExecutionPolicy {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals: "auto-approve",
    projectResources: false,
    networkAccess: "full",
    capabilityPolicy: {
      deny: [],
      ...(extendedDeny.length > 0 ? { extendedDeny: extendedDeny as never } : {}),
      userMcpServers: ["github", "docs"],
    },
  };
}

const GRAPH = policy(["github.write"]);
const ORDINARY = policy();

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
}

afterEach(async () => {
  setPiMcpTransportForTests();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("the withheld environment", () => {
  test("only a policy that denies github.write withholds", async () => {
    const dir = async () => "/tmp/empty-gh";
    expect(await piWithheldGitHubCredential(GRAPH, dir)).toEqual(WITHHELD);
    expect(await piWithheldGitHubCredential(ORDINARY, dir)).toBeUndefined();
    expect(await piWithheldGitHubCredential(undefined, dir)).toBeUndefined();
  });

  test("the spawn hook drops the tokens and keeps the command and directory", () => {
    const hooked = withheldSpawnHook(WITHHELD)({
      command: "gh auth status",
      cwd: "/work",
      env: { PATH: "/usr/bin", GH_TOKEN: "gho_x", GITHUB_TOKEN: "ghs_y", PI_SESSION_ID: "s1" },
    });
    expect(hooked.command).toBe("gh auth status");
    expect(hooked.cwd).toBe("/work");
    expect(hooked.env.GH_TOKEN).toBeUndefined();
    expect(hooked.env.GITHUB_TOKEN).toBeUndefined();
    expect(hooked.env.PI_SESSION_ID).toBe("s1");
    expect(hooked.env.GH_CONFIG_DIR).toBe("/tmp/empty-gh");
    expect(hooked.env.GIT_CONFIG_KEY_0).toBe("credential.helper");
    expect(hooked.env.GIT_CONFIG_VALUE_0).toBe("");
  });

  test("a real bash command run by the replacement tool sees no credential", async () => {
    setEnv({ GH_TOKEN: "gho_pi_unit_probe", GITHUB_TOKEN: "ghs_pi_unit_probe" });
    const dir = await mkdtemp(join(tmpdir(), "pi-gh-withheld-"));
    roots.push(dir);
    const [bash, powershell] = withheldShellToolDefinitions(
      dir,
      { ghConfigDir: dir },
      { commandPrefix: "export PI_PREFIX_RAN=1" },
    );
    expect(bash?.name).toBe("bash");
    expect(powershell?.name).toBe("powershell");
    // Activation follows the session's tool names, as for the built-ins.
    expect(bash?.defaultActive).toBe(false);
    expect(powershell?.defaultActive).toBe(false);
    const result = await bash!.execute(
      "call-1",
      { command: "env" } as never,
      undefined,
      undefined,
      undefined as never,
    );
    const output = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    expect(output).not.toContain("gho_pi_unit_probe");
    expect(output).not.toContain("ghs_pi_unit_probe");
    expect(output).toContain(`GH_CONFIG_DIR=${dir}`);
    expect(output).toContain("GIT_CONFIG_KEY_0=credential.helper");
    // The settings Pi's built-in bash reads are kept.
    expect(output).toContain("PI_PREFIX_RAN=1");
  });

  test("a stdio MCP server inherits the withheld environment; its own entry still wins", () => {
    setEnv({ GH_TOKEN: "gho_pi_stdio", PI_BRIDGE_TOKEN: "bridge-secret" });
    const withheld = stdioEnvironment({ EXTRA: "overlay" }, { withheldGitHubCredential: WITHHELD });
    expect(withheld.GH_TOKEN).toBeUndefined();
    expect(withheld.PI_BRIDGE_TOKEN).toBeUndefined();
    expect(withheld.GH_CONFIG_DIR).toBe("/tmp/empty-gh");
    expect(withheld.EXTRA).toBe("overlay");
    // What the user wrote into the entry is their own configuration.
    expect(
      stdioEnvironment({ GH_CONFIG_DIR: "/mine" }, { withheldGitHubCredential: WITHHELD })
        .GH_CONFIG_DIR,
    ).toBe("/mine");
    expect(stdioEnvironment().GH_TOKEN).toBe("gho_pi_stdio");
  });

  test("withheldEnvironment drops undefined values", () => {
    expect(withheldEnvironment({ A: "1", B: undefined }, WITHHELD)).toMatchObject({ A: "1" });
    expect("B" in withheldEnvironment({ A: "1", B: undefined }, WITHHELD)).toBe(false);
  });
});

describe("MCP servers of a withheld session", () => {
  async function agentDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pi-gh-mcp-"));
    roots.push(root);
    const dir = join(root, "agent");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "github-mcp",
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" },
          },
          docs: { command: "docs-mcp" },
        },
      }),
    );
    return dir;
  }

  function recordingTransport(started: Array<[ResolvedMcpServer, PiMcpConnectContext?]>) {
    return {
      async connect(server, context) {
        started.push([server, context]);
        return {
          tools: [{ name: "search" }],
          async call() {
            return { content: [] };
          },
          async close() {},
        };
      },
    } satisfies PiMcpTransport;
  }

  test("an entry that names a credential variable is skipped, and the rest start withheld", async () => {
    const started: Array<[ResolvedMcpServer, PiMcpConnectContext?]> = [];
    setPiMcpTransportForTests(recordingTransport(started));
    const dir = await agentDir();
    const state = newSessionState(undefined, GRAPH);
    try {
      await preparePiMcp(state, { agentDir: dir, cwd: dir, env: { GITHUB_TOKEN: "ghs_ref" } });
      expect(started.map(([server]) => server.id)).toEqual(["docs"]);
      expect(started[0]?.[1]?.withheldGitHubCredential?.ghConfigDir).toBeString();
      expect(JSON.stringify(publicPiMcpServers(state))).not.toContain("ghs_ref");
    } finally {
      await closePiMcp(state);
    }
  });

  test("an ordinary session resolves the reference and starts servers as before", async () => {
    const started: Array<[ResolvedMcpServer, PiMcpConnectContext?]> = [];
    setPiMcpTransportForTests(recordingTransport(started));
    const dir = await agentDir();
    const state = newSessionState(undefined, ORDINARY);
    try {
      await preparePiMcp(state, { agentDir: dir, cwd: dir, env: { GITHUB_TOKEN: "ghs_ref" } });
      expect(started.map(([server]) => server.id).sort()).toEqual(["docs", "github"]);
      expect(started.find(([server]) => server.id === "github")?.[0].env).toEqual({
        GITHUB_PERSONAL_ACCESS_TOKEN: "ghs_ref",
      });
      for (const [, context] of started) expect(context?.withheldGitHubCredential).toBeUndefined();
    } finally {
      await closePiMcp(state);
    }
  });

  test("a policy that starts or stops withholding needs a new generation", async () => {
    setPiMcpTransportForTests(recordingTransport([]));
    const dir = await agentDir();
    const state = newSessionState(undefined, ORDINARY);
    try {
      await preparePiMcp(state, { agentDir: dir, cwd: dir, env: {} });
      expect(mcpConnectionNeedsRefresh(state)).toBe(false);
      state.policy = GRAPH;
      expect(mcpConnectionNeedsRefresh(state)).toBe(true);
      state.policy = ORDINARY;
      expect(mcpConnectionNeedsRefresh(state)).toBe(false);
    } finally {
      await closePiMcp(state);
    }
  });
});
