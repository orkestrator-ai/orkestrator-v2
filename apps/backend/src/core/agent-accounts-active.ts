import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_AGENT_ACCOUNT_ID,
  type AgentAccountPlatform,
} from "@orkestrator/protocol/agent-accounts";

import type { CommandContext } from "./commands-context.js";
import {
  getClaudeOAuthAccessToken,
  getHostClaudeCredentials,
  readRuntimeHostClaudeCredentials,
} from "./commands-files.js";
import { localServerProcesses } from "./commands-runtime-state.js";
import {
  localAgentAccountIds,
  localAgentAccountTokenExpiry,
  staleLoginLocalBridges,
} from "./agent-account-bridge-state.js";
import {
  agentAccountHome,
  claudeKeychainService,
  prepareAgentAccountHome,
  readCodexAuthFile,
} from "./agent-accounts-homes.js";
import { INHERITED_CREDENTIAL_ENV } from "./agent-accounts-login.js";
import { initializeActivePlanUsageAccount } from "./plan-usage-cache.js";

/** The account a platform's launches use: the host login, or an added account's directory. */
export interface ResolvedAgentAccount {
  accountId: string;
  /** Absent for the host login, which launches with no directory override. */
  home?: string;
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
  if (!accountId) return { accountId: DEFAULT_AGENT_ACCOUNT_ID };
  return {
    accountId,
    home: agentAccountHome(context.storage.agentAccountsDirectory(), platform, accountId),
  };
}

/**
 * Point a Claude or Codex bridge's environment at the active account.
 *
 * The host login changes nothing, so a user who never adds an account
 * launches exactly as before. An added account refreshes its directory's
 * links and MCP settings first, and drops the bearer tokens an agent-test
 * profile may have injected for the host login, which the CLI would otherwise
 * prefer over the account's own credential. Returns the account id so the
 * caller can tell later whether the bridge is still on the active account.
 */
