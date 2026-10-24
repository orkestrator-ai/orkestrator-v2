import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  AGENT_ACCOUNT_PLATFORMS,
  DEFAULT_AGENT_ACCOUNT_ID,
  MAX_AGENT_ACCOUNT_LABEL_LENGTH,
  MAX_AGENT_ACCOUNTS_PER_PLATFORM,
  type AgentAccountLoginProgress,
  type AgentAccountPlatform,
  type AgentAccountsSnapshot,
  type AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

import type { CommandContext } from "./commands-context.js";
import { resolveClaudeBinary, resolveCodexBinary } from "./commands-agent-support.js";
import { getClaudeOAuthAccessToken, readRuntimeHostClaudeCredentials } from "./commands-files.js";
import { runCommand } from "./shell.js";
import { isStoredAgentAccountId, type StoredAgentAccount } from "./agent-accounts-store.js";
import {
  agentAccountHome,
  claudeAccountLoginState,
  claudeKeychainService,
  codexAccountLoginState,
  hostClaudeJsonPath,
  hostClaudeConfigDir,
  prepareAgentAccountHome,
  privateSharedEntries,
  readClaudeAccountJson,
  readCodexAuthFile,
  type AgentAccountLoginState,
} from "./agent-accounts-homes.js";
import { markContainersForClaudeLoginRefresh } from "./agent-accounts-containers.js";
import {
  isAgentAccountInUseByLocalBridge,
  markLocalBridgesForLoginRefresh,
  readAddedClaudeCredentials,
  runtimeHostCodexHome,
} from "./agent-accounts-active.js";
import {
  agentAccountLoginCommand,
  beginAgentAccountLogin,
  ensureBrowserShim,
  type AgentAccountLoginHandle,
  type SpawnLike,
} from "./agent-accounts-login.js";
import { setActivePlanUsageAccount, sharedPlanUsageCache } from "./plan-usage-cache.js";
import {
  forgetAgentAccountUsage,
  rememberAgentAccountUsage,
  resetAgentAccountLastUsageForTests,
  withLastKnownUsage,
} from "./agent-accounts-last-usage.js";
import { readAgentAccountPlanUsage, readPlanUsage, type PlanUsageReader } from "./plan-usage.js";
import { promoteClaudeLogin, removeTemporaryClaudeLogin } from "./agent-accounts-promotion.js";
import { terminalAccountHomes } from "./terminal-account-usage.js";

/**
 * Added Claude and Codex logins: registry, switching, sign-in and per-account
 * usage. See docs/architecture/agent-accounts.md.
 */

const HOST_ACCOUNT_LABEL = "Host login";
const USAGE_TTL_MS = 120_000;
const USAGE_ERROR_TTL_MS = 10_000;
let accountMutation = Promise.resolve();

