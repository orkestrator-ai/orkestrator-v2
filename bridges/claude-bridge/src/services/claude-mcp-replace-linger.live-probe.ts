// Standalone reproduction for an upstream Claude Code report (to-do 0039
// task 1, code item 8): `Query.setMcpServers` replacing a stdio server's
// configuration under the same name connects a new process but never stops
// the old one, which keeps running (with its old environment) until the CLI
// exits.
//
// Self-contained on purpose, so it can be attached to the issue as one file:
// it imports only `@anthropic-ai/claude-agent-sdk` and Node built-ins, and it
// is its own fixture MCP server (`--server`). Nothing from this repository.
//
//   bun add @anthropic-ai/claude-agent-sdk
//   bun claude-mcp-replace-linger.live-probe.ts
//
// `CLAUDE_CLI_PATH` selects a Claude Code executable; without it the SDK's
// own. (In this repository the live test that runs it first refuses a
// `CLAUDE_CLI_PATH` inside the real data directory, `live-cli-guard.ts`; the
// check is not repeated here so the file stays self-contained.) Credential-free: every CLI runs in a temporary HOME and
// CLAUDE_CONFIG_DIR with non-essential traffic off, and no prompt is ever
// sent, so no model request is made. Exit status: 1 when a replaced process
// outlived the replacement (the bug), 0 when none did, 2 on an error or when
// interrupted (SIGTERM/SIGINT close the CLIs and remove the temporary roots).
// The last stdout line is `REPLACE_LINGER_RESULT <json>`.
import { query, type McpServerConfig, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const REPLACE_LINGER_SENTINEL = "REPLACE_LINGER_RESULT ";

/** How the server named `alpha` is first loaded, before it is replaced through `setMcpServers`. */
export type ReplaceScenario = "options" | "dynamic" | "settings";

export interface ReplaceObservation {
  scenario: ReplaceScenario;
  /** The `alpha` versions `mcpServerStatus()` reports after the replacement (`serverInfo.version`). */
  connected: string[];
  /** Every `alpha` process started, in order, with whether it is still alive after the replacement. */
  processes: { version: string; alive: boolean }[];
  /** Processes still alive a few seconds after the CLI exited. */
  aliveAfterExit: number;
  /** A process of the replaced configuration is still running while the CLI is. */
  lingering: boolean;
}

export interface ReplaceLingerResult {
  claudeCode: string;
  scenarios: ReplaceObservation[];
  reproduced: boolean;
}

const SELF = fileURLToPath(import.meta.url);
const READY_TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scenarios still running, so a SIGTERM or SIGINT (the live test's deadline
 * kill, or Ctrl-C) can close their CLIs and remove their temporary roots: an
 * exit on a signal never reaches `runScenario`'s `finally`.
 */
const active = new Set<ScenarioCleanup>();
interface ScenarioCleanup {
  root: string;
  close: () => void;
  /** Settles when the scenario's CLI has exited. */
  exited: () => Promise<void>;
}
/** How long an interrupted run waits for its CLIs to exit before removing their roots. */
const INTERRUPT_EXIT_WAIT_MS = 5_000;

async function cleanUpInterrupted(): Promise<void> {
  const entries = Array.from(active);
  for (const entry of entries) {
    try {
      entry.close();
    } catch {
      // Keep cleaning up the rest.
    }
  }
  // A closing CLI still writes its MCP logs into the scenario's HOME, so
  // removing the root before it exits would leave a fresh copy behind.
  await Promise.race([
    Promise.all(entries.map((entry) => entry.exited())),
    sleep(INTERRUPT_EXIT_WAIT_MS),
  ]);
  for (const entry of entries) rmSync(entry.root, { recursive: true, force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The fixture: a one-tool stdio MCP server that records `start <version> <pid>`. */
function serveFixture(name: string, version: string, markerFile: string): void {
  appendFileSync(markerFile, `start ${version} ${process.pid}\n`);
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
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
      if (message.method === "initialize")
        return reply({
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: `fixture-${name}`, version },
        });
      if (message.method === "tools/list")
        return reply({
          tools: [
            {
              name: "probe",
              description: "Answers with the fixture's version.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        });
      if (message.method === "ping") return reply({});
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    })
    .on("close", () => process.exit(0));
}

function claudeCodeVersion(): string {
  const executable = process.env.CLAUDE_CLI_PATH?.trim();
  if (!executable) return "the Agent SDK's bundled Claude Code";
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000 });
  return result.stdout?.trim() || `unknown (${executable})`;
}

async function runScenario(scenario: ReplaceScenario): Promise<ReplaceObservation> {
  const root = await mkdtemp(join(tmpdir(), "claude-mcp-replace-"));
  const home = join(root, "home");
  const configDir = join(home, ".claude");
  const cwd = join(root, "project");
  const markers = join(root, "markers.log");
  let exited: Promise<void> = Promise.resolve();
  const scenarioCleanup: ScenarioCleanup = { root, close: () => {}, exited: () => exited };
  active.add(scenarioCleanup);
  mkdirSync(configDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  appendFileSync(markers, "");
  const alpha = (version: string): McpServerConfig => ({
    type: "stdio",
    command: process.execPath,
    args: [SELF, "--server", "alpha", version, markers],
    env: { FIXTURE_SECRET: `secret-v${version}` },
  });
  writeFileSync(
    join(configDir, ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: scenario === "settings" ? { alpha: alpha("1") } : {},
    }),
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Input that ends without a message: the CLI starts and answers control
  // requests, but no turn runs and no model is called.
  const prompt: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await held;
        return { done: true, value: undefined };
      },
    }),
  };
  const executable = process.env.CLAUDE_CLI_PATH?.trim();
  const control = query({
    prompt,
    options: {
      cwd,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
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
      settingSources: ["user", "project"],
      mcpServers: scenario === "options" ? { alpha: alpha("1") } : {},
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
  scenarioCleanup.close = () => control.close();
  const starts = () =>
    readFileSync(markers, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("start "))
      .map((line) => {
        const [, version = "", pid = "0"] = line.split(" ");
        return { version, pid: Number(pid) };
      });
  const connectedVersions = async () =>
    (await control.mcpServerStatus())
      .filter((server) => server.name === "alpha" && server.status === "connected")
      .map((server) => server.serverInfo?.version ?? "?");
  const waitFor = async (what: string, ready: () => Promise<boolean>) => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!(await ready())) {
      if (Date.now() > deadline) throw new Error(`${scenario}: ${what} did not happen`);
      await sleep(100);
    }
  };
  try {
    if (scenario === "dynamic") {
      await waitFor("CLI start", async () => Array.isArray(await control.mcpServerStatus()));
      await control.setMcpServers({ alpha: alpha("1") });
    }
    await waitFor("version 1 connecting", async () => (await connectedVersions()).includes("1"));
    // Same name, changed configuration (another argument and env value).
    await control.setMcpServers({ alpha: alpha("2") });
    await waitFor("version 2 connecting", async () => (await connectedVersions()).includes("2"));
    // Give a stopped process time to exit before looking.
    await sleep(2_000);
    const processes = starts().map((start) => ({
      version: start.version,
      alive: isAlive(start.pid),
    }));
    const connected = await connectedVersions();
    release();
    control.close();
    await exited;
    await sleep(3_000);
    return {
      scenario,
      connected,
      processes,
      aliveAfterExit: starts().filter((start) => isAlive(start.pid)).length,
      lingering: processes.some((entry) => entry.version === "1" && entry.alive),
    };
  } finally {
    release();
    control.close();
    await exited;
    await rm(root, { recursive: true, force: true });
    active.delete(scenarioCleanup);
  }
}

export async function runReplaceLingerProbe(): Promise<ReplaceLingerResult> {
  const scenarios: ReplaceObservation[] = [];
  for (const scenario of ["options", "dynamic", "settings"] as const)
    scenarios.push(await runScenario(scenario));
  return {
    claudeCode: claudeCodeVersion(),
    scenarios,
    reproduced: scenarios.some((entry) => entry.lingering),
  };
}

function describe(result: ReplaceLingerResult): string {
  const lines = [`Claude Code: ${result.claudeCode}`];
  for (const entry of result.scenarios) {
    const running = entry.processes
      .map((process) => `v${process.version} ${process.alive ? "running" : "stopped"}`)
      .join(", ");
    lines.push(
      `${entry.scenario}: connected v${entry.connected.join(", v") || "-"}; processes ${running}; ` +
        `${entry.aliveAfterExit} alive after the CLI exited` +
        (entry.lingering ? " -> the replaced process lingered" : ""),
    );
  }
  lines.push(result.reproduced ? "REPRODUCED" : "NOT REPRODUCED");
  return lines.join("\n");
}

if (import.meta.main) {
  const [flag, name = "alpha", version = "1", markerFile] = process.argv.slice(2);
  if (flag === "--server" && markerFile) {
    serveFixture(name, version, markerFile);
  } else {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        void cleanUpInterrupted().finally(() => process.exit(2));
      });
    }
    try {
      const result = await runReplaceLingerProbe();
      console.log(describe(result));
      console.log(`${REPLACE_LINGER_SENTINEL}${JSON.stringify(result)}`);
      process.exitCode = result.reproduced ? 1 : 0;
    } catch (error) {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exitCode = 2;
    }
  }
}
