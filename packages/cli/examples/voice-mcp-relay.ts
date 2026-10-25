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

import { open } from "node:fs/promises";
import { payloadOf, recordCall, recordFailure, type RecordingEntry } from "./voice-recording.js";

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
  /** Called once; the relay then refuses further requests. Errors contain no upstream content. */
  onRecordingError?: () => void;
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
  let recordingFailed = false;
  const write = async (entry: RecordingEntry): Promise<boolean> => {
    const pending = queue.then(async () => {
      if (recordingFailed) return;
      await options.record(entry);
    });
    queue = pending.catch(() => {
      if (!recordingFailed) {
        recordingFailed = true;
        process.stderr.write(
          "Recording failed; relay requests are refused. The recording is incomplete.\n",
        );
        options.onRecordingError?.();
      }
    });
    await queue;
    return !recordingFailed;
  };
  const recordingError = () =>
    new Response("Recording failed; recording is incomplete", { status: 503 });
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      if (recordingFailed) return recordingError();
      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > MAX_REQUEST_BYTES) return new Response("Request too large", { status: 413 });
      // Bound chunked/undeclared bodies while reading, before buffering all of them.
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = request.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_REQUEST_BYTES) {
              await reader.cancel();
              return new Response("Request too large", { status: 413 });
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const rpc = rpcRequest(body);
      const started = performance.now();
      const tool =
        rpc?.method === "tools/call" && typeof rpc.params?.name === "string"
          ? rpc.params.name
          : undefined;
      const args =
        rpc?.params?.arguments &&
        typeof rpc.params.arguments === "object" &&
        !Array.isArray(rpc.params.arguments)
          ? (rpc.params.arguments as Record<string, unknown>)
          : {};
      let upstream: Response;
      let text: string;
      try {
        upstream = await fetch(options.upstream, {
          method: request.method,
          headers,
          ...(body ? { body } : {}),
        });
        text = await upstream.text();
      } catch {
        if (
          tool &&
          !(await write(recordFailure(tool, args, "network-error", performance.now() - started)))
        ) {
          return recordingError();
        }
        return new Response("Control MCP is not reachable", { status: 502 });
      }
      const ms = performance.now() - started;
      const contentType = upstream.headers.get("content-type");
      let entry: RecordingEntry | undefined;
      if (tool) {
        if (upstream.status !== 200) {
          entry = recordFailure(tool, args, `http:${upstream.status}`, ms);
        } else {
          try {
            entry = recordCall(tool, args, payloadOf(text, contentType), ms).entry;
          } catch {
            entry = recordFailure(tool, args, "invalid-response", ms);
          }
        }
      } else if (upstream.status === 200 && rpc?.method === "tools/list") {
        try {
          const reply = payloadOf(text, contentType);
          const tools = (reply as { result?: { tools?: unknown[] } })?.result?.tools;
          if (Array.isArray(tools))
            entry = {
              type: "tools/list",
              at: new Date().toISOString(),
              tools: tools.length,
              bytes: Buffer.byteLength(text),
            };
        } catch {
          // Tool-list discovery has no call targets to score.
        }
      }
      if (entry && !(await write(entry))) return recordingError();
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
  // Open before announcing readiness, so an invalid destination fails startup.
  const destination = await open(recordPath, "a", 0o600);
  const server = startRelay({
    upstream: argument("url", "http://127.0.0.1:34122/mcp")!,
    port: Number(argument("port", "34199")),
    record: async (entry) => {
      await destination.appendFile(`${JSON.stringify(entry)}\n`);
    },
    onRecordingError: () => {
      process.exitCode = 1;
    },
  });
  process.stderr.write(`Relaying http://127.0.0.1:${server.port}/mcp, recording ${recordPath}\n`);
}

if (import.meta.main) await main();
