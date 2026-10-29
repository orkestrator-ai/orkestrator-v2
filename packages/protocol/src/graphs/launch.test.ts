import { describe, expect, test } from "bun:test";
import { compile } from "./compile.js";
import { graphTemplateExample } from "./examples.js";
import {
  GraphLaunchRequestError,
  graphLaunchCostEstimate,
  graphLaunchEnvironmentChoice,
  graphLaunchEnvironmentKey,
  graphLaunchParams,
  graphRoleDefaultBindings,
  graphTicketInputName,
  parseGraphLaunchRequest,
} from "./launch.js";
import { validateGraphRun } from "./run-guards.js";
import type { GraphRole } from "./template-model.js";

const BASE = {
  ref: { scope: "user", id: "sample" },
  projectId: "p1",
  environment: { kind: "existing", environmentId: "e1" },
};

function parseError(value: unknown): string {
  try {
    parseGraphLaunchRequest(value);
  } catch (error) {
    expect(error).toBeInstanceOf(GraphLaunchRequestError);
    return (error as Error).message;
  }
  throw new Error("Expected a refusal");
}

describe("parseGraphLaunchRequest", () => {
  test("accepts a full request and normalizes bindings", () => {
    const request = parseGraphLaunchRequest({
      ...BASE,
      roles: {
        reviewer: [
          { platform: "claude", model: " opus ", lens: { label: "Security", instruction: "x\ny" } },
          { platform: "codex" },
        ],
        fixer: { platform: "codex", reasoningEffort: "high", fastMode: false },
      },
      params: { autoFix: true, rounds: 3, mode: "fast", none: null },
      inputs: { brief: { text: "hi" } },
      ticket: { taskId: "t1" },
      saveDefaults: true,
      requestId: "abc",
    });
    expect(request.roles?.reviewer).toEqual([
      { platform: "claude", model: "opus", lens: { label: "Security", instruction: "x\ny" } },
      { platform: "codex" },
    ]);
    expect(request.ticket).toEqual({ taskId: "t1" });
    expect(request.environment).toEqual({ kind: "existing", environmentId: "e1" });
  });

  test("refuses drafts, unknown fields and malformed values", () => {
    expect(parseError({ ...BASE, template: {} })).toContain("unknown fields: template");
    expect(parseError({ ...BASE, environment: { kind: "new", create: "vm" } })).toContain(
      "worktree or container",
    );
    expect(parseError({ ...BASE, roles: { r: { platform: "gpt" } } })).toContain("platform");
    expect(parseError({ ...BASE, roles: { r: [] } })).toContain("1 to 32");
    expect(parseError({ ...BASE, params: { p: { nested: true } } })).toContain("params.p");
    expect(parseError({ ...BASE, requestId: "" })).toContain("requestId");
    expect(
      parseError({
        ...BASE,
        ref: { scope: "project", projectId: "other", path: ".orkestrator/graphs/a.graph.json" },
      }),
    ).toContain("its own project");
    expect(parseError({ ...BASE, inputs: { big: "x".repeat(300 * 1024) } })).toContain("bytes");
  });
});

describe("graphRoleDefaultBindings (item 108's reading)", () => {
  const roles: GraphRole[] = [
    { key: "fixer", multiplicity: "one", defaultsFrom: ["fixReviewIssues", "review"] },
    { key: "plain", multiplicity: "one" },
    {
      key: "reviewer",
      multiplicity: "panel",
      maxPanel: 4,
      defaultsFrom: ["review", "review2", "additionalReviewers"],
    },
    { key: "panel", multiplicity: "panel" },
  ];

  test("first usable key, else the default agent; panel positions per key then additional reviewers", () => {
    const result = graphRoleDefaultBindings(roles, {
      actionDefaults: {
        fixReviewIssues: { platform: "grok" },
        review: { platform: "claude", model: "opus" },
      },
      additionalReviewers: [{ platform: "pi" }, null, { platform: "opencode" }],
      reviewerLenses: [null, { label: "Tests", instruction: "Coverage." }],
      defaultAgent: "codex",
      // grok is disabled: its default is not usable.
      enabledAgents: ["claude", "codex", "pi"],
    });
    expect(result.fixer).toEqual({ platform: "claude", model: "opus" });
    expect(result.plain).toEqual({ platform: "codex" });
    expect(result.reviewer).toEqual([
      { platform: "claude", model: "opus" },
      { platform: "claude", model: "opus", lens: { label: "Tests", instruction: "Coverage." } },
      { platform: "pi" },
      // null → the first key's; the disabled opencode entry is cut by maxPanel anyway.
      { platform: "claude", model: "opus" },
    ]);
    expect(result.panel).toEqual([{ platform: "codex" }]);
  });
});

