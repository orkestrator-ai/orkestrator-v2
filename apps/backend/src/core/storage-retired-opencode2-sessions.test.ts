import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageDatabase } from "./storage-database.js";
import {
  RETIRED_OPENCODE2_SESSIONS_STORE,
  RETIRE_OPENCODE2_SESSIONS_VERSION,
} from "./storage-retired-features.js";
import { STORAGE_MIGRATIONS, openBackendDatabase, storeLayout } from "./storage-stores.js";

const directories: string[] = [];
const open: StorageDatabase[] = [];
afterEach(async () => {
  for (const database of open.splice(0)) database.close();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

test("the retire-opencode2-sessions migration deletes the store the OpenCode 2 preview wrote", async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-retired-opencode2-sessions-"));
  directories.push(directory);
  const before = new StorageDatabase(directory, {
    layoutFor: (store) =>
      store === RETIRED_OPENCODE2_SESSIONS_STORE
        ? { kind: "record", owner: (value) => (value as { environmentId: string }).environmentId }
        : storeLayout(store),
    migrations: STORAGE_MIGRATIONS.filter(
      (migration) => migration.version < RETIRE_OPENCODE2_SESSIONS_VERSION,
    ),
  });
  before.writeStore(RETIRED_OPENCODE2_SESSIONS_STORE, {
    "env-1": { environmentId: "env-1", sessionIds: ["ses_1"] },
  });
  before.writeStore("kanban", [{ id: "t1", projectId: "p1", title: "Kept" }]);
  expect(before.readStore(RETIRED_OPENCODE2_SESSIONS_STORE)).not.toBeNull();
  before.close();

  const after = openBackendDatabase(directory);
  open.push(after);
  expect(after.schemaVersion()).toBeGreaterThanOrEqual(RETIRE_OPENCODE2_SESSIONS_VERSION);
  expect(after.readStore(RETIRED_OPENCODE2_SESSIONS_STORE)).toBeNull();
  expect(after.readStore("kanban")?.value).toEqual([{ id: "t1", projectId: "p1", title: "Kept" }]);
});
