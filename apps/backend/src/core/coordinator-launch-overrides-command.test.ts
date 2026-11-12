import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_LAUNCH_OVERRIDES_COMMAND,
  type CoordinatorLaunchOverridesSnapshot,
} from "@orkestrator/protocol/coordinator-launch-overrides";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { launchDelegationRequest } from "./coordinator-delegation-request.js";
import { ControlMcpServer } from "./control-mcp/server.js";
import { coordinatorRoleCapabilities } from "./control-mcp/tools.js";
import { CoordinatorService } from "./coordinator-service.js";
import { cleanupSessionHarnesses, setup } from "./public-api/test-provider.js";
import { StorageService } from "./storage.js";

let root: string;
let storage: StorageService;
let commands: Map<string, CommandHandler>;

const list = () =>
  commands.get(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)!({}, { storage } as CommandContext);

/** A worker launched by a coordinator, from what the launch call was given. */
const launch = (
  requestId: string,
  input: Record<string, unknown>,
  extra: Partial<CoordinatorWorkflowAssociation> = {},
) =>
  storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: requestId,
    coordinatorId: "coordinator",
    projectId: "project",
    kind: "environment",
    resourceId: `worker-${requestId}`,
    requestId,
    createdAt: "2026-11-05T10:00:00.000Z",
    delegation: {
      requestedAt: "2026-11-05T10:00:00.000Z",
      workerTabId: "startup-agent",
      state: "running",
      request: launchDelegationRequest(input, { initialAgentModel: "saved-default" }),
    },
    ...extra,
  });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-coordinator-launch-overrides-"));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  commands = createCommandRegistry();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe(COORDINATOR_LAUNCH_OVERRIDES_COMMAND, () => {
  test("a backend with no coordinators answers empty rather than failing", async () => {
    expect(await list()).toEqual({ overrides: [] });
  });

  test("lists a launch that set a model or effort, and not one that used the default", async () => {
    await launch("requested", { initialAgentModel: "opus", initialReasoningEffort: "max" });
    await launch("default", {});
    expect(await list()).toEqual({
      overrides: [
        {
          environmentId: "worker-requested",
          tabId: "startup-agent",
          model: "opus",
          reasoning: "max",
        },
      ],
    });
  });

  test("a real model-only launch_job records the resolved selection on its actual tab", async () => {
    const { harness, stub, projectId } = await setup("claude");
    let server: ControlMcpServer | undefined;
    try {
      const { projectPath } = await harness.createRepository("job-override");
      await harness.storage.updateProject(projectId, { localPath: projectPath });
      await harness.storage.patchRepositorySettings(projectId, {
        coordinatorOtherEnvironments: true,
      });
      await harness.storage.updateEnvironment("env-1", {
        agentSettings: {
          defaultAgent: "claude",
          platforms: { claude: { model: "sonnet", reasoningEffort: "high" } },
        },
      });
      // Only the external provider and its catalogue are scripted. Job dispatch,
      // delegation admission and projection all use the real registry and store.
      harness.commands.set("get_native_agent_model_catalog", () => [
        { id: "opus", name: "Opus", platform: "claude", reasoning: [{ id: "high", name: "High" }] },
      ]);
      const coordinators = new CoordinatorService(harness.storage, () => ({
        enabled: true,
        running: true,
        error: null,
      }));
      harness.context.coordinators = coordinators;
      const { workspace } = await coordinators.ensure(projectId);
      const conversation = workspace.conversations[0]!;
      server = new ControlMcpServer(
        harness.dataDir,
        async <T>(name: string, args: Record<string, unknown> = {}) =>
          (await harness.commands.get(name)!(args, harness.context)) as T,
      );
      const launched = await server.callCoordinatorTool(
        {
          role: "coordinator",
          projectId,
          coordinatorId: workspace.id,
          conversationId: conversation.id,
          mailboxIncarnationId: conversation.mailboxIncarnationId!,
          capabilities: coordinatorRoleCapabilities("main"),
        },
        "launch_job",
        {
          requestId: "job-model-only",
          environmentId: "env-1",
          agent: "claude",
          modelId: "opus",
          prompt: "Fix the fixture parser.",
        },
      );
      expect(launched.isError).toBe(false);
      const job = launched.structuredContent as { tabId: string; delegationNote?: string };
      expect(job.delegationNote).toBeUndefined();
      expect(job.tabId).toBeString();
      expect(stub.sends).toHaveLength(1);
      const rows = await harness.storage.coordinators.listAllCoordinatorWorkflowAssociations();
      expect(
        rows.find((row) => row.delegation?.workerTabId === job.tabId)?.delegation?.request,
      ).toMatchObject({
        model: "opus",
        reasoning: "high",
        source: "requested",
      });
      expect(
        await harness.commands.get(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)!({}, harness.context),
      ).toEqual({
        overrides: [{ environmentId: "env-1", tabId: job.tabId, model: "opus", reasoning: "high" }],
      });
    } finally {
      await server?.stop();
      await cleanupSessionHarnesses();
    }
  });

  test("answers across projects from one read, with workers on other nodes apart", async () => {
    await launch("here", { initialAgentModel: "opus" });
    await launch("elsewhere", { initialAgentModel: "opus" }, { projectId: "other-project" });
    await launch("remote", { initialAgentModel: "opus" }, { nodeId: "bk_leaf" });
    await launch("remote-default", {}, { nodeId: "bk_leaf" });
    const answer = (await list()) as CoordinatorLaunchOverridesSnapshot;
    // An older renderer reads only `overrides`, so no remote row may be there.
    expect(answer.overrides.map((override) => override.environmentId).sort()).toEqual([
      "worker-elsewhere",
      "worker-here",
    ]);
    expect(answer.overrides.some((override) => override.nodeId)).toBe(false);
    expect(answer.remoteOverrides).toEqual([
      { nodeId: "bk_leaf", environmentId: "worker-remote", tabId: "startup-agent", model: "opus" },
    ]);
  });
});
