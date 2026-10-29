import { describe, expect, test } from "bun:test";
import type { GraphLaunchOrigin, GraphLaunchRequest } from "@orkestrator/protocol/graphs/launch";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { GraphRunLaunchService } from "./graph-run-launch.js";

const commands = createCommandRegistry();

function harness() {
  const calls: Array<{ request: GraphLaunchRequest; origin: GraphLaunchOrigin } | unknown> = [];
  const graphLaunches = {
    async launch(request: GraphLaunchRequest, origin: GraphLaunchOrigin) {
      calls.push({ request, origin });
      return { runId: "r1", projectId: request.projectId, status: "running", repeated: false };
    },
    async options(input: unknown) {
      calls.push(input);
      return { launchable: true };
    },
  } as unknown as GraphRunLaunchService;
  const context = { graphLaunches } as unknown as CommandContext;
  const run = async (name: string, args: Record<string, unknown>) =>
    commands.get(name)!(args, context);
  return { calls, run };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe("graph launch commands", () => {
  test("graph_run_launch parses the request and launches as the user", async () => {
    const h = harness();
    await h.run("graph_run_launch", {
      ref: { scope: "user", id: "sample" },
      projectId: "p1",
      environment: { kind: "new", create: "worktree" },
      ticket: { taskId: "t1" },
    });
    expect(h.calls).toEqual([
      {
        request: {
          ref: { scope: "user", id: "sample" },
          projectId: "p1",
          environment: { kind: "new", create: "worktree" },
          ticket: { taskId: "t1" },
        },
        origin: { requestedBy: "user" },
      },
    ]);
  });

  test("malformed requests, drafts and a caller-chosen origin are refused", async () => {
    const h = harness();
    const base = { ref: { scope: "user", id: "sample" }, projectId: "p1" };
    expect(await code(h.run("graph_run_launch", base))).toBe("invalid-request");
    expect(
      await code(
        h.run("graph_run_launch", {
          ...base,
          environment: { kind: "new", create: "worktree" },
          template: {},
        }),
      ),
    ).toBe("invalid-request");
    expect(
      await code(
        h.run("graph_run_launch", {
          ...base,
          environment: { kind: "new", create: "worktree" },
          requestedBy: "coordinator",
        }),
      ),
    ).toBe("invalid-request");
    expect(h.calls).toEqual([]);
  });

  test("graph_launch_options validates its arguments", async () => {
    const h = harness();
    await h.run("graph_launch_options", {
      ref: { scope: "user", id: "sample" },
      projectId: "p1",
      environmentId: "e1",
      create: "container",
    });
    expect(h.calls).toEqual([
      {
        ref: { scope: "user", id: "sample" },
        projectId: "p1",
        environmentId: "e1",
        create: "container",
      },
    ]);
    expect(
      await code(h.run("graph_launch_options", { ref: { scope: "user", id: "sample" } })),
    ).toBe("invalid-request");
    expect(
      await code(h.run("graph_launch_options", { ref: { scope: "nope" }, projectId: "p1" })),
    ).toBe("invalid-request");
  });
});
