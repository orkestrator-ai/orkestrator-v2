/**
 * Stages or reads Orkestrator permission rules (todo 0723) behind a running
 * agent-test backend, like `backend-store.ts` does for whole stores. Run with
 * Bun (specs run under Node, which has no `bun:sqlite`):
 *
 *   bun permission-rules-store.ts <dataDir> list
 *   bun permission-rules-store.ts <dataDir> create   (rule JSON on stdin)
 *
 * The write commits like a second backend process sharing the directory; the
 * running backend reads the rows uncached, so it sees the rule at once.
 */
import { PermissionRuleStore } from "../../apps/backend/src/core/permission-rules/store";
import { openBackendDatabase } from "../../apps/backend/src/core/storage-stores";

const [dataDir, action] = process.argv.slice(2);
if (!dataDir) throw new Error("usage: permission-rules-store.ts <dataDir> <list|create>");
const database = openBackendDatabase(dataDir);
try {
  const store = new PermissionRuleStore({ database: () => database });
  if (action === "list") {
    process.stdout.write(JSON.stringify(store.list()));
  } else if (action === "create") {
    store.create(JSON.parse(await Bun.stdin.text()));
  } else {
    throw new Error(`Unknown action: ${action}`);
  }
} finally {
  database.close();
}
