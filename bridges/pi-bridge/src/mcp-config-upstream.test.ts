import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfigFile, resolvePiMcpServers } from "./mcp-config.js";
import {
  PI_MCP_CONFIG_FIXTURES,
  mcpConfigFileText,
  type PiMcpConfigFixture,
} from "./testing/mcp-config-fixtures.js";

/**
 * Pi's own `mcp.json` loader. It is not a public export, so it is loaded from
 * the pinned package by path; if a Pi upgrade moves it, this test fails and
 * the bridge's loader has to be re-read against the new one.
 */
interface PiMcpConfig {
  servers: Array<{ name: string; scope: "global" | "project"; config: { enabled?: boolean } }>;
}
const { loadMcpConfig } = (await import(
  new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): PiMcpConfig;
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeFixture(
  fixture: PiMcpConfigFixture,
): Promise<{ agentDir: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-upstream-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  if (fixture.user !== undefined)
    await writeFile(join(agentDir, "mcp.json"), mcpConfigFileText(fixture.user));
  if (fixture.project !== undefined)
    await writeFile(join(cwd, ".pi", "mcp.json"), mcpConfigFileText(fixture.project));
  return { agentDir, cwd };
}

describe("the bridge follows Pi's own mcp.json loader", () => {
  for (const fixture of PI_MCP_CONFIG_FIXTURES) {
    test(fixture.name, async () => {
      const { agentDir, cwd } = await writeFixture(fixture);
      const bridge = await resolvePiMcpServers({
        agentDir,
        cwd,
        projectResources: true,
        env: fixture.env ?? {},
      });
      expect(bridge.map((server) => `${server.scope}:${server.id}`).sort()).toEqual(fixture.bridge);
      for (const key of Object.keys(fixture.launchBlocked ?? {})) {
        const [scope, id] = key.split(":");
        const entries = await loadMcpConfigFile(
          scope === "user" ? join(agentDir, "mcp.json") : join(cwd, ".pi", "mcp.json"),
          scope === "user" ? "user" : "project",
          fixture.env ?? {},
        );
        const entry = entries.find((entry) => entry.id === id);
        expect(entry?.kind).toBe("server");
        if (entry?.kind === "server") {
          expect(entry.enabled).toBe(true);
          expect(entry.hasAuth || entry.launch === undefined).toBe(true);
        }
      }

      const pi = loadMcpConfig({ agentDir, cwd, projectTrusted: true });
      const enabled = pi.servers
        .filter((server) => server.config.enabled !== false)
        .map((server) => `${server.scope === "global" ? "user" : server.scope}:${server.name}`)
        .sort();
      // Every difference from Pi is listed, with its reason, in the fixture.
      expect(enabled).toEqual(fixture.pi?.enabled ?? fixture.bridge);
    });
  }
});
