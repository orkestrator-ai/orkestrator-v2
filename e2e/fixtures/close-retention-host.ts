/**
 * The backend behind the close-retention browser spec.
 *
 * Real from the renderer's `invoke` down to each vendor engine: the backend
 * command registry (`teardown_tab`, the native agent commands, pane layouts,
 * compose drafts) over a real `StorageService` and `NativeAgentService`, the
 * real `HttpBridgeProvider` talking to the real Cursor, Pi and ACP (Grok)
 * bridges over HTTP, and the real `OpenCodeProvider`. Only the engines are
 * fake, each at its own boundary:
 *
 * - Cursor: `bridges/cursor-bridge/src/testing/fake-engine-server.ts`
 * - Pi: `bridges/pi-bridge/src/testing/fake-engine-server.ts` (pi-ai faux model)
 * - Grok: `bridges/acp-bridge/src/testing/fake-agent-close.ts`
 * - OpenCode: `close-retention-opencode.ts` (in-memory SDK client)
 *
 * The page reaches it through `/__close-retention/*`, which the spec proxies
 * here. Besides `/invoke`, the host answers `/environment` (a fresh
 * environment per case), `/vendor` (what each engine actually holds),
 * `/bridge-requests` (every request the backend sent each bridge) and
 * `/cursor-create-gate` (hold or release Cursor's `Agent.create`).
 *
 * Nothing here reads provider credentials or reaches the network.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { OpenCodeMessageIdCoordinator } from "@orkestrator/protocol/opencode-message-id";
import { BackendRuntime } from "../../apps/backend/src/core/backend-runtime";
import { createCommandRegistry } from "../../apps/backend/src/core/commands";
import type { CommandContext } from "../../apps/backend/src/core/commands-context";
import { createNativeAgentProvider } from "../../apps/backend/src/core/native-agent-provider";
import { NativeAgentService } from "../../apps/backend/src/core/native-agent-service";
import { StorageService } from "../../apps/backend/src/core/storage";
import { createOpenCodeEngine } from "./close-retention-opencode";

installFatalRejectionGuard({ label: "[close-retention-host]" });

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const root = mkdtempSync(path.join(tmpdir(), "close-retention-"));
const workspace = path.join(root, "workspace");
mkdirSync(workspace, { recursive: true });

type BridgePlatform = "cursor" | "pi" | "grok";
type Bridge = { child: ChildProcess; port: number; token: string; stderr: string };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const files = {
  cursorStore: path.join(root, "cursor", "store.json"),
  cursorLog: path.join(root, "cursor", "sdk.log"),
  cursorCreateGate: path.join(root, "cursor", "create-gate"),
  piCalls: path.join(root, "pi", "calls.jsonl"),
  piSessions: path.join(root, "pi", "sessions"),
  grokStore: path.join(root, "grok", "store.jsonl"),
  grokLog: path.join(root, "grok", "events.log"),
};

async function startBridge(platform: BridgePlatform): Promise<Bridge> {
  const port = await freePort();
  const token = `close-retention-${platform}-${port}`;
  const directory = path.join(root, platform);
  mkdirSync(path.join(directory, "home"), { recursive: true });
  // A minimal environment: nothing ambient can supply a credential or point a
  // bridge at a real state directory.
  const common = {
    PATH: process.env.PATH ?? "",
    HOME: path.join(directory, "home"),
    TMPDIR: tmpdir(),
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    CWD: workspace,
    // Each bridge's own watchdog: if this host dies, the bridge follows.
    ORKESTRATOR_PARENT_PID: String(process.pid),
  };
  let entry: string;
  let env: Record<string, string>;
  if (platform === "cursor") {
    entry = "bridges/cursor-bridge/src/testing/fake-engine-server.ts";
    env = {
      ...common,
      CURSOR_BRIDGE_TOKEN: token,
      CURSOR_BRIDGE_STATE_DIR: path.join(directory, "state"),
      CURSOR_BRIDGE_AUTH_FILE: path.join(directory, "no-auth.json"),
      FAKE_CURSOR_STORE: files.cursorStore,
      FAKE_CURSOR_LOG: files.cursorLog,
      FAKE_CURSOR_CREATE_GATE: files.cursorCreateGate,
    };
  } else if (platform === "pi") {
    mkdirSync(files.piSessions, { recursive: true });
    mkdirSync(path.join(directory, "agent"), { recursive: true });
    entry = "bridges/pi-bridge/src/testing/fake-engine-server.ts";
    env = {
      ...common,
      PI_BRIDGE_TOKEN: token,
      PI_BRIDGE_STATE_DIR: path.join(directory, "state"),
      PI_SESSION_DIR: files.piSessions,
      PI_AGENT_DIR: path.join(directory, "agent"),
      FAKE_PI_CALLS: files.piCalls,
    };
  } else {
    const grokHome = path.join(directory, "grok-home");
    mkdirSync(grokHome, { recursive: true });
    // Signed in as far as the bridge can tell; the fake agent asks nothing.
    await Bun.write(path.join(grokHome, "auth.json"), "{}");
    entry = "bridges/acp-bridge/src/index.ts";
    env = {
      ...common,
      ACP_PROVIDER: "grok",
      ACP_AGENT_PATH: path.join(
        repositoryRoot,
        "bridges/acp-bridge/src/testing/fake-agent-close.ts",
      ),
      ACP_BRIDGE_TOKEN: token,
      ACP_STATE_DIR: path.join(directory, "state"),
      ACP_MEASURE_COMMAND_CHANGES: "0",
      GROK_HOME: grokHome,
      FAKE_CLOSE_STORE: files.grokStore,
      FAKE_CLOSE_LOG: files.grokLog,
    };
  }
  const packageDirectory = path.join(repositoryRoot, entry.split("/src/")[0]!);
  const child = spawn(process.execPath, [path.join(repositoryRoot, entry)], {
    cwd: packageDirectory,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const bridge: Bridge = { child, port, token, stderr: "" };
  // Bounded, and only for a startup failure message.
  child.stderr?.on("data", (chunk: Buffer) => {
    bridge.stderr = (bridge.stderr + chunk.toString("utf8")).slice(-4_000);
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${platform} bridge exited during startup: ${bridge.stderr}`);
    }
    if (
      await fetch(`http://127.0.0.1:${port}/global/health`).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      return bridge;
    }
    await Bun.sleep(50);
  }
  throw new Error(`${platform} bridge did not become healthy: ${bridge.stderr}`);
}

const bridges = Object.fromEntries(
  await Promise.all(
    (["cursor", "pi", "grok"] as const).map(async (platform) => [
      platform,
      await startBridge(platform),
    ]),
  ),
) as Record<BridgePlatform, Bridge>;

/** Every request the backend sent each bridge, in order: `METHOD /path`. */
const bridgeRequests: Record<BridgePlatform, string[]> = { cursor: [], pi: [], grok: [] };
const portPlatform = new Map(
  Object.entries(bridges).map(([platform, bridge]) => [bridge.port, platform as BridgePlatform]),
);
const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const platform = portPlatform.get(Number(url.port));
  if (platform) {
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    bridgeRequests[platform].push(`${method.toUpperCase()} ${url.pathname}`);
  }
  return fetch(input, init);
}) as typeof fetch;

