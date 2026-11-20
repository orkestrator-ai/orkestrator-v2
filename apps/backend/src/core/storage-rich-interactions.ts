import { RichInteractionStore } from "./rich-interactions/store.js";
import type { StorageContext } from "./storage-context.js";

/** Adapts the rich interaction store to the shared database and change journal. */
export class RichInteractionsRepository {
  private storeInstance: RichInteractionStore | null = null;

  constructor(private readonly context: StorageContext) {}

  store(): RichInteractionStore {
    this.storeInstance ??= new RichInteractionStore({
      database: () => this.context.database,
      announce: (environmentId) => this.context.changes.announce("rich-interaction", environmentId),
    });
    return this.storeInstance;
  }
}
