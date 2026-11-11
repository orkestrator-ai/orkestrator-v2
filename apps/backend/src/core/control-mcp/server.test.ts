import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { stat } from "node:fs/promises";
import { MailWorld } from "../agent-mail-world-test-support.js";
import {
  type ControlMcpServer,
  readControlMcpDescriptor,
  type ControlMcpInvoker,
} from "./server.js";
import { coordinatorRoleCapabilities } from "./tools.js";
import { coordinatorDelegationPresentationFrom } from "../coordinator-delegation-authority.js";
import {
  COORDINATOR_CONTROL_TOOL_NAMES,
  COORDINATOR_WORKFLOW_STATUS_WAKE,
} from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_DELEGATION_PRESENTATION,
  parseCoordinatorDelegatedPrompt,
} from "@orkestrator/protocol/review-evidence-frames";
import { rpc, rpcPayload, useControlMcpServerHarness } from "./server-test-support.js";

/**
 * Credentials, transport and the coordinator invoker guard (`server.ts`).
 * The shared server and invoker are in `server-test-support.ts`.
 */
describe("Orkestrator control MCP server", () => {
  const harness = useControlMcpServerHarness();
  const { invocations, overrides } = harness;
  let server: ControlMcpServer;
  beforeEach(() => {
    server = harness.server;
  });

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

    test("coordinator invoker directly refuses the environment merge command", async () => {
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
        checked.invoke("merge_environment_pr", { method: "squash", deleteBranch: true }),
      ).rejects.toThrow("Coordinator capability denied");
      expect(invocations.some((item) => item.command === "merge_environment_pr")).toBe(false);
      // Arming auto-merge would let the backend merge on the coordinator's behalf.
      await expect(
        checked.invoke("set_environment_auto_merge", { environmentId: "env-1", enabled: true }),
      ).rejects.toThrow("Coordinator capability denied");
      expect(invocations.some((item) => item.command === "set_environment_auto_merge")).toBe(false);
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
            "start_build_pipeline",
            {
              baseBranch: "main",
              baseCommit: "a".repeat(40),
              taskId: "task",
              agentType: "codex",
              taskTitle: "Address Findings",
              taskSnapshot: {
                title: "Address Findings",
                description: "Address Findings parser",
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
        for (const id of ["launched"]) {
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
          mode === "off" ? 0 : 1,
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
    for (const name of ["launch_environment", "launch_job", "send_prompt_to_tab"]) {
      const description = definitions.find((tool) => tool.name === name)?.description;
      expect(description).toContain("Never ask the worker to open a pull request");
      expect(description).toContain("State whether review follows");
      expect(description).toContain(
        "When review follows, ask for focused checks rather than a full test suite",
      );
      expect(description).toContain(
        "When no review follows, explicitly request all validation required by the repository before handoff",
      );
    }
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
      expect(required("launch_multi_review")).not.toContain(field);
    // The launch tool exposes auto-fix and auto-PR as optional, saved-by-default booleans.
    for (const name of ["launch_multi_review"]) {
      const tool = definitions.find((item) => item.name === name) as
        | {
            description?: string;
            inputSchema?: { properties?: Record<string, { type?: string; description?: string }> };
          }
        | undefined;
      expect(tool?.description).toContain(
        "Omit autoFix and autoPr to use the user's saved Auto-address findings and Auto-PR settings, as the button does; set them only when the user asks.",
      );
      expect(tool?.description).toContain(
        "A failed, stopped or stalled Address Findings starts no PR.",
      );
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
      "This is the default for any work whose whole spec is known (a ticket, or settled with the user).",
    );
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
    // The backend-only primitive is not offered to coordinators; launch_multi_review is.
    expect(definitions.some((tool) => tool.name === "start_multi_review")).toBe(false);
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
    // Auto-PR passes through untouched; the backend resolves Address Findings it implies.
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
        next: "Address Findings starts automatically if consolidation reports findings, then a PR session once Address Findings completes; a clean report starts the PR session directly.",
      },
    });
    const autoAddressFindingsOff = await rpc(credential.url, credential.token, "tools/call", {
      name: "launch_multi_review",
      arguments: {
        requestId: "launch-review-auto-fix-off",
        environmentId: "env-1",
        autoFix: false,
        autoPr: true,
      },
    });
    expect(autoAddressFindingsOff.body.result?.structuredContent?.selection).toMatchObject({
      source: { autoFix: "requested", autoPr: "requested" },
    });
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

  test("rejects cross-project environments and invalidates paused, superseded, and revoked credentials", async () => {
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
    server.revokeCoordinatorCredentials("coordinator-1", "conversation-1");
    expect((await rpc(credential.url, credential.token, "tools/list")).response.status).toBe(401);
  });

  test("refuses the credential of a conversation that failed to start, and only that one", async () => {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "main", mailboxIncarnationId: "incarnation-main" },
          {
            id: "side",
            mailboxIncarnationId: "incarnation-side",
            startupError: "bridge did not become healthy",
          },
        ],
      },
    }));
    const issue = (conversationId: string) =>
      server.issueCoordinatorCredential({
        role: "coordinator",
        projectId: "project-1",
        coordinatorId: "coordinator-1",
        conversationId,
        mailboxIncarnationId: `incarnation-${conversationId}`,
        capabilities: ["discovery"],
      });
    const failed = issue("side");
    const refused = await rpc(failed.url, failed.token, "tools/list");
    expect(refused.response.status).toBe(409);
    const working = issue("main");
    const answered = await rpc(working.url, working.token, "tools/list");
    expect(answered.response.status).toBe(200);
  });

  // A bridge reads its token once, at launch, so a credential that lapsed while
  // it sat idle overnight left a live coordinator with no tools at all: no
  // launches and no send_message to hand the work on with.
  test("a coordinator credential outlives any idle period while its bridge runs", async () => {
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
      capabilities: ["environments", "discovery", "mail"],
    });
    const later = Date.now() + 30 * 24 * 60 * 60 * 1_000;
    const clock = spyOn(Date, "now").mockReturnValue(later);
    try {
      const listed = await rpc(credential.url, credential.token, "tools/list");
      expect(listed.response.status).toBe(200);
    } finally {
      clock.mockRestore();
    }
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
