/**
 * Additional provider logins for the platforms whose CLI keeps its whole login
 * in one configuration directory.
 *
 * Each added account is its own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. The
 * implicit `default` account is the host's own login and is always present.
 * Exactly one account per platform is active; switching is global, so no tab,
 * environment or settings tier records an account. See
 * docs/architecture/agent-accounts.md.
 */
import {
  parseAgentAccountAutoSwitchStates,
  type AgentAccountAutoSwitchStates,
} from "./agent-account-auto-switch.js";

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
  /**
   * Shared entries (settings, skills, transcripts, …) this added account now
   * keeps as its own copy instead of a link to the host's, because its CLI
   * replaced the link when saving. Names only; absent when every entry is
   * still shared and always absent for the host login.
   */
  privateEntries?: string[];
}

export interface AgentAccountsSnapshot {
  accounts: AgentAccountSummary[];
  active: Record<AgentAccountPlatform, string>;
  /** Automatic switching on this machine. Absent from a machine that predates it. */
  autoSwitch?: AgentAccountAutoSwitchStates;
}

/**
 * Which of the machine's logins one session's bridge uses, for the agent
 * information panel. The backend builds it from what it launched; it is never
 * taken from a bridge answer.
 */
export interface AgentSessionAccount {
  platform: AgentAccountPlatform;
  /**
   * `account`: one of the machine's accounts, in `account`. `container`: an
   * isolated container that keeps its own login. `unknown`: the container's
   * login could not be read.
   */
  source: "account" | "container" | "unknown";
  account?: AgentAccountSummary;
  /** Whether the bridge is running. When it is not, its next start uses `account`. */
  running: boolean;
  /**
   * The machine's active account, when the running bridge is still on another
   * one. The bridge moves to it the next time it is used while idle.
   */
  pendingActive?: AgentAccountSummary;
}

/**
 * One machine's accounts, as a command node collects them for the accounts
 * overview (`list_machine_agent_accounts`). Every machine keeps its own logins;
 * nothing here is a credential.
 */
export interface MachineAgentAccounts {
  /** The machine's node identity. */
  nodeId: string;
  name: string;
  colorToken?: string;
  /** The command node answering, rather than one of its machines. */
  self: boolean;
  /** `unavailable`: not connected. `error`: it answered with a failure. */
  state: "ok" | "unavailable" | "error";
  error?: string;
  snapshot?: AgentAccountsSnapshot;
  /** Absent when the machine predates the read, or could not answer it. */
  signIns?: HostAgentSignIns;
}

/**
 * Platforms with one login per machine and no accounts. The accounts overview
 * shows their sign-in state read-only, with a terminal sign-in on the machine.
 */
export const HOST_SIGN_IN_PLATFORMS = ["grok", "pi"] as const;
export type HostSignInPlatform = (typeof HOST_SIGN_IN_PLATFORMS)[number];

