import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as credentials from "./claude-host-credentials.js";
import * as shell from "./shell.js";
import { CLAUDE_HOST_REFRESH_MODEL } from "./claude-host-login-refresh.js";
import type { AgentAccountAutoSwitcherDeps } from "./agent-accounts-auto-switch.js";
import type { CommandContext } from "./commands-context.js";
import { OrkestratorBackend } from "./index.js";

const ACCOUNT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

for (const accountId of ["default", ACCOUNT_ID]) {
  test(`production auto-switch renewal runs Claude in the ${accountId === "default" ? "host" : "added account"} home`, async () => {
    // The host login is whatever the backend process inherits; an agent running
    // this suite under an added account has its own CLAUDE_CONFIG_DIR set.
    const inheritedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-renewal-wiring-"));
    const backend = new OrkestratorBackend({
      dataDir,
      toolchainBinDir: "",
      appRoot: "",
      resourceRoot: "",
      emit: () => undefined,
    });
    const { context } = backend as unknown as { context: CommandContext };
    // Keep the real renewal and refresher connected. Only the credential store
    // and process boundary are fake; no real login is read or CLI is launched.
    let refreshed = false;
    const read = spyOn(credentials, "getHostClaudeCredentials").mockImplementation(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "test-access",
          refreshToken: "test-refresh",
          expiresAt: Date.now() + (refreshed ? 3_600_000 : -60_000),
        },
      }),
    );
    const run = spyOn(shell, "runCommand").mockImplementation(async () => {
      refreshed = true;
      throw new shell.CommandFailedError("model not found", { exitCode: 1 });
    });
    try {
      await context.storage.init();
      await context.storage.agentAccounts.mutateAgentAccounts((store) => ({
        store: {
          ...store,
          accounts: [
            {
              id: ACCOUNT_ID,
              platform: "claude",
              label: "idle",
              createdAt: new Date().toISOString(),
            },
          ],
        },
        result: undefined,
      }));
      const { deps } = context.accountAutoSwitch as unknown as {
        deps: AgentAccountAutoSwitcherDeps;
      };
      expect(await deps.renewLogin!("claude", accountId)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      const [binary, args, options] = run.mock.calls[0]!;
      expect(binary).toBe("claude");
      expect(args).toContain(CLAUDE_HOST_REFRESH_MODEL);
      expect(options?.cwd).toBe(path.join(dataDir, "claude-login-refresh"));
      const home =
        accountId === "default"
          ? undefined
          : path.join(context.storage.agentAccounts.agentAccountsDirectory(), "claude", ACCOUNT_ID);
      expect(options?.env?.CLAUDE_CONFIG_DIR).toBe(home);
      // Renewal must reread the same login the CLI was asked to refresh.
      expect(read).toHaveBeenCalledTimes(2);
      expect(read.mock.calls.map((call) => call[2])).toEqual([home, home]);
      if (home) {
        expect(read.mock.calls[0]![3]).toMatchObject({
          keychainService: credentials.claudeKeychainService(home),
          configDirOnly: true,
        });
      }
    } finally {
      run.mockRestore();
      read.mockRestore();
      await backend.shutdown();
      await rm(dataDir, { recursive: true, force: true });
      if (inheritedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = inheritedConfigDir;
    }
  });
}
