import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  activeAgentAccountShellEnvironment,
  applyActiveAgentAccountEnvironment,
  applyCoordinatorClaudeAccount,
  localBridgeIsOnActiveAccount,
} from "./agent-accounts-active.js";
import type { CommandContext } from "./commands-context.js";
import {
  localAgentAccountIds,
  localAgentAccountTokenExpiry,
} from "./agent-account-bridge-state.js";
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
  } as unknown as CommandContext;
  localAgentAccountIds.clear();
  localAgentAccountTokenExpiry.clear();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  localAgentAccountIds.clear();
  localAgentAccountTokenExpiry.clear();
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
    expect(soon.tokenExpiresAt).toBeUndefined();
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
    expect(account).toEqual({ accountId: "default" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("localBridgeIsOnActiveAccount", () => {
  test("keeps a bridge on the active account and replaces one on another only when idle", async () => {
    const key = "codex:env-1";
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(true);

    await activate("codex");
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(false);
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(true);

    localAgentAccountIds.set(key, ACCOUNT_IDS.codex);
    liveWork = false;
    expect(await localBridgeIsOnActiveAccount(key, "codex", "env-1", context)).toBe(true);
    // Other platforms have no accounts.
    expect(await localBridgeIsOnActiveAccount("pi:env-1", "pi", "env-1", context)).toBe(true);
  });

  test("keeps a near-expiry token until a fresher one is available or it expires", async () => {
    const key = "claude:coordinator-1";
    localAgentAccountTokenExpiry.set(key, Date.now() + 60 * 60_000);
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);

    localAgentAccountTokenExpiry.set(key, Date.now() + 60_000);
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);
    localAgentAccountTokenExpiry.set(key, Date.now() - 1);
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(false);
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(true);
  });

  test("replaces an idle coordinator once its account has a fresher token", async () => {
    await activate("claude");
    const key = "claude:coordinator-1";
    localAgentAccountIds.set(key, ACCOUNT_IDS.claude);
    localAgentAccountTokenExpiry.set(key, Date.now() + 60_000);
    await fs.mkdir(accountHome("claude"), { recursive: true });
    await fs.writeFile(
      path.join(accountHome("claude"), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "fresh-token", expiresAt: Date.now() + 60 * 60_000 },
      }),
    );
    expect(await localBridgeIsOnActiveAccount(key, "claude", "coordinator-1", context)).toBe(false);
  });
});
