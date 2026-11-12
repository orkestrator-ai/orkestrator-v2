import { beforeEach, describe, expect, test } from "bun:test";
import { AGENT_MAIL_MAX_ATTACHMENTS } from "@orkestrator/protocol/agent-mail";
import { type ControlMcpServer, readControlMcpDescriptor } from "./server.js";
import { rpc, useControlMcpServerHarness } from "./server-test-support.js";

/**
 * The agent mail tools in `tools.ts` and the coordinator's delegation
 * wake contract.
 * The shared server and invoker are in `server-test-support.ts`.
 */
describe("Orkestrator control MCP server", () => {
  const harness = useControlMcpServerHarness();
  const { invocations, overrides, coordinatorCredential } = harness;
  let server: ControlMcpServer;
  beforeEach(() => {
    server = harness.server;
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

  test("a coordinator reads and acknowledges only its own conversation's mailbox", async () => {
    const credential = coordinatorCredential(["discovery", "mail"]);
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
          { id: "conversation-2", tabId: "other-tab", mailboxIncarnationId: "incarnation-2" },
        ],
      },
    }));
    overrides.set("get_agent_mail_mailbox", () => ({ messages: [], total: 0 }));
    overrides.set("get_agent_mail_message", () => ({ id: "message-1", body: "hello" }));
    overrides.set("ack_agent_mail", () => ({ id: "message-1", body: "hello" }));
    const own = {
      environmentId: "coordinator:coordinator-1:conversation-1",
      tabId: "coordinator-tab",
    };
    const other = { environmentId: "coordinator:coordinator-1:conversation-2", tabId: "other-tab" };
    const call = (name: string, args: Record<string, unknown>) =>
      rpc(credential.url, credential.token, "tools/call", { name, arguments: args });
    const reached = () =>
      invocations.filter(({ command }) =>
        ["get_agent_mail_mailbox", "get_agent_mail_message", "ack_agent_mail"].includes(command),
      ).length;

    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ["read_messages", other, "Coordinator credential may only read its own mailbox"],
      ["read_messages", { ...own, tabId: "other-tab" }, "may only read its own mailbox"],
      ["get_message", { ...other, messageId: "message-1" }, "may only read its own mailbox"],
      [
        "ack_message",
        { ...other, messageId: "message-1" },
        "Coordinator credential may only acknowledge its own mailbox",
      ],
      [
        "ack_message",
        { ...own, environmentId: "env-1", messageId: "message-1" },
        "may only acknowledge its own mailbox",
      ],
    ];
    for (const [name, args, text] of refusals) {
      const refused = await call(name, args);
      expect(refused.body.result?.isError).toBe(true);
      expect(JSON.stringify(refused.body.result)).toContain(text);
    }
    expect(reached()).toBe(0);

    for (const [name, args] of [
      ["read_messages", own],
      ["get_message", { ...own, messageId: "message-1" }],
      ["ack_message", { ...own, messageId: "message-1" }],
    ] as const) {
      const allowed = await call(name, args);
      expect(allowed.body.result?.isError).not.toBe(true);
    }
    expect(reached()).toBe(3);
  });

  test("coordinator delegation tools promise a wake and refuse a poll loop", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
        repositoryStatus: {
          branch: "main",
          headCommit: "a".repeat(40),
          detached: false,
          unborn: false,
        },
      },
    }));
    overrides.set("get_project_git_status", () => ({
      branch: "main",
      headCommit: "a".repeat(40),
      trackedChanges: 0,
      untrackedChanges: 0,
    }));
    overrides.set("launch_coordinator_environment", () => ({
      environment: { id: "env-worker", projectId: "project-1", status: "running" },
      coordinatorDelegationOpened: true,
    }));
    const opened: Array<Record<string, unknown>> = [];
    overrides.set("open_coordinator_delegation", (args) => {
      opened.push(args);
      return { opened: true };
    });
    let mailbox: Record<string, unknown> = {
      messages: [{ id: "message-1", placement: "injected" }],
      total: 1,
    };
    overrides.set("get_agent_mail_mailbox", () => mailbox);

    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "environments", "jobs", "mail"],
    });

    const listed = await rpc(credential.url, credential.token, "tools/list");
    const launchTool = listed.body.result?.tools?.find(
      (tool) => tool.name === "launch_environment",
    ) as
      | {
          description?: string;
          inputSchema?: {
            required?: string[];
            properties?: Record<string, { description?: string }>;
          };
        }
      | undefined;
    expect(launchTool?.description).toContain(
      "Coordinator launches require baseBranch and baseCommit from get_launch_options",
    );
    expect(launchTool?.description).toContain(
      "when the whole spec is known, start a pipeline environment with start_build_pipeline instead",
    );
    expect(launchTool?.inputSchema?.required).toEqual(
      expect.arrayContaining(["baseBranch", "baseCommit"]),
    );
    expect(launchTool?.inputSchema?.properties?.baseBranch?.description).toContain(
      "coordinatorBase.baseBranch",
    );
    // Leaving the model and effort out is the stated default, on the tool and
    // on each field, so a coordinator does not fill them in by habit.
    for (const name of ["launch_environment", "launch_job"]) {
      const tool = listed.body.result?.tools?.find((candidate) => candidate.name === name) as
        | {
            description?: string;
            inputSchema?: { properties?: Record<string, { description?: string }> };
          }
        | undefined;
      expect(tool?.description).toContain(
        "Omit agent, modelId and reasoningId to use the user's configured defaults",
      );
      expect(tool?.inputSchema?.properties?.modelId?.description).toContain(
        "Omit to use the user's configured default model",
      );
      expect(tool?.inputSchema?.properties?.reasoningId?.description).toContain(
        "Omit to use the user's configured default effort",
      );
    }

    const gitStatusBeforeLaunchOptions = invocations.filter(
      ({ command }) => command === "get_project_git_status",
    ).length;
    const launchOptions = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(launchOptions.body.result?.structuredContent).toMatchObject({
      coordinatorBase: {
        baseBranch: "main",
        baseCommit: "a".repeat(40),
        available: true,
        requiredFor: "launch_environment",
      },
    });
    expect(invocations.filter(({ command }) => command === "get_project_git_status")).toHaveLength(
      gitStatusBeforeLaunchOptions,
    );

    const launched = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "launch-1",
        projectId: "project-1",
        agent: "codex",
        prompt: "Fix the failing test.",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
      },
    });
    // The tool answers the question the model is about to ask anyway.
    expect(launched.body.result?.structuredContent).toMatchObject({
      environmentId: "env-worker",
      delivery: "async",
      nextStep: "Finish your turn now. Do not poll.",
    });
    const read = async () =>
      rpc(credential.url, credential.token, "tools/call", {
        name: "read_messages",
        arguments: {
          environmentId: "coordinator:coordinator-1:conversation-1",
          tabId: "coordinator-tab",
        },
      });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const page = await read();
      expect(page.body.result?.structuredContent).toMatchObject({ total: 1 });
    }
    // Fourth identical answer still carries the authorized page while warning
    // the coordinator that it is polling.
    const refused = await read();
    expect(refused.body.result?.structuredContent).toMatchObject({
      total: 1,
      messages: [{ id: "message-1" }],
      repeatedRead: true,
    });

    const differentlyFiltered = await rpc(credential.url, credential.token, "tools/call", {
      name: "read_messages",
      arguments: {
        environmentId: "coordinator:coordinator-1:conversation-1",
        tabId: "coordinator-tab",
        unreadOnly: true,
      },
    });
    expect(differentlyFiltered.body.result?.structuredContent).not.toHaveProperty("repeatedRead");
    // A different page size is the same question, so it does not reset the count.
    const resized = await rpc(credential.url, credential.token, "tools/call", {
      name: "read_messages",
      arguments: {
        environmentId: "coordinator:coordinator-1:conversation-1",
        tabId: "coordinator-tab",
        limit: 5,
      },
    });
    expect(resized.body.result?.structuredContent).toHaveProperty("repeatedRead", true);

    // Real new mail clears the guard immediately; the budget never hides it.
    mailbox = {
      messages: [
        { id: "message-1", placement: "injected" },
        { id: "message-2", placement: "pending-inject" },
      ],
      total: 2,
    };
    const afterNewMail = await read();
    expect(afterNewMail.body.result?.structuredContent).toMatchObject({ total: 2 });

    overrides.set("send_coordinator_agent_mail", () => ({
      id: "stored-message",
      requestId: "stored-message",
      placement: "stored",
      coordinatorDelegationOpened: false,
    }));
    const stored = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "stored-message",
        toEnvironmentId: "env-1",
        toTabId: "plain-tab",
        body: "This cannot enter a worker turn.",
      },
    });
    expect(stored.body.result?.structuredContent).not.toHaveProperty("delivery");

    overrides.set("send_coordinator_agent_mail", () => ({
      id: "bounced-message",
      requestId: "bounced-message",
      placement: "bounced",
      coordinatorDelegationOpened: false,
    }));
    const bounced = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "bounced-message",
        toEnvironmentId: "env-1",
        toTabId: "muted-tab",
        body: "This recipient is muted.",
      },
    });
    expect(bounced.body.result?.structuredContent).not.toHaveProperty("delivery");

    overrides.set("open_coordinator_delegation", (args) => {
      opened.push(args);
      throw new Error("storage unavailable");
    });
    const jobWithoutWake = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_job",
      arguments: {
        requestId: "job-without-wake",
        environmentId: "env-1",
        agent: "codex",
        prompt: "Do the work.",
      },
    });
    expect(jobWithoutWake.body.result?.structuredContent).not.toHaveProperty("delivery");
    expect(opened.at(-1)).toMatchObject({
      environmentId: "env-1",
      tabId: "agent-job-job-1",
      requestId: "job-without-wake",
    });

    overrides.set("launch_control_job", () => ({
      jobId: "job-without-tab",
      environmentId: "env-1",
      status: "accepted",
    }));
    const jobWithoutTab = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_job",
      arguments: {
        requestId: "job-without-tab",
        environmentId: "env-1",
        agent: "codex",
        prompt: "Do the work.",
      },
    });
    expect(jobWithoutTab.body.result?.structuredContent).not.toHaveProperty("delivery");

    overrides.set("assert_coordinator_delegation_available", () => {
      throw new Error("That worker tab already has an outstanding coordinator delegation");
    });
    overrides.set("get_pane_layout", () => ({
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
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
    const dispatchesBeforeConflict = invocations.filter(
      ({ command }) => command === "dispatch_native_agent_intent",
    ).length;
    const conflictingPrompt = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_prompt_to_tab",
      arguments: {
        requestId: "conflicting-prompt",
        environmentId: "env-1",
        tabId: "native-1",
        prompt: "Do not dispatch this.",
      },
    });
    expect(conflictingPrompt.body.result?.isError).toBe(true);
    expect(
      invocations.filter(({ command }) => command === "dispatch_native_agent_intent"),
    ).toHaveLength(dispatchesBeforeConflict);

    overrides.set("launch_coordinator_environment", () => ({
      environment: { id: "env-no-wake", projectId: "project-1", status: "running" },
      coordinatorDelegationOpened: false,
    }));
    const launchWithoutWake = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "launch-without-wake",
        projectId: "project-1",
        agent: "codex",
        prompt: "Do the work.",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
      },
    });
    expect(launchWithoutWake.body.result?.structuredContent).not.toHaveProperty("delivery");
  });

  test("coordinator send_message forwards deliverNow and reports what happened", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    overrides.set("send_coordinator_agent_mail", (args) => ({
      id: "message-1",
      requestId: args.requestId,
      placement: "injected",
      body: "never echoed",
      coordinatorDelegationOpened: true,
      ...(args.deliverNow === true
        ? { deliverNow: "steered", deliverNowNote: "Steered into the worker's running turn." }
        : {}),
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["mail"],
    });

    const listed = await rpc(credential.url, credential.token, "tools/list");
    const sendTool = listed.body.result?.tools?.find((tool) => tool.name === "send_message") as
      | {
          description?: string;
          inputSchema?: { required?: string[]; properties?: Record<string, { type?: string }> };
        }
      | undefined;
    expect(sendTool?.inputSchema?.properties?.deliverNow?.type).toBe("boolean");
    expect(sendTool?.inputSchema?.required).not.toContain("deliverNow");
    expect(sendTool?.description).toContain("course correction");

    const steered = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "steer-1",
        toEnvironmentId: "env-1",
        body: "Stop: the requirement changed.",
        deliverNow: true,
      },
    });
    expect(
      invocations.findLast(({ command }) => command === "send_coordinator_agent_mail")?.args,
    ).toMatchObject({ requestId: "steer-1", deliverNow: true });
    expect(steered.body.result?.structuredContent).toMatchObject({
      deliverNow: "steered",
      deliverNowNote: "Steered into the worker's running turn.",
      message: { id: "message-1", placement: "injected" },
    });
    expect(steered.body.result?.structuredContent?.message).not.toHaveProperty("deliverNow");
    expect(steered.body.result?.structuredContent?.message).not.toHaveProperty("body");

    // Left out, nothing is asked of the delivery and the result has no claim.
    const routine = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: { requestId: "routine-1", toEnvironmentId: "env-1", body: "Routine." },
    });
    expect(
      invocations.findLast(({ command }) => command === "send_coordinator_agent_mail")?.args,
    ).not.toHaveProperty("deliverNow");
    expect(routine.body.result?.structuredContent).not.toHaveProperty("deliverNow");
  });

  test("coordinator send_message whose delegation did not open warns that no wake will come, and is still sent", async () => {
    const note =
      "The message was sent, but no delegation was opened, so you will not be woken when the worker answers. Why: the coordinator workflow store is full.";
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    overrides.set("send_coordinator_agent_mail", (args) => ({
      id: "message-1",
      requestId: args.requestId,
      placement: "pending-inject",
      coordinatorDelegationOpened: false,
      delegationNote: note,
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["mail"],
    });
    const sent = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: { requestId: "store-full-1", toEnvironmentId: "env-1", body: "Go." },
    });
    expect(sent.body.result?.isError).not.toBe(true);
    expect(sent.body.result?.structuredContent).toMatchObject({
      warning: note,
      message: { id: "message-1", placement: "pending-inject" },
    });
    expect(sent.body.result?.structuredContent?.message).not.toHaveProperty("delegationNote");
    // No wake was promised, so nothing tells the coordinator to wait for one.
    expect(sent.body.result?.structuredContent).not.toHaveProperty("wake");
    expect(sent.body.result?.structuredContent).not.toHaveProperty("delivery");
  });

  test("coordinator send_message to the project home forwards the reason and reports a held message or a warning", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    let held = true;
    overrides.set("send_coordinator_agent_mail", (args) =>
      held
        ? {
            projectHome: true,
            sent: false,
            state: "pending",
            approvalRequestId: "project-home-message-1",
            toEnvironmentId: args.toEnvironmentId,
            note: "Not sent yet.",
          }
        : {
            id: "message-1",
            requestId: args.requestId,
            placement: "pending-inject",
            body: "never echoed",
            coordinatorDelegationOpened: true,
            projectHome: true,
            projectHomeWarning: "Sent to the project home. This is discouraged.",
          },
    );
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["mail"],
    });
    const listed = await rpc(credential.url, credential.token, "tools/list");
    const sendTool = listed.body.result?.tools?.find((tool) => tool.name === "send_message") as
      | { inputSchema?: { required?: string[]; properties?: Record<string, { type?: string }> } }
      | undefined;
    expect(sendTool?.inputSchema?.properties?.projectHomeReason?.type).toBe("string");
    expect(sendTool?.inputSchema?.required).not.toContain("projectHomeReason");

    const arguments_ = {
      requestId: "home-1",
      toEnvironmentId: "home",
      body: "Rebase the checkout.",
      projectHomeReason: "The user asked for their own checkout.",
    };
    const pending = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: arguments_,
    });
    expect(
      invocations.findLast(({ command }) => command === "send_coordinator_agent_mail")?.args,
    ).toMatchObject({ projectHomeReason: "The user asked for their own checkout." });
    expect(pending.body.result?.structuredContent).toMatchObject({
      projectHomeApproval: { state: "pending", approvalRequestId: "project-home-message-1" },
      delivery: "async",
    });
    expect(pending.body.result?.structuredContent).not.toHaveProperty("message");

    held = false;
    const sent = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: arguments_,
    });
    expect(sent.body.result?.structuredContent).toMatchObject({
      warning: "Sent to the project home. This is discouraged.",
      message: { id: "message-1" },
    });
    expect(sent.body.result?.structuredContent?.message).not.toHaveProperty("projectHomeWarning");
  });

  test("remote send_message lifts delegation failure into a successful warning", async () => {
    const credential = coordinatorCredential(["mail", "discovery"]);
    overrides.set("get_node_status", () => ({
      nodeId: "bk_cmd",
      mode: "command",
      controllers: [],
    }));
    overrides.set("get_node_summaries", () => ({
      selfId: "bk_cmd",
      nodes: [
        {
          nodeId: "bk_leaf",
          available: true,
          view: { displayName: "Leaf" },
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
    overrides.set("send_coordinator_node_mail", () => ({
      id: "remote-message",
      placement: "pending-inject",
      coordinatorDelegationOpened: false,
      delegationNote: "Sent, but no delegation opened.",
    }));
    const sent = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "remote-warning",
        nodeId: "bk_leaf",
        toEnvironmentId: "leaf-env",
        body: "Go.",
      },
    });
    expect(sent.body.result?.isError).not.toBe(true);
    expect(sent.body.result?.structuredContent).toMatchObject({
      warning: "Sent, but no delegation opened.",
      message: { id: "remote-message" },
    });
    expect(sent.body.result?.structuredContent?.message).not.toHaveProperty("delegationNote");
  });

  // A leaf without `node-mail-steer` answers with no outcome of its own.
  for (const [placement, reason, outcome, leafOutcome] of [
    ["pending-inject", undefined, "unsupported, queued"],
    ["stored", "inject-policy-off", "not queued"],
    ["bounced", "recipient-muted", "not queued"],
    ["inject-held", "loop-budget-exhausted", "not queued"],
    ["inject-held", "hourly-limit", "not queued"],
    ["injected", undefined, "steered", "steered"],
    ["pending-inject", "verifying", "verifying", "verifying"],
  ]) {
    test(`remote deliverNow reports ${placement} ${reason ?? ""} ${leafOutcome ? "from the leaf" : "for an older leaf"}`, async () => {
      const credential = coordinatorCredential(["mail", "discovery"]);
      overrides.set("get_node_status", () => ({
        nodeId: "bk_cmd",
        mode: "command",
        controllers: [],
      }));
      overrides.set("get_node_summaries", () => ({
        selfId: "bk_cmd",
        nodes: [
          {
            nodeId: "bk_leaf",
            available: true,
            view: { displayName: "Build box" },
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
      overrides.set("send_coordinator_node_mail", (args) => ({
        nodeId: args.nodeId,
        messageId: "leaf-message",
        placement,
        placementReason: reason,
        ...(leafOutcome
          ? { deliverNow: leafOutcome, deliverNowNote: `Leaf: ${leafOutcome}.` }
          : {}),
      }));
      const sent = await rpc(credential.url, credential.token, "tools/call", {
        name: "send_message",
        arguments: {
          nodeId: "bk_leaf",
          requestId: "remote-correction",
          toEnvironmentId: "leaf-env",
          body: "Correction.",
          deliverNow: true,
        },
      });
      expect(sent.body.result?.isError).not.toBe(true);
      expect(sent.body.result?.structuredContent).toMatchObject({
        deliverNow: outcome,
        message: { messageId: "leaf-message", placement },
      });
      expect(sent.body.result?.structuredContent?.message).not.toHaveProperty("deliverNow");
      if (leafOutcome) {
        expect(sent.body.result?.structuredContent?.deliverNowNote).toBe(`Leaf: ${leafOutcome}.`);
      } else if (reason) {
        expect(sent.body.result?.structuredContent?.deliverNowNote).toContain(reason);
      }
      // The command node decides whether the leaf can take it.
      const forwarded = invocations.findLast(
        ({ command }) => command === "send_coordinator_node_mail",
      );
      expect(forwarded?.args).toMatchObject({
        requestId: "remote-correction",
        nodeId: "bk_leaf",
        deliverNow: true,
      });
    });
  }

  test("coordinators are told they can pass on a pasted image, and the backend does the copying", async () => {
    const credential = coordinatorCredential(["mail", "discovery", "environments"]);
    const listed = await rpc(credential.url, credential.token, "tools/list");
    const tool = (name: string) => listed.body.result?.tools?.find((entry) => entry.name === name);
    expect(tool("send_message")?.description).toContain("image the user pasted");
    expect(tool("send_message")?.description).toContain("name it in attachments");
    expect(tool("send_message")?.inputSchema?.properties).toHaveProperty("attachments");
    expect(tool("transfer_files")?.description).toContain("own pasted images");

    overrides.set("send_coordinator_agent_mail", (args) => ({
      id: "m1",
      toEnvironmentId: args.toEnvironmentId,
      placement: "pending-inject",
      attachments: [{ name: "shot.png", path: "/w/shot.png" }],
    }));
    const sent = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "with-image",
        toEnvironmentId: "env-1",
        body: "See this.",
        attachments: ["/data/coordinator-attachments/c/conv/shot.png"],
      },
    });
    expect(sent.body.result?.structuredContent?.message).toMatchObject({
      attachments: [{ name: "shot.png" }],
    });
    expect(
      invocations.findLast(({ command }) => command === "send_coordinator_agent_mail")?.args,
    ).toMatchObject({
      attachments: ["/data/coordinator-attachments/c/conv/shot.png"],
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
    });
  });

  test("a coordinator's tool cannot ask for more images than a message carries", async () => {
    const credential = coordinatorCredential(["mail", "discovery"]);
    const before = invocations.length;
    const refused = await rpc(credential.url, credential.token, "tools/call", {
      name: "send_message",
      arguments: {
        requestId: "too-many",
        toEnvironmentId: "env-1",
        body: "See these.",
        attachments: Array.from({ length: AGENT_MAIL_MAX_ATTACHMENTS + 1 }, (_, i) => `${i}.png`),
      },
    });
    const text = JSON.stringify(refused.body);
    expect(text).toContain(`at most ${AGENT_MAIL_MAX_ATTACHMENTS} images`);
    expect(invocations.slice(before).some(({ command }) => command.startsWith("send_"))).toBe(
      false,
    );
  });

  test("external send_message schema omits deliverNow", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const listed = await rpc(descriptor.url, descriptor.token, "tools/list");
    const send = listed.body.result?.tools?.find((tool) => tool.name === "send_message");
    expect(send).toBeDefined();
    expect(send?.inputSchema?.properties).not.toHaveProperty("deliverNow");
    // Attachments are a conversation's own; an operator has none to name.
    expect(send?.inputSchema?.properties).not.toHaveProperty("attachments");
  });
});
