// A harmless MCP stdio server for `session-manager-prompt-mcp-sync.live-probe.ts`.
//
// One tool, `probe_<name>`, that only answers with its own name. It appends
// `start <name> <pid>` to the marker file so the probe can tell whether the
// CLI still runs it. Never imported by the bridge.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [name = "fixture", version = "1", markerFile] = process.argv.slice(2);
if (markerFile) appendFileSync(markerFile, `start ${name} ${process.pid}\n`);

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message: { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `fixture-${name}`, version },
        });
      case "tools/list":
        return reply({
          tools: [
            {
              name: `probe_${name}`,
              description: `Answers with the fixture's name (${name}).`,
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      case "tools/call":
        return reply({ content: [{ type: "text", text: `pong from ${name} v${version}` }] });
      case "ping":
        return reply({});
      default:
        return send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Method not found" },
        });
    }
  })
  .on("close", () => process.exit(0));
