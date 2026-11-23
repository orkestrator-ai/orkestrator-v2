/** The errors {@link StorageDatabase} throws, re-exported from `database.ts`. */

export class StorageDatabaseVersionError extends Error {
  constructor(found: number, supported: number) {
    super(
      `Storage database schema version ${found} is newer than this build supports (${supported}). Update Orkestrator to open it.`,
    );
    this.name = "StorageDatabaseVersionError";
  }
}

/** A stored value that is not valid JSON (imported from a corrupt legacy file). */
export class StoreCorruptError extends Error {
  constructor(store: string) {
    super(`Storage ${store} is unreadable`);
    this.name = "StoreCorruptError";
  }
}

/** A write refused by its `maxBytes` bound; nothing was written. */
export class StoreTooLargeError extends Error {
  constructor(
    store: string,
    readonly bytes: number,
  ) {
    super(`Storage ${store} would exceed its size limit`);
    this.name = "StoreTooLargeError";
  }
}

export class StoreConflictError extends Error {
  constructor(store: string) {
    super(`Storage ${store} changed concurrently`);
    this.name = "StoreConflictError";
  }
}
