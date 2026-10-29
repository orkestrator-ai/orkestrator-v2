import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import {
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { bindAllRoles, compiledPlan } from "./graph-run-executor-test-support.js";
import { graphRunSettled, missingGraphRunOutputs, planGraphRun } from "./graph-run-scheduling.js";

const AT = "2026-10-29T00:00:00.000Z";
const id = (label: string) => createHash("sha256").update(label).digest("hex");

function runOf(
  plan: CompiledGraphPlan,
  options: { panel?: number; params?: GraphRun["bindings"]["params"]; inputs?: string[] } = {},
): GraphRun {
  const params: GraphRun["bindings"]["params"] = {};
  for (const parameter of plan.parameters) {
    if (parameter.default !== undefined) params[parameter.key] = parameter.default;
  }
  return {
    format: GRAPH_RUN_FORMAT,
    formatVersion: GRAPH_RUN_FORMAT_VERSION,
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
      roles: bindAllRoles(plan, options.panel ?? 2),
      params: { ...params, ...options.params },
      inputs: Object.fromEntries(
        (options.inputs ?? plan.inputs.map((input) => input.name)).map((name) => [name, id(name)]),
      ),
    },
    status: "running",
    mock: false,
    activations: [],
    rewinds: [],
    loopIterations: Object.fromEntries(plan.loops.map((loop) => [loop.id, 1])),
    usage: { agentSessions: 0, tokens: 0 },
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
  };
}

function plan(run: GraphRun, values: Map<string, { value: unknown }> = new Map()) {
  return planGraphRun(run, { at: AT, values });
}

function find(run: GraphRun, nodeId: string, iteration = 1, branchKey?: string): NodeActivation {
  const found = run.activations
    .filter(
      (activation) =>
        activation.nodeId === nodeId &&
        activation.iteration === iteration &&
        activation.branchKey === branchKey,
    )
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!found) throw new Error(`no activation for ${nodeId}#${iteration}#${branchKey ?? ""}`);
  return found;
}

/** Settles an activation as an executor would (tests skip the admission step). */
function settle(
  run: GraphRun,
  key: string,
  state: "complete" | "failed",
  extra: Partial<NodeActivation> = {},
): GraphRun {
  return {
    ...run,
    activations: run.activations.map((activation) =>
      activation.key === key ? { ...activation, state, finishedAt: AT, ...extra } : activation,
    ),
  };
}

/** Completes every activation of a node at an iteration, one artifact per output port. */
function completeNode(
  run: GraphRun,
  nodeId: string,
  options: { iteration?: number; outlet?: string } = {},
): GraphRun {
  const node = run.plan.nodes.find((candidate) => candidate.id === nodeId)!;
  let next = run;
  for (const activation of run.activations) {
    if (activation.nodeId !== nodeId || activation.iteration !== (options.iteration ?? 1)) continue;
    if (activation.state !== "ready") continue;
    const outputs =
      options.outlet !== undefined
        ? Object.fromEntries(
            Object.entries(activation.inputs).flatMap(([port, ids]) =>
              Array.isArray(ids) ? [] : [[port, ids]],
            ),
          )
        : Object.fromEntries(
            node.outputs.map((port) => [port.name, id(`${activation.key}/${port.name}`)]),
          );
    next = settle(next, activation.key, "complete", {
      outputs,
      ...(options.outlet !== undefined ? { outlet: options.outlet } : {}),
    });
  }
  return next;
}

function states(run: GraphRun): Record<string, string> {
  return Object.fromEntries(
    run.activations.map((activation) => [activation.key, activation.state]),
  );
}

function baseTemplate(): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "base",
    revision: 1,
    name: "Base",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [
      { name: "target", type: "workspace@1" },
      { name: "notes", type: "text@1", required: false },
    ],
    outputs: [
      { name: "report", type: "review-report@1", from: { node: "review", port: "report" } },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "build",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "builder" },
        workspaceAccess: "write",
        prompt: { template: "Implement the change.\n\n{{> input.code}}\n" },
        inputs: [
          { name: "code", type: "workspace@1" },
          { name: "notes", type: "text@1", required: false },
        ],
        outputs: [{ name: "code", type: "workspace@1" }],
      },
      {
        id: "review",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "reviewer" },
        workspaceAccess: "read",
        prompt: { template: "Review the change.\n\n{{> input.code}}\n" },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "report", type: "review-report@1" }],
      },
    ],
    edges: [
      { id: "target-build", from: { input: "target" }, to: { node: "build", port: "code" } },
      { id: "notes-build", from: { input: "notes" }, to: { node: "build", port: "notes" } },
      {
        id: "build-review",
        from: { node: "build", port: "code" },
        to: { node: "review", port: "code" },
      },
    ],
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 4 },
  };
}

