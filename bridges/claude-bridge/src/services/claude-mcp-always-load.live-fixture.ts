// A harmless MCP stdio server for `claude-mcp-always-load.live-probe.ts`.
//
// Two tools that only answer "ok": one lists `_meta["anthropic/alwaysLoad"]`,
// the way the backend lists a workflow attempt's result tools, and one lists
// nothing. Never imported by the bridge.
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
          serverInfo: { name: "fixture-always-load", version: "1" },
        });
      case "tools/list":
        return reply({
          tools: [
            {
              name: "submit_result",
              description: "Lists anthropic/alwaysLoad.",
              inputSchema: schema,
              _meta: { "anthropic/alwaysLoad": true },
            },
            { name: "other_tool", description: "Lists nothing.", inputSchema: schema },
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