async function withAccountMutation<T>(run: () => Promise<T>): Promise<T> {
  const previous = accountMutation;
  let release: () => void = () => undefined;
  accountMutation = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

function accountsRoot(context: CommandContext): string {
  return context.storage.agentAccountsDirectory();
}

function homeFor(context: CommandContext, platform: AgentAccountPlatform, id: string): string {
  return agentAccountHome(accountsRoot(context), platform, id);
}

/**
 * Whether this runtime may read the host login for a platform. An agent-test
 * profile only reads what the harness granted; added accounts are
 * Orkestrator's own and need no grant.
 */
function hostLoginAllowed(context: CommandContext, platform: AgentAccountPlatform): boolean {
  return (
    context.runtimeFlavor !== "agent-test" || context.credentialSources?.has(platform) === true
  );
}

async function readClaudeCredentialsFor(
  context: CommandContext,
  home: string | undefined,
): Promise<string | undefined> {
  if (home) return readAddedClaudeCredentials(home);
  return hostLoginAllowed(context, "claude") ? readRuntimeHostClaudeCredentials() : undefined;
}

async function readCodexAuthFor(
  context: CommandContext,
  home: string | undefined,
): Promise<string | undefined> {
  if (home) return readCodexAuthFile(home);
  return hostLoginAllowed(context, "codex") ? readCodexAuthFile(runtimeHostCodexHome()) : undefined;
}

async function readLoginState(
  context: CommandContext,
  platform: AgentAccountPlatform,
  home: string | undefined,
): Promise<AgentAccountLoginState> {
  if (platform === "claude") {
    const claudeJson =
      home || hostLoginAllowed(context, "claude")
        ? await readClaudeAccountJson(home ? path.join(home, ".claude.json") : hostClaudeJsonPath())
        : undefined;
    return claudeAccountLoginState(await readClaudeCredentialsFor(context, home), claudeJson);
  }
  return codexAccountLoginState(await readCodexAuthFor(context, home));
}

export async function listAgentAccounts(context: CommandContext): Promise<AgentAccountsSnapshot> {
  const store = await context.storage.loadAgentAccounts();
  const rows = AGENT_ACCOUNT_PLATFORMS.flatMap((platform) => [
    { platform, stored: undefined as StoredAgentAccount | undefined },
    ...store.accounts
      .filter((account) => account.platform === platform)
      .map((stored) => ({ platform, stored })),
  ]);
  const accounts = await Promise.all(
    rows.map(async ({ platform, stored }): Promise<AgentAccountSummary> => {
      const home = stored ? homeFor(context, platform, stored.id) : undefined;
      const [state, privateEntries] = await Promise.all([
        readLoginState(context, platform, home),
        home ? privateSharedEntries(platform, home) : Promise.resolve([]),
      ]);
      const id = stored?.id ?? DEFAULT_AGENT_ACCOUNT_ID;
      return {
        id,
        platform,
        label: stored?.label ?? HOST_ACCOUNT_LABEL,
        isDefault: !stored,
        isActive: (store.active[platform] ?? DEFAULT_AGENT_ACCOUNT_ID) === id,
        signedIn: state.signedIn,
        // What the login says now wins over what was recorded when it was added.
        identity: { ...stored?.identity, ...state.identity },
        ...(stored ? { createdAt: stored.createdAt } : {}),
        ...(privateEntries.length > 0 ? { privateEntries } : {}),
      };
    }),
  );
  return {
    accounts,
    active: {
      claude: store.active.claude ?? DEFAULT_AGENT_ACCOUNT_ID,
      codex: store.active.codex ?? DEFAULT_AGENT_ACCOUNT_ID,
    },
  };
}

function assertKnownAccountId(accountId: string): void {
  if (accountId !== DEFAULT_AGENT_ACCOUNT_ID && !isStoredAgentAccountId(accountId)) {
    throw new Error("Unknown agent account");
  }
}

/**
 * Make an account the one new launches use. Running bridges are not touched:
 * each moves over on its next use once idle (see `localBridgeIsOnActiveAccount`).
 */
export async function setActiveAgentAccount(
  context: CommandContext,
  platform: AgentAccountPlatform,
  accountId: string,
): Promise<AgentAccountsSnapshot> {
  assertKnownAccountId(accountId);
  await withAccountMutation(async () => {
    const outgoing = sharedPlanUsageCache.lastOk(platform);
    const previous = await context.storage.mutateAgentAccounts<string | undefined>((store) => {
      const current = store.active[platform] ?? DEFAULT_AGENT_ACCOUNT_ID;
      if (current === accountId) return { store, result: undefined };
      const active = { ...store.active };
      if (accountId === DEFAULT_AGENT_ACCOUNT_ID) {
        delete active[platform];
      } else {
        if (!store.accounts.some((a) => a.id === accountId && a.platform === platform)) {
          throw new Error("Unknown agent account");
        }
        active[platform] = accountId;
      }
      return { store: { ...store, active }, result: current };
    });
    // Readers take this same lock before selecting an account and before
    // publishing a result. No reader can observe a half-completed switch.
    bumpUsageGeneration(context, platform);
    readPlanUsage.invalidate(platform);
    setActivePlanUsageAccount(platform, accountId);
    usageCache.delete(usageKey(context, platform, accountId));
    if (previous) usageCache.delete(usageKey(context, platform, previous));
    if (previous && outgoing) {
      await rememberAgentAccountUsage(accountsRoot(context), platform, previous, outgoing);
    }
  });
  return listAgentAccounts(context);
}

export async function renameAgentAccount(
  context: CommandContext,
  platform: AgentAccountPlatform,
  accountId: string,
  label: string,
): Promise<AgentAccountsSnapshot> {
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > MAX_AGENT_ACCOUNT_LABEL_LENGTH) {
    throw new Error(`Account names must be 1–${MAX_AGENT_ACCOUNT_LABEL_LENGTH} characters`);
  }
  if (!isStoredAgentAccountId(accountId)) throw new Error("The host login cannot be renamed");
  await context.storage.mutateAgentAccounts((store) => {
    const index = store.accounts.findIndex((a) => a.id === accountId && a.platform === platform);
    if (index < 0) throw new Error("Unknown agent account");
    const accounts = [...store.accounts];
    accounts[index] = { ...accounts[index]!, label: trimmed };
    return { store: { ...store, accounts }, result: undefined };
  });
  return listAgentAccounts(context);
}

