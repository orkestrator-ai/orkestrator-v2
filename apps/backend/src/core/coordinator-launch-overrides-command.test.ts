import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import { COORDINATOR_LAUNCH_OVERRIDES_COMMAND } from "@orkestrator/protocol/coordinator-launch-overrides";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { launchDelegationRequest } from "./coordinator-delegation-request.js";
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

  test("answers across projects from one read, and leaves out a worker on another node", async () => {
    await launch("here", { initialAgentModel: "opus" });
    await launch("elsewhere", { initialAgentModel: "opus" }, { projectId: "other-project" });
    await launch("remote", { initialAgentModel: "opus" }, { nodeId: "bk_leaf" });
    const { overrides } = (await list()) as { overrides: Array<{ environmentId: string }> };
    expect(overrides.map((override) => override.environmentId).sort()).toEqual([
      "worker-elsewhere",
      "worker-here",
    ]);
  });
});
