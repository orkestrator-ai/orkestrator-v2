import {
  DEFAULT_AGENT_ACCOUNT_ID,
  isAgentAccountPlatform,
  MAX_AGENT_ACCOUNT_LABEL_LENGTH,
  type AgentAccountIdentity,
  type AgentAccountPlatform,
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

export interface AgentAccountStore {
  version: 1;
  accounts: StoredAgentAccount[];
  active: Partial<Record<AgentAccountPlatform, string>>;
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
