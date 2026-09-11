import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  orkestratorMcpServer,
  parseAgentMcpConnection,
  resolvePiMcpServers,
} from "./mcp-config.js";

describe("Pi MCP config", () => {
  test("accepts the same Orkestrator hosts Claude does and rejects the rest", () => {
    for (const hostname of ["127.0.0.1", "localhost", "host.docker.internal"]) {
      expect(
        orkestratorMcpServer(undefined, {
          ORKESTRATOR_AGENT_MCP_URL: `http://${hostname}:4567/mcp`,
          ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
        }),
      ).toMatchObject({
        id: "orkestrator",
        scope: "orkestrator",
        transport: "http",
        url: `http://${hostname}:4567/mcp`,
      });
    }
    for (const env of [
      {},
      { ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp" },
      { ORKESTRATOR_AGENT_MCP_TOKEN: "project-token" },
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
        ORKESTRATOR_AGENT_MCP_URL: "http://user:password@127.0.0.1:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "project-token",
      },
    ]) {
      expect(orkestratorMcpServer(undefined, env)).toBeUndefined();
    }
  });

  test("prefers a per-tab connection over the process env", () => {
    expect(
      orkestratorMcpServer(
        { url: "http://127.0.0.1:9/mcp", token: "tab-token" },
        {
          ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp",
          ORKESTRATOR_AGENT_MCP_TOKEN: "env-token",
        },
      ),
    ).toMatchObject({
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer tab-token" },
    });
  });

  test("rejects a bearer longer than 1KiB", () => {
    expect(parseAgentMcpConnection({ url: "http://127.0.0.1:4567/mcp", token: "x".repeat(1025) })).toBe(
      undefined,
    );
  });

  test("loads user and project files, gates project scope, and reserves orkestrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-config-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { type: "http", url: "https://docs.example/mcp" },
          orkestrator: { command: "steal-the-name" },
          local: { command: "uvx", args: ["mcp-server"] },
        },
      }),
    );
    await writeFile(
      join(cwd, ".pi", "mcp.json"),
      JSON.stringify({
        projectdocs: { transport: "streamable-http", url: "http://127.0.0.1:9/mcp" },
        local: { command: "from-project" },
        disabled: { command: "nope", disabled: true },
      }),
    );

    const host = await resolvePiMcpServers({
      agentDir,
      cwd,
      projectResources: false,
      env: {
        ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "env-token",
      },
    });
    expect(host.map((server) => `${server.scope}:${server.id}`).sort()).toEqual([
      "orkestrator:orkestrator",
      "user:docs",
      "user:local",
    ]);
    expect(host.find((server) => server.id === "local")?.command).toBe("uvx");

    const container = await resolvePiMcpServers({
      agentDir,
      cwd,
      projectResources: true,
      env: {
        ORKESTRATOR_AGENT_MCP_URL: "http://127.0.0.1:4567/mcp",
        ORKESTRATOR_AGENT_MCP_TOKEN: "env-token",
      },
    });
    expect(container.map((server) => `${server.scope}:${server.id}`).sort()).toEqual([
      "orkestrator:orkestrator",
      "project:local",
      "project:projectdocs",
      "user:docs",
    ]);
    expect(container.find((server) => server.id === "local")?.command).toBe("from-project");
  });
});
