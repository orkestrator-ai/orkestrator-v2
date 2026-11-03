/**
 * Security report M8, end to end: a host `~/.claude.json` staged by the real
 * `stagePortableInputs` from a throwaway HOME reaches the container only as its
 * allowlist, no raw copy is readable by `node`, and Claude Code still starts on
 * it, interactively, past onboarding, trust and first-run prompts.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * The container has no network and only fake credentials, so no provider
 * request can succeed and nothing is billed.
 */
import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_CONTAINER_CONFIG_KEYS } from "../src/core/claude-container-config";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { stagePortableInputs, stagedInputMountArguments } from "../src/core/portable-inputs";
import { runCommand } from "../src/core/shell";

const image = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim();
const enabled = process.env.RUN_LIVE_DOCKER_TESTS === "1" && Boolean(image);

/** Keys the entrypoint adds to the container's own copy. */
const ENTRYPOINT_KEYS = ["bypassPermissionsModeAccepted", "hasCompletedOnboarding", "theme"];

test.skipIf(!enabled)(
  "a staged ~/.claude.json carries only its allowlist and Claude still starts on it",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-m8-claude-json-"));
    const home = path.join(root, "home");
    const dataDir = path.join(root, "data");
    let container: string | undefined;
    const docker = async (args: string[]) =>
      (await runCommand("docker", args, { timeoutMs: 120_000 })).stdout.trim();
    const asNode = (...args: string[]) => docker(["exec", "--user", "node", container!, ...args]);
    try {
      await fs.mkdir(path.join(home, ".claude"), { recursive: true });
      await fs.mkdir(dataDir);
      await fs.writeFile(
        path.join(home, ".claude", ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"fixture","refreshToken":""}}',
        { mode: 0o600 },
      );
      await fs.writeFile(
        path.join(home, ".claude.json"),
        JSON.stringify({
          oauthAccount: { emailAddress: "m8@fixture.invalid" },
          hasCompletedOnboarding: true,
          hasSeenAutoDefaultNudge: true,
          primaryApiKey: "SENTINEL-API-KEY",
          userID: "SENTINEL-USER-ID",
          projects: { [path.join(home, "code", "app")]: { allowedTools: ["Bash"] } },
          githubRepoPaths: { "acme/app": [path.join(home, "code", "app")] },
          mcpServers: {
            docs: { type: "http", url: "https://docs.example.invalid/mcp" },
            orkestrator: {
              type: "http",
              url: "http://127.0.0.1:34122/mcp",
              headers: { Authorization: "Bearer SENTINEL-OPERATOR" },
            },
            hostbin: { command: path.join(home, ".local", "bin", "mcp") },
          },
        }),
        { mode: 0o600 },
      );
      const staged = await stagePortableInputs(dataDir, "m8-qualification", new Set(["claude"]), {
        home,
        agentTest: false,
      });
      expect(staged.mounts.map((mount) => mount.target)).toContain("/claude-config.json");

      container = await docker([
        "create",
        "--label",
        `orkestrator-qualification=m8-${crypto.randomUUID()}`,
        "--network",
        "none",
        "-e",
        "NETWORK_MODE=full",
        ...stagedInputMountArguments(staged),
        image!,
      ]);
      await docker(["start", container]);
      await waitForContainerBoot(container);

      // Every copy node can read, the bind itself and the root relay included.
      const readable = await asNode(
        "sh",
        "-c",
        'for f in /claude-config.json /run/orkestrator-inputs/claude-config.json "$HOME/.claude.json"; do [ -r "$f" ] && cat "$f"; echo; done',
      );
      expect(readable).toContain("m8@fixture.invalid");
      expect(readable).not.toContain("SENTINEL");
      expect(readable).not.toContain(home);
      expect(readable).not.toContain("34122");

      const claudeJson = JSON.parse(await asNode("cat", "/home/node/.claude.json"));
      for (const key of Object.keys(claudeJson)) {
        if (key === "projects") continue;
        expect([...CLAUDE_CONTAINER_CONFIG_KEYS, ...ENTRYPOINT_KEYS]).toContain(key);
      }
      expect(Object.keys(claudeJson.projects)).toEqual(["/workspace"]);
      expect(Object.keys(claudeJson.mcpServers)).toEqual(["docs"]);

      // The CLI loads the imported config: only the container-safe server is listed.
      expect(await asNode("claude", "--version")).toContain("Claude Code");
      const mcp = await asNode("claude", "mcp", "list");
      expect(mcp).toContain("docs:");
      expect(mcp).not.toContain("orkestrator");
      expect(mcp).not.toContain("hostbin");

      // Interactive Claude reaches its banner in /workspace with no first-run,
      // trust or auto-mode prompt in the way.
      await docker([
        "exec",
        "--user",
        "node",
        "--workdir",
        "/workspace",
        "--env",
        "TERM=xterm-256color",
        container,
        "tmux",
        "new-session",
        "-d",
        "-s",
        "m8",
        "-x",
        "160",
        "-y",
        "45",
        "claude",
      ]);
      let pane = "";
      for (let waited = 0; waited < 90_000 && !pane.includes("Claude Code v"); waited += 2_000) {
        await Bun.sleep(2_000);
        pane = await asNode("tmux", "capture-pane", "-p", "-t", "m8");
      }
      expect(pane).toContain("Claude Code v");
      // Let any prompt that would follow the banner render.
      await Bun.sleep(5_000);
      pane = await asNode("tmux", "capture-pane", "-p", "-t", "m8");
      expect(pane).toContain("/workspace");
      for (const prompt of ["text style", "trust the files", "auto mode", "Log in", "API key"]) {
        expect(pane).not.toContain(prompt);
      }
      expect(await asNode("sh", "-c", "tmux has-session -t m8 && echo running")).toBe("running");
    } finally {
      try {
        if (container) await docker(["rm", "-f", container]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  },
  240_000,
);
