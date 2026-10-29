/**
 * `items` fan-out end to end (item 401): the report §9.4 example as written,
 * explicit truncation, branch key stability across retries and restarts,
 * and per-item provenance through to downstream nodes. Real scheduler
 * passes with the real gate and merge executors and the pass-through agent
 * and system executors. Deterministic: a manual clock, no waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { compile, type CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import { graphTemplateExample } from "@orkestrator/protocol/graphs/examples";
import { validateGraphProvenance } from "@orkestrator/protocol/graphs/provenance";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import type { GraphAgentNode, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { loadGraphAgentInputs } from "./graph-agent-prompt.js";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import type { GraphRunService } from "./graph-run-service.js";
import { ManualTime } from "./recurring-test-support.js";

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
}

async function harness(): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  world.fakes.skipKinds.add("gate");
  world.fakes.skipKinds.add("merge");
  const time = new ManualTime(0);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  service.executors.register(createGraphGateExecutor());
  service.executors.register(createGraphMergeExecutor());
  await service.init();
  return { world, service, time };
}

async function launch(h: Harness, plan: CompiledGraphPlan): Promise<GraphRun> {
  return h.service.create({
    projectId: "p1",
    environmentId: "e1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan, 2),
    inputs: Object.fromEntries(
      plan.inputs.map((input) => [input.name, graphTypeExample(plan, input.type)]),
    ),
  });
}

async function finish(h: Harness, runId: string, passes = 80): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    h.time.jump(3_000);
    const run = await h.service.advanceNow(runId);
    if (!run) throw new Error("the run disappeared");
    if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }
  }
  throw new Error("the run did not finish");
}

function latest(run: GraphRun, nodeId: string, iteration = 1, branchKey?: string): NodeActivation {
  const found = run.activations
    .filter(
      (activation) =>
        activation.nodeId === nodeId &&
        activation.iteration === iteration &&
        activation.branchKey === branchKey,
    )
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!found) throw new Error(`no activation of ${nodeId} at ${iteration} ${branchKey ?? ""}`);
  return found;
}

const live = (run: GraphRun, nodeId: string) =>
  run.activations.filter(
    (activation) => activation.nodeId === nodeId && activation.state !== "superseded",
  );

async function artifact(h: Harness, run: GraphRun, id: string) {
  const stored = await h.world.storage.graphRuns.getGraphArtifact(run.id, id);
  if (!stored) throw new Error(`no artifact ${id}`);
  return stored;
}

function failure(id: string) {
  return {
    id,
    command: `bun test ${id}`,
    state: "failed",
    exitCode: 1,
    summary: "fails",
    output: "1 failed",
  };
}

function results(failures: ReturnType<typeof failure>[]) {
  return {
    headRef: "a".repeat(40),
    state: failures.length > 0 ? "failed" : "passed",
    total: 4,
    passed: 4 - failures.length,
    failures,
    limitations: [],
  };
}

const diagnosis = (rootCause: string) => ({
  diagnoses: [{ rootCause, explanation: "why", files: ["src/a.ts"] }],
});

/** §9.4 as written, with `maxBranches` and `truncate` on its items axis changed. */
function failureDiagnosis(change: Partial<{ maxBranches: number; truncate: "first" | "fail" }>) {
  const template = graphTemplateExample("failure-diagnosis");
  const diagnose = template.nodes.find((node) => node.id === "diagnose") as GraphAgentNode;
  diagnose.replicate = { over: "items", input: "failures", maxBranches: 12, ...change };
  return template;
}

