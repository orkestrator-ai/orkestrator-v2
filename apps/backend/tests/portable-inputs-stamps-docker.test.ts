/**
 * The entrypoint's input stamps in a real container: a fixture home bound at
 * the staged mounts, started, stopped and started again. Set
 * `ORKESTRATOR_QUALIFICATION_OLD_IMAGE` to an image from before `staged-inputs`
 * 5 to also prove it keeps its full copy. `--network none`: nothing here needs
 * a network, so no address pool is touched.
 */
import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { runCommand } from "../src/core/shell";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const oldImage = process.env.ORKESTRATOR_QUALIFICATION_OLD_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);

const docker = async (args: string[]) =>
  (await runCommand("docker", args, { timeoutMs: 120_000 })).stdout.trim();

const FILES: Record<string, string> = {
  "claude-config/CLAUDE.md": "fixture memory\n",
  "claude-config/skills/review/SKILL.md": "---\nname: review\ndescription: d\n---\nReview.\n",
  "claude-config/skills/gone/SKILL.md": "---\nname: gone\ndescription: d\n---\nGone.\n",
  "claude-config/commands/one.md": "command one\n",
  "codex-home/config.toml": "model = 'one'\n",
  "codex-home/AGENTS.md": "agents one\n",
  "codex-home/rules/default.rules": "allow\n",
  "codex-home/auth.json": '{"tokens":{"access_token":"token-one","refresh_token":"host-refresh"}}',
  "opencode-config/opencode.json": '{"model":"fixture/one"}',
  "grok-config/settings.json": '{"one":true}',
  "pi-config/agent/settings.json": '{"one":true}',
  "pi-config/agent/prompts/review.md": "prompt one\n",
  "agents-skills/shared/SKILL.md": "---\nname: shared\ndescription: d\n---\nShared.\n",
  "cursor-config/mcp.json": '{"mcpServers":{}}',
};
const MOUNTS = [
  "claude-config",
  "codex-home",
  "opencode-config",
  "grok-config",
  "pi-config",
  "agents-skills",
  "cursor-config",
];
const STAMPED = [
  ".claude/CLAUDE.md",
  ".claude/skills/review/SKILL.md",
  ".claude/commands/one.md",
  ".codex/config.toml",
  ".codex/rules/default.rules",
  ".config/opencode/opencode.json",
  ".config/grok/settings.json",
  ".pi/agent/prompts/review.md",
  ".agents/skills/shared/SKILL.md",
  ".cursor/mcp.json",
];

const containers: string[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const container of containers.splice(0)) {
    await docker(["rm", "-f", container]).catch(() => undefined);
  }
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixtureContainer(fromImage: string, forceRelay = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-input-stamps-live-"));
  roots.push(root);
  const write = async (name: string, content: string) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, content, { mode: 0o600 });
  };
  for (const [name, content] of Object.entries(FILES)) await write(name, content);
  const container = await docker([
    "create",
    "--label",
    `orkestrator-qualification=input-stamps-${crypto.randomUUID()}`,
    "--network",
    "none",
    "-e",
    "NETWORK_MODE=full",
    ...MOUNTS.flatMap((name) => [
      "--mount",
      `type=bind,src=${path.join(root, name)},dst=/${name},readonly`,
    ]),
    fromImage,
  ]);
  containers.push(container);
  const inContainer = (...args: string[]) => docker(["exec", "--user", "node", container, ...args]);
  const relayOwner = async (owner: string) => {
    const helper = await docker([
      "create",
      "--network",
      "none",
      "--user",
      "root",
      "--env",
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      "--entrypoint",
      "sh",
      "--mount",
      `type=bind,src=${root},dst=/staged`,
      fromImage,
      "-c",
      'stat -c "%u:%g" /staged; chown -R "$1" /staged',
      "owner",
      owner,
    ]);
    containers.push(helper);
    return (await docker(["start", "--attach", helper])).trim();
  };
  const start = async () => {
    // Different ownership with owner-only modes reproduces non-1000/rootless
    // mounts without changing the permissions the relay must preserve.
    const owner = forceRelay ? await relayOwner("12345:12345") : undefined;
    try {
      await docker(["start", container]);
      await waitForContainerBoot(container);
      if (forceRelay) {
        expect(
          await inContainer("test", "-r", "/run/orkestrator-inputs/codex-home/config.toml"),
        ).toBe("");
      }
    } finally {
      if (owner) await relayOwner(owner);
    }
  };
  const stop = () => docker(["stop", "--time", "1", container]);
  const identities = async () =>
    inContainer("sh", "-c", 'cd "$HOME" && stat -c "%n %i %.9Y" "$@"', "stat", ...STAMPED);
  const counts = async () =>
    (await inContainer("cat", "/tmp/.entrypoint-progress")).match(
      /Agent inputs: (\d+) unchanged, (\d+) copied/,
    );
  const read = (name: string) => inContainer("cat", `/home/node/${name}`);
  const exists = async (name: string) =>
    (await inContainer(
      "sh",
      "-c",
      'test -e "$1" && echo yes || echo no',
      "exists",
      `/home/node/${name}`,
    )) === "yes";
  return { root, write, start, stop, identities, counts, read, exists };
}

