import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";
import { OpenCode2Client } from "./client.js";
import {
  OPENCODE2_ARTIFACTS_MCP_PREFIX,
  OPENCODE2_DESIGN_MCP_PREFIX,
  openCode2SessionMcpServer,
  openCode2TabMcpServer,
} from "./permissions.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * The per-turn Orkestrator connections 1.x carried as `system` text, on a real
 * pinned 2.x server with a scripted local model (`turn-connections.ts`): the
 * design server, a result turn's artifact grant and a pipeline worker's own
 * mailbox. Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x
 * binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

type ToolCall = { path: string; token: string | null; name: string };

/**
 * A minimal streamable-HTTP MCP server answering on every path the agent
 * tools server serves (`/mcp`, `/design-mcp`, `/artifact-mcp`), recording
 * which path and credential each call used.
 */
function startMcpServer() {
  const calls: ToolCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string };
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
        const tools =
          path === "/mcp"
            ? ["echo_value", "submit_review_report"]
            : path === "/design-mcp"
              ? ["draw_value"]
              : ["create_artifact"];
        return reply({
          tools: tools.map((name) => ({ name, description: name, inputSchema: schema })),
        });
      }
      if (body.method === "tools/call") {
        calls.push({ path, token: request.headers.get("authorization"), name: body.params!.name! });
        return reply({ content: [{ type: "text", text: `accepted:${body.params!.name}` }] });
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/mcp`, calls, stop: () => server.stop(true) };
}

let fixture: OpenCode2Fixture | undefined;
let mcp: ReturnType<typeof startMcpServer> | undefined;
let provider: OpenCode2Provider | undefined;
let client: OpenCode2Client | undefined;
const mailboxRequests: unknown[] = [];

beforeAll(async () => {
  if (!live) return;
  mcp = startMcpServer();
  fixture = await startOpenCode2Fixture(binary!);
  client = new OpenCode2Client({
    baseUrl: fixture.baseUrl,
    password: fixture.password,
    directory: fixture.directory,
  });
  provider = new OpenCode2Provider(client, {
    workerMailbox: async (mail) => {
      mailboxRequests.push(mail);
      return { url: mcp!.url, token: "worker-token" };
    },
  });
}, 60_000);

afterAll(async () => {
  await provider?.dispose();
  await fixture?.stop();
  mcp?.stop();
});

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
  return fixture!.model.calls.findLast((call) => call.toolResult !== undefined)?.toolResult ?? "";
}

function offeredTools(): string[] {
  return fixture!.model.calls.findLast((call) => call.lastRole === "user")!.tools;
}

const POLICY = () =>
  resolveNativeAgentExecutionPolicy(
    { environmentType: "local", networkAccessMode: "full" },
    "automated-review",
  );

liveTest(
  "a tab with design canvases reaches its own design server with its own credential",
  async () => {
    const p = provider!;
    const a = await p.createSession("build", "design a", { model: "fixture/fixture" });
    const b = await p.createSession("build", "design b", { model: "fixture/fixture" });
    const toolA = `${openCode2SessionMcpServer(OPENCODE2_DESIGN_MCP_PREFIX, a)}_draw_value`;

    await p.send(a, `RUN_TOOL:${toolA} {"value":"x"}`, {
      requestId: "design-a-1",
      agentMcp: { url: mcp!.url, token: "tab-a", design: true },
    });
    await settled(a, "design-a-1");
    expect(mcp!.calls.at(-1)).toEqual({
      path: "/design-mcp",
      token: "Bearer tab-a",
      name: "draw_value",
    });

    const before = mcp!.calls.length;
    await p.send(b, `RUN_TOOL:${toolA} {"value":"y"}`, {
      requestId: "design-b-1",
      agentMcp: { url: mcp!.url, token: "tab-b", design: true },
    });
    await settled(b, "design-b-1");
    expect(offeredTools()).not.toContain(toolA);
    expect(lastToolResult()).toContain("No tool named");
    expect(mcp!.calls.length).toBe(before);
  },
  120_000,
);

liveTest(
  "a result turn's artifact grant is its own server for that turn; the next turn has none",
  async () => {
    const p = provider!;
    const id = await p.createSession("review", "reviewer", {
      model: "fixture/fixture",
      policy: POLICY(),
      reviewerSession: true,
    });
    const other = await p.createSession("review", "other", {
      model: "fixture/fixture",
      policy: POLICY(),
    });
    const broker = { url: mcp!.url, token: "broker-token", workflowResultCapability: "cap-1" };
    const tool = `${openCode2SessionMcpServer(OPENCODE2_ARTIFACTS_MCP_PREFIX, id)}_create_artifact`;
    await p.send(id, `RUN_TOOL:${tool} {"value":"report"}`, {
      requestId: "art-1",
      readOnly: true,
      agentMcp: broker,
      workflowResultTool: "submit_review_report",
      artifactGrant: "grant-token-1",
    });
    await settled(id, "art-1");
    expect(mcp!.calls.at(-1)).toEqual({
      path: "/artifact-mcp",
      token: "Bearer grant-token-1",
      name: "create_artifact",
    });
    expect(offeredTools()).toContain("orkestrator_workflow_result_submit_review_report");
    // The grant never reached the model as text.
    expect(JSON.stringify(fixture!.model.calls.at(-1)?.userTexts ?? [])).not.toContain(
      "grant-token-1",
    );

    // Another session cannot use it.
    let before = mcp!.calls.length;
    await p.send(other, `RUN_TOOL:${tool} {"value":"steal"}`, { requestId: "art-other" });
    await settled(other, "art-other");
    expect(offeredTools()).not.toContain(tool);
    expect(mcp!.calls.length).toBe(before);

    // A later turn without a grant does not keep the old one.
    before = mcp!.calls.length;
    await p.send(id, `RUN_TOOL:${tool} {"value":"late"}`, { requestId: "art-2" });
    await settled(id, "art-2");
    expect(offeredTools()).not.toContain(tool);
    expect(mcp!.calls.length).toBe(before);
    expect((await client!.listMcpServers()).map((server) => server.name)).not.toContain(
      openCode2SessionMcpServer(OPENCODE2_ARTIFACTS_MCP_PREFIX, id),
    );
  },
  120_000,
);

liveTest(
  "a pipeline worker turn connects as its own mailbox",
  async () => {
    const p = provider!;
    const id = await p.createSession("build", "stage", { model: "fixture/fixture" });
    const mail = {
      environmentId: "env",
      tabId: "pipeline-worker:stage-1",
      capability: "wm.capability-not-sent",
    };
    const tool = `${openCode2TabMcpServer(id)}_echo_value`;
    await p.send(id, `RUN_TOOL:${tool} {"value":"hello"}`, {
      requestId: "worker-1",
      workerMail: mail,
      artifactGrant: "grant-worker",
    });
    await settled(id, "worker-1");
    expect(mailboxRequests).toEqual([mail]);
    expect(mcp!.calls.at(-1)).toEqual({
      path: "/mcp",
      token: "Bearer worker-token",
      name: "echo_value",
    });
    // The worker's connection carries artifacts itself; no grant server, no capability as text.
    expect(offeredTools()).not.toContain(
      `${openCode2SessionMcpServer(OPENCODE2_ARTIFACTS_MCP_PREFIX, id)}_create_artifact`,
    );
    const texts = JSON.stringify(fixture!.model.calls.map((call) => call.userTexts));
    expect(texts).not.toContain("wm.capability-not-sent");
    expect(texts).not.toContain("grant-worker");
  },
  120_000,
);