describe("§9.4 with items fan-out", () => {
  test("the example as written runs one diagnosis per failure, dedupes, fixes and revalidates until clean", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("validate", ({ port, iteration }) =>
      port === "results"
        ? results(iteration === 1 ? [failure("a"), failure("b"), failure("c")] : [])
        : undefined,
    );
    h.world.fakes.scripts.set("diagnose", ({ branchKey }) =>
      diagnosis(branchKey === "item.validate:failure-3" ? "typo" : "race"),
    );
    const run = await finish(
      h,
      (await launch(h, compiledPlan(graphTemplateExample("failure-diagnosis")))).id,
    );
    expect(run.status).toBe("complete");
    expect(run.loopIterations.repair).toBe(2);

    // One fan-out record, keyed by each failure's stable id; nothing truncated.
    expect(run.fanOuts).toHaveLength(1);
    const fanOut = run.fanOuts![0]!;
    expect(fanOut).toMatchObject({ nodeId: "diagnose", iteration: 1, total: 3 });
    expect(fanOut.truncatedIds).toBeUndefined();
    expect(fanOut.items.map((item) => [item.key, item.index, item.id])).toEqual([
      ["item.validate:failure-1", 1, "validate/failure-1"],
      ["item.validate:failure-2", 2, "validate/failure-2"],
      ["item.validate:failure-3", 3, "validate/failure-3"],
    ]);
    // Each branch reads exactly its failure: one element artifact cut from the results.
    const resultsId = latest(run, "validate").outputs.results!;
    for (const item of fanOut.items) {
      const branch = latest(run, "diagnose", 1, item.key);
      expect(branch.state).toBe("complete");
      expect(branch.inputs.failures).toBe(item.artifact);
      const element = await artifact(h, run, item.artifact);
      expect(element.type).toBe("validation-failure@1");
      expect(element.sourceItem).toBe(item.id);
      expect(element.inputs).toEqual([resultsId]);
      expect(fanOut.sources).toContain(element.id);
      // The branch's output stands for its failure.
      const output = await artifact(h, run, branch.outputs.diagnosis!);
      expect(output.sourceItem).toBe(item.id);
    }
    // The dedupe folds the shared root cause; its sources name the failures through the keys.
    const merged = await artifact(h, run, latest(run, "dedupe").outputs.diagnosis!);
    expect(merged.itemSources).toEqual([
      [
        "diagnose/item.validate:failure-1/diagnosis-1",
        "diagnose/item.validate:failure-2/diagnosis-1",
      ],
      ["diagnose/item.validate:failure-3/diagnosis-1"],
    ]);
    expect(latest(run, "fix").inputs.diagnosis).toBe(merged.id);
    // Iteration 2 is clean: diagnose skips as a whole (its `when`), and so does the rest.
    expect(latest(run, "diagnose", 2)).toMatchObject({ state: "skipped" });
    expect(latest(run, "diagnose", 2).branchKey).toBeUndefined();
    expect(latest(run, "fix", 2).state).toBe("skipped");
  });

  test("a branch's prompt sees one failure, its index and id; it may cite exactly that item", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("validate", ({ port, iteration }) =>
      port === "results" ? results(iteration === 1 ? [failure("a"), failure("b")] : []) : undefined,
    );
    h.world.fakes.scripts.set("diagnose", () => diagnosis("race"));
    const run = await finish(
      h,
      (await launch(h, compiledPlan(graphTemplateExample("failure-diagnosis")))).id,
    );
    const node = run.plan.nodes.find((entry) => entry.id === "diagnose")!;
    if (node.kind !== "agent") throw new Error("diagnose is an agent");
    const branch = latest(run, "diagnose", 1, "item.validate:failure-2");
    const inputs = await loadGraphAgentInputs(run, node, branch, h.world.artifacts);
    expect(inputs.values.inputs.failures).toEqual(failure("b"));
    expect(inputs.values.item).toEqual({ index: 2, id: "validate/failure-2" });
    expect(inputs.values.branch).toEqual({
      index: 2,
      key: "item.validate:failure-2",
      count: 2,
    });
    expect(inputs.values.elements?.failures).toEqual([{ sourceItem: "validate/failure-2" }]);
    // The branch's citable source is its own item, not its siblings'.
    expect(inputs.sources["validate/failure-2"]).toBe("validation-failure@1");
    expect(inputs.sources["validate/failure-1"]).toBeUndefined();
  });
});

