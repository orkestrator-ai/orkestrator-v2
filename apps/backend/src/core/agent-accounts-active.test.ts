import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  activeAgentAccountShellEnvironment,
  applyActiveAgentAccountEnvironment,
  applyCoordinatorClaudeAccount,
  localBridgeIsOnActiveAccount,
  markLocalBridgesForLoginRefresh,
} from "./agent-accounts-active.js";
import type { CommandContext } from "./commands-context.js";
import * as commandFiles from "./commands-files.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { LocalServerLaunch } from "./local-server-runtime.js";
import { prepareCoordinatorClaudeHome } from "./commands-servers.js";
import { StorageService } from "./storage.js";

const ACCOUNT_IDS = {
  claude: "11111111-2222-4333-8444-555555555555",
  codex: "66666666-7777-4888-9999-aaaaaaaaaaaa",
} as const;
const savedEnv = {
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};

let root: string;
let storage: StorageService;
let liveWork = false;
let context: CommandContext;
let restoreHostCredentialRead: (() => void) | undefined;

/**
 * Records `key` as an owned bridge launched with `launch`. Each call replaces
 * every launch fact, as a relaunch does.
 */
function launchBridge(key: string, launch: Omit<LocalServerLaunch, "workingDirectory"> = {}): void {
  context.runtime.localServers.adoptProcess(key, {} as never, {
    workingDirectory: root,
    ...launch,
  });
}

function accountHome(platform: "claude" | "codex"): string {
  return path.join(root, "data", "agent-accounts", platform, ACCOUNT_IDS[platform]);
}

async function activate(platform: "claude" | "codex" | undefined): Promise<void> {
  await storage.mutateAgentAccounts((store) => ({
    store: {
      ...store,
      accounts: [
        {
          id: ACCOUNT_IDS.claude,
          platform: "claude",
          label: "Second",
          createdAt: "2026-09-28T00:00:00Z",
        },
        {
          id: ACCOUNT_IDS.codex,
          platform: "codex",
          label: "Second",
          createdAt: "2026-09-28T00:00:00Z",
        },
      ],
      active: platform ? { [platform]: ACCOUNT_IDS[platform] } : {},
    },
    result: undefined,
  }));
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "ork-accounts-active-")));
  process.env.CODEX_HOME = path.join(root, "host-codex");
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "host-claude");
  await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
  await fs.mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  liveWork = false;
  context = {
    storage,
    // Nothing here may read the real host login.
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
    nativeAgents: { hasObservedLiveWork: async () => liveWork },
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
});

afterEach(async () => {
  restoreHostCredentialRead?.();
  restoreHostCredentialRead = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  context.runtime.shutdown();
  await fs.rm(root, { recursive: true, force: true });
});

describe("activeAgentAccountShellEnvironment", () => {
  test("is empty for host logins and names each added account's directory", async () => {
    expect(await activeAgentAccountShellEnvironment(context)).toEqual({});
    await activate("codex");
    expect(await activeAgentAccountShellEnvironment(context)).toEqual({
      CODEX_HOME: accountHome("codex"),
    });
    // The directory is ready to use: its transcripts are the host's.
    expect(await fs.readlink(path.join(accountHome("codex"), "sessions"))).toBe(
      path.join(process.env.CODEX_HOME!, "sessions"),
    );
  });
});

test("an added account clears inherited API keys before launch", async () => {
  await activate("claude");
  const env: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "host",
    ANTHROPIC_AUTH_TOKEN: "host",
    CLAUDE_CODE_OAUTH_TOKEN: "host",
    OPENAI_API_KEY: "host",
    CODEX_API_KEY: "host",
  };
  await applyActiveAgentAccountEnvironment(context, "claude", env);
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
  ]) {
    expect(env[key]).toBeUndefined();
  }
  expect(env.CLAUDE_CONFIG_DIR).toBe(accountHome("claude"));
});

