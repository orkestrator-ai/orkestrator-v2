import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_AGENT_ACCOUNT_ID,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";
import { jwtExpiryMs, restrictCodexAuthSnapshot } from "@orkestrator/protocol/login-snapshots";

import type { CommandContext } from "./commands-context.js";
import {
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  readRuntimeHostClaudeCredentials,
} from "./commands-files.js";
import {
  agentAccountHome,
  claudeKeychainService,
  hostAgentAccountSources,
  prepareAgentAccountHome,
  readCodexAuthFile,
} from "./agent-accounts-homes.js";
import { INHERITED_CREDENTIAL_ENV } from "./agent-accounts-login.js";
import { initializeActivePlanUsageAccount } from "./plan-usage-cache.js";
import { runCommand } from "./shell.js";

/** The account a platform's launches use: the host login, or an added account's directory. */
export interface ResolvedAgentAccount {
  accountId: string;
  /** Absent for the host login, which launches with no directory override. */
  home?: string;
  /** Captured with the identity and home, so copied logins cannot acquire a newer marker. */
  loginGeneration?: string;
}

export function stripInheritedAgentCredentials(env: NodeJS.ProcessEnv): void {
  for (const key of INHERITED_CREDENTIAL_ENV) delete env[key];
}

export async function resolveActiveAgentAccount(
  context: CommandContext,
  platform: AgentAccountPlatform,
): Promise<ResolvedAgentAccount> {
  const store = await context.storage.loadAgentAccounts();
  const accountId = store.active[platform];
  initializeActivePlanUsageAccount(platform, accountId ?? DEFAULT_AGENT_ACCOUNT_ID);
  const loginGeneration = store.loginGeneration?.[platform];
  return {
    accountId: accountId ?? DEFAULT_AGENT_ACCOUNT_ID,
    ...(accountId
      ? { home: agentAccountHome(context.storage.agentAccountsDirectory(), platform, accountId) }
      : {}),
    ...(loginGeneration ? { loginGeneration } : {}),
  };
}

/** Read by the Codex bridge (`bridges/codex-bridge/src/bridge-state-dir.ts`). */
export const CODEX_BRIDGE_STATE_DIR_ENV = "CODEX_BRIDGE_STATE_DIR";

/**
 * Point a Claude or Codex bridge's environment at the active account.
 *
 * The host login changes nothing, so a user who never adds an account
 * launches exactly as before. An added account refreshes its directory's
 * links and MCP settings first, and drops the bearer tokens an agent-test
 * profile may have injected for the host login, which the CLI would otherwise
 * prefer over the account's own credential. Returns the account id so the
 * caller can tell later whether the bridge is still on the active account.
 *
 * The Codex bridge keeps the record that ties a tab to its thread under its
 * `CODEX_HOME`, so on an added account it is pointed at the host login's
 * (`CODEX_BRIDGE_STATE_DIR`): a bridge replaced after a switch then finds the
 * tab's session instead of starting an empty one. Claude's bridge keeps its
 * records under HOME, which no account changes.
 */
export async function applyActiveAgentAccountEnvironment(
  context: CommandContext,
  platform: AgentAccountPlatform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  if (platform === "codex") delete env[CODEX_BRIDGE_STATE_DIR_ENV];
  const active = await resolveActiveAgentAccount(context, platform);
  if (!active.home) return active.accountId;
  const sources = hostAgentAccountSources();
  await prepareAgentAccountHome(platform, active.home, sources);
  stripInheritedAgentCredentials(env);
  if (platform === "claude") {
    env.CLAUDE_CONFIG_DIR = active.home;
  } else {
    env.CODEX_HOME = active.home;
    env[CODEX_BRIDGE_STATE_DIR_ENV] = path.join(sources.codexHome, "orkestrator-bridge");
  }
  return active.accountId;
}

