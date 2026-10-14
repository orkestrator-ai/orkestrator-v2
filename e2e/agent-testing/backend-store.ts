/**
 * Reads or replaces one backend database store from outside the backend, for
 * specs that stage state behind a running agent-test backend. Run with Bun
 * (specs run under Node, which has no `bun:sqlite`):
 *
 *   bun backend-store.ts <dataDir> <store.json> read
 *   bun backend-store.ts <dataDir> <store.json> write   (JSON value on stdin)
 *   bun backend-store.ts <dataDir> <store.json> delete
 *
 * The write commits like a second backend process sharing the directory; the
 * running backend observes it through the store's committed revision.
 */
import {
  deleteStoredValue,
  readStoredValue,
  seedStore,
} from "../../apps/backend/src/core/storage-test-support";

const [dataDir, file, action] = process.argv.slice(2);
if (!dataDir || !file) throw new Error("usage: backend-store.ts <dataDir> <store.json> <action>");
if (action === "read") {
  const value = readStoredValue(dataDir, file);
  process.stdout.write(JSON.stringify(value === undefined ? null : { value }));
} else if (action === "write") {
  seedStore(dataDir, file, JSON.parse(await Bun.stdin.text()) as unknown);
} else if (action === "delete") {
  deleteStoredValue(dataDir, file);
} else {
  throw new Error(`Unknown action: ${action}`);
}