describe("applyCoordinatorClaudeAccount", () => {
  test("hands over only a Keychain-backed access token with enough lifetime", async () => {
    await activate("claude");
    const coordinatorHome = path.join(root, "coordinator", "keychain-only");
    const expiresAt = Date.now() + 60 * 60_000;
    const credentials = JSON.stringify({
      claudeAiOauth: {
        accessToken: "access-only",
        refreshToken: "must-stay-private",
        expiresAt,
      },
    });
    const env: NodeJS.ProcessEnv = {};
    const account = await applyCoordinatorClaudeAccount(
      context,
      coordinatorHome,
      env,
      prepareCoordinatorClaudeHome,
      async () => credentials,
    );
    expect(account).toEqual({ accountId: ACCOUNT_IDS.claude, tokenExpiresAt: expiresAt });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("access-only");
    expect(JSON.stringify(env)).not.toContain("must-stay-private");
    await expect(fs.stat(path.join(coordinatorHome, ".credentials.json"))).rejects.toThrow();

    const soon = await applyCoordinatorClaudeAccount(
      context,
      coordinatorHome,
      {},
      prepareCoordinatorClaudeHome,
      async () =>
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "soon",
            expiresAt: Date.now() + 2 * 60_000,
          },
        }),
    );
    expect(soon).toEqual({ accountId: ACCOUNT_IDS.claude, loginless: true });
  });
  test("copies the active account's credential file and replaces an earlier one", async () => {
    await activate("claude");
    await fs.mkdir(accountHome("claude"), { recursive: true });
    await fs.writeFile(
      path.join(accountHome("claude"), ".credentials.json"),
      '{"claudeAiOauth":{"accessToken":"second"}}',
    );
    const coordinatorHome = path.join(root, "coordinator", "claude-home");
    await fs.mkdir(coordinatorHome, { recursive: true });
    await fs.writeFile(path.join(coordinatorHome, "credentials.json"), '{"stale":true}');
    const env: NodeJS.ProcessEnv = { ANTHROPIC_AUTH_TOKEN: "host-token" };

    const account = await applyCoordinatorClaudeAccount(
      context,
      coordinatorHome,
      env,
      prepareCoordinatorClaudeHome,
    );

    expect(account).toEqual({ accountId: ACCOUNT_IDS.claude });
    expect(env.CLAUDE_CONFIG_DIR).toBe(coordinatorHome);
    // The host token an agent-test profile injected would outrank the account.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(await fs.readFile(path.join(coordinatorHome, ".credentials.json"), "utf8")).toContain(
      "second",
    );
    await expect(fs.stat(path.join(coordinatorHome, "credentials.json"))).rejects.toThrow();
  });

  test("an agent-test profile without a grant never reads the host login", async () => {
    const coordinatorHome = path.join(root, "coordinator", "claude-home");
    const env: NodeJS.ProcessEnv = {};
    const account = await applyCoordinatorClaudeAccount(
      context,
      coordinatorHome,
      env,
      prepareCoordinatorClaudeHome,
    );
    expect(account).toEqual({ accountId: "default", loginless: true });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("localBridgeIsOnActiveAccount", () => {
  test("refreshes a loginless host-account coordinator only when a usable login appears and work is idle", async () => {
    // Exercise the ordinary runtime's host/Keychain boundary without reading
    // the developer's credentials. No added account means active.home is absent.
    const hostCredentialRead = spyOn(commandFiles, "readRuntimeHostClaudeCredentials");
    restoreHostCredentialRead = () => hostCredentialRead.mockRestore();
    hostCredentialRead.mockResolvedValue(undefined);
    context.runtimeFlavor = "production";
    const key = "claude:host-coordinator";
    launchBridge(key, { accountId: "default", loginless: true });

    expect(await localBridgeIsOnActiveAccount(key, "claude", "host-coordinator", context)).toBe(
      true,
    );
    expect(hostCredentialRead).toHaveBeenCalledTimes(1);

    for (const remainingMs of [-60_000, 2 * 60_000]) {
      hostCredentialRead.mockResolvedValue(
        JSON.stringify({
          claudeAiOauth: { accessToken: "host-token", expiresAt: Date.now() + remainingMs },
        }),
      );
      expect(await localBridgeIsOnActiveAccount(key, "claude", "host-coordinator", context)).toBe(
        true,
      );
    }

    const expiresAt = Date.now() + 60 * 60_000;
    hostCredentialRead.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: { accessToken: "host-token", refreshToken: "host-refresh", expiresAt },
      }),
    );
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "claude", "host-coordinator", context)).toBe(
      true,
    );
    liveWork = false;
    expect(await localBridgeIsOnActiveAccount(key, "claude", "host-coordinator", context)).toBe(
      false,
    );

    const env: NodeJS.ProcessEnv = {};
    expect(
      await applyCoordinatorClaudeAccount(
        context,
        path.join(root, "host-coordinator"),
        env,
        prepareCoordinatorClaudeHome,
      ),
    ).toEqual({
      accountId: "default",
      tokenExpiresAt: expiresAt,
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("host-token");
    expect(JSON.stringify(env)).not.toContain("host-refresh");
    expect(hostCredentialRead).toHaveBeenCalledTimes(6);
  });

  test("keeps a bridge on the active account and replaces one on another only when idle", async () => {
    const key = "codex:env-1";
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(true);

    await activate("codex");
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(false);
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(true);

    launchBridge(key, { accountId: ACCOUNT_IDS.codex });
    liveWork = false;
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(true);
    // Other platforms have no accounts.
    expect(await localBridgeIsOnActiveAccount("pi:env-1", "pi", "env-1", context)).toBe(true);
  });

  test("replaces an idle OpenCode server once a provider login changed", async () => {
    const key = "opencode:env-1";
    const { localServers } = context.runtime;
    localServers.adoptProcess(key, {} as never);
    localServers.adoptProcess("codex:env-1", {} as never);
    expect(await localBridgeIsOnActiveAccount(key, "opencode", "env-1", context)).toBe(true);
    markLocalBridgesForLoginRefresh(context, "opencode");
    expect(localServers.hasStaleLogin(key)).toBe(true);
    expect(localServers.hasStaleLogin("codex:env-1")).toBe(false);
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "opencode", "env-1", context)).toBe(true);
    liveWork = false;
    expect(await localBridgeIsOnActiveAccount(key, "opencode", "env-1", context)).toBe(false);
  });

  test("keeps a near-expiry token until a fresher one is available or it expires", async () => {
    const key = "claude:coordinator-1";
    launchBridge(key, { tokenExpiresAt: Date.now() + 60 * 60_000 });
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);

    launchBridge(key, { tokenExpiresAt: Date.now() + 60_000 });
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);
    launchBridge(key, { tokenExpiresAt: Date.now() - 1 });
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(false);
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);
  });

  test("replaces an idle coordinator once its account has a fresher token", async () => {
    await activate("claude");
    const key = "claude:coordinator-1";
    launchBridge(key, { accountId: ACCOUNT_IDS.claude, tokenExpiresAt: Date.now() + 60_000 });
    await fs.mkdir(accountHome("claude"), { recursive: true });
    await fs.writeFile(
      path.join(accountHome("claude"), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fresh-token", expiresAt: Date.now() + 60 * 60_000 },
      }),
    );
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(false);
  });

  test("replaces an idle coordinator launched without a login once one appears", async () => {
    await activate("claude");
    const key = "claude:coordinator-1";
    launchBridge(key, { accountId: ACCOUNT_IDS.claude, loginless: true });
    // Still signed out: a relaunch would not help.
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);

    // Signed in from a terminal, which Orkestrator is never told about.
    await fs.mkdir(accountHome("claude"), { recursive: true });
    await fs.writeFile(
      path.join(accountHome("claude"), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fresh-token", expiresAt: Date.now() + 60 * 60_000 },
      }),
    );
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);
    liveWork = false;
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(false);
  });
});
