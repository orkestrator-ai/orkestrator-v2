import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { OrkestratorGateway } from "./gateway.js";

/**
 * A real gateway for `e2e/preview/gateway-browser-security.spec.ts`, with what
 * the security report's dynamic checks need around it on the same host: another
 * HTTP service on another port, and an agent-controlled legacy preview. Prints
 * one `ready` line, and exits when stdin closes. The token is random and lives
 * only as long as this process.
 */

const PREVIEW_DOCUMENT = '<!doctype html><title>preview</title><p id="preview">preview</p>';
export const SECRET_RESPONSE = "another-preview-secret";

function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
}

/** Another service on this host: shows the Cookie header it was sent. */
const otherService = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://other.invalid");
  if (url.pathname === "/link") {
    const target = url.searchParams.get("to") ?? "/";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      `<!doctype html><a id="go" href="${target}">go</a>
       <form id="post" method="POST" action="${target}" enctype="text/plain">
         <input name="command" value="list_projects"></form>`,
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(request.headers.cookie ?? "");
});

const preview = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end(PREVIEW_DOCUMENT);
});
const secretPreview = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/plain" });
  response.end(SECRET_RESPONSE);
});

const otherPort = await listen(otherService);
const previewPort = await listen(preview);
const secretPort = await listen(secretPreview);

const dataDir = await mkdtemp(join(tmpdir(), "ork-gateway-browser-"));
const rendererRoot = join(dataDir, "dist");
await mkdir(rendererRoot);
await writeFile(join(rendererRoot, "index.html"), '<div id="root">signed-in-app</div>');

const invokes: string[] = [];
const token = randomBytes(32).toString("base64url");
const gateway = new OrkestratorGateway({
  backend: {
    invoke: (command) => {
      invokes.push(command);
      return null;
    },
  },
  dataDir,
  rendererRoot,
  bindAddress: "127.0.0.1",
  port: 0,
  env: { ORKESTRATOR_GATEWAY_TOKEN: token },
  allowNonTailscaleBind: true,
  legacyPreviewPortAccess: async (port) =>
    port === previewPort || port === secretPort ? "allowed" : "unknown",
});
const info = await gateway.start();
if (!info) throw new Error("gateway did not start");

process.stdout.write(
  `${JSON.stringify({
    type: "ready",
    gatewayPort: info.port,
    token,
    otherPort,
    previewPort,
    secretPort,
    secretResponse: SECRET_RESPONSE,
  })}\n`,
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await gateway.stop();
  for (const server of [otherService, preview, secretPreview]) {
    server.closeAllConnections();
    server.close();
  }
  await rm(dataDir, { recursive: true, force: true });
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "invokes") {
    process.stdout.write(`${JSON.stringify({ type: "invokes", invokes })}\n`);
  }
});
lines.on("close", () => void shutdown());
