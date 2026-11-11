import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentSystemInstructions } from "@orkestrator/protocol/agent-system-instructions";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OpenCodeEnvironmentProvider } from "./environment-provider.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * The server Orkestrator starts runs with its file watchers off
 * (`OPENCODE2_DISABLE_FILEWATCHER`, `server.ts`), which the fixture applies
 * too. This qualifies what that launch still has to do against the pinned
 * 2.x binary and a scripted local model (no credentials, no remote calls):
 * a second prompt, the shared instructions reaching the model, a command
 * file added while the server runs, and an MCP settings reload through the
 * environment provider that keeps a session's Orkestrator tools. Run with
 * RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

/** A minimal streamable-HTTP MCP server with one echo tool. */
function startMcpServer() {
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: { value?: string } };
      };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
      if (body.method === "initialize") {
        return reply({
          protocolVersion: body.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
      }
      if (body.method === "tools/list") {
        const schema = { type: "object", properties: { value: { type: "string" } } };
        return reply({
          tools: [{ name: "echo_value", description: "Echo a value", inputSchema: schema }],
        });
      }
      if (body.method === "tools/call") {
        calls.push(String(body.params?.arguments?.value ?? ""));
        return reply({ content: [{ type: "text", text: "accepted" }] });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, calls, stop: () => server.stop(true) };
}

let fixture: OpenCode2Fixture | undefined;
let mcp: ReturnType<typeof startMcpServer> | undefined;
let environment: OpenCodeEnvironmentProvider | undefined;
let refreshes = 0;

beforeAll(async () => {
  if (!live) return;
  mcp = startMcpServer();
  fixture = await startOpenCode2Fixture(binary!);
  const connection = {
    baseUrl: fixture.baseUrl,
    password: fixture.password,
    directory: fixture.directory,
    generation: "live",
    refreshConfiguration: async () => {
      refreshes += 1;
    },
  };
  environment = new OpenCodeEnvironmentProvider({
    connection: async () => connection,
    createProvider: (client: OpenCode2Client) =>
      new OpenCode2Provider(client, { allowedModelProviders: async () => [] }),
  });
}, 60_000);

afterAll(async () => {
  await environment?.dispose();
  await fixture?.stop();
  mcp?.stop();
});

async function settled(id: string, requestId: string, timeoutMs = 30_000) {
  const p = environment!;
  const deadline = Date.now() + timeoutMs;
  while (
    (await p.dispatchStatus(id, requestId)) !== "dispatched" ||
    (await p.activity(id)) !== "idle" ||
    !(await p.settleTurn(id, requestId))
  ) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

/** The model requests made for prompts whose text contains `marker`. */
function requestsFor(marker: string) {
  return fixture!.model.calls.filter((call) => call.userTexts.at(-1)?.includes(marker));
}

liveTest(
  "a second prompt runs and the shared instructions reach the model",
  async () => {
    const p = environment!;
    const id = await p.createSession("build", "watchers off", { model: "fixture/fixture" });
    await p.send(id, "ANSWER_JSON:first", { requestId: "w-1" });
    await settled(id, "w-1");
    await p.send(id, "ANSWER_JSON:second", { requestId: "w-2" });
    await settled(id, "w-2");
    expect(requestsFor("ANSWER_JSON:first").length).toBeGreaterThan(0);
    expect(requestsFor("ANSWER_JSON:second").length).toBeGreaterThan(0);

    // The durable instruction entry (`instructions.ts`) is in the model's system prompt.
    const instructions = agentSystemInstructions();
    expect(instructions).toBeTruthy();
    const excerpt = instructions!
      .split("\n")
      .find((line) => line.trim().length > 30)!
      .trim();
    const system = requestsFor("ANSWER_JSON:second").at(-1)!.systemTexts.join("\n");
    expect(system).toContain(excerpt);
  },
  90_000,
);

liveTest(
  "a command file added while the server runs is listed after an explicit refresh",
  async () => {
    const p = environment!;
    // A tab's session loads the location before its composer lists commands.
    await p.createSession("build", "commands", { model: "fixture/fixture" });
    const listed = async () => (await p.commandCatalogue()).commands.map((row) => row.name);
    await p.refreshCommands();
    // Catalogue rows are named as typed, with the slash.
    expect(await listed()).toContain("/review");

    const name = `watchers-off-probe-${Date.now()}`;
    const directory = join(fixture!.directory, ".opencode", "command");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${name}.md`),
      "---\ndescription: Added while the server runs\n---\nSay hello.\n",
    );
    // With watchers off the running location does not see it on its own: a
    // bare re-read of the list (what a refresh used to do) misses it.
    const client = new OpenCode2Client({
      baseUrl: fixture!.baseUrl,
      password: fixture!.password,
      directory: fixture!.directory,
    });
    const raw = await client.api<Array<{ name: string }>>("GET", "/api/command", "list", {});
    expect(raw.map((row) => row.name)).not.toContain(name);

    // The explicit refresh reloads the idle location, and the read after it
    // sees the rebuilt one rather than the empty list a mid-rebuild read gets.
    expect(await p.refreshCommands()).toEqual({ outcome: "reloaded" });
    const after = await listed();
    expect(after).toContain(`/${name}`);
    expect(after).toContain("/review");
  },
  60_000,
);

liveTest(
  "an MCP settings reload rebuilds the location and the session keeps its Orkestrator tools",
  async () => {
    const p = environment!;
    const id = await p.createSession("build", "reload", { model: "fixture/fixture" });
    const agentMcp = { url: mcp!.url, token: "token-reload" };
    const tool = (await import("./permissions.js")).openCode2TabMcpServer(id) + "_echo_value";

    await p.send(id, `RUN_TOOL:${tool} {"value":"before"}`, { requestId: "r-1", agentMcp });
    await settled(id, "r-1");
    expect(mcp!.calls).toContain("before");

    const before = refreshes;
    expect(await p.reloadMcpConfiguration()).toBe("reloaded");
    expect(refreshes).toBe(before + 1);

    await p.send(id, `RUN_TOOL:${tool} {"value":"after"}`, { requestId: "r-2", agentMcp });
    await settled(id, "r-2");
    expect(mcp!.calls).toContain("after");
    const offered = requestsFor('{"value":"after"}').at(0)!.tools;
    expect(offered).toContain(tool);
  },
  90_000,
);
