import { afterEach, expect, test } from "bun:test";
import path from "node:path";
import { MailWorld } from "./agent-mail-world-test-support.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerCoordinatorNodeCommands } from "./commands-registry-coordinator-nodes.js";
import { ControlMcpServer, type ControlMcpInvoker } from "./control-mcp-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const world = await MailWorld.create();
  cleanups.push(() => world.close());
  await world.storage.updateProject(world.projectId, {
    gitUrl: "https://github.com/acme/site.git",
  });
  const main = await world.main();
  const routed: Array<{ command: string; args: Record<string, unknown> }> = [];
  let available = true;
  const environments = new Map<string, Record<string, unknown>>([
    ["leaf-only", { id: "leaf-only", projectId: "p-leaf", status: "running" }],
    ["other-project", { id: "other-project", projectId: "p-other", status: "running" }],
    [
      "project-home",
      { id: "project-home", projectId: "p-leaf", projectHome: true, status: "running" },
    ],
  ]);
  const workflows = new Map<string, unknown>();
  const summaries = async () => ({
    selfId: "bk_cmd",
    nodes: [
      {
        nodeId: "bk_leaf",
        available,
        view: {
          displayName: "Build box",
          connection: { state: available ? "connected" : "disconnected" },
        },
        projects: [{ ref: { projectId: "p-leaf" }, repositoryHint: "github.com/acme/site" }],
        environments: [],
      },
    ],
  });
  const remote = async (input: { command: string; args: Record<string, unknown> }) => {
    routed.push(input);
    if (!available) throw new Error("not connected");
    let result: unknown = {};
    const { command, args } = input;
    if (command === "get_environment")
      result = environments.get(String(args.environmentId)) ?? null;
    if (command === "get_environment_snapshots")
      result = Array.from(environments.values()).filter(
        (environment) => environment.projectId === args.projectId,
      );
    if (command === "get_build_pipeline" || command === "get_multi_review_workflow")
      result = workflows.get(String(args.pipelineId ?? args.workflowId)) ?? null;
    if (command === "get_pane_layout")
      result = {
        root: {
          kind: "leaf",
          id: "pane",
          tabs: [
            { id: "startup-agent", type: "agent-native", nativeAgentData: { platform: "codex" } },
          ],
        },
      };
    if (command === "dispatch_native_agent_intent") result = { outcome: "accepted" };
    if (command === "launch_control_job")
      result = { tabId: "job-tab", environmentId: args.environmentId, outcome: "accepted" };
    if (command === "get_config")
      result = { global: { enabledAgentPlatforms: ["codex"], agentMessaging: { enabled: true } } };
    if (command === "get_native_agent_model_catalog")
      result = [
        {
          id: "gpt-5.6-codex",
          name: "Codex",
          platform: "codex",
          reasoning: [{ id: "high", name: "High" }],
        },
      ];
    if (command === "get_agent_model_catalog_cache") result = { schemaVersion: 1 };
    if (command === "deliver_node_mail")
      result = { messageId: "mail", toTabId: "startup-agent", placement: "pending-inject" };
    return { outcome: "ok", result };
  };
  const context = {
    storage: world.storage,
    coordinators: world.coordinator,
    nodes: { status: async () => ({ nodeId: "bk_cmd", mode: "command" }) },
    nodePortal: { summaries, invokeOnNode: remote },
  } as unknown as CommandContext;
  const commands = new Map<string, CommandHandler>();
  registerCoordinatorNodeCommands((name, handler) => commands.set(name, handler));
  const localLookups: string[] = [];
  const invoke: ControlMcpInvoker = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    const handler = commands.get(command);
    if (handler) return (await handler(args, context)) as T;
    let result: unknown;
    switch (command) {
      case "get_project_coordinator":
        result = {
          workspace: await world.storage.getCoordinatorWorkspace(world.projectId),
          workflows: await world.storage.listCoordinatorWorkflowAssociations(world.projectId),
        };
        break;
      case "get_projects":
        result = await world.storage.loadProjects();
        break;
      case "get_environment":
        localLookups.push(String(args.environmentId));
        result = await world.storage.getEnvironment(String(args.environmentId));
        break;
      case "get_environment_snapshots":
        result = [];
        break;
      case "get_config":
        result = {
          global: { enabledAgentPlatforms: ["codex"], agentMessaging: { enabled: true } },
        };
        break;
      case "get_node_status":
        result = { nodeId: "bk_cmd", mode: "command", controllers: [] };
        break;
      case "get_node_summaries":
        result = await summaries();
        break;
      case "invoke_on_node":
        return (await remote(args as never)) as T;
      default:
        result = {};
    }
    return result as T;
  };
  const server = new ControlMcpServer(path.join(world.root, "mcp"), invoke, { port: 0 });
  await server.start();
  cleanups.push(() => server.stop());
  const credential = async (
    conversationId = main.conversationId!,
    capabilities = ["environments", "jobs", "mail", "discovery", "build-pipelines", "multi-review"],
  ) => {
    const workspace = (await world.storage.getCoordinatorWorkspace(world.projectId))!;
    const conversation = workspace.conversations.find((item) => item.id === conversationId)!;
    return server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId,
      mailboxIncarnationId: conversation.mailboxIncarnationId!,
      capabilities,
    });
  };
  const call = async (
    name: string,
    args: Record<string, unknown>,
    connection?: Awaited<ReturnType<typeof credential>>,
  ) => {
    const auth = connection ?? (await credential());
    const response = await fetch(auth.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
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
    const raw = await response.text();
    const json = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? raw
          .split("\n")
          .find((line) => line.startsWith("data: "))!
          .slice(6)
      : raw;
    const body = JSON.parse(json) as {
      result?: {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: Array<{ text: string }>;
      };
      error?: unknown;
    };
    return { status: response.status, body };
  };
  return {
    world,
    main,
    routed,
    localLookups,
    call,
    credential,
    workflows,
    disconnect: () => {
      available = false;
    },
  };
}

