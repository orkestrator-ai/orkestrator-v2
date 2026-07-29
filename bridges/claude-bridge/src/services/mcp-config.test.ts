import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerConfig } from "../types/mcp.js";
import {
  configToSdkFormat,
  getMcpRuntimeConfig,
  getOrkestratorAgentMcpServer,
  getMcpServerInfo,
  getMergedMcpServers,
  loadGlobalMcpServers,
  loadProjectMcpServers,
  loadProjectOverridesFromGlobal,
} from "./mcp-config.js";
import { setClaudeHomeForTesting } from "./claude-home.js";
import { clearJsonFileCache } from "./json-file-cache.js";

describe("configToSdkFormat", () => {
  test("converts an http server config", () => {
    const result = configToSdkFormat({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });

    expect(result).toEqual({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer x" },
    });
  });

  test("converts an explicit stdio server config", () => {
    const result = configToSdkFormat({
      type: "stdio",
      command: "my-server",
      args: ["--flag"],
      env: { KEY: "value" },
    });

    expect(result).toEqual({
      type: "stdio",
      command: "my-server",
      args: ["--flag"],
      env: { KEY: "value" },
    });
  });

  test("defaults to stdio when type is omitted but a command is present", () => {
    const result = configToSdkFormat({ command: "implicit-stdio" });

    expect(result).toEqual({
      type: "stdio",
      command: "implicit-stdio",
      args: undefined,
      env: undefined,
    });
  });

  test("returns null for an http config missing its url", () => {
    // Malformed config (http type without a url) — neither branch matches.
    const result = configToSdkFormat({ type: "http" } as McpServerConfig);
    expect(result).toBeNull();
  });

  test("returns null for a config that is neither http nor stdio", () => {
    const result = configToSdkFormat({} as McpServerConfig);
    expect(result).toBeNull();
  });
});

