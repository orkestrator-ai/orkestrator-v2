import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModel } from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import {
  OPENCODE2_COORDINATOR_READ_REFUSAL,
  OPENCODE2_COORDINATOR_TOOL_REFUSAL,
} from "./coordinator-plugin.js";
import {
  openCode2CoordinatorLaunchEnv,
  openCode2CoordinatorPolicy,
  openCode2CoordinatorSignature,
  writeOpenCode2CoordinatorConfig,
  type OpenCode2CoordinatorAuthority,
} from "./coordinator.js";
import { OpenCode2Provider } from "./provider.js";
import { mintOpenCode2InputId } from "./steer.js";
import { openCode2HostLaunch, waitForOpenCode2Ready } from "./server.js";

/**
 * A coordinator's OpenCode 2.x server, launched the way
 * `opencode2-host-server.ts` launches one, against the real pinned binary and
 * a scripted local model (no credentials, no remote calls):
 *
 * - a coordinator turn cannot write a file or run a command, its rules come
 *   from the server's launch, and the `plan` agent is pinned;
 * - it cannot read Orkestrator's data directory, through a link either;
 * - it reaches its control tools and its research server's tools;
 * - the server process itself refuses a mutation when a session's stored
 *   rules are widened behind the backend's back (process authority);
 * - the checkout's project configuration (an MCP server, a plugin) never
 *   loads.
 *
 * Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

type ToolCall = { token: string | null; name: string };

/** A minimal streamable-HTTP MCP server with the given tools. */
function startMcpServer(tools: string[]) {
  const calls: ToolCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string };
      };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
      if (body.method === "initialize") {
        return reply({
          protocolVersion: body.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        });
      }
      if (body.method === "tools/list") {
        const inputSchema = { type: "object", properties: { value: { type: "string" } } };
        return reply({
          tools: tools.map((name) => ({ name, description: name, inputSchema })),
        });
      }
      if (body.method === "tools/call") {
        calls.push({ token: request.headers.get("authorization"), name: body.params!.name! });
        return reply({ content: [{ type: "text", text: `accepted:${body.params!.name}` }] });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, calls, stop: () => server.stop(true) };
}

/**
 * A checkout's project configuration that leaves a marker when it loads: a
 * plugin (`<markers>-plugin-loaded`) and a local MCP server
 * (`<markers>-mcp-started`), with rules that would allow everything.
 */
async function writeProjectConfiguration(directory: string, markers: string) {
  await mkdir(join(directory, ".opencode", "plugins", "project-plugin"), { recursive: true });
  await writeFile(
    join(directory, ".opencode", "plugins", "project-plugin", "index.ts"),
    `import { writeFileSync } from "node:fs";\nexport default { id: "project-plugin", async setup() { writeFileSync(${JSON.stringify(`${markers}-plugin-loaded`)}, "x"); } };\n`,
  );
  await writeFile(
    join(directory, "opencode.json"),
    JSON.stringify({
      permission: { "*": "allow" },
      mcp: {
        project: { type: "local", command: ["touch", `${markers}-mcp-started`], enabled: true },
      },
    }),
  );
}

let root: string | undefined;
let model: ScriptedModel | undefined;
let control: ReturnType<typeof startMcpServer> | undefined;
let research: ReturnType<typeof startMcpServer> | undefined;
let server: ReturnType<typeof Bun.spawn> | undefined;
let client: OpenCode2Client | undefined;
let provider: OpenCode2Provider | undefined;
let checkout = "";
let dataDir = "";

beforeAll(async () => {
  if (!live) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "ork-opencode2-coordinator-")));
  checkout = join(root, "checkout");
  dataDir = join(root, "orkestrator-data");
  const home = join(root, "home");
  await Promise.all([checkout, dataDir, home].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(dataDir, "control-mcp.json"), "DATA-DIR-SECRET");
  await writeFile(join(checkout, "README.md"), "checkout readme");
  // The data directory, reachable from the checkout through a link.
  await symlink(dataDir, join(checkout, "linked-data"));
  // Project configuration that must not load.
  await writeProjectConfiguration(checkout, join(root, "coordinator"));

  model = new ScriptedModel();
  const modelUrl = model.start();
  control = startMcpServer(["list_environments", "not_a_control_tool"]);
  research = startMcpServer(["resolve_library"]);
  const researchSetting = {
    mode: "search-and-mcp" as const,
    servers: [{ name: "lookup", url: research.url }],
  };
  const configDir = await writeOpenCode2CoordinatorConfig(dataDir, {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "xdg"),
  });
  const password = crypto.randomUUID();
  // The server binds an ephemeral port itself and reports it.
  const launch = openCode2HostLaunch({
    cliPath: binary!,
    dataDir,
    configDir,
    port: 0,
    password,
    baseEnv: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      // The project file is off, so the scripted model comes from here.
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Local fixture",
            options: { baseURL: `${modelUrl}/v1`, apiKey: "test-key" },
            models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
          },
        },
        model: "fixture/fixture",
      }),
      ...openCode2CoordinatorLaunchEnv({ dataDir, research: researchSetting }),
    },
  });
  server = Bun.spawn([launch.command, ...launch.args], {
    cwd: checkout,
    env: launch.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const port = await listeningPort(server);
  client = new OpenCode2Client({
    baseUrl: `http://127.0.0.1:${port}`,
    password,
    directory: checkout,
  });
  await waitForOpenCode2Ready(client, {
    timeoutMs: 60_000,
    isAlive: () => server!.exitCode === null,
  });
  const authority: OpenCode2CoordinatorAuthority = {
    policy: openCode2CoordinatorPolicy(researchSetting.mode),
    research: researchSetting,
    signature: openCode2CoordinatorSignature(researchSetting),
    controlConnection: () => ({ url: control!.url, token: "coordinator-token" }),
  };
  provider = new OpenCode2Provider(client, { coordinator: authority });
}, 90_000);