/**
 * Whether a running local bridge may keep serving, as far as accounts go.
 *
 * A bridge launched on another account is replaced on its next use, which is
 * what makes a switch take effect without killing anything up front. One with
 * observed live work is left alone: replacing it would kill a running turn or
 * its background work, so it moves over once idle. A coordinator bridge that
 * was handed a short-lived token is replaced once a fresher login is available
 * or the token actually expires. One launched with no login at all is replaced
 * once the account has a token, however the user signed in.
 */
export async function localBridgeIsOnActiveAccount(
  key: string,
  kind: string,
  environmentId: string,
  context: CommandContext,
): Promise<boolean> {
  const localServers = context.runtime.localServers;
  if (kind === "opencode") {
    // OpenCode has no accounts, but a server keeps the provider credentials it
    // loaded until restarted, so a provider signed in from the app since
    // launch moves it over once idle.
    if (!localServers.hasStaleLogin(key)) return true;
    return (await context.nativeAgents?.hasObservedLiveWork(environmentId, kind)) === true;
  }
  if (kind !== "claude" && kind !== "codex") return true;
  const launchedWith = localServers.launchedAccountId(key) ?? DEFAULT_AGENT_ACCOUNT_ID;
  const active = await resolveActiveAgentAccount(context, kind);
  const tokenExpiresAt = localServers.launchedTokenExpiry(key);
  const tokenLapsed =
    tokenExpiresAt !== undefined && Date.now() >= tokenExpiresAt - TOKEN_REPLACEMENT_LEAD_MS;
  // Signed in again since launch: the bridge's login is out of date even
  // though it is on the right account.
  if (launchedWith === active.accountId && !localServers.hasStaleLogin(key)) {
    if (localServers.isLoginless(key)) {
      // It answers "Not logged in" to everything; relaunching only helps once
      // the account has a token to hand over.
      const usable =
        kind === "claude"
          ? Boolean(
              (await readUsableClaudeLogin(context, active, readAddedClaudeCredentials)).token,
            )
          : (await readCoordinatorCodexLogin(active)).text !== undefined;
      if (!usable) return true;
      return (await context.nativeAgents?.hasObservedLiveWork(environmentId, kind)) === true;
    }
    if (tokenExpiresAt === undefined || !tokenLapsed) return true;
    const fresh =
      kind === "claude"
        ? await readFreshClaudeTokenExpiry(context, active)
        : (await readCoordinatorCodexLogin(active)).tokenExpiresAt;
    // A lapsed lead window is only a reason to relaunch when there is a
    // better token to hand over. Keep the existing bridge until actual expiry.
    if (!fresh || fresh <= tokenExpiresAt) {
      if (Date.now() < tokenExpiresAt) return true;
    }
  }
  return (await context.nativeAgents?.hasObservedLiveWork(environmentId, kind)) === true;
}

/** The active Claude login's expiry, when it holds a token that outlives the replacement lead. */
async function readFreshClaudeTokenExpiry(
  context: CommandContext,
  active: ResolvedAgentAccount,
): Promise<number | undefined> {
  const credentials = await readActiveClaudeCredentials(context, active);
  if (!getClaudeOAuthAccessToken(credentials, Date.now() + TOKEN_REPLACEMENT_LEAD_MS)) {
    return undefined;
  }
  return claudeCredentialExpiry(credentials);
}

/** How long before a handed-over token expires its idle bridge is replaced. */
export const TOKEN_REPLACEMENT_LEAD_MS = 5 * 60_000;

/**
 * The platform's login was renewed (for OpenCode, any provider login changed).
 * Every live local bridge may hold the old one, so each is replaced the next
 * time it is used while idle.
 */
export function markLocalBridgesForLoginRefresh(
  context: CommandContext,
  platform: AgentAccountPlatform | "opencode",
): void {
  context.runtime.localServers.markLoginStale(platform);
}

