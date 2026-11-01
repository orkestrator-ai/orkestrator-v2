import {
  AUTO_SWITCH_REASONS,
  type AgentAccountAutoSwitchLastSwitch,
  type AutoSwitchReason,
} from "@orkestrator/protocol/agent-account-auto-switch";
import {
  AGENT_ACCOUNT_PLATFORMS,
  DEFAULT_AGENT_ACCOUNT_ID,
  isAgentAccountPlatform,
  MAX_AGENT_ACCOUNT_LABEL_LENGTH,
  parsePreferredAgentIdentities,
  type AgentAccountIdentity,
  type AgentAccountPlatform,
  type PreferredAgentIdentities,
} from "@orkestrator/protocol/agent-accounts";

/**
 * The persisted registry of added accounts (`agent-accounts.json`).
 *
 * It lives outside `config.json` on purpose: the renderer writes the whole
 * global config back, and a list it never edits must not be overwritten by a
 * stale copy. The file holds no credential; each account's login stays in its
 * own directory or Keychain entry.
 */
export interface StoredAgentAccount {
  id: string;
  platform: AgentAccountPlatform;
  label: string;
  createdAt: string;
  /** Provider identity the login resolved to, used to refuse duplicates. */
  identityKey?: string;
  identity?: AgentAccountIdentity;
}

/**
 * What automatic switching keeps per machine, per platform. The ticks that
 * travel are in the global config; these never leave the machine.
 */
export interface StoredAgentAccountAutoSwitch {
  /** A manual switch: automatic switching stays off here until ticked again. */
  pin?: { accountId: string; pinnedAt: string };
  /** Accounts with no email whose own tick is on; they cannot be matched elsewhere. */
  includedAccountIds?: string[];
  lastSwitch?: AgentAccountAutoSwitchLastSwitch;
}

export interface AgentAccountStore {
  version: 1;
  /** Durable renewal revision compared with running containers. */
  loginGeneration?: Partial<Record<AgentAccountPlatform, string>>;
  accounts: StoredAgentAccount[];
  active: Partial<Record<AgentAccountPlatform, string>>;
  /**
   * The email of the login wanted on every machine, per platform, for the
   * accounts overview (`set_preferred_agent_identity`). A pointer only: no
   * account here or elsewhere is switched because of it.
   */
  preferred?: PreferredAgentIdentities;
  autoSwitch?: Partial<Record<AgentAccountPlatform, StoredAgentAccountAutoSwitch>>;
}

export function emptyAgentAccountStore(): AgentAccountStore {
  return { version: 1, accounts: [], active: {} };
}

/** Ids name a directory, so they are restricted to a lowercase UUID. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isStoredAgentAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

function optionalString(value: unknown, max = 320): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : undefined;
}

function parseIdentity(value: unknown): AgentAccountIdentity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const identity: AgentAccountIdentity = {};
  const email = optionalString(record.email);
  const organizationName = optionalString(record.organizationName);
  const plan = optionalString(record.plan, 64);
  if (email) identity.email = email;
  if (organizationName) identity.organizationName = organizationName;
  if (plan) identity.plan = plan;
  return Object.keys(identity).length > 0 ? identity : undefined;
}

function parseAutoSwitch(value: unknown): AgentAccountStore["autoSwitch"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed: NonNullable<AgentAccountStore["autoSwitch"]> = {};
  for (const platform of AGENT_ACCOUNT_PLATFORMS) {
    const entry = (value as Record<string, unknown>)[platform] as
      Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const state: StoredAgentAccountAutoSwitch = {};
    const pin = entry.pin as Record<string, unknown> | undefined;
    const pinnedId = pin && optionalString(pin.accountId, 128);
    const pinnedAt = pin && optionalString(pin.pinnedAt, 64);
    if (pinnedId && pinnedAt) state.pin = { accountId: pinnedId, pinnedAt };
    if (Array.isArray(entry.includedAccountIds)) {
      const ids = entry.includedAccountIds.filter(
        (id): id is string => id === DEFAULT_AGENT_ACCOUNT_ID || isStoredAgentAccountId(id),
      );
      if (ids.length) state.includedAccountIds = Array.from(new Set(ids));
    }
    const last = entry.lastSwitch as Record<string, unknown> | undefined;
    const from = last && optionalString(last.fromAccountId, 128);
    const to = last && optionalString(last.toAccountId, 128);
    const at = last && optionalString(last.at, 64);
    if (from && to && at && (AUTO_SWITCH_REASONS as readonly unknown[]).includes(last?.reason)) {
      state.lastSwitch = {
        fromAccountId: from,
        toAccountId: to,
        at,
        reason: last?.reason as AutoSwitchReason,
      };
    }
    if (Object.keys(state).length) parsed[platform] = state;
  }
  return Object.keys(parsed).length ? parsed : undefined;
}

function parseAccount(value: unknown): StoredAgentAccount | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isStoredAgentAccountId(record.id) || !isAgentAccountPlatform(record.platform)) {
    return undefined;
  }
  const label = optionalString(record.label, MAX_AGENT_ACCOUNT_LABEL_LENGTH);
  const createdAt = optionalString(record.createdAt, 64);
  if (!label || !createdAt) return undefined;
  const identityKey = optionalString(record.identityKey, 512);
  const identity = parseIdentity(record.identity);
  return {
    id: record.id,
    platform: record.platform,
    label,
    createdAt,
    ...(identityKey ? { identityKey } : {}),
    ...(identity ? { identity } : {}),
  };
}

/**
 * Tolerant read: a malformed entry is dropped rather than failing every
 * account, and an active id that no longer names an account falls back to the
 * host login.
 */
export function parseAgentAccountStore(value: unknown): AgentAccountStore {
  const store = emptyAgentAccountStore();
  if (!value || typeof value !== "object" || Array.isArray(value)) return store;
  const record = value as Record<string, unknown>;
  if (record.loginGeneration && typeof record.loginGeneration === "object") {
    const generations: Partial<Record<AgentAccountPlatform, string>> = {};
    for (const [platform, generation] of Object.entries(record.loginGeneration)) {
      if (isAgentAccountPlatform(platform) && isStoredAgentAccountId(generation))
        generations[platform] = generation;
    }
    if (Object.keys(generations).length) store.loginGeneration = generations;
  }
  const preferred = parsePreferredAgentIdentities(record.preferred);
  if (Object.keys(preferred).length) store.preferred = preferred;
  const autoSwitch = parseAutoSwitch(record.autoSwitch);
  if (autoSwitch) store.autoSwitch = autoSwitch;
  const seen = new Set<string>();
  for (const entry of Array.isArray(record.accounts) ? record.accounts : []) {
    const account = parseAccount(entry);
    if (!account || seen.has(account.id)) continue;
    seen.add(account.id);
    store.accounts.push(account);
  }
  const active = record.active;
  if (active && typeof active === "object" && !Array.isArray(active)) {
    for (const [platform, id] of Object.entries(active as Record<string, unknown>)) {
      if (!isAgentAccountPlatform(platform) || typeof id !== "string") continue;
      if (id === DEFAULT_AGENT_ACCOUNT_ID) continue;
      if (store.accounts.some((account) => account.id === id && account.platform === platform)) {
        store.active[platform] = id;
      }
    }
  }
  return store;
}
