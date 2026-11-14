/**
 * A loopback model that refuses every login (to-do 5160 task 4), so the real
 * pinned Claude CLI, Codex app-server, Pi SDK and OpenCode server fail a turn
 * the way a provider does when the key is wrong, with no login and nothing
 * billed. It answers every request with HTTP 401 in the caller's own error
 * shape: Anthropic's for `/v1/messages` (Claude), OpenAI's for everything else
 * (Codex's Responses, Pi's and OpenCode's chat completions). A WebSocket
 * upgrade (Codex's Responses transport) is refused with the same 401.
 *
 *   bun refused-login-model.ts
 *
 * prints its origin (`http://127.0.0.1:<port>`) as the first stdout line.
 *
 * `POST /__qa/hold` with `{"hold":true}` parks every later model request until
 * `{"hold":false}`, so a spec can hold a turn at "the provider is working"
 * while it stops the turn, kills the bridge or restarts the backend.
 * `GET /__qa/stats` answers `{ requests, held }`. It keeps no request body and
 * logs nothing.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export const ANTHROPIC_REFUSAL = {
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
} as const;

export const OPENAI_REFUSAL = {
  error: {
    message: "Incorrect API key provided: refused-*******. This key is made up for a test.",
    type: "invalid_request_error",
    param: null,
    code: "invalid_api_key",
  },
} as const;

/** The 401 body a provider at `pathname` would send for a wrong key. */
export function refusalFor(pathname: string): typeof ANTHROPIC_REFUSAL | typeof OPENAI_REFUSAL {
  return /\/messages(\/|$)/.test(pathname) ? ANTHROPIC_REFUSAL : OPENAI_REFUSAL;
}

export interface RefusedLoginModel {
  origin: string;
  stats(): { requests: number; held: number };
  setHold(hold: boolean): void;
  stop(): void;
}

/**
 * Serve on 127.0.0.1 at an ephemeral port. `node:http` rather than
 * `Bun.serve`, so the unit tests' DOM preload (which replaces the global
 * `Response`) cannot change what it answers.
 */
export async function serveRefusedLoginModel(): Promise<RefusedLoginModel> {
  let requests = 0;
  let hold = false;
  const waiting = new Set<() => void>();
  const releaseAll = () => {
    for (const release of Array.from(waiting)) release();
  };
  const json = (response: ServerResponse, status: number, value: unknown) => {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      ...(status === 401 ? { "x-should-retry": "false" } : {}),
    });
    response.end(body);
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      // Only the control route's tiny body is kept; a model request is drained.
      size += chunk.length;
      if (pathname === "/__qa/hold" && size <= 1_024) chunks.push(chunk);
    });
    request.on("end", () => {
      if (pathname === "/__qa/stats") {
        json(response, 200, { requests, held: waiting.size });
        return;
      }
      if (pathname === "/__qa/hold" && request.method === "POST") {
        let body: { hold?: unknown } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { hold?: unknown };
        } catch {
          // An unreadable body releases, the safe answer.
        }
        hold = body.hold === true;
        if (!hold) releaseAll();
        json(response, 200, { hold, held: waiting.size });
        return;
      }
      requests += 1;
      const answer = () => {
        if (!response.destroyed) json(response, 401, refusalFor(pathname));
      };
      if (!hold) {
        answer();
        return;
      }
      const release = () => {
        waiting.delete(release);
        answer();
      };
      waiting.add(release);
      response.once("close", () => waiting.delete(release));
    });
  });
  // A WebSocket upgrade (Codex's Responses transport) is refused like any request.
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    requests += 1;
    const body = JSON.stringify(refusalFor(new URL(request.url ?? "/", "http://x").pathname));
    socket.end(
      `HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\n` +
        `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    stats: () => ({ requests, held: waiting.size }),
    setHold(next) {
      hold = next;
      if (!hold) releaseAll();
    },
    stop() {
      releaseAll();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Ask a running model (started as its own process) to hold or release. */
export async function setRefusedLoginHold(origin: string, hold: boolean): Promise<void> {
  const response = await fetch(`${origin}/__qa/hold`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hold }),
  });
  if (!response.ok) throw new Error(`hold ${hold}: HTTP ${response.status}`);
}

export async function refusedLoginStats(
  origin: string,
): Promise<{ requests: number; held: number }> {
  const response = await fetch(`${origin}/__qa/stats`);
  if (!response.ok) throw new Error(`stats: HTTP ${response.status}`);
  return (await response.json()) as { requests: number; held: number };
}

if (import.meta.main) {
  const model = await serveRefusedLoginModel();
  const stop = () => {
    model.stop();
    process.exit(0);
  };
  // Handlers first, then the ready line (AGENTS.md invariant 16).
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(model.origin);
}
