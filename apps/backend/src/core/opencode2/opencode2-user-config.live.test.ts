import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { OpenCode2Client } from "./client.js";
import { openCode2ConfiguredUserMcpServers } from "./mcp.js";
import { openCode2CreateRules, openCode2PolicyRules } from "./permissions.js";
import { OPENCODE2_FLAGS, writeOpenCode2HostConfig } from "./server.js";
import { mintOpenCode2InputId } from "./steer.js";

/**
 * The user's global OpenCode configuration on a real pinned 2.x server, as
 * the host launch gives it (`user-config.ts`): a fake `~/.config/opencode`
 * (an isolated `XDG_CONFIG_HOME`, never the developer's) with a local MCP
 * server, a slash command, a 1.x plugin file and a 1.x `plugin` entry. Run
 * with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE2 === "1" && binary ? test : test.skip;

/** A newline-delimited JSON-RPC MCP server on stdio with one tool. */
const STDIO_MCP_SERVER = `
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "user-fixture", version: "1" },
      });
    } else if (message.method === "tools/list") {
      reply(message.id, {
        tools: [{
          name: "user_echo",
          description: "Echo a value",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        }],
      });
    } else if (message.method === "tools/call") {
      reply(message.id, { content: [{ type: "text", text: "user-mcp-answer:" + message.params.arguments.value }] });
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } }) + "\\n");
    }
  }
});
`;

/** A 1.x plugin: importing it at all leaves a marker. */
const V1_PLUGIN = (marker: string) => `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "loaded");
export const UserPlugin = async () => ({});
`;

let fixture: OpenCode2Fixture | undefined;
let root: string | undefined;
afterEach(async () => {
  await fixture?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  fixture = undefined;
  root = undefined;
});

