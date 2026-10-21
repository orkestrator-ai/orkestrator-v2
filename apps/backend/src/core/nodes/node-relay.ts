import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";

import { isBackendId, type BackendId } from "@orkestrator/protocol/federation";

import { isWorkspaceExcludedCommand } from "./node-routing.js";

/**
 * The relay fallback: a client that cannot reach a leaf directly sends its
 * leaf-workspace traffic to the command node under
 * `/__orkestrator/nodes/<nodeId>/__orkestrator/…`, authenticated with its ordinary
 * command-node credential. The command node forwards it over its own
 * verified link with the leaf's token, which the client never sees.
 *
 * Relayed paths are the client API only: hello, invoke, events, terminal
 * and the loopback preview proxies. Administrative commands are refused,
 * the same as for client grants.
 */

export const NODE_RELAY_PREFIX = "/__orkestrator/nodes/";

const RELAYED_PATHS = [
  /^\/__orkestrator\/hello$/,
  /^\/__orkestrator\/invoke$/,
  /^\/__orkestrator\/events$/,
  /^\/__orkestrator\/terminal$/,
  /^\/__orkestrator\/proxy\/loopback\/\d+(?:\/.*)?$/,
  /^\/__orkestrator\/browser\/loopback\/\d+(?:\/.*)?$/,
];

/** Request headers never forwarded: the leaf gets the command node's own credential. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "x-orkestrator-controller",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "access-control-allow-origin",
  "access-control-allow-credentials",
]);

const MAX_RELAYED_INVOKE_BYTES = 48 * 1024 * 1024;

export interface RelayTarget {
  baseUrl: string;
  headers: Record<string, string>;
}

export type RelayResolver = (nodeId: BackendId) => RelayTarget | null;

/** `/__orkestrator/nodes/<id>/<rest>` → `{ nodeId, path }`, or null. */
export function parseRelayPath(pathname: string): { nodeId: BackendId; path: string } | null {
  if (!pathname.startsWith(NODE_RELAY_PREFIX)) return null;
  const rest = pathname.slice(NODE_RELAY_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const nodeId = decodeURIComponent(rest.slice(0, slash));
  // The relay base is a prefix: `/__orkestrator/nodes/<id>/__orkestrator/invoke`
  // relays to the node's `/__orkestrator/invoke`, so clients join paths as usual.
  const path = rest.slice(slash);
  if (!isBackendId(nodeId)) return null;
  if (!RELAYED_PATHS.some((pattern) => pattern.test(path))) return null;
  return { nodeId, path };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function forwardedHeaders(request: IncomingMessage, target: RelayTarget): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return { ...headers, ...target.headers };
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) throw new Error("The relayed request is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Relay one HTTP request. Returns false when the path is not a relay path. */
export async function relayHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  resolve: RelayResolver,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const parsed = parseRelayPath(url.pathname);
  if (!parsed) return false;
  const target = resolve(parsed.nodeId);
  if (!target) {
    json(response, 503, { error: "That node is not connected to this command node." });
    return true;
  }
  let body: Buffer | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      body = await readBody(request, MAX_RELAYED_INVOKE_BYTES);
    } catch (error) {
      json(response, 413, { error: error instanceof Error ? error.message : "Too large" });
      return true;
    }
    if (parsed.path === "/__orkestrator/invoke") {
      let command: unknown;
      try {
        command = (JSON.parse(body.toString("utf8")) as { command?: unknown }).command;
      } catch {
        json(response, 400, { error: "Expected a JSON command." });
        return true;
      }
      if (typeof command !== "string" || isWorkspaceExcludedCommand(command)) {
        json(response, 403, { error: "That command cannot be relayed to another node." });
        return true;
      }
    }
  }
  const destination = new URL(parsed.path + url.search, target.baseUrl);
  const abort = new AbortController();
  response.on("close", () => abort.abort());
  let upstream: Response;
  try {
    upstream = await fetchImpl(destination, {
      method: request.method ?? "GET",
      headers: forwardedHeaders(request, target),
      ...(body ? { body: new Uint8Array(body) } : {}),
      redirect: "manual",
      signal: abort.signal,
    });
  } catch {
    if (!response.headersSent) {
      json(response, 502, { error: "The node did not answer through the command node." });
    }
    return true;
  }
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) headers[name] = value;
  });
  response.writeHead(upstream.status, headers);
  if (!upstream.body) {
    response.end();
    return true;
  }
  const stream = Readable.fromWeb(
    upstream.body as unknown as import("node:stream/web").ReadableStream,
  );
  stream.on("error", () => response.destroy());
  stream.pipe(response);
  return true;
}

/** Relay a WebSocket upgrade (terminal). Returns false when the path is not a relay path. */
export function relayUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  url: URL,
  resolve: RelayResolver,
): boolean {
  const parsed = parseRelayPath(url.pathname);
  if (!parsed || parsed.path !== "/__orkestrator/terminal") return false;
  const target = resolve(parsed.nodeId);
  if (!target) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return true;
  }
  const destination = new URL(parsed.path + url.search, target.baseUrl);
  const client = destination.protocol === "https:" ? https : http;
  const headers = forwardedHeaders(request, target);
  const upstreamRequest = client.request(destination, {
    method: "GET",
    headers: {
      ...headers,
      // The leaf's terminal endpoint refuses an origin-less upgrade that
      // authenticates by header; this request comes from the leaf's own
      // command node, so it presents the leaf's own origin.
      origin: destination.origin,
      connection: "Upgrade",
      upgrade: request.headers.upgrade ?? "websocket",
    },
  });
  upstreamRequest.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} Switching Protocols`];
    for (const [name, value] of Object.entries(upstreamResponse.headers)) {
      if (value === undefined || name === "set-cookie") continue;
      for (const entry of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${entry}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const close = () => {
      upstreamSocket.destroy();
      socket.destroy();
    };
    upstreamSocket.on("error", close);
    socket.on("error", close);
    upstreamSocket.on("close", close);
    socket.on("close", close);
  });
  upstreamRequest.on("response", (upstreamResponse) => {
    socket.end(
      `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} Relay Refused\r\nConnection: close\r\n\r\n`,
    );
    upstreamResponse.resume();
  });
  upstreamRequest.on("error", () => {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  upstreamRequest.end();
  return true;
}
