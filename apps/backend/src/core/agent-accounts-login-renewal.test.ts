import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { removeAgentAccount, renewAgentAccountLogin } from "./agent-accounts.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";

const NOW = Date.parse("2026-11-03T12:00:00Z");
const ACCOUNT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

let root: string;
let context: CommandContext;

function credentials(options: { expiresInMs: number; refreshable?: boolean }): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "access-token-for-tests",
      ...(options.refreshable === false ? {} : { refreshToken: "refresh-token-for-tests" }),
      expiresAt: NOW + options.expiresInMs,
    },
  });
}

const LAPSED = credentials({ expiresInMs: -60_000 });
const LIVE = credentials({ expiresInMs: 8 * 3_600_000 });

/** A login whose stored credentials change from `before` to `after` once `claude` ran. */
function login(before: string | undefined, after: string | undefined = before) {
  let refreshed = false;
  const refresh = mock(async (_account: { accountId: string; home?: string }) => {
    refreshed = true;
  });
  const readCredentials = mock(async (_home: string | undefined) => (refreshed ? after : before));
  return { refresh, readCredentials, now: () => NOW };
}

async function addClaudeAccount(): Promise<void> {
  await context.storage.agentAccounts.mutateAgentAccounts((store) => ({
    store: {
      ...store,
      accounts: [
        ...store.accounts,
        {
          id: ACCOUNT_ID,
          platform: "claude",
          label: "idle@example.com",
          createdAt: new Date(NOW).toISOString(),
        },
      ],
    },
    result: undefined,
  }));
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-login-renewal-")));
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  // Not an agent-test profile, which never renews; every credential read is
  // injected, so nothing reaches the real Keychain.
  context = {
    storage,
    runtime: new BackendRuntime({ emit: () => undefined }),
    emit: () => undefined,
  } as unknown as CommandContext;
  await addClaudeAccount();
});

afterEach(async () => {
  context.runtime.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

describe("renewing an idle account's sign-in", () => {
  test("a lapsed login is renewed by Claude Code in the account's own directory", async () => {
    const run = login(LAPSED, LIVE);
    expect(await renewAgentAccountLogin(context, "claude", ACCOUNT_ID, run)).toBe(true);
    expect(run.refresh).toHaveBeenCalledTimes(1);
    const account = run.refresh.mock.calls[0]![0];
    expect(account.accountId).toBe(ACCOUNT_ID);
    expect(account.home).toContain(ACCOUNT_ID);
    expect(run.readCredentials.mock.calls.map(([home]) => home)).toEqual([
      account.home,
      account.home,
    ]);
  });

  test("the host login is renewed with no directory override", async () => {
    const run = login(LAPSED, LIVE);
    expect(await renewAgentAccountLogin(context, "claude", "default", run)).toBe(true);
    expect(run.refresh.mock.calls[0]![0]).toEqual({ accountId: "default" });
  });

  test("a live login needs nothing", async () => {
    const run = login(LIVE);
    expect(await renewAgentAccountLogin(context, "claude", ACCOUNT_ID, run)).toBe(true);
    expect(run.refresh).not.toHaveBeenCalled();
  });

  test("a signed-out login is left alone", async () => {
    for (const before of [undefined, credentials({ expiresInMs: -60_000, refreshable: false })]) {
      const run = login(before, LIVE);
      expect(await renewAgentAccountLogin(context, "claude", ACCOUNT_ID, run)).toBe(false);
      expect(run.refresh).not.toHaveBeenCalled();
    }
  });

  test("a renewal that fails or does not extend the token reports false", async () => {
    const failing = login(LAPSED, LIVE);
    failing.refresh.mockImplementation(async () => {
      throw new Error("Host Claude refresh timeout");
    });
    expect(await renewAgentAccountLogin(context, "claude", ACCOUNT_ID, failing)).toBe(false);

    const unchanged = login(LAPSED, LAPSED);
    expect(await renewAgentAccountLogin(context, "claude", ACCOUNT_ID, unchanged)).toBe(false);
    expect(unchanged.refresh).toHaveBeenCalledTimes(1);
  });

  test("Codex, agent-test profiles and unknown accounts are never renewed", async () => {
    const run = login(LAPSED, LIVE);
    expect(await renewAgentAccountLogin(context, "codex", ACCOUNT_ID, run)).toBe(false);
    expect(
      await renewAgentAccountLogin(
        { ...context, runtimeFlavor: "agent-test" } as CommandContext,
        "claude",
        ACCOUNT_ID,
        run,
      ),
    ).toBe(false);
    expect(
      await renewAgentAccountLogin(context, "claude", "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f", run),
    ).toBe(false);
    expect(run.refresh).not.toHaveBeenCalled();
    expect(run.readCredentials).not.toHaveBeenCalled();
  });

  test("the host login is not renewed while host credentials are turned off", async () => {
    const config = await context.storage.loadConfig();
    await context.storage.saveConfig({
      ...config,
      global: { ...config.global, useHostClaudeCredentials: false },
    });
    const run = login(LAPSED, LIVE);
    expect(await renewAgentAccountLogin(context, "claude", "default", run)).toBe(false);
    expect(run.refresh).not.toHaveBeenCalled();
  });

  test("removal waits out a renewal running in the account's directory", async () => {
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = login(LAPSED, LIVE);
    const renewed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const renewing = renewAgentAccountLogin(context, "claude", ACCOUNT_ID, {
      ...run,
      refresh: async (account) => {
        started();
        await renewed;
        await run.refresh(account);
      },
    });
    await running;
    await expect(removeAgentAccount(context, "claude", ACCOUNT_ID)).rejects.toThrow(
      "renewing this account's sign-in",
    );
    release();
    expect(await renewing).toBe(true);
    const snapshot = await removeAgentAccount(context, "claude", ACCOUNT_ID);
    expect(snapshot.accounts.some((account) => account.id === ACCOUNT_ID)).toBe(false);
  });
});
