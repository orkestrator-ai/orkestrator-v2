import {
  COMPATIBILITY_PATH_USAGE_STORE,
  mergeCompatibilityPathUsage,
  normalizeCompatibilityPathUsage,
  type CompatibilityPathUsageSink,
} from "./compatibility-path-usage.js";
import { existsSync } from "node:fs";
import type { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";

/** A sink on the backend database of `dataDir`, opened on first use. */
export function compatibilityPathUsageDatabaseSink(dataDir: string): CompatibilityPathUsageSink {
  let database: StorageDatabase | null = null;
  const open = () => {
    if (!database || database.isClosed()) {
      // Never recreate a data directory that is gone; the counts stay pending.
      if (!existsSync(dataDir)) throw new Error("Data directory is missing");
      database = openBackendDatabase(dataDir);
    }
    return database;
  };
  return {
    merge(pending) {
      const db = open();
      // A read takes no write lock.
      if (pending.size === 0) {
        return normalizeCompatibilityPathUsage(db.readStore(COMPATIBILITY_PATH_USAGE_STORE)?.value);
      }
      return db.transaction(() => {
        // Older backends must not erase valid ids introduced by newer peers.
        const document = mergeCompatibilityPathUsage(
          normalizeCompatibilityPathUsage(
            db.readStoreValueInTransaction(COMPATIBILITY_PATH_USAGE_STORE)?.value,
            true,
          ),
          pending,
        );
        db.writeStoreInTransaction(COMPATIBILITY_PATH_USAGE_STORE, document);
        return normalizeCompatibilityPathUsage(document);
      });
    },
    close() {
      database?.close();
      database = null;
    },
  };
}
