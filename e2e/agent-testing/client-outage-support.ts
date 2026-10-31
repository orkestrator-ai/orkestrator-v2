import type { EventEmitter } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";

/**
 * The network between one client and an isolated profile's gateway, as a local
 * proxy a test can break. Nothing on the machine changes: the client connects
 * to this listener instead of the gateway.
 *
 * - `reset`: open connections die and new ones are dropped, as when a backend
 *   stops or a route goes away with an answer.
 * - `blackhole`: open connections go silent and new ones are never answered, as
 *   when a link drops with no answer at all (a tailnet peer that vanished). No
 *   error reaches the client until something on its side times out.
 * - `stall`: only the terminal streams stop being read, so the gateway meets
 *   real TCP backpressure while everything else keeps working.
 *
 * Only `/__orkestrator` traffic crosses the link. The renderer's assets and
 * Vite's HMR socket go straight to Vite, standing in for a client whose page has
 * already loaded: a dev-only HMR reconnect must not reload the tab under test.
 *
 * Records hold timings, kinds, statuses and command names: never a body, a
 * header or a URL query.
 */
export type LinkMode = "up" | "reset" | "blackhole";
export type LinkRequestKind = "main-stream" | "terminal-stream" | "terminal-socket" | "invoke";

export interface LinkRequest {
  owner: string;
  kind: LinkRequestKind;
  /** Wall-clock ms when the request reached the link. */
  at: number;
  /** Wall-clock ms when the client got an answer. */
  answeredAt?: number;
  status?: number;
  /** The invoke command's name; never its arguments. */
  command?: string;
  /** The link refused it, or held it unanswered, because it was down. */
  dropped?: boolean;
}

const API_PREFIX = "/__orkestrator";
/** An empty same-origin page for a direct client, which needs no app shell. */
export const BLANK_PATH = "/__outage-link/blank";
const MAX_RECORDED_REQUESTS = 50_000;
const MAX_PEEKED_INVOKE_BYTES = 4 * 1024 * 1024;

function classify(url: URL, upgrade: boolean): LinkRequestKind | null {
  if (upgrade) return url.pathname === `${API_PREFIX}/terminal` ? "terminal-socket" : null;
  if (url.pathname === `${API_PREFIX}/events`) {
    return url.searchParams.has("includeEvents") ? "terminal-stream" : "main-stream";
  }
  return url.pathname === `${API_PREFIX}/invoke` ? "invoke" : null;
}

function parseCommand(body: Buffer): string | undefined {
  try {
    const command = (JSON.parse(body.toString("utf8")) as { command?: unknown }).command;
    return typeof command === "string" ? command : undefined;
  } catch {
    return undefined;
  }
}

/** What a live connection needs in order to be reset, silenced or stalled. */
interface LinkConnection {
  kind: LinkRequestKind | "other";
  destroy(): void;
  /** Stop passing bytes in both directions, keeping both sockets open. */
  silence(): void;
  /** Stop reading the gateway, so it meets backpressure. */
  stall(): void;
  /** Resume after `stall`. */
  release(): void;
}

export interface OutageLink {
  readonly url: string;
  readonly owner: string;
  readonly requests: readonly LinkRequest[];
  readonly mode: LinkMode;
  setMode(mode: LinkMode): void;
  /** Stop reading terminal streams and sockets from the gateway, or resume. */
  setTerminalStall(stalled: boolean): void;
  close(): Promise<void>;
}

