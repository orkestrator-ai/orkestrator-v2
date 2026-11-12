import { controlJobId } from "../control-job-identity.js";
import { beforeEach, describe, expect, test } from "bun:test";
import { type ControlMcpServer, readControlMcpDescriptor } from "./server.js";
import {
  COORDINATOR_WORKER_NO_PR_INSTRUCTION,
  COORDINATOR_WORKER_VALIDATION_INSTRUCTION,
} from "@orkestrator/protocol/review-evidence-frames";
import {
  COORDINATOR_REPLAYED_NOTE,
  COORDINATOR_REQUEST_ID_RULE,
} from "@orkestrator/protocol/coordinator";
import { BASE, rpc, useControlMcpServerHarness } from "./server-test-support.js";

/**
 * The launch tools in `tools.ts`: `get_launch_options`,
 * `launch_environment`, `launch_job` and the coordinator launch base.
 * The shared server and invoker are in `server-test-support.ts`.
 */
describe("Orkestrator control MCP server", () => {
  const harness = useControlMcpServerHarness();
  const { invocations, overrides, coordinatorCredential } = harness;
  let server: ControlMcpServer;
  beforeEach(() => {
    server = harness.server;
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
      activateTab: false,
      requestId: "external-job-1",
      environmentId: "env-1",
      agent: "codex",
      modelId: "gpt-5.6-codex",
      reasoningId: "high",
      fastMode: true,
      conversationMode: "build",
      title: "Fix the failing suite",
    });
    expect(
      invocations.find(({ command }) => command === "open_coordinator_delegation")?.args,
    ).toMatchObject({
      request: {
        summary: "Diagnose and fix the failing test suite.",
        agent: "codex",
        model: "gpt-5.6-codex",
        source: "requested",
      },
    });
    // A coordinator's prompt is framed as a delegation around the original text.
    expect(String(launch?.prompt)).toContain("Diagnose and fix the failing test suite.");
    expect(String(launch?.prompt)).toContain(COORDINATOR_WORKER_NO_PR_INSTRUCTION);
    expect(String(launch?.prompt)).toContain(COORDINATOR_WORKER_VALIDATION_INSTRUCTION);
  });

  test("a dispatched job explains delegation failure without suggesting another dispatch", async () => {
    overrides.set("open_coordinator_delegation", () => {
      throw new Error("requestId reused");
    });
    const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_job",
      arguments: {
        requestId: "delegation-conflict",
        environmentId: "env-1",
        agent: "codex",
        prompt: "Work",
      },
    });
    expect(launched.body.result?.isError).not.toBe(true);
    expect(launched.body.result?.structuredContent?.delegationNote).toContain(
      "no delegation was opened",
    );
    expect(launched.body.result?.structuredContent?.delegationNote).toContain(
      "Do not dispatch again",
    );
  });

  test("pending startup replay uses the saved agent even when current defaults change", async () => {
    const environment = {
      id: "saved",
      projectId: "project-1",
      agentSettings: { defaultAgent: "codex" },
    };
    overrides.set("get_coordinator_launch_environment", () => environment);
    overrides.set("get_repository_config", () => ({ agentSettings: { defaultAgent: "claude" } }));
    overrides.set("launch_coordinator_environment", () => ({ environment, replayed: true }));
    const descriptor = coordinatorCredential(["discovery", "environments"]);
    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_environment",
      arguments: {
        requestId: "saved",
        projectId: "project-1",
        baseBranch: "main",
        baseCommit: "a".repeat(40),
        prompt: "Work",
      },
    });
    expect(launched.body.result?.isError).not.toBe(true);
    expect(launched.body.result?.structuredContent).toMatchObject({
      replayed: true,
      selection: { agent: "codex" },
    });
  });

  test("defaulted job retry validates its saved platform after the environment default changes", async () => {
    overrides.set("get_config", () => ({ global: { enabledAgentPlatforms: ["codex", "claude"] } }));
    overrides.set("get_environment", () => ({
      id: "env-1",
      projectId: "project-1",
      agentSettings: { defaultAgent: "claude" },
    }));
    overrides.set("get_pane_layout", () => ({
      root: {
        kind: "leaf",
        id: "leaf",
        activeTabId: null,
        tabs: [
          {
            id: `agent-job-${controlJobId("env-1", "saved-job")}`,
            type: "agent-native",
            nativeAgentData: { platform: "codex" },
          },
        ],
      },
    }));
    const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
    const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
      name: "launch_job",
      arguments: {
        requestId: "saved-job",
        environmentId: "env-1",
        modelId: "gpt-5.6-codex",
        prompt: "Work",
      },
    });
    expect(launched.body.result?.isError, JSON.stringify(launched.body.result)).not.toBe(true);
    expect(
      invocations.findLast((item) => item.command === "launch_control_job")?.args,
    ).toMatchObject({ agent: "codex", agentDefaulted: true });
    expect(launched.body.result?.structuredContent?.selection).toMatchObject({ agent: "codex" });
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
    expect(options.defaults.guidance).toContain("Omit agent, modelId and reasoningId");
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

  describe("an omitted agent runs the user's default agent", () => {
    // Claude is the built-in fallback and listed first; the saved default is Codex.
    const settings = () => {
      overrides.set("get_config", () => ({
        global: { enabledAgentPlatforms: ["claude", "codex"], agentMessaging: { enabled: true } },
      }));
      overrides.set("get_repository_config", () => ({ agentSettings: { defaultAgent: "codex" } }));
    };

    test("neither launch tool requires agent", async () => {
      const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
      const listed = await rpc(descriptor.url, descriptor.token, "tools/list", {});
      const tools = listed.body.result?.tools as Array<{
        name: string;
        inputSchema: { required?: string[]; properties: Record<string, { description?: string }> };
      }>;
      for (const name of ["launch_environment", "launch_job"]) {
        const schema = tools.find((tool) => tool.name === name)!.inputSchema;
        expect(schema.required ?? []).not.toContain("agent");
        expect(schema.properties.agent?.description).toContain("default agent");
      }
    });

    test("launch_environment", async () => {
      settings();
      overrides.set("launch_coordinator_environment", () => ({
        environment: { id: "env-new", projectId: "project-1", status: "creating" },
      }));
      const descriptor = coordinatorCredential(["discovery", "environments"]);
      const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_environment",
        arguments: {
          requestId: "default-agent",
          projectId: "project-1",
          prompt: "Build it.",
          ...BASE,
        },
      });
      expect(launched.body.result?.isError).not.toBe(true);
      expect(launched.body.result?.structuredContent?.selection).toMatchObject({
        agent: "codex",
        source: "default",
      });
      const call = invocations.findLast(
        ({ command }) => command === "launch_coordinator_environment",
      )?.args as { input: { agentSettings: { defaultAgent: string } }; agentDefaulted?: boolean };
      expect(call.input.agentSettings.defaultAgent).toBe("codex");
      // The request is recorded as "the default", so a retry survives a settings change.
      expect(call.agentDefaulted).toBe(true);

      // A named agent is the caller's choice and is not marked as defaulted.
      await rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_environment",
        arguments: {
          requestId: "named-agent",
          projectId: "project-1",
          agent: "claude",
          prompt: "Build it.",
          ...BASE,
        },
      });
      const named = invocations.findLast(
        ({ command }) => command === "launch_coordinator_environment",
      )?.args as { input: { agentSettings: { defaultAgent: string } }; agentDefaulted?: boolean };
      expect(named.input.agentSettings.defaultAgent).toBe("claude");
      expect(named.agentDefaulted).toBeUndefined();
    });

    test("launch_job takes the environment's own default", async () => {
      settings();
      overrides.set("get_environment", () => ({
        id: "env-1",
        projectId: "project-1",
        name: "Existing environment",
        status: "running",
        setupStatus: "ready",
        environmentType: "local",
        agentSettings: { defaultAgent: "claude" },
      }));
      const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
      const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_job",
        arguments: { requestId: "job-default-agent", environmentId: "env-1", prompt: "Do work." },
      });
      expect(launched.body.result?.isError).not.toBe(true);
      expect(launched.body.result?.structuredContent?.selection).toMatchObject({
        agent: "claude",
        source: "default",
      });
      expect(
        invocations.findLast(({ command }) => command === "launch_control_job")?.args.agent,
      ).toBe("claude");

      // Without an environment tier the repository's default applies.
      overrides.delete("get_environment");
      await rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_job",
        arguments: { requestId: "job-repository-agent", environmentId: "env-1", prompt: "Go." },
      });
      expect(
        invocations.findLast(({ command }) => command === "launch_control_job")?.args.agent,
      ).toBe("codex");
    });

    test("no enabled platform is refused before anything launches", async () => {
      overrides.set("get_config", () => ({ global: { enabledAgentPlatforms: [] } }));
      const descriptor = coordinatorCredential(["discovery", "environments", "jobs"]);
      const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_job",
        arguments: { requestId: "job-no-agent", environmentId: "env-1", prompt: "Do work." },
      });
      expect(launched.body.result?.isError).toBe(true);
      expect(invocations.some(({ command }) => command === "launch_control_job")).toBe(false);
    });
  });

  describe("request ids", () => {
    test("coordinators are told to make a new id per action and reuse one only to retry", async () => {
      const descriptor = coordinatorCredential(["discovery", "environments", "multi-review"]);
      const initialized = await rpc(descriptor.url, descriptor.token, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      const instructions = (initialized.body.result as unknown as { instructions: string })
        .instructions;
      expect(instructions).toContain(COORDINATOR_REQUEST_ID_RULE);
      expect(instructions).not.toContain("Reuse requestId when retrying");
      expect(instructions).not.toContain("start_multi_review");
      const listed = await rpc(descriptor.url, descriptor.token, "tools/list", {});
      const tools = (listed.body.result?.tools ?? []) as Array<{
        name: string;
        description: string;
      }>;
      const launch = tools.find((tool) => tool.name === "launch_environment")!;
      expect(launch.description).toContain("Use a new requestId for each new launch");
    });

    test("a replayed launch says it started nothing new", async () => {
      overrides.set("launch_coordinator_environment", () => ({
        environment: { id: "env-earlier", projectId: "project-1", status: "running" },
        coordinatorDelegationOpened: false,
        replayed: true,
      }));
      const descriptor = coordinatorCredential(["discovery", "environments"]);
      const launched = await rpc(descriptor.url, descriptor.token, "tools/call", {
        name: "launch_environment",
        arguments: { requestId: "launch-1", projectId: "project-1", prompt: "Go.", ...BASE },
      });
      expect(launched.body.result?.structuredContent).toMatchObject({
        environmentId: "env-earlier",
        replayed: true,
        replayNote: COORDINATOR_REPLAYED_NOTE,
      });
    });
  });
});
