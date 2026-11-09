import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  isNewerSharedUsageReading,
  parseSharedUsageReading,
  SHARED_USAGE_LIMITS,
  usageIdentityKey,
  type SharedUsageReading,
  type UsageIdentity,
} from "@orkestrator/protocol/agent-account-shared-usage";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("agent-accounts");

/**
 * The newest plan-usage reading of each login identity this machine knows, kept
 * in `<agent-accounts>/shared-usage.json` (docs/architecture/agent-accounts.md,
 * "Shared readings").
 *
 * It holds this machine's own fresh readings and the ones its command node
 * shared with it, newest per identity (provider, email, organisation). On a
 * command node it is also the central copy every other machine's readings
 * are merged into, so a machine that reconnects while the one that took a
 * reading is offline still gets it. The file holds usage only, never a
 * credential, and at most {@link SHARED_USAGE_LIMITS.maxReadings} entries:
 * past that the oldest reading goes.
 *
 * Owned by `AgentAccountsRuntime` as `sharedUsage`.
 */

const FILE_NAME = "shared-usage.json";

type Store = Map<string, SharedUsageReading>;

export class AgentAccountSharedUsage {
  private readonly loaded = new Map<string, Promise<Store>>();
  private readonly writes = new Map<string, Promise<void>>();

  async get(accountsRoot: string, identity: UsageIdentity): Promise<SharedUsageReading | undefined> {
    return (await this.load(accountsRoot)).get(usageIdentityKey(identity));
  }

  async all(accountsRoot: string): Promise<SharedUsageReading[]> {
    return Array.from((await this.load(accountsRoot)).values());
  }

  /**
   * Keep each reading that is newer than the one held for its identity. When
   * `identities` is given, readings of any other identity are ignored (a leaf
   * keeps only its own logins). Answers the readings kept.
   */
  async record(
    accountsRoot: string,
    readings: readonly SharedUsageReading[],
    now: number,
    identities?: ReadonlySet<string>,
  ): Promise<SharedUsageReading[]> {
    const store = await this.load(accountsRoot);
    const kept: SharedUsageReading[] = [];
    for (const candidate of readings) {
      // Checked again here: a store is written by peers as well as this machine.
      const reading = parseSharedUsageReading(candidate, now);
      if (!reading) continue;
      const key = usageIdentityKey(reading.identity);
      if (identities && !identities.has(key)) continue;
      if (!isNewerSharedUsageReading(reading, store.get(key))) continue;
      store.delete(key);
      store.set(key, reading);
      kept.push(reading);
    }
    if (kept.length === 0) return kept;
    while (store.size > SHARED_USAGE_LIMITS.maxReadings) {
      let oldest: [string, number] | undefined;
      for (const [key, reading] of store) {
        const at = Date.parse(reading.fetchedAt);
        if (!oldest || at < oldest[1]) oldest = [key, at];
      }
      if (!oldest) break;
      store.delete(oldest[0]);
    }
    await this.persist(accountsRoot, store);
    return kept;
  }

  private load(accountsRoot: string): Promise<Store> {
    const file = storeFile(accountsRoot);
    let store = this.loaded.get(file);
    if (!store) {
      store = fs
        .readFile(file, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw) as unknown;
          const result: Store = new Map();
          if (!Array.isArray(parsed)) return result;
          const now = Date.now();
          for (const value of parsed.slice(0, SHARED_USAGE_LIMITS.maxReadings)) {
            const reading = parseSharedUsageReading(value, now);
            if (!reading) continue;
            const key = usageIdentityKey(reading.identity);
            if (isNewerSharedUsageReading(reading, result.get(key))) result.set(key, reading);
          }
          return result;
        })
        .catch(() => new Map());
      this.loaded.set(file, store);
    }
    return store;
  }

  /** Serialized: each write saves the whole store as it stands then. */
  private persist(accountsRoot: string, store: Store): Promise<void> {
    const file = storeFile(accountsRoot);
    const write = (this.writes.get(file) ?? Promise.resolve()).then(async () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(temporary, JSON.stringify(Array.from(store.values())), { mode: 0o600 });
        await fs.rename(temporary, file);
      } catch {
        // Kept in memory; the next reading writes the whole store again.
        log.warn("shared-usage.save-failed");
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
    this.writes.set(file, write);
    return write;
  }
}

function storeFile(accountsRoot: string): string {
  return path.join(path.resolve(accountsRoot), FILE_NAME);
}