describe("ready set over small plans", () => {
  test("a node is ready once its required inputs are live, with them bound", () => {
    const compiled = compiledPlan(baseTemplate());
    let run = runOf(compiled, { inputs: ["target"] });
    const first = plan(run);
    expect(first.failure).toBeUndefined();
    run = first.run;
    // Only `build` resolves; the absent optional input is simply left out.
    expect(states(run)).toEqual({ "build#iter=1#attempt=1": "ready" });
    expect(find(run, "build").inputs).toEqual({ code: id("target") });
    expect(first.waiting).toBe(1);
    run = completeNode(run, "build");
    run = plan(run).run;
    const review = find(run, "review");
    expect(review.state).toBe("ready");
    expect(review.inputs).toEqual({ code: id("build#iter=1#attempt=1/code") });
    // Planning again changes nothing: the position already has its activation.
    expect(plan(run).created).toBe(0);
  });

  test("a required input that is absent skips the node and everything fed only by it", () => {
    const compiled = compiledPlan(baseTemplate());
    let run = plan(runOf(compiled)).run;
    // `build` fails with `onFailure: skip`-like outcome: it produced no code.
    run = settle(run, find(run, "build").key, "complete", { outputs: {} });
    const result = plan(run);
    expect(find(result.run, "review").state).toBe("skipped");
    // The required run output was not produced.
    expect(missingGraphRunOutputs(result.run)).toEqual(["report"]);
  });

  test("an untaken gate outlet and a false `when` skip their subtrees (§9.1)", () => {
    const compiled = compiledPlan(graphTemplateExample("multi-review"));
    let run = runOf(compiled, { panel: 2, params: { autoFix: true, autoPr: true } });
    run = plan(run).run;
    run = completeNode(run, "plan");
    run = completeNode(plan(run).run, "package");
    run = plan(run).run;
    expect(find(run, "review", 1, "panel.1").state).toBe("ready");
    expect(find(run, "review", 1, "panel.2").state).toBe("ready");
    run = completeNode(run, "review");
    run = completeNode(plan(run).run, "consolidate");
    run = plan(run).run;
    // The clean outlet leaves fix, describe-pr and pr without input: all skip.
    const clean = completeNode(run, "has-findings", { outlet: "clean" });
    const afterClean = plan(clean);
    expect(find(afterClean.run, "fix").state).toBe("skipped");
    expect(find(afterClean.run, "describe-pr").state).toBe("skipped");
    expect(find(afterClean.run, "pr").state).toBe("skipped");
    expect(afterClean.waiting).toBe(0);
    expect(missingGraphRunOutputs(afterClean.run)).toEqual([]);
    // The findings outlet with `autoFix: false` skips fix through its `when`.
    const noFix = runOf(compiled, { panel: 2, params: { autoFix: false, autoPr: true } });
    let other = plan(noFix).run;
    other = completeNode(other, "plan");
    other = completeNode(plan(other).run, "package");
    other = completeNode(plan(other).run, "review");
    other = completeNode(plan(other).run, "consolidate");
    other = completeNode(plan(other).run, "has-findings", { outlet: "findings" });
    const result = plan(other).run;
    expect(find(result, "fix").state).toBe("skipped");
    expect(find(result, "fix").inputs).toEqual({});
    expect(find(result, "pr").state).toBe("skipped");
  });

  test("a fan-in waits for every branch and collects the successful ones", () => {
    const compiled = compiledPlan(graphTemplateExample("multi-review"));
    let run = runOf(compiled, { panel: 3 });
    run = completeNode(plan(run).run, "plan");
    run = plan(completeNode(plan(run).run, "package")).run;
    const [one, two, three] = ["panel.1", "panel.2", "panel.3"].map(
      (branch) => find(run, "review", 1, branch).key,
    ) as [string, string, string];
    run = settle(run, one, "complete", { outputs: { report: id("r1") } });
    // Two branches still run: consolidate waits.
    expect(
      plan(run).run.activations.some((activation) => activation.nodeId === "consolidate"),
    ).toBe(false);
    run = settle(run, two, "failed", { error: "lost", errorCause: "provider-error" });
    run = settle(run, three, "complete", { outputs: { report: id("r3") } });
    const result = plan(run);
    // Replicated reviewers skip on failure; the collect policy decides.
    expect(result.failure).toBeUndefined();
    expect(find(result.run, "consolidate").inputs).toEqual({ reports: [id("r1"), id("r3")] });
  });

  test("a fan-in below `minSuccessful` fails its consumer, and `fail-run` fails the run", () => {
    const compiled = compiledPlan(graphTemplateExample("multi-review"));
    let run = runOf(compiled, { panel: 2 });
    run = completeNode(plan(run).run, "plan");
    run = plan(completeNode(plan(run).run, "package")).run;
    for (const branch of ["panel.1", "panel.2"]) {
      run = settle(run, find(run, "review", 1, branch).key, "failed", {
        error: "lost",
        errorCause: "provider-error",
      });
    }
    const result = plan(run);
    expect(find(result.run, "consolidate").state).toBe("failed");
    expect(find(result.run, "consolidate").error).toContain("0 of 2 branches succeeded");
    expect(result.failure?.error).toContain("Node consolidate failed");
  });

  test("retries rerun a position with the same inputs, then `onFailure` applies", () => {
    const template = baseTemplate();
    (template.nodes[0] as { retry?: unknown }).retry = { attempts: 2, on: ["provider-error"] };
    const compiled = compiledPlan(template);
    let run = plan(runOf(compiled, { inputs: ["target"] })).run;
    run = settle(run, find(run, "build").key, "failed", {
      error: "unreachable",
      errorCause: "provider-error",
    });
    let result = plan(run);
    expect(result.retried).toBe(1);
    const retry = find(result.run, "build");
    expect(retry.key).toBe("build#iter=1#attempt=2");
    expect(retry.inputs).toEqual({ code: id("target") });
    run = settle(result.run, retry.key, "failed", { error: "again", errorCause: "provider-error" });
    result = plan(run);
    expect(result.retried).toBe(0);
    expect(result.failure).toEqual({ error: "Node build failed: again", cause: "provider-error" });
    // A cause the policy does not name is not retried.
    run = plan(runOf(compiled, { inputs: ["target"] })).run;
    run = settle(run, find(run, "build").key, "failed", { error: "x", errorCause: "timeout" });
    expect(plan(run).failure?.cause).toBe("timeout");
  });
});