test("real scoped credentials prompt and launch jobs in leaf-only environments with durable delegations", async () => {
  const { world, call, localLookups, routed } = await setup();
  const prompted = await call("send_prompt_to_tab", {
    nodeId: "bk_leaf",
    environmentId: "leaf-only",
    tabId: "startup-agent",
    requestId: "prompt",
    prompt: "Test it",
  });
  expect(prompted.body.result?.isError).not.toBe(true);
  expect(prompted.body.result?.structuredContent).toMatchObject({
    delivery: "async",
    nodeId: "bk_leaf",
  });
  const job = await call("launch_job", {
    nodeId: "bk_leaf",
    environmentId: "leaf-only",
    agent: "codex",
    requestId: "job",
    prompt: "Lint it",
  });
  expect(job.body.result?.isError).not.toBe(true);
  expect(job.body.result?.structuredContent).toMatchObject({ delivery: "async", tabId: "job-tab" });
  const delegations = await world.storage.listOpenCoordinatorDelegations();
  expect(delegations).toHaveLength(2);
  expect(delegations.map((item) => item.delegation?.workerTabId).sort()).toEqual([
    "job-tab",
    "startup-agent",
  ]);
  expect(
    delegations.every((item) => item.nodeId === "bk_leaf" && item.resourceId === "leaf-only"),
  ).toBe(true);
  expect(localLookups).not.toContain("leaf-only");
  expect(routed.some((item) => item.command === "record_node_environment_origin")).toBe(true);
});

test("a side-agent mail credential cannot deliver remote mail", async () => {
  const { world, call, credential, routed } = await setup();
  const side = await world.addSide();
  const auth = await credential(side.conversationId!, ["mail"]);
  const result = await call(
    "send_message",
    { nodeId: "bk_leaf", requestId: "side-mail", toEnvironmentId: "leaf-only", body: "Work" },
    auth,
  );
  expect(result.body.result?.isError).toBe(true);
  expect(JSON.stringify(result.body)).toContain("only message the main coordinator");
  expect(routed.some((item) => item.command === "deliver_node_mail")).toBe(false);
  const unauthorized = await call(
    "stop_environment",
    { nodeId: "bk_leaf", environmentId: "leaf-only" },
    auth,
  );
  expect(unauthorized.status).toBe(403);
  expect(routed.some((item) => item.command === "stop_environment")).toBe(false);
});

