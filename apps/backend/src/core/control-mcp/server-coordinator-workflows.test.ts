import { beforeEach, describe, expect, test } from "bun:test";
import type { ControlMcpServer, ControlMcpInvoker } from "./server.js";
import { coordinatorRoleCapabilities, withoutWakePromise } from "./tools.js";
import {
  COORDINATOR_ASYNC_CONTRACT,
  COORDINATOR_TIMERS_AND_ACCOUNTS_RULE,
  COORDINATOR_MESSAGING_OFF_NOTE,
  COORDINATOR_PR_RULE,
  COORDINATOR_PR_STATUS_WAKE,
  COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
} from "@orkestrator/protocol/coordinator";
import { MAX_BUILD_PIPELINE_ITERATIONS } from "@orkestrator/protocol/build-pipeline";
import { rpc, useControlMcpServerHarness } from "./server-test-support.js";

/**
 * Coordinator worker, workflow, review and schedule tools (`coordinator-tools.ts`,
 * `coordinator-worker-tools.ts`, `review-actions.ts`,
 * `account-tools.ts`).
 * The shared server and invoker are in `server-test-support.ts`.
 */
describe("Orkestrator control MCP server", () => {
  const harness = useControlMcpServerHarness();
  const { invocations, overrides, coordinatorCredential } = harness;
  let server: ControlMcpServer;
  beforeEach(() => {
    server = harness.server;
  });

  test("AGENTS.md tool description requires consent for noticed patterns", async () => {
    const credential = coordinatorCredential(["environments"]);
    const listed = await rpc(credential.url, credential.token, "tools/list");
    const proposalDescription = listed.body.result?.tools?.find(
      (tool) => tool.name === "propose_agents_md_update",
    )?.description;
    for (const phrase of [
      "Ask the user first",
      "pattern noticed in repeated steering or an explicit standing preference",
      "quoting the exact entries you suggest",
      "Call only after the user agrees, using any wording they changed",
      "batch every decision into one call",
      "You write nothing",
    ]) {
      expect(proposalDescription).toContain(phrase);
    }
  });

  test("worker surface tools forward the authenticated scope and stay off side agents", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", mailboxIncarnationId: "incarnation-1", role: "main" },
          { id: "side-1", mailboxIncarnationId: "incarnation-2", role: "side" },
        ],
      },
    }));
    overrides.set("launch_coordinator_terminal", (args) => ({
      environmentId: (args.input as { environmentId: string }).environmentId,
      tabId: "terminal-job-1",
      tabType: "plain",
      status: "started",
    }));
    const scope = {
      role: "coordinator" as const,
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    };
    const surfaces = [
      "launch_terminal",
      "open_worker_browser",
      "edit_worker_tab",
      "request_root_changes",
      "propose_agents_md_update",
      "launch_feature_plan",
      "get_feature_plan",
      "custom_fix_multi_review",
      "create_pr",
      "resolve_conflicts",
    ];
    const main = (await server.listCoordinatorTools(scope)) as Array<{ name: string }>;
    for (const name of surfaces) expect(main.map((tool) => tool.name)).toContain(name);
    const side = (await server.listCoordinatorTools({
      ...scope,
      conversationId: "side-1",
      mailboxIncarnationId: "incarnation-2",
      capabilities: coordinatorRoleCapabilities("side"),
    })) as Array<{ name: string }>;
    for (const name of surfaces) expect(side.map((tool) => tool.name)).not.toContain(name);

    const launched = await server.callCoordinatorTool(scope, "launch_terminal", {
      requestId: "tests",
      environmentId: "env-1",
      command: "bun test",
      // A caller-supplied scope is never trusted.
    });
    expect(launched.isError).not.toBe(true);
    const forwarded = invocations.findLast(
      (entry) => entry.command === "launch_coordinator_terminal",
    );
    expect(forwarded?.args.scope).toEqual({
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
    });
    expect(forwarded?.args.input).toMatchObject({ environmentId: "env-1", tabType: "plain" });

    // The PR and Resolve tabs say the conversation will hear how the PR goes.
    overrides.set("create_coordinator_pr", () => ({
      environmentId: "env-1",
      status: "launched",
      tabId: "pr-tab",
    }));
    const raised = await server.callCoordinatorTool(scope, "create_pr", {
      requestId: "pr",
      environmentId: "env-1",
    });
    expect(raised.isError).not.toBe(true);
    expect(raised.text).toContain(COORDINATOR_PR_STATUS_WAKE);
    overrides.set("create_coordinator_pr", () => ({ environmentId: "env-1", status: "skipped" }));
    expect(
      (
        await server.callCoordinatorTool(scope, "create_pr", {
          requestId: "pr2",
          environmentId: "env-1",
        })
      ).text,
    ).toContain("not followed");
    overrides.set("resolve_coordinator_conflicts", () => ({
      environmentId: "env-1",
      status: "launched",
      tabId: "resolve-tab",
    }));
    const resolving = await server.callCoordinatorTool(scope, "resolve_conflicts", {
      requestId: "resolve",
      environmentId: "env-1",
      targetBranch: "main",
    });
    expect(resolving.isError).not.toBe(true);
    expect(resolving.text).toContain(COORDINATOR_PR_STATUS_WAKE);
    expect(
      invocations.findLast((entry) => entry.command === "resolve_coordinator_conflicts")?.args,
    ).toEqual({
      scope: {
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
      },
      input: { requestId: "resolve", environmentId: "env-1", targetBranch: "main" },
    });
    expect(
      (
        await server.callCoordinatorTool(
          {
            ...scope,
            conversationId: "side-1",
            mailboxIncarnationId: "incarnation-2",
            capabilities: coordinatorRoleCapabilities("side"),
          },
          "resolve_conflicts",
          { requestId: "side", environmentId: "env-1" },
        )
      ).isError,
    ).toBe(true);

    // The AGENTS.md proposal only forwards the validated proposal; a side
    // agent cannot call it, and a path or extra field is refused up front.
    overrides.set("request_coordinator_agents_md_update", () => ({
      approvalRequestId: "approval-1",
      state: "pending",
    }));
    const proposal = {
      requestId: "decisions",
      changes: [{ action: "add", text: "Never touch ports 34121/34122." }],
      reason: "Agreed in chat",
    };
    const proposed = await server.callCoordinatorTool(scope, "propose_agents_md_update", proposal);
    expect(proposed.isError).not.toBe(true);
    expect(proposed.text).toContain("Do not poll");
    const forwardedProposal = invocations.findLast(
      (entry) => entry.command === "request_coordinator_agents_md_update",
    );
    expect(forwardedProposal?.args).toEqual({
      scope: {
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
      },
      input: proposal,
    });
    expect(
      (
        await server.callCoordinatorTool(scope, "propose_agents_md_update", {
          ...proposal,
          path: "README.md",
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await server.callCoordinatorTool(
          {
            ...scope,
            conversationId: "side-1",
            mailboxIncarnationId: "incarnation-2",
            capabilities: coordinatorRoleCapabilities("side"),
          },
          "propose_agents_md_update",
          proposal,
        )
      ).isError,
    ).toBe(true);

    const refused = await server.callCoordinatorTool(scope, "launch_terminal", {
      requestId: "smuggled",
      environmentId: "env-1",
      command: "x",
      scope: { projectId: "project-2" },
    });
    expect(refused.isError).toBe(true);
  });

  test("get_worker_changes reaches side agents; fork_worker is the main coordinator's", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", mailboxIncarnationId: "incarnation-1", role: "main" },
          { id: "side-1", mailboxIncarnationId: "incarnation-2", role: "side" },
        ],
      },
    }));
    overrides.set("get_coordinator_worker_changes", () => ({ environmentId: "env-1" }));
    overrides.set("fork_coordinator_worker", () => ({
      environmentId: "env-2",
      status: "accepted",
      coordinatorDelegationOpened: true,
    }));
    const main = {
      role: "coordinator" as const,
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    };
    const side = {
      ...main,
      conversationId: "side-1",
      mailboxIncarnationId: "incarnation-2",
      capabilities: coordinatorRoleCapabilities("side"),
    };
    const sideTools = ((await server.listCoordinatorTools(side)) as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(sideTools).toContain("get_worker_changes");
    expect(sideTools).not.toContain("fork_worker");
    expect(
      ((await server.listCoordinatorTools(main)) as Array<{ name: string }>).map(
        (tool) => tool.name,
      ),
    ).toContain("fork_worker");

    const read = await server.callCoordinatorTool(side, "get_worker_changes", {
      environmentId: "env-1",
      paths: ["src"],
    });
    expect(read.isError).not.toBe(true);
    expect(
      invocations.findLast((entry) => entry.command === "get_coordinator_worker_changes")?.args,
    ).toEqual({
      scope: { projectId: "project-1", coordinatorId: "coordinator-1", conversationId: "side-1" },
      input: { environmentId: "env-1", paths: ["src"] },
    });
    // Bounds are refused before the backend is asked.
    expect(
      (
        await server.callCoordinatorTool(side, "get_worker_changes", {
          environmentId: "env-1",
          maxDiffBytes: 10 * 1024 * 1024,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await server.callCoordinatorTool(side, "get_worker_changes", {
          environmentId: "env-1",
          diffScope: "staged",
        })
      ).isError,
    ).toBe(true);
    await server.callCoordinatorTool(side, "get_worker_changes", {
      environmentId: "env-1",
      diffScope: "split",
    });
    expect(
      invocations.findLast((entry) => entry.command === "get_coordinator_worker_changes")?.args,
    ).toMatchObject({ input: { environmentId: "env-1", diffScope: "split" } });
    expect(
      (
        await server.callCoordinatorTool(side, "fork_worker", {
          requestId: "r",
          environmentId: "e",
        })
      ).isError,
    ).toBe(true);

    const forked = await server.callCoordinatorTool(main, "fork_worker", {
      requestId: "alt",
      environmentId: "env-1",
    });
    expect(forked.isError).not.toBe(true);
    expect(forked.text).toContain("Do not poll");
    expect(
      invocations.findLast((entry) => entry.command === "fork_coordinator_worker")?.args.input,
    ).toEqual({ requestId: "alt", environmentId: "env-1" });
    expect(
      (
        await server.callCoordinatorTool(main, "fork_worker", {
          requestId: "alt-2",
          environmentId: "env-1",
          prompt: "p",
          modelId: "m",
        })
      ).text,
    ).toContain("modelId needs agent");
  });

  test("answer_worker_question only creates a request, for the main coordinator, scheduled or not", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", mailboxIncarnationId: "incarnation-1", role: "main" },
          { id: "side-1", mailboxIncarnationId: "incarnation-2", role: "side" },
        ],
      },
    }));
    overrides.set("request_coordinator_worker_answer", () => ({
      approvalRequestId: "approval-1",
      state: "pending",
    }));
    const scope = {
      role: "coordinator" as const,
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    };
    const sideScope = {
      ...scope,
      conversationId: "side-1",
      mailboxIncarnationId: "incarnation-2",
      capabilities: coordinatorRoleCapabilities("side"),
    };
    expect((await server.listCoordinatorTools(scope)).map((tool) => tool.name)).toContain(
      "answer_worker_question",
    );
    expect((await server.listCoordinatorTools(sideScope)).map((tool) => tool.name)).not.toContain(
      "answer_worker_question",
    );
    const input = {
      requestId: "answer-db",
      environmentId: "env-1",
      tabId: "agent-1",
      interactionId: "q-1",
      answers: [{ questionId: "db", optionIds: ["pg"] }],
      reason: "The ticket says Postgres",
    };
    // A scheduled tool action runs through this same in-process call.
    const proposed = await server.callCoordinatorTool(scope, "answer_worker_question", input);
    expect(proposed.isError).not.toBe(true);
    expect(proposed.structuredContent).toMatchObject({
      approvalRequestId: "approval-1",
      delivery: "async",
      nextStep: "Finish your turn now. Do not poll.",
    });
    expect(
      invocations.findLast((entry) => entry.command === "request_coordinator_worker_answer")?.args,
    ).toEqual({
      scope: {
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
      },
      input,
    });
    expect(
      (await server.callCoordinatorTool(sideScope, "answer_worker_question", input)).isError,
    ).toBe(true);
    expect(
      (
        await server.callCoordinatorTool(scope, "answer_worker_question", {
          ...input,
          action: "approve",
        })
      ).isError,
    ).toBe(true);
    const guarded = server as unknown as {
      coordinatorInvoker(
        scope: Record<string, unknown>,
      ): Promise<{ ok: boolean; invoke: ControlMcpInvoker }>;
    };
    const checked = await guarded.coordinatorInvoker(scope);
    // Only the user's approval answers; the coordinator's credential cannot.
    const approvalOnly = [
      "prepare_node_mail_attachments",
      "place_node_mail_attachments",
      "answer_project_worker_question",
      "answer_controller_worker_question",
      "resolve_native_agent_interaction",
      "resolve_node_action_request",
      // Setup commands run on the host; only the user approves them.
      "approve_environment_setup",
      "approve_project_setup_commands",
      "approve_setup_commands_on_nodes",
    ];
    for (const command of approvalOnly) {
      await expect(checked.invoke(command, {})).rejects.toThrow("Coordinator capability denied");
      // Wrapped for a connected node, it is refused the same way.
      await expect(
        checked.invoke("invoke_on_node", { nodeId: "leaf-1", command, args: {} }),
      ).rejects.toThrow("Coordinator capability denied");
    }
    expect(invocations.filter((entry) => approvalOnly.includes(entry.command))).toEqual([]);
    expect(invocations.some((entry) => entry.command === "invoke_on_node")).toBe(false);
  });

  test("publishes the worker prompt format rule on every delegation prompt field", async () => {
    const credential = coordinatorCredential(coordinatorRoleCapabilities("main"));
    const listed = await rpc(credential.url, credential.token, "tools/list");

    expect(listed.response.status).toBe(200);
    expect(listed.body.error).toBeUndefined();
    for (const name of ["launch_environment", "launch_job", "send_prompt_to_tab"]) {
      const tool = listed.body.result?.tools?.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.inputSchema?.properties?.prompt?.description).toContain(
        COORDINATOR_WORKER_PROMPT_FORMAT_RULE,
      );
    }
  });

  test("bounds start_build_pipeline maxIterations by the protocol limit", async () => {
    const credential = coordinatorCredential(coordinatorRoleCapabilities("main"));
    const listed = await rpc(credential.url, credential.token, "tools/list");
    const tool = listed.body.result?.tools?.find((item) => item.name === "start_build_pipeline") as
      | { inputSchema?: { properties?: Record<string, { minimum?: number; maximum?: number }> } }
      | undefined;
    expect(tool?.inputSchema?.properties?.maxIterations).toMatchObject({
      minimum: 1,
      maximum: MAX_BUILD_PIPELINE_ITERATIONS,
    });
    // A coordinator's build follows the ticket's own delivery policy.
    expect(tool?.inputSchema?.properties?.deliveryPolicy).toBeUndefined();

    const call = (requestId: string, maxIterations: number) =>
      rpc(credential.url, credential.token, "tools/call", {
        name: "start_build_pipeline",
        arguments: {
          requestId,
          taskId: "task-1",
          baseBranch: "main",
          baseCommit: "a".repeat(40),
          taskTitle: "Task",
          taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "" },
          maxIterations,
        },
      });
    const refused = await call("build-too-many-iterations", MAX_BUILD_PIPELINE_ITERATIONS + 1);
    expect(refused.body.result?.isError).toBe(true);
    expect(JSON.stringify(refused.body.result)).toContain(
      `maxIterations must be at most ${MAX_BUILD_PIPELINE_ITERATIONS}`,
    );
    expect(
      invocations.filter((entry) => entry.command === "start_coordinator_build_pipeline"),
    ).toHaveLength(0);

    overrides.set("start_coordinator_build_pipeline", () => ({
      id: "pipeline-1",
      projectId: "project-1",
      environmentId: "env-1",
      phase: "building",
      agentType: "claude",
    }));
    const accepted = await call("build-max-iterations", MAX_BUILD_PIPELINE_ITERATIONS);
    expect(accepted.body.result?.isError).not.toBe(true);
    expect(
      invocations.findLast((entry) => entry.command === "start_coordinator_build_pipeline")?.args
        .input,
    ).toMatchObject({ maxIterations: MAX_BUILD_PIPELINE_ITERATIONS });
  });

  test("start_build_pipeline carries per-step instructions within their bound", async () => {
    const credential = coordinatorCredential(coordinatorRoleCapabilities("main"));
    const call = (requestId: string, extra: Record<string, unknown>) =>
      rpc(credential.url, credential.token, "tools/call", {
        name: "start_build_pipeline",
        arguments: {
          requestId,
          taskId: "task-1",
          baseBranch: "main",
          baseCommit: "a".repeat(40),
          taskTitle: "Task",
          taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "" },
          ...extra,
        },
      });
    const refused = await call("build-long-instructions", {
      steps: { verify: { instructions: "x".repeat(16 * 1024 + 1) } },
    });
    expect(refused.body.result?.isError).toBe(true);
    expect(JSON.stringify(refused.body.result)).toContain("instructions must be at most 16384");
    expect(
      invocations.filter((entry) => entry.command === "start_coordinator_build_pipeline"),
    ).toHaveLength(0);

    overrides.set("start_coordinator_build_pipeline", () => ({
      id: "pipeline-1",
      projectId: "project-1",
      environmentId: "env-1",
      phase: "building",
      agentType: "claude",
      steps: {
        build: { agent: "claude", instructions: "Write the test first." },
        review: { agent: "codex", instructions: "Security." },
      },
      reviewers: [
        { agent: "codex", instructions: "Security." },
        { agent: "claude", instructions: "Performance." },
      ],
      reviewPreparation: { agent: "claude", instructions: "Merge duplicates." },
    }));
    const accepted = await call("build-instructions", {
      steps: { build: { instructions: "Write the test first." } },
      reviewers: [
        { agent: "codex", instructions: "Security." },
        { agent: "claude", instructions: "Performance." },
      ],
      reviewPreparation: { instructions: "Merge duplicates." },
    });
    expect(accepted.body.result?.isError).not.toBe(true);
    // The tool forwards the caller's choices; the backend command layers an
    // instructions-only step over the saved selection.
    expect(
      invocations.findLast((entry) => entry.command === "start_coordinator_build_pipeline")?.args
        .input,
    ).toMatchObject({
      steps: { build: { instructions: "Write the test first." } },
      reviewers: [
        { agent: "codex", instructions: "Security." },
        { agent: "claude", instructions: "Performance." },
      ],
      reviewPreparation: { instructions: "Merge duplicates." },
    });
    // The result reports what was stored by size, not by echoing the text.
    const selection = accepted.body.result?.structuredContent?.selection as Record<string, unknown>;
    expect(selection).toMatchObject({
      steps: { build: { agent: "claude", instructionsBytes: 21 } },
      reviewers: [
        { agent: "codex", instructionsBytes: 9 },
        { agent: "claude", instructionsBytes: 12 },
      ],
      reviewPreparation: { agent: "claude", instructionsBytes: 17 },
    });
    expect(JSON.stringify(selection)).not.toContain("Write the test first.");
  });

  test("Multi Review launch tools and start_build_pipeline carry reviewer lenses", async () => {
    const credential = coordinatorCredential(coordinatorRoleCapabilities("main"));
    const call = (name: string, args: Record<string, unknown>) =>
      rpc(credential.url, credential.token, "tools/call", { name, arguments: args });
    const lens = { label: "Security", instruction: "Trace untrusted input to its sinks." };
    const lensSummary = { label: "Security", instructionBytes: 35 };
    const workflow = {
      id: "review-1",
      projectId: "project-1",
      environmentId: "env-1",
      phase: "preparing",
      reviewers: [
        { id: "r1", agent: "codex", model: "gpt-5.6-codex", status: "pending", lens },
        { id: "r2", agent: "codex", model: "gpt-5.6-codex", status: "pending" },
      ],
      fixModel: { agent: "codex", model: "gpt-5.6-codex" },
    };
    overrides.set("launch_coordinator_multi_review_action", () => ({
      outcome: "opened",
      reused: false,
      ui: { status: "opened" },
      workflow,
    }));
    overrides.set("start_coordinator_multi_review", () => workflow);
    const reviewers = [
      { agent: "codex", model: "gpt-5.6-codex", lens },
      { agent: "codex", model: "gpt-5.6-codex" },
    ];

    const launched = await call("launch_multi_review", {
      requestId: "launch-lens",
      environmentId: "env-1",
      reviewers,
    });
    expect(launched.body.result?.isError).not.toBe(true);
    expect(
      invocations.findLast((entry) => entry.command === "launch_coordinator_multi_review_action")
        ?.args.input,
    ).toMatchObject({ reviewers });
    const launchedSelection = launched.body.result?.structuredContent?.selection as {
      reviewers: unknown[];
    };
    expect(launchedSelection.reviewers[0]).toMatchObject({ lens: lensSummary });
    expect(JSON.stringify(launchedSelection)).not.toContain(lens.instruction);

    const launches = () =>
      invocations.filter((entry) => entry.command === "launch_coordinator_multi_review_action")
        .length;
    const before = launches();
    for (const args of [
      { reviewers: [{ ...reviewers[0], lens: { label: "x".repeat(65), instruction: "x" } }] },
      { reviewers: [{ ...reviewers[0], lens: { label: "L", instruction: "é".repeat(2049) } }] },
      { reviewers: [{ ...reviewers[0], lens: { label: "L" } }] },
      { fixModel: { agent: "codex", model: "gpt-5.6-codex", lens } },
    ]) {
      const refused = await call("launch_multi_review", {
        requestId: "launch-bad-lens",
        environmentId: "env-1",
        ...args,
      });
      expect(refused.body.result?.isError).toBe(true);
    }
    expect(launches()).toBe(before);

    overrides.set("start_coordinator_build_pipeline", () => ({
      id: "pipeline-1",
      projectId: "project-1",
      environmentId: "env-1",
      phase: "building",
      agentType: "claude",
      steps: { review: { agent: "codex", lens } },
      reviewers: [
        { agent: "codex", lens },
        { agent: "claude", instructions: "Performance." },
      ],
    }));
    const build = await call("start_build_pipeline", {
      requestId: "build-lens",
      taskId: "task-1",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      taskTitle: "Task",
      taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "" },
      reviewers: [
        { agent: "codex", lens },
        { agent: "claude", instructions: "Performance." },
      ],
    });
    expect(build.body.result?.isError).not.toBe(true);
    expect(
      invocations.findLast((entry) => entry.command === "start_coordinator_build_pipeline")?.args
        .input,
    ).toMatchObject({ reviewers: [{ agent: "codex", lens }, { agent: "claude" }] });
    const buildSelection = build.body.result?.structuredContent?.selection as Record<
      string,
      unknown
    >;
    expect(buildSelection).toMatchObject({
      steps: { review: { agent: "codex", lens: lensSummary } },
      reviewers: [
        { agent: "codex", lens: lensSummary },
        { agent: "claude", instructionsBytes: 12 },
      ],
    });
    expect(JSON.stringify(buildSelection)).not.toContain(lens.instruction);
    const refusedBuild = await call("start_build_pipeline", {
      requestId: "build-bad-lens",
      taskId: "task-1",
      baseBranch: "main",
      baseCommit: "a".repeat(40),
      taskTitle: "Task",
      taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "" },
      reviewers: [{ agent: "codex", lens: { label: "Two\nlines", instruction: "x" } }],
    });
    expect(refusedBuild.body.result?.isError).toBe(true);
  });

  test("withholds the schedule tools while experimental scheduling is off", async () => {
    overrides.set("get_config", () => ({
      global: { enabledAgentPlatforms: ["codex"], agentMessaging: { enabled: true } },
    }));
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
      },
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    });
    const metadata = await rpc(credential.url, credential.token, "tools/list");
    const names = metadata.body.result!.tools!.map((tool) => tool.name);
    expect(names).toContain("send_message");
    expect(names.filter((name) => name.endsWith("_schedule") || name === "list_schedules")).toEqual(
      [],
    );
  });

  test("normalizes persisted workflow envelopes for coordinator list, read, and control tools", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          {
            id: "conversation-1",
            mailboxIncarnationId: "incarnation-1",
          },
        ],
      },
      workflows: [
        {
          id: "association-build",
          kind: "build-pipeline",
          resourceId: "pipeline-1",
          requestId: "request-build",
          createdAt: new Date(0).toISOString(),
        },
        {
          id: "association-review",
          kind: "multi-review",
          resourceId: "review-1",
          requestId: "request-review",
          createdAt: new Date(0).toISOString(),
        },
      ],
    }));
    const buildEnvelope = {
      id: "pipeline-1",
      projectId: "project-1",
      environmentId: "env-1",
      snapshot: {
        id: "pipeline-1",
        projectId: "project-1",
        environmentId: "env-1",
        phase: "reviewing",
        createdAt: new Date(1).toISOString(),
      },
      updatedAt: new Date(2).toISOString(),
      revision: 7,
    };
    const reviewEnvelope = {
      id: "review-1",
      environmentId: "env-1",
      snapshot: {
        id: "review-1",
        projectId: "project-1",
        environmentId: "env-1",
        phase: "review",
        createdAt: new Date(3).toISOString(),
      },
      updatedAt: new Date(4).toISOString(),
      revision: 9,
    };
    overrides.set("get_build_pipeline", () => buildEnvelope);
    overrides.set("get_multi_review_workflow", () => reviewEnvelope);
    overrides.set("pause_build_pipeline", () => buildEnvelope);
    overrides.set("cancel_multi_review", () => reviewEnvelope);
    overrides.set("address_coordinator_multi_review_action", () => ({
      workflow: reviewEnvelope.snapshot,
      outcome: "pending",
      reused: true,
      ui: { status: "opened", tabId: "root-review" },
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "build-pipelines", "multi-review"],
    });
    const call = (name: string, arguments_: Record<string, unknown> = {}) =>
      rpc(credential.url, credential.token, "tools/call", { name, arguments: arguments_ });

    const listed = await call("list_workflows");
    expect(listed.body.result?.structuredContent).toMatchObject({
      workflows: [
        { resource: { id: "pipeline-1", phase: "reviewing", revision: 7 } },
        { resource: { id: "review-1", phase: "review", revision: 9 } },
      ],
    });
    expect(
      (await call("get_build_pipeline", { pipelineId: "pipeline-1" })).body.result,
    ).toMatchObject({ structuredContent: { workflow: { phase: "reviewing", revision: 7 } } });
    expect((await call("get_multi_review", { workflowId: "review-1" })).body.result).toMatchObject({
      structuredContent: { workflow: { phase: "review", revision: 9 } },
    });
    expect(
      (await call("pause_build_pipeline", { pipelineId: "pipeline-1" })).body.result?.isError,
    ).not.toBe(true);
    expect(
      (await call("cancel_multi_review", { workflowId: "review-1" })).body.result?.isError,
    ).not.toBe(true);
    expect(
      (await call("address_multi_review", { workflowId: "review-1" })).body.result?.isError,
    ).not.toBe(true);
  });

  test("workflow lists and build controls keep a tally; only get_build_pipeline includes evidence", async () => {
    const descriptor = coordinatorCredential(coordinatorRoleCapabilities("main"));
    const commit = "a".repeat(40);
    const record = {
      id: "pipeline-1",
      projectId: "project-1",
      environmentId: "env-1",
      phase: "complete",
      verificationResult: "pass",
      taskSnapshot: {
        title: "Ticket",
        description: "",
        acceptanceCriteria: "- Private criterion text",
        comments: [],
        images: [],
        acceptanceCriteriaItems: [{ id: "ac-1", text: "Private criterion text" }],
      },
      sessions: [
        {
          id: "verify-1",
          phase: "verify",
          status: "completed",
          startedAt: new Date(0).toISOString(),
          validationHeadAtStart: commit,
          validationWorktreeStatusAtStart: "clean",
          validationUncommittedPathsAtStart: [],
          acceptanceCriteriaResults: [
            { id: "ac-1", status: "passed", evidence: "Detailed test evidence" },
          ],
        },
      ],
    };
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
      },
      workflows: [
        {
          id: "association-1",
          kind: "build-pipeline",
          resourceId: "pipeline-1",
          requestId: "request-1",
          createdAt: new Date(0).toISOString(),
        },
      ],
    }));
    for (const command of [
      "get_build_pipeline",
      "start_coordinator_build_pipeline",
      "cancel_build_pipeline",
      "pause_build_pipeline",
      "resume_build_pipeline",
    ]) {
      overrides.set(command, () => record);
    }
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const { body } = await rpc(descriptor.url, descriptor.token, "tools/call", {
        name,
        arguments: args,
      });
      expect(body.result?.isError, `${name}: ${JSON.stringify(body)}`).not.toBe(true);
      return body.result?.structuredContent as Record<string, any>;
    };
    const compact = (value: Record<string, any>) => {
      expect(value.verificationResult).toBe("pass");
      expect(value.criteria).toMatchObject({
        total: 1,
        passed: 1,
        failed: 0,
        notChecked: 0,
        commit,
      });
      expect(value.criteria.criteria).toBeUndefined();
      expect(JSON.stringify(value)).not.toContain("Detailed test evidence");
      expect(JSON.stringify(value)).not.toContain("Private criterion text");
    };
    compact((await call("list_workflows", { openOnly: false })).workflows[0].resource);
    compact(
      (
        await call("start_build_pipeline", {
          requestId: "start-compact",
          taskTitle: "Ticket",
          taskSnapshot: record.taskSnapshot,
          taskId: "task-1",
          baseBranch: "main",
          baseCommit: commit,
        })
      ).workflow,
    );
    compact((await call("cancel_build_pipeline", { pipelineId: "pipeline-1" })).workflow);
    compact((await call("pause_build_pipeline", { pipelineId: "pipeline-1" })).workflow);
    record.phase = "paused";
    compact((await call("resume_build_pipeline", { pipelineId: "pipeline-1" })).workflow);
    expect((await call("get_build_pipeline", { pipelineId: "pipeline-1" })).workflow).toMatchObject(
      {
        verificationResult: "pass",
        criteria: {
          commit,
          criteria: [
            {
              id: "ac-1",
              text: "Private criterion text",
              evidence: "Detailed test evidence",
              status: "passed",
            },
          ],
        },
      },
    );
  });

  test("list_workflows answers what the coordinator is waiting on", async () => {
    const now = new Date(0).toISOString();
    const worker = (id: string, delegation?: Record<string, unknown>) => ({
      id: `association-${id}`,
      kind: "environment",
      resourceId: `env-${id}`,
      requestId: `request-${id}`,
      createdAt: now,
      ...(delegation
        ? { delegation: { requestedAt: now, workerTabId: `tab-${id}`, ...delegation } }
        : {}),
    });
    const running = worker("running", { state: "running" });
    const waiting = worker("waiting", {
      state: "running",
      waiting: { since: now, notifiedAt: now },
    });
    const finished = worker("finished", { state: "completed", completedAt: now, wokenAt: now });
    const plain = worker("plain");
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
      },
      workflows: [
        // Older than the 200 rows the unfiltered list keeps.
        running,
        waiting,
        ...Array.from({ length: 200 }, (_, index) =>
          worker(`old-${index}`, { state: "completed", completedAt: now }),
        ),
        finished,
        plain,
      ],
    }));
    overrides.set("get_environment", (args) => ({
      id: args.environmentId,
      name: args.environmentId,
      status: "running",
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    });
    const list = async (args: Record<string, unknown> = {}) => {
      invocations.length = 0;
      const result = await rpc(credential.url, credential.token, "tools/call", {
        name: "list_workflows",
        arguments: args,
      });
      return result.body.result?.structuredContent as {
        workflows: Array<Record<string, unknown>>;
        total: number;
      };
    };

    const open = await list({ openOnly: true });
    expect(open.workflows.map((row) => row.resourceId)).toEqual(["env-running", "env-waiting"]);
    expect(open.workflows[0]?.delegation).toEqual({
      state: "running",
      bucket: "running",
      workerTabId: "tab-running",
      requestedAt: now,
    });
    expect(open.workflows[1]?.delegation).toEqual({
      state: "running",
      bucket: "needs-you",
      workerTabId: "tab-waiting",
      requestedAt: now,
      waitingSince: now,
    });
    // The filter is what spares the per-row resource reads.
    expect(invocations.filter((call) => call.command === "get_environment")).toHaveLength(2);

    const all = await list();
    expect(all.total).toBe(200);
    expect(all.workflows.at(-2)?.delegation).toEqual({
      state: "completed",
      bucket: "finished",
      workerTabId: "tab-finished",
      requestedAt: now,
      completedAt: now,
    });
    expect(all.workflows.at(-1)).not.toHaveProperty("delegation");

    const tools = (await rpc(credential.url, credential.token, "tools/list")).body.result!.tools!;
    expect(tools.find((tool) => tool.name === "list_workflows")?.description).toContain(
      "instead of polling list_environments or list_agents",
    );
  });

  test("with agent messaging off no coordinator surface promises a wake", async () => {
    let enabled = false;
    overrides.set("get_config", () => ({
      global: {
        enabledAgentPlatforms: ["codex"],
        agentMessaging: { enabled },
        experimentalScheduling: true,
      },
    }));
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
      },
      workflows: [],
    }));
    overrides.set("launch_coordinator_feature_plan", () => ({
      featureId: "plan-1",
      phase: "dispatching",
      reused: false,
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    });
    const instructions = async () => {
      const initialized = await rpc(credential.url, credential.token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      return (initialized.body.result as unknown as { instructions: string }).instructions;
    };
    expect(await instructions()).toContain(COORDINATOR_MESSAGING_OFF_NOTE);
    expect(await instructions()).not.toContain(COORDINATOR_ASYNC_CONTRACT);
    expect(await instructions()).not.toContain(COORDINATOR_PR_RULE);
    expect(await instructions()).not.toContain(COORDINATOR_TIMERS_AND_ACCOUNTS_RULE);
    const launchPlan = async (requestId: string) => {
      const launched = await rpc(credential.url, credential.token, "tools/call", {
        name: "launch_feature_plan",
        arguments: { requestId, message: "Add dark mode" },
      });
      return launched.body.result?.structuredContent as Record<string, unknown>;
    };
    expect(await launchPlan("plan-off")).toMatchObject({
      featureId: "plan-1",
      wake: COORDINATOR_MESSAGING_OFF_NOTE,
    });

    enabled = true;
    expect(await instructions()).toContain(COORDINATOR_ASYNC_CONTRACT);
    expect(await instructions()).toContain(COORDINATOR_PR_RULE);
    expect(await instructions()).toContain(COORDINATOR_TIMERS_AND_ACCOUNTS_RULE);
    expect(await instructions()).not.toContain(COORDINATOR_MESSAGING_OFF_NOTE);
    expect((await launchPlan("plan-on")).wake).toContain("woken once");
  });

  test("withoutWakePromise rewrites a promised wake in both copies of a result", () => {
    const rewritten = withoutWakePromise({
      content: [
        {
          type: "text",
          text: JSON.stringify({ accepted: true, wake: "You will be woken.", nextStep: "Finish." }),
        },
      ],
      structuredContent: {
        accepted: true,
        delivery: "async",
        wake: "You will be woken.",
        nextStep: "Finish.",
      },
    }) as { content: Array<{ text: string }>; structuredContent: Record<string, unknown> };
    expect(rewritten.structuredContent).toEqual({
      accepted: true,
      delivery: "async",
      wake: COORDINATOR_MESSAGING_OFF_NOTE,
    });
    expect(JSON.parse(rewritten.content[0]!.text)).toEqual({
      accepted: true,
      wake: COORDINATOR_MESSAGING_OFF_NOTE,
    });

    // The poll guard's refusal restates the contract under another name.
    const refusal = withoutWakePromise({
      content: [],
      structuredContent: { repeatedRead: true, instruction: COORDINATOR_ASYNC_CONTRACT },
    }) as { structuredContent: Record<string, unknown> };
    expect(refusal.structuredContent).toEqual({
      repeatedRead: true,
      wake: COORDINATOR_MESSAGING_OFF_NOTE,
    });

    // A result with no promise, or one that is not JSON, comes back as it went in.
    const plain = {
      content: [{ type: "text", text: "not json" }],
      structuredContent: { accepted: true, instruction: "Read the file." },
    };
    expect(withoutWakePromise(plain)).toEqual(plain);
  });

  test("list_workflows shows a followed pull request with its follow and PR fields", async () => {
    const prUrl = "https://github.com/org/repo/pull/7";
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
      },
      workflows: [
        {
          id: "association-pr",
          kind: "pull-request",
          resourceId: "env-1",
          requestId: "pr-follow:pr",
          createdAt: new Date(0).toISOString(),
          statusNotice: { key: "conflicts:abc", notifiedAt: new Date(1).toISOString() },
          pullRequest: {
            source: "create-pr",
            prUrl,
            notices: 2,
            resolve: { tabId: "resolve-tab", requestedAt: new Date(2).toISOString() },
          },
        },
      ],
    }));
    overrides.set("get_environment", () => ({
      id: "env-1",
      projectId: "project-1",
      name: "worker",
      status: "running",
      prUrl,
      prState: "open",
      hasMergeConflicts: true,
      prMergeability: "dirty",
    }));
    overrides.set("get_environment_pr_health", () => ({
      "env-1": { prMonitorConfirmed: true, prCheckSummary: { passed: 2, total: 2, pending: 0 } },
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery"],
    });
    const listed = await rpc(credential.url, credential.token, "tools/call", {
      name: "list_workflows",
      arguments: {},
    });
    expect(listed.body.result?.structuredContent).toMatchObject({
      workflows: [
        {
          kind: "pull-request",
          follow: {
            source: "create-pr",
            prUrl,
            following: true,
            lastReportedState: "pr-conflicts",
            resolve: { tabId: "resolve-tab", state: "running" },
          },
          resource: {
            id: "env-1",
            prHasMergeConflicts: true,
            prMergeability: "dirty",
            prChecks: { passed: 2, failed: 0, pending: 0, total: 2 },
            prReadyToMerge: false,
            prNotReadyReason: "conflicts",
          },
        },
      ],
    });
    const tools = (await rpc(credential.url, credential.token, "tools/list")).body.result!.tools!;
    expect(tools.find((tool) => tool.name === "list_workflows")?.description).toContain(
      "pull-request associations",
    );
  });
});
