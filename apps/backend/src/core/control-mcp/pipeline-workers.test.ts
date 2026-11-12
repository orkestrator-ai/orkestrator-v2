/**
 * A coordinator's Control MCP tools and build pipeline workers: discovery,
 * a send to one worker on this node and on a leaf (`nodeId`), the workers in
 * `get_build_pipeline`, and a worker's own transcript through
 * `get_tab_transcript`. Which backend command each call reaches; the mail
 * store's side is `pipeline-worker-mail.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
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
  if (body.result.isError) throw new Error(JSON.stringify(body.result.content));
  return body.result.structuredContent!;
}

const PIPELINE = "pipeline-1";
const REVIEWER = pipelineWorkerTabId(`${PIPELINE}:review:0:reviewer-2`);

/** A leaf's pipeline record, as `get_build_pipeline` returns it there. */
function pipelineRecord(projectId: string, environmentId: string) {
  const session = (phase: string, key: string, label: string, status: string) => ({
    phase,
    agent: "codex",
    model: "gpt-test",
    iteration: 0,
    sessionKey: `${PIPELINE}:${phase}:0:${key}`,
    sdkSessionId: `sdk-${key}`,
    status,
    startedAt: "2026-11-03T00:00:00.000Z",
    label,
  });
  return {
    id: PIPELINE,
    projectId,
    environmentId,
    revision: 3,
    snapshot: {
      id: PIPELINE,
      projectId,
      environmentId,
      agentType: "codex",
      phase: "reviewing",
      currentSessionIndex: 2,
      sessions: [
        session("build", "build", "Build Session", "idle"),
        session("review", "reviewer-1", "Independent Review 1", "running"),
        session("review", "reviewer-2", "Independent Review 2", "running"),
      ],
      reviewFanout: {
        reviewers: [1, 2].map((slot) => ({
          id: `reviewer-${slot}`,
          status: "running",
          agent: "codex",
          model: "gpt-test",
          sessionKey: `${PIPELINE}:review:0:reviewer-${slot}`,
        })),
      },
    },
  };
}