describe("Orkestrator agent MCP injection", () => {
  test("builds the private HTTP server for every supported backend host", () => {
    for (const hostname of ["127.0.0.1", "localhost", "host.docker.internal"]) {
      expect(getOrkestratorAgentMcpServer({
        ORKESTRATOR_AGENT_MCP_URL: `http://${hostname}:4567/mcp`,
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      })).toEqual({
        type: "http",
        url: `http://${hostname}:4567/mcp`,
        headers: { Authorization: "Bearer project-token" },
      });
    }
  });

  test("rejects missing, malformed, remote, or otherwise untrusted endpoints", () => {
    for (const env of [
      {},
      { ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp" },
      { ORKESTRATOR_AGENT_MCP_TOKEN: "project-token" },
      {
        ORKESTRATOR_AGENT_MCP_URL: "not a URL",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      },
      {
        ORKESTRATOR_AGENT_MCP_URL: "https://127.0.0.1:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      },
      {
        ORKESTRATOR_AGENT_MCP_URL: "http://attacker.example/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      },
      {
        ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/not-mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      },
      {
        ORKESTRATOR_AGENT_MCP_URL: "http://user@127.0.0.1:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      },
      {
        ORKESTRATOR_AGENT_MCP_URL: "http://user:password@127.0.0.1:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      },
    ]) {
      expect(getOrkestratorAgentMcpServer(env)).toBeNull();
    }
  });
});

/**
 * These resolvers read `~/.claude.json`, which belongs to whoever is running
 * the suite — so they are pointed at a scratch home instead. Everything below
 * exercises the real file reading and the real slice cache.
 */
describe("mcp config resolution", () => {
  let home: string;
  let cwd: string;

  const writeClaudeJson = (value: unknown) =>
    writeFile(join(home, ".claude.json"), JSON.stringify(value));

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-home-"));
    cwd = await mkdtemp(join(tmpdir(), "claude-bridge-mcp-project-"));
    setClaudeHomeForTesting(home);
    clearJsonFileCache();
  });

  afterEach(async () => {
    setClaudeHomeForTesting(null);
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    clearJsonFileCache();
  });

  test("returns empty records when no config file exists at all", async () => {
    expect(await loadGlobalMcpServers()).toEqual({});
    expect(await loadProjectMcpServers(cwd)).toEqual({});
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual({});
    expect(await getMergedMcpServers(cwd)).toEqual({});
    expect(await getMcpServerInfo(cwd)).toEqual([]);

    const runtime = await getMcpRuntimeConfig(cwd, {});
    expect(runtime.servers).toEqual({});
    expect(runtime.names.size).toBe(0);
  });

  test("returns empty records when the config file has no mcpServers key", async () => {
    await writeClaudeJson({ projects: {}, someUnrelatedKey: 1 });

    expect(await loadGlobalMcpServers()).toEqual({});
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual({});
  });

  test("treats a malformed config file as absent rather than failing the turn", async () => {
    await writeFile(join(home, ".claude.json"), "{ not json");

    expect(await loadGlobalMcpServers()).toEqual({});
    expect(await getMergedMcpServers(cwd)).toEqual({});
  });

  test("loads global, project-entry and project-file servers from their own sources", async () => {
    await writeClaudeJson({
      mcpServers: { global: { command: "global-server" } },
      projects: { [cwd]: { mcpServers: { entry: { command: "entry-server" } } } },
    });
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "local-server" } } }),
    );

    expect(await loadGlobalMcpServers()).toEqual({ global: { command: "global-server" } });
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual({
      entry: { command: "entry-server" },
    });
    expect(await loadProjectMcpServers(cwd)).toEqual({ local: { command: "local-server" } });
  });

  test("does not serve one project's overrides to another", async () => {
    const otherCwd = "/somewhere/else";
    await writeClaudeJson({
      projects: {
        [cwd]: { mcpServers: { mine: { command: "mine" } } },
        [otherCwd]: { mcpServers: { theirs: { command: "theirs" } } },
      },
    });

    // Both slices come from the same file; a shared cache key would cross them.
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual({ mine: { command: "mine" } });
    expect(await loadProjectOverridesFromGlobal(otherCwd)).toEqual({
      theirs: { command: "theirs" },
    });
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual({ mine: { command: "mine" } });
  });

  test("merges with project file over project entry over global", async () => {
    await writeClaudeJson({
      mcpServers: {
        shared: { command: "from-global" },
        onlyGlobal: { command: "global-only" },
      },
      projects: {
        [cwd]: {
          mcpServers: {
            shared: { command: "from-project-entry" },
            alsoShared: { command: "from-project-entry" },
          },
        },
      },
    });
    await writeFile(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { alsoShared: { command: "from-project-file" } } }),
    );

    expect(await getMergedMcpServers(cwd)).toEqual({
      onlyGlobal: { command: "global-only" },
      shared: { command: "from-project-entry" },
      alsoShared: { command: "from-project-file" },
    });
  });

  test("picks up an edit made while the bridge is running", async () => {
    await writeClaudeJson({ mcpServers: { before: { command: "before" } } });
    expect(await loadGlobalMcpServers()).toEqual({ before: { command: "before" } });

    // Past coarse mtime granularity; the size differs here too.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeClaudeJson({ mcpServers: { after: { command: "after-server" } } });

    expect(await loadGlobalMcpServers()).toEqual({ after: { command: "after-server" } });
  });

  describe("getMcpRuntimeConfig", () => {
    test("translates every recognised transport and reports names", async () => {
      await writeClaudeJson({
        mcpServers: {
          stdioServer: { command: "run-me", args: ["--x"], env: { K: "v" } },
          httpServer: { type: "http", url: "https://example.com/mcp" },
        },
      });

      const { servers, names } = await getMcpRuntimeConfig(cwd, {});

      expect(servers).toEqual({
        stdioServer: { type: "stdio", command: "run-me", args: ["--x"], env: { K: "v" } },
        httpServer: { type: "http", url: "https://example.com/mcp", headers: undefined },
      });
      expect([...names].sort()).toEqual(["httpServer", "stdioServer"]);
    });

    test("keeps an untranslatable server in names even though it is dropped from servers", async () => {
      // A server whose shape we cannot translate is still an MCP server as far
      // as `mcp_<server>_<tool>` parsing goes; dropping the name would
      // misattribute its tools to a server whose name contains an underscore.
      await writeClaudeJson({
        mcpServers: {
          good: { command: "fine" },
          weird: { type: "http" },
        },
      });

      const { servers, names } = await getMcpRuntimeConfig(cwd, {});

      expect(Object.keys(servers)).toEqual(["good"]);
      expect([...names].sort()).toEqual(["good", "weird"]);
    });

    test("reflects the merge precedence, not just the global file", async () => {
      await writeClaudeJson({
        mcpServers: { shared: { command: "from-global" } },
        projects: { [cwd]: { mcpServers: { shared: { command: "from-project" } } } },
      });

      const { servers } = await getMcpRuntimeConfig(cwd, {});
      expect(servers.shared).toEqual({
        type: "stdio",
        command: "from-project",
        args: undefined,
        env: undefined,
      });
    });

    test("injects the agent server into runtime servers and names", async () => {
      const { servers, names } = await getMcpRuntimeConfig(cwd, {
        ORKESTRATOR_AGENT_MCP_URL: "http://host.docker.internal:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      });

      expect(servers.orkestrator).toEqual({
        type: "http",
        url: "http://host.docker.internal:4567/mcp",
        headers: { Authorization: "Bearer project-token" },
      });
      expect(names).toEqual(new Set(["orkestrator"]));
    });

    test("trusted agent injection wins a reserved-name collision", async () => {
      await writeClaudeJson({
        mcpServers: {
          orkestrator: {
            type: "http",
            url: "https://attacker.example/mcp",
            headers: { Authorization: "Bearer attacker-token" },
          },
        },
      });

      const { servers, names } = await getMcpRuntimeConfig(cwd, {
        ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      });

      expect(servers.orkestrator).toEqual({
        type: "http",
        url: "http://127.0.0.1:4567/mcp",
        headers: { Authorization: "Bearer project-token" },
      });
      expect([...names]).toEqual(["orkestrator"]);
    });

    test("uses its explicit environment instead of ambient agent credentials", async () => {
      const originalUrl = process.env.ORKESTRATOR_AGENT_MCP_URL;
      const originalToken = process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
      process.env.ORKESTRATOR_AGENT_MCP_URL = "http://127.0.0.1:9999/mcp";
      process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "ambient-token";
      try {
        const { servers, names } = await getMcpRuntimeConfig(cwd, {});
        expect(servers.orkestrator).toBeUndefined();
        expect(names.has("orkestrator")).toBe(false);
      } finally {
        if (originalUrl === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_URL;
        else process.env.ORKESTRATOR_AGENT_MCP_URL = originalUrl;
        if (originalToken === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
        else process.env.ORKESTRATOR_AGENT_MCP_TOKEN = originalToken;
      }
    });

    test("uses installed process credentials when no environment is supplied", async () => {
      const originalUrl = process.env.ORKESTRATOR_AGENT_MCP_URL;
      const originalToken = process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
      process.env.ORKESTRATOR_AGENT_MCP_URL = "http://localhost:4567/mcp";
      process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "process-token";
      try {
        const { servers, names } = await getMcpRuntimeConfig(cwd);
        expect(servers.orkestrator).toEqual({
          type: "http",
          url: "http://localhost:4567/mcp",
          headers: { Authorization: "Bearer process-token" },
        });
        expect(names.has("orkestrator")).toBe(true);
      } finally {
        if (originalUrl === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_URL;
        else process.env.ORKESTRATOR_AGENT_MCP_URL = originalUrl;
        if (originalToken === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
        else process.env.ORKESTRATOR_AGENT_MCP_TOKEN = originalToken;
      }
    });

    test("ignores an invalid injection without replacing user configuration", async () => {
      await writeClaudeJson({
        mcpServers: { orkestrator: { command: "user-server" } },
      });

      const { servers, names } = await getMcpRuntimeConfig(cwd, {
        ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/wrong",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      });

      expect(servers.orkestrator).toEqual({
        type: "stdio",
        command: "user-server",
        args: undefined,
        env: undefined,
      });
      expect(names.has("orkestrator")).toBe(true);
    });
  });

  describe("getMcpServerInfo", () => {
    test("labels each server with the source that won", async () => {
      await writeClaudeJson({
        mcpServers: { globalOnly: { command: "g" } },
        projects: { [cwd]: { mcpServers: { fromEntry: { type: "http", url: "https://e" } } } },
      });
      await writeFile(
        join(cwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { fromFile: { command: "f" } } }),
      );

      const info = await getMcpServerInfo(cwd);
      const byName = Object.fromEntries(info.map((entry) => [entry.name, entry]));

      expect(byName.globalOnly).toEqual({
        name: "globalOnly",
        type: "stdio",
        command: "g",
        source: "global",
      });
      expect(byName.fromEntry).toEqual({
        name: "fromEntry",
        type: "http",
        url: "https://e",
        source: "project",
      });
      expect(byName.fromFile).toEqual({
        name: "fromFile",
        type: "stdio",
        command: "f",
        source: "project",
      });
    });

    test("omits a server whose config matches no known transport", async () => {
      await writeClaudeJson({ mcpServers: { broken: { type: "http" } } });

      expect(await getMcpServerInfo(cwd)).toEqual([]);
    });
  });
});
