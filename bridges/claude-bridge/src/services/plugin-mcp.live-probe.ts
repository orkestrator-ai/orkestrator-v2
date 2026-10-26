// Runs the pinned Claude CLI with the plugin set the bridge passes and prints
// the MCP servers it loaded. Used by the backend's
// `apps/backend/tests/claude-plugin-mcp-live.test.ts` to prove the MCP
// editor's plugin rows, the live rows and their join agree.
//
// Credential-free: the CLI runs in the caller's temporary home with
// non-essential traffic off, and no prompt is ever sent; `mcpServerStatus()`
// answers without a model. Usage:
//   bun plugin-mcp.live-probe.ts '{"home":…,"cwd":…,"settingSources":[…]}'
import { query, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";

import { setClaudeHomeForTesting } from "./claude-home.js";
import { mcpScope } from "./mcp-runtime-status.js";
import { getPluginsForSdk } from "./plugin-config.js";

export const PLUGIN_PROBE_SENTINEL = "__CLAUDE_PLUGIN_MCP_RESULT__";

interface ProbeInput {
  home: string;
  cwd: string;
  settingSources: SettingSource[];
}

const READY_TIMEOUT_MS = 30_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const input = JSON.parse(process.argv[2] ?? "{}") as ProbeInput;
  setClaudeHomeForTesting(input.home);
  // Exactly what a turn passes: project plugin layers only with project
  // resources, installs only when the loaded settings enable them.
  const plugins = await getPluginsForSdk(
    input.cwd,
    input.settingSources.includes("project"),
    input.settingSources,
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
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
      cwd: input.cwd,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      settingSources: input.settingSources,
      plugins,
      env: {
        PATH: process.env.PATH,
        HOME: input.home,
        CLAUDE_CONFIG_DIR: `${input.home}/.claude`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_AUTOUPDATER: "1",
        ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      },
    },
  });
  const stop = () => {
    release();
    control.close();
  };
  process.once("SIGTERM", () => {
    stop();
    process.exit(143);
  });
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let servers = await control.mcpServerStatus();
    while (servers.some((server) => server.status === "pending")) {
      if (Date.now() > deadline) throw new Error("MCP servers did not finish connecting");
      await sleep(100);
      servers = await control.mcpServerStatus();
    }
    const result = {
      plugins: plugins.map((plugin) => plugin.path),
      servers: servers
        .map((server) => ({
          name: server.name,
          status: server.status,
          // The live panel's layer, mapped exactly as the bridge maps it.
          scope: mcpScope(server.scope, server.name, server.source),
          args:
            server.config && "args" in server.config && Array.isArray(server.config.args)
              ? server.config.args
              : undefined,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
    process.stdout.write(`${PLUGIN_PROBE_SENTINEL}${JSON.stringify(result)}\n`);
  } finally {
    stop();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  },
);