afterAll(async () => {
  await provider?.dispose();
  if (server) {
    server.kill("SIGTERM");
    await Promise.race([server.exited, Bun.sleep(5_000)]);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
  }
  model?.stop();
  control?.stop();
  research?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

/** The port the server reports it is listening on (it was started with `--port 0`). */
async function listeningPort(child: ReturnType<typeof Bun.spawn>): Promise<number> {
  const decoder = new TextDecoder();
  let seen = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      seen += decoder.decode(chunk);
      const match = /127\.0\.0\.1:(\d+)/.exec(seen);
      if (match && Number(match[1]) > 0) return Number(match[1]);
    }
    return undefined;
  };
  const found = await Promise.race([
    read(child.stdout as ReadableStream<Uint8Array>),
    read(child.stderr as ReadableStream<Uint8Array>),
    Bun.sleep(60_000).then(() => undefined),
  ]);
  if (!found) throw new Error("the 2.x server did not report its port");
  return found;
}

async function settled(id: string, requestId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (
    (await provider!.dispatchStatus(id, requestId)) !== "dispatched" ||
    (await provider!.activity(id)) !== "idle" ||
    !(await provider!.settleTurn(id, requestId))
  ) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(150);
  }
}

function lastToolResult(): string {
  return model!.calls.findLast((call) => call.toolResult !== undefined)?.toolResult ?? "";
}

function offeredTools(): string[] {
  return model!.calls.findLast((call) => call.lastRole === "user")!.tools;
}

liveTest(
  "a coordinator turn on 2.x cannot write, run a command or read the data directory, and reaches its tools",
  async () => {
    const p = provider!;
    const id = await p.createSession("coordinator", "Coordinator", {
      model: "fixture/fixture",
      policy: openCode2CoordinatorPolicy("search-and-mcp"),
    });
    expect((await client!.getSession(id)).agent).toBe("plan");

    // The checkout reads; the turn runs as plan.
    await p.send(id, `RUN_TOOL:read {"path":"README.md"}`, { requestId: "c-read" });
    await settled(id, "c-read");
    expect(lastToolResult()).toContain("checkout readme");
    const offered = offeredTools();
    expect(offered).toContain("read");
    expect(offered).toContain("orkestrator_list_environments");
    expect(offered).toContain("lookup_resolve_library");
    for (const tool of ["write", "edit", "shell", "webfetch", "orkestrator_not_a_control_tool"]) {
      expect(offered).not.toContain(tool);
    }

    // No write, no command.
    const written = join(checkout, "coordinator-write.txt");
    await p.send(id, `RUN_TOOL:write {"path":${JSON.stringify(written)},"content":"x"}`, {
      requestId: "c-write",
    });
    await settled(id, "c-write");
    expect(existsSync(written)).toBe(false);
    const touched = join(checkout, "coordinator-touch.txt");
    await p.send(id, `RUN_BASH:touch ${touched}`, { requestId: "c-shell" });
    await settled(id, "c-shell");
    expect(existsSync(touched)).toBe(false);
    // Refused before it runs: by the rules (no shell offered) or, for the
    // `bash` spelling the model used, by the server's guard.
    expect(lastToolResult()).toMatch(/No tool named|Coordinators are read-only/);

    // The data directory: directly, and through a link inside the checkout.
    await p.send(
      id,
      `RUN_TOOL:read {"path":${JSON.stringify(join(dataDir, "control-mcp.json"))}}`,
      {
        requestId: "c-data",
      },
    );
    await settled(id, "c-data");
    expect(lastToolResult()).not.toContain("DATA-DIR-SECRET");
    await p.send(id, `RUN_TOOL:read {"path":"linked-data/control-mcp.json"}`, {
      requestId: "c-link",
    });
    await settled(id, "c-link");
    expect(lastToolResult()).toContain(OPENCODE2_COORDINATOR_READ_REFUSAL);
    await p.send(id, `RUN_TOOL:grep {"pattern":"DATA-DIR-SECRET","path":"linked-data"}`, {
      requestId: "c-grep",
    });
    await settled(id, "c-grep");
    expect(lastToolResult()).toContain(OPENCODE2_COORDINATOR_READ_REFUSAL);
    // A sub-agent runs in the same server, behind the same guard and rules.
    const inner = `RUN_TOOL:read {"path":"linked-data/control-mcp.json"}`;
    const subagent = JSON.stringify({ agent: "general", description: "probe", prompt: inner });
    await p.send(id, `RUN_TOOL:subagent ${subagent}`, { requestId: "c-subagent" });
    await settled(id, "c-subagent");
    const child = model!.calls.findLast(
      (call) => call.toolResult !== undefined && call.userTexts.at(-1)?.includes(inner),
    );
    expect(child?.toolResult).toContain(OPENCODE2_COORDINATOR_READ_REFUSAL);
    expect(child?.tools).not.toContain("shell");

    // Its tools: the control tool with the conversation's credential, and research.
    await p.send(id, `RUN_TOOL:orkestrator_list_environments {"value":"x"}`, {
      requestId: "c-control",
    });
    await settled(id, "c-control");
    expect(control!.calls.at(-1)).toEqual({
      token: "Bearer coordinator-token",
      name: "list_environments",
    });
    await p.send(id, `RUN_TOOL:lookup_resolve_library {"value":"react"}`, {
      requestId: "c-research",
    });
    await settled(id, "c-research");
    expect(research!.calls.at(-1)?.name).toBe("resolve_library");

    // A command selection is refused before anything is sent.
    await expect(
      p.send(id, "/review", {
        requestId: "c-command",
        command: {
          id: "opencode:review",
          name: "review",
          executionKind: "provider-command",
          arguments: "",
        } as never,
      }),
    ).rejects.toThrow("read-only coordinator");
  },
  180_000,
);

