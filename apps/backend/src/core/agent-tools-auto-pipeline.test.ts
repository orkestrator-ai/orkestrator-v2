import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTO_PIPELINE_TOOL_NAME } from "@orkestrator/protocol/build-pipeline";
import { ACCEPTANCE_CRITERIA_RULE } from "@orkestrator/protocol/ticket-sections";
import { AgentToolsServer } from "./agent-tools.js";
import type { AutoPipelineToolHost, AutoPipelineToolScope } from "./agent-tools-auto-pipeline.js";
import { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

type RpcBody = {
  result?: {
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    structuredContent?: Record<string, unknown>;
  };
};

async function rpc(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcBody> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return payload ? (JSON.parse(payload) as RpcBody) : {};
}

const draft = {
  title: "Finished feature",
  description: "Summary: done.\nProblem: missing.\nContext: fixture.",
  acceptanceCriteria: ["It works"],
  notes: { summary: "Did it", workDone: [], decisions: [], tests: [], notDone: [] },
};

describe("convert_to_pipeline on the Orkestrator MCP server", () => {
  let dataDir: string;
  let storage: StorageService;
  let workflowResults: WorkflowResultService;
  let server: AgentToolsServer;
  let offered: boolean;
  let submitted: Array<{ scope: AutoPipelineToolScope; result: unknown }>;
  let failWith: Error | null;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-auto-pipeline-tool-"));
    storage = new StorageService(dataDir);
    await storage.init();
    workflowResults = new WorkflowResultService(dataDir);
    server = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
    offered = true;
    submitted = [];
    failWith = null;
    const host: AutoPipelineToolHost = {
      offered: async () => offered,
      submit: async (scope, result) => {
        if (failWith) throw failWith;
        submitted.push({ scope, result });
        return { draftId: "draft-1" };
      },
    };
    server.setAutoPipelineToolHost(host);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    workflowResults.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  const tabConnection = () => server.connection("env-1", "project-1", "host", "tab-1");
  const toolNames = (body: RpcBody) => body.result?.tools?.map((tool) => tool.name) ?? [];

  test("is listed to a tab's own credential while the tab is offered it", async () => {
    const tab = tabConnection();
    const listed = await rpc(tab.url, tab.token, "tools/list");
    expect(toolNames(listed)).toContain(AUTO_PIPELINE_TOOL_NAME);
    const tool = listed.result?.tools?.find((tool) => tool.name === AUTO_PIPELINE_TOOL_NAME);
    expect(tool?.description).toContain(ACCEPTANCE_CRITERIA_RULE);
    const schema = tool?.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["title", "description", "acceptanceCriteria", "notes"]);

    offered = false;
    expect(toolNames(await rpc(tab.url, tab.token, "tools/list"))).not.toContain(
      AUTO_PIPELINE_TOOL_NAME,
    );
  });

  test("is not listed to an environment-wide credential, which names no tab", async () => {
    const environment = server.connection("env-1", "project-1", "host");
    expect(toolNames(await rpc(environment.url, environment.token, "tools/list"))).not.toContain(
      AUTO_PIPELINE_TOOL_NAME,
    );
  });

  test("hands the draft to the calling tab's own scope", async () => {
    const tab = tabConnection();
    const called = await rpc(tab.url, tab.token, "tools/call", {
      name: AUTO_PIPELINE_TOOL_NAME,
      arguments: draft,
    });
    expect(called.result?.structuredContent).toMatchObject({ ok: true, draftId: "draft-1" });
    expect(submitted).toEqual([
      { scope: { environmentId: "env-1", tabId: "tab-1" }, result: draft },
    ]);
  });

  test("tells the agent why a draft was refused, so it can correct it", async () => {
    const tab = tabConnection();
    failWith = new Error("Ticket description requires a nonempty Problem section");
    const called = await rpc(tab.url, tab.token, "tools/call", {
      name: AUTO_PIPELINE_TOOL_NAME,
      arguments: draft,
    });
    expect(called.result?.structuredContent).toEqual({
      ok: false,
      message: "Ticket description requires a nonempty Problem section",
    });
  });

  test("refuses a draft that does not match the published schema before the host sees it", async () => {
    const tab = tabConnection();
    const called = await rpc(tab.url, tab.token, "tools/call", {
      name: AUTO_PIPELINE_TOOL_NAME,
      arguments: { ...draft, acceptanceCriteria: [] },
    });
    expect(called.result?.structuredContent?.ok).not.toBe(true);
    expect(submitted).toHaveLength(0);
  });
});
