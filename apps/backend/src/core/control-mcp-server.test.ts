import { MailWorld } from "./agent-mail-world-test-support.js";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ControlMcpServer,
  controlMcpPortOverride,
  readControlMcpDescriptor,
  type ControlMcpInvoker,
} from "./control-mcp-server.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import { coordinatorDelegationPresentationFrom } from "./coordinator-delegation-authority.js";
import {
  COORDINATOR_CONTROL_TOOL_NAMES,
  COORDINATOR_WORKFLOW_STATUS_WAKE,
} from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  parseCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";

type RpcBody = {
  result?: {
    tools?: Array<{ name: string; description?: string; annotations?: Record<string, boolean> }>;
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

async function rpcPayload(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
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
              supportsSpeed: true,
              reasoning: [{ id: "high", name: "High" }],
            },
          ];
          break;
        case "get_agent_model_catalog_cache":
          result = { schemaVersion: 1 };
          break;
        case "get_repository_config":
          result = {};
          break;
        case "get_project_base_branch_tip":
          result = { branch: "main", commit: "a".repeat(40), ref: "origin/main", fetched: true };
          break;
        case "verify_project_launch_base":
          result = { contained: true };
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

  /**
   * A ready coordinator conversation's credential. Operator credentials run
   * the shared launch, prompt, ticket and mail tools through public actions
   * (`control-mcp-operator-tools.test.ts`); coordinators keep these
   * implementations, which is what the tests below exercise.
   */
  function coordinatorCredential(capabilities: string[]) {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    overrides.set("open_coordinator_delegation", () => ({ opened: false }));
    overrides.set("assert_coordinator_delegation_available", () => ({ available: true }));
    return server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities,
    });
  }
  const BASE = { baseBranch: "main", baseCommit: "a".repeat(40) };

  for (const mode of ["off", "settled"] as const) {
    test("coordinator invoker directly refuses the PR-opening command", async () => {
      overrides.set("get_project_coordinator", () => ({
        workspace: {
          id: "coordinator-1",
          lifecycleState: "ready",
          conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
        },
      }));
      const guarded = server as unknown as {
        coordinatorInvoker(
          scope: Record<string, unknown>,
        ): Promise<{ ok: boolean; invoke: ControlMcpInvoker }>;
      };
      const checked = await guarded.coordinatorInvoker({
        role: "coordinator",
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
        mailboxIncarnationId: "incarnation-1",
      });
      expect(checked.ok).toBe(true);
      await expect(
        checked.invoke("open_project_agents_md_pr", { projectId: "project-1" }),
      ).rejects.toThrow("Coordinator capability denied");
      expect(invocations.some((item) => item.command === "open_project_agents_md_pr")).toBe(false);
    });

    test(`workflow tool wake promises match the ${mode} observer policy`, async () => {
      const world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
      try {
        const config = await world.storage.loadConfig();
        await world.storage.updateGlobalConfig({
          ...config.global,
          agentMessaging: { ...config.global.agentMessaging!, coordinatorStatusWakes: mode },
        });
        const main = await world.main();
        const worker = await world.addEnvironment("review");
        const workspace = (await world.storage.coordinators.getCoordinatorWorkspace(
          world.projectId,
        ))!;
        const conversation = workspace.conversations.find(
          (item) => item.id === main.conversationId,
        )!;
        overrides.set("get_config", () => world.storage.loadConfig());
        overrides.set("get_project_coordinator", () => ({ workspace }));
        overrides.set("get_environment", () => ({
          id: worker.environmentId,
          projectId: world.projectId,
        }));
        const saveStarted = async (kind: "multi-review" | "build-pipeline", id: string) => {
          const snapshot = {
            id,
            environmentId: worker.environmentId,
            projectId: world.projectId,
            phase: kind === "multi-review" ? "reviewing" : "building",
          };
          if (kind === "multi-review")
            await world.storage.saveMultiReviewWorkflow(id, worker.environmentId, 1, snapshot);
          else
            await world.storage.saveBuildPipeline(
              id,
              world.projectId,
              worker.environmentId,
              1,
              snapshot,
            );
          await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
            id: `a-${id}`,
            projectId: world.projectId,
            coordinatorId: world.coordinatorId,
            conversationId: main.conversationId!,
            kind,
            resourceId: id,
            requestId: id,
            createdAt: new Date().toISOString(),
          });
          return snapshot;
        };
        overrides.set("launch_coordinator_multi_review_action", async () => ({
          outcome: "opened",
          reused: false,
          ui: { status: "opened" },
          workflow: await saveStarted("multi-review", "launched"),
        }));
        overrides.set("start_coordinator_multi_review", () =>
          saveStarted("multi-review", "started"),
        );
        overrides.set("start_coordinator_build_pipeline", () =>
          saveStarted("build-pipeline", "build"),
        );
        const credential = server.issueCoordinatorCredential({
          role: "coordinator",
          projectId: world.projectId,
          coordinatorId: world.coordinatorId,
          conversationId: main.conversationId!,
          mailboxIncarnationId: conversation.mailboxIncarnationId!,
          capabilities: ["multi-review", "build-pipelines"],
        });
        const selection = { agent: "codex", model: "default" };
        for (const [name, args] of [
          [
            "launch_multi_review",
            { environmentId: worker.environmentId, reviewers: [selection], fixModel: selection },
          ],
          [
            "start_multi_review",
            {
              buildPipelineId: "build",
              environmentId: worker.environmentId,
              targetBranch: "main",
              reviewers: [selection],
              fixModel: selection,
            },
          ],
          [
            "start_build_pipeline",
            {
              baseBranch: "main",
              baseCommit: "a".repeat(40),
              taskId: "task",
              agentType: "codex",
              taskTitle: "Fix",
              taskSnapshot: {
                title: "Fix",
                description: "Fix parser",
                acceptanceCriteria: "Tests pass",
              },
            },
          ],
        ] as const) {
          const result = await rpc(credential.url, credential.token, "tools/call", {
            name,
            arguments: { requestId: name, ...args },
          });
          expect(result.body.result?.isError).not.toBe(true);
          const content = result.body.result!.structuredContent!;
          expect(content.delivery).toBe("async");
          if (mode === "off") {
            expect(content.wake).toContain("Only terminal");
            expect(content.wake).not.toBe(COORDINATOR_WORKFLOW_STATUS_WAKE);
            expect(content.nextStep).toContain("tell the user to inspect");
            expect(content.nextStep).toContain("do not wait for a ready or fix-turn wake");
          } else expect(content.wake).toBe(COORDINATOR_WORKFLOW_STATUS_WAKE);
        }
        for (const id of ["launched", "started"]) {
          await world.storage.saveMultiReviewWorkflow(id, worker.environmentId, 1, {
            id,
            environmentId: worker.environmentId,
            phase: "ready",
            reviewSession: { sessionKey: id, completedAt: "done" },
          });
        }
        await world.coordinator.reconcileWorkflowNotifications();
        const inbox = await world.storage.getAgentMailMailbox(main.environmentId, main.tabId);
        expect(inbox.messages.filter((message) => message.notice?.state === "ready")).toHaveLength(
          mode === "off" ? 0 : 2,
        );
      } finally {
        await world.close();
      }
    });
  }

  test("publishes a private descriptor and rejects invalid credentials", async () => {
    const info = server.getInfo();
    expect(info).not.toBeNull();
    const descriptor = await readControlMcpDescriptor(info!.descriptorFile);
    expect(descriptor).toMatchObject({ version: 2, url: info!.url, pid: process.pid });
    expect(descriptor.token.length).toBeGreaterThanOrEqual(32);
    // The first start creates the default credential with the full profile.
    expect(descriptor.credentials).toEqual([
      expect.objectContaining({ id: "default", profile: "full", token: descriptor.token }),
    ]);
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
      "start_looped_review",
      "get_looped_review",
      "cancel_looped_review",
      "launch_feature_plan",
      "get_feature_plan",
      "custom_fix_multi_review",
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

  test("binds coordinator credentials to one project and revokes them", async () => {
    overrides.set("get_projects", () => [
      { id: "project-1", name: "Allowed", localPath: "/allowed" },
      { id: "project-2", name: "Hidden", localPath: "/hidden" },
    ]);
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
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    });
    const listed = await rpc(credential.url, credential.token, "tools/call", {
      name: "list_projects",
      arguments: {},
    });
    const metadata = await rpc(credential.url, credential.token, "tools/list");
    const definitions = metadata.body.result!.tools!;
    // Bridges gate a coordinator's tools by this list (Pi); it must not drift.
    expect(definitions.map((tool) => tool.name).toSorted()).toEqual(
      [...COORDINATOR_CONTROL_TOOL_NAMES].toSorted(),
    );
    expect(definitions.find((tool) => tool.name === "launch_multi_review")?.description).toContain(
      "Preferred complete Multi Review button action",
    );
    // Workers commit and report; the pull request comes from the PR tab.
    for (const name of ["launch_environment", "launch_job", "send_prompt_to_tab"])
      expect(definitions.find((tool) => tool.name === name)?.description).toContain(
        "Never ask the worker to open a pull request",
      );
    expect(definitions.find((tool) => tool.name === "create_pr")?.description).toContain(
      "only after the review and its fix have finished",
    );
    const multiReviewTool = definitions.find((tool) => tool.name === "launch_multi_review") as
      { description?: string; inputSchema?: { required?: string[] } } | undefined;
    // Omitted model rows use the saved defaults, the same as the button.
    expect(multiReviewTool?.description).toContain(
      "Omit reviewers, reviewModel and fixModel to use the user's saved Multi Review defaults",
    );
    expect(multiReviewTool?.inputSchema?.required).toEqual(["requestId", "environmentId"]);
    const required = (name: string) =>
      (
        definitions.find((tool) => tool.name === name) as
          { inputSchema?: { required?: string[] } } | undefined
      )?.inputSchema?.required ?? [];
    for (const field of ["reviewers", "reviewModel", "fixModel", "autoFix", "autoPr"])
      expect(required("start_multi_review")).not.toContain(field);
    // Both launch tools expose auto-fix and auto-PR as optional, saved-by-default booleans.
    for (const name of ["launch_multi_review", "start_multi_review"]) {
      const tool = definitions.find((item) => item.name === name) as
        | {
            description?: string;
            inputSchema?: { properties?: Record<string, { type?: string; description?: string }> };
          }
        | undefined;
      expect(tool?.description).toContain(
        "Omit autoFix and autoPr to use the user's saved Auto-fix and Auto-PR settings, as the button does; set them only when the user asks.",
      );
      expect(tool?.description).toContain("A failed, stopped or stalled Fix starts no PR.");
      expect(tool?.description).not.toContain("always apply");
      for (const field of ["autoFix", "autoPr"]) {
        expect(tool?.inputSchema?.properties?.[field]?.type).toBe("boolean");
        expect(tool?.inputSchema?.properties?.[field]?.description).toContain(
          "Set only when the user asks.",
        );
      }
      expect(tool?.inputSchema?.properties?.autoPr?.description).toContain("never merges");
    }
    // Build steps and reviewers are overridable, but the defaults are the stated norm.
    for (const field of ["agentType", "steps", "reviewers", "reviewPreparation"])
      expect(required("start_build_pipeline")).not.toContain(field);
    const buildTool = definitions.find((tool) => tool.name === "start_build_pipeline") as
      | {
          description?: string;
          inputSchema?: { properties?: Record<string, { description?: string }> };
        }
      | undefined;
    expect(buildTool?.description).toContain(
      "Override one only when the user has asked for a specific agent, model, effort or reviewer set",
    );
    expect(buildTool?.inputSchema?.properties?.steps?.description).toContain(
      "omitted steps keep theirs",
    );
    overrides.set("start_coordinator_build_pipeline", () => ({
      id: "pipeline-1",
      projectId: "project-1",
      environmentId: "env-1",
      phase: "building",
      agentType: "claude",
      steps: {
        build: { agent: "claude" },
        review: { agent: "codex", model: "gpt-5.6" },
        address: { agent: "codex" },
      },
      reviewers: [{ agent: "codex", model: "gpt-5.6" }],
    }));
    const build = await rpc(credential.url, credential.token, "tools/call", {
      name: "start_build_pipeline",
      arguments: {
        requestId: "build-override",
        taskId: "task-1",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
        taskTitle: "Task",
        taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "" },
        steps: { build: { agent: "claude" }, review: { agent: "codex", model: "gpt-5.6" } },
      },
    });
    expect(build.body.result?.isError).not.toBe(true);
    expect(
      invocations.findLast((entry) => entry.command === "start_coordinator_build_pipeline")?.args
        .input,
    ).toMatchObject({
      steps: { build: { agent: "claude" }, review: { agent: "codex", model: "gpt-5.6" } },
    });
    expect(build.body.result?.structuredContent?.selection).toMatchObject({
      agentType: "claude",
      source: {
        agentType: "requested",
        steps: { build: "requested", review: "requested", address: "default" },
        reviewers: "default",
        reviewPreparation: "default",
      },
    });
    expect(build.body.result?.structuredContent).toMatchObject({
      delivery: "async",
      wake: COORDINATOR_WORKFLOW_STATUS_WAKE,
      nextStep: "Finish your turn now. Do not poll.",
    });
    expect(definitions.find((tool) => tool.name === "start_multi_review")?.description).toContain(
      "does NOT create/select a root tab",
    );
    for (const name of [
      "launch_multi_review",
      "open_multi_review",
      "open_multi_review_fix",
      "address_multi_review",
    ])
      expect(definitions.find((tool) => tool.name === name)?.annotations?.idempotentHint).toBe(
        true,
      );
    overrides.set("launch_coordinator_multi_review_action", () => ({
      outcome: "partial",
      reused: false,
      workflow: {
        id: "review-action",
        projectId: "project-1",
        environmentId: "env-1",
        phase: "cancelling",
        controllerFence: "must-not-cross-mcp",
      },
      ui: { status: "unavailable" },
      recovery: "Cancellation is in progress; reopen the saved review.",
    }));
    const button = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: {
        requestId: "launch-review",
        environmentId: "env-1",
        reviewers: [{ agent: "codex", model: "default", reasoningEffort: "x".repeat(128) }],
        fixModel: { agent: "claude", model: "default" },
      },
    });
    expect(button.body.result).toMatchObject({
      isError: true,
      structuredContent: {
        outcome: "partial",
        ui: { status: "unavailable" },
        workflow: { id: "review-action" },
      },
    });
    expect(JSON.stringify(button.body)).not.toContain("must-not-cross-mcp");
    // A launch that did not start work promises no wake.
    expect(button.body.result?.structuredContent).not.toHaveProperty("delivery");
    overrides.set("launch_coordinator_multi_review_action", () => ({
      outcome: "opened",
      reused: false,
      workflow: { id: "review-started", projectId: "project-1", environmentId: "env-1" },
      ui: { status: "opened" },
    }));
    const started = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: {
        requestId: "launch-review-started",
        environmentId: "env-1",
        reviewers: [{ agent: "codex", model: "default" }],
        fixModel: { agent: "claude", model: "default" },
      },
    });
    // Started work tells the coordinator how it will hear back, so it does not poll.
    expect(started.body.result?.structuredContent).toMatchObject({
      outcome: "opened",
      delivery: "async",
      wake: COORDINATOR_WORKFLOW_STATUS_WAKE,
      nextStep: "Finish your turn now. Do not poll.",
    });

    expect(button.body.result?.structuredContent?.selection).toMatchObject({
      source: { reviewers: "requested", reviewModel: "default", fixModel: "requested" },
    });
    // Leaving every model row out hands the choice to the saved defaults.
    overrides.set("launch_coordinator_multi_review_action", () => ({
      outcome: "opened",
      reused: false,
      workflow: {
        id: "review-defaults",
        projectId: "project-1",
        environmentId: "env-1",
        phase: "preparing",
        reviewers: [{ id: "reviewer-0", agent: "claude", model: "default", status: "pending" }],
        reviewModel: { agent: "claude", model: "default" },
        fixModel: { agent: "claude", model: "default", reasoningEffort: "high" },
      },
      ui: { status: "opened" },
    }));
    const defaulted = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: { requestId: "launch-review-defaults", environmentId: "env-1" },
    });
    expect(defaulted.body.result?.isError).not.toBe(true);
    expect(defaulted.body.result?.structuredContent).toMatchObject({
      delivery: "async",
      wake: COORDINATOR_WORKFLOW_STATUS_WAKE,
      nextStep: "Finish your turn now. Do not poll.",
    });
    expect(defaulted.body.result?.structuredContent?.selection).toEqual({
      reviewers: [{ agent: "claude", model: "default" }],
      reviewModel: { agent: "claude", model: "default" },
      fixModel: { agent: "claude", model: "default", reasoningEffort: "high" },
      autoFix: false,
      autoPr: false,
      source: {
        reviewers: "default",
        reviewModel: "default",
        fixModel: "default",
        autoFix: "default",
        autoPr: "default",
      },
    });
    expect(
      invocations.findLast((entry) => entry.command === "launch_coordinator_multi_review_action")
        ?.args.input,
    ).toEqual({ requestId: "launch-review-defaults", environmentId: "env-1" });
    // Auto-PR passes through untouched; the backend resolves the Fix it implies.
    overrides.set("launch_coordinator_multi_review_action", () => ({
      outcome: "opened",
      reused: false,
      workflow: {
        id: "review-auto-pr",
        projectId: "project-1",
        environmentId: "env-1",
        phase: "preparing",
        autoFix: true,
        autoPr: true,
      },
      ui: { status: "opened" },
    }));
    const autoPr = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: { requestId: "launch-review-auto-pr", environmentId: "env-1", autoPr: true },
    });
    expect(autoPr.body.result?.isError).not.toBe(true);
    expect(
      invocations.findLast((entry) => entry.command === "launch_coordinator_multi_review_action")
        ?.args.input,
    ).toEqual({ requestId: "launch-review-auto-pr", environmentId: "env-1", autoPr: true });
    expect(autoPr.body.result?.structuredContent?.selection).toMatchObject({
      autoFix: true,
      autoPr: true,
      source: { autoFix: "implied", autoPr: "requested" },
    });
    expect(autoPr.body.result?.structuredContent?.workflow).toMatchObject({
      automation: {
        autoFix: true,
        autoPr: true,
        next: "The Fix starts automatically if consolidation reports findings, then a PR session once the Fix completes; a clean report starts the PR session directly.",
      },
    });
    const autoFixOff = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: {
        requestId: "launch-review-auto-fix-off",
        environmentId: "env-1",
        autoFix: false,
        autoPr: true,
      },
    });
    expect(autoFixOff.body.result?.structuredContent?.selection).toMatchObject({
      source: { autoFix: "requested", autoPr: "requested" },
    });
    overrides.set("start_coordinator_multi_review", () => ({
      id: "started-review",
      projectId: "project-1",
      environmentId: "env-1",
      phase: "preparing",
      reviewers: [{ id: "reviewer-0", agent: "codex", model: "default", status: "pending" }],
      fixModel: { agent: "claude", model: "default" },
      autoFix: false,
      autoPr: true,
      controllerFence: "must-not-cross-mcp",
    }));
    const startedReview = await rpc(credential.url, credential.token, "tools/call", {
      name: "start_multi_review",
      arguments: {
        requestId: "start-review-auto",
        buildPipelineId: "pipeline-1",
        environmentId: "env-1",
        targetBranch: "main",
        autoFix: false,
        autoPr: true,
      },
    });
    expect(startedReview.body.result?.isError).not.toBe(true);
    expect(
      invocations.findLast((entry) => entry.command === "start_coordinator_multi_review")?.args
        .input,
    ).toEqual({
      environmentId: "env-1",
      targetBranch: "main",
      autoFix: false,
      autoPr: true,
      projectId: "project-1",
    });
    expect(startedReview.body.result?.structuredContent).toMatchObject({
      workflow: {
        id: "started-review",
        automation: {
          autoFix: false,
          autoPr: true,
          next: "Stops at ready if consolidation reports findings; address_multi_review starts the Fix; a PR session starts once that Fix completes. A clean report starts the PR session directly.",
        },
      },
      selection: {
        reviewers: [{ agent: "codex", model: "default" }],
        autoFix: false,
        autoPr: true,
        source: { reviewers: "default", autoFix: "requested", autoPr: "requested" },
      },
      delivery: "async",
    });
    expect(JSON.stringify(startedReview.body)).not.toContain("must-not-cross-mcp");
    const notBoolean = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: { requestId: "launch-review-bad-auto", environmentId: "env-1", autoPr: "yes" },
    });
    expect(notBoolean.body.result?.isError).toBe(true);
    expect(
      invocations.filter(
        (entry) =>
          entry.command === "launch_coordinator_multi_review_action" &&
          entry.args.input &&
          (entry.args.input as { requestId?: string }).requestId === "launch-review-bad-auto",
      ),
    ).toHaveLength(0);
    overrides.delete("launch_coordinator_multi_review_action");
    expect(
      invocations.find((entry) => entry.command === "launch_coordinator_multi_review_action")?.args,
    ).toMatchObject({
      scope: {
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
      },
      input: { requestId: "launch-review", environmentId: "env-1" },
    });
    const launchInvocationsBeforeInvalidEffort = invocations.filter(
      (entry) => entry.command === "launch_coordinator_multi_review_action",
    ).length;
    const invalidEffort = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: {
        requestId: "launch-review-invalid-effort",
        environmentId: "env-1",
        reviewers: [{ agent: "codex", model: "default", reasoningEffort: "x".repeat(129) }],
        fixModel: { agent: "claude", model: "default" },
      },
    });
    expect(invalidEffort.body.result?.isError).toBe(true);
    expect(
      invocations.filter((entry) => entry.command === "launch_coordinator_multi_review_action"),
    ).toHaveLength(launchInvocationsBeforeInvalidEffort);
    expect(listed.body.result?.structuredContent).toMatchObject({
      total: 1,
      projects: [{ id: "project-1" }],
    });

    const registrySnapshot = {
      revision: 7,
      entries: [{ environmentId: "env-project-1", tabId: "agent", state: "working" }],
      environments: [{ environmentId: "env-project-1", tabs: 1, working: 1 }],
    };
    overrides.set("get_agent_registry", () => registrySnapshot);
    const agents = await rpc(credential.url, credential.token, "tools/call", {
      name: "list_agents",
      arguments: { environmentId: "env-project-1" },
    });
    expect(agents.body.result?.structuredContent).toEqual(registrySnapshot);
    expect(invocations.filter((entry) => entry.command === "get_agent_registry")).toEqual([
      {
        command: "get_agent_registry",
        args: { projectId: "project-1", environmentId: "env-project-1" },
      },
    ]);
    overrides.set("get_environment_snapshots", ({ projectId }) => [
      {
        id: `env-${projectId}`,
        projectId,
        name: "Scoped environment",
        status: "running",
      },
    ]);
    const environments = await rpc(credential.url, credential.token, "tools/call", {
      name: "list_environments",
      arguments: {},
    });
    expect(environments.body.result?.structuredContent).toMatchObject({
      total: 1,
      environments: [{ id: "env-project-1", projectId: "project-1" }],
    });

    overrides.set("get_environment", () => ({ id: "env-project-1", projectId: "project-1" }));
    overrides.set("launch_control_job", () => ({
      jobId: "job-1",
      environmentId: "env-project-1",
      tabId: "agent-job-1",
      status: "accepted",
    }));
    const launched = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_job",
      arguments: {
        requestId: "coordinator-job-1",
        environmentId: "env-project-1",
        agent: "codex",
        prompt: "Implement the delegated task.",
      },
    });
    expect(launched.body.result?.isError).not.toBe(true);
    const launchArgs = invocations.find(
      ({ command, args }) =>
        command === "launch_control_job" && args.requestId === "coordinator-job-1",
    )?.args;
    const parsedDelegation = parseCoordinatorDelegatedPrompt(String(launchArgs?.prompt));
    expect(parsedDelegation?.source).toBe("Implement the delegated task.");
    expect(launchArgs && coordinatorDelegationPresentationFrom(launchArgs)).toEqual({
      kind: COORDINATOR_DELEGATION_PRESENTATION,
      frame: parsedDelegation?.frame,
    });

    const denied = await rpc(credential.url, credential.token, "tools/call", {
      name: "list_tickets",
      arguments: { projectId: "project-2" },
    });
    expect(denied.body.result?.isError).toBe(true);

    const replacement = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery"],
    });
    expect((await rpc(credential.url, credential.token, "tools/list")).response.status).toBe(401);
    const batch = await rpcPayload(replacement.url, replacement.token, [
      {
        jsonrpc: "2.0",
        id: "allowed",
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: "denied",
        method: "tools/call",
        params: { name: "send_message", arguments: {} },
      },
    ]);
    expect(batch.status).toBe(403);

    server.revokeCoordinatorCredentials("coordinator-1", "conversation-1");
    expect((await rpc(replacement.url, replacement.token, "tools/list")).response.status).toBe(401);
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

  test("authenticated coordinator transfers authorize both nested endpoints before admission", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
      },
    }));
    overrides.set("get_node_status", () => ({
      nodeId: "bk_self",
      mode: "command",
      controllers: [],
    }));
    overrides.set("get_projects", () => [
      { id: "project-1", gitUrl: "https://git.test/team/repo.git" },
    ]);
    overrides.set("get_environment", (args) => ({
      id: args.environmentId,
      projectId: args.environmentId === "other" ? "project-2" : "project-1",
      projectHome: args.environmentId === "home",
    }));
    overrides.set("get_node_summaries", () => ({
      nodes: [
        {
          nodeId: "bk_leaf",
          view: { displayName: "Leaf" },
          projects: [{ ref: { projectId: "leaf-project" }, repositoryHint: "git.test/team/repo" }],
          environments: [
            { ref: { environmentId: "own" }, projectId: "leaf-project" },
            { ref: { environmentId: "other" }, projectId: "unrelated" },
            { ref: { environmentId: "home" }, projectId: "leaf-project", isProjectHome: true },
          ],
        },
      ],
    }));
    overrides.set("transfer_node_files", () => ({ status: "completed" }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["environments", "discovery"],
    });
    const call = (from: unknown, to: unknown) =>
      rpc(credential.url, credential.token, "tools/call", {
        name: "transfer_files",
        arguments: { from, to, files: ["x.txt"] },
      });
    for (const side of ["from", "to"])
      for (const nodeId of ["bk_self", "bk_leaf"])
        for (const environmentId of ["other", "home"]) {
          invocations.length = 0;
          const endpoints = {
            from: { nodeId: "bk_self", environmentId: "own" },
            to: { nodeId: "bk_leaf", environmentId: "own" },
            [side]: { nodeId, environmentId },
          };
          expect((await call(endpoints.from, endpoints.to)).body.result?.isError).toBe(true);
          expect(invocations.some((entry) => entry.command === "transfer_node_files")).toBe(false);
        }
    expect(
      (
        await call(
          { nodeId: "bk_self", projectRoot: true },
          { nodeId: "bk_leaf", projectRoot: true },
        )
      ).body.result?.isError,
    ).toBe(true);
    expect(
      (
        await call(
          { nodeId: "bk_self", projectRoot: true },
          { nodeId: "bk_leaf", environmentId: "own" },
        )
      ).body.result?.isError,
    ).not.toBe(true);
  });

  test("never lets a coordinator credential act on the project home", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
      },
    }));
    overrides.set("get_environment", () => ({
      id: "env-home",
      projectId: "project-1",
      projectHome: true,
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["environments", "discovery"],
    });

    const result = await rpc(credential.url, credential.token, "tools/call", {
      name: "start_environment",
      arguments: { environmentId: "env-home" },
    });

    expect(result.body.result?.isError).toBe(true);
    expect(invocations.some((entry) => entry.command.startsWith("start_environment"))).toBe(false);
  });

  test("rejects cross-project environments and invalidates paused, superseded, and expired credentials", async () => {
    let lifecycleState = "ready";
    let incarnation = "incarnation-1";
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState,
        conversations: [
          {
            id: "conversation-1",
            mailboxIncarnationId: incarnation,
          },
        ],
      },
    }));
    overrides.set("get_environment", () => ({ id: "env-2", projectId: "project-2" }));
    const issue = () =>
      server.issueCoordinatorCredential({
        role: "coordinator",
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
        mailboxIncarnationId: "incarnation-1",
        capabilities: ["environments", "discovery"],
      });

    let credential = issue();
    const crossProject = await rpc(credential.url, credential.token, "tools/call", {
      name: "start_environment",
      arguments: { environmentId: "env-2" },
    });
    expect(crossProject.body.result?.isError).toBe(true);
    const crossProjectTranscript = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_tab_transcript",
      arguments: { environmentId: "env-2", tabId: "tab-1" },
    });
    expect(crossProjectTranscript.body.result?.isError).toBe(true);
    const deniedMutation = await rpc(credential.url, credential.token, "tools/call", {
      name: "update_config",
      arguments: { config: {} },
    });
    expect(deniedMutation.response.status).toBe(403);
    const missingDelegationBase = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "missing-base",
        projectId: "project-1",
        agent: "codex",
        prompt: "Delegate this work",
      },
    });
    expect(missingDelegationBase.body.result?.isError).toBe(true);

    lifecycleState = "paused";
    expect((await rpc(credential.url, credential.token, "tools/list")).response.status).toBe(409);
    lifecycleState = "ready";
    incarnation = "incarnation-2";
    expect((await rpc(credential.url, credential.token, "tools/list")).response.status).toBe(401);

    incarnation = "incarnation-1";
    credential = issue();
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now + 12 * 60 * 60 * 1_000 + 1);
    try {
      expect((await rpc(credential.url, credential.token, "tools/list")).response.status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });

  test("keeps the original operator tools first without leaking project paths", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const listed = await rpc(descriptor.url, descriptor.token, "tools/list");
    expect(listed.response.status).toBe(200);
    // The full profile lists the original tools first; the voice core, the
    // gateway and the direct tools follow (control-mcp-voice.test.ts).
    expect(listed.body.result?.tools?.map(({ name }) => name).slice(0, 18)).toEqual([
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
    const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_job",
      arguments: {
        requestId: "external-job-1",
        environmentId: "env-1",
        agent: "codex",
        modelId: "gpt-5.6-codex",
        reasoningId: "high",
        fastMode: true,
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
    const launch = invocations.find(({ command }) => command === "launch_control_job")?.args;
    expect(launch).toMatchObject({
      activateTab: true,
      requestId: "external-job-1",
      environmentId: "env-1",
      agent: "codex",
      modelId: "gpt-5.6-codex",
      reasoningId: "high",
      fastMode: true,
      conversationMode: "build",
      title: "Fix the failing suite",
    });
    // A coordinator's prompt is framed as a delegation around the original text.
    expect(String(launch?.prompt)).toContain("Diagnose and fix the failing test suite.");
  });

  test("rejects disabled agents and invalid model or reasoning selections", async () => {
    const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
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
    overrides.set("get_native_agent_model_catalog", () => [
      {
        id: "gpt-5.6-codex",
        label: "GPT-5.6 Codex",
        platform: "codex",
        supportsSpeed: false,
        reasoning: [{ id: "high", label: "High" }],
      },
    ]);
    const unavailableFastMode = await call({ modelId: "gpt-5.6-codex", fastMode: true });
    expect(unavailableFastMode.body.result?.isError).toBe(true);
    expect(invocations.filter(({ command }) => command === "launch_control_job")).toHaveLength(0);
  });

  test("get_launch_options marks what an omitted model and effort resolve to", async () => {
    overrides.set("get_config", () => ({
      global: {
        enabledAgentPlatforms: ["codex"],
        agentSettings: { platforms: { codex: { model: "gpt-5.6-codex" } } },
      },
    }));
    overrides.set("get_native_agent_model_catalog", () => [
      {
        id: "gpt-5.6-codex",
        label: "GPT-5.6 Codex",
        platform: "codex",
        reasoning: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        defaultReasoningId: "medium",
      },
      {
        id: "gpt-5.6-mini",
        label: "GPT-5.6 Mini",
        platform: "codex",
        reasoning: [{ id: "low", label: "Low" }],
        defaultReasoningId: "low",
      },
    ]);
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const listed = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    const options = listed.body.result?.structuredContent as {
      enabledAgents: string[];
      models: Array<{ id: string; isDefault?: boolean }>;
      defaults: { agent: string; byAgent: Record<string, unknown>; guidance: string };
    };
    expect(options.enabledAgents).toEqual(["codex"]);
    expect(options.defaults).toMatchObject({
      agent: "codex",
      byAgent: { codex: { modelId: "gpt-5.6-codex", reasoningId: "medium" } },
    });
    expect(options.defaults.guidance).toContain("Omit modelId and reasoningId");
    expect(options.models.map(({ id, isDefault }) => [id, isDefault === true])).toEqual([
      ["gpt-5.6-codex", true],
      ["gpt-5.6-mini", false],
    ]);
  });

  test("reports whether a launch runs the defaults or a requested selection", async () => {
    overrides.set("get_config", () => ({
      global: {
        enabledAgentPlatforms: ["codex"],
        agentMessaging: { enabled: true },
        agentSettings: { platforms: { codex: { model: "gpt-5.6-codex" } } },
      },
    }));
    // The repository tier is read too, the way the startup launch reads it.
    overrides.set("get_repository_config", () => ({
      agentSettings: { platforms: { codex: { reasoningEffort: "high" } } },
    }));
    overrides.set("get_native_agent_model_catalog", () => [
      {
        id: "gpt-5.6-codex",
        label: "GPT-5.6 Codex",
        platform: "codex",
        reasoning: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
        defaultReasoningId: "medium",
      },
      {
        id: "gpt-5.6-mini",
        label: "GPT-5.6 Mini",
        platform: "codex",
        reasoning: [{ id: "low", label: "Low" }],
        defaultReasoningId: "low",
      },
    ]);
    overrides.set("launch_coordinator_environment", () => ({
      environment: { id: "env-new", projectId: "project-1", status: "creating" },
    }));
    const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
    const job = (arguments_: Record<string, unknown>) =>
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

    const defaulted = await job({});
    expect(defaulted.body.result?.structuredContent?.selection).toEqual({
      agent: "codex",
      model: "gpt-5.6-codex",
      reasoning: "high",
      source: "default",
    });
    // Nothing is pinned on the launch, so the backend's own resolution applies.
    const defaultedLaunch = invocations.findLast(({ command }) => command === "launch_control_job");
    expect(defaultedLaunch?.args.modelId).toBeUndefined();
    expect(defaultedLaunch?.args.reasoningId).toBeUndefined();

    // A pinned model that does not offer the inherited effort runs its own default.
    const otherModel = await job({ modelId: "gpt-5.6-mini" });
    expect(otherModel.body.result?.structuredContent?.selection).toEqual({
      agent: "codex",
      model: "gpt-5.6-mini",
      reasoning: "low",
      source: "requested",
    });
    const pinned = await job({ modelId: "gpt-5.6-codex", reasoningId: "medium" });
    expect(pinned.body.result?.structuredContent?.selection).toEqual({
      agent: "codex",
      model: "gpt-5.6-codex",
      reasoning: "medium",
      source: "requested",
    });

    const environment = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "environment-defaults",
        projectId: "project-1",
        agent: "codex",
        prompt: "Build it.",
        ...BASE,
      },
    });
    expect(environment.body.result?.structuredContent?.selection).toEqual({
      agent: "codex",
      model: "gpt-5.6-codex",
      reasoning: "high",
      source: "default",
      advisory: true,
    });
    const created = invocations.find(({ command }) => command === "launch_coordinator_environment")
      ?.args.input as Record<string, unknown> | undefined;
    expect(created?.initialAgentModel).toBeUndefined();
    expect(created?.initialReasoningEffort).toBeUndefined();
  });

  test("environment replay reports persisted startup controls after defaults change", async () => {
    const accepted = { id: "env-replayed", projectId: "project-1", status: "running" };
    overrides.set("launch_coordinator_environment", () => ({ environment: accepted }));
    overrides.set("get_native_agent_session", () => ({
      agent: "codex",
      controls: { modelId: "original-model", reasoningId: "high" },
    }));
    const descriptor = coordinatorCredential(["discovery", "environments"]);
    const launch = () =>
      rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_environment",
        arguments: {
          requestId: "replay-defaults",
          projectId: "project-1",
          agent: "codex",
          prompt: "Work",
          ...BASE,
        },
      });
    const first = await launch();
    overrides.set("get_repository_config", () => ({
      agentSettings: { platforms: { codex: { model: "new-model", reasoningEffort: "low" } } },
    }));
    const replay = await launch();
    expect(replay.body.result?.structuredContent?.selection).toEqual(
      first.body.result?.structuredContent?.selection,
    );
    expect(replay.body.result?.structuredContent?.selection).toEqual({
      agent: "codex",
      model: "original-model",
      reasoning: "high",
      source: "default",
    });
    // The transient startup snapshot is authoritative too, including terminal launches.
    overrides.set("launch_coordinator_environment", () => ({
      environment: {
        ...accepted,
        startupAgentSession: {
          agent: "codex",
          model: "terminal-model",
          reasoningEffort: "medium",
          style: "terminal",
        },
      },
    }));
    expect((await launch()).body.result?.structuredContent?.selection).toMatchObject({
      model: "terminal-model",
      reasoning: "medium",
    });
  });

  test("environment effort report matches startup's unfiltered inherited effort", async () => {
    overrides.set("get_repository_config", () => ({
      agentSettings: { platforms: { codex: { reasoningEffort: "high" } } },
    }));
    overrides.set("get_native_agent_model_catalog", () => [
      {
        platform: "codex",
        id: "mini",
        label: "Mini",
        reasoning: [{ id: "low", label: "Low" }],
        defaultReasoningId: "low",
      },
    ]);
    overrides.set("launch_coordinator_environment", () => ({
      environment: { id: "env-new", projectId: "project-1", status: "creating" },
    }));
    const descriptor = coordinatorCredential(["discovery", "environments"]);
    const result = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "effort",
        projectId: "project-1",
        agent: "codex",
        modelId: "mini",
        prompt: "Work",
        ...BASE,
      },
    });
    expect(result.body.result?.structuredContent?.selection).toEqual({
      agent: "codex",
      model: "mini",
      reasoning: "high",
      source: "requested",
      advisory: true,
    });
    const created = invocations.find(({ command }) => command === "launch_coordinator_environment")!
      .args.input as Record<string, unknown>;
    expect(created.initialAgentModel).toBe("mini");
    // Startup resolves this absent override directly from the repository tier.
    expect(created.initialReasoningEffort).toBeUndefined();
  });

  test("settings failures omit advisory defaults and selection without failing launch", async () => {
    overrides.set("get_repository_config", () => {
      throw new Error("settings unavailable");
    });
    overrides.set("launch_coordinator_environment", () => ({
      environment: { id: "env-new", projectId: "project-1", status: "creating" },
    }));
    const descriptor = coordinatorCredential(["discovery", "environments"]);
    const options = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(options.body.result?.isError).not.toBe(true);
    expect(options.body.result?.structuredContent?.defaults).toBeUndefined();
    const launch = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "unreadable",
        projectId: "project-1",
        agent: "codex",
        prompt: "Work",
        ...BASE,
      },
    });
    expect(launch.body.result?.isError).not.toBe(true);
    expect(launch.body.result?.structuredContent?.selection).toBeUndefined();
  });

  test("reports a created environment when its start is not admitted", async () => {
    overrides.set("launch_coordinator_environment", () => ({
      environment: { id: "env-new", projectId: "project-1", status: "stopped" },
      startError: "Lifecycle admission closed",
    }));
    const descriptor = coordinatorCredential(["discovery", "environments"]);
    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "environment-request-2",
        projectId: "project-1",
        agent: "codex",
        prompt: "Build it.",
        ...BASE,
      },
    });

    expect(launched.body.result?.structuredContent).toMatchObject({
      environmentId: "env-new",
      status: "created",
      error: "Lifecycle admission closed",
    });
  });

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
          global: { enabledAgentPlatforms: ["codex"], agentMessaging: { enabled: true } },
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
        "Omit modelId and reasoningId to use the user's configured defaults",
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

  test("reports an unavailable checkout base without calling git status", async () => {
    const issue = (workspace: Record<string, unknown>) => {
      overrides.set("get_project_coordinator", () => ({ workspace }));
      return server.issueCoordinatorCredential({
        role: "coordinator",
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
        mailboxIncarnationId: "incarnation-1",
        capabilities: ["discovery", "environments"],
      });
    };
    const callLaunchOptions = async (workspace: Record<string, unknown>) => {
      const credential = issue(workspace);
      const gitStatusBefore = invocations.filter(
        ({ command }) => command === "get_project_git_status",
      ).length;
      const result = await rpc(credential.url, credential.token, "tools/call", {
        name: "get_launch_options",
        arguments: { projectId: "project-1" },
      });
      expect(
        invocations.filter(({ command }) => command === "get_project_git_status"),
      ).toHaveLength(gitStatusBefore);
      return result.body.result?.structuredContent;
    };

    // A detached or unborn checkout leaves the base-branch default launchable.
    expect(
      await callLaunchOptions({
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
        repositoryStatus: {
          branch: null,
          headCommit: "a".repeat(40),
          detached: true,
          unborn: false,
        },
      }),
    ).toMatchObject({
      enabledAgents: ["codex"],
      coordinatorBase: { baseBranch: "main", baseCommit: "a".repeat(40), available: true },
      checkoutBase: {
        baseBranch: null,
        baseCommit: "a".repeat(40),
        available: false,
        unavailableReason: "detached HEAD",
        source: "checkout",
      },
    });

    expect(
      await callLaunchOptions({
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
        repositoryStatus: {
          branch: "main",
          headCommit: null,
          detached: false,
          unborn: true,
        },
      }),
    ).toMatchObject({
      enabledAgents: ["codex"],
      checkoutBase: {
        baseBranch: "main",
        baseCommit: null,
        available: false,
        unavailableReason: "unborn repository",
      },
    });

    let coordinatorReads = 0;
    overrides.set("get_project_coordinator", () => {
      coordinatorReads += 1;
      if (coordinatorReads > 1) throw new Error("Project Git is unavailable");
      return {
        workspace: {
          id: "coordinator-1",
          lifecycleState: "ready",
          conversations: [
            {
              id: "conversation-1",
              tabId: "coordinator-tab",
              mailboxIncarnationId: "incarnation-1",
            },
          ],
        },
      };
    });
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "environments"],
    });
    const failed = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(failed.body.result?.isError).not.toBe(true);
    expect(failed.body.result?.structuredContent).toMatchObject({
      enabledAgents: ["codex"],
      checkoutBase: {
        baseBranch: null,
        baseCommit: null,
        available: false,
        unavailableReason: "Repository status is unavailable: Project Git is unavailable",
      },
    });
  });

  test("defaults coordinator launches to the base branch's latest commit", async () => {
    // The checkout sits on a feature branch, behind the base branch.
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
        repositoryStatus: {
          branch: "feature",
          headCommit: "c".repeat(40),
          detached: false,
          unborn: false,
        },
      },
    }));
    overrides.set("get_project_base_branch_tip", () => ({
      branch: "develop",
      commit: "b".repeat(40),
      ref: "origin/develop",
      fetched: false,
      fetchError: "Could not resolve host",
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "environments"],
    });
    const options = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(options.body.result?.structuredContent).toMatchObject({
      coordinatorBase: {
        baseBranch: "develop",
        baseCommit: "b".repeat(40),
        available: true,
        source: "base-branch",
        ref: "origin/develop",
        // A failed fetch still answers, but says the remote may have moved on.
        remoteState: "stale",
        fetchError: "Could not resolve host",
        requiredFor: "launch_environment",
      },
      checkoutBase: {
        baseBranch: "feature",
        baseCommit: "c".repeat(40),
        available: true,
        source: "checkout",
      },
    });

    overrides.set("get_project_base_branch_tip", () => ({
      branch: "develop",
      commit: null,
      ref: null,
      fetched: false,
      unavailableReason: "Base branch develop was not found locally or on origin",
    }));
    const missing = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(missing.body.result?.structuredContent).toMatchObject({
      coordinatorBase: {
        baseBranch: "develop",
        baseCommit: null,
        available: false,
        unavailableReason: "Base branch develop was not found locally or on origin",
      },
    });
  });

  test("base discovery failure stays unavailable without silently using the checkout", async () => {
    overrides.set("get_project_base_branch_tip", () => {
      throw new Error("git read failed");
    });
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
        repositoryStatus: { branch: "feature", headCommit: "c".repeat(40) },
      },
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery"],
    });
    const tools = await rpc(credential.url, credential.token, "tools/list");
    expect(
      tools.body.result?.tools?.find((tool) => tool.name === "get_launch_options")?.annotations,
    ).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    const options = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(options.body.result?.isError).not.toBe(true);
    expect(options.body.result?.structuredContent).toMatchObject({
      coordinatorBase: {
        baseBranch: null,
        baseCommit: null,
        available: false,
        unavailableReason: "Base branch is unavailable: git read failed",
      },
      checkoutBase: { baseBranch: "feature", baseCommit: "c".repeat(40), available: true },
    });
  });

  test.each(["launch_environment", "start_build_pipeline"])(
    "%s refuses an unverifiable base before starting work",
    async (tool) => {
      overrides.set("get_project_coordinator", () => ({
        workspace: {
          id: "coordinator-1",
          lifecycleState: "ready",
          conversations: [
            {
              id: "conversation-1",
              tabId: "coordinator-tab",
              mailboxIncarnationId: "incarnation-1",
            },
          ],
        },
      }));
      const credential = server.issueCoordinatorCredential({
        role: "coordinator",
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId: "conversation-1",
        mailboxIncarnationId: "incarnation-1",
        capabilities: ["environments", "build-pipelines"],
      });
      const launch = () =>
        rpc(credential.url, credential.token, "tools/call", {
          name: tool,
          arguments: {
            requestId: "invalid-base",
            projectId: "project-1",
            agent: "codex",
            prompt: "Fix it",
            taskId: "task-1",
            taskTitle: "Task",
            taskSnapshot: { title: "Task", description: "", acceptanceCriteria: "" },
            baseBranch: "main",
            baseCommit: "b".repeat(40),
          },
        });
      overrides.set("verify_project_launch_base", () => ({
        contained: false,
        reason: "the commit is not on main",
      }));
      const stray = await launch();
      expect(stray.body.result?.isError).toBe(true);
      expect(JSON.stringify(stray.body)).toContain("the commit is not on main");
      expect(JSON.stringify(stray.body)).toContain("Refresh get_launch_options");
      overrides.set("verify_project_launch_base", () => {
        throw new Error("git unavailable");
      });
      const failed = await launch();
      expect(failed.body.result?.isError).toBe(true);
      expect(JSON.stringify(failed.body)).toContain(
        "Coordinator launch base could not be verified: git unavailable",
      );
      expect(JSON.stringify(failed.body)).toContain("Refresh get_launch_options");
      expect(
        invocations.some(({ command }) =>
          ["launch_coordinator_environment", "start_coordinator_build_pipeline"].includes(command),
        ),
      ).toBe(false);
    },
  );

  test("rejects coordinator launches whose commit is not on the named branch", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
        repositoryStatus: {
          branch: "feature",
          headCommit: "c".repeat(40),
          detached: false,
          unborn: false,
        },
      },
    }));
    overrides.set("get_project_git_status", () => ({
      branch: "feature",
      headCommit: "c".repeat(40),
      trackedChanges: 2,
      untrackedChanges: 0,
    }));
    // main holds a…, feature holds c…; nothing holds b….
    overrides.set("verify_project_launch_base", ({ branch, commit }) => {
      const tip = { main: "a".repeat(40), feature: "c".repeat(40) }[branch as string];
      if (!tip)
        return { contained: false, reason: `${branch} does not exist in the project checkout` };
      return String(commit).toLowerCase() === tip
        ? { contained: true }
        : { contained: false, reason: `the commit is not on ${branch}` };
    });
    let launched = 0;
    overrides.set("launch_coordinator_environment", () => {
      launched += 1;
      return {
        environment: { id: "env-worker", projectId: "project-1", status: "running" },
        coordinatorDelegationOpened: true,
      };
    });
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "environments"],
    });
    const launch = (baseBranch: string, baseCommit: string) =>
      rpc(credential.url, credential.token, "tools/call", {
        name: "launch_environment",
        arguments: {
          requestId: `launch-${baseBranch}-${baseCommit.slice(0, 8)}`,
          projectId: "project-1",
          agent: "codex",
          prompt: "Fix the failing test.",
          baseBranch,
          baseCommit,
        },
      });

    const strayCommit = await launch("main", "b".repeat(40));
    expect(strayCommit.body.result?.isError).toBe(true);
    expect(JSON.stringify(strayCommit.body)).toContain("the commit is not on main");
    expect(JSON.stringify(strayCommit.body)).toContain("Refresh get_launch_options");

    const missingBranch = await launch("another", "a".repeat(40));
    expect(missingBranch.body.result?.isError).toBe(true);
    expect(JSON.stringify(missingBranch.body)).toContain("Refresh get_launch_options");
    expect(launched).toBe(0);

    // The base branch's tip launches although the checkout is elsewhere, and
    // the checkout's dirty state is not reported for a base it is not on.
    const fromBase = await launch("main", "A".repeat(40));
    expect(fromBase.body.result?.isError).not.toBe(true);
    expect(fromBase.body.result?.structuredContent).toMatchObject({
      environmentId: "env-worker",
      delegationBaseBranch: "main",
      delegationBaseCommit: "A".repeat(40),
    });
    expect(fromBase.body.result?.structuredContent).not.toHaveProperty(
      "liveCheckoutHasUncommittedChanges",
    );
    expect(
      invocations.find(({ command }) => command === "launch_coordinator_environment")?.args,
    ).toMatchObject({
      input: { delegationBaseBranch: "main", delegationBaseCommit: "A".repeat(40) },
    });

    // Building on the checkout stays possible when asked for, and says that
    // its uncommitted changes are not part of the worker's base.
    const fromCheckout = await launch("feature", "c".repeat(40));
    expect(fromCheckout.body.result?.structuredContent).toMatchObject({
      environmentId: "env-worker",
      liveCheckoutHasUncommittedChanges: true,
    });
    expect(launched).toBe(2);
  });

  test("uses the worker's live catalog when the project home is the first snapshot", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    overrides.set("get_environment_snapshots", () => [
      { id: "env-home", projectId: "project-1", projectHome: true, status: "running" },
      { id: "env-worker", projectId: "project-1", status: "running", setupStatus: "ready" },
    ]);
    const workerModels = [
      {
        id: "worker-live-model",
        label: "Worker live model",
        platform: "codex",
        supportsSpeed: true,
        reasoning: [{ id: "high", label: "High" }],
      },
    ];
    overrides.set("get_native_agent_model_catalog", ({ environmentId }) => {
      expect(environmentId).toBe("env-worker");
      return workerModels;
    });
    overrides.set("get_agent_model_catalog_cache", () => ({
      schemaVersion: 1,
      codex: {
        updatedAt: new Date(0).toISOString(),
        models: [{ id: "cached-model", name: "Cached model" }],
      },
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery"],
    });

    const options = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(options.body.result?.isError).not.toBe(true);
    expect(options.body.result?.structuredContent?.models).toEqual(workerModels);
    expect(
      invocations.filter(({ command }) => command === "get_native_agent_model_catalog"),
    ).toEqual([
      { command: "get_native_agent_model_catalog", args: { environmentId: "env-worker" } },
    ]);
    expect(
      invocations.filter(
        ({ command }) =>
          command === "get_agent_model_catalog_cache" ||
          command === "get_opencode_model_catalog_cache",
      ),
    ).toHaveLength(0);
  });

  test("lets a coordinator launch when the project home is the only environment", async () => {
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
    overrides.set("get_environment_snapshots", () => [
      { id: "env-home", projectId: "project-1", projectHome: true, status: "running" },
    ]);
    overrides.set("get_environment", () => ({
      id: "env-home",
      projectId: "project-1",
      projectHome: true,
    }));
    overrides.set("get_project_git_status", () => ({
      branch: "main",
      headCommit: "a".repeat(40),
    }));
    overrides.set("launch_coordinator_environment", () => ({
      environment: { id: "env-worker", projectId: "project-1", status: "running" },
      coordinatorDelegationOpened: true,
    }));
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: ["discovery", "environments"],
    });

    const options = await rpc(credential.url, credential.token, "tools/call", {
      name: "get_launch_options",
      arguments: { projectId: "project-1" },
    });
    expect(options.body.result?.isError).not.toBe(true);
    expect(options.body.result?.structuredContent).toMatchObject({
      enabledAgents: ["codex"],
      coordinatorBase: { baseBranch: "main", baseCommit: "a".repeat(40), available: true },
    });

    const launched = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "launch-home-only",
        projectId: "project-1",
        agent: "codex",
        prompt: "Fix the failing test.",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
      },
    });
    expect(launched.body.result?.isError).not.toBe(true);
    expect(launched.body.result?.structuredContent).toMatchObject({
      environmentId: "env-worker",
    });
    expect(
      invocations.some(
        ({ command, args }) =>
          command === "get_native_agent_model_catalog" && args.environmentId === "env-home",
      ),
    ).toBe(false);
  });
});

describe("controlMcpPortOverride", () => {
  test("only the installed app's backends take the fixed port", () => {
    const app = { NODE_ENV: "production" };
    expect(controlMcpPortOverride("production", app)).toBeUndefined();
    expect(controlMcpPortOverride(undefined, app)).toBeUndefined();
    expect(controlMcpPortOverride("development", app)).toBeUndefined();
    // A qualification service or headless agent-test backend left running
    // must never hold the port the desktop needs.
    expect(controlMcpPortOverride("agent-test", app)).toBe(0);
    expect(controlMcpPortOverride("production", { NODE_ENV: "test" })).toBe(0);
  });

  test("an explicit port still applies to an agent-test backend", () => {
    const env = { NODE_ENV: "production", ORKESTRATOR_CONTROL_MCP_PORT: "45000" };
    expect(controlMcpPortOverride("agent-test", env)).toBeUndefined();
    expect(controlMcpPortOverride("agent-test", { ORKESTRATOR_CONTROL_MCP_PORT: " " })).toBe(0);
  });
});
