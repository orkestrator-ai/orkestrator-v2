import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_CONTAINER_CONFIG_KEYS,
  claudeContainerConfig,
  containerSafeMcpServer,
} from "./claude-container-config.js";

const HOME = "/home/fixture-user";

/** A host `.claude.json` with every kind of content a container must not see. */
function hostConfig(): Record<string, unknown> {
  return {
    numStartups: 42,
    userID: "SENTINEL-USER-ID",
    primaryApiKey: "SENTINEL-API-KEY",
    customApiKeyResponses: { approved: ["SENTINEL-KEY-SUFFIX"] },
    githubRepoPaths: { "acme/app": [`${HOME}/code/app`] },
    projects: {
      [`${HOME}/code/app`]: {
        allowedTools: [],
        mcpServers: { project: { command: "npx", env: { TOKEN: "SENTINEL-PROJECT" } } },
      },
    },
    cachedStatsigGates: { gate: true },
    oauthAccount: { accountUuid: "fixture-uuid", emailAddress: "fixture@example.invalid" },
    hasCompletedOnboarding: true,
    hasSeenTasksHint: "yes",
    lastOnboardingVersion: "2.1.0",
    lastReleaseNotesSeen: "x".repeat(65),
    mcpServers: {
      github: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: "fixture-kept-token" },
      },
      docs: { type: "http", url: "https://docs.example.com/mcp" },
      orkestrator: {
        type: "http",
        url: "https://100.64.0.1:34122/mcp",
        headers: { Authorization: "Bearer SENTINEL-OPERATOR" },
      },
      hostService: {
        type: "http",
        url: "http://127.0.0.1:34122/mcp",
        headers: { Authorization: "Bearer SENTINEL-LOOPBACK" },
      },
      filesystem: { command: "npx", args: ["server-filesystem", `${HOME}/code`] },
      hostBinary: { command: `${HOME}/.local/bin/mcp`, env: { KEY: "SENTINEL-HOST-BIN" } },
    },
  };
}

