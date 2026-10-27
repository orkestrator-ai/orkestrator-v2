import { AgentAccountLastUsage } from "./agent-accounts-last-usage.js";

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

/**
 * Agent-account state of one backend: the last plan-usage readings
 * (`lastUsage`), the login refreshers its keeper provides, and the
 * coordinator homes whose Keychain login was already removed. Owned by
 * `BackendRuntime` as `accounts` and reached through `context.runtime` at
 * call time. The refreshers are construction options, not registrations:
 * `index.ts` passes closures over its keeper.
 */
export class AgentAccountsRuntime {
  readonly lastUsage = new AgentAccountLastUsage();
  private readonly options: AgentAccountsRuntimeOptions;
  private readonly clearedCoordinatorKeychainHomes = new Set<string>();

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
