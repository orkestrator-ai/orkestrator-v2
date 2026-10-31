import { createHash } from "node:crypto";

import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";

import { AgentAccountLastUsage } from "./agent-accounts-last-usage.js";
import type { AgentAccountLoginHandle } from "./agent-accounts-login.js";
import { PlanUsageState } from "./plan-usage-cache.js";
import { createPlanUsageReader, type PlanUsageReader } from "./plan-usage.js";

/**
 * Login refreshers the backend's login keeper provides. Each returns
 * `undefined` when there is nothing to ask (the keeper is not running yet, or
 * has stopped), which callers treat as "no refresh happened".
 */
export type AgentAccountsRuntimeOptions = {
  /** `ContainerClaudeLoginKeeper.refreshLocalLoginIfDue`. */
  localClaudeLoginRefresher?: () => Promise<unknown> | undefined;
  /** `ContainerClaudeLoginKeeper.refreshHostIfDue`. */
  hostClaudeLoginRefresher?: () => Promise<unknown> | undefined;
  /** `createCodexLoginRefresher`: renews the Codex login in the home that owns it. */
  localCodexLoginRefresher?: (home: string) => Promise<void> | undefined;
};

/** A sign-in started by `startAgentAccountLogin`. */
export interface AgentAccountLogin {
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

export interface AgentAccountCachedUsage {
  expiresAt: number;
  rateLimited?: boolean;
  snapshot: PlanUsageSnapshot;
}

const MAX_MCP_DIGESTS_PER_SERVER = 8;
const MAX_MCP_SERVERS = 128;

/** The host's MCP refresh-token digests, most recent first, per `mcpOAuth` key. */
export class HostMcpRefreshDigests {
  private readonly digests = new Map<string, string[]>();

  remember(credentials: string): void {
    let mcpOAuth: unknown;
    try {
      mcpOAuth = (JSON.parse(credentials) as { mcpOAuth?: unknown } | null)?.mcpOAuth;
    } catch {
      return;
    }
    if (!mcpOAuth || typeof mcpOAuth !== "object" || Array.isArray(mcpOAuth)) return;
    for (const [key, entry] of Object.entries(mcpOAuth)) {
      const token = (entry as { refreshToken?: unknown } | null)?.refreshToken;
      if (typeof token !== "string" || !token.trim()) continue;
      const digest = createHash("sha256").update(token).digest("hex");
      const known = this.digests.get(key) ?? [];
      this.digests.delete(key);
      this.digests.set(
        key,
        [digest, ...known.filter((value) => value !== digest)].slice(0, MAX_MCP_DIGESTS_PER_SERVER),
      );
    }
    for (const key of this.digests.keys()) {
      if (this.digests.size <= MAX_MCP_SERVERS) break;
      this.digests.delete(key);
    }
  }

  snapshot(): Record<string, string[]> {
    return Object.fromEntries(this.digests);
  }
}

/**
 * Agent-account state of one backend: the account mutation chain, the single
 * in-flight sign-in, per-account usage, plan usage (`planUsage`, `readPlanUsage`,
 * `lastUsage`), what was pushed into each container, the login refreshers its
 * keeper provides, and the coordinator homes whose Keychain login was already
 * removed. Owned by `BackendRuntime` as `accounts` and reached through
 * `context.runtime` at call time. The refreshers are construction options, not
 * registrations: `index.ts` passes closures over its keeper.
 */
export class AgentAccountsRuntime {
  readonly lastUsage = new AgentAccountLastUsage();
  /** The active account's plan usage: the cache sessions write through. */
  readonly planUsage = new PlanUsageState();
  /** The provider read behind the settings card, over `planUsage.cache`. */
  readonly readPlanUsage: PlanUsageReader = createPlanUsageReader({ cache: this.planUsage.cache });
  /** MCP refresh tokens seen on the host, as digests handed to containers. */
  readonly hostMcpRefreshDigests = new HostMcpRefreshDigests();
  private readonly options: AgentAccountsRuntimeOptions;
  private readonly clearedCoordinatorKeychainHomes = new Set<string>();
  private mutation: Promise<void> = Promise.resolve();
  /**
   * The single in-flight sign-in. One at a time across platforms: both CLIs
   * are human-paced browser flows and a second one would only confuse which
   * tab belongs to which account.
   */
  private login: AgentAccountLogin | undefined;
  private readonly usage = new Map<string, AgentAccountCachedUsage>();
  private readonly usageGenerations = new Map<string, number>();
  /**
   * What each container was last handed, as a digest of the access-only text,
   * so the keeper only writes into a container when the host's login changed.
   * Lost on restart, when every running container is simply pushed once more.
   */
  private readonly pushedClaudeLogins = new Map<string, string>();

  constructor(options: AgentAccountsRuntimeOptions = {}) {
    this.options = options;
  }

  /**
   * Asks the keeper to have Claude refresh the active local login when it is
   * due. Resolves `false` when there was no keeper to ask; a failed refresh
   * still counts as asked.
   */
  refreshLocalClaudeLogin(): Promise<boolean> {
    return asked(this.options.localClaudeLoginRefresher?.());
  }

  /**
   * Asks the host to refresh the active Claude login when it is due, so a
   * container start that finds the host token expired does not leave the
   * container signed out until the keeper's next pass.
   */
  refreshHostClaudeLogin(): Promise<boolean> {
    return asked(this.options.hostClaudeLoginRefresher?.());
  }

  /** Renews the Codex login in `home`; `false` when there was nothing to ask. */
  refreshLocalCodexLogin(home: string): Promise<boolean> {
    return asked(this.options.localCodexLoginRefresher?.(home));
  }

  /** Runs `run` after every account mutation already queued, one at a time. */
  async withMutation<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release: () => void = () => undefined;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  }

  activeLogin(): AgentAccountLogin | undefined {
    return this.login;
  }

  claimLogin(login: AgentAccountLogin): void {
    this.login = login;
  }

  clearLogin(): void {
    this.login = undefined;
  }

  cachedUsage(key: string): AgentAccountCachedUsage | undefined {
    return this.usage.get(key);
  }

  cacheUsage(key: string, entry: AgentAccountCachedUsage): void {
    this.usage.set(key, entry);
  }

  forgetUsage(key: string): void {
    this.usage.delete(key);
  }

  usageGeneration(key: string): number {
    return this.usageGenerations.get(key) ?? 0;
  }

  bumpUsageGeneration(key: string): void {
    this.usageGenerations.set(key, this.usageGeneration(key) + 1);
  }

  pushedClaudeLogin(containerId: string): string | undefined {
    return this.pushedClaudeLogins.get(containerId);
  }

  rememberPushedClaudeLogin(containerId: string, digest: string): void {
    this.pushedClaudeLogins.set(containerId, digest);
  }

  forgetPushedClaudeLogin(containerId: string): void {
    this.pushedClaudeLogins.delete(containerId);
  }

  /** True the first time a coordinator home's Keychain login is to be removed. */
  claimCoordinatorKeychainClear(coordinatorHome: string): boolean {
    if (this.clearedCoordinatorKeychainHomes.has(coordinatorHome)) return false;
    this.clearedCoordinatorKeychainHomes.add(coordinatorHome);
    return true;
  }
}

async function asked(refreshing: Promise<unknown> | undefined): Promise<boolean> {
  if (!refreshing) return false;
  await refreshing.catch(() => undefined);
  return true;
}
