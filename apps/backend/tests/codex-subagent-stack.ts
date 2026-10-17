/**
 * The Codex sub-agent card stack, end to end except for the model.
 *
 * `fake-codex-app-server.mjs` (script `subagents`) stands in for `codex
 * app-server` and writes real rollouts. Everything downstream of it is the
 * shipped code: the codex-bridge runs as its own process from source, the
 * backend reaches it through the production `HttpBridgeProvider`, and the
 * `NativeAgentService` projection is what a renderer reads.
 *
 * `restart()` is the cold path the duplicate-card fix has to survive: the
 * bridge process (and with it the app-server child) is killed, and a fresh
 * bridge and a fresh service open the same storage and Codex home, so nothing
 * held in memory can stand in for recovery from disk.
 *
 * Used by `codex-subagent-cards.test.ts` and, through
 * `e2e/fixtures/codex-subagent-host.ts`, by the browser spec.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, promises as fs } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";

import { waitForLocalServerHealth } from "../src/core/commands-server-health.js";
import { HttpBridgeProvider } from "../src/core/http-bridge-provider.js";
import { NativeAgentService } from "../src/core/native-agent-service.js";
import { StorageService } from "../src/core/storage.js";
import { waitForProjection } from "./wait-for-projection.js";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const bridgeRoot = path.join(repositoryRoot, "bridges", "codex-bridge");
const fakeCodex = path.join(bridgeRoot, "src", "testing", "fake-codex-app-server.mjs");

export const SUBAGENT_STACK_IDENTITY = {
  environmentId: "env-subagents",
  agent: "codex" as const,
  logicalSessionKey: "env-env-subagents:tab-subagents",
};

/** What the scenario asks for; the fake ignores the wording. */
export const SUBAGENT_STACK_PROMPT = "Run the three checks in parallel sub-agents.";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

interface RunningBridge {
  child: ChildProcess;
  port: number;
  exited: Promise<void>;
  stderr: string[];
}