/**
 * Delete an account directory and, for Claude on macOS, its Keychain entry.
 * The directory holds links into the host directory; removing a link never
 * touches its target.
 */
async function deleteAccountDirectory(
  context: CommandContext,
  platform: AgentAccountPlatform,
  accountId: string,
): Promise<void> {
  if (!isStoredAgentAccountId(accountId)) return;
  const home = homeFor(context, platform, accountId);
  const platformRoot = path.join(path.resolve(accountsRoot(context)), platform);
  if (path.dirname(home) !== platformRoot) return;
  await fs.rm(home, { recursive: true, force: true });
  if (platform === "claude" && process.platform === "darwin") {
    await runCommand("security", ["delete-generic-password", "-s", claudeKeychainService(home)], {
      timeoutMs: 10_000,
    }).catch(() => undefined);
  }
}

export async function removeAgentAccount(
  context: CommandContext,
  platform: AgentAccountPlatform,
  accountId: string,
): Promise<AgentAccountsSnapshot> {
  if (!isStoredAgentAccountId(accountId)) throw new Error("The host login cannot be removed");
  if (isAgentAccountInUseByLocalBridge(platform, accountId)) {
    throw new Error("An agent is still running on this account. Try again once it is idle.");
  }
  return withAccountMutation(async () => {
    if (
      Array.from(terminalAccountHomes.values()).some(
        (home) => home === homeFor(context, platform, accountId),
      )
    ) {
      throw new Error(
        "A terminal is still running on this account. Close it before removing the account.",
      );
    }
    const store = await context.storage.loadAgentAccounts();
    if (store.active[platform] === accountId)
      throw new Error("Switch to another account before removing this one.");
    if (
      !store.accounts.some((account) => account.id === accountId && account.platform === platform)
    )
      throw new Error("Unknown agent account");
    await deleteAccountDirectory(context, platform, accountId);
    await context.storage.mutateAgentAccounts((store) => {
      if (store.active[platform] === accountId) {
        throw new Error("Switch to another account before removing this one.");
      }
      const accounts = store.accounts.filter(
        (a) => !(a.id === accountId && a.platform === platform),
      );
      if (accounts.length === store.accounts.length) throw new Error("Unknown agent account");
      return { store: { ...store, accounts }, result: undefined };
    });
    bumpUsageGeneration(context, platform);
    usageCache.delete(usageKey(context, platform, accountId));
    await forgetAgentAccountUsage(accountsRoot(context), platform, accountId);
    return listAgentAccounts(context);
  });
}

// ---------------------------------------------------------------------------
// Sign-in

interface ActiveLogin {
  operationId: string;
  completedAt?: string;
  temporaryHome?: string;
  committing?: boolean;
  platform: AgentAccountPlatform;
  /** The new account's id, or for `reauthenticate` the active account's. */
  accountId: string;
  mode: "add" | "reauthenticate";
  state: "pending" | "succeeded" | "failed";
  handle?: AgentAccountLoginHandle;
  codeSubmitted?: boolean;
  cancelled?: boolean;
  error?: string;
}

/**
 * The single in-flight sign-in. One at a time across platforms: both CLIs
 * are human-paced browser flows and a second one would only confuse which
 * tab belongs to which account.
 */
let activeLogin: ActiveLogin | undefined;

