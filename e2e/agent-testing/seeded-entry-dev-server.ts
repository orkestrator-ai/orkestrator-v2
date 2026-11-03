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
import { createServer } from "node:http";

// A client-owned reconnect loop updates the visible page without navigation.
const client = `document.body.dataset.documentId = crypto.randomUUID();
async function refresh() {
  try {
    const response = await fetch('/health', { cache: 'no-store' });
    if (response.ok) {
      const { marker } = await response.json();
      document.body.dataset.serviceMarker = marker;
      document.querySelector('h1').textContent = marker;
    }
  } catch {}
  setTimeout(refresh, 500);
}
refresh();`;

const first = Number(process.env.SEEDED_ENTRY_PORT);
if (!Number.isInteger(first) || first < 1 || first > 65_530) {
  throw new Error("SEEDED_ENTRY_PORT must name the project's entry port");
}
const marker = `seeded-${path.basename(process.cwd())}-${process.pid}`;

let url: string | null = null;
for (let port = first; port < first + 5 && !url; port += 1) {
  try {
    const server = createServer((request, response) => {
      response.setHeader("cache-control", "no-store");
      // Reconnect on each poll so the tunnel checks the current binding.
      response.setHeader("connection", "close");
      if (request.url === "/health") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ marker }));
      } else {
        response.setHeader("content-type", "text/html");
        response.end(
          `<!doctype html><body data-service-marker="${marker}"><h1>${marker}</h1><script>${client}</script>`,
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    url = `http://127.0.0.1:${port}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  }
}
if (!url) throw new Error(`Ports ${first} to ${first + 4} are all in use`);
if (!url.endsWith(`:${first}`)) console.log(`Port ${first} is in use, trying another one...`);
console.log(`  Local:   ${url}/`);
