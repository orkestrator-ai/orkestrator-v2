/** Every staged mount through the image's real root bootstrap and node readers. */
import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { runCommand } from "../src/core/shell";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);

test.skipIf(!enabled)(
  "all staged mounts reach their node consumers after the root bootstrap",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-all-inputs-"));
    let container: string | undefined;
    const docker = async (args: string[]) =>
      (await runCommand("docker", args, { timeoutMs: 120_000 })).stdout.trim();
    // Representative file and directory reads for every mount, including the
    // special Claude settings merge, credential injection and project setup.
    const files: Record<string, string> = {
      "claude-config/CLAUDE.md": "relayed memory",
      "claude-config/commands/review.md": "relayed command",
      "claude-config/settings.json": '{"enabledPlugins":{"review@fixture":true}}',
      "claude-config/.credentials.json":
        '{"claudeAiOauth":{"accessToken":"fixture","refreshToken":""}}',
      "claude-config.json": '{"hasCompletedOnboarding":true,"relayFixture":true}',
      "codex-home/auth.json": '{"OPENAI_API_KEY":"fixture-not-a-key"}',
      "codex-home/rules/fixture.rules": "relayed rule",
      "opencode-config/opencode.json": '{"model":"fixture/model"}',
      "opencode-data/auth.json": '{"fixture":{"type":"api","key":"fixture-not-a-key"}}',
      "opencode-state/model.json": '{"recent":["fixture/model"]}',
      "grok-home/config.toml": 'model = "fixture"\n',
      "grok-config/fixture.json": '{"relayed":true}',
      "pi-config/agent/settings.json": '{"defaultProvider":"fixture"}',
      "pi-config/agent/prompts/review.md": "relayed prompt",
      "cursor-config/mcp.json": '{"mcpServers":{}}',
      "tmp/gitconfig": "[user]\n\tname = Relay Fixture\n",
      "project-env/.env": "RELAY_FIXTURE=1\n",
      "opencode-project-json": '{"model":"fixture/project"}',
    };
    const mounts = [
      "claude-config",
      "claude-config.json",
      "codex-home",
      "opencode-config",
      "opencode-data",
      "opencode-state/model.json",
      "grok-home",
      "grok-config",
      "pi-config",
      "cursor-config",
      "tmp/gitconfig",
      "project-env",
      "opencode-project-json",
    ];
    try {
      const bootstrap = await fs.readFile(
        path.join(import.meta.dir, "../../../docker/network-policy-entrypoint.sh"),
        "utf8",
      );
      const declared = bootstrap.match(/^STAGED_INPUT_MOUNTS="([^"]+)"/m)?.[1]?.split(" ");
      if (!declared) throw new Error("Missing staged mount declaration");
      expect(mounts.toSorted()).toEqual(declared.toSorted());
      for (const [name, content] of Object.entries(files)) {
        const source = path.join(root, name);
        await fs.mkdir(path.dirname(source), { recursive: true, mode: 0o700 });
        await fs.writeFile(source, content, { mode: 0o600 });
      }
      const security: string[] = JSON.parse(
        await docker(["info", "-f", "{{json .SecurityOptions}}"]),
      );
      const rootless = security.includes("name=rootless");
      container = await docker([
        "create",
        "--label",
        `orkestrator-qualification=inputs-${crypto.randomUUID()}`,
        "--network",
        "none",
        "-e",
        "NETWORK_MODE=full",
        ...mounts.flatMap((name) => [
          "--mount",
          `type=bind,src=${path.join(root, name)},dst=/${name},readonly`,
        ]),
        image!,
      ]);
      await docker(["start", container]);
      await waitForContainerBoot(container);
      await docker(["exec", "--user", "node", container, "/usr/local/bin/workspace-setup.sh"]);

      const imported: Record<string, string> = {
        "claude-config/CLAUDE.md": "/home/node/.claude/CLAUDE.md",
        "claude-config/commands/review.md": "/home/node/.claude/commands/review.md",
        "codex-home/auth.json": "/home/node/.codex/auth.json",
        "codex-home/rules/fixture.rules": "/home/node/.codex/rules/fixture.rules",
        "opencode-config/opencode.json": "/home/node/.config/opencode/opencode.json",
        "opencode-data/auth.json": "/home/node/.local/share/opencode/auth.json",
        "opencode-state/model.json": "/home/node/.local/state/opencode/model.json",
        "grok-home/config.toml": "/home/node/.grok/config.toml",
        "grok-config/fixture.json": "/home/node/.config/grok/fixture.json",
        "pi-config/agent/settings.json": "/home/node/.pi/agent/settings.json",
        "pi-config/agent/prompts/review.md": "/home/node/.pi/agent/prompts/review.md",
        "cursor-config/mcp.json": "/home/node/.cursor/mcp.json",
        "project-env/.env": "/workspace/.env",
        "opencode-project-json": "/workspace/opencode.json",
      };
      for (const [source, target] of Object.entries(imported)) {
        expect(await docker(["exec", "--user", "node", container, "cat", target])).toBe(
          files[source]!.trim(),
        );
      }
      expect(
        JSON.parse(
          await docker([
            "exec",
            "--user",
            "node",
            container,
            "cat",
            "/home/node/.claude/settings.json",
          ]),
        ).enabledPlugins,
      ).toEqual({ "review@fixture": true });
      expect(
        JSON.parse(
          await docker(["exec", "--user", "node", container, "cat", "/home/node/.claude.json"]),
        ).relayFixture,
      ).toBe(true);
      expect(
        JSON.parse(
          await docker([
            "exec",
            "--user",
            "node",
            container,
            "cat",
            "/home/node/.claude/.credentials.json",
          ]),
        ).claudeAiOauth.accessToken,
      ).toBe("fixture");
      expect(
        await docker([
          "exec",
          "--user",
          "node",
          container,
          "git",
          "config",
          "--global",
          "user.name",
        ]),
      ).toBe("Relay Fixture");
      if (rootless) {
        for (const name of Object.keys(files)) {
          expect(
            await docker([
              "exec",
              "--user",
              "node",
              container,
              "sh",
              "-c",
              'test ! -r "$1" && test -r "/run/orkestrator-inputs$1" && echo relayed',
              "relay-check",
              `/${name}`,
            ]),
          ).toBe("relayed");
        }
      }
      // Bootstrap and setup never relax the host staging permissions.
      for (const name of Object.keys(files)) {
        expect((await fs.stat(path.join(root, name))).mode & 0o777).toBe(0o600);
      }
    } finally {
      try {
        if (container) await docker(["rm", "-f", container]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  },
  180_000,
);
