/**
 * The development server `service-preview-seeded-electron.spec.ts` runs in a
 * local environment's terminal, through the fixture project's `run` command.
 *
 * It behaves like Vite on a taken port: it tries `SEEDED_ENTRY_PORT` first,
 * moves to the next free port, and prints the address it ended up on. The
 * page marker names the worktree and the process, so a check can tell which
 * environment's server a preview shows and whether a restart produced a new
 * process.
 */
import path from "node:path";

import { startPreviewFixture } from "../../test-fixtures/preview-app/server";

const first = Number(process.env.SEEDED_ENTRY_PORT);
if (!Number.isInteger(first) || first < 1 || first > 65_530) {
  throw new Error("SEEDED_ENTRY_PORT must name the project's entry port");
}
const marker = `seeded-${path.basename(process.cwd())}-${process.pid}`;

let url: string | null = null;
for (let port = first; port < first + 5 && !url; port += 1) {
  try {
    url = (await startPreviewFixture({ marker, host: "127.0.0.1", port })).url;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
}
if (!url) throw new Error(`Ports ${first} to ${first + 4} are all in use`);
if (!url.endsWith(`:${first}`)) console.log(`Port ${first} is in use, trying another one...`);
console.log(`  Local:   ${url}/`);
