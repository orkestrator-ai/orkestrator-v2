/** Subprocess-only real SDK qualification: no credentials and no model calls. */
import { createAgentPlatform, JsonlLocalAgentStore } from "@cursor/sdk";
import { join } from "node:path";
import { cursorInlineMcpServers, cursorMcpServers } from "../mcp.js";

const cwd = process.env.CWD!;
// The SDK uses no remote service to warm an unauthenticated workspace.
// Fail any accidental fetch rather than consulting an account.
globalThis.fetch = Object.assign(
  async () => {
    throw new Error("MCP startup qualification forbids network fetches");
  },
  {
    preconnect: () => {
      throw new Error("MCP startup qualification forbids network preconnects");
    },
  },
);
const platform = await createAgentPlatform({
  localStore: new JsonlLocalAgentStore(join(cwd, "store")),
});
const resolved = await cursorMcpServers(undefined, { projectResources: true });
const release = await platform.prewarmLocalWorkspace({
  local: { cwd, settingSources: ["project"], sandboxOptions: { enabled: false } },
  mcpServers: cursorInlineMcpServers(resolved, true),
});
try {
  // prewarm starts the MCP clients; each fixture records its initialize call.
  const deadline = Date.now() + 10_000;
  while (!(await Bun.file(join(cwd, "initialized")).exists()) && Date.now() < deadline) {
    await Bun.sleep(20);
  }
  if (!(await Bun.file(join(cwd, "initialized")).exists()))
    throw new Error("Project MCP was not initialized");
} finally {
  await release();
}