describe("inside an inlined sub-graph (item 402)", () => {
  test("§9.4 inlined as a child fans out under namespaced ids, keys and source items", async () => {
    const h = await harness();
    const child = { ...graphTemplateExample("failure-diagnosis"), id: "repair-loop" };
    const parent: GraphTemplateV1 = {
      format: "orkestrator.graph",
      formatVersion: 1,
      id: "nested-repair",
      revision: 1,
      name: "Nested repair",
      parameters: [],
      roles: [
        { key: "diagnoser", multiplicity: "one" },
        { key: "fixer", multiplicity: "one" },
      ],
      inputs: [
        { name: "plan", type: "validation-plan@1" },
        { name: "target", type: "workspace@1" },
      ],
      outputs: [
        {
          name: "results",
          type: "validation-results@1",
          from: { node: "repair", port: "results" },
        },
      ],
      workspace: { kind: "environment" },
      nodes: [
        {
          id: "repair",
          kind: "subgraph",
          template: { scope: "user", id: "repair-loop" },
          roles: { diagnoser: "diagnoser", fixer: "fixer" },
          inputs: [
            { name: "plan", type: "validation-plan@1" },
            { name: "target", type: "workspace@1" },
          ],
          outputs: [{ name: "results", type: "validation-results@1" }],
        },
      ],
      edges: [
        { id: "plan-repair", from: { input: "plan" }, to: { node: "repair", port: "plan" } },
        { id: "target-repair", from: { input: "target" }, to: { node: "repair", port: "target" } },
      ],
      limits: { maxAgentSessions: 39, maxConcurrentAgents: 12 },
    };
    const result = compile(parent, {
      resolveTemplate: (ref) =>
        ref.scope === "user" && ref.id === "repair-loop"
          ? { template: structuredClone(child) }
          : undefined,
    });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const plan = result.plan!;
    const diagnoseNode = plan.nodes.find((node) => node.id === "repair/diagnose")!;
    expect(diagnoseNode.fanOut).toEqual({ min: 0, max: 12 });
    h.world.fakes.scripts.set("repair/validate", ({ port, iteration }) =>
      port === "results" ? results(iteration === 1 ? [failure("a"), failure("b")] : []) : undefined,
    );
    h.world.fakes.scripts.set("repair/diagnose", ({ branchKey }) =>
      diagnosis(branchKey === "item.repair:validate:failure-2" ? "typo" : "race"),
    );
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    expect(run.loopIterations["repair/repair"]).toBe(2);
    const fanOut = run.fanOuts![0]!;
    expect(fanOut.nodeId).toBe("repair/diagnose");
    expect(fanOut.items.map((item) => [item.key, item.id])).toEqual([
      ["item.repair:validate:failure-1", "repair/validate/failure-1"],
      ["item.repair:validate:failure-2", "repair/validate/failure-2"],
    ]);
    for (const item of fanOut.items) {
      const branch = latest(run, "repair/diagnose", 1, item.key);
      expect(branch.key).toBe(`repair/diagnose#iter=1#branch=${item.key}#attempt=1`);
      expect((await artifact(h, run, item.artifact)).sourceItem).toBe(item.id);
      expect((await artifact(h, run, branch.outputs.diagnosis!)).sourceItem).toBe(item.id);
    }
    const merged = await artifact(h, run, latest(run, "repair/dedupe").outputs.diagnosis!);
    expect(merged.itemSources).toEqual([
      ["repair/diagnose/item.repair:validate:failure-1/diagnosis-1"],
      ["repair/diagnose/item.repair:validate:failure-2/diagnosis-1"],
    ]);
    // The inlined branch's prompt reads its item like any other.
    if (diagnoseNode.kind !== "agent") throw new Error("diagnose is an agent");
    const inputs = await loadGraphAgentInputs(
      run,
      diagnoseNode,
      latest(run, "repair/diagnose", 1, "item.repair:validate:failure-2"),
      h.world.artifacts,
    );
    expect(inputs.values.item).toEqual({ index: 2, id: "repair/validate/failure-2" });
    expect(Object.keys(inputs.sources)).toContain("repair/validate/failure-2");
  });
});

