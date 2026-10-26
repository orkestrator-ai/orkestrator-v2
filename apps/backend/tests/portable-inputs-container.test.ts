/** Credential-free staged settings -> real entrypoint -> bridge resolver -> CLI.
 * Build this checkout with docker:build:dev, then set
 * RUN_PORTABLE_INPUTS_DOCKER=1 and PORTABLE_INPUTS_DOCKER_IMAGE to that image.
 */
import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stagePortableInputs, stagedInputMountArguments } from "../src/core/portable-inputs";

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 45_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Docker fixture failed (${code}): ${stderr}`);
    return stdout.trim();
  } finally {
    clearTimeout(timer);
  }
}

test.skipIf(process.env.RUN_PORTABLE_INPUTS_DOCKER !== "1")(
  "staged filtered settings agree with the entrypoint, bridge and real CLI",
  async () => {
    const image = process.env.PORTABLE_INPUTS_DOCKER_IMAGE;
    if (!image)
      throw new Error("Set PORTABLE_INPUTS_DOCKER_IMAGE to this checkout's development image");
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ork-portable-chain-")));
    const home = path.join(root, "host");
    const workspace = path.join(root, "workspace");
    let container: string | undefined;
    const write = async (file: string, text: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    };
    try {
      await fs.mkdir(workspace);
      const plugins: Record<string, unknown[]> = {};
      for (const name of ["on", "off", "never", "inline-off"]) {
        const install = path.join(home, ".claude", "plugins", name);
        plugins[`${name}@market`] = [{ scope: "user", installPath: install, version: "1.0.0" }];
        await write(path.join(install, ".claude-plugin", "plugin.json"), JSON.stringify({ name }));
        await write(
          path.join(install, ".mcp.json"),
          JSON.stringify({
            mcpServers: { one: { command: "node", args: ["/tmp/plugin-mcp-server.mjs", name] } },
          }),
        );
      }
      await write(
        path.join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({ version: 2, plugins }),
      );
      await write(
        path.join(home, ".claude.json"),
        JSON.stringify({ hasCompletedOnboarding: true }),
      );
      const settings = {
        enabledPlugins: {
          "on@market": true,
          "off@market": false,
          "inline-off@market": true,
          "inline-off@inline": false,
        },
      };
      const linkedSettings = path.join(root, "dotfiles", "settings.json");
      await write(
        linkedSettings,
        JSON.stringify({ ...settings, env: { SECRET: "SENTINEL-HOST-SECRET" } }),
      );
      await fs.symlink(linkedSettings, path.join(home, ".claude", "settings.json"));
      const staged = await stagePortableInputs(
        path.join(root, "data"),
        "chain",
        new Set(["claude"]),
        { home, agentTest: false },
      );
      expect(
        JSON.parse(
          await fs.readFile(path.join(staged.directory, "claude-config", "settings.json"), "utf8"),
        ),
      ).toEqual(settings);
      const services = path.resolve(import.meta.dir, "../../../bridges/claude-bridge/src/services");
      for (const [source, output, external] of [
        ["plugin-mcp.live-probe.ts", "probe.mjs", ["@anthropic-ai/claude-agent-sdk"]],
        ["session-manager-prompt-mcp-sync.live-fixture.ts", "plugin-mcp-server.mjs", []],
      ] as const) {
        const build = await Bun.build({
          entrypoints: [path.join(services, source)],
          target: "node",
          external: [...external],
        });
        if (!build.success) throw new Error(`Fixture build failed: ${build.logs}`);
        await write(path.join(root, output), await build.outputs[0]!.text());
      }
      container = await docker(
        "run",
        "--detach",
        "--network",
        "none",
        "--env",
        "NETWORK_MODE=full",
        ...stagedInputMountArguments(staged),
        "--mount",
        `type=bind,src=${workspace},dst=/workspace`,
        image,
      );
      const deadline = Date.now() + 60_000;
      while (
        (await docker(
          "exec",
          container,
          "sh",
          "-c",
          "if [ -f /tmp/.entrypoint-complete ]; then echo ready; fi",
        )) !== "ready"
      ) {
        if (Date.now() > deadline) throw new Error("Fixture entrypoint did not finish");
        await Bun.sleep(200);
      }
      const merged = await docker("exec", container, "cat", "/home/node/.claude/settings.json");
      expect(JSON.parse(merged).enabledPlugins).toEqual(settings.enabledPlugins);
      expect(merged).not.toContain("SENTINEL-HOST-SECRET");
      await docker(
        "cp",
        path.join(root, "probe.mjs"),
        `${container}:/opt/claude-bridge/dist/portable-settings-probe.mjs`,
      );
      await docker(
        "cp",
        path.join(root, "plugin-mcp-server.mjs"),
        `${container}:/tmp/plugin-mcp-server.mjs`,
      );
      const output = await docker(
        "exec",
        container,
        "node",
        "/opt/claude-bridge/dist/portable-settings-probe.mjs",
        JSON.stringify({
          home: "/home/node",
          cwd: "/workspace",
          settingSources: ["user", "project"],
        }),
      );
      const result = JSON.parse(output.split("__CLAUDE_PLUGIN_MCP_RESULT__")[1]!);
      expect(result.plugins.sort()).toEqual([
        "/home/node/.claude/plugins/inline-off",
        "/home/node/.claude/plugins/on",
      ]);
      expect(result.servers).toEqual([
        expect.objectContaining({ name: "plugin:on:one", status: "connected" }),
      ]);
    } finally {
      if (container) await docker("rm", "--force", container);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
