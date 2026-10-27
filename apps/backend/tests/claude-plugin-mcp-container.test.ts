/** Real Docker discovery, including the production folder-listing fallback.
 * RUN_LIVE_CLAUDE_PLUGIN_MCP_DOCKER=1; image can be overridden by
 * CLAUDE_PLUGIN_MCP_DOCKER_IMAGE. Only the disposable container is removed.
 */
import { describe, expect, test } from "bun:test";

import {
  listContainerMcpDirectories,
  readContainerMcpFile,
} from "../src/core/commands-registry-mcp";
import { McpManagementService } from "../src/core/mcp-management/service";
import { createFixture, targetIdFor } from "../src/core/mcp-management/test-support";

const enabled = process.env.RUN_LIVE_CLAUDE_PLUGIN_MCP_DOCKER === "1";

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const deadline = setTimeout(() => child.kill(), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Docker fixture command failed (${code}): ${stderr}`);
    return stdout.trim();
  } finally {
    clearTimeout(deadline);
  }
}

describe.skipIf(!enabled)("Claude plugin discovery in a real container", () => {
  test.each(["installed", "missing", "invalid"])(
    "%s installation state",
    async (state) => {
      const fixture = createFixture({ environmentType: "containerized", env: {} });
      let containerId: string | undefined;
      let service: McpManagementService | undefined;
      try {
        const dir = state === "installed" ? "cache/market/docs/1.0.0" : "docs";
        fixture.write(
          `home/.claude/plugins/${dir}/.claude-plugin/plugin.json`,
          JSON.stringify({ name: "docs" }),
        );
        fixture.write(
          `home/.claude/plugins/${dir}/.mcp.json`,
          JSON.stringify({ mcpServers: { search: { command: "fixture-search" } } }),
        );
        if (state !== "missing")
          fixture.write(
            "home/.claude/plugins/installed_plugins.json",
            state === "invalid"
              ? "{ broken"
              : JSON.stringify({
                  version: 2,
                  plugins: {
                    "docs@market": [
                      {
                        installPath: `/Users/other/.claude/plugins/${dir}`,
                        scope: "user",
                        version: "1.0.0",
                      },
                    ],
                  },
                }),
          );
        // The container's settings carry the host's plugin enablement (merged
        // in by the entrypoint); an install is passed only when its id is true.
        if (state === "installed")
          fixture.write(
            "home/.claude/settings.json",
            JSON.stringify({ enabledPlugins: { "docs@market": true } }),
          );
        // A folder without a manifest is never included by the scan.
        fixture.write(
          "home/.claude/plugins/bare/.mcp.json",
          JSON.stringify({ hidden: { command: "hidden" } }),
        );
        containerId = await docker(
          "run",
          "--detach",
          "--network",
          "none",
          "--entrypoint",
          "/bin/sh",
          "--mount",
          `type=bind,src=${fixture.home},dst=/home/node,readonly`,
          "--mount",
          `type=bind,src=${fixture.worktree},dst=/workspace,readonly`,
          process.env.CLAUDE_PLUGIN_MCP_DOCKER_IMAGE ?? "orkestrator-v2:latest",
          "-c",
          "sleep 300",
        );
        fixture.environment.containerId = containerId;
        expect(
          (await listContainerMcpDirectories(containerId, "/home/node/.claude/plugins"))
            .directories,
        ).toContain(`/home/node/.claude/plugins/${dir.split("/")[0]}`);
        if (state === "missing") {
          for (let index = 0; index < 1025; index += 1)
            fixture.write(`home/listing/d${index}/.keep`, "");
          const bounded = await listContainerMcpDirectories(containerId, "/home/node/listing");
          expect(bounded.directories).toHaveLength(1024);
          expect(bounded.incomplete).toBe(true);
          expect(await listContainerMcpDirectories(containerId, "/home/node/absent")).toEqual({
            directories: [],
          });
        }
        service = new McpManagementService({
          dataDir: `${fixture.root}/real-container-data`,
          home: fixture.home,
          env: {},
          tickMs: 1_000_000,
          storage: {
            getEnvironment: async () => fixture.environment as never,
            getProject: async () => ({ id: "proj-1", name: "fixture" }) as never,
            previewServices: {
              getPreviewBackendIdentity: async () => ({ instanceId: "backend-1", created: false }),
            },
          },
          emit: () => undefined,
          probe: fixture.probe,
          readContainerFile: readContainerMcpFile,
          listContainerDirectories: listContainerMcpDirectories,
        });
        const snapshot = await service.snapshot({
          targetId: await targetIdFor(fixture, "claude", "environment"),
        });
        const sources = snapshot.sources.filter((source) => source.scope === "plugin");
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({
          label: "Plugin docs",
          state: "ok",
          writable: false,
          displayPath: `container:/home/node/.claude/plugins/${dir}/.mcp.json`,
        });
        expect(snapshot.definitions.find((row) => row.name === "plugin:docs:search")).toMatchObject(
          { status: "effective", sourceId: sources[0]!.sourceId },
        );
        expect(snapshot.definitions.some((row) => row.name.includes("hidden"))).toBe(false);
        if (state === "installed") {
          // Turned off in Claude Code: not passed, and the row says why.
          fixture.write(
            "home/.claude/settings.json",
            JSON.stringify({ enabledPlugins: { "docs@market": false } }),
          );
          const off = await service.snapshot({
            targetId: await targetIdFor(fixture, "claude", "environment"),
          });
          expect(off.definitions.find((row) => row.name === "plugin:docs:search")).toMatchObject({
            status: "disabled",
            statusReason:
              'Disabled: enabledPlugins["docs@market"] is false in ~/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
          });
        }
      } finally {
        service?.dispose();
        if (containerId) await docker("rm", "--force", containerId);
        await fixture.cleanup();
      }
    },
    90_000,
  );
});