function loginProgress(): AgentAccountLoginProgress {
  const entry = activeLogin;
  if (!entry) return { state: "idle" };
  return {
    state: entry.state,
    operationId: entry.operationId,
    ...(entry.completedAt ? { completedAt: entry.completedAt } : {}),
    accountId: entry.accountId,
    platform: entry.platform,
    mode: entry.mode,

    ...(entry.state === "pending" && entry.handle
      ? {
          url: entry.handle.url,
          needsCode: entry.handle.needsCode,
          ...(entry.handle.userCode ? { userCode: entry.handle.userCode } : {}),
          ...(entry.codeSubmitted ? { codeSubmitted: true } : {}),
        }
      : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

export function agentAccountLoginProgress(): AgentAccountLoginProgress {
  return loginProgress();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Remove the private directory created by an unsuccessful sign-in. Renewals
 * write into a temporary directory and never remove the existing account.
 */
async function discardNewAccount(context: CommandContext, entry: ActiveLogin): Promise<void> {
  if (entry.mode === "reauthenticate") {
    if (entry.temporaryHome) await removeTemporaryClaudeLogin(entry.temporaryHome);
    return;
  }
  await deleteAccountDirectory(context, entry.platform, entry.accountId);
}

/** Private directory the CLI writes into, including a temporary home for renewals. */
function loginHome(context: CommandContext, entry: ActiveLogin): string | undefined {
  if (entry.temporaryHome) return entry.temporaryHome;
  return entry.accountId === DEFAULT_AGENT_ACCOUNT_ID
    ? undefined
    : homeFor(context, entry.platform, entry.accountId);
}

/**
 * A renewed login: keep the account, refresh what is derived from it, and make
 * every running agent that may hold the previous login pick up the new one.
 */
async function finishReauthentication(context: CommandContext, entry: ActiveLogin): Promise<void> {
  const { platform, accountId } = entry;
  await withAccountMutation(async () => {
    if (entry.cancelled) throw new Error("The sign-in was cancelled");
    const state = await readLoginState(context, platform, entry.temporaryHome);
    if (!state.signedIn) throw new Error("The sign-in finished but no login was saved.");
    if (!state.identityKey) throw new Error("The sign-in finished without an account identity.");
    const added = accountId !== DEFAULT_AGENT_ACCOUNT_ID;
    const host = added ? await readLoginState(context, platform, undefined) : undefined;
    const previousIdentity = await readLoginState(
      context,
      platform,
      added ? homeFor(context, platform, accountId) : undefined,
    );
    const destination = added ? homeFor(context, platform, accountId) : hostClaudeConfigDir();
    const jsonPath = added ? path.join(destination, ".claude.json") : hostClaudeJsonPath();
    // Credentials and metadata are committed under the same account and storage
    // locks. If persistence fails the promotion restores the previous login.
    await promoteClaudeLogin(
      entry.temporaryHome!,
      destination,
      jsonPath,
      added,
      async (promote) => {
        await context.storage.mutateAgentAccounts(async (store) => {
          if (entry.cancelled) throw new Error("The sign-in was cancelled");
          if (host?.identityKey === state.identityKey) {
            throw new Error("That is the host login, which is already listed.");
          }
          const duplicate = store.accounts.find(
            (a) =>
              a.platform === platform && a.id !== accountId && a.identityKey === state.identityKey,
          );
          if (duplicate) throw new Error(`That login is already added as “${duplicate.label}”.`);
          const index = store.accounts.findIndex(
            (a) => a.id === accountId && a.platform === platform,
          );
          if (added && index < 0) throw new Error("Unknown agent account");
          const accounts = [...store.accounts];
          if (added) {
            const previous = accounts[index]!;
            accounts[index] = {
              ...previous,
              ...(state.identity.email && previous.label === previous.identity?.email
                ? { label: state.identity.email.slice(0, MAX_AGENT_ACCOUNT_LABEL_LENGTH) }
                : {}),
              identityKey: state.identityKey,
              identity: state.identity,
            };
          }
          entry.committing = true;
          await promote();
          return {
            store: {
              ...store,
              accounts,
              loginGeneration: { ...store.loginGeneration, [platform]: entry.operationId },
            },
            result: undefined,
          };
        });
      },
    );
    bumpUsageGeneration(context, platform);
    usageCache.delete(usageKey(context, platform, accountId));
    readPlanUsage.invalidate(platform);
    // A local slot can be renewed as a different provider identity. Its old
    // quota must not survive that replacement, including across a restart.
    if (previousIdentity.identityKey !== state.identityKey) {
      await forgetAgentAccountUsage(accountsRoot(context), platform, accountId);
    }
    await discardNewAccount(context, entry).catch(() =>
      console.warn("[agent-accounts] Temporary login cleanup failed"),
    );
  });
  markLocalBridgesForLoginRefresh(platform);
  if (platform === "claude")
    await markContainersForClaudeLoginRefresh(context, true).catch(() =>
      console.warn(
        "[agent-accounts] Container login refresh will reconcile from its durable generation",
      ),
    );
}

async function finishLogin(context: CommandContext, entry: ActiveLogin): Promise<void> {
  const { platform, accountId } = entry;
  try {
    if (entry.cancelled) throw new Error("The sign-in was cancelled");
    if (entry.mode === "reauthenticate") {
      await finishReauthentication(context, entry);
      entry.state = "succeeded";
      entry.completedAt = new Date().toISOString();
      return;
    }
    const state = await readLoginState(context, platform, homeFor(context, platform, accountId));
    if (!state.signedIn) throw new Error("The sign-in finished but no login was saved.");
    if (!state.identityKey)
      throw new Error("The sign-in finished without an account identity. Try signing in again.");
    const host = await readLoginState(context, platform, undefined);
    await context.storage.mutateAgentAccounts((store) => {
      const siblings = store.accounts.filter((a) => a.platform === platform);
      if (state.identityKey) {
        if (host.identityKey === state.identityKey) {
          throw new Error("That is the host login, which is already listed.");
        }
        const duplicate = siblings.find((a) => a.identityKey === state.identityKey);
        if (duplicate) throw new Error(`That login is already added as “${duplicate.label}”.`);
      }
      if (siblings.length >= MAX_AGENT_ACCOUNTS_PER_PLATFORM) {
        throw new Error("No more accounts can be added for this platform.");
      }
      const label =
        state.identity.email ?? `${AGENT_PLATFORM_LABELS[platform]} account ${siblings.length + 1}`;
      const account: StoredAgentAccount = {
        id: accountId,
        platform,
        label: label.slice(0, MAX_AGENT_ACCOUNT_LABEL_LENGTH),
        createdAt: new Date().toISOString(),
        ...(state.identityKey ? { identityKey: state.identityKey } : {}),
        ...(Object.keys(state.identity).length > 0 ? { identity: state.identity } : {}),
      };
      return { store: { ...store, accounts: [...store.accounts, account] }, result: undefined };
    });
    entry.state = "succeeded";
    entry.completedAt = new Date().toISOString();
  } catch (error) {
    entry.state = "failed";
    entry.completedAt = new Date().toISOString();
    entry.error = errorMessage(error);
    try {
      await discardNewAccount(context, entry);
    } catch {
      entry.error = `${entry.error} Account cleanup failed; retry removing the account directory.`;
    }
  }
}

/**
 * Start a sign-in.
 *
 * By default it adds an account. With `reauthenticate` it signs the platform's
 * active account in again — the host login or an added account — so an agent
 * whose login has lapsed can be repaired without leaving the app.
 */
export async function startAgentAccountLogin(
  context: CommandContext,
  platform: AgentAccountPlatform,
  options: { spawnImpl?: SpawnLike; executable?: string; reauthenticate?: boolean } = {},
): Promise<AgentAccountLoginProgress> {
  const mode = options.reauthenticate ? "reauthenticate" : "add";
  if (activeLogin?.state === "pending") {
    if (activeLogin.platform === platform && activeLogin.mode === mode) return loginProgress();
    throw new Error("Finish or cancel the other sign-in first.");
  }
  if (mode === "reauthenticate" && platform !== "claude") {
    throw new Error("Signing in again is only available for Claude.");
  }
  const entry: ActiveLogin = {
    operationId: randomUUID(),
    platform,
    mode,
    accountId: mode === "add" ? randomUUID() : DEFAULT_AGENT_ACCOUNT_ID,
    state: "pending",
  };
  activeLogin = entry;
  try {
    const store = await context.storage.loadAgentAccounts();
    if (mode === "reauthenticate") {
      entry.accountId = store.active[platform] ?? DEFAULT_AGENT_ACCOUNT_ID;
      // An agent-test profile only reads the host login its harness granted;
      // it must not write one.
      if (entry.accountId === DEFAULT_AGENT_ACCOUNT_ID && context.runtimeFlavor === "agent-test") {
        throw new Error("The host login cannot be signed in again from this profile.");
      }
    } else if (
      store.accounts.filter((a) => a.platform === platform).length >=
      MAX_AGENT_ACCOUNTS_PER_PLATFORM
    ) {
      throw new Error("No more accounts can be added for this platform.");
    }
  } catch (error) {
    entry.state = "failed";
    entry.completedAt = new Date().toISOString();
    entry.error = errorMessage(error);
    throw error;
  }
  if (mode === "reauthenticate") {
    entry.temporaryHome = path.join(accountsRoot(context), ".reauth", entry.operationId);
  }
  const home = loginHome(context, entry);
  let handle: AgentAccountLoginHandle;
  try {
    if (entry.temporaryHome) await fs.mkdir(entry.temporaryHome, { recursive: true, mode: 0o700 });
    else if (home) await prepareAgentAccountHome(platform, home);
    const shim = await ensureBrowserShim(path.join(accountsRoot(context), ".login-shim"));
    const command = agentAccountLoginCommand({
      platform,
      executable:
        options.executable ??
        (platform === "claude" ? resolveClaudeBinary(context) : resolveCodexBinary(context)),
      ...(home ? { accountHome: home } : {}),
      browserShimDirectory: shim,
    });
    handle = await beginAgentAccountLogin(platform, command, { spawnImpl: options.spawnImpl });
  } catch (error) {
    entry.state = "failed";
    entry.completedAt = new Date().toISOString();
    entry.error = entry.cancelled ? "The sign-in was cancelled" : errorMessage(error);
    try {
      await discardNewAccount(context, entry);
    } catch {
      entry.error = `${entry.error} Account cleanup failed.`;
    }
    throw new Error(entry.error);
  }
  if (entry.cancelled) {
    handle.cancel();
    try {
      await discardNewAccount(context, entry);
    } catch {
      entry.state = "failed";
      entry.completedAt = new Date().toISOString();
      entry.error = "The sign-in was cancelled; account cleanup failed.";
    }
    throw new Error("The sign-in was cancelled");
  }
  entry.handle = handle;
  void handle.completion
    .then(
      () => finishLogin(context, entry),
      async (error: unknown) => {
        entry.state = "failed";
        entry.completedAt = new Date().toISOString();
        entry.error = entry.cancelled ? "The sign-in was cancelled" : errorMessage(error);
        try {
          await discardNewAccount(context, entry);
        } catch {
          entry.error = `${entry.error} Account cleanup failed.`;
        }
      },
    )
    .catch((error: unknown) => {
      entry.state = "failed";
      entry.completedAt = new Date().toISOString();
      entry.error = errorMessage(error);
    });
  return loginProgress();
}

export function submitAgentAccountLoginCode(code: string): AgentAccountLoginProgress {
  const entry = activeLogin;
  if (entry?.state !== "pending" || !entry.handle?.needsCode) {
    throw new Error("No sign-in is waiting for a code.");
  }
  entry.handle.submitCode(code);
  entry.codeSubmitted = true;
  return loginProgress();
}

/** Cancel a pending sign-in, or dismiss a finished one. */
export function cancelAgentAccountLogin(operationId?: string): AgentAccountLoginProgress {
  const entry = activeLogin;
  if (operationId && entry?.operationId !== operationId) return loginProgress();
  if (entry?.committing && entry.state === "pending") return loginProgress();
  activeLogin = undefined;
  if (entry?.state === "pending") {
    entry.cancelled = true;
    entry.handle?.cancel();
  }
  return loginProgress();
}

/** Test seam: forget any sign-in without touching its process. */
export function resetAgentAccountLoginForTests(): void {
  activeLogin = undefined;
  usageCache.clear();
  usageGenerations.clear();
  resetAgentAccountLastUsageForTests();
}

// ---------------------------------------------------------------------------
// Usage

const usageCache = new Map<
  string,
  { expiresAt: number; rateLimited?: boolean; snapshot: PlanUsageSnapshot }
>();

// Generation changes fence network work that outlives a switch, renewal or
// removal. The mutation lock also covers persistence so deletion cannot race
// a completed read's check-and-write.
const usageGenerations = new Map<string, number>();

function usageKey(context: CommandContext, platform: AgentAccountPlatform, id: string): string {
  return `${accountsRoot(context)}:${platform}:${id}`;
}

function usageGeneration(context: CommandContext, platform: AgentAccountPlatform): number {
  return usageGenerations.get(usageKey(context, platform, "generation")) ?? 0;
}

function bumpUsageGeneration(context: CommandContext, platform: AgentAccountPlatform): void {
  usageGenerations.set(
    usageKey(context, platform, "generation"),
    usageGeneration(context, platform) + 1,
  );
}

/**
 * Plan usage for any listed account.
 *
 * The active account is served by the shared reader, the same snapshot the
 * platform's usage card and running sessions keep current. Any other account
 * is read from its own directory. Orkestrator never refreshes a token itself,
 * so an inactive Claude account's short-lived access token lapses until that
 * account is used again. Until then, as after any failed read, the account's
 * last known usage is shown, marked stale.
 */
export async function readAgentAccountUsage(
  context: CommandContext,
  platform: AgentAccountPlatform,
  accountId: string,
  options: { force?: boolean; reader: PlanUsageReader; now?: () => number },
): Promise<PlanUsageSnapshot> {
  assertKnownAccountId(accountId);
  const { store, generation } = await withAccountMutation(async () => ({
    store: await context.storage.loadAgentAccounts(),
    generation: usageGeneration(context, platform),
  }));
  const now = options.now ?? Date.now;
  const root = accountsRoot(context);
  const publish = (snapshot: PlanUsageSnapshot, retryAfterMs?: number, cache = false) =>
    withAccountMutation(async () => {
      if (usageGeneration(context, platform) !== generation) {
        throw new Error("The account changed while reading plan usage. Try again.");
      }
      const result = await withLastKnownUsage(root, platform, accountId, snapshot, now());
      if (cache) {
        usageCache.set(usageKey(context, platform, accountId), {
          expiresAt:
            now() +
            (retryAfterMs ??
              (result.status === "ok" && !result.stale ? USAGE_TTL_MS : USAGE_ERROR_TTL_MS)),
          ...(retryAfterMs !== undefined ? { rateLimited: true } : {}),
          snapshot: result,
        });
      }
      return result;
    });
  if ((store.active[platform] ?? DEFAULT_AGENT_ACCOUNT_ID) === accountId) {
    const snapshot = await options.reader(context, platform, { force: options.force === true });
    return publish(snapshot);
  }
  const stored = store.accounts.find((a) => a.id === accountId && a.platform === platform);
  if (accountId !== DEFAULT_AGENT_ACCOUNT_ID && !stored) throw new Error("Unknown agent account");

  const key = usageKey(context, platform, accountId);
  const cached = usageCache.get(key);
  // A forced refresh still waits out a 429: each retry spends the allowance.
  if (cached && cached.expiresAt > now() && (!options.force || cached.rateLimited)) {
    return publish(cached.snapshot);
  }

  const home = stored ? homeFor(context, platform, stored.id) : undefined;
  let snapshot: PlanUsageSnapshot;
  let retryAfterMs: number | undefined;
  if (platform === "claude") {
    const { global } = await context.storage.loadConfig();
    const credentials =
      home || global.useHostClaudeCredentials !== false
        ? await readClaudeCredentialsFor(context, home)
        : undefined;
    const token = getClaudeOAuthAccessToken(credentials, now());
    if (!token && claudeAccountLoginState(credentials, undefined, now()).signedIn) {
      snapshot = {
        platform,
        status: "unavailable",
        windows: [],
        message:
          "This account's sign-in is refreshed while it is in use. Switch to it to see current usage.",
        fetchedAt: new Date(now()).toISOString(),
      };
    } else {
      ({ snapshot, retryAfterMs } = await readAgentAccountPlanUsage(context, "claude", token, {
        now,
      }));
    }
  } else {
    ({ snapshot, retryAfterMs } = await readAgentAccountPlanUsage(
      context,
      "codex",
      await readCodexAuthFor(context, home),
      { now },
    ));
  }
  return publish(snapshot, retryAfterMs, true);
}