describe("claudeContainerConfig", () => {
  test("keeps only the identity, onboarding flags and container-safe MCP servers", () => {
    const text = claudeContainerConfig(JSON.stringify(hostConfig()), { hostHomes: [HOME] });
    expect(JSON.parse(text!)).toEqual({
      oauthAccount: { accountUuid: "fixture-uuid", emailAddress: "fixture@example.invalid" },
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.0",
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "fixture-kept-token" },
        },
        docs: { type: "http", url: "https://docs.example.com/mcp" },
      },
    });
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain(HOME);
    for (const key of Object.keys(JSON.parse(text!))) {
      expect(CLAUDE_CONTAINER_CONFIG_KEYS).toContain(key as never);
    }
  });

  test("withholds text that is not a JSON object and keeps an empty object staged", () => {
    expect(claudeContainerConfig("{not json")).toBeUndefined();
    expect(claudeContainerConfig("[]")).toBeUndefined();
    expect(claudeContainerConfig("null")).toBeUndefined();
    expect(claudeContainerConfig('"text"')).toBeUndefined();
    expect(claudeContainerConfig('{"projects":{"/x":{}}}')).toBe("{}");
  });

  test("drops non-object identity and MCP containers, and keeps prototype keys inert", () => {
    const text = claudeContainerConfig(
      '{"oauthAccount":"SENTINEL","mcpServers":[1],"__proto__":{"polluted":true}}',
    );
    expect(text).toBe("{}");
    const servers = claudeContainerConfig(
      '{"mcpServers":{"__proto__":{"command":"npx"},"constructor":{"command":"uvx"}}}',
    );
    expect(Object.keys(JSON.parse(servers!).mcpServers)).toEqual(["__proto__", "constructor"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("ignores a home of / or a relative one", () => {
    const text = claudeContainerConfig(
      JSON.stringify({ mcpServers: { tool: { command: "/usr/bin/tool" } } }),
      { hostHomes: ["/", "relative", ""] },
    );
    expect(JSON.parse(text!).mcpServers).toEqual({ tool: { command: "/usr/bin/tool" } });
  });
});

describe("containerSafeMcpServer", () => {
  const safe = (entry: unknown, name = "server") => containerSafeMcpServer(name, entry, [HOME]);

  test("refuses the orkestrator name in any case", () => {
    expect(safe({ type: "http", url: "https://example.com/mcp" }, "orkestrator")).toBe(false);
    expect(safe({ type: "http", url: "https://example.com/mcp" }, "Orkestrator")).toBe(false);
    expect(safe({ command: "npx" }, "")).toBe(false);
  });

  test("refuses remote servers on loopback or with an unusable URL", () => {
    for (const url of [
      "http://localhost:3000/mcp",
      "http://LOCALHOST/mcp",
      "http://api.localhost/mcp",
      "http://localhost.:34122/mcp",
      "https://api.localhost./mcp",
      "http://127.0.0.1:34122/mcp",
      "http://127.1/mcp",
      "http://0x7f.0.0.1/mcp",
      "http://0.0.0.0:8080/mcp",
      "http://[::1]:8080/mcp",
      "http://[::]/mcp",
      "http://[::ffff:127.0.0.1]/mcp",
      "file:///etc/passwd",
      "not a url",
    ]) {
      expect(safe({ type: "http", url })).toBe(false);
      expect(safe({ type: "sse", url })).toBe(false);
    }
    expect(safe({ type: "http" })).toBe(false);
    expect(safe({ type: "http", url: 42 })).toBe(false);
  });

  test("keeps remote servers on routable hosts, typed or not", () => {
    expect(safe({ type: "http", url: "https://mcp.example.com/mcp" })).toBe(true);
    expect(safe({ type: "http", url: "https://mcp.example.com./mcp" })).toBe(true);
    expect(safe({ type: "sse", url: "http://10.0.0.5:8000/sse" })).toBe(true);
    expect(safe({ type: "ws", url: "wss://mcp.example.com/ws" })).toBe(true);
    expect(safe({ url: "https://mcp.example.com/mcp" })).toBe(true);
    expect(safe({ url: "http://localhost:1/mcp" })).toBe(false);
  });

  test("refuses local servers without a command or on Windows paths", () => {
    expect(safe({ type: "stdio" })).toBe(false);
    expect(safe({ command: "  " })).toBe(false);
    expect(safe({ command: 42 })).toBe(false);
    expect(safe({ command: "C:\\tools\\mcp.exe" })).toBe(false);
    expect(safe({ command: "npx", cwd: "D:/work" })).toBe(false);
    expect(safe({ command: "npx", args: ["-y", "server"], cwd: "/workspace" })).toBe(true);
  });

  test("refuses anything that names a path in a host home, but not a sibling", () => {
    expect(safe({ command: `${HOME}/bin/mcp` })).toBe(false);
    expect(safe({ command: "npx", args: [`--root=${HOME}`] })).toBe(false);
    expect(safe({ command: "npx", cwd: `${HOME}/code` })).toBe(false);
    expect(safe({ command: "npx", env: { CONFIG: `${HOME}/.config/x.json` } })).toBe(false);
    expect(safe({ command: "npx", env: { [`${HOME}/key`]: "1" } })).toBe(false);
    expect(
      safe({ type: "http", url: "https://example.com/mcp", headers: { X: `${HOME}/token` } }),
    ).toBe(false);
    expect(safe({ command: "npx", args: [`${HOME}-other/code`, `${HOME}x`] })).toBe(true);
    expect(containerSafeMcpServer("server", { command: `${HOME}/bin/mcp` })).toBe(true);
  });

  test("refuses unknown transports and non-object entries", () => {
    expect(safe({ type: "sdk", name: "x" })).toBe(false);
    expect(safe("npx")).toBe(false);
    expect(safe(null)).toBe(false);
    expect(safe([])).toBe(false);
  });

  test("treats an implausibly deep entry as unsafe", () => {
    let nested: unknown = "leaf";
    for (let index = 0; index < 40; index += 1) nested = { nested };
    expect(safe({ command: "npx", env: nested })).toBe(false);
  });
});

describe("docker/entrypoint.sh .claude.json import", () => {
  const cleanup: string[] = [];
  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function entrypointBlock(): Promise<string> {
    const entrypoint = await fs.readFile(
      path.join(import.meta.dir, "../../../../docker/entrypoint.sh"),
      "utf8",
    );
    const start = entrypoint.indexOf("CLAUDE_JSON_ALLOWED_KEYS=");
    const end = entrypoint.indexOf("# Sync filesystem to ensure config is written");
    if (start === -1 || end === -1) throw new Error("Missing .claude.json entrypoint block");
    return entrypoint.slice(start, end);
  }

  async function runImport(input: string | null): Promise<Record<string, unknown>> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-claude-json-"));
    cleanup.push(root);
    const home = path.join(root, "home");
    const relay = path.join(root, "relay");
    await fs.mkdir(home, { recursive: true });
    if (input !== null) {
      await fs.mkdir(relay, { recursive: true });
      await fs.writeFile(path.join(relay, "claude-config.json"), input);
    }
    const result = Bun.spawnSync({
      cmd: ["bash", "-ec", await entrypointBlock()],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        STAGED_INPUT_RELAY_DIR: relay,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"));
  }

  test("repeats the backend's top-level allowlist", async () => {
    const assignment = (await entrypointBlock()).match(/^CLAUDE_JSON_ALLOWED_KEYS='([^']+)'$/m);
    expect(JSON.parse(assignment![1]!)).toEqual([...CLAUDE_CONTAINER_CONFIG_KEYS]);
  });

  test("keeps only allowlisted keys of an unfiltered file and adds container settings", async () => {
    const config = await runImport(JSON.stringify(hostConfig()));
    expect(Object.keys(config).sort()).toEqual(
      [
        "bypassPermissionsModeAccepted",
        "hasCompletedOnboarding",
        "hasSeenTasksHint",
        "lastOnboardingVersion",
        "lastReleaseNotesSeen",
        "mcpServers",
        "oauthAccount",
        "projects",
        "theme",
      ].sort(),
    );
    expect(config.projects).toEqual({
      "/workspace": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    });
    expect(JSON.stringify(config)).not.toContain("SENTINEL-API-KEY");
    expect(JSON.stringify(config)).not.toContain("SENTINEL-PROJECT");
  });

  test("treats an emptied or missing input as no host config", async () => {
    const minimal = {
      bypassPermissionsModeAccepted: true,
      hasCompletedOnboarding: true,
      theme: "dark",
      projects: {
        "/workspace": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    };
    expect(await runImport("")).toEqual(minimal);
    expect(await runImport(null)).toEqual(minimal);
  });
});