describe("loops and iterations (§9.2)", () => {
  const compiled = compiledPlan(graphTemplateExample("build-pipeline-loop"));
  const verdict = (complete: boolean) => ({
    complete,
    criteria: [],
    summary: complete ? "Done" : "Not yet",
  });

  /** Runs one iteration: everything ready completes; the gate takes `outlet`. */
  function iteration(run: GraphRun, at: number, outlet: "issues" | "clean"): GraphRun {
    let next = plan(run).run;
    if (at === 1) next = plan(completeNode(next, "build")).run;
    next = plan(next).run;
    for (const nodeId of ["fix", "prepare", "package", "review"]) {
      next = plan(completeNode(next, nodeId, { iteration: at })).run;
    }
    next = plan(completeNode(next, "has-issues", { iteration: at, outlet })).run;
    next = plan(completeNode(next, "address", { iteration: at })).run;
    return completeNode(next, "verify", { iteration: at });
  }

  test("iteration 1 reads `first` edges and skips the later-only entry", () => {
    let run = plan(runOf(compiled)).run;
    run = plan(completeNode(run, "build")).run;
    const fix = find(run, "fix");
    expect(fix.state).toBe("skipped");
    const prepare = find(run, "prepare");
    expect(prepare.state).toBe("ready");
    expect(prepare.inputs.code).toBe(id("build#iter=1#attempt=1/code"));
  });

  test("a settled iteration whose `until` is false starts the next, fed by carries and `later` edges", () => {
    let run = iteration(runOf(compiled), 1, "issues");
    const verifyCode = find(run, "verify").outputs.code!;
    const verdictId = find(run, "verify").outputs.verdict!;
    const values = new Map([[verdictId, { value: verdict(false) }]]);
    // `until` needs the verdict's value before the loop can move on.
    const waiting = plan(run);
    expect(waiting.needValues).toEqual([verdictId]);
    const result = plan(run, values);
    expect(result.loopsAdvanced).toBe(1);
    run = result.run;
    expect(run.loopIterations.rounds).toBe(2);
    const fix = find(run, "fix", 2);
    expect(fix.state).toBe("ready");
    expect(fix.inputs).toEqual({
      ticket: id("ticket"),
      feedback: verdictId,
      code: verifyCode,
    });
    run = plan(completeNode(run, "fix", { iteration: 2 }), values).run;
    // `prepare` now reads the `later` edge from fix, not build.
    expect(find(run, "prepare", 2).inputs.code).toBe(id("fix#iter=2#attempt=1/code"));
  });

  test("a clean outlet takes the other producer of a single-value port", () => {
    let run = plan(runOf(compiled)).run;
    run = plan(completeNode(run, "build")).run;
    for (const nodeId of ["prepare", "package", "review"]) {
      run = plan(completeNode(run, nodeId)).run;
    }
    run = plan(completeNode(run, "has-issues", { outlet: "clean" })).run;
    expect(find(run, "address").state).toBe("skipped");
    const verify = find(run, "verify");
    expect(verify.state).toBe("ready");
    expect(verify.inputs.code).toBe(id("prepare#iter=1#attempt=1/code"));
    expect(verify.inputs.address).toBeUndefined();
  });

  test("the loop ends when `until` holds or at `maxIterations`", () => {
    const run = iteration(runOf(compiled), 1, "issues");
    const verdictId = find(run, "verify").outputs.verdict!;
    const done = plan(run, new Map([[verdictId, { value: verdict(true) }]]));
    expect(done.doneLoops).toEqual(["rounds"]);
    expect(done.run.loopIterations.rounds).toBe(1);
    expect(done.waiting).toBe(0);
    // At the bound the loop ends without reading `until` again.
    let bounded = runOf(compiled);
    const values = new Map<string, { value: unknown }>();
    for (let at = 1; at <= 3; at++) {
      bounded = iteration(bounded, at, "issues");
      values.set(find(bounded, "verify", at).outputs.verdict!, { value: verdict(false) });
      bounded = plan(bounded, values).run;
    }
    const atBound = plan(bounded, values);
    expect(atBound.run.loopIterations.rounds).toBe(3);
    expect(atBound.doneLoops).toEqual(["rounds"]);
    expect(
      atBound.run.activations.filter((activation) => activation.nodeId === "fix"),
    ).toHaveLength(3);
  });
});

