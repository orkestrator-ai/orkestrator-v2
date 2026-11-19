import { CredentialRecordStore } from "./credentials/records.js";
import type { StorageContext } from "./storage-context.js";

/** Adapts the agent credential records to the shared database and change journal. */
export class CredentialsRepository {
  private storeInstance: CredentialRecordStore | null = null;

  constructor(private readonly context: StorageContext) {}

  store(): CredentialRecordStore {
    this.storeInstance ??= new CredentialRecordStore({
      database: () => this.context.database,
      announce: (id) => this.context.changes.announce("credential", id),
    });
    return this.storeInstance;
  }
}
