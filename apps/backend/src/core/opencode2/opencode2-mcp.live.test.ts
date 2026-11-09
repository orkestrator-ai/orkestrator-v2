import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { resolveNativeAgentExecutionPolicy } from "../native-agent-execution-policy.js";
import { OpenCode2Client } from "./client.js";
import { openCode2TabMcpServer } from "./permissions.js";
import { OpenCode2Provider } from "./provider.js";

/**
 * Orkestrator's MCP connections, workflow results, structured output and
 * read-only turns against a real pinned 2.x server and a scripted local model
 * (no credentials, no remote calls). The MCP routes are experimental upstream;
 * this file is what guards them on every pin bump. Run with
 * RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH set to the 2.x binary.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const live = process.env.RUN_LIVE_OPENCODE2 === "1" && !!binary;
const liveTest = live ? test : test.skip;

type ToolCall = { token: string | null; name: string; args: Record<string, unknown> };

/** A minimal streamable-HTTP MCP server: one echo tool and one result tool. */
function startMcpServer() {
  const calls: ToolCall[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = (await request.json()) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
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
          tools: [
            { name: "echo_value", description: "Echo a value", inputSchema: schema },
            { name: "submit_review_report", description: "Submit", inputSchema: schema },
            { name: "submit_fix_result", description: "Submit", inputSchema: schema },
          ],
        });
      }
      if (body.method === "tools/call") {
        const token = request.headers.get("authorization");
        calls.push({ token, name: body.params!.name!, args: body.params!.arguments ?? {} });
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

beforeAll(async () => {
  if (!live) return;
  mcp = startMcpServer();
  fixture = await startOpenCode2Fixture(binary!);
  client = new OpenCode2Client({
    baseUrl: fixture.baseUrl,
    password: fixture.password,
    directory: fixture.directory,
  });
  provider = new OpenCode2Provider(client);
}, 60_000);

afterAll(async () => {
  await provider?.dispose();
  await fixture?.stop();
  mcp?.stop();
});

/** Wait for the request's run to end (its input is in history and an idle row follows it). */
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

/** The tool result the model was handed after its call in this turn. */
function lastToolResult(): string {
  return fixture!.model.calls.findLast((call) => call.toolResult !== undefined)?.toolResult ?? "";
}

const POLICY = () =>
  resolveNativeAgentExecutionPolicy(
    { environmentType: "local", networkAccessMode: "full" },
    "automated-review",
  );

liveTest(
  "a tab's MCP server is callable by its own session only",
  async () => {
    const p = provider!;
    const a = await p.createSession("build", "tab a", { model: "fixture/fixture" });
    const b = await p.createSession("build", "tab b", { model: "fixture/fixture" });
    const toolA = `${openCode2TabMcpServer(a)}_echo_value`;
    const toolB = `${openCode2TabMcpServer(b)}_echo_value`;

    await p.send(a, `RUN_TOOL:${toolA} {"value":"from-a"}`, {
      requestId: "tab-a-1",
      agentMcp: { url: mcp!.url, token: "token-a" },
    });
    await settled(a, "tab-a-1");
    expect(mcp!.calls.at(-1)).toEqual({
      token: "Bearer token-a",
      name: "echo_value",
      args: { value: "from-a" },
    });
    expect(lastToolResult()).toContain("accepted:echo_value");

    // B has its own server; A's tools are neither offered to B nor callable by it.
    const before = mcp!.calls.length;
    await p.send(b, `RUN_TOOL:${toolA} {"value":"from-b"}`, {
      requestId: "tab-b-1",
      agentMcp: { url: mcp!.url, token: "token-b" },
    });
    await settled(b, "tab-b-1");
    const offered = fixture!.model.calls.findLast((call) => call.lastRole === "user")!.tools;
    expect(offered).toContain(toolB);
    expect(offered).not.toContain(toolA);
    expect(mcp!.calls.length).toBe(before);
    expect(lastToolResult()).toContain("No tool named");

    // Nor through a sub-agent: a child session starts with its parent's rules.
    const inner = `RUN_TOOL:${toolA} {"value":"child"}`;
    const subagent = JSON.stringify({ agent: "general", description: "probe", prompt: inner });
    await p.send(b, `RUN_TOOL:subagent ${subagent}`, {
      requestId: "tab-b-2",
      agentMcp: { url: mcp!.url, token: "token-b" },
    });
    await settled(b, "tab-b-2");
    const child = fixture!.model.calls.findLast(
      (call) => call.toolResult !== undefined && call.userTexts.at(-1)?.includes(inner),
    );
    expect(child?.toolResult).toContain("No tool named");
    expect(mcp!.calls.length).toBe(before);

    // Closing a tab removes its server from the 2.x server.
    await p.closeSession(a);
    expect((await client!.listMcpServers()).map((server) => server.name)).not.toContain(
      openCode2TabMcpServer(a),
    );
  },
  120_000,
);

liveTest(
  "a workflow-result turn submits through its own tool, which is gone after the turn",
  async () => {
    const p = provider!;
    const id = await p.createSession("review", "reviewer", {
      model: "fixture/fixture",
      policy: POLICY(),
      reviewerSession: true,
    });
    const broker = { url: mcp!.url, token: "broker-token", workflowResultCapability: "cap-1" };
    const tool = "orkestrator_workflow_result_submit_review_report";
    await p.prepareDispatch(id, { agentMcp: broker, workflowResultTool: "submit_review_report" });
    await p.send(id, `RUN_TOOL:${tool} {"value":"verdict"}`, {
      requestId: "wr-1",
      readOnly: true,
      agentMcp: broker,
      workflowResultTool: "submit_review_report",
    });
    await settled(id, "wr-1");
    expect(mcp!.calls.at(-1)).toEqual({
      token: "Bearer broker-token",
      name: "submit_review_report",
      args: { value: "verdict" },
    });
    // Another kind's tool was never offered on that turn.
    const offered = fixture!.model.calls.findLast((call) => call.lastRole === "user")!.tools;
    expect(offered).toContain(tool);
    expect(offered).not.toContain("orkestrator_workflow_result_submit_fix_result");

    // After the turn the grant is restored: the same call is refused.
    const before = mcp!.calls.length;
    await p.send(id, `RUN_TOOL:${tool} {"value":"late"}`, { requestId: "wr-2" });
    await settled(id, "wr-2");
    expect(mcp!.calls.length).toBe(before);
    expect(lastToolResult()).toContain("No tool named");
  },
  120_000,
);

liveTest(
  "a structured-output turn returns its parsed result",
  async () => {
    const p = provider!;
    const id = await p.createSession("plan", "plan", { model: "fixture/fixture" });
    await p.send(id, 'Plan it.\nANSWER_JSON:{"steps":3,"ok":true}', {
      requestId: "so-1",
      schema: { type: "object" },
    });
    await settled(id, "so-1");
    const deadline = Date.now() + 30_000;
    let result = await p.structured(id, "so-1");
    while (!result && Date.now() < deadline) {
      await Bun.sleep(150);
      result = await p.structured(id, "so-1");
    }
    expect(result).toEqual({
      ok: true,
      provider: "opencode",
      requestId: "so-1",
      value: { steps: 3, ok: true },
    });
  },
  120_000,
);

liveTest(
  "a read-only turn is refused a write and a mutating command; the next turn may write",
  async () => {
    const p = provider!;
    const id = await p.createSession("review", "ro", { model: "fixture/fixture" });
    const written = join(fixture!.directory, "read-only-write.txt");
    const touched = join(fixture!.directory, "read-only-touch.txt");

    await p.send(id, `RUN_TOOL:write {"path":${JSON.stringify(written)},"content":"x"}`, {
      requestId: "ro-1",
      readOnly: true,
    });
    await settled(id, "ro-1");
    expect(existsSync(written)).toBe(false);
    expect(lastToolResult()).toContain("No tool named");

    await p.send(id, `RUN_BASH:touch ${touched}`, { requestId: "ro-2", readOnly: true });
    await settled(id, "ro-2");
    expect(existsSync(touched)).toBe(false);
    expect(lastToolResult()).toContain("No tool named");

    // The grant was restored: an ordinary turn writes.
    await p.send(id, `RUN_TOOL:write {"path":${JSON.stringify(written)},"content":"x"}`, {
      requestId: "rw-1",
    });
    await settled(id, "rw-1");
    expect(existsSync(written)).toBe(true);
  },
  120_000,
);
