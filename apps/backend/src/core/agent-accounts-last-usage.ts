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

/**
 * The last-usage store of one backend: the loaded file per accounts root, its
 * serialised writes, and the roots whose last save failed. Owned by
 * `BackendRuntime` as `accounts.lastUsage` and reached through
 * `context.runtime` at call time.
 */
export class AgentAccountLastUsage {
  private readonly loaded = new Map<string, Promise<LastUsageStore>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();

  /** Keep a successful reading as the account's last known usage. */
  async remember(
    accountsRoot: string,
    platform: AgentAccountPlatform,
    accountId: string,
    snapshot: PlanUsageSnapshot,
  ): Promise<void> {
    if (snapshot.status !== "ok" || snapshot.stale) return;
    const store = await this.load(accountsRoot);
    const key = storeKey(platform, accountId);
    const previous = store[key];
    // The active account is served from a shared cache, so the same reading
    // arrives on every settings read until it is replaced.
    if (previous && Date.parse(previous.fetchedAt) >= Date.parse(snapshot.fetchedAt)) {
      if (this.dirty.has(storeFile(accountsRoot))) await this.persist(accountsRoot, store);
      return;
    }
    store[key] = snapshot;
    await this.persist(accountsRoot, store);
  }

  async forget(
    accountsRoot: string,
    platform: AgentAccountPlatform,
    accountId: string,
  ): Promise<void> {
    const store = await this.load(accountsRoot);
    const key = storeKey(platform, accountId);
    if (!(key in store) && !this.dirty.has(storeFile(accountsRoot))) return;
    delete store[key];
    await this.persist(accountsRoot, store);
  }

  /**
   * A fresh reading is remembered and returned. Anything else is answered with
   * the last known reading, marked stale and carrying the failure's message,
   * when there is one.
   */
  async withLastKnown(
    accountsRoot: string,
    platform: AgentAccountPlatform,
    accountId: string,
    snapshot: PlanUsageSnapshot,
    now: number,
  ): Promise<PlanUsageSnapshot> {
    if (snapshot.status === "ok") {
      if (!snapshot.stale) await this.remember(accountsRoot, platform, accountId, snapshot);
      return snapshot;
    }
    const last = (await this.load(accountsRoot))[storeKey(platform, accountId)];
    return last ? stalePlanUsageSnapshot(last, now, snapshot.message) : snapshot;
  }

  private load(accountsRoot: string): Promise<LastUsageStore> {
    const file = storeFile(accountsRoot);
    let store = this.loaded.get(file);
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
      this.loaded.set(file, store);
    }
    return store;
  }

  /** Serialized: each write saves the whole store as it stands then. */
  private persist(accountsRoot: string, store: LastUsageStore): Promise<void> {
    const file = storeFile(accountsRoot);
    const write = (this.writes.get(file) ?? Promise.resolve()).then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(store), { mode: 0o600 });
        await fs.rename(temporary, file);
        this.dirty.delete(file);
      } catch {
        this.dirty.add(file);
        console.warn("[agent-accounts] Could not save the last plan usage reading");
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.writes.set(file, write);
    return write;
  }
}

function storeKey(platform: AgentAccountPlatform, accountId: string): string {
  return `${platform}:${accountId}`;
}

function storeFile(accountsRoot: string): string {
  return path.join(path.resolve(accountsRoot), FILE_NAME);
}
