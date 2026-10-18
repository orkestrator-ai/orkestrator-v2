import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";
import {
  isPlanUsageSnapshot,
  stalePlanUsageSnapshot,
  type PlanUsageSnapshot,
} from "@orkestrator/protocol/plan-usage";

/**
 * The last successful plan-usage reading of each account, kept on disk in
 * `<agent-accounts>/last-usage.json`.
 *
 * An account that is not in use cannot be read once its access token lapses,
 * and a rate-limited read cannot be read at all. Both show this reading,
 * marked stale, instead. The file holds no credential.
 */

const FILE_NAME = "last-usage.json";

type LastUsageStore = Record<string, PlanUsageSnapshot>;

const loaded = new Map<string, Promise<LastUsageStore>>();
const writes = new Map<string, Promise<void>>();
const dirty = new Set<string>();

function storeKey(platform: AgentAccountPlatform, accountId: string): string {
  return `${platform}:${accountId}`;
}

function storeFile(accountsRoot: string): string {
  return path.join(path.resolve(accountsRoot), FILE_NAME);
}

async function loadStore(accountsRoot: string): Promise<LastUsageStore> {
  const file = storeFile(accountsRoot);
  let store = loaded.get(file);
  if (!store) {
    store = fs
      .readFile(file, "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as unknown;
        const result: LastUsageStore = {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if (isPlanUsageSnapshot(value) && value.status === "ok" && !value.stale)
              result[key] = value;
          }
        }
        return result;
      })
      .catch(() => ({}));
    loaded.set(file, store);
  }
  return store;
}

/** Serialized: each write saves the whole store as it stands then. */
function persist(accountsRoot: string, store: LastUsageStore): Promise<void> {
  const file = storeFile(accountsRoot);
  const write = (writes.get(file) ?? Promise.resolve()).then(async () => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
      await fs.rename(temporary, file);
      dirty.delete(file);
    } catch {
      dirty.add(file);
      console.warn("[agent-accounts] Could not save the last plan usage reading");
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  writes.set(file, write);
  return write;
}

/** Keep a successful reading as the account's last known usage. */
export async function rememberAgentAccountUsage(
  accountsRoot: string,
  platform: AgentAccountPlatform,
  accountId: string,
  snapshot: PlanUsageSnapshot,
): Promise<void> {
  if (snapshot.status !== "ok" || snapshot.stale) return;
  const store = await loadStore(accountsRoot);
  const key = storeKey(platform, accountId);
  const previous = store[key];
  // The active account is served from a shared cache, so the same reading
  // arrives on every settings read until it is replaced.
  if (previous && Date.parse(previous.fetchedAt) >= Date.parse(snapshot.fetchedAt)) {
    if (dirty.has(storeFile(accountsRoot))) await persist(accountsRoot, store);
    return;
  }
  store[key] = snapshot;
  await persist(accountsRoot, store);
}

export async function forgetAgentAccountUsage(
  accountsRoot: string,
  platform: AgentAccountPlatform,
  accountId: string,
): Promise<void> {
  const store = await loadStore(accountsRoot);
  const key = storeKey(platform, accountId);
  if (!(key in store) && !dirty.has(storeFile(accountsRoot))) return;
  delete store[key];
  await persist(accountsRoot, store);
}

/**
 * A fresh reading is remembered and returned. Anything else is answered with
 * the last known reading, marked stale and carrying the failure's message, when
 * there is one.
 */
export async function withLastKnownUsage(
  accountsRoot: string,
  platform: AgentAccountPlatform,
  accountId: string,
  snapshot: PlanUsageSnapshot,
  now: number,
): Promise<PlanUsageSnapshot> {
  if (snapshot.status === "ok") {
    if (!snapshot.stale)
      await rememberAgentAccountUsage(accountsRoot, platform, accountId, snapshot);
    return snapshot;
  }
  const last = (await loadStore(accountsRoot))[storeKey(platform, accountId)];
  return last ? stalePlanUsageSnapshot(last, now, snapshot.message) : snapshot;
}

/** Test seam: forget what was loaded so each test reads its own directory. */
export function resetAgentAccountLastUsageForTests(): void {
  loaded.clear();
  writes.clear();
  dirty.clear();
}
