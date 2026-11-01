import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import {
  coordinatorProcessPolicy,
  createPiSessionServices,
  newSessionState,
  piAppendedInstructions,
} from "./agent-session.js";
import {
  closePiMcp,
  piMcpInstructions,
  preparePiMcp,
  setPiMcpTransportForTests,
  type PiMcpTransport,
} from "./mcp.js";

/**
 * Pi's system prompt carries the instructions every Orkestrator provider
 * receives, and the instructions its MCP servers return on `initialize`,
 * which Pi's SDK would otherwise never see (it loads no MCP client).
 */
const roots: string[] = [];

afterEach(async () => {
  setPiMcpTransportForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-system-instructions-"));
  roots.push(root);
  return root;
}

function transport(instructions: Record<string, string>): PiMcpTransport {
  return {
    async connect(server) {
      return {
        tools: [{ name: "search" }],
        ...(instructions[server.id] ? { instructions: instructions[server.id] } : {}),
        async call() {
          return { content: [] };
        },
        async close() {},
      };
    },
  };
}

async function withServers(
  state: ReturnType<typeof newSessionState>,
  instructions: Record<string, string>,
): Promise<void> {
  const root = await tempRoot();
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" }, quiet: { command: "q" } } }),
  );
  setPiMcpTransportForTests(transport(instructions));
  state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
  await preparePiMcp(state, { agentDir, cwd: root, env: {} });
}

describe("Pi MCP server instructions", () => {
  test("collects each connected server's instructions under its name", async () => {
    const state = newSessionState();
    await withServers(state, { orkestrator: "Check your inbox.", docs: "Search first." });
    const text = piMcpInstructions(state)!;
    expect(text).toStartWith("# MCP Server Instructions");
    expect(text).toContain("## orkestrator\nCheck your inbox.");
    expect(text).toContain("## docs\nSearch first.");
    expect(text).not.toContain("## quiet");
    await closePiMcp(state);
    expect(piMcpInstructions(state)).toBeUndefined();
  });

  test("bounds a server's instructions", async () => {
    const state = newSessionState();
    await withServers(state, { docs: "x".repeat(20_000) });
    expect(piMcpInstructions(state)!.length).toBeLessThan(9_000);
    await closePiMcp(state);
  });

  test("is undefined when no server sent any", async () => {
    const state = newSessionState();
    await withServers(state, {});
    expect(piMcpInstructions(state)).toBeUndefined();
    await closePiMcp(state);
  });
});

describe("Pi appended system prompt", () => {
  test("a writable session gets the shared block, then its MCP instructions", async () => {
    const state = newSessionState();
    await withServers(state, { orkestrator: "Check your inbox." });
    expect(piAppendedInstructions(state)).toEqual([
      agentSystemInstructions(),
      piMcpInstructions(state)!,
    ]);
    await closePiMcp(state);
  });

  test("a read-only coordinator gets no shared block", () => {
    const state = newSessionState(undefined, coordinatorProcessPolicy());
    expect(piAppendedInstructions(state)).toEqual([]);
  });

  test("the loader keeps a user's APPEND_SYSTEM.md before Orkestrator's block", async () => {
    const root = await tempRoot();
    const cwd = join(root, "checkout");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), "{}");
    await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Prefer small commits.");
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const services = await createPiSessionServices(newSessionState(), {
      cwd,
      agentDir,
      settingsManager,
    });
    expect(services.resourceLoader.getAppendSystemPrompt()).toEqual([
      "Prefer small commits.",
      agentSystemInstructions(),
    ]);
  });

  test("a read-only coordinator still reads the repository's AGENTS.md", async () => {
    const root = await tempRoot();
    const cwd = join(root, "checkout");
    const agentDir = join(root, "agent");
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), "{}");
    await writeFile(join(cwd, "AGENTS.md"), "Always show visual changes as images.");
    const state = newSessionState(undefined, coordinatorProcessPolicy());
    state.readOnly = true;
    const services = await createPiSessionServices(state, {
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
    });
    expect(
      services.resourceLoader.getAgentsFiles().agentsFiles.map((file) => file.content),
    ).toContain("Always show visual changes as images.");
  });
});
