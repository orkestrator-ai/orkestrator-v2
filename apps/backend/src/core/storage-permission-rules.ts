import { PermissionRuleStore } from "./permission-rules/store.js";
import type { StorageContext } from "./storage-context.js";

/** Adapts the permission-rule store to the shared database and change journal. */
export class PermissionRulesRepository {
  private storeInstance: PermissionRuleStore | null = null;

  constructor(private readonly context: StorageContext) {}

  store(): PermissionRuleStore {
    this.storeInstance ??= new PermissionRuleStore({
      database: () => this.context.database,
      announce: (id) => this.context.changes.announce("permission-rule", id),
    });
    return this.storeInstance;
  }
}