describe("graphLaunchParams", () => {
  const parameters = [
    { key: "autoFix", type: "boolean" as const, default: false },
    { key: "rounds", type: "integer" as const, min: 1, max: 5 },
    { key: "mode", type: "enum" as const, options: ["fast", "deep"], default: "fast" },
    { key: "note", type: "string" as const, maxBytes: 4, default: "" },
  ];

  test("given, then saved, then declared defaults; required values and bounds are issues", () => {
    expect(graphLaunchParams(parameters, { rounds: 2 }, { mode: "deep", autoFix: "bad" })).toEqual({
      params: { autoFix: false, rounds: 2, mode: "deep", note: "" },
      issues: [],
    });
    expect(graphLaunchParams(parameters).issues).toEqual(["The parameter rounds needs a value"]);
    expect(
      graphLaunchParams(parameters, { rounds: 9, mode: "x", note: "toolong", ghost: 1 }).issues,
    ).toEqual([
      "The template has no parameter ghost",
      "The parameter rounds must be at most 5",
      "The parameter mode must be one of fast, deep",
      "The parameter note must be at most 4 bytes",
    ]);
    expect(graphLaunchParams(parameters, { rounds: 1.5 }).issues).toEqual([
      "The parameter rounds must be a whole number",
    ]);
  });
});

describe("inputs, environments and cost", () => {
  const plan = compile(graphTemplateExample("build-pipeline-loop")).plan!;
  const review = compile(graphTemplateExample("multi-review")).plan!;

  test("the ticket input is the only ticket@1 input, or the one named", () => {
    expect(graphTicketInputName(plan)).toBe("ticket");
    expect(graphTicketInputName(plan, "ticket")).toBe("ticket");
    expect(graphTicketInputName(plan, "target")).toBeNull();
    expect(graphTicketInputName(review)).toBeNull();
  });

  test("environment choices round-trip", () => {
    expect(graphLaunchEnvironmentChoice("new-container")).toEqual({
      kind: "new",
      create: "container",
    });
    expect(graphLaunchEnvironmentChoice("existing")).toBeNull();
    expect(graphLaunchEnvironmentKey({ kind: "existing", environmentId: "e" })).toBe("existing");
    expect(graphLaunchEnvironmentKey({ kind: "new", create: "worktree" })).toBe("new-worktree");
  });

  test("the cost estimate scales replicated nodes by the bound panel", () => {
    const one = graphLaunchCostEstimate(review, { reviewer: [{ platform: "claude" }] });
    const five = graphLaunchCostEstimate(review, {
      reviewer: Array.from({ length: 5 }, () => ({ platform: "claude" as const })),
    });
    expect(five.agentSessions.worst - one.agentSessions.worst).toBeGreaterThanOrEqual(4);
    expect(five.peakParallelism).toBeGreaterThanOrEqual(5);
  });
});

describe("run records keep launch info and panel lenses", () => {
  test("validated, and malformed ones refused", () => {
    const plan = compile(graphTemplateExample("multi-review")).plan!;
    const run = {
      format: "orkestrator.graph-run",
      formatVersion: 1,
      id: "run-1",
      projectId: "p1",
      environmentId: "e1",
      template: {
        id: plan.template.id,
        revision: plan.template.revision,
        digest: plan.templateDigest,
      },
      plan,
      bindings: {
        roles: {
          reviewer: [{ platform: "claude", lens: { label: "Security", instruction: "a\nb" } }],
        },
        params: {},
        inputs: {},
      },
      launch: { requestedBy: "schedule", scheduleId: "s1", ticket: { taskId: "t1" } },
      status: "running",
      mock: false,
      activations: [],
      rewinds: [],
      loopIterations: {},
      usage: { agentSessions: 0, tokens: 0 },
      revision: 1,
      createdAt: "2026-10-29T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
    };
    expect(validateGraphRun(run).ok).toBe(true);
    expect(validateGraphRun({ ...run, launch: { requestedBy: "robot" } }).ok).toBe(false);
    expect(validateGraphRun({ ...run, launch: { requestedBy: "user", extra: 1 } }).ok).toBe(false);
  });
});
