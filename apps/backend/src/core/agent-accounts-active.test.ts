import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  activeAgentAccountShellEnvironment,
  applyActiveAgentAccountEnvironment,
  applyCoordinatorClaudeAccount,
  coordinatorCodexLogin,
  localBridgeIsOnActiveAccount,
  markLocalBridgesForLoginRefresh,
  setLocalClaudeLoginRefresher,
  setLocalCodexLoginRefresher,
  readCoordinatorCodexLogin,
} from "./agent-accounts-active.js";
import type { CommandContext } from "./commands-context.js";
import * as commandFiles from "./commands-files.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { LocalServerLaunch } from "./local-server-runtime.js";

import { prepareCoordinatorClaudeHome, prepareCoordinatorCodexHome } from "./commands-servers.js";
import { createCodexLoginRefresher } from "./codex-host-login-refresh.js";
import { claudeKeychainService } from "./agent-accounts-homes.js";
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
const noKeychain = async (): Promise<void> => undefined;

/** A JWT-shaped token whose `exp` claim is `expiresAt`. Never a real credential. */
function fakeJwt(expiresAt: number, marker: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: Math.floor(expiresAt / 1000), marker })}.sig`;
}

/** A Codex ChatGPT login whose access token expires at `expiresAt`. */
function codexAuth(expiresAt: number, marker = "login"): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt(expiresAt, `${marker}-id`),
      access_token: fakeJwt(expiresAt, marker),
      refresh_token: `refresh-${marker}`,
      account_id: `account-${marker}`,
    },
    last_refresh: "2026-10-01T00:00:00.000Z",
  });
}

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
  setLocalCodexLoginRefresher(undefined);
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
      noKeychain,
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
      noKeychain,
    );
    expect(soon).toEqual({ accountId: ACCOUNT_IDS.claude, loginless: true });
  });
  test("hands over a file login's access token and never copies the file", async () => {
    await activate("claude");
    await fs.mkdir(accountHome("claude"), { recursive: true });
    const expiresAt = Date.now() + 60 * 60_000;
    await fs.writeFile(
      path.join(accountHome("claude"), ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "second", refreshToken: "account-refresh", expiresAt },
      }),
    );
    const coordinatorHome = path.join(root, "coordinator", "claude-home");
    await fs.mkdir(coordinatorHome, { recursive: true });
    // Earlier builds copied a login in; it must not survive the launch.
    await fs.writeFile(
      path.join(coordinatorHome, ".credentials.json"),
      '{"claudeAiOauth":{"accessToken":"stale","refreshToken":"stale-refresh"}}',
    );
    await fs.writeFile(path.join(coordinatorHome, "credentials.json"), '{"stale":true}');
    const env: NodeJS.ProcessEnv = { ANTHROPIC_AUTH_TOKEN: "host-token" };

    const account = await applyCoordinatorClaudeAccount(
      context,
      coordinatorHome,
      env,
      prepareCoordinatorClaudeHome,
      (home) => fs.readFile(path.join(home, ".credentials.json"), "utf8"),
      noKeychain,
    );

    expect(account).toEqual({ accountId: ACCOUNT_IDS.claude, tokenExpiresAt: expiresAt });
    expect(env.CLAUDE_CONFIG_DIR).toBe(coordinatorHome);
    // The host token an agent-test profile injected would outrank the account.
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("second");
    expect(JSON.stringify(env)).not.toContain("account-refresh");
    expect(await fs.readdir(coordinatorHome)).toEqual([]);
  });

  test("refreshes a lapsed login before handing over its token", async () => {
    await activate("claude");
    const expiresAt = Date.now() + 60 * 60_000;
    let credentials = JSON.stringify({
      claudeAiOauth: { accessToken: "old", refreshToken: "r", expiresAt: Date.now() - 60_000 },
    });
    let refreshes = 0;
    setLocalClaudeLoginRefresher(async () => {
      refreshes += 1;
      credentials = JSON.stringify({
        claudeAiOauth: { accessToken: "renewed", refreshToken: "r2", expiresAt },
      });
    });
    context.runtimeFlavor = "production";
    try {
      const env: NodeJS.ProcessEnv = {};
      const account = await applyCoordinatorClaudeAccount(
        context,
        path.join(root, "coordinator", "lapsed"),
        env,
        prepareCoordinatorClaudeHome,
        async () => credentials,
        noKeychain,
      );
      expect(refreshes).toBe(1);
      expect(account).toEqual({ accountId: ACCOUNT_IDS.claude, tokenExpiresAt: expiresAt });
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("renewed");

      // A login with no refresh token is not worth asking about.
      credentials = JSON.stringify({
        claudeAiOauth: { accessToken: "old", expiresAt: Date.now() - 60_000 },
      });
      expect(
        await applyCoordinatorClaudeAccount(
          context,
          path.join(root, "coordinator", "lapsed"),
          {},
          prepareCoordinatorClaudeHome,
          async () => credentials,
          noKeychain,
        ),
      ).toEqual({ accountId: ACCOUNT_IDS.claude, loginless: true });
      expect(refreshes).toBe(1);
    } finally {
      setLocalClaudeLoginRefresher(undefined);
    }
  });

  test("uses an agent-test profile's own file login, never the Keychain", async () => {
    const profileDir = path.join(root, "profile-claude");
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(
      path.join(profileDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "profile", refreshToken: "profile-r" } }),
    );
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: profileDir };
    const account = await applyCoordinatorClaudeAccount(
      context,
      path.join(root, "coordinator", "profile"),
      env,
      prepareCoordinatorClaudeHome,
      undefined,
      noKeychain,
    );
    expect(account).toEqual({ accountId: "default" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("profile");
    expect(JSON.stringify(env)).not.toContain("profile-r");
  });

  test("an agent-test profile without a grant never reads the host login", async () => {
    const coordinatorHome = path.join(root, "coordinator", "claude-home");
    const env: NodeJS.ProcessEnv = {};
    const account = await applyCoordinatorClaudeAccount(
      context,
      coordinatorHome,
      env,
      prepareCoordinatorClaudeHome,
      undefined,
      noKeychain,
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
        undefined,
        noKeychain,
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

  test("replaces an idle Codex coordinator once its token nears expiry and a fresher one exists", async () => {
    await activate("codex");
    const key = "codex:coordinator-1";
    const handedOver = Date.now() + 60_000;
    launchBridge(key, { accountId: ACCOUNT_IDS.codex, tokenExpiresAt: handedOver });
    await fs.mkdir(accountHome("codex"), { recursive: true });
    // The account's own login has not been refreshed: nothing better to hand over.
    await fs.writeFile(path.join(accountHome("codex"), "auth.json"), codexAuth(handedOver));
    expect(await localBridgeIsOnActiveAccount(key, "codex", "coordinator-1", context)).toBe(true);

    await fs.writeFile(
      path.join(accountHome("codex"), "auth.json"),
      codexAuth(Date.now() + 10 * 24 * 60 * 60_000, "fresh"),
    );
    liveWork = true;
    expect(await localBridgeIsOnActiveAccount(key, "codex", "coordinator-1", context)).toBe(true);
    liveWork = false;
    expect(await localBridgeIsOnActiveAccount(key, "codex", "coordinator-1", context)).toBe(false);
  });

  test("replaces an idle Codex coordinator launched without a login once one appears", async () => {
    await activate("codex");
    const key = "codex:coordinator-1";
    launchBridge(key, { accountId: ACCOUNT_IDS.codex, loginless: true });
    expect(await localBridgeIsOnActiveAccount(key, "codex", "coordinator-1", context)).toBe(true);

    await fs.mkdir(accountHome("codex"), { recursive: true });
    await fs.writeFile(
      path.join(accountHome("codex"), "auth.json"),
      codexAuth(Date.now() + 60 * 60_000),
    );
    expect(await localBridgeIsOnActiveAccount(key, "codex", "coordinator-1", context)).toBe(false);
  });
});

describe("prepareCoordinatorCodexHome", () => {
  test("hands over the access token without the refresh token and records its expiry", async () => {
    const expiresAt = Date.now() + 60 * 60_000;
    const source = path.join(root, "codex-source");
    const destination = path.join(root, "codex-coordinator");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "auth.json"), codexAuth(expiresAt));

    const login = await prepareCoordinatorCodexHome(destination, source);
    expect(login).toEqual({ tokenExpiresAt: Math.floor(expiresAt / 1000) * 1000 });
    const copied = JSON.parse(await fs.readFile(path.join(destination, "auth.json"), "utf8"));
    expect(copied.tokens.access_token).toBe(JSON.parse(codexAuth(expiresAt)).tokens.access_token);
    expect(copied.tokens.refresh_token).toBe("");
    expect(JSON.stringify(copied)).not.toContain("refresh-login");
    expect((await fs.stat(path.join(destination, "auth.json"))).mode & 0o777).toBe(0o600);
    // The account's own login is untouched.
    expect(await fs.readFile(path.join(source, "auth.json"), "utf8")).toBe(codexAuth(expiresAt));
  });

  test("starts signed out rather than hand over a token about to lapse", async () => {
    const source = path.join(root, "codex-source");
    const destination = path.join(root, "codex-coordinator");
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "auth.json"), "earlier login");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "auth.json"), codexAuth(Date.now() + 60_000));

    expect(await prepareCoordinatorCodexHome(destination, source)).toEqual({ loginless: true });
    await expect(fs.access(path.join(destination, "auth.json"))).rejects.toThrow();
    expect(await prepareCoordinatorCodexHome(destination, path.join(root, "absent"))).toEqual({
      loginless: true,
    });
  });

  test("keeps an API key login, which never expires", () => {
    const raw = JSON.stringify({ OPENAI_API_KEY: "sk-test-key" });
    expect(coordinatorCodexLogin(raw)).toEqual({ text: raw });
  });
});

test("renews an expired owner login without ordinary sessions before the coordinator handoff", async () => {
  await activate("codex");
  const home = accountHome("codex");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "auth.json"), codexAuth(Date.now() - 60_000));
  let calls = 0;
  const production = { ...context, runtimeFlavor: "production" } as CommandContext;
  setLocalCodexLoginRefresher(
    createCodexLoginRefresher(production, async (owner) => {
      calls++;
      expect(owner).toBe(home);
      await fs.writeFile(
        path.join(owner, "auth.json"),
        codexAuth(Date.now() + 3600_000, "renewed"),
      );
    }),
  );
  const destination = path.join(root, "coordinator-codex");
  const [login] = await Promise.all([
    prepareCoordinatorCodexHome(destination, home),
    readCoordinatorCodexLogin({ accountId: ACCOUNT_IDS.codex, home }),
  ]);
  expect(login.loginless).toBeUndefined();
  expect(calls).toBe(1);
  const owner = JSON.parse(await fs.readFile(path.join(home, "auth.json"), "utf8"));
  const copy = JSON.parse(await fs.readFile(path.join(destination, "auth.json"), "utf8"));
  expect(owner.tokens.refresh_token).toBe("refresh-renewed");
  expect(copy.tokens.access_token).toBe(owner.tokens.access_token);
  expect(copy.tokens.refresh_token).toBe("");
  // The following turn can use the renewed token and does not spend it again.
  expect(
    (await readCoordinatorCodexLogin({ accountId: ACCOUNT_IDS.codex, home })).text,
  ).toBeTruthy();
  expect(calls).toBe(1);
});

test("macOS removes only each coordinator home's Keychain login, once per home", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  const removed: string[] = [];
  try {
    for (const name of ["one", "one", "two"]) {
      await applyCoordinatorClaudeAccount(
        context,
        path.join(root, name),
        {},
        prepareCoordinatorClaudeHome,
        async () => undefined,
        async (service) => {
          removed.push(service);
        },
      );
    }
    expect(removed).toEqual([
      claudeKeychainService(path.join(root, "one")),
      claudeKeychainService(path.join(root, "two")),
    ]);
    expect(removed).not.toContain(claudeKeychainService(accountHome("claude")));
    expect(removed).not.toContain("Claude Code-credentials");
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("a due Codex coordinator renews its owning login on reuse and moves only while idle", async () => {
  await activate("codex");
  const home = accountHome("codex");
  const key = "codex:renew-on-use";
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, "auth.json"), codexAuth(Date.now() + 60_000));
  launchBridge(key, { accountId: ACCOUNT_IDS.codex, tokenExpiresAt: Date.now() + 60_000 });
  let refreshes = 0;
  setLocalCodexLoginRefresher(
    createCodexLoginRefresher({ ...context, runtimeFlavor: "production" }, async (owner) => {
      refreshes++;
      await fs.writeFile(path.join(owner, "auth.json"), codexAuth(Date.now() + 3600_000));
    }),
  );
  liveWork = true;
  expect(await localBridgeIsOnActiveAccount(key, "codex", "renew-on-use", context)).toBe(true);
  liveWork = false;
  expect(await localBridgeIsOnActiveAccount(key, "codex", "renew-on-use", context)).toBe(false);
  expect(refreshes).toBe(1);
});

test("real keeper refreshes the 4m30s handoff gap before a coordinator starts", async () => {
  const { ContainerClaudeLoginKeeper } = await import("./container-claude-login-keeper.js");
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  await activate("claude");
  context.runtimeFlavor = undefined;
  let credentials = JSON.stringify({
    claudeAiOauth: { accessToken: "old", refreshToken: "owner-refresh", expiresAt: now + 270_000 },
  });
  let refreshes = 0;
  const keeper = new ContainerClaudeLoginKeeper(context, {
    now: () => now,
    readLocalCredentials: async () => credentials,
    refreshHostLogin: async () => {
      refreshes++;
      credentials = JSON.stringify({
        claudeAiOauth: {
          accessToken: "renewed",
          refreshToken: "new-owner-refresh",
          expiresAt: now + 8 * 3600_000,
        },
      });
    },
  });
  setLocalClaudeLoginRefresher(() => keeper.refreshLocalLoginIfDue());
  try {
    const env: NodeJS.ProcessEnv = {};
    const result = await applyCoordinatorClaudeAccount(
      context,
      path.join(root, "coordinator"),
      env,
      prepareCoordinatorClaudeHome,
      async () => credentials,
      noKeychain,
    );
    expect(refreshes).toBe(1);
    expect(result.loginless).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("renewed");
    expect(JSON.stringify(env)).not.toContain("owner-refresh");
  } finally {
    clock.mockRestore();
    setLocalClaudeLoginRefresher(undefined);
  }
});

test.skipIf(process.platform !== "darwin")(
  "cleans an actual isolated coordinator Keychain entry before launch",
  async () => {
    const { runCommand } = await import("./shell.js");
    const { claudeKeychainService } = await import("./agent-accounts-homes.js");
    const home = path.join(root, "keychain-coordinator");
    const service = claudeKeychainService(home);
    // This uniquely named disposable entry belongs only to this test.
    await runCommand("security", [
      "add-generic-password",
      "-a",
      "ork-account-test",
      "-s",
      service,
      "-w",
      "test-only",
    ]);
    try {
      await applyCoordinatorClaudeAccount(
        context,
        home,
        {},
        prepareCoordinatorClaudeHome,
        async () => undefined,
      );
      await expect(
        runCommand("security", ["find-generic-password", "-s", service]),
      ).rejects.toThrow();
    } finally {
      await runCommand("security", ["delete-generic-password", "-s", service]).catch(
        () => undefined,
      );
    }
  },
);

test("keeper reads the real active added-account path to renew a loginless local bridge", async () => {
  const { ContainerClaudeLoginKeeper } = await import("./container-claude-login-keeper.js");
  await activate("claude");
  context.runtimeFlavor = undefined;
  const home = accountHome("claude");
  await fs.mkdir(home, { recursive: true });
  const credentialsPath = path.join(home, ".credentials.json");
  await fs.writeFile(
    credentialsPath,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: "old",
        refreshToken: "account-refresh",
        expiresAt: Date.now() + 270_000,
      },
    }),
  );
  const key = "claude:env-loginless";
  launchBridge(key, { accountId: ACCOUNT_IDS.claude, loginless: true });
  const refreshed: string[] = [];
  const keeper = new ContainerClaudeLoginKeeper(context, {
    refreshHostLogin: async (account) => {
      refreshed.push(account.home!);
      await fs.writeFile(
        credentialsPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "fresh",
            refreshToken: "renewed-private",
            expiresAt: Date.now() + 8 * 3600_000,
          },
        }),
      );
    },
  });
  setLocalClaudeLoginRefresher(() => keeper.refreshLocalLoginIfDue());
  expect(await localBridgeIsOnActiveAccount(key, "claude", "env-loginless", context)).toBe(false);
  expect(refreshed).toEqual([home]);
  liveWork = true;
  expect(await localBridgeIsOnActiveAccount(key, "claude", "env-loginless", context)).toBe(true);
});

test("keeper's local default path reads host credentials only outside agent-test profiles", async () => {
  const { ContainerClaudeLoginKeeper } = await import("./container-claude-login-keeper.js");
  const host = spyOn(commandFiles, "readRuntimeHostClaudeCredentials").mockResolvedValue(
    JSON.stringify({
      claudeAiOauth: { accessToken: "host", expiresAt: Date.now() + 8 * 3600_000 },
    }),
  );
  try {
    const keeper = new ContainerClaudeLoginKeeper(context);
    expect(await keeper.refreshLocalLoginIfDue()).toBeUndefined();
    expect(host).not.toHaveBeenCalled();
    context.runtimeFlavor = undefined;
    expect((await keeper.refreshLocalLoginIfDue())?.expiresAt).toBeGreaterThan(Date.now());
    expect(host).toHaveBeenCalledTimes(1);
  } finally {
    host.mockRestore();
  }
});
