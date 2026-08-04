import { describe, expect, mock, test } from "bun:test";
import { createCommandRegistry, type CommandContext } from "./commands.js";

function harness(withService = true) {
  const start = mock(async (input: unknown) => ({ input }));
  const snapshot = mock(async (projectId: string) => ({ projectId }));
  const retry = mock(async (featureId: string) => ({ featureId, retried: true }));
  const cancel = mock(async (featureId: string) => ({ featureId, cancelled: true }));
  const updateFeaturePlan = mock(async (featureId: string, updates: unknown) => ({
    id: featureId,
    updates,
  }));
  const context = {
    storage: { updateFeaturePlan },
    ...(withService
      ? { featurePlanning: { start, snapshot, retry, cancel } }
      : {}),
  } as unknown as CommandContext;
  const commands = createCommandRegistry();
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`Missing command: ${name}`);
    return await handler(args, context);
  };
  return { invoke, start, snapshot, retry, cancel, updateFeaturePlan };
}

describe("feature planning commands", () => {
  test("validates and delegates every planning operation", async () => {
    const { invoke, start, snapshot, retry, cancel } = harness();
    await invoke("start_feature_planning", {
      featureId: "feature-1",
      kind: "story",
      storyId: "story-1",
      userMessage: "Refine it",
    });
    await invoke("get_feature_planning_snapshot", { projectId: "project-1" });
    await invoke("retry_feature_planning", { featureId: "feature-1" });
    await invoke("cancel_feature_planning", { featureId: "feature-1" });

    expect(start).toHaveBeenCalledWith({
      featureId: "feature-1",
      kind: "story",
      storyId: "story-1",
      userMessage: "Refine it",
    });
    expect(snapshot).toHaveBeenCalledWith("project-1");
    expect(retry).toHaveBeenCalledWith("feature-1");
    expect(cancel).toHaveBeenCalledWith("feature-1");
  });

  test("rejects unknown fields and invalid start envelopes", async () => {
    const { invoke } = harness();
    for (const [command, args] of [
      ["start_feature_planning", {
        featureId: "feature-1", kind: "feature", userMessage: "Plan", extra: true,
      }],
      ["get_feature_planning_snapshot", { projectId: "project-1", extra: true }],
      ["retry_feature_planning", { featureId: "feature-1", extra: true }],
      ["cancel_feature_planning", { featureId: "feature-1", extra: true }],
    ] as const) {
      await expect(invoke(command, args)).rejects.toThrow("Unexpected arguments field: extra");
    }
    await expect(invoke("start_feature_planning", {
      featureId: "feature-1",
      kind: "story",
      userMessage: "Missing story",
    })).rejects.toThrow("valid bounded feature planning request");
    await expect(invoke("start_feature_planning", {
      featureId: "feature-1",
      kind: "feature",
      storyId: "unexpected-story",
      userMessage: "Plan",
    })).rejects.toThrow("valid bounded feature planning request");
    await expect(invoke("start_feature_planning", {
      featureId: "feature-1",
      kind: "feature",
      userMessage: "   ",
    })).rejects.toThrow("non-blank string");
    await expect(invoke("start_feature_planning", {
      featureId: "feature-1",
      kind: "feature",
      userMessage: "x".repeat(100_001),
    })).rejects.toThrow("valid bounded feature planning request");
  });

  test("fails every planning command closed when the supervisor is absent", async () => {
    const { invoke } = harness(false);
    for (const [command, args] of [
      ["start_feature_planning", {
        featureId: "feature-1", kind: "feature", userMessage: "Plan",
      }],
      ["get_feature_planning_snapshot", { projectId: "project-1" }],
      ["retry_feature_planning", { featureId: "feature-1" }],
      ["cancel_feature_planning", { featureId: "feature-1" }],
    ] as const) {
      await expect(invoke(command, args)).rejects.toThrow(
        "Feature planning supervisor is unavailable",
      );
    }
  });

  test("allows only validated public feature fields", async () => {
    const { invoke, updateFeaturePlan } = harness();
    await invoke("update_feature_plan", {
      featureId: "feature-1",
      updates: {
        title: "Renamed",
        status: "stories",
        summary: "Summary",
        buildTaskId: undefined,
        messages: [{
          id: "message-1",
          role: "assistant",
          content: "Ready",
          createdAt: "2026-01-01T00:00:00.000Z",
          stateApplication: "applied",
        }],
        stories: [{
          id: "story-1",
          title: "Story",
          description: "Description",
          acceptanceCriteria: ["It works"],
          messages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }],
      },
    });
    expect(updateFeaturePlan).toHaveBeenCalledWith("feature-1", {
      title: "Renamed",
      status: "stories",
      summary: "Summary",
      buildTaskId: undefined,
      messages: [{
        id: "message-1",
        role: "assistant",
        content: "Ready",
        createdAt: "2026-01-01T00:00:00.000Z",
        stateApplication: "applied",
      }],
      stories: [{
        id: "story-1",
        title: "Story",
        description: "Description",
        acceptanceCriteria: ["It works"],
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    for (const protectedField of [
      "id", "projectId", "createdAt", "updatedAt", "order", "planning",
    ]) {
      await expect(invoke("update_feature_plan", {
        featureId: "feature-1",
        updates: { [protectedField]: "forged" },
      })).rejects.toThrow(`Unexpected updates field: ${protectedField}`);
    }
    await expect(invoke("update_feature_plan", {
      featureId: "feature-1",
      updates: { status: "invalid" },
    })).rejects.toThrow("valid feature plan status");
    await expect(invoke("update_feature_plan", {
      featureId: "feature-1",
      updates: { messages: [{ id: "message-1" }] },
    })).rejects.toThrow("role");
    await expect(invoke("update_feature_plan", {
      featureId: "feature-1",
      updates: [],
    })).rejects.toThrow("Expected updates to be an object");
    await expect(invoke("update_feature_plan", {
      featureId: "feature-1",
      updates: {},
      extra: true,
    })).rejects.toThrow("Unexpected arguments field: extra");
  });
});
