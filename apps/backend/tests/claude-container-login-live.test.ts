import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PINNED_TOOLCHAIN_VERSIONS } from "@orkestrator/toolchain/manifest";
import { readAddedClaudeCredentials } from "../src/core/agent-accounts-active.js";
import { syncContainerClaudeLogin } from "../src/core/agent-accounts-containers.js";
import {
  ContainerClaudeLoginKeeper,
  CLAUDE_HOST_REFRESH_LEAD_MS,
} from "../src/core/container-claude-login-keeper.js";
import { refreshHostClaudeLogin } from "../src/core/claude-host-login-refresh.js";
import type { CommandContext } from "../src/core/commands-context.js";
import { runCommand } from "../src/core/shell.js";

// This consumes a real refresh token. Never run against a borrowed agent-test
// credential: provision an exclusive disposable account home instead. Nothing
// reads the default host login, and credentials/replies never enter assertions.
const enabled = process.env.ORKESTRATOR_LIVE_CLAUDE_LOGIN === "1";

test.skipIf(!enabled)(
  "real host renewal reaches a running Claude background turn past the old token expiry",
  async () => {
    const home = process.env.ORKESTRATOR_LIVE_CLAUDE_ACCOUNT_HOME;
    const image = process.env.ORKESTRATOR_LIVE_CLAUDE_IMAGE;
    const toolchainBinDir = process.env.ORKESTRATOR_LIVE_CLAUDE_TOOLCHAIN_BIN;
    if (!home || !image?.startsWith("orkestrator-v2:dev-") || !toolchainBinDir)
      throw new Error(
        "Dedicated account home, development image and pinned toolchain are required",
      );
    if (
      path.basename(path.dirname(home)) !== "claude" ||
      !/^[a-f0-9-]{36}$/.test(path.basename(home))
    )
      throw new Error("Use an exclusive agent-accounts/claude/<uuid> home");
    const read = async () => {
      const credentials = await readAddedClaudeCredentials(home);
      if (!credentials) throw new Error("Dedicated login is unreadable");
      return credentials;
    };
    const initial = JSON.parse(await read()).claudeAiOauth;
    const remaining = initial?.expiresAt - Date.now();
    if (
      !initial?.refreshToken ||
      !Number.isFinite(remaining) ||
      remaining < 90_000 ||
      remaining > CLAUDE_HOST_REFRESH_LEAD_MS
    )
      throw new Error(
        "The dedicated real login must have 90–240 seconds left; do not simulate expiry by editing metadata",
      );
    const root = await fs.mkdtemp(path.join(tmpdir(), "ork-live-claude-renewal-"));
    const accountId = path.basename(home);
    const auth = randomBytes(32).toString("base64url");
    let containerId: string | undefined;
    let sessionId: string | undefined;
    let base = "";
    const docker = async (args: string[]) =>
      (
        await runCommand("docker", args, {
          timeoutMs: 30_000,
          redactValues: [auth],
          env: { ...process.env, CLAUDE_BRIDGE_TOKEN: auth },
        })
      ).stdout.trim();
    const bridge = async <T>(route: string, body?: unknown): Promise<T> => {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-orkestrator-claude-token": auth, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) throw new Error(`Live Claude bridge request failed (${response.status})`);
      return response.json() as Promise<T>;
    };
    const until = async (check: () => Promise<boolean>, timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(1_000);
      }
      throw new Error("Live Claude qualification deadline exceeded");
    };
    try {
      const version = await runCommand(path.join(toolchainBinDir, "claude"), ["--version"]);
      expect(version.stdout.includes(PINNED_TOOLCHAIN_VERSIONS.claude)).toBe(true);
      containerId = await docker([
        "create",
        "--label",
        `orkestrator-owner=claude-login-qa-${path.basename(root)}`,
        "--publish",
        "127.0.0.1::4097",
        "--env",
        "CLAUDE_BRIDGE_TOKEN",
        "--env",
        "HOSTNAME=0.0.0.0",
        "--entrypoint",
        "bash",
        image,
        "-lc",
        "mkdir -p /workspace; cd /workspace; exec bun /opt/claude-bridge/dist/index.js",
      ]);
      await docker(["start", containerId]);
      const port = (await docker(["port", containerId, "4097/tcp"])).split(":").at(-1);
      base = `http://127.0.0.1:${port}`;
      await until(async () => {
        try {
          await bridge("/global/health");
          return true;
        } catch {
          return false;
        }
      }, 30_000);
      expect(
        (await docker(["exec", containerId, "claude", "--version"])).includes(
          PINNED_TOOLCHAIN_VERSIONS.claude,
        ),
      ).toBe(true);
      await docker([
        "exec",
        containerId,
        "bash",
        "-c",
        `printf '%s' '${accountId}' > /tmp/orkestrator-claude-account`,
      ]);
      const environment = { id: "live-login-qa", containerId, status: "running" };
      const context = {
        appRoot: root,
        resourceRoot: root,
        toolchainBinDir,
        storage: {
          getDataDir: () => root,
          agentAccounts: {
            agentAccountsDirectory: () => path.dirname(path.dirname(home)),
            loadAgentAccounts: async () => ({ active: { claude: accountId }, accounts: [] }),
          },
          loadConfig: async () => ({ global: { enabledAgentPlatforms: ["claude"] } }),
          loadEnvironments: async () => [environment],
          getEnvironment: async () => environment,
        },
      } as unknown as CommandContext;
      expect(await syncContainerClaudeLogin(context, containerId)).toBe(true);
      const pid = await docker(["inspect", "-f", "{{.State.Pid}}", containerId]);
      sessionId = (await bridge<{ sessionId: string }>("/session/create", {})).sessionId;
      const seconds = Math.ceil((initial.expiresAt - Date.now()) / 1_000) + 15;
      await bridge(`/session/${sessionId}/prompt`, {
        requestId: crypto.randomUUID(),
        permissionMode: "bypassPermissions",
        prompt: `Use Bash with run_in_background=true to run: sleep ${seconds}; echo TASK-DONE. Reply STARTED now. When the task finishes, reply exactly RENEWAL-QUALIFIED. Do not read any files or run any other tools.`,
      });
      await until(async () => {
        const state = await bridge<{ backgroundTasks: Record<string, { status?: string }> }>(
          `/session/${sessionId}`,
        );
        return Object.values(state.backgroundTasks).some((task) => task.status === "running");
      }, 45_000);
      const keeper = new ContainerClaudeLoginKeeper(context, {
        readCredentials: read,
        refreshHostLogin: () => refreshHostClaudeLogin(context, { accountId, home }),
      });
      await keeper.tick();
      const renewed = JSON.parse(await read()).claudeAiOauth;
      expect(
        renewed.expiresAt > initial.expiresAt && renewed.accessToken !== initial.accessToken,
      ).toBe(true);
      // Assert in the container, returning no credentials or model content.
      await docker([
        "exec",
        containerId,
        "bash",
        "-euc",
        `test "$(stat -c %a "$HOME/.claude/.credentials.json")" = 600; jq -e '.claudeAiOauth.expiresAt > ${initial.expiresAt} and (.claudeAiOauth | has("refreshToken") | not)' "$HOME/.claude/.credentials.json" >/dev/null`,
      ]);
      await until(
        async () => Date.now() > initial.expiresAt + 10_000,
        CLAUDE_HOST_REFRESH_LEAD_MS + 30_000,
      );
      await until(async () => {
        const state = await bridge<{ status: string; error?: unknown }>(`/session/${sessionId}`);
        if (state.error || state.status === "error")
          throw new Error("Live Claude continuation failed");
        const transcript = await bridge<{
          messages: Array<{
            role: string;
            createdAt: string;
            parts: Array<{ type: string; text?: string }>;
          }>;
        }>(`/session/${sessionId}/messages`);
        return transcript.messages.some(
          (message) =>
            message.role === "assistant" &&
            Date.parse(message.createdAt) > initial.expiresAt &&
            message.parts.some(
              (part) => part.type === "text" && part.text?.trim() === "RENEWAL-QUALIFIED",
            ),
        );
      }, 90_000);
      expect(await docker(["inspect", "-f", "{{.State.Pid}}", containerId])).toBe(pid);
    } finally {
      try {
        if (sessionId) await bridge(`/session/${sessionId}/close`, {});
      } finally {
        if (containerId) await docker(["rm", "--force", containerId]);
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  },
  8 * 60_000,
);