const openCode = createOpenCodeEngine(workspace);
const storage = new StorageService(path.join(root, "data"));
await storage.init();

const invokeInternal = async <T>(command: string): Promise<T> => {
  throw new Error(`The close-retention host does not serve ${command} to the service`);
};
const nativeAgents = new NativeAgentService(storage, invokeInternal, {
  // The production registry starts a bridge per environment; here every
  // environment shares one bridge per platform, already running.
  provider: async (input) => {
    if (input.agent === "opencode") {
      return createNativeAgentProvider(
        {
          agent: "opencode",
          baseUrl: "http://opencode.close-retention.invalid",
          authToken: "close-retention",
          directory: workspace,
        },
        {
          openCodeClient: openCode.client,
          openCodeMessageIdCoordinator: new OpenCodeMessageIdCoordinator(),
          autoAnswerRequests: false,
        },
      );
    }
    if (input.agent !== "cursor" && input.agent !== "pi" && input.agent !== "grok") {
      throw new Error(`The close-retention host has no ${input.agent} bridge`);
    }
    const bridge = bridges[input.agent];
    return createNativeAgentProvider(
      { agent: input.agent, baseUrl: `http://127.0.0.1:${bridge.port}`, authToken: bridge.token },
      { autoAnswerRequests: false, fetch: recordingFetch },
    );
  },
});
await nativeAgents.init();