export interface SubagentStack {
  /** How many bridge processes this stack has started. */
  readonly bridgeGeneration: number;
  prompt(): Promise<void>;
  /** Completes every child and the parent turn inside the fake. */
  finishChildren(): Promise<void>;
  projection(): Promise<NativeAgentSessionProjection>;
  /**
   * Re-reads the projection until `accept` returns true, re-checking on every
   * bridge event. Returns the accepted projection.
   */
  waitForProjection(
    accept: (projection: NativeAgentSessionProjection) => boolean,
    description: string,
  ): Promise<NativeAgentSessionProjection>;
  /**
   * Replaces the backend service and its provider, keeping the bridge: what a
   * reader returning to the tab, or a backend restart over a surviving bridge,
   * gets. The new service never saw the turn run.
   */
  reopenBackend(): Promise<void>;
  /** Kills the bridge and the service; starts fresh ones over the same state. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function startSubagentStack(): Promise<SubagentStack> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-subagent-stack-"));
  const dataDir = path.join(root, "data");
  const codexHome = path.join(root, "codex-home");
  const workspace = path.join(root, "workspace");
  // Short on purpose: a Unix socket path is limited to ~104 bytes on macOS.
  const controlSocket = path.join(root, "ctl.sock");
  await Promise.all([dataDir, codexHome, workspace].map((dir) => fs.mkdir(dir)));
  chmodSync(fakeCodex, 0o755);
  const token = `subagent-stack-${crypto.randomUUID()}`;

  let bridge: RunningBridge | undefined;
  let storage: StorageService | undefined;
  let service: NativeAgentService | undefined;
  let generation = 0;

  async function startBridge(): Promise<RunningBridge> {
    const port = await freePort();
    const child = spawn(process.execPath, ["src/index.ts"], {
      cwd: bridgeRoot,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        // The Node test preload sets this so imported bridges never bind; this
        // one is a real server.
        CODEX_BRIDGE_NO_SERVER: undefined,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        CODEX_BRIDGE_TOKEN: token,
        CODEX_PATH: fakeCodex,
        CODEX_HOME: codexHome,
        CWD: workspace,
        FAKE_CODEX_SCRIPT: "subagents",
        FAKE_CODEX_CONTROL_SOCKET: controlSocket,
        ORKESTRATOR_PARENT_PID: String(process.pid),
      },
    });
    const stderr: string[] = [];
    createInterface({ input: child.stderr! }).on("line", (line) => {
      stderr.push(line);
      if (stderr.length > 200) stderr.shift();
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await waitForLocalServerHealth(port, "codex");
    } catch (error) {
      child.kill("SIGKILL");
      throw new Error(`codex-bridge did not start: ${String(error)}\n${stderr.join("\n")}`);
    }
    generation += 1;
    return { child, port, exited, stderr };
  }

  async function startService(port: number): Promise<void> {
    storage = new StorageService(dataDir);
    await storage.init();
    if (!(await storage.getEnvironment(SUBAGENT_STACK_IDENTITY.environmentId))) {
      await storage.addEnvironment({
        id: SUBAGENT_STACK_IDENTITY.environmentId,
        projectId: "project-subagents",
        name: "Sub-agent cards",
        branch: "main",
        containerId: null,
        status: "running",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: new Date(0).toISOString(),
        networkAccessMode: "restricted",
        order: 0,
        environmentType: "local",
        worktreePath: workspace,
        setupScriptsComplete: true,
      });
    }
    const provider = new HttpBridgeProvider(
      { agent: "codex", baseUrl: `http://127.0.0.1:${port}`, authToken: token },
      fetch,
    );
    service = new NativeAgentService(
      storage,
      async <T>(command: string): Promise<T> => {
        throw new Error(`Unexpected backend command: ${command}`);
      },
      { provider: async () => provider },
    );
  }

  async function stopService(): Promise<void> {
    await service?.shutdown();
    service = undefined;
    storage?.close();
    storage = undefined;
  }

  async function stopAll(): Promise<void> {
    await stopService();
    if (bridge) {
      const running = bridge;
      bridge = undefined;
      running.child.kill("SIGKILL");
      await running.exited;
    }
  }

  async function projection(): Promise<NativeAgentSessionProjection> {
    const read = await service!.getProjection(SUBAGENT_STACK_IDENTITY);
    if (!read) throw new Error("The backend has no projection for the sub-agent session");
    return read;
  }

  /**
   * Resolves on the bridge's next SSE frame for any session, keepalives
   * included. The caller re-reads the projection each time, so a frame is only
   * a hint to look again.
   */
  async function* bridgeEvents(signal: AbortSignal): AsyncGenerator<void> {
    const response = await fetch(`http://127.0.0.1:${bridge!.port}/event/subscribe`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok || !response.body) throw new Error(`SSE subscribe: ${response.status}`);
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
        yield;
      }
    } finally {
      reader.releaseLock();
    }
  }

  try {
    bridge = await startBridge();
    await startService(bridge.port);
  } catch (error) {
    await stopAll();
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    get bridgeGeneration() {
      return generation;
    },
    async prompt() {
      await service!.ensureSession(SUBAGENT_STACK_IDENTITY);
      await service!.dispatchPrompt({
        ...SUBAGENT_STACK_IDENTITY,
        prompt: SUBAGENT_STACK_PROMPT,
        requestId: `subagent-stack-${crypto.randomUUID()}`,
      });
    },
    async finishChildren() {
      const socket = createConnection(controlSocket);
      try {
        const reply = await new Promise<string>((resolve, reject) => {
          socket.once("error", reject);
          createInterface({ input: socket }).once("line", resolve);
          socket.write("finish\n");
        });
        if (reply !== "finished") throw new Error(`fake app-server answered ${reply}`);
      } finally {
        socket.destroy();
      }
    },
    projection,
    waitForProjection: (accept, description) =>
      waitForProjection({
        projection,
        subscribe: bridgeEvents,
        accept,
        description,
        diagnostics: (last) =>
          `last projection: ${JSON.stringify(last?.messages ?? null).slice(0, 4_000)}\nbridge stderr:\n${bridge?.stderr.join("\n") ?? ""}`,
      }),
    async reopenBackend() {
      await stopService();
      await startService(bridge!.port);
    },
    async restart() {
      await stopAll();
      bridge = await startBridge();
      await startService(bridge.port);
    },
    async close() {
      await stopAll();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