export async function startOutageLink(options: {
  owner: string;
  gatewayUrl: string;
  rendererUrl: string;
}): Promise<OutageLink> {
  const gateway = new URL(options.gatewayUrl);
  const renderer = new URL(options.rendererUrl);
  const requests: LinkRequest[] = [];
  const connections = new Set<LinkConnection>();
  const held = new Set<Socket>();
  let mode: LinkMode = "up";
  let terminalStalled = false;

  const record = (entry: LinkRequest): LinkRequest => {
    if (requests.length < MAX_RECORDED_REQUESTS) requests.push(entry);
    return entry;
  };
  const track = (connection: LinkConnection, closes: EventEmitter): void => {
    connections.add(connection);
    closes.once("close", () => connections.delete(connection));
    if (terminalStalled && connection.kind.startsWith("terminal-")) connection.stall();
    if (mode === "blackhole") connection.silence();
  };

  /** Down: drop the connection, or leave it unanswered until the link returns. */
  const refuse = (socket: Socket): void => {
    if (mode === "reset") {
      socket.destroy();
      return;
    }
    held.add(socket);
    socket.once("close", () => held.delete(socket));
  };

  const forward = (
    request: IncomingMessage,
    response: ServerResponse,
    target: URL,
    entry: LinkRequest | null,
    kind: LinkRequestKind | "other",
    body?: Buffer,
  ): void => {
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (answer) => {
        if (entry) {
          entry.answeredAt = Date.now();
          entry.status = answer.statusCode;
        }
        response.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
        response.flushHeaders();
        answer.pipe(response);
        answer.once("error", () => response.destroy());
        const connection: LinkConnection = {
          kind,
          destroy: () => {
            answer.destroy();
            response.destroy();
          },
          silence: () => {
            answer.unpipe(response);
            answer.pause();
          },
          stall: () => {
            answer.unpipe(response);
            answer.pause();
          },
          release: () => {
            answer.pipe(response);
            answer.resume();
          },
        };
        track(connection, response);
      },
    );
    upstream.once("error", () => response.destroy());
    response.once("close", () => upstream.destroy());
    if (body) upstream.end(body);
    else request.pipe(upstream);
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://link.invalid");
    if (url.pathname === BLANK_PATH) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Direct client</title>");
      return;
    }
    if (!url.pathname.startsWith(API_PREFIX)) {
      forward(request, response, renderer, null, "other");
      return;
    }
    const kind = classify(url, false);
    const entry = kind ? record({ owner: options.owner, kind, at: Date.now() }) : null;
    const dispatch = (body?: Buffer) => {
      if (mode !== "up") {
        if (entry) entry.dropped = true;
        refuse(request.socket);
        return;
      }
      forward(request, response, gateway, entry, kind ?? "other", body);
    };
    if (kind !== "invoke") {
      dispatch();
      return;
    }
    // The command name is the only thing kept from an invoke's body.
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_PEEKED_INVOKE_BYTES) request.destroy();
      else chunks.push(chunk);
    });
    request.once("end", () => {
      const body = Buffer.concat(chunks);
      entry!.command = parseCommand(body);
      dispatch(body);
    });
  });

  server.on("upgrade", (request, socket: Socket, head) => {
    const url = new URL(request.url ?? "/", "http://link.invalid");
    const isApi = url.pathname.startsWith(API_PREFIX);
    const kind = isApi ? classify(url, true) : null;
    const entry = kind ? record({ owner: options.owner, kind, at: Date.now() }) : null;
    if (isApi && mode !== "up") {
      if (entry) entry.dropped = true;
      refuse(socket);
      return;
    }
    const target = isApi ? gateway : renderer;
    const upstream = net.connect(Number(target.port), target.hostname);
    socket.once("error", () => upstream.destroy());
    upstream.once("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
    upstream.once("connect", () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.byteLength > 0) upstream.write(head);
      upstream.once("data", (first: Buffer) => {
        if (entry) {
          entry.answeredAt = Date.now();
          const status = /^HTTP\/1\.1 (\d{3})/.exec(first.subarray(0, 32).toString("latin1"))?.[1];
          if (status) entry.status = Number(status);
        }
      });
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    if (!isApi) return;
    track(
      {
        kind: kind ?? "other",
        destroy: () => {
          socket.destroy();
          upstream.destroy();
        },
        silence: () => {
          upstream.unpipe(socket);
          socket.unpipe(upstream);
          upstream.pause();
          socket.pause();
        },
        stall: () => {
          upstream.unpipe(socket);
          upstream.pause();
        },
        release: () => {
          upstream.pipe(socket);
          upstream.resume();
        },
      },
      socket,
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    owner: options.owner,
    get requests() {
      return requests;
    },
    get mode() {
      return mode;
    },
    setMode(next) {
      if (next === mode) return;
      mode = next;
      if (next === "up") {
        // A silenced connection is gone by now: the peer would have timed out.
        for (const socket of Array.from(held)) socket.destroy();
      }
      for (const connection of Array.from(connections)) {
        if (connection.kind === "other") continue;
        if (next === "reset" || next === "up") connection.destroy();
        else connection.silence();
      }
    },
    setTerminalStall(stalled) {
      if (stalled === terminalStalled) return;
      terminalStalled = stalled;
      for (const connection of Array.from(connections)) {
        if (!connection.kind.startsWith("terminal-")) continue;
        if (stalled) connection.stall();
        else connection.release();
      }
    },
    async close() {
      server.closeAllConnections();
      for (const socket of Array.from(held)) socket.destroy();
      for (const connection of Array.from(connections)) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** One retry rung of several owners: their nth attempt after the outage began. */
export interface RetryRung {
  rung: number;
  owners: number;
  /** Latest minus earliest attempt in this rung. */
  spanMs: number;
  /** Owner pairs whose attempts landed within `tickMs` of each other. */
  coincidentPairs: number;
  pairs: number;
}

/**
 * How spread out a set of reconnect owners were, from each owner's attempt
 * times after the outage began. Only rungs every owner reached are compared.
 */
export function retryRungs(
  attemptsByOwner: ReadonlyMap<string, readonly number[]>,
  tickMs = 20,
): RetryRung[] {
  const lists = Array.from(attemptsByOwner.values());
  if (lists.length < 2) return [];
  const complete = Math.min(...lists.map((attempts) => attempts.length));
  const rungs: RetryRung[] = [];
  for (let rung = 0; rung < complete; rung += 1) {
    const times = lists.map((attempts) => attempts[rung]!).sort((a, b) => a - b);
    let coincidentPairs = 0;
    let pairs = 0;
    for (let first = 0; first < times.length; first += 1) {
      for (let second = first + 1; second < times.length; second += 1) {
        pairs += 1;
        if (times[second]! - times[first]! <= tickMs) coincidentPairs += 1;
      }
    }
    rungs.push({
      rung,
      owners: times.length,
      spanMs: times.at(-1)! - times[0]!,
      coincidentPairs,
      pairs,
    });
  }
  return rungs;
}

/**
 * The pass rule for "spread out": some rung spans at least half of its jitter
 * window, and owners do not land together. Equal jitter puts a rung's delay in
 * the upper half of its base, so its window is half the base.
 *
 * Any rung, not the last: a few owners' samples can fall close together on any
 * one rung by chance (three tabs once spanned 3.6 s of an 8 s window), whereas
 * lock-step owners stay within a few milliseconds on every rung.
 */
export function retriesAreSpread(
  rungs: readonly RetryRung[],
  jitterWindowMsOfRung: (rung: number) => number,
): boolean {
  if (rungs.length === 0) return false;
  const pairs = rungs.reduce((total, rung) => total + rung.pairs, 0);
  const coincident = rungs.reduce((total, rung) => total + rung.coincidentPairs, 0);
  const wideEnough = rungs.some((rung) => rung.spanMs >= jitterWindowMsOfRung(rung.rung) / 2);
  return wideEnough && coincident / pairs <= 0.2;
}
