import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import { registerKanbanCommands } from "./commands-registry-kanban.js";
import { registrarFrom } from "./commands-registry-contracts.js";
import type { CommandHandler } from "./commands-context.js";
import { type ControlMcpServer, readControlMcpDescriptor } from "./control-mcp-server.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import {
  COORDINATOR_ENVIRONMENT_CHOICE_RULE,
  COORDINATOR_PR_RULE,
  COORDINATOR_VALIDATION_RULE,
} from "@orkestrator/protocol/coordinator";
import { rpc, useControlMcpServerHarness } from "./control-mcp-server-test-support.js";

/**
 * Tool listing and instructions, and the project, environment, tab, ticket and
 * node tools in `control-mcp-tools.ts`.
 * The shared server and invoker are in `control-mcp-server-test-support.ts`.
 */
describe("Orkestrator control MCP server", () => {
  const harness = useControlMcpServerHarness();
  const { invocations, overrides, coordinatorCredential } = harness;
  let server: ControlMcpServer;
  beforeEach(() => {
    server = harness.server;
  });

  test("keeps the original operator tools first without leaking project paths", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const listed = await rpc(descriptor.url, descriptor.token, "tools/list");
    expect(listed.response.status).toBe(200);
    // The full profile lists the original tools first; the voice core, the
    // gateway and the direct tools follow (control-mcp-voice.test.ts).
    expect(listed.body.result?.tools?.map(({ name }) => name).slice(0, 21)).toEqual([
      "list_projects",
      "get_launch_options",
      "list_environments",
      "get_environment",
      "list_tabs",
      "list_agents",
      "get_tab_state",
      "get_tab_transcript",
      "list_tickets",
      "get_ticket",
      "create_ticket",
      "update_ticket",
      "add_ticket_comment",
      "list_ticket_labels",
      "create_ticket_label",
      "set_ticket_label",
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

    const coordinator = coordinatorCredential(["discovery"]);
    const projects = await rpc(coordinator.url, coordinator.token, "tools/call", {
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

  test.each(["main", "side"] as const)(
    "PR instructions are gated for the %s coordinator",
    async (role) => {
      const descriptor = coordinatorCredential(coordinatorRoleCapabilities(role));
      const initialized = await rpc(descriptor.url, descriptor.token, "initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      expect(initialized.body.error).toBeUndefined();
      const instructions =
        (initialized.body.result as { instructions?: string })?.instructions ?? "";
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.includes(COORDINATOR_ENVIRONMENT_CHOICE_RULE)).toBe(role === "main");
      expect(instructions.includes(COORDINATOR_PR_RULE)).toBe(role === "main");
      expect(instructions.includes(COORDINATOR_VALIDATION_RULE)).toBe(role === "main");
    },
  );

  test("a coordinator's tools act on another node's copy of the project when given its nodeId", async () => {
    const layout = {
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "startup-agent",
        tabs: [
          { id: "startup-agent", type: "agent-native", nativeAgentData: { platform: "codex" } },
        ],
      },
    };
    const routed: Array<{ command: string; args: Record<string, unknown>; requestKey?: unknown }> =
      [];
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coord-tab", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    overrides.set("get_node_status", () => ({
      nodeId: "bk_self",
      mode: "command",
      controllers: [],
    }));
    overrides.set("get_node_summaries", () => ({
      selfId: "bk_self",
      nodes: [
        {
          nodeId: "bk_leaf",
          available: true,
          view: { displayName: "Build box", connection: { state: "connected" } },
          projects: [
            {
              ref: { backendId: "bk_leaf", projectId: "p-leaf" },
              repositoryHint: "example.invalid/secret/repo",
            },
          ],
          environments: [],
        },
      ],
    }));
    let remoteDefault = "codex";
    overrides.set("invoke_on_node", (args) => {
      const inner = {
        command: String(args.command),
        args: args.args as Record<string, unknown>,
        requestKey: args.requestKey,
      };
      routed.push(inner);
      const answers: Record<string, unknown> = {
        get_environment: { id: inner.args.environmentId, projectId: "p-leaf", status: "running" },
        get_pane_layout: layout,
        get_native_agent_projection: {
          messages: [{ id: "m1", role: "assistant", content: "Done on the leaf." }],
        },
        dispatch_native_agent_intent: { outcome: "accepted" },
        verify_project_launch_base: { contained: true },
        // The node's own launch options.
        get_project: { id: "p-leaf", name: "Orkestrator" },
        get_config: {
          global: {
            enabledAgentPlatforms: ["codex", "claude"],
            agentSettings: { defaultAgent: remoteDefault },
            agentMessaging: { enabled: true },
          },
        },
        get_native_agent_model_catalog: [
          {
            id: "gpt-5.6-codex",
            name: "GPT-5.6 Codex",
            platform: "codex",
            reasoning: [{ id: "high", name: "High" }],
          },
        ],
        get_agent_model_catalog_cache: { schemaVersion: 1 },
        get_repository_config: {},
        get_environment_snapshots: [],
      };
      return { outcome: "ok", result: answers[inner.command] ?? null };
    });
    overrides.set("assert_coordinator_node_delegation_available", () => ({ available: true }));
    overrides.set("open_coordinator_node_delegation", () => ({ opened: true }));
    overrides.set("launch_coordinator_node_environment", () => ({
      environment: { id: "leaf-new", status: "creating" },
      coordinatorDelegationOpened: true,
    }));
    overrides.set("send_coordinator_node_mail", (args) => ({
      nodeId: args.nodeId,
      toEnvironmentId: args.toEnvironmentId,
      coordinatorDelegationOpened: true,
    }));
    overrides.set("get_agent_mail_message", () => ({
      id: "msg-1",
      from: {
        kind: "node",
        nodeId: "bk_leaf",
        nodeName: "Build box",
        role: "agent",
        projectId: "project-1",
        environmentId: "leaf-env",
        tabId: "startup-agent",
        title: null,
      },
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["environments", "jobs", "mail", "discovery"],
    });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await rpc(credential.url, credential.token, "tools/call", {
        name,
        arguments: args,
      });
      if (result.body.result?.isError) throw new Error(JSON.stringify(result.body.result));
      return result.body.result!.structuredContent!;
    };

    const transcript = await call("get_tab_transcript", {
      environmentId: "leaf-env",
      tabId: "startup-agent",
      nodeId: "bk_leaf",
    });
    expect(transcript).toMatchObject({ nodeId: "bk_leaf", node: "Build box", agent: "codex" });
    expect(JSON.stringify(transcript.messages)).toContain("Done on the leaf.");

    const prompted = await call("send_prompt_to_tab", {
      requestId: "prompt-remote",
      environmentId: "leaf-env",
      tabId: "startup-agent",
      prompt: "Run the tests.",
      nodeId: "bk_leaf",
    });
    expect(prompted).toMatchObject({ nodeId: "bk_leaf", delivery: "async" });
    expect(routed.find((entry) => entry.command === "dispatch_native_agent_intent")).toMatchObject({
      args: { environmentId: "leaf-env", logicalSessionKey: "env-leaf-env:startup-agent" },
      requestKey: "prompt:prompt-remote",
    });
    expect(
      invocations.find(({ command }) => command === "open_coordinator_node_delegation")?.args,
    ).toMatchObject({ nodeId: "bk_leaf", environmentId: "leaf-env", tabId: "startup-agent" });
    // The node's own dispatch never ran here.
    expect(invocations.some(({ command }) => command === "dispatch_native_agent_intent")).toBe(
      false,
    );

    const launched = await call("launch_environment", {
      requestId: "launch-remote",
      projectId: "project-1",
      agent: "codex",
      prompt: "Fix it.",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      nodeId: "bk_leaf",
    });
    expect(launched).toMatchObject({ environmentId: "leaf-new", nodeId: "bk_leaf" });
    expect(routed.find((entry) => entry.command === "verify_project_launch_base")?.args).toEqual({
      projectId: "p-leaf",
      branch: "main",
      commit: "a".repeat(40),
    });
    expect(
      invocations.find(({ command }) => command === "launch_coordinator_node_environment")?.args,
    ).toMatchObject({ nodeId: "bk_leaf", requestId: "launch-remote" });

    remoteDefault = "claude";
    const saved = {
      id: "leaf-new",
      projectId: "p-leaf",
      agentSettings: { defaultAgent: "codex" },
      startupAgentSession: { agent: "codex", model: "original-model", reasoningEffort: "high" },
    };
    overrides.set("get_coordinator_node_launch_environment", () => saved);
    overrides.set("launch_coordinator_node_environment", () => ({
      environment: saved,
      replayed: true,
    }));
    const replay = await call("launch_environment", {
      requestId: "launch-remote",
      projectId: "project-1",
      prompt: "Fix it.",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      nodeId: "bk_leaf",
    });
    expect(replay).toMatchObject({
      replayed: true,
      selection: { agent: "codex", model: "original-model", reasoning: "high" },
    });

    // A reply to an agent on another node goes back across the node link.
    await call("send_message", {
      requestId: "reply-remote",
      toEnvironmentId: "coordinator",
      replyToMessageId: "msg-1",
      body: "Thanks; now lint.",
    });
    expect(
      invocations.find(({ command }) => command === "send_coordinator_node_mail")?.args,
    ).toMatchObject({
      nodeId: "bk_leaf",
      toEnvironmentId: "leaf-env",
      toTabId: "startup-agent",
      body: "Thanks; now lint.",
    });

    // This node's own ID is this node.
    overrides.set("get_pane_layout", () => layout);
    routed.length = 0;
    await call("list_tabs", { environmentId: "env-1", nodeId: "bk_self" });
    expect(routed).toEqual([]);
  });

  test("only a coordinator may name a node", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const result = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "list_tabs",
      arguments: { environmentId: "env-1", nodeId: "bk_leaf" },
    });
    expect(result.body.result?.isError).toBe(true);
    expect(invocations.some(({ command }) => command === "invoke_on_node")).toBe(false);
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
    const descriptor = coordinatorCredential(["discovery", "jobs"]);
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
      invocations.find(({ command }) => command === "open_coordinator_delegation")?.args,
    ).toMatchObject({ request: { summary: "Continue.", agent: "codex" } });
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

  test("coordinator credentials create, list, assign, filter and remove ticket labels", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "coordinator-labels-"));
    const storage = new StorageService(dir);
    await storage.init();
    const commands = new Map<string, CommandHandler>();
    registerKanbanCommands(
      registrarFrom((name, handler) => commands.set(name, handler)),
      {} as never,
    );
    for (const name of ["get_kanban_labels", "create_kanban_label", "set_kanban_task_label"]) {
      overrides.set(name, (args) => commands.get(name)!(args, { storage } as never));
    }
    overrides.set("get_kanban_tasks", ({ projectId }) =>
      storage.kanban.getKanbanTasks(projectId as string),
    );
    const descriptor = coordinatorCredential(["discovery", "tickets"]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await rpc(descriptor.url, descriptor.token, "tools/call", {
        name,
        arguments: { projectId: "project-1", ...args },
      });
      expect(result.body.error).toBeUndefined();
      return result.body.result;
    };
    try {
      expect((await call("list_ticket_labels", {}))?.structuredContent).toEqual({
        labels: [],
        total: 0,
      });
      const created = await call("create_ticket_label", {
        requestId: "label",
        name: "Needs  design",
        color: "#A855F7",
        description: "Waiting",
      });
      expect(created?.structuredContent).toMatchObject({
        label: { name: "Needs design", color: "#a855f7", description: "Waiting" },
        created: true,
      });
      const task = await storage.kanban.addKanbanTask("project-1", "Ticket", "");
      await storage.kanban.addKanbanTask("project-1", "Unlabelled", "");
      expect(
        (await call("set_ticket_label", { ticketId: task.id, name: "needs design" }))
          ?.structuredContent,
      ).toMatchObject({ ticket: { labels: ["Needs design"] } });
      for (const label of ["NEEDS DESIGN", " needs  design ", "needs\tdesign"]) {
        expect((await call("list_tickets", { label }))?.structuredContent).toMatchObject({
          total: 1,
          tickets: [{ id: task.id, labels: ["Needs design"] }],
        });
      }
      expect((await call("list_ticket_labels", {}))?.structuredContent).toMatchObject({
        labels: [{ name: "Needs design", ticketCount: 1 }],
        total: 1,
      });
      expect(
        (
          await call("set_ticket_label", {
            ticketId: task.id,
            name: "NEEDS DESIGN",
            present: false,
          })
        )?.structuredContent,
      ).toMatchObject({ ticket: { labels: [] } });
      expect(
        (await call("list_tickets", { label: "needs design" }))?.structuredContent,
      ).toMatchObject({ total: 0, tickets: [] });
      const elsewhere = await storage.kanban.addKanbanTask("project-2", "Elsewhere", "");
      expect(
        (await call("set_ticket_label", { ticketId: elsewhere.id, name: "bug" }))?.isError,
      ).toBe(true);
      expect((await storage.kanban.getKanbanTask(elsewhere.id))?.labels).toBeUndefined();
    } finally {
      storage.close();
      await rm(dir, { recursive: true, force: true });
    }
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
    const descriptor = coordinatorCredential(["discovery", "tickets"]);

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

  test("a coordinator re-listing unchanged environments is told it is polling", async () => {
    let worker: Record<string, unknown> = {
      id: "env-worker",
      projectId: "project-1",
      name: "worker",
      status: "running",
      agentActivityState: "working",
      lastActivityAt: "2026-10-25T10:00:00.000Z",
    };
    overrides.set("get_environment_snapshots", () => [worker]);
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          {
            id: "conversation-list",
            tabId: "coordinator-tab",
            mailboxIncarnationId: "incarnation-1",
          },
        ],
      },
    }));
    let remoteActivity = "working";
    let remoteAvailable = true;
    overrides.set("get_node_status", () => ({
      nodeId: "bk_self",
      mode: "command",
      controllers: [],
    }));
    overrides.set("get_node_summaries", () => ({
      selfId: "bk_self",
      nodes: [
        {
          nodeId: "bk_leaf",
          available: remoteAvailable,
          view: { displayName: "Build box" },
          projects: [
            {
              ref: { backendId: "bk_leaf", projectId: "p-leaf" },
              repositoryHint: "example.invalid/secret/repo",
            },
          ],
          environments: [
            {
              ref: { environmentId: "remote-worker" },
              projectId: "p-leaf",
              name: "Remote worker",
              status: "running",
              activity: remoteActivity,
            },
          ],
        },
      ],
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-list",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "environments"],
    });
    const list = async (args: Record<string, unknown> = {}) =>
      (
        await rpc(credential.url, credential.token, "tools/call", {
          name: "list_environments",
          arguments: args,
        })
      ).body.result?.structuredContent as Record<string, unknown> | undefined;

    // A worker still working moves its activity timestamp; that is not news.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      worker = { ...worker, lastActivityAt: `2026-10-25T10:00:0${attempt + 1}.000Z` };
      expect(await list()).not.toHaveProperty("repeatedRead");
    }
    const polled = await list();
    expect(polled).toMatchObject({
      total: 1,
      environments: [{ id: "env-worker", agentActivityState: "working" }],
      otherNodes: [
        {
          nodeId: "bk_leaf",
          available: true,
          environments: [{ environmentId: "remote-worker", activity: "working" }],
        },
      ],
      repeatedRead: true,
    });
    expect(String(polled?.instruction)).toContain("Do not wait, sleep, poll");

    // A different question is not the same poll, and a real change clears it.
    expect(await list({ status: "running" })).not.toHaveProperty("repeatedRead");
    remoteActivity = "waiting";
    expect(await list()).not.toHaveProperty("repeatedRead");
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await list()).not.toHaveProperty("repeatedRead");
    expect(await list()).toHaveProperty("repeatedRead", true);
    remoteAvailable = false;
    expect(await list()).not.toHaveProperty("repeatedRead");
    worker = { ...worker, agentActivityState: "idle" };
    expect(await list()).not.toHaveProperty("repeatedRead");
  });

  test("coordinator environment reads carry PR readiness, and its change is a new answer", async () => {
    const prUrl = "https://github.com/org/repo/pull/7";
    let worker: Record<string, unknown> = {
      id: "env-worker",
      projectId: "project-1",
      name: "worker",
      status: "running",
      agentActivityState: "idle",
      prUrl,
      prState: "open",
      hasMergeConflicts: false,
      prMergeability: "clean",
    };
    let checks = { passed: 2, total: 3, pending: 1 };
    let remote: Record<string, unknown> = {
      ref: { environmentId: "remote-worker" },
      projectId: "p-leaf",
      name: "Remote worker",
      status: "running",
      activity: "idle",
      prState: "open",
      prHasMergeConflicts: false,
      prMergeability: "clean",
      prMonitorConfirmed: true,
    };
    overrides.set("get_environment_snapshots", () => [worker]);
    overrides.set("get_environment", () => worker);
    overrides.set("get_environment_pr_health", ({ projectId, environmentIds }) => {
      expect(projectId).toBe("project-1");
      expect(environmentIds).toEqual(["env-worker"]);
      return { "env-worker": { prMonitorConfirmed: true, prCheckSummary: checks } };
    });
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          {
            id: "conversation-pr",
            tabId: "coordinator-tab",
            mailboxIncarnationId: "incarnation-1",
          },
        ],
      },
    }));
    overrides.set("get_node_status", () => ({
      nodeId: "bk_self",
      mode: "command",
      controllers: [],
    }));
    overrides.set("get_node_summaries", () => ({
      selfId: "bk_self",
      nodes: [
        {
          nodeId: "bk_leaf",
          available: true,
          freshness: "current",
          view: { displayName: "Build box" },
          projects: [
            {
              ref: { backendId: "bk_leaf", projectId: "p-leaf" },
              repositoryHint: "example.invalid/secret/repo",
            },
          ],
          environments: [remote],
        },
      ],
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-pr",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "environments"],
    });
    const callTool = async (name: string, args: Record<string, unknown> = {}) =>
      (
        await rpc(credential.url, credential.token, "tools/call", {
          name,
          arguments: args,
        })
      ).body.result?.structuredContent as Record<string, unknown> | undefined;
    const list = () => callTool("list_environments");

    expect(await list()).toMatchObject({
      environments: [
        {
          id: "env-worker",
          prUrl,
          prState: "open",
          prHasMergeConflicts: false,
          prMergeability: "clean",
          prChecks: { passed: 2, failed: 0, pending: 1, total: 3 },
          prReadyToMerge: false,
          prNotReadyReason: "checks-pending",
        },
      ],
      otherNodes: [
        {
          nodeId: "bk_leaf",
          environments: [
            {
              environmentId: "remote-worker",
              prState: "open",
              prHasMergeConflicts: false,
              prReadyToMerge: true,
            },
          ],
        },
      ],
    });
    expect(await callTool("get_environment", { environmentId: "env-worker" })).toMatchObject({
      environment: { prChecks: { failed: 0, pending: 1 }, prReadyToMerge: false },
    });
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await list()).not.toHaveProperty("repeatedRead");
    expect(await list()).toHaveProperty("repeatedRead", true);

    // The checks finishing is news, even with nothing else changed.
    checks = { passed: 3, total: 3, pending: 0 };
    const ready = await list();
    expect(ready).not.toHaveProperty("repeatedRead");
    expect(ready).toMatchObject({
      environments: [{ prReadyToMerge: true, prChecks: { passed: 3 } }],
    });
    for (let attempt = 0; attempt < 2; attempt += 1) await list();
    expect(await list()).toHaveProperty("repeatedRead", true);

    // So is another node's PR starting to conflict.
    remote = { ...remote, prHasMergeConflicts: true, prMergeability: "dirty" };
    const conflicting = await list();
    expect(conflicting).not.toHaveProperty("repeatedRead");
    expect(conflicting).toMatchObject({
      otherNodes: [
        {
          environments: [
            { prHasMergeConflicts: true, prReadyToMerge: false, prNotReadyReason: "conflicts" },
          ],
        },
      ],
    });
    worker = { ...worker, prMergeability: "behind" };
    expect(await list()).not.toHaveProperty("repeatedRead");
  });

  test("list_agents and get_environment are guarded too, and the description asks for no polling", async () => {
    let state = "working";
    overrides.set("get_agent_registry", () => ({
      entries: [{ environmentId: "env-1", tabId: "agent-1", state, ownerKind: "environment" }],
      environments: [],
    }));
    const credential = coordinatorCredential(["discovery", "environments"]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await rpc(credential.url, credential.token, "tools/call", { name, arguments: args })).body
        .result?.structuredContent as Record<string, unknown> | undefined;
    for (let read = 0; read < 3; read += 1) {
      expect(await call("list_agents")).not.toHaveProperty("repeatedRead");
    }
    expect(await call("list_agents")).toHaveProperty("repeatedRead", true);
    state = "idle";
    expect(await call("list_agents")).not.toHaveProperty("repeatedRead");

    for (let read = 0; read < 3; read += 1) {
      expect(await call("get_environment", { environmentId: "env-1" })).not.toHaveProperty(
        "repeatedRead",
      );
    }
    expect(await call("get_environment", { environmentId: "env-1" })).toMatchObject({
      environment: { id: "env-1" },
      repeatedRead: true,
    });

    const listed = await rpc(credential.url, credential.token, "tools/list", {});
    const tools = (listed.body.result?.tools ?? []) as Array<{ name: string; description: string }>;
    const description = tools.find((tool) => tool.name === "list_agents")?.description;
    expect(description).not.toContain("instead of polling");
    expect(description).toContain("not to wait");
  });

  test("get_tab_state and list_workflows flag an unchanged re-read only", async () => {
    let phase = "running";
    let revision = 1;
    overrides.set("get_pane_layout", () => ({
      activePaneId: "pane-1",
      root: {
        kind: "leaf",
        id: "pane-1",
        activeTabId: "native-1",
        tabs: [{ id: "native-1", type: "agent-native", nativeAgentData: { platform: "codex" } }],
      },
    }));
    overrides.set("get_native_agent_projection", () => ({
      connection: "connected",
      turn: { phase },
      interactions: [],
      // Streaming moves the revision on every event; that is not news.
      revision: (revision += 1),
      messages: [],
    }));
    const credential = coordinatorCredential(["discovery", "environments"]);
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      (await rpc(credential.url, credential.token, "tools/call", { name, arguments: args })).body
        .result?.structuredContent as Record<string, unknown> | undefined;
    const tab = { environmentId: "env-1", tabId: "native-1" };
    for (let read = 0; read < 3; read += 1) {
      expect(await call("get_tab_state", tab)).not.toHaveProperty("repeatedRead");
    }
    expect(await call("get_tab_state", tab)).toHaveProperty("repeatedRead", true);
    phase = "idle";
    expect(await call("get_tab_state", tab)).not.toHaveProperty("repeatedRead");

    for (let read = 0; read < 3; read += 1) {
      expect(await call("list_workflows", { openOnly: true })).not.toHaveProperty("repeatedRead");
    }
    expect(await call("list_workflows", { openOnly: true })).toHaveProperty("repeatedRead", true);
  });
});
