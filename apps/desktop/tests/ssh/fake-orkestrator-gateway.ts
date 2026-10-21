import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const FAKE_INSTALLATION_ID = "bk_live";

/**
 * A minimal authenticated Orkestrator client gateway on 127.0.0.1: hello,
 * status, invoke (recorded per command) and a held-open SSE stream. Several
 * listeners can stand for one backend installation reached by different
 * routes. Every request must carry `Authorization: Bearer <token>`.
 */
export class FakeOrkestratorGateway {
  readonly commands = new Map<string, number>();
  /** Commands whose response is never sent (lost-response scenarios). */
  readonly holdCommands = new Set<string>();
  invokeRequests = 0;
  eventStreams = 0;
  unauthorized = 0;
  #server: Server;
  #sockets = new Set<Socket>();
  #port = 0;

  private constructor(
    readonly name: string,
    readonly token: string,
  ) {
    this.#server = createServer((request, response) => this.#handle(request, response));
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
  }

  static async start(name: string, token: string): Promise<FakeOrkestratorGateway> {
    const gateway = new FakeOrkestratorGateway(name, token);
    await new Promise<void>((resolve) => gateway.#server.listen(0, "127.0.0.1", resolve));
    const address = gateway.#server.address();
    gateway.#port = typeof address === "object" && address ? address.port : 0;
    return gateway;
  }

  get port(): number {
    return this.#port;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  count(command: string): number {
    return this.commands.get(command) ?? 0;
  }

  /** Abrupt loss: stop accepting and destroy every open socket, mid-request included. */
  destroy(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    for (const socket of this.#sockets) socket.destroy();
    return closed;
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Bearer ${this.token}`) {
      this.unauthorized += 1;
      json(response, 401, { error: "Authentication required" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/__orkestrator/hello") {
      json(response, 200, {
        schemaVersion: 1,
        installationId: FAKE_INSTALLATION_ID,
        generation: "gen-live-1",
        appVersion: "2.25.0",
        clientApi: { minVersion: 1, maxVersion: 1 },
        capabilities: { "backend-profile": 1 },
        profile: {
          revision: 1,
          displayName: "Live machine",
          colorToken: "teal",
          updatedAt: "2026-10-21T00:00:00.000Z",
        },
        endpointRole: "client",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/__orkestrator/status") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/__orkestrator/events") {
      this.eventStreams += 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.write('id: 1\ndata: {"event":"gateway.connected","payload":{"status":"fresh"}}\n\n');
      return;
    }
    if (request.method === "POST" && url.pathname === "/__orkestrator/invoke") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      request.on("end", () => {
        let command = "";
        try {
          command = String((JSON.parse(body) as { command?: unknown }).command ?? "");
        } catch {
          json(response, 400, { error: "Malformed request" });
          return;
        }
        this.invokeRequests += 1;
        this.commands.set(command, this.count(command) + 1);
        if (this.holdCommands.has(command)) return;
        json(response, 200, { result: { listener: this.name, command } });
      });
      return;
    }
    json(response, 404, { error: "Not found" });
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
