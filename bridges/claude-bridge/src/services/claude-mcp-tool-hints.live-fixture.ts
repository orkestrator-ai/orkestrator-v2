// A harmless MCP stdio server for `claude-mcp-tool-hints.live-probe.ts`.
//
// Three tools that only answer "ok", each declaring different MCP tool
// annotations, under names with characters the CLI rewrites in a call name.
// Never imported by the bridge.
import { createInterface } from "node:readline";

const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const schema = { type: "object", properties: {} };

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
          serverInfo: { name: "fixture-hints", version: "1" },
        });
      case "tools/list":
        return reply({
          tools: [
            {
              name: "wipe.disk tool",
              description: "Declares every hint.",
              inputSchema: schema,
              annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
              },
            },
            {
              name: "read_thing",
              description: "Declares read-only and open-world.",
              inputSchema: schema,
              annotations: { readOnlyHint: true, openWorldHint: true },
            },
            { name: "plain", description: "Declares nothing.", inputSchema: schema },
          ],
        });
      case "tools/call":
        return reply({ content: [{ type: "text", text: "ok" }] });
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
