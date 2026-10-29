/**
 * Per-session user MCP servers on Pi (graphs item 404).
 *
 * Pi's SDK loads no MCP client; the bridge's own client starts the servers
 * and registers their tools through the `orkestrator-mcp` extension. A graph
 * node's policy selects which configured servers that client starts, and the
 * read-only gate admits a granted server's tools by exact registered name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { newSessionState } from "./agent-session.js";
import { requestToolApproval } from "./interactions.js";
import {
  closePiMcp,
  isGrantedUserMcpTool,
  piMcpExtension,
  preparePiMcp,
  publicPiMcpServers,
  setPiMcpTransportForTests,
  type PiMcpTransport,
} from "./mcp.js";
import { piUserMcpServerFilter, resolvePiMcpServers } from "./mcp-config.js";

const roots: string[] = [];

afterEach(async () => {
  setPiMcpTransportForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function agentDirWithServers(): Promise<{ root: string; agentDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-mcp-select-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        docs: { command: "docs-mcp" },
        linear: { command: "linear-mcp" },
        "my.notes": { command: "notes-mcp" },
      },
    }),
  );
  return { root, agentDir };
}

const transport: PiMcpTransport = {
  async connect() {
    return {
      tools: [{ name: "search" }],
      async call() {
        return { content: [{ type: "text", text: "ok" }] };
      },
      async close() {},
    };
  },
};

function policy(
  userMcpServers: string[] | undefined,
  deny: string[] = [],
  approvals: NativeAgentExecutionPolicy["approvals"] = "auto-approve",
): NativeAgentExecutionPolicy {
  return {
    id: "pipeline",
    sandbox: "none",
    approvals,
    projectResources: false,
    networkAccess: "full",
    capabilityPolicy: { deny: deny as never, ...(userMcpServers ? { userMcpServers } : {}) },
  };
}

describe("piUserMcpServerFilter", () => {
  test("matches the ids Pi gives servers, and a denial wins", () => {
    expect(piUserMcpServerFilter(policy(undefined))).toBeUndefined();
    const allow = piUserMcpServerFilter(policy(["docs", "my.notes"], ["mcp:docs"]))!;
    expect([allow("docs"), allow("my_notes"), allow("linear")]).toEqual([false, true, false]);
    const denyOnly = piUserMcpServerFilter(policy(undefined, ["mcp:linear"]))!;
    expect([denyOnly("docs"), denyOnly("linear")]).toEqual([true, false]);
  });

  test("resolution starts only the selected configured servers", async () => {
    const { root, agentDir } = await agentDirWithServers();
    const servers = await resolvePiMcpServers({
      agentDir,
      cwd: root,
      projectResources: false,
      agentMcp: { url: "http://127.0.0.1:4567/mcp", token: "tab" },
      env: {},
      allowServer: piUserMcpServerFilter(policy(["docs"])),
    });
    expect(servers.map((server) => server.id).sort()).toEqual(["docs", "orkestrator"]);
  });
});

describe("a granted server on a live session", () => {
  test("a granted server is registered and an ungranted one is absent", async () => {
    const { root, agentDir } = await agentDirWithServers();
    setPiMcpTransportForTests(transport);
    const state = newSessionState();
    state.policy = policy(["docs"]);
    await preparePiMcp(state, { agentDir, cwd: root, env: {} });
    try {
      const registered: string[] = [];
      piMcpExtension(state)({
        registerTool: (tool: { name: string }) => registered.push(tool.name),
      } as never);
      expect(registered).toEqual(["mcp_docs_search"]);
      expect(publicPiMcpServers(state).map((server) => server.id)).toEqual(["docs"]);
      expect(isGrantedUserMcpTool(state, "mcp_docs_search")).toBe(true);
    } finally {
      await closePiMcp(state);
    }
  });

  test("no grant starts no user server; no selection starts them all", async () => {
    const { root, agentDir } = await agentDirWithServers();
    setPiMcpTransportForTests(transport);
    const none = newSessionState();
    none.policy = policy([]);
    await preparePiMcp(none, { agentDir, cwd: root, env: {} });
    const all = newSessionState();
    all.policy = policy(undefined);
    await preparePiMcp(all, { agentDir, cwd: root, env: {} });
    try {
      expect(publicPiMcpServers(none)).toEqual([]);
      expect(
        publicPiMcpServers(all)
          .map((server) => server.id)
          .sort(),
      ).toEqual(["docs", "linear", "my_notes"]);
      // Without an explicit grant nothing is admitted past the read-only gate.
      expect(isGrantedUserMcpTool(all, "mcp_docs_search")).toBe(false);
    } finally {
      await closePiMcp(none);
      await closePiMcp(all);
    }
  });

  test("the read-only gate admits a granted tool and still refuses the rest", async () => {
    const { root, agentDir } = await agentDirWithServers();
    setPiMcpTransportForTests(transport);
    const state = newSessionState();
    state.policy = policy(["docs"], [], "deny");
    state.readOnly = true;
    await preparePiMcp(state, { agentDir, cwd: root, env: {} });
    try {
      expect(await requestToolApproval(state, "c1", "mcp_docs_search", {})).toEqual({
        block: false,
      });
      expect(await requestToolApproval(state, "c2", "bash", {})).toMatchObject({ block: true });
      expect(await requestToolApproval(state, "c3", "mcp_linear_search", {})).toMatchObject({
        block: true,
      });
    } finally {
      await closePiMcp(state);
    }
  });
});