export function isHostSignInPlatform(value: unknown): value is HostSignInPlatform {
  return typeof value === "string" && (HOST_SIGN_IN_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Whether a machine has a login a local bridge would use, from files and
 * variable names only (`read_host_agent_sign_ins`). It is not checked against
 * the provider, so an expired or revoked login still reads as signed in.
 */
export interface HostAgentSignIn {
  state: "signed-in" | "signed-out";
  /** Where the login comes from, e.g. "Stored login", "XAI_API_KEY", or Pi's provider ids. Never a credential. */
  source?: string;
}

export type HostAgentSignIns = Partial<Record<HostSignInPlatform, HostAgentSignIn>>;

/** The terminal tab `open_agent_sign_in_terminal` opened, for the client to show. */
export interface AgentSignInTerminal {
  environmentId: string;
  projectId: string;
  tabId: string;
}

export interface MachineAgentAccountsResult {
  machines: MachineAgentAccounts[];
  /**
   * The login the user wants each machine on, per platform, kept by the
   * machine answering (`set_preferred_agent_identity`). Absent from older
   * machines and when nothing is preferred.
   */
  preferred?: PreferredAgentIdentities;
}

/**
 * The email of the login a user prefers for a platform across machines. It is
 * a pointer, never a credential: the overview flags machines whose active
 * login has another email and offers to switch the ones that have it. Nothing
 * switches by itself and nothing is sent to other machines.
 */
export type PreferredAgentIdentities = Partial<Record<AgentAccountPlatform, string>>;

const MAX_PREFERRED_EMAIL_LENGTH = 320;

/** A trimmed email, or undefined when `value` cannot name one. */
export function normalizePreferredEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  if (!email || email.length > MAX_PREFERRED_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return undefined;
  }
  return email;
}

/** Keep only platforms with a valid email; peer and stored values are untrusted. */
export function parsePreferredAgentIdentities(value: unknown): PreferredAgentIdentities {
  const preferred: PreferredAgentIdentities = {};
  if (!isAccountRecord(value)) return preferred;
  for (const platform of AGENT_ACCOUNT_PLATFORMS) {
    const email = normalizePreferredEmail(value[platform]);
    if (email) preferred[platform] = email;
  }
  return preferred;
}

/** Whether a login's email names the preferred one. Emails compare case-insensitively. */
export function isPreferredIdentity(
  identity: AgentAccountIdentity,
  preferredEmail: string | undefined,
): boolean {
  const email = identity.email?.trim();
  return Boolean(email && preferredEmail && email.toLowerCase() === preferredEmail.toLowerCase());
}

/**
 * Announced by a node whenever its Claude or Codex accounts change: a switch,
 * an added, renamed or removed account, or a renewed login. It only says that
 * something changed; a view re-reads `list_agent_accounts` (on another machine,
 * through the command node's relay). A sign-in made outside Orkestrator, such
 * as `claude auth login` in a terminal, is never announced.
 */
export const AGENT_ACCOUNTS_CHANGED_EVENT = "agent-accounts-changed";

export interface AgentAccountsChangedEvent {
  platform: AgentAccountPlatform;
}

export function isAgentAccountsChangedEvent(value: unknown): value is AgentAccountsChangedEvent {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    isAgentAccountPlatform((value as { platform?: unknown }).platform)
  );
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

/** Reconstruct peer sign-in metadata without retaining credentials or extra fields. */
export function parseHostAgentSignIns(value: unknown): HostAgentSignIns | undefined {
  if (!isAccountRecord(value)) return undefined;
  const result: HostAgentSignIns = {};
  for (const platform of HOST_SIGN_IN_PLATFORMS) {
    const entry = value[platform];
    if (!isAccountRecord(entry)) continue;
    if (entry.state !== "signed-in" && entry.state !== "signed-out") continue;
    result[platform] = {
      state: entry.state,
      ...(typeof entry.source === "string" && entry.source
        ? { source: entry.source.slice(0, 120) }
        : {}),
    };
  }
  return result;
}

function isAccountRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Peer summaries are untrusted. Reject malformed rows and copy only display fields. */
export function parseAgentAccountsSnapshot(value: unknown): AgentAccountsSnapshot | undefined {
  if (!isAccountRecord(value) || !Array.isArray(value.accounts) || !isAccountRecord(value.active)) {
    return undefined;
  }
  const { claude, codex } = value.active;
  if (
    typeof claude !== "string" ||
    !claude ||
    claude.length > 128 ||
    typeof codex !== "string" ||
    !codex ||
    codex.length > 128
  )
    return undefined;
  if (value.accounts.length > 2 * (MAX_AGENT_ACCOUNTS_PER_PLATFORM + 1)) return undefined;
  const accounts: AgentAccountSummary[] = [];
  const seen = new Set<string>();
  for (const row of value.accounts) {
    if (
      !isAccountRecord(row) ||
      !isAgentAccountPlatform(row.platform) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 128 ||
      typeof row.label !== "string" ||
      !row.label ||
      typeof row.isDefault !== "boolean" ||
      typeof row.isActive !== "boolean" ||
      typeof row.signedIn !== "boolean" ||
      !isAccountRecord(row.identity)
    )
      return undefined;
    const key = `${row.platform}:${row.id}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const identity: AgentAccountIdentity = {};
    for (const field of ["email", "organizationName", "plan"] as const) {
      const text = row.identity[field];
      if (text !== undefined && typeof text !== "string") return undefined;
      if (typeof text === "string") identity[field] = text.slice(0, 320);
    }
    if (row.createdAt !== undefined && typeof row.createdAt !== "string") return undefined;
    accounts.push({
      id: row.id,
      platform: row.platform,
      label: row.label.slice(0, MAX_AGENT_ACCOUNT_LABEL_LENGTH),
      isDefault: row.isDefault,
      isActive: row.isActive,
      signedIn: row.signedIn,
      identity,
      ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt.slice(0, 80) } : {}),
    });
  }
  const autoSwitch = parseAgentAccountAutoSwitchStates(value.autoSwitch);
  return { accounts, active: { claude, codex }, ...(autoSwitch ? { autoSwitch } : {}) };
}
