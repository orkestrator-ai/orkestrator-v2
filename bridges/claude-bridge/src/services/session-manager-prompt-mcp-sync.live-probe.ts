// Proves on the real pinned Claude CLI what `session-manager-prompt-mcp-sync.ts`
// relies on. Run by `session-manager-prompt-mcp-sync.live.test.ts` in its own
// process, because the session-manager suites replace the SDK with a mock.
//
// Credential-free: every CLI runs in a temporary home and configuration
// directory with non-essential traffic off. Inventory scenarios write no prompt;
// the call scenario uses a deterministic loopback model. The servers are `session-manager-prompt-mcp-sync.live-fixture.ts`.
// What the model is offered is read from `getContextUsage({ detail: "summary" })`,
// which lists the CLI's own MCP tool registry without a token-count request.
import { runMcpCallProbe } from "./session-manager-prompt-mcp-sync.live-calls.js";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeQueryControl } from "../types/index.js";
import { setClaudeAccountHomeForTesting, setClaudeHomeForTesting } from "./claude-home.js";
import {
  claudeAccountOnlyMcpServerNames,
  getMcpRuntimeConfig,
  type SdkMcpServersConfig,
} from "./mcp-config.js";
import { claudeExecutableOptions } from "./session-manager-core.js";
import {
  createClaudeRuntimeMcp,
  type McpSyncRuntime,
  type McpSyncTarget,
  syncClaudeRuntimeMcp,
} from "./session-manager-prompt-mcp-sync.js";

export const RESULT_SENTINEL = "__CLAUDE_MCP_SYNC_RESULT__";

/** What one scenario left the CLI running. */
export interface McpSyncObservation {
  /** Servers the CLI reports, other than disabled ones. */
  servers: string[];
  /** MCP tools the CLI would offer the model. */
  tools: string[];
  /** What the sync reported it could not unload. */
  stale: string[];
  /** Fixture servers whose process is still alive. */
  alive: string[];
  /** All process starts and handshakes, including servers later stopped. */
  started: string[];
  initialized: string[];
}

const FIXTURE = join(import.meta.dir, "session-manager-prompt-mcp-sync.live-fixture.ts");
const READY_TIMEOUT_MS = 20_000;
const open = new Set<Query>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What an account scenario's bridge resolves from the host file, as `resolveQueryPlan` does. */
interface BridgeView {
  writeHost: (servers: Record<string, unknown>) => void;
  /** The next turn's sync target, read from the host file by the bridge's own resolver. */
  next: (key: string) => Promise<McpSyncTarget>;
}

interface Scenario {
  /** `mcpServers` in the CLI's own `.claude.json`. */
  file: Record<string, unknown>;
  /** What the bridge passes inline at launch. */
  inline: SdkMcpServersConfig;
  /** Every name the configuration declares at launch. */
  declared: string[];
  /**
   * An added Claude account: `mcpServers` of the host `HOME/.claude.json`,
   * which the bridge reads, while the CLI reads `file` from its
   * `CLAUDE_CONFIG_DIR`. The launch set (`inline`, `declared`, the
   * account-only names) is then resolved by the bridge's own code instead.
   */
  host?: Record<string, unknown>;
  act: (
    runtime: McpSyncRuntime,
    writeFile: (servers: Record<string, unknown>) => void,
    bridge: BridgeView,
  ) => Promise<void>;
}

/** Runs one scenario on its own CLI; `build` gets the fixture servers for this run. */
async function run(
  build: (fixture: (name: string, version?: string) => SdkMcpServersConfig[string]) => Scenario,
): Promise<McpSyncObservation> {
  const root = await mkdtemp(join(tmpdir(), "claude-mcp-sync-"));
  const home = join(root, "home");
  const configDir = join(home, ".claude");
  const cwd = join(root, "project");
  const markers = join(root, "markers.log");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  appendFileSync(markers, "");
  const scenario = build((name, version = "1") => ({
    type: "stdio",
    command: process.execPath,
    args: [FIXTURE, name, version, markers],
  }));
  const writeFile = (servers: Record<string, unknown>) =>
    writeFileSync(
      join(configDir, ".claude.json"),
      JSON.stringify({ hasCompletedOnboarding: true, mcpServers: servers }),
    );
  writeFile(scenario.file);
  const writeHost = (servers: Record<string, unknown>) =>
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: servers }));
  const settingSources = ["user", "project"];
  const bridge: BridgeView = {
    writeHost,
    next: async (key) => {
      const { servers, names } = await getMcpRuntimeConfig(cwd, {}, undefined, "user");
      return { servers, key, names, required: [] };
    },
  };
  let accountOnly: string[] = [];
  if (scenario.host) {
    writeHost(scenario.host);
    setClaudeHomeForTesting(home);
    setClaudeAccountHomeForTesting(configDir);
    const launch = await bridge.next("launch");
    scenario.inline = launch.servers;
    scenario.declared = Array.from(launch.names);
    accountOnly = await claudeAccountOnlyMcpServerNames(cwd, settingSources, launch.names);
  }
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Input that ends without a message: the CLI starts and answers control
  // requests, but no turn ever runs.
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await held;
        return { done: true, value: undefined };
      },
    }),
  };
  // The CLI writes its MCP logs under `home` while it shuts down, so the
  // directory is removed only once the process has exited.
  let exited: Promise<void> = Promise.resolve();
  const control = query({
    prompt,
    options: {
      cwd,
      ...claudeExecutableOptions(),
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ["pipe", "pipe", "ignore"],
        });
        exited = new Promise((resolve) => {
          child.once("exit", () => resolve());
          child.once("error", () => resolve());
        });
        return child;
      },
      settingSources: settingSources as ("user" | "project")[],
      mcpServers: scenario.inline,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      },
    },
  });
  open.add(control);
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while ((await control.mcpServerStatus()).some((server) => server.status === "pending")) {
      if (Date.now() > deadline) throw new Error("MCP servers did not finish connecting");
      await sleep(100);
    }
    const runtime: McpSyncRuntime = {
      control: control as unknown as ClaudeQueryControl,
      mcpServers: "launch",
      mcp: createClaudeRuntimeMcp(scenario.inline, scenario.declared, accountOnly),
    };
    await scenario.act(runtime, writeFile, bridge);
    // Let a server the CLI stopped finish exiting.
    await sleep(1_000);
    const servers = (await control.mcpServerStatus())
      .filter((server) => server.status !== "disabled")
      .map((server) => server.name)
      .sort();
    const usage = await control.getContextUsage({ detail: "summary" });
    const tools = usage.mcpTools.map((tool) => tool.name).sort();
    const events = readFileSync(markers, "utf8")
      .split("\n")
      .map((line) => line.split(" "));
    const alive = events
      .filter(([event, , pid]) => event === "start" && isAlive(Number(pid)))
      .map(([, name]) => name!)
      .sort();
    return {
      servers,
      tools,
      stale: Array.from(runtime.mcp.stale).sort(),
      alive,
      started: events
        .filter(([event]) => event === "start")
        .map(([, name]) => name!)
        .sort(),
      initialized: events
        .filter(([event]) => event === "initialize")
        .map(([, name]) => name!)
        .sort(),
    };
  } finally {
    release();
    open.delete(control);
    control.close();
    await exited;
    setClaudeHomeForTesting(null);
    setClaudeAccountHomeForTesting(undefined);
    await rm(root, { recursive: true, force: true });
  }
}

