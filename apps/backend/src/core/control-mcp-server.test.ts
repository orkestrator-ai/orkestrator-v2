import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ControlMcpServer,
  readControlMcpDescriptor,
  type ControlMcpInvoker,
} from "./control-mcp-server.js";

type RpcBody = {
  result?: {
    tools?: Array<{ name: string; annotations?: Record<string, boolean> }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { message?: string };
};

async function rpc(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ response: Response; body: RpcBody }> {
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
      method,
      ...(params ? { params } : {}),
    }),
  });
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return { response, body: payload ? (JSON.parse(payload) as RpcBody) : {} };
}

describe("Orkestrator control MCP server", () => {
  let dataDir: string;
  let server: ControlMcpServer;
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
  const overrides = new Map<
    string,
    (args: Record<string, unknown>) => unknown | Promise<unknown>
  >();

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-mcp-"));
    invocations.length = 0;
    overrides.clear();
    const invoke: ControlMcpInvoker = async <T>(command: string, args = {}) => {
      invocations.push({ command, args });
      const override = overrides.get(command);
      if (override) return (await override(args)) as T;
      let result: unknown;
      switch (command) {
        case "get_projects":
          result = [
            {
              id: "project-1",
              name: "Orkestrator",
              localPath: "/private/worktree",
              gitUrl: "git@example.invalid:secret/repo.git",
              createdAt: new Date(0).toISOString(),
            },
          ];
          break;
        case "get_project":
          result = { id: "project-1", name: "Orkestrator" };
          break;
        case "get_config":
          result = {
            global: { enabledAgentPlatforms: ["codex"], agentMessaging: { enabled: true } },
          };
          break;
        case "get_environment_snapshots":
          result = [
            {
              id: "env-1",
              projectId: "project-1",
              name: "Existing environment",
              status: "running",
              setupStatus: "ready",
              environmentType: "local",
            },
          ];
          break;
        case "get_environment":
          result = {
            id: "env-1",
            projectId: "project-1",
            name: "Existing environment",
            status: "running",
            setupStatus: "ready",
            environmentType: "local",
          };
          break;
        case "get_native_agent_model_catalog":
          result = [
            {
              id: "gpt-5.6-codex",
              name: "GPT-5.6 Codex",
              platform: "codex",
              reasoning: [{ id: "high", name: "High" }],
            },
          ];
          break;
        case "get_agent_model_catalog_cache":
          result = { schemaVersion: 1 };
          break;
        case "get_opencode_model_catalog_cache":
          result = null;
          break;
        case "launch_control_job":
          result = {
            jobId: "job-1",
            environmentId: "env-1",
            tabId: "agent-job-job-1",
            status: "accepted",
          };
          break;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
      return result as T;
    };
    server = new ControlMcpServer(dataDir, invoke, { port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("publishes a private descriptor and rejects invalid credentials", async () => {
    const info = server.getInfo();
    expect(info).not.toBeNull();
    const descriptor = await readControlMcpDescriptor(info!.descriptorFile);
    expect(descriptor).toMatchObject({ version: 1, url: info!.url, pid: process.pid });
    expect(descriptor.token.length).toBeGreaterThanOrEqual(32);
    expect((await stat(info!.descriptorFile)).mode & 0o777).toBe(0o600);

    const unauthorized = await rpc(descriptor.url, `${descriptor.token}x`, "tools/list");
    expect(unauthorized.response.status).toBe(401);
  });

  test("keeps the token across restarts and rotates it only on request", async () => {
    const first = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);

    await server.stop();
    await server.start();
    const restarted = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    expect(restarted.token).toBe(first.token);

    const rotated = await server.rotateToken();
    expect(rotated.token).not.toBe(first.token);
    expect(rotated.url).toBe(server.getInfo()!.url);

    const oldCredential = await rpc(rotated.url, first.token, "tools/list");
    expect(oldCredential.response.status).toBe(401);
    const newCredential = await rpc(rotated.url, rotated.token, "tools/list");
    expect(newCredential.response.status).toBe(200);
  });

  test("exposes the bounded core tools without leaking project paths", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const listed = await rpc(descriptor.url, descriptor.token, "tools/list");
    expect(listed.response.status).toBe(200);
    expect(listed.body.result?.tools?.map(({ name }) => name)).toEqual([
      "list_projects",
      "get_launch_options",
      "list_environments",
      "get_environment",
      "list_tabs",
      "get_tab_state",
      "get_tab_transcript",
      "list_tickets",
      "get_ticket",
      "create_ticket",
      "update_ticket",
      "add_ticket_comment",
      "launch_environment",
      "launch_job",
      "send_prompt_to_tab",
      "list_mailboxes",
      "send_message",
    ]);
    for (const name of ["launch_environment", "launch_job", "send_prompt_to_tab"]) {
      expect(
        listed.body.result?.tools?.find((tool) => tool.name === name)?.annotations,
      ).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
    }

    const projects = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "list_projects",
      arguments: {},
    });
    expect(projects.body.result?.structuredContent).toEqual({
      projects: [
        {
          id: "project-1",
          name: "Orkestrator",
          hasLocalCheckout: true,
        },
      ],
      total: 1,
    });
    expect(JSON.stringify(projects.body.result?.structuredContent)).not.toContain("/private");
    expect(JSON.stringify(projects.body.result?.structuredContent)).not.toContain("git@");
  });

  test("lists mailboxes and sends body-free external-message results", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    overrides.set("list_agent_mailboxes", () => ({
      mailboxes: [
        {
          mailboxId: "env-1\0agent",
          environmentId: "env-1",
          tabId: "agent",
          title: "Agent",
        },
      ],
      total: 1,
      offset: 0,
      limit: 100,
    }));
    overrides.set("send_external_agent_mail", (args) => ({
      id: "message-1",
      requestId: args.requestId,
      placement: "stored",
      body: args.body,
    }));

    const listed = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "list_mailboxes",
      arguments: {},
    });
    expect(listed.body.result?.structuredContent).toMatchObject({ total: 1 });

    const sent = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "external-request",
        toEnvironmentId: "env-1",
        toTabId: "agent",
        body: "sensitive body",
      },
    });
    expect(sent.body.result?.structuredContent).toEqual({
      message: {
        id: "message-1",
        requestId: "external-request",
        placement: "stored",
      },
    });
    expect(invocations.at(-1)).toEqual({
      command: "send_external_agent_mail",
      args: {
        requestId: "external-request",
        toEnvironmentId: "env-1",
        toTabId: "agent",
        body: "sensitive body",
      },
    });
  });

  test("does not publish messaging tools while messaging is disabled", async () => {
    overrides.set("get_config", () => ({
      global: { enabledAgentPlatforms: ["codex"], agentMessaging: { enabled: false } },
    }));
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const listed = await rpc(descriptor.url, descriptor.token, "tools/list");
    const names = listed.body.result?.tools?.map(({ name }) => name) ?? [];
    expect(names).not.toContain("list_mailboxes");
    expect(names).not.toContain("send_message");
  });

  test("validates and routes an idempotent job launch into an existing environment", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_job",
      arguments: {
        requestId: "external-job-1",
        environmentId: "env-1",
        agent: "codex",
        modelId: "gpt-5.6-codex",
        reasoningId: "high",
        conversationMode: "build",
        title: "Fix the failing suite",
        prompt: "Diagnose and fix the failing test suite.",
      },
    });

    expect(launched.body.result?.isError).not.toBe(true);
    expect(launched.body.result?.structuredContent).toMatchObject({
      environmentId: "env-1",
      tabId: "agent-job-job-1",
      status: "accepted",
    });
    expect(invocations.find(({ command }) => command === "launch_control_job")?.args).toEqual({
      requestId: "external-job-1",
      environmentId: "env-1",
      agent: "codex",
      modelId: "gpt-5.6-codex",
      reasoningId: "high",
      conversationMode: "build",
      title: "Fix the failing suite",
      prompt: "Diagnose and fix the failing test suite.",
    });
  });

  test("rejects disabled agents and invalid model or reasoning selections", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const call = (arguments_: Record<string, unknown>) =>
      rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_job",
        arguments: {
          requestId: crypto.randomUUID(),
          environmentId: "env-1",
          agent: "codex",
          prompt: "Do work.",
          ...arguments_,
        },
      });

    const disabled = await call({ agent: "claude" });
    expect(disabled.body.result?.isError).toBe(true);
    const missingModel = await call({ reasoningId: "high" });
    expect(missingModel.body.result?.isError).toBe(true);
    const unavailableModel = await call({ modelId: "not-a-model" });
    expect(unavailableModel.body.result?.isError).toBe(true);
    const unavailableReasoning = await call({
      modelId: "gpt-5.6-codex",
      reasoningId: "ultra",
    });
    expect(unavailableReasoning.body.result?.isError).toBe(true);
    expect(invocations.filter(({ command }) => command === "launch_control_job")).toHaveLength(0);
  });

  test("launches the first project environment with an explicitly cached model", async () => {
    overrides.set("get_environment_snapshots", () => []);
    overrides.set("get_agent_model_catalog_cache", () => ({
      schemaVersion: 1,
      codex: {
        updatedAt: new Date().toISOString(),
        models: [
          {
            id: "gpt-5.6-codex",
            name: "GPT-5.6 Codex",
            reasoningOptions: [{ effort: "high", label: "High" }],
            defaultReasoningEffort: "high",
          },
        ],
      },
    }));
    let creationCalls = 0;
    overrides.set("create_environment", () => ({
      id: "env-new",
      projectId: "project-1",
      status: creationCalls++ === 0 ? "stopped" : "creating",
    }));
    overrides.set("start_environment_background", () => undefined);
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);

    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "environment-request-1",
        projectId: "project-1",
        environmentType: "local",
        agent: "codex",
        modelId: "gpt-5.6-codex",
        reasoningId: "high",
        conversationMode: "plan",
        prompt: "Plan the implementation.",
      },
    });

    expect(launched.body.result?.isError).not.toBe(true);
    expect(launched.body.result?.structuredContent).toEqual({
      environmentId: "env-new",
      tabId: "startup-agent",
      status: "accepted",
    });
    expect(invocations.find(({ command }) => command === "create_environment")?.args).toMatchObject(
      {
        projectId: "project-1",
        initialPrompt: "Plan the implementation.",
        pendingAgentLaunch: true,
        initialAgentModel: "gpt-5.6-codex",
        initialReasoningEffort: "high",
        initialConversationMode: "plan",
        controlRequestId: "environment-request-1",
      },
    );
    expect(
      invocations.filter(({ command }) => command === "start_environment_background"),
    ).toHaveLength(1);

    const replayed = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "environment-request-1",
        projectId: "project-1",
        environmentType: "local",
        agent: "codex",
        modelId: "gpt-5.6-codex",
        reasoningId: "high",
        conversationMode: "plan",
        prompt: "Plan the implementation.",
      },
    });
    expect(replayed.body.result?.structuredContent).toMatchObject({
      environmentId: "env-new",
      status: "accepted",
    });
    expect(
      invocations.filter(({ command }) => command === "start_environment_background"),
    ).toHaveLength(1);
  });

  test("reports a created environment when background start admission fails", async () => {
    overrides.set("create_environment", () => ({
      id: "env-new",
      projectId: "project-1",
      status: "stopped",
    }));
    overrides.set("start_environment_background", () => {
      throw new Error("Lifecycle admission closed");
    });
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "environment-request-2",
        projectId: "project-1",
        agent: "codex",
        prompt: "Build it.",
      },
    });

    expect(launched.body.result?.structuredContent).toMatchObject({
      environmentId: "env-new",
      status: "created",
      error: "Lifecycle admission closed",
    });
  });

  test("routes prompts only to native tabs with their durable logical session key", async () => {
    overrides.set("get_pane_layout", () => ({
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "native-1",
        tabs: [
          {
            id: "native-1",
            type: "agent-native",
            nativeAgentData: { platform: "codex" },
          },
        ],
      },
    }));
    overrides.set("dispatch_native_agent_intent", () => ({ outcome: "accepted" }));
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const sent = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "send_prompt_to_tab",
      arguments: {
        requestId: "prompt-request-1",
        environmentId: "env-1",
        tabId: "native-1",
        prompt: "Continue.",
        conversationMode: "build",
      },
    });

    expect(sent.body.result?.isError).not.toBe(true);
    expect(
      invocations.find(({ command }) => command === "dispatch_native_agent_intent")?.args,
    ).toEqual({
      environmentId: "env-1",
      agent: "codex",
      logicalSessionKey: "env-env-1:native-1",
      requestId: "prompt-request-1",
      prompt: "Continue.",
      mode: "build",
    });

    overrides.set("get_pane_layout", () => ({
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "terminal-1",
        tabs: [{ id: "terminal-1", type: "plain" }],
      },
    }));
    const rejected = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "send_prompt_to_tab",
      arguments: {
        requestId: "prompt-request-2",
        environmentId: "env-1",
        tabId: "terminal-1",
        prompt: "Do not send.",
      },
    });
    expect(rejected.body.result?.isError).toBe(true);
  });

  test("bounds native transcripts and reports terminal truncation after ANSI stripping", async () => {
    const nativeLayout = {
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "native-1",
        tabs: [
          {
            id: "native-1",
            type: "agent-native",
            nativeAgentData: { platform: "codex" },
          },
        ],
      },
    };
    overrides.set("get_pane_layout", () => nativeLayout);
    overrides.set("get_native_agent_projection", ({ messageLimit }) => ({
      state: "idle",
      revision: 7,
      generation: "generation-1",
      messageWindow: { total: 120 },
      messages: Array.from({ length: messageLimit === 1 ? 1 : 120 }, (_, index) => ({
        id: `message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: "x".repeat(index === 119 ? 120_000 : 20_000),
        parts: Array.from({ length: 120 }, () => ({ type: "text" })),
      })),
    }));
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const state = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_state",
      arguments: { environmentId: "env-1", tabId: "native-1" },
    });
    expect(state.body.result?.structuredContent).toMatchObject({
      environmentId: "env-1",
      tabId: "native-1",
      agent: "codex",
      state: { state: "idle", revision: 7 },
    });

    const transcript = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_transcript",
      arguments: { environmentId: "env-1", tabId: "native-1", limit: 100 },
    });
    const compact = transcript.body.result?.structuredContent as {
      messages: Array<{ id: string; content: string; parts: unknown[] }>;
      truncated: boolean;
    };
    expect(compact.truncated).toBe(true);
    expect(compact.messages.length).toBeLessThan(100);
    expect(compact.messages.at(-1)?.id).toBe("message-119");
    expect(compact.messages.at(-1)?.content).toHaveLength(100_000);
    expect(compact.messages.every((message) => message.parts.length <= 100)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(compact.messages), "utf8")).toBeLessThanOrEqual(
      1024 * 1024,
    );

    overrides.set("get_pane_layout", () => ({
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "terminal-1",
        tabs: [{ id: "terminal-1", type: "plain" }],
      },
    }));
    overrides.set("get_terminal_output_snapshot", () => ({
      output: `${"\x1b[31m".repeat(60_000)}visible`,
      truncated: false,
      revision: 3,
    }));
    overrides.set("get_terminal_session", () => ({ status: "running" }));
    const terminalState = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_state",
      arguments: { environmentId: "env-1", tabId: "terminal-1" },
    });
    expect(terminalState.body.result?.structuredContent).toMatchObject({
      tabId: "terminal-1",
      state: { status: "running" },
    });
    const terminal = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_transcript",
      arguments: { environmentId: "env-1", tabId: "terminal-1" },
    });
    expect(terminal.body.result?.structuredContent).toMatchObject({
      kind: "terminal-output",
      output: "visible",
      truncated: false,
      revision: 3,
    });
    expect(
      invocations.find(({ command }) => command === "get_terminal_output_snapshot")?.args,
    ).toEqual({ sessionId: "local-env-1:terminal-1" });

    overrides.set("get_environment", () => ({
      id: "env-1",
      projectId: "project-1",
      environmentType: "containerized",
      containerId: "container-1",
    }));
    await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_transcript",
      arguments: { environmentId: "env-1", tabId: "terminal-1" },
    });
    expect(
      invocations.filter(({ command }) => command === "get_terminal_output_snapshot").at(-1)?.args,
    ).toEqual({ sessionId: "container-1:terminal-1" });

    overrides.set("get_pane_layout", () => ({
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "browser-1",
        tabs: [{ id: "browser-1", type: "browser" }],
      },
    }));
    const persisted = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_state",
      arguments: { environmentId: "env-1", tabId: "browser-1" },
    });
    expect(persisted.body.result?.structuredContent).toMatchObject({
      tabId: "browser-1",
      state: { kind: "persisted" },
    });
    const unavailable = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_transcript",
      arguments: { environmentId: "env-1", tabId: "browser-1" },
    });
    expect(unavailable.body.result?.isError).toBe(true);
  });

  test("returns connecting and an empty transcript before a native projection exists", async () => {
    overrides.set("get_pane_layout", () => ({
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "native-1",
        tabs: [
          {
            id: "native-1",
            type: "agent-native",
            nativeAgentData: { platform: "codex" },
          },
        ],
      },
    }));
    overrides.set("get_native_agent_projection", () => null);
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const state = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_state",
      arguments: { environmentId: "env-1", tabId: "native-1" },
    });
    expect(state.body.result?.structuredContent).toMatchObject({
      connection: "connecting",
      agent: "codex",
    });
    const transcript = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_tab_transcript",
      arguments: { environmentId: "env-1", tabId: "native-1" },
    });
    expect(transcript.body.result?.structuredContent).toMatchObject({
      agent: "codex",
      messages: [],
    });
  });

  test("scopes ticket tools and forwards durable request IDs", async () => {
    const ticket = {
      id: "ticket-1",
      projectId: "project-1",
      title: "Investigate",
      description: "Details",
      acceptanceCriteria: "Fixed",
      status: "backlog",
      comments: [],
      images: [],
      createdAt: new Date(0).toISOString(),
      order: 0,
    };
    overrides.set("get_kanban_tasks", () => [ticket]);
    overrides.set("add_kanban_task", () => ticket);
    overrides.set("update_kanban_task", (_args) => ({ ...ticket, status: "done" }));
    overrides.set("add_kanban_comment", ({ text }) => ({
      ...ticket,
      comments: [{ id: "comment-1", text, createdAt: new Date(0).toISOString() }],
    }));
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);

    const listed = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "list_tickets",
      arguments: { projectId: "project-1" },
    });
    expect(listed.body.result?.structuredContent).toMatchObject({ total: 1 });
    const fetched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_ticket",
      arguments: { projectId: "project-1", ticketId: "ticket-1" },
    });
    expect(fetched.body.result?.structuredContent).toMatchObject({
      ticket: { id: "ticket-1", description: "Details" },
    });

    await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "create_ticket",
      arguments: {
        requestId: "ticket-request-1",
        projectId: "project-1",
        title: "Investigate",
      },
    });
    expect(invocations.find(({ command }) => command === "add_kanban_task")?.args).toMatchObject({
      requestId: "ticket-request-1",
      projectId: "project-1",
    });

    await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "update_ticket",
      arguments: { projectId: "project-1", ticketId: "ticket-1", status: "done" },
    });
    expect(invocations.find(({ command }) => command === "update_kanban_task")?.args).toEqual({
      taskId: "ticket-1",
      status: "done",
    });

    await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "add_ticket_comment",
      arguments: {
        requestId: "comment-request-1",
        projectId: "project-1",
        ticketId: "ticket-1",
        text: "Looks good",
      },
    });
    expect(invocations.find(({ command }) => command === "add_kanban_comment")?.args).toEqual({
      taskId: "ticket-1",
      text: "Looks good",
      projectId: "project-1",
      requestId: "comment-request-1",
    });

    overrides.set("get_kanban_tasks", () => []);
    const rejected = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "update_ticket",
      arguments: { projectId: "project-2", ticketId: "ticket-1", status: "done" },
    });
    expect(rejected.body.result?.isError).toBe(true);
  });

  test("rejects invalid HTTP paths, methods, JSON, and oversized bodies", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const wrongPath = await fetch(descriptor.url.replace(/\/mcp$/, "/missing"), {
      method: "POST",
    });
    expect(wrongPath.status).toBe(404);

    const wrongMethod = await fetch(descriptor.url, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");

    const malformed = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(descriptor.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${descriptor.token}` },
      body: `{"payload":"${"x".repeat(1024 * 1024)}"}`,
    });
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      error: "Control MCP request body is too large",
    });
  });
});