/** Whether any live local bridge was launched on this account. */
export function isAgentAccountInUseByLocalBridge(
  context: CommandContext,
  platform: AgentAccountPlatform,
  accountId: string,
): boolean {
  return context.runtime.localServers.isAccountInUse(platform, accountId);
}

/**
 * Variables that point `claude` and `codex` started from an Orkestrator
 * terminal at the active accounts. Empty for host logins, so a terminal
 * inherits the user's own environment exactly as before.
 */
export async function activeAgentAccountShellEnvironment(
  context: CommandContext,
): Promise<{ CLAUDE_CONFIG_DIR?: string; CODEX_HOME?: string }> {
  const [claude, codex] = await Promise.all([
    resolveActiveAgentAccount(context, "claude"),
    resolveActiveAgentAccount(context, "codex"),
  ]);
  if (claude.home) await prepareAgentAccountHome("claude", claude.home);
  if (codex.home) await prepareAgentAccountHome("codex", codex.home);
  return {
    ...(claude.home ? { CLAUDE_CONFIG_DIR: claude.home } : {}),
    ...(codex.home ? { CODEX_HOME: codex.home } : {}),
  };
}

/**
 * An added Claude account's stored login: its own Keychain entry on macOS,
 * then `.credentials.json` in its directory. Never the host login.
 */
export async function readAddedClaudeCredentials(home: string): Promise<string | undefined> {
  return getHostClaudeCredentials(process.platform, os.homedir(), home, {
    keychainService: claudeKeychainService(home),
    configDirOnly: true,
    allowDefaultKeychainSearchList: true,
  });
}

/** The active Claude login: the added account's, or the host's outside an agent-test profile. */
async function readActiveClaudeCredentials(
  context: CommandContext,
  active: ResolvedAgentAccount,
  readCredentials: (home: string) => Promise<string | undefined> = readAddedClaudeCredentials,
  profileConfigDir?: string,
): Promise<string | undefined> {
  if (active.home) return readCredentials(active.home);
  // An agent-test profile reads the host login only through its own grant,
  // which `applyClaudeHostCredentialEnvironment` has already applied. Its own
  // isolated directory's file login is its own, and never the Keychain's.
  if (context.runtimeFlavor === "agent-test") {
    return profileConfigDir
      ? getHostClaudeCredentials("linux", os.homedir(), profileConfigDir, { configDirOnly: true })
      : undefined;
  }
  return readRuntimeHostClaudeCredentials();
}

export async function readAddedCodexAuth(home: string): Promise<string | undefined> {
  return readCodexAuthFile(home);
}

/** The Codex home the host login lives in, as the plan reader has always resolved it. */
export function runtimeHostCodexHome(): string {
  const home = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME?.trim() || os.homedir();
  return process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
}

function claudeCredentialExpiry(credentials: string | undefined): number | undefined {
  try {
    const expiresAt = (JSON.parse(credentials ?? "") as { claudeAiOauth?: { expiresAt?: unknown } })
      .claudeAiOauth?.expiresAt;
    return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : undefined;
  } catch {
    return undefined;
  }
}

export interface CoordinatorAgentAccount {
  accountId: string;
  /** Set when the bridge runs on a short-lived access token rather than a login. */
  tokenExpiresAt?: number;
  /** Set when there was no login to hand over, so the bridge will report signed out. */
  loginless?: true;
}

/**
 * Asks the backend's login keeper to have Claude refresh the active login when
 * it is due (`ContainerClaudeLoginKeeper.refreshLocalLoginIfDue`). Registered
 * by the backend; absent in tests and tools that never refresh.
 */
let localClaudeLoginRefresher: (() => Promise<unknown>) | undefined;

export function setLocalClaudeLoginRefresher(
  refresher: (() => Promise<unknown>) | undefined,
): void {
  localClaudeLoginRefresher = refresher;
}

