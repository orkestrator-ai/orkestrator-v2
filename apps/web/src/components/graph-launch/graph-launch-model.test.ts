import { describe, expect, test } from "bun:test";
import type {
  GraphLaunchInputOption,
  GraphLaunchOptions,
} from "@orkestrator/protocol/graphs/launch";
import type { GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";
import {
  graphLaunchInputProblem,
  graphLaunchProblems,
  graphLaunchRequest,
  graphTemplateLaunchBlocker,
  initialGraphLaunchDraft,
} from "./graph-launch-model";

const workspaceInput: GraphLaunchInputOption = {
  name: "code",
  type: "workspace@1",
  required: true,
  ticket: false,
  launchable: true,
  autoFill: "environment-head",
};

function options(overrides: Partial<GraphLaunchOptions> = {}): GraphLaunchOptions {
  return {
    summary: { name: "Checks" } as GraphTemplateSummary,
    launchable: true,
    errors: [],
    roles: [],
    parameters: [{ key: "notes", type: "string" }],
    params: {},
    inputs: [workspaceInput],
    environment: { workspace: "environment", create: "worktree", default: "new-worktree" },
    cost: null,
    saved: null,
    ...overrides,
  };
}

describe("graph launch model", () => {
  test("a workspace input is filled from the run's environment, existing or new", () => {
    const base = initialGraphLaunchDraft(options(), { environmentId: "env-1" });
    expect(base.environment).toBe("new-worktree");
    expect(graphLaunchInputProblem(workspaceInput, base, null)).toBeNull();
    const existing = { ...base, environment: "existing" as const };
    expect(graphLaunchInputProblem(workspaceInput, existing, null)).toBeNull();
    const given = { ...base, inputs: { code: '{"branch":"main"}' } };
    expect(graphLaunchInputProblem(workspaceInput, given, null)).toBeNull();
    expect(graphLaunchInputProblem(workspaceInput, { ...base, inputs: { code: "{" } }, null)).toBe(
      "code must be JSON",
    );
  });

  test("opened from an environment with no saved or template choice, it runs there", () => {
    const draft = initialGraphLaunchDraft(
      options({ environment: { workspace: "environment", default: "new-worktree" } }),
      { environmentId: "env-1" },
    );
    expect(draft.environment).toBe("existing");
    expect(draft.environmentId).toBe("env-1");
  });

  test("a parameter without a value or default blocks the launch; the request omits empties", () => {
    const opts = options({ inputs: [] });
    const draft = initialGraphLaunchDraft(opts, {});
    expect(graphLaunchProblems(opts, draft)).toEqual(["notes needs a value"]);
    const filled = { ...draft, params: { notes: "careful" } };
    expect(graphLaunchProblems(opts, filled)).toEqual([]);
    expect(
      graphLaunchRequest({
        ref: { scope: "user", id: "checks" },
        projectId: "p",
        options: opts,
        draft: filled,
        requestId: "r-1",
      }),
    ).toEqual({
      ref: { scope: "user", id: "checks" },
      projectId: "p",
      environment: { kind: "new", create: "worktree" },
      roles: {},
      params: { notes: "careful" },
      saveDefaults: true,
      requestId: "r-1",
    });
  });

  test("names why a template in the picker cannot be launched", () => {
    const summary = {
      launchable: false,
      trust: "trusted",
      compile: { errors: 0, pendingAcknowledgements: 0 },
    } as GraphTemplateSummary;
    expect(graphTemplateLaunchBlocker({ ...summary, launchable: true })).toBeNull();
    expect(graphTemplateLaunchBlocker({ ...summary, engine: "multi-review" })).toContain("engine");
    expect(graphTemplateLaunchBlocker({ ...summary, trust: "untrusted" })).toContain("approve");
    expect(
      graphTemplateLaunchBlocker({ ...summary, compile: { ...summary.compile, errors: 2 } }),
    ).toContain("2 errors");
  });
});