export async function applyActiveAgentAccountEnvironment(
  context: CommandContext,
  platform: AgentAccountPlatform,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const active = await resolveActiveAgentAccount(context, platform);
  if (!active.home) return active.accountId;
  await prepareAgentAccountHome(platform, active.home);
  stripInheritedAgentCredentials(env);
  if (platform === "claude") {
    env.CLAUDE_CONFIG_DIR = active.home;
  } else {
    env.CODEX_HOME = active.home;
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
 * or the token actually expires.
 */
export async function localBridgeIsOnActiveAccount(
  key: string,
  kind: string,
  environmentId: string,
  context: CommandContext,
): Promise<boolean> {
  if (kind !== "claude" && kind !== "codex") return true;
  const launchedWith = localAgentAccountIds.get(key) ?? DEFAULT_AGENT_ACCOUNT_ID;
  const active = await resolveActiveAgentAccount(context, kind);
  const tokenExpiresAt = kind === "claude" ? localAgentAccountTokenExpiry.get(key) : undefined;
  const tokenLapsed =
    tokenExpiresAt !== undefined && Date.now() >= tokenExpiresAt - TOKEN_REPLACEMENT_LEAD_MS;
  // Signed in again since launch: the bridge's login is out of date even
  // though it is on the right account.
  if (launchedWith === active.accountId && !staleLoginLocalBridges.has(key)) {
    if (tokenExpiresAt === undefined || !tokenLapsed) return true;
    const credentials = active.home
      ? await readAddedClaudeCredentials(active.home)
      : context.runtimeFlavor === "agent-test"
        ? undefined
        : await readRuntimeHostClaudeCredentials();
    const freshExpiry = claudeCredentialExpiry(credentials);
    // A lapsed lead window is only a reason to relaunch when there is a
    // better token to hand over. Keep the existing bridge until actual expiry.
    if (
      !freshExpiry ||
      freshExpiry <= tokenExpiresAt ||
      !getClaudeOAuthAccessToken(credentials, Date.now() + TOKEN_REPLACEMENT_LEAD_MS)
    ) {
      if (Date.now() < tokenExpiresAt) return true;
    }
  }
  return (await context.nativeAgents?.hasObservedLiveWork(environmentId, kind)) === true;
}

/** How long before a handed-over token expires its idle bridge is replaced. */
const TOKEN_REPLACEMENT_LEAD_MS = 5 * 60_000;

/**
 * The platform's login was renewed. Every live local bridge may hold the old
 * one, so each is replaced the next time it is used while idle.
 */
export function markLocalBridgesForLoginRefresh(platform: AgentAccountPlatform): void {
  for (const key of localServerProcesses.keys()) {
    if (key.startsWith(`${platform}:`)) staleLoginLocalBridges.add(key);
  }
}

/** Whether any live local bridge was launched on this account. */
export function isAgentAccountInUseByLocalBridge(
  platform: AgentAccountPlatform,
  accountId: string,
): boolean {
  for (const [key, launchedWith] of localAgentAccountIds) {
    if (launchedWith !== accountId || !key.startsWith(`${platform}:`)) continue;
    const child = localServerProcesses.get(key);
    if (child && child.exitCode === null && child.signalCode === null) return true;
  }
  return false;
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

async function hasFileCredential(configDir: string): Promise<boolean> {
  for (const name of [".credentials.json", "credentials.json"]) {
    const stat = await fs.lstat(path.join(configDir, name)).catch(() => null);
    if (stat?.isFile() && stat.size > 0) return true;
  }
  return false;
}

export interface CoordinatorAgentAccount {
  accountId: string;
  /** Set when the bridge runs on a short-lived access token rather than a login. */
  tokenExpiresAt?: number;
}

/**
 * Seed a coordinator conversation's private Claude directory from the active
 * account and point the bridge at it.
 *
 * The directory receives a copied credential file when the account keeps one.
 * A login held only in the macOS Keychain cannot follow: Claude names that
 * entry after the directory it belongs to, so the private directory has none
 * of its own. The account's current access token is handed over instead, and
 * never its refresh token — a copied refresh token would rotate away from the
 * account's own login. The token cannot be renewed, so the returned expiry
 * lets an idle bridge be replaced before it lapses.
 */
export async function applyCoordinatorClaudeAccount(
  context: CommandContext,
  coordinatorHome: string,
  env: NodeJS.ProcessEnv,
  prepareHome: (destination: string, source?: string) => Promise<void>,
  readCredentials: (home: string) => Promise<string | undefined> = readAddedClaudeCredentials,
): Promise<CoordinatorAgentAccount> {
  const active = await resolveActiveAgentAccount(context, "claude");
  if (active.home) {
    stripInheritedAgentCredentials(env);
  }
  // The directory outlives a launch; a login copied for an earlier account
  // must not outrank the active one.
  for (const name of [".credentials.json", "credentials.json"]) {
    await fs.rm(path.join(coordinatorHome, name), { force: true });
  }
  // Without an added account this is whatever directory the run would
  // otherwise have used, which an agent-test profile may have pointed at an
  // isolated home.
  await prepareHome(coordinatorHome, active.home ?? (env.CLAUDE_CONFIG_DIR?.trim() || undefined));
  env.CLAUDE_CONFIG_DIR = coordinatorHome;
  if (
    (await hasFileCredential(coordinatorHome)) ||
    env.ANTHROPIC_AUTH_TOKEN ||
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    env.ANTHROPIC_API_KEY
  ) {
    return { accountId: active.accountId };
  }
  // An agent-test profile reads the host login only through its own grant,
  // which `applyClaudeHostCredentialEnvironment` has already applied.
  const credentials = active.home
    ? await readCredentials(active.home)
    : context.runtimeFlavor === "agent-test"
      ? undefined
      : await readRuntimeHostClaudeCredentials();
  const token = getClaudeOAuthAccessToken(credentials, Date.now() + TOKEN_REPLACEMENT_LEAD_MS);
  if (!token) return { accountId: active.accountId };
  env.CLAUDE_CODE_OAUTH_TOKEN = token;
  const tokenExpiresAt = claudeCredentialExpiry(credentials);
  return { accountId: active.accountId, ...(tokenExpiresAt ? { tokenExpiresAt } : {}) };
}
