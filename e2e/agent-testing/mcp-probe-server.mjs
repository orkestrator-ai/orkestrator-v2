#!/usr/bin/env node
/**
 * A harmless MCP server for the live MCP apply probes
 * (`mcp-apply-live.spec.ts`). It has no dependencies, so every provider can
 * start it with the absolute path of a Node binary.
 *
 * One tool, `probe`, takes a `nonce` and answers
 * `MCPQ-RESULT <label> <tag> <nonce>`. Every start, call and exit is appended
 * to the `--log` file as one JSON line with the process id, so whether a call
 * reached this server is read from the server's own record, never from what a
 * model says. Nothing else is read or written.
 *
 *   node mcp-probe-server.mjs --label alpha --tag v1 --log /tmp/x.jsonl
 *   node mcp-probe-server.mjs --sse --port-file /tmp/port ...   (legacy SSE)
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const options = parseArguments(process.argv.slice(2));
const label = options.label ?? "probe";
const tag = options.tag ?? "v0";
const logFile = options.log;

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--sse") result.sse = true;
    else if (argument.startsWith("--")) result[argument.slice(2)] = argv[(index += 1)];
  }
  return result;
}

function record(event, extra = {}) {
  if (!logFile) return;
  const line = { event, label, tag, pid: process.pid, at: new Date().toISOString(), ...extra };
  appendFileSync(logFile, `${JSON.stringify(line)}\n`);
}

const TOOL = {
  name: "probe",
  description:
    "Qualification probe. Returns a fixed result line for the given nonce. Harmless: it reads and changes nothing.",
  inputSchema: {
    type: "object",
    properties: { nonce: { type: "string", description: "The nonce to echo back." } },
    required: ["nonce"],
    additionalProperties: false,
  },
};

/** One JSON-RPC message in, at most one response out. */
function handle(message) {
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return null;
  const { id, method, params } = message;
  if (id === undefined || id === null) return null; // notification
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `mcpq-${label}`, version: "1.0.0" },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL.name) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } };
      }
      const nonce = String(params?.arguments?.nonce ?? "");
      record("call", { nonce });
      return reply({ content: [{ type: "text", text: `MCPQ-RESULT ${label} ${tag} ${nonce}` }] });
    }
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
  }
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function responses(payload) {
  const messages = Array.isArray(payload) ? payload : [payload];
  return messages.map(handle).filter(Boolean);
}

let exiting = false;
function exit(reason) {
  if (exiting) return;
  exiting = true;
  record("exit", { reason });
  process.exit(0);
}
process.on("SIGTERM", () => exit("SIGTERM"));
process.on("SIGINT", () => exit("SIGINT"));
process.on("SIGHUP", () => exit("SIGHUP"));

record("start", { transport: options.sse ? "sse" : "stdio" });

if (options.sse) {
  const streams = new Map();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/sse") {
      const sessionId = randomUUID();
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      streams.set(sessionId, response);
      request.on("close", () => streams.delete(sessionId));
      return;
    }
    if (request.method === "POST" && url.pathname === "/messages") {
      const stream = streams.get(url.searchParams.get("sessionId") ?? "");
      if (!stream) {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.writeHead(202).end("Accepted");
        for (const out of responses(parse(body))) {
          stream.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
        }
      });
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(Number(options.port ?? 0), "127.0.0.1", () => {
    const address = server.address();
    if (options["port-file"] && address && typeof address === "object") {
      writeFileSync(options["port-file"], String(address.port));
    }
  });
} else {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        for (const out of responses(parse(line))) process.stdout.write(`${JSON.stringify(out)}\n`);
      }
      newline = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", () => exit("stdin-closed"));
}