const commands = createCommandRegistry({
  tabTeardown: {
    peekBridge: async (_environment, agent) => {
      if (agent !== "cursor" && agent !== "pi" && agent !== "grok") return null;
      return { port: bridges[agent].port, authToken: bridges[agent].token };
    },
    fetch: recordingFetch,
  },
});
const context = {
  storage,
  nativeAgents,
  emit: () => undefined,
  runtime: new BackendRuntime({ emit: () => undefined }),
  appRoot: repositoryRoot,
  resourceRoot: repositoryRoot,
  runtimeFlavor: "agent-test",
} as unknown as CommandContext;

let environmentCount = 0;
async function createEnvironment(): Promise<string> {
  environmentCount += 1;
  const id = `close-retention-${Date.now().toString(36)}-${environmentCount}`;
  await storage.addEnvironment({
    id,
    projectId: "close-retention-project",
    name: `Close retention ${environmentCount}`,
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date().toISOString(),
    networkAccessMode: "full",
    order: environmentCount,
    environmentType: "local",
    worktreePath: workspace,
    setupScriptsComplete: true,
  } as Parameters<StorageService["addEnvironment"]>[0]);
  return id;
}

function readJsonLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * What each engine holds, read from its own store rather than from the
 * bridge: the conversations that exist and the prompts each one actually ran.
 */
function vendorView() {
  const cursor = existsSync(files.cursorStore)
    ? (JSON.parse(readFileSync(files.cursorStore, "utf8")) as {
        agents: Record<string, { turns: Array<{ prompt: string; status: string }> }>;
      })
    : { agents: {} };
  const grokTurns = readJsonLines(files.grokStore) as Array<{
    sessionId: string;
    prompt?: string;
  }>;
  const grokSessions = new Map<string, string[]>();
  for (const turn of grokTurns) {
    const prompts = grokSessions.get(turn.sessionId) ?? [];
    if (turn.prompt !== undefined) prompts.push(turn.prompt);
    grokSessions.set(turn.sessionId, prompts);
  }
  return {
    cursor: Object.entries(cursor.agents).map(([id, agent]) => ({
      id,
      prompts: agent.turns.map((turn) => turn.prompt),
      statuses: agent.turns.map((turn) => turn.status),
    })),
    // `<event>:<agentId>` for every SDK call, in order.
    cursorSdk: existsSync(files.cursorLog)
      ? readFileSync(files.cursorLog, "utf8").split("\n").filter(Boolean)
      : [],
    pi: {
      sessionFiles: existsSync(files.piSessions)
        ? readdirSync(files.piSessions, { recursive: true }).filter((file) =>
            String(file).endsWith(".jsonl"),
          ).length
        : 0,
      // The user prompts the model was given on each call, in order.
      calls: (readJsonLines(files.piCalls) as Array<{ prompts: string[] }>).map(
        (call) => call.prompts,
      ),
    },
    grok: {
      sessions: [...grokSessions].map(([id, prompts]) => ({ id, prompts })),
      // Lifecycle events across every agent process: `cancel`, `reply:<kind>:…`.
      events: existsSync(files.grokLog)
        ? readFileSync(files.grokLog, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(line.indexOf(" ") + 1))
        : [],
    },
    opencode: openCode.view(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/invoke" && request.method === "POST") {
      const { command, args } = (await request.json()) as {
        command: string;
        args?: Record<string, unknown>;
      };
      const handler = commands.get(command);
      if (!handler) {
        return Response.json({ error: `Unknown command: ${command}` }, { status: 404 });
      }
      try {
        return Response.json({ result: (await handler(args ?? {}, context)) ?? null });
      } catch (error) {
        return Response.json({ error: errorMessage(error) }, { status: 500 });
      }
    }
    if (pathname === "/environment" && request.method === "POST") {
      return Response.json({ environmentId: await createEnvironment(), worktreePath: workspace });
    }
    if (pathname === "/vendor") return Response.json(vendorView());
    if (pathname === "/cursor-create-gate" && request.method === "POST") {
      // Held: the next Cursor SDK agent creation does not return until released.
      const { held } = (await request.json()) as { held: boolean };
      if (held) await Bun.write(files.cursorCreateGate, "held");
      else rmSync(files.cursorCreateGate, { force: true });
      return Response.json({ held });
    }
    if (pathname === "/bridge-requests") return Response.json(bridgeRequests);
    return new Response("Not found", { status: 404 });
  },
});

async function shutdown() {
  await nativeAgents.shutdown().catch(() => undefined);
  server.stop(true);
  for (const bridge of Object.values(bridges)) bridge.child.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

console.log(`CLOSE_RETENTION_HOST_READY:${server.port}`);