describe("maxBranches", () => {
  const four = () => results([failure("a"), failure("b"), failure("c"), failure("d")]);

  test("truncate first: the first items run, the rest are recorded on the fan-out", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("validate", ({ port, iteration }) =>
      port === "results" ? (iteration === 1 ? four() : results([])) : undefined,
    );
    h.world.fakes.scripts.set("diagnose", () => diagnosis("race"));
    const run = await finish(
      h,
      (await launch(h, compiledPlan(failureDiagnosis({ maxBranches: 2 })))).id,
    );
    expect(run.status).toBe("complete");
    const fanOut = run.fanOuts![0]!;
    expect(fanOut.items.map((item) => item.id)).toEqual([
      "validate/failure-1",
      "validate/failure-2",
    ]);
    expect(fanOut.total).toBe(4);
    expect(fanOut.truncatedIds).toEqual(["validate/failure-3", "validate/failure-4"]);
    expect(live(run, "diagnose").filter((activation) => activation.iteration === 1)).toHaveLength(
      2,
    );
  });

  test("truncate fail: the position fails before any branch starts, naming both counts", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("validate", ({ port }) => (port === "results" ? four() : undefined));
    const run = await finish(
      h,
      (await launch(h, compiledPlan(failureDiagnosis({ maxBranches: 2, truncate: "fail" })))).id,
    );
    const diagnose = live(run, "diagnose").filter((activation) => activation.iteration === 1);
    expect(diagnose).toHaveLength(1);
    expect(diagnose[0]).toMatchObject({ state: "failed", errorCause: "budget-exceeded" });
    expect(diagnose[0]!.branchKey).toBeUndefined();
    expect(diagnose[0]!.error).toBe(
      "Input failures holds 4 items; diagnose runs at most 2 (truncate: fail)",
    );
    expect(run.fanOuts).toBeUndefined();
    expect(h.world.fakes.callsOf("start", "diagnose")).toHaveLength(0);
    // Nothing downstream ran on a partial set.
    expect(live(run, "fix").every((activation) => activation.state !== "complete")).toBe(true);
  });

  test("an empty list records an empty fan-out and skips the position", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("validate", ({ port }) =>
      port === "results" ? results([]) : undefined,
    );
    const template = graphTemplateExample("failure-diagnosis");
    const diagnose = template.nodes.find((node) => node.id === "diagnose") as GraphAgentNode;
    delete diagnose.when;
    const run = await finish(h, (await launch(h, compiledPlan(template))).id);
    expect(run.status).toBe("complete");
    expect(run.fanOuts).toEqual([
      expect.objectContaining({ nodeId: "diagnose", iteration: 1, items: [], total: 0 }),
    ]);
    expect(latest(run, "diagnose")).toMatchObject({ state: "skipped" });
    expect(latest(run, "dedupe").state).toBe("skipped");
  });
});

