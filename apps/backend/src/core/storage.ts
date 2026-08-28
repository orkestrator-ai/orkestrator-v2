export * from "./storage-shared.js";

import { StorageKanban } from "./storage-kanban.js";

export class StorageService extends StorageKanban {
  override async init(): Promise<void> {
    await super.init();
    await this.migrateConfigSchema();
  }
}
