import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { AgentToolsServer } from "../src/core/agent-tools.js";
import { StorageService } from "../src/core/storage.js";

/**
 * What one agent MCP handshake (`initialize` then `tools/list`, as Codex runs
 * at thread start) costs the backend, against a synthetic data directory in
 * the system temporary directory:
 *
 *   mise exec -- bun apps/backend/scripts/agent-mcp-handshake-bench.ts \
 *     [--environments 100] [--tabs 6] [--messages 600] [--sequential 600] \
 *     [--concurrent 40]
 *
 * The defaults approximate arktech-mini on 2026-10-28: about 600 mailboxes
 * and a 1.2 MB agent mail store. Reports sequential handshake latency, the
 * wall time and backend CPU per handshake of a concurrent burst, and the cost
 * of one `listAgentMailboxes` read. Figures are machine- and load-specific;
 * compare runs on one host only. Todo 0735 records measured runs.
 */

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : Number(process.argv[index + 1]);
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

const environments = Math.max(1, option("environments", 100));
const tabs = Math.max(1, option("tabs", 6));
const messages = option("messages", 600);
const sequential = Math.max(1, option("sequential", 600));
const concurrent = Math.max(1, option("concurrent", 40));

const dataDir = await mkdtemp(path.join(tmpdir(), "ork-mcp-handshake-bench-"));
// Console output from storage and mail would otherwise dominate the run.
const quiet = { log: console.log, info: console.info, warn: console.warn };
console.log = console.info = console.warn = () => undefined;
const storage = new StorageService(dataDir);
let server: AgentToolsServer | null = null;
try {
  await storage.init();
  await storage.addProject({
    id: "project",
    name: "project",
    gitUrl: "https://example.invalid/project.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  for (let index = 0; index < environments; index += 1) {
    const id = `env-${index}`;
    await storage.addEnvironment({
      id,
      projectId: "project",
      name: id,
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: index,
      environmentType: "local",
      setupPhase: "ready",
      setupScriptsComplete: true,
    });
    await storage.savePaneLayout(
      id,
      {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: Array.from({ length: tabs }, (_, tab) => ({
            id: `tab-${tab}`,
            type: "agent-native" as const,
            displayTitle: `tab ${tab}`,
            nativeAgentData: { environmentId: id, platform: "claude" as const },
          })),
          activeTabId: "tab-0",
        },
      },
      0,
    );
  }
  await storage.synchronizeAgentMailboxes();
  const body = "m".repeat(1_800);
  for (let index = 0; index < messages; index += 1) {
    await storage.sendAgentMail(
      {
        kind: "tab",
        environmentId: `env-${index % environments}`,
        projectId: "project",
        tabId: "tab-0",
      },
      {
        requestId: `bench-${index}`,
        toEnvironmentId: `env-${(index + 1) % environments}`,
        toTabId: `tab-${index % tabs}`,
        body,
      },
    );
  }

  const tools = new AgentToolsServer(storage, "127.0.0.1");
  server = tools;
  await tools.start();
  const rpc = async (url: string, token: string, method: string, params?: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    });
    await response.text();
    if (response.status !== 200) throw new Error(`${method} answered ${response.status}`);
  };
  const handshake = async (index: number) => {
    const connection = tools.connection(`env-${index % environments}`, "project", "host", "tab-0");
    await rpc(connection.url, connection.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "handshake-bench", version: "0" },
    });
    await rpc(connection.url, connection.token, "tools/list");
  };
  const percentile = (values: number[], fraction: number) =>
    values.slice().sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * fraction))
    ]!;
  const round = (value: number) => Math.round(value * 10) / 10;

  for (let index = 0; index < 5; index += 1) await handshake(index);
  const latencies: number[] = [];
  for (let index = 0; index < sequential; index += 1) {
    const started = performance.now();
    await handshake(index);
    latencies.push(performance.now() - started);
  }
  const burstStarted = performance.now();
  const cpuBefore = process.cpuUsage();
  const burst = await Promise.all(
    Array.from({ length: concurrent }, async (_, index) => {
      const started = performance.now();
      await handshake(index);
      return performance.now() - started;
    }),
  );
  const burstWall = performance.now() - burstStarted;
  const cpu = process.cpuUsage(cpuBefore);
  const listStarted = performance.now();
  for (let index = 0; index < 40; index += 1) {
    await storage.listAgentMailboxes({
      environmentId: "env-1",
      currentEnvironmentId: "env-1",
      limit: 200,
    });
  }
  quiet.log(
    JSON.stringify({
      environments,
      tabs,
      messages,
      sequentialHandshakeMs: {
        p50: round(percentile(latencies, 0.5)),
        p90: round(percentile(latencies, 0.9)),
      },
      concurrent: {
        handshakes: concurrent,
        wallMs: round(burstWall),
        maxMs: round(Math.max(...burst)),
        cpuMsPerHandshake: round((cpu.user + cpu.system) / 1_000 / concurrent),
      },
      listAgentMailboxesMs: round((performance.now() - listStarted) / 40),
    }),
  );
} finally {
  await server?.stop();
  Object.assign(console, quiet);
  await rm(dataDir, { recursive: true, force: true });
}
process.exit(0);