describe("branch key stability", () => {
  test("an upstream retry and a branch retry keep every item's key and input", async () => {
    const run = async (retry: boolean) => {
      const h = await harness();
      const template = graphTemplateExample("failure-diagnosis");
      const validate = template.nodes.find((node) => node.id === "validate")!;
      const diagnose = template.nodes.find((node) => node.id === "diagnose") as GraphAgentNode;
      if (validate.kind !== "system") throw new Error("validate is a system node");
      validate.retry = { attempts: 2, on: ["provider-error"] };
      diagnose.retry = { attempts: 2, on: ["provider-error"] };
      if (retry) {
        h.world.fakes.failQueue.set("validate", ["provider-error"]);
        h.world.fakes.failBranches.set("diagnose/item.validate:failure-2", ["provider-error"]);
      }
      h.world.fakes.scripts.set("validate", ({ port, iteration }) =>
        port === "results"
          ? results(iteration === 1 ? [failure("a"), failure("b")] : [])
          : undefined,
      );
      h.world.fakes.scripts.set("diagnose", () => diagnosis("race"));
      template.limits = { ...template.limits, maxAgentSessions: 80 };
      return { h, run: await finish(h, (await launch(h, compiledPlan(template))).id) };
    };
    const clean = await run(false);
    const retried = await run(true);
    expect(retried.run.status).toBe("complete");
    expect(latest(retried.run, "validate").attempt).toBe(2);
    const keys = (r: GraphRun) => r.fanOuts![0]!.items.map((item) => [item.key, item.id]);
    expect(keys(retried.run)).toEqual(keys(clean.run));
    // The failed branch reran on the same key, with the same item.
    const attempts = retried.run.activations.filter(
      (activation) =>
        activation.nodeId === "diagnose" && activation.branchKey === "item.validate:failure-2",
    );
    expect(attempts.map((activation) => `${activation.attempt}:${activation.state}`)).toEqual([
      "1:failed",
      "2:complete",
    ]);
    expect(attempts[1]!.inputs).toEqual(attempts[0]!.inputs);
    expect(retried.run.fanOuts).toHaveLength(1);
  });

  test("restarting a branch keeps the fan-out; restarting the upstream expands again", async () => {
    const h = await harness();
    h.world.fakes.scripts.set("validate", ({ port, iteration, attempt }) => {
      if (port !== "results") return undefined;
      if (iteration > 1) return results([]);
      return results(attempt === 1 ? [failure("a"), failure("b")] : [failure("c")]);
    });
    h.world.fakes.scripts.set("diagnose", () => diagnosis("race"));
    const done = await finish(
      h,
      (await launch(h, compiledPlan(graphTemplateExample("failure-diagnosis")))).id,
    );
    expect(done.status).toBe("complete");
    const before = done.fanOuts![0]!;

    // A branch restart: same key, same item, same record.
    const branch = latest(done, "diagnose", 1, "item.validate:failure-1");
    await h.service.restart(done.id, branch.key, { requestId: "restart-branch" });
    const rerun = await finish(h, done.id);
    expect(rerun.status).toBe("complete");
    expect(rerun.fanOuts).toEqual([before]);
    const again = latest(rerun, "diagnose", 1, "item.validate:failure-1");
    expect(again.attempt).toBe(2);
    expect(again.inputs).toEqual(branch.inputs);

    // An upstream restart supersedes the record; the position expands from the new results.
    const validate = latest(rerun, "validate", 1);
    await h.service.restart(rerun.id, validate.key, { requestId: "restart-validate" });
    const expanded = await finish(h, rerun.id);
    expect(expanded.status).toBe("complete");
    expect(expanded.fanOuts).toHaveLength(2);
    expect(expanded.fanOuts![0]!.supersededBy).toBe("restart-validate");
    const next = expanded.fanOuts![1]!;
    expect(next.supersededBy).toBeUndefined();
    expect(next.items.map((item) => item.id)).toEqual(["validate/failure-1"]);
    const element = await artifact(h, expanded, next.items[0]!.artifact);
    expect((element.body as { value: { id: string } }).value.id).toBe("c");
    expect(
      live(expanded, "diagnose")
        .filter((activation) => activation.iteration === 1)
        .map((activation) => activation.branchKey),
    ).toEqual(["item.validate:failure-1"]);
  });
});

