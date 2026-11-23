import { expect, test } from "bun:test";

import { StoreCorruptError } from "./database.js";
import { StorageService } from "./service.js";
import { readStoredValue, storageDatabase, withTemporaryStorage } from "./test-support.js";

const DOCUMENT = { version: 1, fine: [[1, 2, 1, 50, 40]], coarse: [] };

test("the history is one row that survives reopening the storage", async () => {
  await withTemporaryStorage(async (storage, dataDir) => {
    expect(storage.machineLoadHistory.loadMachineLoadHistory()).toBeUndefined();
    storage.machineLoadHistory.saveMachineLoadHistory(DOCUMENT);
    storage.machineLoadHistory.saveMachineLoadHistory({ ...DOCUMENT, coarse: [[0, 1, 1, 0, 0]] });
    expect(readStoredValue(dataDir, "machine-load-history.json")).toEqual({
      local: { ...DOCUMENT, coarse: [[0, 1, 1, 0, 0]] },
    });

    const reopened = new StorageService(dataDir);
    await reopened.init();
    try {
      expect(reopened.machineLoadHistory.loadMachineLoadHistory()).toEqual({
        ...DOCUMENT,
        coarse: [[0, 1, 1, 0, 0]],
      });
    } finally {
      reopened.close();
    }
  });
});

test("an unreadable row throws on load and is replaced by the next save", async () => {
  await withTemporaryStorage(async (storage, dataDir) => {
    storage.machineLoadHistory.saveMachineLoadHistory(DOCUMENT);
    storageDatabase(storage)
      .db.query(
        "UPDATE store_rows SET value = '{ torn' WHERE store = 'machine-load-history' AND key = 'local'",
      )
      .run();
    // A fresh process, which has no cached copy of the row.
    const reopened = new StorageService(dataDir);
    await reopened.init();
    try {
      expect(() => reopened.machineLoadHistory.loadMachineLoadHistory()).toThrow(StoreCorruptError);
      reopened.machineLoadHistory.saveMachineLoadHistory(DOCUMENT);
      expect(reopened.machineLoadHistory.loadMachineLoadHistory()).toEqual(DOCUMENT);
    } finally {
      reopened.close();
    }
  });
});