function isRefreshableClaudeLogin(credentials: string | undefined): boolean {
  try {
    const refreshToken = (
      JSON.parse(credentials ?? "") as { claudeAiOauth?: { refreshToken?: unknown } }
    ).claudeAiOauth?.refreshToken;
    return typeof refreshToken === "string" && refreshToken.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * The active login and an access token from it that will outlive a bridge
 * start. A login whose token lapsed while nothing used it is refreshed first,
 * through Claude's own CLI, so a coordinator does not start signed out just
 * because the host's `claude` was idle.
 */
async function readUsableClaudeLogin(
  context: CommandContext,
  active: ResolvedAgentAccount,
  readCredentials: (home: string) => Promise<string | undefined>,
  profileConfigDir?: string,
): Promise<{ credentials: string | undefined; token: string | undefined }> {
  const read = () =>
    readActiveClaudeCredentials(context, active, readCredentials, profileConfigDir);
  let credentials = await read();
  let token = getClaudeOAuthAccessToken(credentials, Date.now() + TOKEN_REPLACEMENT_LEAD_MS);
  if (
    !token &&
    localClaudeLoginRefresher &&
    context.runtimeFlavor !== "agent-test" &&
    isRefreshableClaudeLogin(credentials)
  ) {
    await localClaudeLoginRefresher().catch(() => undefined);
    credentials = await read();
    token = getClaudeOAuthAccessToken(credentials, Date.now() + TOKEN_REPLACEMENT_LEAD_MS);
  }
  return { credentials, token };
}

/** Coordinator homes whose own Keychain entry was already removed by this process. */
const clearedCoordinatorKeychainEntries = new Set<string>();

/**
 * Remove a Keychain login Claude may have saved under the coordinator home.
 *
 * Builds before access-only coordinators copied the account's credential file
 * in, refresh token included. When that refresh failed, Claude saved the
 * blanked login under the directory's own Keychain entry, and it then answers
 * "OAuth session expired" instead of "Not logged in" whenever no token is
 * handed over. Once per home per process is enough: nothing writes it now.
 */
async function clearCoordinatorKeychainLogin(
  coordinatorHome: string,
  removeKeychainEntry: (service: string) => Promise<void>,
): Promise<void> {
  if (process.platform !== "darwin" || clearedCoordinatorKeychainEntries.has(coordinatorHome)) {
    return;
  }
  clearedCoordinatorKeychainEntries.add(coordinatorHome);
  await removeKeychainEntry(claudeKeychainService(coordinatorHome)).catch(() => undefined);
}

async function deleteKeychainEntry(service: string): Promise<void> {
  await runCommand("security", ["delete-generic-password", "-s", service], {
    timeoutMs: 10_000,
  });
}

/**
 * Point a coordinator conversation's Claude bridge at the active account.
 *
 * The coordinator's private directory never holds a login. The account's
 * current access token is handed over as `CLAUDE_CODE_OAUTH_TOKEN`, and never
 * its refresh token: a copied refresh token rotates away from the account's
 * own login, and a copy of a stale file (macOS keeps the live login in the
 * Keychain) fails to refresh at all. The token cannot be renewed by the
 * bridge, so the returned expiry lets an idle bridge be replaced before it
 * lapses.
 */
export async function applyCoordinatorClaudeAccount(
  context: CommandContext,
  coordinatorHome: string,
  env: NodeJS.ProcessEnv,
  prepareHome: (destination: string) => Promise<void>,
  readCredentials: (home: string) => Promise<string | undefined> = readAddedClaudeCredentials,
  removeKeychainEntry: (service: string) => Promise<void> = deleteKeychainEntry,
): Promise<CoordinatorAgentAccount> {
  const active = await resolveActiveAgentAccount(context, "claude");
  if (active.home) {
    stripInheritedAgentCredentials(env);
  }
  // An agent-test profile may have pointed the run at its own isolated home,
  // whose login stands in for the host's.
  const profileConfigDir = active.home ? undefined : env.CLAUDE_CONFIG_DIR?.trim() || undefined;
  // The directory outlives a launch, and earlier builds copied logins into it.
  for (const name of [".credentials.json", "credentials.json"]) {
    await fs.rm(path.join(coordinatorHome, name), { force: true });
  }
  await prepareHome(coordinatorHome);
  await clearCoordinatorKeychainLogin(coordinatorHome, removeKeychainEntry);
  env.CLAUDE_CONFIG_DIR = coordinatorHome;
  if (env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY) {
    return { accountId: active.accountId };
  }
  const { credentials, token } = await readUsableClaudeLogin(
    context,
    active,
    readCredentials,
    profileConfigDir,
  );
  // Signed out, or an access token that lapsed and could not be refreshed.
  if (!token) return { accountId: active.accountId, loginless: true };
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  const tokenExpiresAt = claudeCredentialExpiry(credentials);
  return { accountId: active.accountId, ...(tokenExpiresAt ? { tokenExpiresAt } : {}) };
}

/** Where a coordinator finds the host's Codex login: `CODEX_HOME`, else `~/.codex`. */
export function coordinatorHostCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

/** A Codex login reduced to what a coordinator may hold. */
export interface CoordinatorCodexLogin {
  /** The access-only `auth.json`, absent when there is nothing usable to hand over. */
  text?: string;
  /** When its ChatGPT access token expires; absent for an API key, which does not. */
  tokenExpiresAt?: number;
}

function codexAccessTokenExpiry(text: string): number | undefined {
  try {
    const accessToken = (JSON.parse(text) as { tokens?: { access_token?: unknown } }).tokens
      ?.access_token;
    return typeof accessToken === "string" ? jwtExpiryMs(accessToken) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The access-only form of a Codex `auth.json` for a coordinator.
 *
 * The refresh token is blanked (`restrictCodexAuthSnapshot`, the same form
 * containers receive): Codex rotates it on every refresh, so a coordinator
 * that refreshed a copy would retire the account's own login. An access
 * token that will not outlive the replacement lead is not handed over at all;
 * the bridge then starts signed out and moves over once a fresher one exists.
 */
export function coordinatorCodexLogin(
  raw: string | undefined,
  nowMs = Date.now(),
): CoordinatorCodexLogin {
  if (raw === undefined) return {};
  const restricted = restrictCodexAuthSnapshot(raw, nowMs);
  if (!("text" in restricted)) return {};
  const tokenExpiresAt = codexAccessTokenExpiry(restricted.text);
  if (tokenExpiresAt !== undefined && tokenExpiresAt - nowMs < TOKEN_REPLACEMENT_LEAD_MS) {
    return {};
  }
  return { text: restricted.text, ...(tokenExpiresAt ? { tokenExpiresAt } : {}) };
}

/**
 * The active Codex login as a coordinator would receive it. Codex keeps its
 * login in a file only. Renew it in the owning home before handing out an
 * access-only copy; the coordinator never receives the renewable login.
 */
export async function readCoordinatorCodexLogin(
  active: ResolvedAgentAccount,
): Promise<CoordinatorCodexLogin> {
  const home = active.home ?? coordinatorHostCodexHome();
  let raw = await readCodexAuthFile(home);
  let login = coordinatorCodexLogin(raw);
  if (!login.text && localCodexLoginRefresher && codexHasRefreshToken(raw)) {
    await localCodexLoginRefresher(home).catch(() => undefined);
    raw = await readCodexAuthFile(home);
    login = coordinatorCodexLogin(raw);
  }
  return login;
}

let localCodexLoginRefresher: ((home: string) => Promise<void>) | undefined;

export function setLocalCodexLoginRefresher(refresher: typeof localCodexLoginRefresher): void {
  localCodexLoginRefresher = refresher;
}

function codexHasRefreshToken(raw: string | undefined): boolean {
  try {
    const token = JSON.parse(raw ?? "").tokens?.refresh_token;
    return typeof token === "string" && token.trim() !== "";
  } catch {
    return false;
  }
}
