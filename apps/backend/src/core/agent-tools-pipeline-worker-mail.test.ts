/**
 * A build pipeline worker's tool-mode turn connects with its workflow-result
 * capability alone; that server also carries the worker's own mail tools,
 * bound to the mailbox the backend's record says owns the attempt. An
 * OpenCode turn without one uses the environment-wide connection with the
 * worker's signed mail capability.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { AGENT_MAIL_TOOL_NAMES } from "@orkestrator/protocol/agent-mail";
import { BUILD_PIPELINE_VERSION } from "@orkestrator/protocol/build-pipeline";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { AgentToolsServer } from "./agent-tools.js";
import {
  authenticatePipelineWorkerMailCapability,
  pipelineWorkerMailCapability,
} from "./pipeline-worker-identity.js";
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

  async function attempt(owned: boolean, provider: "codex" | "opencode" = "codex") {
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
      provider,
    });
    return {
      resultKey,
      worker: pipelineWorkerTabId(address.sessionKey),
      connection: server.workflowResultConnection("e1", "p1", "host", resultKey, provider),
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

  test("OpenCode broker authenticates mail per call and refuses impersonation", async () => {
    const { worker, connection, resultKey } = await attempt(true, "opencode");
    const auth = { resultKey, capability: connection.workflowResultCapability };
    const call = (name: string, args: Record<string, unknown>) =>
      rpc(connection.url, connection.token, "tools/call", {
        name,
        arguments: { ...auth, ...args },
      });
    const listed = await call("list_mailboxes", {});
    expect(listed.result?.structuredContent?.identity).toMatchObject({ tabId: worker });
    const sent = await call("send_message", {
      requestId: "broker-send",
      toEnvironmentId: "e2",
      toTabId: "agent",
      body: "hello",
    });
    expect(sent.result?.isError).not.toBe(true);
    const inbound = await storage.sendAgentMail(
      { kind: "tab", environmentId: "e2", projectId: "p1", tabId: "agent" },
      { requestId: "inbound", toEnvironmentId: "e1", toTabId: worker, body: "question" },
    );
    expect((await call("read_message", { messageId: inbound.id })).result?.isError).not.toBe(true);
    expect(
      (
        await call("reply_message", {
          messageId: inbound.id,
          requestId: "broker-reply",
          body: "answer",
        })
      ).result?.isError,
    ).not.toBe(true);
    expect((await call("ack_message", { messageId: inbound.id })).result?.isError).not.toBe(true);
    expect((await call("list_mailboxes", { tabId: "another-worker" })).result?.isError).toBe(true);
    expect((await call("list_mailboxes", { resultKey: "different-key" })).result?.isError).toBe(
      true,
    );
  });

  test("an attempt no pipeline worker owns gets no mail tools", async () => {
    const { connection } = await attempt(false);
    const names = (await rpc(connection.url, connection.token, "tools/list")).result?.tools?.map(
      (tool) => tool.name,
    );
    expect(names).toContain("submit_fix_result");
    expect(names).not.toContain("send_message");
  });

  describe("an OpenCode turn without a workflow-result capability", () => {
    async function workerPipeline(addressStatus: "running" | "finished" = "running") {
      const address = stageSession("address", { key: "address", label: "Address Session" });
      const verify = stageSession("verify", { key: "verify", label: "Verify Session" });
      await storage.saveBuildPipeline(
        PIPELINE_ID,
        "p1",
        "e1",
        BUILD_PIPELINE_VERSION,
        addressStatus === "running"
          ? pipelineSnapshot("e1", "p1", [address], { phase: "addressing" })
          : pipelineSnapshot("e1", "p1", [{ ...address, status: "idle" }, verify], {
              phase: "verifying",
            }),
      );
      await storage.synchronizeAgentMailboxes();
      const worker = pipelineWorkerTabId(address.sessionKey);
      const connection = server.connection("e1", "p1", "host");
      const capability = pipelineWorkerMailCapability(workflowResults, {
        environmentId: "e1",
        projectId: "p1",
        tabId: worker,
      });
      const call = (name: string, args: Record<string, unknown>) =>
        rpc(connection.url, connection.token, "tools/call", { name, arguments: args });
      return { worker, connection, capability, call };
    }

    test("the environment connection acts as the worker with its mail capability", async () => {
      const { worker, connection, capability, call } = await workerPipeline();
      const tools = (await rpc(connection.url, connection.token, "tools/list")).result?.tools as
        Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> | undefined;
      for (const name of AGENT_MAIL_TOOL_NAMES) {
        const tool = tools?.find((candidate) => candidate.name === name);
        expect(tool?.inputSchema?.properties).toHaveProperty("mailCapability");
      }

      const listed = await call("list_mailboxes", { mailCapability: capability });
      expect(listed.result?.structuredContent?.identity).toMatchObject({
        environmentId: "e1",
        tabId: worker,
        resolved: "credential",
      });
      const sent = await call("send_message", {
        mailCapability: capability,
        requestId: "opencode-send",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "From the OpenCode Address worker.",
      });
      expect(sent.result?.isError).not.toBe(true);
      const outbound = (await storage.getAgentMailMailbox("e2", "agent")).messages[0]!;
      expect(outbound.from).toMatchObject({ kind: "tab", environmentId: "e1", tabId: worker });
      expect(
        (await call("get_message_status", { mailCapability: capability, messageId: outbound.id }))
          .result?.isError,
      ).not.toBe(true);

      const inbound = await storage.sendAgentMail(
        { kind: "tab", environmentId: "e2", projectId: "p1", tabId: "agent" },
        { requestId: "inbound", toEnvironmentId: "e1", toTabId: worker, body: "A question?" },
      );
      const inbox = await call("check_inbox", { mailCapability: capability });
      const listedIds = (
        (inbox.result?.structuredContent?.messages ?? []) as Array<{ id: string }>
      ).map((message) => message.id);
      expect(listedIds).toContain(inbound.id);
      expect(
        (await call("read_message", { mailCapability: capability, messageId: inbound.id })).result
          ?.isError,
      ).not.toBe(true);
      const replied = await call("reply_message", {
        mailCapability: capability,
        messageId: inbound.id,
        requestId: "opencode-reply",
        body: "The answer.",
      });
      expect(replied.result?.isError).not.toBe(true);
      const reply = (await storage.getAgentMailMailbox("e2", "agent")).messages.find(
        (message) => message.replyToMessageId === inbound.id,
      );
      expect(reply?.from).toMatchObject({ kind: "tab", tabId: worker });
      expect(
        (await call("ack_message", { mailCapability: capability, messageId: inbound.id })).result
          ?.isError,
      ).not.toBe(true);
    });

    test("without, or with a forged or foreign capability, it cannot claim the worker", async () => {
      const { worker, capability, call } = await workerPipeline();
      const send = (args: Record<string, unknown>) =>
        call("send_message", {
          requestId: crypto.randomUUID(),
          toEnvironmentId: "e2",
          toTabId: "agent",
          body: "Not me.",
          ...args,
        });
      // The environment credential alone never reaches a worker's mailbox.
      expect((await send({ fromTabId: worker })).result?.isError).toBe(true);
      const forged = `${capability.slice(0, -2)}${capability.endsWith("AA") ? "BB" : "AA"}`;
      expect((await send({ mailCapability: forged })).result?.isError).toBe(true);
      const foreign = pipelineWorkerMailCapability(workflowResults, {
        environmentId: "e2",
        projectId: "p1",
        tabId: worker,
      });
      expect((await send({ mailCapability: foreign })).result?.isError).toBe(true);
      // A capability names one mailbox; it cannot speak for another tab.
      expect((await send({ mailCapability: capability, fromTabId: "agent" })).result?.isError).toBe(
        true,
      );
      expect(() =>
        pipelineWorkerMailCapability(workflowResults, {
          environmentId: "e1",
          projectId: "p1",
          tabId: "agent",
        }),
      ).toThrow();
      // It is not a bearer credential.
      const bearer = await rpc(server.connection("e1", "p1", "host").url, capability, "tools/list");
      expect(bearer.result?.tools).toBeUndefined();
      expect((await storage.getAgentMailMailbox("e2", "agent")).messages).toHaveLength(0);
    });

    test("a finished worker's capability no longer acts as its mailbox", async () => {
      const { capability, call } = await workerPipeline("finished");
      const sent = await call("send_message", {
        mailCapability: capability,
        requestId: "late",
        toEnvironmentId: "e2",
        toTabId: "agent",
        body: "After the end.",
      });
      expect(sent.result?.isError).toBe(true);
    });

    test("the capability is signed by the durable identity and survives a restart", async () => {
      const { worker, capability } = await workerPipeline();
      const restarted = new WorkflowResultService(dataDir);
      try {
        await restarted.initializeCapabilityIdentity();
        expect(authenticatePipelineWorkerMailCapability(restarted, capability)).toEqual({
          environmentId: "e1",
          projectId: "p1",
          tabId: worker,
        });
      } finally {
        restarted.closeStorage();
      }
    });
  });
});
