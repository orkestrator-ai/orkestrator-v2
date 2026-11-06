/**
 * Shared by the inactive-environment MCP apply specs
 * (`mcp-apply-inactive.spec.ts` for Claude, `mcp-apply-inactive-codex.spec.ts`
 * for the Codex process-wide variant).
 */

/**
 * A harmless stdio MCP server: one tool, `probe_<name>`, that answers
 * `pong <name> v<version> <nonce>` and appends `call <name> <version>` to the
 * marker file. Plain ESM so the runner's own `node` executes it.
 */
export const FIXTURE_SERVER = `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [name, version, nonce, marker] = process.argv.slice(2);
appendFileSync(marker, \`start \${name} \${version} \${process.pid}\\n\`);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin })
  .on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: \`mcpq-\${name}\`, version },
        });
      case "tools/list":
        return reply({ tools: [{
          name: \`probe_\${name}\`,
          description: \`Answers with a fixed token from the \${name} fixture.\`,
          inputSchema: { type: "object", properties: {} },
        }] });
      case "tools/call":
        appendFileSync(marker, \`call \${name} \${version}\\n\`);
        return reply({ content: [{ type: "text", text: \`pong \${name} v\${version} \${nonce}\` }] });
      case "ping":
        return reply({});
      default:
        return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  })
  .on("close", () => process.exit(0));
`;