/** Every scenario, each on its own CLI. */
export async function runMcpSyncProbe(): Promise<Record<string, McpSyncObservation>> {
  return {
    // The update without the takeover: the launch server stays.
    bare: await run((fixture) => ({
      file: { alpha: fixture("alpha") },
      inline: { alpha: fixture("alpha") },
      declared: ["alpha"],
      act: async (runtime, writeFile) => {
        writeFile({});
        await runtime.control.setMcpServers!({});
      },
    })),
    remove: await run((fixture) => ({
      file: { alpha: fixture("alpha"), keep: fixture("keep") },
      inline: { alpha: fixture("alpha"), keep: fixture("keep") },
      declared: ["alpha", "keep"],
      act: async (runtime, writeFile) => {
        writeFile({ keep: fixture("keep") });
        await syncClaudeRuntimeMcp(runtime, {
          servers: { keep: fixture("keep") },
          key: "next",
          names: new Set(["keep"]),
          required: [],
        });
      },
    })),
    rename: await run((fixture) => ({
      file: { alpha: fixture("alpha") },
      inline: { alpha: fixture("alpha") },
      declared: ["alpha"],
      act: async (runtime, writeFile) => {
        writeFile({ beta: fixture("beta") });
        await syncClaudeRuntimeMcp(runtime, {
          servers: { beta: fixture("beta") },
          key: "next",
          names: new Set(["beta"]),
          required: [],
        });
      },
    })),
    // An edit of a server's configuration under the same name. The CLI
    // connects the new process; whether it stops the old one is upstream
    // behaviour (0039 item 8) the live test records.
    replace: await run((fixture) => ({
      file: { alpha: fixture("alpha") },
      inline: { alpha: fixture("alpha") },
      declared: ["alpha"],
      act: async (runtime, writeFile) => {
        writeFile({ alpha: fixture("alpha", "2") });
        await syncClaudeRuntimeMcp(runtime, {
          servers: { alpha: fixture("alpha", "2") },
          key: "next",
          names: new Set(["alpha"]),
          required: [],
        });
      },
    })),
    // An added Claude account (0039 item 12). The bridge reads the host
    // file and the CLI reads the account's copy, which still names `extra`
    // (removed from the host since the copy was made, or added inside the
    // account home). The host's SSE entry, which the bridge never passes
    // inline, shows whether the CLI reads the host file too. Then two host
    // edits, each picked up on the next turn as the bridge does: an addition,
    // and the removal of a server the account's copy still names.
    account: await run((fixture) => ({
      host: { keep: fixture("keep"), hostsse: { type: "sse", url: "http://127.0.0.1:9/sse" } },
      file: { keep: fixture("keep"), extra: fixture("extra") },
      inline: {},
      declared: [],
      act: async (runtime, _writeFile, bridge) => {
        const sse = { type: "sse", url: "http://127.0.0.1:9/sse" };
        bridge.writeHost({ keep: fixture("keep"), added: fixture("added"), hostsse: sse });
        await syncClaudeRuntimeMcp(runtime, await bridge.next("added"));
        bridge.writeHost({ added: fixture("added"), hostsse: sse });
        await syncClaudeRuntimeMcp(runtime, await bridge.next("removed"));
      },
    })),
    // An SSE entry the bridge never passes inline; the CLI loads it itself.
    fileOnly: await run((fixture) => ({
      file: { keep: fixture("keep"), remote: { type: "sse", url: "http://127.0.0.1:9/sse" } },
      inline: { keep: fixture("keep") },
      declared: ["keep", "remote"],
      act: async (runtime, writeFile) => {
        writeFile({ keep: fixture("keep") });
        await syncClaudeRuntimeMcp(runtime, {
          servers: { keep: fixture("keep") },
          key: "launch",
          names: new Set(["keep"]),
          required: [],
        });
      },
    })),
  };
}

if (import.meta.main) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      for (const control of open) control.close();
      process.exit(1);
    });
  }
  try {
    console.log(
      `${RESULT_SENTINEL}${JSON.stringify({ ...(await runMcpSyncProbe()), calls: await runMcpCallProbe(open) })}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