/** Every file below `dir` with its contents, to prove nothing was written there. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = entry.isFile() ? await readFile(file, "utf8") : "dir";
  }
  return out;
}

async function toolOutput(client: OpenCode2Client, sessionId: string, end: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = (await client.listMessages(sessionId, { limit: 50, order: "asc" }))
      .messages as Array<{ content?: Array<{ type: string; state?: { content?: unknown } }> }>;
    const output = JSON.stringify(
      rows.flatMap((row) => row.content ?? []).filter((part) => part.type === "tool"),
    );
    if (output.includes(end)) return output;
    await Bun.sleep(100);
  }
  throw new Error("the tool never answered");
}

liveTest(
  "a 2.x server sees the user's global MCP servers and commands, never their plugins",
  async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode2-usercfg-")));
    const xdg = path.join(root, "xdg");
    const userDir = path.join(xdg, "opencode");
    const marker = path.join(root, "v1-plugin-loaded");
    const mcpScript = path.join(root, "user-mcp.js");
    await mkdir(path.join(userDir, "command"), { recursive: true });
    await mkdir(path.join(userDir, "plugins"), { recursive: true });
    await writeFile(mcpScript, STDIO_MCP_SERVER);
    await writeFile(path.join(userDir, "plugins", "user-v1.ts"), V1_PLUGIN(marker));
    await writeFile(
      path.join(userDir, "command", "user-hello.md"),
      "---\ndescription: Say hello from the user's config\n---\nSay hello.\n",
    );
    await writeFile(
      path.join(userDir, "opencode.json"),
      JSON.stringify({
        // A 1.x npm plugin and a 2.x removal: both must stay away from 2.x.
        plugin: ["opencode-orkestrator-test-nonexistent-plugin", "-*"],
        mcp: { "user-tools": { type: "local", command: [process.execPath, mcpScript] } },
      }),
    );
    const before = await snapshot(userDir);

    const dataDir = path.join(root, "data");
    const configDir = await writeOpenCode2HostConfig(dataDir, {
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: xdg,
    });
    fixture = await startOpenCode2Fixture(binary!, {
      env: {
        XDG_CONFIG_HOME: xdg,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_FLAGS: OPENCODE2_FLAGS,
      },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    const client = new OpenCode2Client({
      baseUrl: fixture.baseUrl,
      password: fixture.password,
      directory: fixture.directory,
    });

    // The user's server is listed and connects.
    let servers = await client.listMcpServers();
    for (let attempt = 0; attempt < 100; attempt++) {
      if (servers.some((s) => s.name === "user-tools" && s.status.status === "connected")) break;
      await Bun.sleep(100);
      servers = await client.listMcpServers();
    }
    expect(servers.find((s) => s.name === "user-tools")?.status).toMatchObject({
      status: "connected",
    });

    // A session can call it.
    const session = await client.createSession({ model: { providerID: "fixture", id: "fixture" } });
    await client.prompt(session.id, {
      id: mintOpenCode2InputId(),
      text: 'RUN_TOOL:execute {"code":"return await tools[\\"user-tools\\"].user_echo({ value: \\"hi\\" })"}',
      delivery: "steer",
    });
    // Its tools are reached through Code Mode (`execute`), 2.x's default for a configured server.
    const output = await toolOutput(client, session.id, "user-mcp-answer");
    expect(output).toContain("user-mcp-answer:hi");
    expect(fixture.model.calls.some((call) => call.tools.includes("execute"))).toBe(true);

    // The credential plugin still loaded, despite the user's "-*".
    const shell = await client.createSession({ model: { providerID: "fixture", id: "fixture" } });
    await client.prompt(shell.id, {
      id: mintOpenCode2InputId(),
      text: "RUN_BASH:echo PW=${OPENCODE_PASSWORD:+SET} END",
      delivery: "steer",
    });
    expect(await toolOutput(client, shell.id, "END")).toContain("PW= END");

    // The user's command is served; their 1.x plugin never ran; nothing of theirs was written.
    expect(await commands(fixture)).toContain("user-hello");
    expect(existsSync(marker)).toBe(false);
    expect(await snapshot(userDir)).toEqual(before);

    // A policy that selects no user server denies its tools, through Code Mode too.
    const policy: NativeAgentExecutionPolicy = {
      id: "pipeline",
      sandbox: "none",
      approvals: "auto-approve",
      projectResources: true,
      networkAccess: "full",
      capabilityPolicy: { deny: [], userMcpServers: [] },
    };
    const configured = await openCode2ConfiguredUserMcpServers(client, policy);
    expect(configured).toEqual(["user-tools"]);
    const narrowed = await client.createSession({
      model: { providerID: "fixture", id: "fixture" },
      permissions: openCode2CreateRules(openCode2PolicyRules(policy, configured)),
    });
    await client.prompt(narrowed.id, {
      id: mintOpenCode2InputId(),
      text: 'RUN_TOOL:execute {"code":"return await tools[\\"user-tools\\"].user_echo({ value: \\"denied\\" })"}',
      delivery: "steer",
    });
    // The turn settles (an idle row follows it) before its tool output is read.
    let rows: Array<{ type: string }> = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      rows = (await client.listMessages(narrowed.id, { limit: 50, order: "asc" }))
        .messages as Array<{ type: string }>;
      if (rows.some((row) => row.type === "idle")) break;
      await Bun.sleep(100);
    }
    expect(rows.some((row) => row.type === "idle")).toBe(true);
    // The model did call `execute`, and Code Mode no longer offers the denied server's tool.
    const tools = (rows as Array<{ content?: Array<{ type: string; name?: string }> }>)
      .flatMap((row) => row.content ?? [])
      .filter((part) => part.type === "tool");
    expect(tools.map((part) => part.name)).toContain("execute");
    expect(JSON.stringify(tools)).toContain("Unknown tool 'user-tools.user_echo'");
    expect(JSON.stringify(rows)).not.toContain("user-mcp-answer:denied");
  },
  180_000,
);

liveTest(
  "control: without the mirror, OPENCODE_CONFIG_DIR hides the user's configuration from 2.x",
  async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode2-usercfg-")));
    const xdg = path.join(root, "xdg");
    const userDir = path.join(xdg, "opencode");
    await mkdir(path.join(userDir, "command"), { recursive: true });
    await writeFile(path.join(userDir, "command", "user-hello.md"), "Say hello.\n");
    await writeFile(
      path.join(userDir, "opencode.json"),
      JSON.stringify({ mcp: { "user-tools": { type: "local", command: ["true"] } } }),
    );
    // The plugin directory alone: the mirror reads an empty HOME, not this XDG_CONFIG_HOME.
    const configDir = await writeOpenCode2HostConfig(path.join(root, "data"), {
      HOME: path.join(root, "home"),
    });
    fixture = await startOpenCode2Fixture(binary!, {
      env: {
        XDG_CONFIG_HOME: xdg,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_FLAGS: OPENCODE2_FLAGS,
      },
    });
    const client = new OpenCode2Client({
      baseUrl: fixture.baseUrl,
      password: fixture.password,
      directory: fixture.directory,
    });
    // Commands and MCP servers load asynchronously, so wait for a project-level
    // command and server (loaded from the same pass) before asserting absence.
    const project = path.join(fixture.directory, ".opencode");
    await mkdir(path.join(project, "command"), { recursive: true });
    await writeFile(path.join(project, "command", "project-hello.md"), "Say hello.\n");
    await writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify({ mcp: { "project-tools": { type: "local", command: ["true"] } } }),
    );
    let listing = "";
    let names: string[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      listing = await commands(fixture);
      names = (await client.listMcpServers()).map((server) => server.name);
      if (listing.includes("project-hello") && names.includes("project-tools")) break;
      await Bun.sleep(100);
    }
    expect(listing).toContain("project-hello");
    expect(names).toContain("project-tools");
    expect(listing).not.toContain("user-hello");
    expect(names).not.toContain("user-tools");
  },
  120_000,
);

/** The location's slash commands, as raw text. */
async function commands(f: OpenCode2Fixture): Promise<string> {
  const response = await fetch(`${f.baseUrl}/api/command`, {
    headers: {
      authorization: `Basic ${btoa(`opencode:${f.password}`)}`,
      "x-opencode-directory": f.directory,
    },
  });
  expect(response.status).toBe(200);
  return response.text();
}