describe("coordinator tools and build pipeline workers", () => {
  let dataDir: string;
  let server: ControlMcpServer;
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-mcp-pipeline-workers-"));
    invocations.length = 0;
    const local: Record<string, (args: Structured) => unknown> = {
      get_environment: (args) => ({
        id: args.environmentId,
        projectId: args.environmentId === "env-leaf" ? "p-leaf" : "project-1",
        name: "pipeline",
        status: "running",
      }),
      list_agent_mailboxes: (args) => ({
        mailboxes: [
          {
            environmentId: args.environmentId,
            tabId: REVIEWER,
            kind: "pipeline",
            agent: "codex",
            pipelineWorker: { step: "review", slot: 2, round: 1, status: "running" },
          },
        ],
        total: 1,
        offset: 0,
        limit: 100,
      }),
      get_build_pipeline: (args) =>
        pipelineRecord(
          args.pipelineId === PIPELINE && leafRead ? "p-leaf" : "project-1",
          leafRead ? "env-leaf" : "env-local",
        ),
      get_build_pipeline_worker_transcript: (args) => ({
        environmentId: args.environmentId,
        tabId: args.tabId,
        pipelineId: PIPELINE,
        worker: { address: args.tabId, step: "review", status: "finished" },
        messages: [
          { id: "m1", role: "user", content: "Review this." },
          { id: "m2", role: "assistant", content: "Two issues." },
        ].slice(-(args.limit as number)),
        messageWindow: { startIndex: 0, messageCount: 2, complete: true },
      }),
    };
    let leafRead = false;
    const invoke: ControlMcpInvoker = async <T>(command: string, args: Structured = {}) => {
      invocations.push({ command, args });
      const answers: Record<string, () => unknown> = {
        get_projects: () => [
          { id: "project-1", name: "Site", gitUrl: "git@github.com:acme/site.git" },
        ],
        get_config: () => ({ global: { agentMessaging: { enabled: true } } }),
        get_project_coordinator: () => ({
          workspace: {
            id: "coordinator-1",
            lifecycleState: "ready",
            conversations: [
              { id: "conversation-1", tabId: "coord-tab", mailboxIncarnationId: "incarnation-1" },
            ],
          },
        }),
        get_node_status: () => ({ nodeId: "bk_cmd", mode: "command", controllers: [] }),
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
        invoke_on_node: () => {
          leafRead = true;
          const inner = local[String(args.command)];
          if (!inner) throw new Error(`Unexpected leaf command: ${String(args.command)}`);
          const result = inner(args.args as Structured);
          leafRead = false;
          return { outcome: "ok", result };
        },
        send_coordinator_node_mail: () => ({
          nodeId: args.nodeId,
          toEnvironmentId: args.toEnvironmentId,
          toTabId: args.toTabId,
          placement: "injected",
          injectedVia: "steer",
          deliverNow: "steered",
          deliverNowNote: "Steered into the worker's running turn.",
          coordinatorDelegationOpened: true,
        }),
        send_coordinator_agent_mail: () => ({
          id: "message-1",
          toEnvironmentId: args.toEnvironmentId,
          toTabId: args.toTabId,
          placement: "pending-inject",
          coordinatorDelegationOpened: true,
        }),
      };
      const answer = answers[command] ?? (local[command] ? () => local[command]!(args) : null);
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
      capabilities: ["mail", "discovery", "environments", "build-pipelines"],
    });
    return rpc(credential.url, credential.token, name, args);
  };
  const sent = (command: string) =>
    invocations.filter((entry) => entry.command === command).map((entry) => entry.args);
  const routed = (command: string) =>
    sent("invoke_on_node")
      .filter((entry) => entry.command === command)
      .map((entry) => entry.args as Structured);

  test("list_mailboxes with environmentId lists that pipeline environment's workers", async () => {
    const page = await call("list_mailboxes", { environmentId: "env-local" });
    expect(sent("list_agent_mailboxes")[0]).toMatchObject({
      environmentId: "env-local",
      projectId: "project-1",
      strictProjectScope: true,
    });
    expect(page.mailboxes).toEqual([
      expect.objectContaining({ tabId: REVIEWER, pipelineWorker: expect.any(Object) }),
    ]);
  });

  test("with nodeId, discovery and a send reach one worker on that node", async () => {
    const page = await call("list_mailboxes", { nodeId: "bk_leaf", environmentId: "env-leaf" });
    expect(routed("list_agent_mailboxes")[0]).toMatchObject({
      environmentId: "env-leaf",
      projectId: "p-leaf",
      strictProjectScope: true,
    });
    expect(page).toMatchObject({ nodeId: "bk_leaf", mailboxes: [{ tabId: REVIEWER }] });

    const result = await call("send_message", {
      requestId: "fix-reviewer",
      nodeId: "bk_leaf",
      toEnvironmentId: "env-leaf",
      toTabId: REVIEWER,
      body: "Also check the migration.",
      deliverNow: true,
    });
    expect(sent("send_coordinator_node_mail")[0]).toMatchObject({
      nodeId: "bk_leaf",
      toEnvironmentId: "env-leaf",
      toTabId: REVIEWER,
      deliverNow: true,
    });
    expect(result).toMatchObject({ deliverNow: "steered" });
  });

  test("a send on this node names the worker it was given", async () => {
    await call("send_message", {
      requestId: "local-1",
      toEnvironmentId: "env-local",
      toTabId: REVIEWER,
      body: "Look at the API too.",
    });
    expect(sent("send_coordinator_agent_mail")[0]).toMatchObject({
      toEnvironmentId: "env-local",
      toTabId: REVIEWER,
    });
  });

  test("get_build_pipeline lists every worker, here and on a leaf", async () => {
    const here = await call("get_build_pipeline", { pipelineId: PIPELINE });
    const workers = (here.workflow as Structured).workers as Structured[];
    expect(workers.map((worker) => [worker.step, worker.slot, worker.status])).toEqual([
      ["build", undefined, "finished"],
      ["review", 1, "running"],
      ["review", 2, "running"],
    ]);
    expect(workers[2]).toMatchObject({ address: REVIEWER, agent: "codex", model: "gpt-test" });
    const there = await call("get_build_pipeline", { pipelineId: PIPELINE, nodeId: "bk_leaf" });
    expect(((there.workflow as Structured).workers as Structured[])[2]).toMatchObject({
      address: REVIEWER,
    });
  });

  test("get_tab_transcript with a worker address reads that worker's own transcript", async () => {
    const transcript = await call("get_tab_transcript", {
      environmentId: "env-local",
      tabId: REVIEWER,
      limit: 1,
    });
    expect(sent("get_build_pipeline_worker_transcript")[0]).toMatchObject({
      environmentId: "env-local",
      tabId: REVIEWER,
      limit: 1,
    });
    expect(transcript).toMatchObject({ kind: "pipeline-worker", pipelineId: PIPELINE });
    expect(JSON.stringify(transcript.messages)).toContain("Two issues.");
    expect(sent("get_pane_layout")).toEqual([]);

    const remote = await call("get_tab_transcript", {
      environmentId: "env-leaf",
      tabId: REVIEWER,
      nodeId: "bk_leaf",
    });
    expect(routed("get_build_pipeline_worker_transcript")[0]).toMatchObject({ tabId: REVIEWER });
    expect(remote).toMatchObject({ nodeId: "bk_leaf", kind: "pipeline-worker" });
  });
});
