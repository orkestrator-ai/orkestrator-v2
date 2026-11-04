import { describe, expect, mock, test } from "bun:test";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";

const row = { agent: "codex", model: "review-model" };
const addressRow = { agent: "claude", model: "address-model" };
const projectId = "project-1";
const environmentId = "environment-1";
const baseCommit = "a".repeat(40);

function harness() {
  const startBuild = mock(async (input: Record<string, unknown>) => ({ id: "build-1", input }));
  const startReview = mock(async (input: Record<string, unknown>) => ({ id: "review-1", input }));
  const context = {
    storage: {
      loadConfig: async () => ({
        global: { agentSettings: { multiReview: { autoFix: true, autoPr: true } } },
        repositories: {},
      }),
      getProject: async () => ({ id: projectId }),
      getEnvironment: async () => ({ id: environmentId, projectId, environmentType: "local" }),
      getMultiReviewWorkflow: async () => null,
      getBuildPipeline: async () => ({
        snapshot: { projectId, environmentId, phase: "complete" },
      }),
      kanban: { getKanbanTask: async () => ({ id: "task-1", projectId }) },
    },
    buildPipelines: { start: startBuild },
    multiReviews: { start: startReview },
  } as unknown as CommandContext;
  const commands = createCommandRegistry();
  return {
    startBuild,
    startReview,
    invoke: (name: string, args: Record<string, unknown>) =>
      Promise.resolve().then(() => commands.get(name)!(args, context)),
  };
}

function buildInput() {
  return {
    projectId,
    taskId: "task-1",
    taskTitle: "Implement the ticket",
    taskSnapshot: {
      title: "Implement the ticket",
      description: "",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    environmentType: "local",
    agentType: "codex",
    delegationBaseBranch: "main",
    delegationBaseCommit: baseCommit,
    steps: { "address-findings": addressRow },
  };
}

function reviewInput() {
  return {
    environmentId,
    projectId,
    targetBranch: "main",
    reviewers: [row, row],
    reviewModel: row,
    addressFindingsModel: addressRow,
    autoAddressFindings: false,
  };
}

describe("workflow vocabulary at backend command boundaries", () => {
  for (const command of [
    "start_build_pipeline",
    "launch_build_pipeline",
    "start_controller_build_pipeline",
  ]) {
    const args = (input: Record<string, unknown>) =>
      command === "start_controller_build_pipeline" ? { input } : input;

    test(`${command} translates the future Address Findings step before starting`, async () => {
      const h = harness();
      await h.invoke(command, args(buildInput()));
      expect(h.startBuild).toHaveBeenCalledTimes(1);
      const input = h.startBuild.mock.calls[0]![0];
      expect(input.steps).toMatchObject({ address: addressRow });
      expect(input.steps).not.toHaveProperty("address-findings");
      expect(input.taskId).toBe("task-1");
    });

    test(`${command} refuses a malformed future step before service invocation`, async () => {
      const h = harness();
      await expect(
        h.invoke(
          command,
          args({ ...buildInput(), steps: { "address-findings": { agent: "unknown" } } }),
        ),
      ).rejects.toThrow("Invalid build pipeline");
      expect(h.startBuild).not.toHaveBeenCalled();
    });
  }

  for (const command of ["start_multi_review", "start_controller_multi_review"]) {
    const args = (input: Record<string, unknown>) =>
      command === "start_controller_multi_review"
        ? { input, reservedId: "review-1", buildPipelineId: "build-1" }
        : input;

    test(`${command} preserves the future model and explicit false automation`, async () => {
      const h = harness();
      await h.invoke(command, args(reviewInput()));
      expect(h.startReview).toHaveBeenCalledTimes(1);
      const input = h.startReview.mock.calls[0]![0];
      expect(input).toMatchObject({ fixModel: addressRow, autoFix: false });
      expect(input).not.toHaveProperty("addressFindingsModel");
      expect(input).not.toHaveProperty("autoAddressFindings");
    });

    test(`${command} rejects a nonboolean future automation flag before service invocation`, async () => {
      const h = harness();
      await expect(
        h.invoke(command, args({ ...reviewInput(), autoAddressFindings: "false" })),
      ).rejects.toThrow("Invalid multi");
      expect(h.startReview).not.toHaveBeenCalled();
    });

    test(`${command} rejects a malformed PR automation flag before service invocation`, async () => {
      const h = harness();
      await expect(h.invoke(command, args({ ...reviewInput(), autoPr: "false" }))).rejects.toThrow(
        "Invalid multi",
      );
      expect(h.startReview).not.toHaveBeenCalled();
    });

    test(`${command} rejects a malformed future model before service invocation`, async () => {
      const h = harness();
      await expect(
        h.invoke(command, args({ ...reviewInput(), addressFindingsModel: { agent: "unknown" } })),
      ).rejects.toThrow("Invalid multi");
      expect(h.startReview).not.toHaveBeenCalled();
    });
  }
});
