/**
 * Additional provider logins for the platforms whose CLI keeps its whole login
 * in one configuration directory.
 *
 * Each added account is its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. The
 * implicit `default` account is the host's own login and is always present.
 * Exactly one account per platform is active; switching is global, so no tab,
 * environment or settings tier records an account. See
 * docs/plans/multi-account.md.
 */
export const AGENT_ACCOUNT_PLATFORMS = ["claude", "codex"] as const;
export type AgentAccountPlatform = (typeof AGENT_ACCOUNT_PLATFORMS)[number];

export function isAgentAccountPlatform(value: unknown): value is AgentAccountPlatform {
  return (
    typeof value === "string" && (AGENT_ACCOUNT_PLATFORMS as readonly string[]).includes(value)
  );
}

/** The host login. Never stored; it has no directory of its own. */
export const DEFAULT_AGENT_ACCOUNT_ID = "default";

export const MAX_AGENT_ACCOUNT_LABEL_LENGTH = 80;
/** Added accounts per platform, the host account not included. */
export const MAX_AGENT_ACCOUNTS_PER_PLATFORM = 16;

/** What the provider says the login is. Every field is best effort. */
export interface AgentAccountIdentity {
  email?: string;
  organizationName?: string;
  /** Subscription or plan name, e.g. `max`, `pro`, `plus`. */
  plan?: string;
}

export interface AgentAccountSummary {
  id: string;
  platform: AgentAccountPlatform;
  label: string;
  isDefault: boolean;
  isActive: boolean;
  /** Whether the account's directory holds a usable login right now. */
  signedIn: boolean;
  identity: AgentAccountIdentity;
  createdAt?: string;
}

export interface AgentAccountsSnapshot {
  accounts: AgentAccountSummary[];
  active: Record<AgentAccountPlatform, string>;
}

export type AgentAccountLoginState = "idle" | "pending" | "succeeded" | "failed";

/**
 * The single in-flight login, as the settings pane polls it.
 *
 * Claude prints an authorize URL and waits for the code the browser shows
 * (`needsCode`); Codex prints a verification URL plus a one-time code
 * (`userCode`) and finishes by itself once the user approves it.
 */
export interface AgentAccountLoginProgress {
  state: AgentAccountLoginState;
  /** Identifies a login across polls, cancellation and remounts. */
  operationId?: string;
  /** Lets a recovery card ignore a result predating its authentication failure. */
  completedAt?: string;
  platform?: AgentAccountPlatform;
  /**
   * `add` creates a new account; `reauthenticate` signs the active account in
   * again, replacing its credential in place. Absent while idle.
   */
  mode?: "add" | "reauthenticate";
  /** The account being created or renewed, present throughout the operation. */
  accountId?: string;
  url?: string;
  userCode?: string;
  needsCode?: boolean;
  /** The pasted code was sent and the CLI has not exited yet. */
  codeSubmitted?: boolean;
  error?: string;
}
