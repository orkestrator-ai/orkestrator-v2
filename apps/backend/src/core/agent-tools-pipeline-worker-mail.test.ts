/**
 * A build pipeline worker's tool-mode turn connects with its workflow-result
 * capability alone; that server also carries the worker's own mail tools,
 * bound to the mailbox the backend's record says owns the attempt.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { BUILD_PIPELINE_VERSION } from "@orkestrator/protocol/build-pipeline";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { AgentToolsServer } from "./agent-tools.js";
import { fixture } from "./agent-mail-storage-test-support.js";
import {
  PIPELINE_ID,
  pipelineSnapshot,
  stageSession,
} from "./pipeline-worker-mail-test-support.js";
import type { StorageService } from "./storage.js";
import { WorkflowResultService } from "./workflow-result-service.js";

type RpcBody = {
  result?: {
    tools?: Array<{ name: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    content?: Array<{ text?: string }>;
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

describe("a pipeline worker's mail tools on its workflow-result server", () => {
  let dataDir: string;
  let storage: StorageService;
  let workflowResults: WorkflowResultService;
  let server: AgentToolsServer;

  beforeEach(async () => {
    ({ storage, dataDir } = await fixture());
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      agentMessaging: { ...config.global.agentMessaging!, enabled: true },
    });
    workflowResults = new WorkflowResultService(dataDir);
    server = new AgentToolsServer(storage, "127.0.0.1", workflowResults);
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    workflowResults.closeStorage();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function attempt(owned: boolean) {
    const resultKey = crypto.randomUUID();
    const address = stageSession("address", { key: "address", label: "Address Session" });
    await storage.saveBuildPipeline(
      PIPELINE_ID,
      "p1",
      "e1",
      BUILD_PIPELINE_VERSION,
      pipelineSnapshot(
        "e1",
        "p1",
        [{ ...address, ...(owned ? { structuredRequestId: resultKey } : {}) }],
        { phase: "addressing" },
      ),
    );
    await storage.synchronizeAgentMailboxes();
    await workflowResults.prepare({
      resultKey,
      kind: "fix-result",
      environmentId: "e1",
      projectId: "p1",
      provider: "codex",
    });
    return {
      worker: pipelineWorkerTabId(address.sessionKey),
      connection: server.workflowResultConnection("e1", "p1", "host", resultKey, "codex"),
    };
  }

  test("lists the mail tools and acts as that worker", async () => {
    const { worker, connection } = await attempt(true);
    const names = (await rpc(connection.url, connection.token, "tools/list")).result?.tools?.map(
      (tool) => tool.name,
    );
    for (const name of AGENT_MAIL_TOOL_NAMES) expect(names).toContain(name);
    expect(names).toContain("submit_fix_result");

    const listed = await rpc(connection.url, connection.token, "tools/call", {
      name: "list_mailboxes",
      arguments: {},
    });
    expect(listed.result?.structuredContent?.identity).toMatchObject({
      environmentId: "e1",
      tabId: worker,
      resolved: "credential",
    });
    const sent = await rpc(connection.url, connection.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "worker-1",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "From the Address worker.",
      },
    });
    expect(sent.result?.isError).not.toBe(true);
    const inbox = await storage.getAgentMailMailbox("e2", "agent");
    expect(inbox.messages[0]!.from).toMatchObject({ kind: "tab", tabId: worker });

    // It cannot speak for another tab in its environment.
    const impersonated = await rpc(connection.url, connection.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "worker-2",
        fromTabId: "agent",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "Not me.",
      },
    });
    expect(impersonated.result?.isError).toBe(true);
  });

  test("an attempt no pipeline worker owns gets no mail tools", async () => {
    const { connection } = await attempt(false);
    const names = (await rpc(connection.url, connection.token, "tools/list")).result?.tools?.map(
      (tool) => tool.name,
    );
    expect(names).toContain("submit_fix_result");
    expect(names).not.toContain("send_message");
  });
});