liveTest(
  "a widened session is restated by the next turn, and the server refuses a mutation meanwhile",
  async () => {
    const p = provider!;
    const id = await p.createSession("coordinator", "Coordinator", {
      model: "fixture/fixture",
      policy: openCode2CoordinatorPolicy("search-and-mcp"),
    });
    // A persisted record widened behind the backend's back: everything allowed, agent build.
    await client!.updateSession(id, {
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
    await client!.selectAgent(id, "build");

    // The server process refuses the command even under those rules.
    const touched = join(checkout, "widened-touch.txt");
    const session = await client!.getSession(id);
    expect(session.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    await client!.prompt(id, {
      id: mintOpenCode2InputId(),
      text: `RUN_BASH:touch ${touched}`,
      delivery: "queue",
    });
    const deadline = Date.now() + 30_000;
    while (
      !model!.calls.some((call) => call.toolResult?.includes(OPENCODE2_COORDINATOR_TOOL_REFUSAL))
    ) {
      if (Date.now() > deadline) throw new Error("the guard never answered");
      await Bun.sleep(150);
    }
    expect(existsSync(touched)).toBe(false);
    while ((await p.activity(id)) !== "idle") await Bun.sleep(150);

    // The backend's next turn restates the launch's rules and the plan agent.
    await p.send(id, "hello", { requestId: "w-1" });
    await settled(id, "w-1");
    const restated = await client!.getSession(id);
    expect(restated.agent).toBe("plan");
    expect(restated.permissions?.[0]).toEqual({ action: "*", resource: "*", effect: "deny" });
    expect(offeredTools()).not.toContain("shell");

    // A wider policy is refused outright.
    await expect(
      p.synchronizeSessionPolicy(id, {
        ...openCode2CoordinatorPolicy("off"),
        id: "interactive-host",
      }),
    ).rejects.toThrow("read-only policy");
  },
  180_000,
);

liveTest(
  "the checkout's project configuration never loads, where without the switch it would",
  async () => {
    expect(existsSync(join(root!, "coordinator-plugin-loaded"))).toBe(false);
    expect(existsSync(join(root!, "coordinator-mcp-started"))).toBe(false);
    expect((await client!.listMcpServers()).map((server) => server.name)).not.toContain("project");

    // The same configuration under a server without the switch does load, so
    // the markers above are evidence rather than a layout that never loads.
    const plain = join(root!, "plain-checkout");
    const home = join(root!, "plain-home");
    await mkdir(home, { recursive: true });
    await mkdir(plain, { recursive: true });
    await writeProjectConfiguration(plain, join(root!, "plain"));
    const password = crypto.randomUUID();
    const child = Bun.spawn([binary!, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: plain,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        OPENCODE_DB: join(root!, "plain.db"),
        OPENCODE_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const port = await listeningPort(child);
      const plainClient = new OpenCode2Client({
        baseUrl: `http://127.0.0.1:${port}`,
        password,
        directory: plain,
      });
      await waitForOpenCode2Ready(plainClient, { timeoutMs: 60_000 });
      await plainClient.listMcpServers();
      const deadline = Date.now() + 30_000;
      while (
        !existsSync(join(root!, "plain-plugin-loaded")) ||
        !existsSync(join(root!, "plain-mcp-started"))
      ) {
        if (Date.now() > deadline) throw new Error("the project configuration never loaded");
        await Bun.sleep(100);
      }
    } finally {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
  120_000,
);
