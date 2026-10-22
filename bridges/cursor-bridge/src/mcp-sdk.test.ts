import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real SDK starts a project MCP server once with project settings enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-sdk-mcp-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await mkdir(join(root, ".cursor"));
    const script = join(root, "server.cjs");
    await writeFile(
      script,
      `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(join(root, "starts"))}, "start\\n");
let pending = "";
process.stdin.on("data", chunk => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    let result = {};
    if (request.method === "initialize") {
      fs.writeFileSync(${JSON.stringify(join(root, "initialized"))}, "yes");
      result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } };
    }
    if (request.method === "tools/list") result = { tools: [] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
});
`,
    );
    await writeFile(
      join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          probe: { command: process.execPath, args: [script] },
        },
      }),
    );
    child = Bun.spawn([process.execPath, join(import.meta.dir, "testing/mcp-sdk-startup.ts")], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: root,
        CWD: root,
        CURSOR_API_KEY: "",
        ORKESTRATOR_AGENT_MCP_URL: "",
        ORKESTRATOR_AGENT_MCP_TOKEN: "",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const timeout = setTimeout(() => child?.kill("SIGKILL"), 20_000);
    try {
      expect(await child.exited, (await stderr).slice(-2000)).toBe(0);
    } finally {
      clearTimeout(timeout);
    }
    expect(await readFile(join(root, "starts"), "utf8")).toBe("start\n");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
