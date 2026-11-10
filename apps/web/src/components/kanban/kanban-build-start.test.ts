import { describe, expect, test } from "bun:test";
import type { BuildLaunchSelection } from "@/components/build/BuildLaunchDialog";
import { kanbanBuildStartOptions } from "./kanban-build-start";

const step = { agent: "claude" as const, model: "opus" };

function selection(overrides: Partial<BuildLaunchSelection> = {}): BuildLaunchSelection {
  return {
    environmentType: "containerized",
    steps: { build: step, review: step } as unknown as BuildLaunchSelection["steps"],
    reviewers: [step],
    reviewPreparation: step,
    deliveryPolicy: "open-pr",
    ...overrides,
  };
}

describe("kanbanBuildStartOptions", () => {
  test("carries the launcher's network access choice to startBuild", () => {
    const options = kanbanBuildStartOptions(selection({ networkAccessMode: "full" }));
    expect(options.networkAccessMode).toBe("full");
    expect(options.deliveryPolicy).toBe("open-pr");
    expect(options.reviewers).toEqual([step]);
    expect(options.reviewPreparation).toEqual(step);
  });

  test("passes no network access when the launcher chose none (a local worktree)", () => {
    expect(
      kanbanBuildStartOptions(selection({ environmentType: "local" })).networkAccessMode,
    ).toBeUndefined();
  });
});