test("remote mutations reject foreign environments and the project checkout before dispatch", async () => {
  const { call, routed } = await setup();
  for (const environmentId of ["other-project", "project-home"]) {
    for (const name of [
      "start_environment",
      "stop_environment",
      "send_prompt_to_tab",
      "launch_job",
    ]) {
      const result = await call(name, {
        nodeId: "bk_leaf",
        environmentId,
        tabId: "startup-agent",
        agent: "codex",
        requestId: `${name}-${environmentId}`,
        prompt: "Work",
      });
      expect(result.body.result?.isError).toBe(true);
    }
  }
  expect(routed.every((item) => item.command === "get_environment")).toBe(true);
  const local = await call("stop_environment", { environmentId: "leaf-only" });
  expect(local.body.result?.isError).toBe(true);
});

test("remote workflow mutations reject resources from another project", async () => {
  const { call, workflows, routed } = await setup();
  workflows.set("foreign", { snapshot: { id: "foreign", projectId: "p-other", phase: "running" } });
  for (const name of [
    "pause_build_pipeline",
    "resume_build_pipeline",
    "cancel_build_pipeline",
    "cancel_multi_review",
  ]) {
    const result = await call(name, {
      nodeId: "bk_leaf",
      pipelineId: "foreign",
      workflowId: "foreign",
    });
    expect(result.body.result?.isError).toBe(true);
  }
  expect(
    routed.every(
      (item) =>
        item.command === "get_build_pipeline" || item.command === "get_multi_review_workflow",
    ),
  ).toBe(true);
});

test("unavailable nodes refuse environment reads and remain visible as unavailable workflow resources", async () => {
  const { world, main, call, disconnect, routed } = await setup();
  await world.storage.saveCoordinatorWorkflowAssociation({
    id: "remote-build",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: main.conversationId!,
    kind: "build-pipeline",
    resourceId: "build",
    nodeId: "bk_leaf",
    requestId: "build",
    createdAt: new Date().toISOString(),
  });
  disconnect();
  const environments = await call("list_environments", { nodeId: "bk_leaf" });
  expect(environments.body.result?.isError).toBe(true);
  const allEnvironments = await call("list_environments", {});
  expect(allEnvironments.body.result?.structuredContent?.otherNodes).toEqual([
    expect.objectContaining({ nodeId: "bk_leaf", available: false }),
  ]);
  const workflows = await call("list_workflows", {});
  expect(workflows.body.result?.isError).not.toBe(true);
  expect(workflows.body.result?.structuredContent?.workflows).toEqual([
    expect.objectContaining({
      nodeId: "bk_leaf",
      resource: { id: "build", status: "unavailable" },
    }),
  ]);
  expect(routed).toEqual([]);
});

test("authorized remote state changes stay on the matching project and node", async () => {
  const { call, workflows, routed } = await setup();
  for (const name of ["start_environment", "stop_environment"]) {
    const response = await call(name, { nodeId: "bk_leaf", environmentId: "leaf-only" });
    expect(response.body.result?.structuredContent).toMatchObject({
      accepted: true,
      nodeId: "bk_leaf",
    });
  }
  workflows.set("own", { snapshot: { id: "own", projectId: "p-leaf", phase: "running" } });
  for (const name of [
    "pause_build_pipeline",
    "resume_build_pipeline",
    "cancel_build_pipeline",
    "cancel_multi_review",
  ]) {
    const response = await call(name, { nodeId: "bk_leaf", pipelineId: "own", workflowId: "own" });
    expect(response.body.result?.isError).not.toBe(true);
    expect(routed.some((item) => item.command === name)).toBe(true);
  }
  const listed = await call("list_environments", { nodeId: "bk_leaf" });
  expect(listed.body.result?.structuredContent?.environments).toEqual([
    expect.objectContaining({ id: "leaf-only", nodeId: "bk_leaf" }),
  ]);
});