describe("per-item provenance through to a downstream fix", () => {
  /** review → one fix plan per finding (items of a type that declares them), citing its finding. */
  function perFindingTemplate(): GraphTemplateV1 {
    return {
      format: "orkestrator.graph",
      formatVersion: 1,
      id: "per-finding",
      revision: 1,
      name: "Per finding",
      parameters: [],
      roles: [{ key: "worker", multiplicity: "one" }],
      inputs: [{ name: "target", type: "workspace@1" }],
      outputs: [
        { name: "plans", type: "list<fix-plan@1>", from: { node: "plan-fix", port: "plan" } },
      ],
      types: [
        {
          name: "fix-plan",
          version: 1,
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              fixes: { type: "array", items: { type: "string" }, "x-orkestrator-sources": true },
            },
            required: ["summary", "fixes"],
            additionalProperties: false,
          },
          storage: "value",
          budgets: { maxBytes: 8_192 },
          example: { summary: "Guard the null.", fixes: [] },
        },
      ],
      workspace: { kind: "environment" },
      nodes: [
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
        {
          id: "plan-fix",
          kind: "agent",
          role: "worker",
          capabilities: { profile: "observer" },
          workspaceAccess: "none",
          replicate: { over: "items", input: "report", maxBranches: 8 },
          prompt: {
            template: "Plan a fix for finding {{item.id}}: {{item.title}}\n",
          },
          inputs: [{ name: "report", type: "review-report@1" }],
          outputs: [{ name: "plan", type: "fix-plan@1", provenance: "cite" }],
        },
      ],
      edges: [
        { id: "target-review", from: { input: "target" }, to: { node: "review", port: "code" } },
        {
          id: "review-plan",
          from: { node: "review", port: "report" },
          to: { node: "plan-fix", port: "report" },
        },
      ],
      limits: { maxAgentSessions: 9, maxConcurrentAgents: 8 },
    };
  }

  test("each fix branch sees its finding, cites it, and its output records it", async () => {
    const h = await harness();
    const plan = compiledPlan(perFindingTemplate());
    const reportExample = graphTypeExample(plan, "review-report@1") as {
      issues: Record<string, unknown>[];
    };
    h.world.fakes.scripts.set("review", () => ({
      ...reportExample,
      issues: ["first", "second", "third"].map((title) => ({ ...reportExample.issues[0], title })),
    }));
    const run = await finish(h, (await launch(h, plan)).id);
    expect(run.status).toBe("complete");
    const fanOut = run.fanOuts![0]!;
    expect(fanOut.items.map((item) => item.key)).toEqual([
      "item.review:issue-1",
      "item.review:issue-2",
      "item.review:issue-3",
    ]);
    const reportId = latest(run, "review").outputs.report!;
    expect(fanOut.sources).toEqual([reportId]);
    const node = run.plan.nodes.find((entry) => entry.id === "plan-fix")!;
    if (node.kind !== "agent") throw new Error("plan-fix is an agent");
    const branch = latest(run, "plan-fix", 1, "item.review:issue-2");
    // The branch's input is the report; its prompt sees the second finding only.
    expect(branch.inputs.report).toBe(reportId);
    const inputs = await loadGraphAgentInputs(run, node, branch, h.world.artifacts);
    expect((inputs.values.inputs.report as { title: string }).title).toBe("second");
    expect(inputs.values.item).toEqual({ index: 2, id: "review/issue-2" });
    expect(Object.keys(inputs.sources)).toEqual(["review/issue-2"]);
    // It may cite the finding it fixed, and nothing else (103's validator).
    const provenance = { mode: "cite" as const, fields: [{ segments: ["fixes"] }] };
    expect(
      validateGraphProvenance(
        { summary: "x", fixes: ["review/issue-2"] },
        provenance,
        inputs.sources,
      ),
    ).toEqual([]);
    expect(
      validateGraphProvenance(
        { summary: "x", fixes: ["review/issue-1"] },
        provenance,
        inputs.sources,
      ).map((issue) => issue.code),
    ).toEqual(["invalid_value"]);
    // Every branch's output records the finding it stands for.
    for (const item of fanOut.items) {
      const output = await artifact(h, run, latest(run, "plan-fix", 1, item.key).outputs.plan!);
      expect(output.sourceItem).toBe(item.id);
    }
  });
});
