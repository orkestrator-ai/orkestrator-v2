import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CLAUDE_HOST_REFRESH_MODEL, refreshHostClaudeLogin } from "./claude-host-login-refresh.js";
import {
  ContainerClaudeLoginKeeper,
  CLAUDE_HOST_REFRESH_RETRY_MS,
} from "./container-claude-login-keeper.js";
import { CommandFailedError } from "./shell.js";
import { AgentAccountsRuntime } from "./agent-accounts-runtime.js";
import type { CommandContext } from "./commands-context.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function context(runtimeFlavor?: "agent-test"): Promise<CommandContext> {
  root = await fs.mkdtemp(path.join(tmpdir(), "ork-claude-host-refresh-"));
  return {
    runtimeFlavor,
    resourceRoot: path.join(root, "resources"),
    appRoot: path.join(root, "app"),
    storage: { getDataDir: () => root! },
  } as unknown as CommandContext;
}

describe("refreshHostClaudeLogin", () => {
  test("runs the host CLI with nothing of the user's loaded and no inherited bearer token", async () => {
    const calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }> =
      [];
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "inherited-key";
    try {
      await refreshHostClaudeLogin(
        await context(),
        { accountId: "account", home: "/accounts/claude/account" },
        (async (
          command: string,
          args: string[],
          options: { env?: NodeJS.ProcessEnv; cwd?: string },
        ) => {
          calls.push({ command, args, ...options });
          throw new CommandFailedError("exit 1: model not found", { exitCode: 1 });
        }) as never,
      );
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
    expect(calls).toHaveLength(1);
    const [call] = calls;
    // No managed binary in this fixture: the CLI on PATH, the user's own.
    expect(call!.command).toBe("claude");
    expect(call!.args).toEqual([
      "-p",
      "ok",
      "--model",
      CLAUDE_HOST_REFRESH_MODEL,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--tools",
      "",
      "--no-session-persistence",
    ]);
    expect(call!.env?.CLAUDE_CONFIG_DIR).toBe("/accounts/claude/account");
    expect(call!.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call!.cwd).toBe(path.join(root!, "claude-login-refresh"));
    expect((await fs.stat(call!.cwd!)).isDirectory()).toBe(true);
  });

  for (const [reason, details] of [
    ["timeout", { timedOut: true }],
    ["executable missing", { executableMissing: true }],
    ["command failed", { exitCode: 2 }],
  ] as const) {
    test(`reports ${reason} without exposing command output`, async () => {
      await expect(
        refreshHostClaudeLogin(await context(), { accountId: "default" }, (async () => {
          throw new CommandFailedError("SECRET-OUTPUT", details);
        }) as never),
      ).rejects.toThrow(`Host Claude refresh ${reason}`);
    });
  }

  for (const details of [{ timedOut: true }, { executableMissing: true }]) {
    test(`the keeper diagnoses ${details.timedOut ? "timeout" : "missing executable"} once per backoff window`, async () => {
      const ctx = await context();
      const now = Date.now();
      Object.assign(ctx, { runtime: { accounts: new AgentAccountsRuntime() } });
      Object.assign(ctx.storage, {
        loadConfig: async () => ({ global: {} }),
        agentAccounts: { loadAgentAccounts: async () => ({ accounts: [], active: {} }) },
      });
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const keeper = new ContainerClaudeLoginKeeper(ctx, {
          now: () => now,
          readCredentials: async () =>
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "a",
                refreshToken: "r",
                expiresAt: now + CLAUDE_HOST_REFRESH_RETRY_MS,
              },
            }),
          refreshHostLogin: (account) =>
            refreshHostClaudeLogin(ctx, account, (async () => {
              throw new CommandFailedError("SECRET-OUTPUT", details);
            }) as never),
        });
        await keeper.refreshHostIfDue();
        await keeper.refreshHostIfDue();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls).toEqual([["[claude-login-keeper] Host Claude refresh failed"]]);
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("an agent-test profile never runs it", async () => {
    let ran = false;
    await expect(
      refreshHostClaudeLogin(await context("agent-test"), { accountId: "default" }, (async () => {
        ran = true;
        return { stdout: "", stderr: "" };
      }) as never),
    ).rejects.toThrow("agent-test");
    expect(ran).toBe(false);
  });
});
