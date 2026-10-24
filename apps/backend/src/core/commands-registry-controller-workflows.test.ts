import { describe, expect, test } from "bun:test";
import { COORDINATOR_DELEGATION_PRESENTATION } from "@orkestrator/protocol/review-evidence-frames";

import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerControllerWorkflowCommands } from "./commands-registry-controller-workflows.js";

function harness(options: { environment?: Record<string, unknown> } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ id: string; changes: Record<string, unknown> }> = [];
  const started: Array<Record<string, unknown>> = [];
  const commands = new Map<string, CommandHandler>();
  commands.set("create_environment", async (args) => {
    created.push(args);
    return { id: "env-new", projectId: "p-leaf", status: "stopped" };
  });
  const registered = new Map<string, CommandHandler>();
  registerControllerWorkflowCommands((name, handler) => registered.set(name, handler), {
    commands,
  });
  const context = {
    storage: {
      getProject: async (id: string) => (id === "p-leaf" ? { id, localPath: "/x" } : null),
      getEnvironment: async () => options.environment ?? null,
      loadConfig: async () => ({ global: {}, repositories: {} }),
      updateEnvironment: async (id: string, changes: Record<string, unknown>) => {
        updates.push({ id, changes });
        return { id, ...changes };
      },
      getMultiReviewWorkflow: async () => null,
    },
    buildPipelines: {
      start: async (input: Record<string, unknown>) => {
        started.push(input);
        return { id: "pipeline-1", ...input };
      },
    },
  } as unknown as CommandContext;
  const run = (name: string, args: Record<string, unknown>) => registered.get(name)!(args, context);
  return { run, created, updates, started };
}

const build = {
  taskId: "t1",
  projectId: "p-leaf",
  environmentType: "local",
  agentType: "codex",
  taskTitle: "Fix",
  taskSnapshot: { title: "Fix", description: "", acceptanceCriteria: "", comments: [], images: [] },
  delegationBaseBranch: "main",
  delegationBaseCommit: "c".repeat(40),
};

describe("controller workflow commands", () => {
  test("a controller environment is created idempotently and shown as a delegation", async () => {
    const { run, created, updates } = harness();
    await run("create_controller_environment", {
      input: { projectId: "p-leaf", initialPrompt: "framed" },
      controlRequestId: "node:c1:launch-1",
      presentation: { kind: COORDINATOR_DELEGATION_PRESENTATION, frame: "frame" },
    });
    expect(created).toEqual([
      { projectId: "p-leaf", initialPrompt: "framed", controlRequestId: "node:c1:launch-1" },
    ]);
    expect(updates).toEqual([
      {
        id: "env-new",
        changes: {
          initialPromptPresentation: { kind: COORDINATOR_DELEGATION_PRESENTATION, frame: "frame" },
        },
      },
    ]);
    await run("create_controller_environment", {
      input: { projectId: "p-leaf" },
      controlRequestId: "node:c1:launch-2",
      presentation: { kind: "something-else", frame: "x" },
    });
    expect(updates).toHaveLength(1);
  });

  test("a controller build runs this node's defaults and checks its own delegation base", async () => {
    const { run, started } = harness();
    await run("start_controller_build_pipeline", { input: build });
    expect(started[0]).toMatchObject({ projectId: "p-leaf", taskId: "t1" });

    await expect(
      run("start_controller_build_pipeline", {
        input: { ...build, delegationBaseCommit: undefined },
      }),
    ).rejects.toThrow();
    await expect(
      run("start_controller_build_pipeline", { input: { ...build, projectId: "missing" } }),
    ).rejects.toThrow("does not exist on this node");
  });

  test("an existing environment must come from the delegation commit", async () => {
    const { run } = harness({
      environment: { id: "env-1", projectId: "p-leaf", createdFromCommit: "d".repeat(40) },
    });
    await expect(
      run("start_controller_build_pipeline", {
        input: { ...build, existingEnvironmentId: "env-1" },
      }),
    ).rejects.toThrow("was not created from the requested delegation commit");
  });

  test("a review surface needs a saved review on this node", async () => {
    const { run } = harness();
    await expect(
      run("controller_multi_review_surface", { workflowId: "w1", surface: "root" }),
    ).rejects.toThrow("not found on this node");
    await expect(
      run("controller_multi_review_surface", { workflowId: "w1", surface: "elsewhere" }),
    ).rejects.toThrow("Expected surface");
  });
});