describe("skips, routes and deliveries in planning (item 206)", () => {
  test("a fan-in whose branches were all skipped is absent, not a failed collect", () => {
    const template = baseTemplate();
    template.roles.push({ key: "panel", multiplicity: "panel", maxPanel: 4 });
    template.parameters = [{ key: "enabled", type: "boolean", default: false }];
    template.nodes[1] = {
      ...template.nodes[1]!,
      role: "panel",
      replicate: { over: "panel", role: "panel" },
      when: { path: "params.enabled", op: "eq", value: true },
    } as GraphTemplateV1["nodes"][number];
    template.nodes.push({
      id: "consolidate",
      kind: "agent",
      role: "worker",
      capabilities: { profile: "observer" },
      workspaceAccess: "none",
      prompt: { template: "Consolidate.\n\n{{> input.reports}}\n" },
      inputs: [{ name: "reports", type: "list<review-report@1>" }],
      outputs: [{ name: "report", type: "review-report@1" }],
    });
    template.edges.push({
      id: "review-consolidate",
      from: { node: "review", port: "report" },
      to: { node: "consolidate", port: "reports" },
    });
    template.outputs = [];
    let run = plan(runOf(compiledPlan(template))).run;
    run = completeNode(run, "build");
    const result = plan(run);
    expect(result.failure).toBeUndefined();
    expect(find(result.run, "review", 1, "panel.1").state).toBe("skipped");
    expect(find(result.run, "consolidate")).toMatchObject({ state: "skipped" });
  });

  test("a routed failure waits for its error artifact, then feeds the recovery branch", () => {
    const template = baseTemplate();
    template.nodes[0] = {
      ...template.nodes[0]!,
      onFailure: "route",
      outputs: [
        { name: "code", type: "workspace@1" },
        { name: "error", type: "error@1" },
      ],
    } as GraphTemplateV1["nodes"][number];
    template.nodes.push({
      id: "recover",
      kind: "agent",
      role: "worker",
      capabilities: { profile: "observer" },
      workspaceAccess: "none",
      prompt: { template: "Recover.\n\n{{> input.error}}\n" },
      inputs: [{ name: "error", type: "error@1" }],
      outputs: [{ name: "notes", type: "text@1" }],
    });
    template.edges.push({
      id: "build-recover",
      from: { node: "build", port: "error" },
      to: { node: "recover", port: "error" },
    });
    template.outputs = [];
    let run = plan(runOf(compiledPlan(template))).run;
    const build = find(run, "build");
    run = settle(run, build.key, "failed", { error: "It broke", errorCause: "provider-error" });
    const outcomes = new Map();
    const waiting = planGraphRun(run, { at: AT, values: new Map(), outcomes });
    // The failed node's other consumer skips; the recovery branch waits for the artifact.
    expect(find(waiting.run, "review").state).toBe("skipped");
    expect(waiting.run.activations.some((activation) => activation.nodeId === "recover")).toBe(
      false,
    );
    expect(waiting.needArtifacts).toHaveLength(1);
    const request = waiting.needArtifacts[0]!;
    expect(request).toMatchObject({
      purpose: "error",
      type: "error@1",
      producer: { nodeId: "build", activation: build.key, port: "error" },
      // Lineage: what the failed activation consumed.
      inputs: [id("target"), id("notes")],
      values: [
        {
          node: "build",
          cause: "provider-error",
          code: "provider_error",
          message: "It broke",
          attempts: 1,
          retryable: true,
        },
      ],
    });
    outcomes.set(request.key, { ok: true, ids: [id("error")] });
    const routed = planGraphRun(waiting.run, { at: AT, values: new Map(), outcomes });
    expect(routed.needArtifacts).toEqual([]);
    expect(find(routed.run, "build").outputs).toEqual({ error: id("error") });
    expect(find(routed.run, "recover")).toMatchObject({
      state: "ready",
      inputs: { error: id("error") },
    });
  });

  test("an edge with transforms asks for its source values, then for the artifacts it makes", () => {
    const template = baseTemplate();
    template.nodes.push({
      id: "triage",
      kind: "agent",
      role: "worker",
      capabilities: { profile: "observer" },
      workspaceAccess: "none",
      prompt: { template: "Triage.\n\n{{> input.findings}}\n" },
      inputs: [{ name: "findings", type: "list<finding@1>" }],
      outputs: [{ name: "notes", type: "text@1" }],
    });
    template.edges.push({
      id: "review-triage",
      from: { node: "review", port: "report" },
      to: { node: "triage", port: "findings" },
      transform: [
        { op: "flatten", path: "issues" },
        { op: "limit", count: 1 },
      ],
    });
    let run = plan(runOf(compiledPlan(template))).run;
    run = completeNode(run, "build");
    run = completeNode(plan(run).run, "review");
    const reportId = find(run, "review").outputs.report!;
    const outcomes = new Map();
    const values = new Map<string, { value: unknown }>();
    const first = planGraphRun(run, { at: AT, values, outcomes });
    expect(first.needValues).toEqual([reportId]);
    expect(first.waiting).toBe(1);
    values.set(reportId, { value: { issues: [{ title: "one" }, { title: "two" }] } });
    const second = planGraphRun(first.run, { at: AT, values, outcomes });
    expect(second.needArtifacts).toHaveLength(1);
    expect(second.needArtifacts[0]).toMatchObject({
      purpose: "delivery",
      type: "finding@1",
      values: [{ title: "one" }],
      inputs: [reportId],
      producer: { nodeId: "triage", activation: "triage#iter=1#attempt=1", port: "findings" },
    });
    expect(graphRunSettled(second.run, second)).toBe(false);
    outcomes.set(second.needArtifacts[0]!.key, { ok: true, ids: [id("finding")] });
    const third = planGraphRun(second.run, { at: AT, values, outcomes });
    expect(find(third.run, "triage")).toMatchObject({
      state: "ready",
      inputs: { findings: [id("finding")] },
    });
  });
});