for (const forceRelay of [false, true]) {
  test.skipIf(!enabled)(
    `first and second start show expected inputs and copy nothing (forced relay=${forceRelay})`,
    async () => {
      const f = await fixtureContainer(image!, forceRelay);
      await f.start();
      const first = await f.counts();
      expect(Number(first?.[1])).toBe(0);
      const copied = Number(first?.[2]);
      expect(copied).toBeGreaterThanOrEqual(STAMPED.length);
      const imported = await f.identities();
      expect(await f.read(".claude/CLAUDE.md")).toBe("fixture memory");
      expect(await f.read(".agents/skills/shared/SKILL.md")).toContain("Shared.");
      expect(await f.read(".pi/agent/prompts/review.md")).toBe("prompt one");
      const login = await f.read(".codex/auth.json");
      expect(login).toContain("token-one");
      expect(login).not.toContain("host-refresh");

      await f.stop();
      await f.start();
      const second = await f.counts();
      expect(Number(second?.[1])).toBe(copied);
      expect(Number(second?.[2])).toBe(0);
      expect(await f.identities()).toBe(imported);
      expect(await f.read(".claude/CLAUDE.md")).toBe("fixture memory");
      expect(await f.read(".agents/skills/shared/SKILL.md")).toContain("Shared.");

      // Changing, adding and removing one input each, and a rotated login.
      await f.stop();
      await f.write("codex-home/config.toml", "model = 'two'\n");
      await f.write("claude-config/skills/added/SKILL.md", "---\nname: added\n---\nAdded.\n");
      await fs.rm(path.join(f.root, "claude-config/skills/gone"), { recursive: true });
      await fs.rm(path.join(f.root, "codex-home/AGENTS.md"));
      await f.write(
        "codex-home/auth.json",
        '{"tokens":{"access_token":"token-two","refresh_token":"host-refresh"}}',
      );
      await f.start();
      expect(await f.read(".codex/config.toml")).toBe("model = 'two'");
      expect(await f.read(".claude/skills/added/SKILL.md")).toContain("Added.");
      expect(await f.exists(".claude/skills/gone")).toBe(false);
      expect(await f.exists(".codex/AGENTS.md")).toBe(false);
      expect(await f.read(".codex/auth.json")).toContain("token-two");

      // A sign-out: the staged login goes, and so does the imported copy.
      await f.stop();
      await fs.rm(path.join(f.root, "codex-home/auth.json"));
      await f.start();
      expect(await f.exists(".codex/auth.json")).toBe(false);
      expect(await f.read(".claude/skills/review/SKILL.md")).toContain("Review.");
    },
    300_000,
  );
}

test.skipIf(!enabled || !oldImage)(
  "an image from before the capability keeps its full copy",
  async () => {
    const f = await fixtureContainer(oldImage!);
    await f.start();
    expect(await f.counts()).toBeNull();
    const imported = await f.identities();
    expect(await f.read(".claude/CLAUDE.md")).toBe("fixture memory");

    await f.stop();
    await f.start();
    expect(await f.counts()).toBeNull();
    expect(await f.identities()).not.toBe(imported);
    expect(await f.read(".claude/CLAUDE.md")).toBe("fixture memory");
  },
  300_000,
);
