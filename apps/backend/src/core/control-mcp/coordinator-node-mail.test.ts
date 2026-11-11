/**
 * The coordinator's Control MCP mail tools between a command node's
 * coordinator and a leaf's coordinator: which backend command each call
 * reaches (`coordinator-node-coordinator-mail.ts` owns what they do).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ControlMcpServer, type ControlMcpInvoker } from "./server.js";

type Structured = Record<string, unknown>;

async function rpc(url: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  const body = JSON.parse(payload!) as {
    result?: { structuredContent?: Structured; isError?: boolean; content?: unknown[] };
    error?: { message?: string };
  };
  if (!body.result) throw new Error(body.error?.message ?? text);
  if (body.result?.isError) throw new Error(JSON.stringify(body.result.content));
  return body.result!.structuredContent!;
}

const NODE_SENDER = {
  kind: "node",
  nodeName: "Office desktop",
  projectId: "project-1",
  tabId: "coord-tab",
  title: null,
};

describe("coordinator mail between a command node and its leaves", () => {
  let dataDir: string;
  let server: ControlMcpServer;
  let mode: "command" | "leaf" = "command";
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
  const parents = new Map<string, Structured>();
  let noMailbox = false;
  let parentError = false;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-mcp-node-mail-"));
    invocations.length = 0;
    mode = "command";
    noMailbox = false;
    parentError = false;
    parents.clear();
    const invoke: ControlMcpInvoker = async <T>(command: string, args: Structured = {}) => {
      invocations.push({ command, args });
      const answers: Record<string, () => unknown> = {
        get_projects: () => [
          { id: "project-1", name: "Site", gitUrl: "git@github.com:acme/site.git" },
        ],
        get_config: () => ({ global: { agentMessaging: { enabled: true } } }),
        get_project_coordinator: () =>
          noMailbox
            ? null
            : {
                workspace: {
                  id: "coordinator-1",
                  lifecycleState: "ready",
                  conversations: [
                    {
                      id: "conversation-1",
                      tabId: "coord-tab",
                      mailboxIncarnationId: "incarnation-1",
                    },
                  ],
                },
              },
        get_node_status: () =>
          mode === "leaf"
            ? { nodeId: "bk_leaf", mode: "leaf", controllers: [{ displayName: "Office desktop" }] }
            : { nodeId: "bk_cmd", mode: "command", controllers: [] },
        get_node_summaries: () => ({
          selfId: "bk_cmd",
          nodes: [
            {
              nodeId: "bk_leaf",
              available: true,
              view: { displayName: "Build box", connection: { state: "connected" } },
              projects: [
                {
                  ref: { backendId: "bk_leaf", projectId: "p-leaf" },
                  repositoryHint: "github.com/acme/site",
                },
              ],
              environments: [],
            },
          ],
        }),
        get_agent_mail_message: () => {
          if (parentError) throw new Error("read failed");
          return parents.get(String(args.messageId)) ?? null;
        },
        get_coordinator_node_mailbox: () => ({
          nodeId: args.nodeId,
          node: "Build box",
          coordinator: { reachable: true, address: "coordinator" },
        }),
        send_coordinator_node_mail: () => ({
          nodeId: args.nodeId,
          toEnvironmentId: args.toEnvironmentId,
          placement: "pending-inject",
          coordinatorDelegationOpened: false,
          delivery: "async",
          wake: "The coordinator on Build box answers by mail.",
          nextStep: "Finish your turn now. Do not poll.",
        }),
        send_coordinator_command_node_mail: () => ({
          outboxSeq: 1,
          placement: "node-outbox",
          coordinator: "command node Office desktop",
          coordinatorDelegationOpened: false,
        }),
      };
      const answer = answers[command];
      if (!answer) throw new Error(`Unexpected command: ${command}`);
      return answer() as T;
    };
    server = new ControlMcpServer(dataDir, invoke, { port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const call = (name: string, args: Record<string, unknown>) => {
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["mail", "discovery"],
    });
    return rpc(credential.url, credential.token, name, args);
  };
  const sent = (command: string) =>
    invocations.filter((entry) => entry.command === command).map((entry) => entry.args);

  test("missing reply parents and unavailable mailboxes refuse without a local send", async () => {
    for (const failure of ["missing", "lookup-error", "no-mailbox"]) {
      noMailbox = failure === "no-mailbox";
      parentError = failure === "lookup-error";
      await expect(
        call("send_message", {
          requestId: failure,
          toEnvironmentId: "coordinator",
          replyToMessageId: "missing",
          body: "reply",
        }),
      ).rejects.toThrow(
        failure === "no-mailbox" ? "Coordinator credential is no longer valid" : "Reply parent",
      );
    }
    expect(sent("send_coordinator_agent_mail")).toEqual([]);
    expect(sent("send_coordinator_command_node_mail")).toEqual([]);
  });

  test("list_mailboxes with nodeId says whether that node has a coordinator to reach", async () => {
    const reach = await call("list_mailboxes", { nodeId: "bk_leaf" });
    expect(reach).toMatchObject({ coordinator: { reachable: true, address: "coordinator" } });
    expect(sent("get_coordinator_node_mailbox")[0]).toMatchObject({
      nodeId: "bk_leaf",
      scope: { projectId: "project-1", coordinatorId: "coordinator-1" },
    });
  });

  test("send_message carries attachments on all three routes, for the backend to copy", async () => {
    const attachments = ["/data/coordinator-attachments/c/conv/shot.png"];
    await call("send_message", {
      requestId: "a-1",
      nodeId: "bk_leaf",
      toEnvironmentId: "env-1",
      body: "See this.",
      attachments,
    });
    expect(sent("send_coordinator_node_mail")[0]).toMatchObject({ attachments });
    await call("send_message", {
      requestId: "a-2",
      toEnvironmentId: "command-node-coordinator",
      body: "See this.",
      attachments,
    });
    expect(sent("send_coordinator_command_node_mail")[0]).toMatchObject({ attachments });
  });

  test('send_message with nodeId to "coordinator" asks that node\'s coordinator', async () => {
    const result = await call("send_message", {
      requestId: "ask-1",
      nodeId: "bk_leaf",
      toEnvironmentId: "coordinator",
      body: "Which branch is checked out?",
    });
    expect(sent("send_coordinator_node_mail")[0]).toMatchObject({
      nodeId: "bk_leaf",
      toEnvironmentId: "coordinator",
      body: "Which branch is checked out?",
    });
    expect(result).toMatchObject({ delivery: "async", nextStep: expect.any(String) });
    expect(result.message).not.toHaveProperty("wake");
  });

  test("a reply to a leaf coordinator's mail goes to that node's coordinator address", async () => {
    parents.set("from-leaf-coordinator", {
      id: "from-leaf-coordinator",
      from: {
        ...NODE_SENDER,
        nodeId: "bk_leaf",
        nodeName: "Build box",
        role: "agent",
        environmentId: "coordinator:leaf-coordinator:main",
      },
    });
    await call("send_message", {
      requestId: "reply-1",
      toEnvironmentId: "coordinator",
      replyToMessageId: "from-leaf-coordinator",
      body: "Thanks.",
    });
    expect(sent("send_coordinator_node_mail")[0]).toEqual(
      expect.objectContaining({ nodeId: "bk_leaf", toEnvironmentId: "coordinator" }),
    );
    expect(sent("send_coordinator_node_mail")[0]).not.toHaveProperty("toTabId");
  });

  test("on a leaf, a reply and a new message go up through the outbox; other node tools refuse", async () => {
    mode = "leaf";
    parents.set("from-command", {
      id: "from-command",
      from: {
        ...NODE_SENDER,
        nodeId: "bk_cmd",
        role: "coordinator",
        environmentId: "coordinator:command-coordinator:main",
      },
    });
    const replied = await call("send_message", {
      requestId: "answer-1",
      toEnvironmentId: "coordinator",
      replyToMessageId: "from-command",
      body: "release/2.36",
    });
    expect(replied).toMatchObject({ message: { placement: "node-outbox" } });
    await call("send_message", {
      requestId: "raise-1",
      toEnvironmentId: "command-node-coordinator",
      body: "The disk is nearly full.",
    });
    expect(sent("send_coordinator_command_node_mail")).toEqual([
      expect.objectContaining({ requestId: "answer-1", replyToMessageId: "from-command" }),
      expect.objectContaining({ requestId: "raise-1", body: "The disk is nearly full." }),
    ]);
    expect(sent("send_coordinator_command_node_mail")[1]).not.toHaveProperty("replyToMessageId");
    expect(sent("send_coordinator_node_mail")).toEqual([]);
    // Naming a node is still refused in leaf mode.
    await expect(
      call("send_message", {
        requestId: "across-1",
        nodeId: "bk_other",
        toEnvironmentId: "coordinator",
        body: "Hello?",
      }),
    ).rejects.toThrow("leaf mode");
  });
});
