#!/usr/bin/env bun
/**
 * Recording relay for qualifying a realtime voice runtime against Control MCP.
 *
 * Point the voice runtime's MCP server URL at this relay instead of
 * Orkestrator. It forwards every request unchanged, including the runtime's
 * own `Authorization` header (it holds no token of its own), and appends one
 * JSON line per `tools/list` and `tools/call` to --record: the tool, its
 * latency and outcome, the IDs it targeted and the IDs its result returned.
 * Prompts, answers and result text are not written. Score the recording with
 *
 *   bun packages/cli/examples/voice-qualify.ts --score <recording> --environment <id>
 *
 * which reports p50/p95 latency, tool-list and result sizes, misresolved
 * targets and session-handle copy errors.
 *
 *   bun packages/cli/examples/voice-mcp-relay.ts --record voice.jsonl \
 *     [--url http://127.0.0.1:34122/mcp] [--port 34199]
 *
 * It listens on 127.0.0.1 only and buffers each response before relaying it,
 * which Control MCP's stateless single-response replies allow.
 */

import { appendFile } from "node:fs/promises";
import { payloadOf, recordCall, type RecordingEntry } from "./voice-recording.js";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version"];

interface RelayOptions {
  upstream: string;
  port?: number;
  /** Receives each recording line, in request completion order. */
  record: (entry: RecordingEntry) => Promise<void> | void;
}

function rpcRequest(text: string): { method?: string; params?: Record<string, unknown> } | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { method?: string; params?: Record<string, unknown> })
      : null;
  } catch {
    return null;
  }
}

export function startRelay(options: RelayOptions) {
  let queue: Promise<void> = Promise.resolve();
  const write = (entry: RecordingEntry) => {
    queue = queue.then(() => options.record(entry)).catch(() => undefined);
    return queue;
  };
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_REQUEST_BYTES) return new Response("Request too large", { status: 413 });
      const body =
        request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        return new Response("Request too large", { status: 413 });
      }
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const rpc = rpcRequest(body);
      const started = performance.now();
      let upstream: Response;
      try {
        upstream = await fetch(options.upstream, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
        });
      } catch {
        return new Response("Control MCP is not reachable", { status: 502 });
      }
      const text = await upstream.text();
      const ms = performance.now() - started;
      const contentType = upstream.headers.get("content-type");
      if (upstream.status === 200 && rpc?.method) {
        try {
          const reply = payloadOf(text, contentType);
          if (rpc.method === "tools/list") {
            const tools = (reply as { result?: { tools?: unknown[] } }).result?.tools ?? [];
            await write({
              type: "tools/list",
              at: new Date().toISOString(),
              tools: tools.length,
              bytes: Buffer.byteLength(text),
            });
          } else if (rpc.method === "tools/call" && typeof rpc.params?.name === "string") {
            const args =
              rpc.params.arguments && typeof rpc.params.arguments === "object"
                ? (rpc.params.arguments as Record<string, unknown>)
                : {};
            await write(recordCall(rpc.params.name, args, reply, ms).entry);
          }
        } catch {
          // A reply the relay cannot parse is still relayed; it is not scored.
        }
      }
      const responseHeaders = new Headers();
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(text, {
        status: upstream.status,
        headers: responseHeaders,
      });
    },
  });
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const recordPath = argument("record");
  if (!recordPath) {
    process.stderr.write("Pass --record <file.jsonl>\n");
    process.exit(2);
  }
  const server = startRelay({
    upstream: argument("url", "http://127.0.0.1:34122/mcp")!,
    port: Number(argument("port", "34199")),
    record: (entry) => appendFile(recordPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }),
  });
  process.stderr.write(`Relaying http://127.0.0.1:${server.port}/mcp, recording ${recordPath}\n`);
}

if (import.meta.main) await main();
