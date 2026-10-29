import { describe, expect, test } from "bun:test";
import type { ScheduleGraphLaunch } from "@orkestrator/protocol/scheduled-jobs";
import {
  graphScheduleOptionsQuery,
  graphScheduleProblems,
  graphScheduleRequest,
  graphScheduleWithOptions,
  initialGraphScheduleForm,
  type GraphScheduleForm,
} from "./graph-schedule-model";
import { GRAPH_REF, graphScheduleOptions } from "./graph-schedule.test-fixtures";

function chosen(overrides: Partial<GraphScheduleForm> = {}): GraphScheduleForm {
  return graphScheduleWithOptions(
    { ...initialGraphScheduleForm(), projectId: "p1", ref: GRAPH_REF, ...overrides },
    graphScheduleOptions(),
  );
}

describe("graph schedule form", () => {
  test("a new form uses the saved launch defaults and needs a project and a template", () => {
    const form = initialGraphScheduleForm();
    expect(form.useDefaults).toBe(true);
    expect(graphScheduleProblems(form)).toEqual(["Choose a project"]);
    expect(graphScheduleProblems({ ...form, projectId: "p1" })).toEqual(["Choose a template"]);
    expect(graphScheduleProblems({ ...form, projectId: "p1", ref: GRAPH_REF })).toEqual([
      "The template is still being compiled",
    ]);
  });

  test("with saved defaults the request leaves roles and parameters to fire time", () => {
    expect(graphScheduleRequest(chosen())).toEqual({
      ref: GRAPH_REF,
      projectId: "p1",
      environment: { kind: "new", create: "worktree" },
    });
  });

  test("pinned roles, parameters and inputs are stored; no requestId or saveDefaults", () => {
    const form = chosen({ useDefaults: false });
    form.draft!.inputs.brief = '"Sweep"';
    form.draft!.environment = "existing";
    form.draft!.environmentId = "env-1";
    expect(graphScheduleRequest(form)).toEqual({
      ref: GRAPH_REF,
      projectId: "p1",
      environment: { kind: "existing", environmentId: "env-1" },
      roles: { reviewer: [{ platform: "claude" }, { platform: "codex" }] },
      params: { rounds: 3 },
      inputs: { brief: "Sweep" },
    });
  });

  test("editing starts from the stored request, compiled for its environment", () => {
    const stored: ScheduleGraphLaunch = {
      ref: GRAPH_REF,
      projectId: "p1",
      environment: { kind: "new", create: "container" },
      roles: { reviewer: { platform: "codex", model: "gpt-5.5" } },
      params: { rounds: 5 },
      inputs: { brief: "Nightly" },
    };
    const initial = initialGraphScheduleForm({ kind: "graph", request: stored });
    expect(initial.useDefaults).toBe(false);
    expect(graphScheduleOptionsQuery(initial)).toEqual({ create: "container" });
    const form = graphScheduleWithOptions(initial, graphScheduleOptions());
    expect(form.draft?.environment).toBe("new-container");
    expect(form.draft?.params.rounds).toBe("5");
    expect(graphScheduleRequest(form)).toEqual({
      ...stored,
      roles: { reviewer: [{ platform: "codex", model: "gpt-5.5" }] },
    });
    // Another template starts from its own defaults.
    const other = graphScheduleWithOptions(
      { ...initial, ref: { scope: "user", id: "other" } },
      graphScheduleOptions(),
    );
    expect(other.draft?.environment).toBe("new-worktree");
  });

  test("a default the template cannot fill is reported, with how to set it", () => {
    const options = graphScheduleOptions({
      parameters: [{ key: "rounds", label: "Rounds", type: "integer", min: 1, max: 5 }],
      params: {},
    });
    const form = graphScheduleWithOptions(
      { ...initialGraphScheduleForm(), projectId: "p1", ref: GRAPH_REF },
      options,
    );
    expect(graphScheduleProblems(form)).toEqual([
      "Rounds needs a value (turn off saved defaults to set it here)",
    ]);
    expect(() => graphScheduleRequest(form)).toThrow("Rounds needs a value");
    expect(graphScheduleProblems({ ...form, useDefaults: false })).toEqual([
      "Rounds needs a value",
    ]);
  });
});
