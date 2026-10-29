/**
 * Human nodes end to end (item 208): the real human executor and answers
 * through real scheduler passes, with pass-through agents downstream.
 * Deterministic: a manual clock, no waits.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import {
  graphRunPendingInteractions,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphNodeSpec, GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  createGraphHumanExecutor,
  GraphHumanAnswerError,
  GraphHumanAnswers,
} from "./graph-node-human.js";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import type { GraphRunService } from "./graph-run-service.js";
import { ManualTime } from "./recurring-test-support.js";

const BASE = Date.parse("2026-10-29T12:00:00.000Z");
const BRIEF = { text: "Export reports as CSV." };

const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  answers: GraphHumanAnswers;
  time: ManualTime;
}

async function harness(world?: GraphRunWorld, time = new ManualTime(0)): Promise<Harness> {
  const owned = world ?? (await graphRunWorld());
  if (!world) worlds.push(owned);
  owned.fakes.skipKinds.add("human");
  const clock = () => new Date(BASE + time.now());
  const service = owned.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    clock,
  });
  service.executors.register(createGraphHumanExecutor());
  await service.init();
  const answers = new GraphHumanAnswers({ runs: service, artifacts: owned.artifacts, clock });
  return { world: owned, service, answers, time };
}

function agent(id: string, input: string, type = "text@1"): GraphNodeSpec {
  return {
    id,
    kind: "agent",
    role: "worker",
    capabilities: { profile: "observer" },
    workspaceAccess: "none",
    prompt: { template: `Do ${id}.\n\n{{> input.${input}}}\n` },
    inputs: [{ name: input, type }],
    outputs: [{ name: "done", type: "text@1" }],
  } as GraphNodeSpec;
}

function template(human: Record<string, unknown>, extra: GraphNodeSpec[], edges: unknown[]) {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "people",
    revision: 1,
    name: "People",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "brief", type: "text@1" }],
    outputs: [],
    workspace: { kind: "environment" },
    nodes: [
      { id: "check", kind: "human", inputs: [{ name: "brief", type: "text@1" }], ...human },
      ...extra,
    ],
    edges: [{ id: "in", from: { input: "brief" }, to: { node: "check", port: "brief" } }, ...edges],
    limits: { maxAgentSessions: 10, maxConcurrentAgents: 2 },
  } as unknown as GraphTemplateV1;
}

/** check (approve or edit) → build on `approved`, rework on `rejected`. */
function approvalPlan(form: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return compiledPlan(
    template(
      { form, ...extra },
      [agent("build", "brief"), agent("rework", "brief")],
      [
        {
          id: "approved",
          from: { node: "check", outlet: "approved", port: "brief" },
          to: { node: "build", port: "brief" },
        },
        {
          id: "rejected",
          from: { node: "check", outlet: "rejected", port: "brief" },
          to: { node: "rework", port: "brief" },
        },
      ],
    ),
  );
}

function launch(h: Harness, plan: CompiledGraphPlan): Promise<GraphRun> {
  return h.service.create({
    projectId: "p1",
    environmentId: "e1",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan),
    inputs: { brief: BRIEF },
  });
}

async function pass(h: Harness, runId: string, ms = 3_000): Promise<GraphRun> {
  h.time.jump(ms);
  const run = await h.service.advanceNow(runId);
  if (!run) throw new Error("the run disappeared");
  return run;
}

async function finish(h: Harness, runId: string, passes = 40): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    const run = await pass(h, runId);
    if (run.status === "complete" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }
  }
  throw new Error("the run did not finish");
}

function latest(run: GraphRun, nodeId: string): NodeActivation {
  const found = run.activations
    .filter((activation) => activation.nodeId === nodeId)
    .sort((left, right) => right.attempt - left.attempt)[0];
  if (!found) throw new Error(`no activation of ${nodeId}`);
  return found;
}

async function waiting(h: Harness, plan: CompiledGraphPlan) {
  const launched = await launch(h, plan);
  let run = await pass(h, launched.id);
  run = await pass(h, launched.id);
  const check = latest(run, "check");
  expect(check.state).toBe("awaiting-human");
  expect(run.status).toBe("waiting");
  return { run, check, location: { runId: run.id, activationKey: check.key } };
}

async function refusal(promise: Promise<unknown>): Promise<GraphHumanAnswerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GraphHumanAnswerError) return error;
    throw error;
  }
  throw new Error("the answer was accepted");
}

describe("human node executor", () => {
  test("approve: the run waits, the answer takes `approved`, the other outlet is skipped", async () => {
    const h = await harness();
    const { run, check, location } = await waiting(h, approvalPlan({ kind: "approve" }));
    expect(check.human).toMatchObject({ form: "approve" });
    expect(graphRunPendingInteractions(run)).toEqual([
      expect.objectContaining({ kind: "human", waitId: check.human!.id, form: "approve" }),
    ]);
    // Without a timeout the run waits indefinitely, paused rather than failed.
    let still = run;
    for (let index = 0; index < 20; index++) still = await pass(h, run.id, 60_000);
    expect(still.status).toBe("waiting");
    expect(latest(still, "check").state).toBe("awaiting-human");

    const answered = await h.answers.answer(
      location,
      { waitId: check.human!.id, decision: "approve", note: "Looks right" },
      "user",
    );
    expect(answered.human?.answer).toMatchObject({ decision: "approve", outlet: "approved" });
    const done = await finish(h, run.id);
    expect(done.status).toBe("complete");
    const decided = latest(done, "check");
    expect(decided).toMatchObject({ state: "complete", outlet: "approved" });
    expect(decided.outputs.brief).toBe(run.bindings.inputs.brief);
    expect(latest(done, "build").state).toBe("complete");
    expect(latest(done, "build").inputs.brief).toBe(run.bindings.inputs.brief);
    expect(latest(done, "rework").state).toBe("skipped");
  });

  test("reject takes `rejected`; a stale, repeated or mismatched answer is refused", async () => {
    const h = await harness();
    const { run, check, location } = await waiting(h, approvalPlan({ kind: "approve" }));
    const waitId = check.human!.id;
    expect(
      (
        await refusal(
          h.answers.answer(location, { waitId: crypto.randomUUID(), decision: "approve" }, "user"),
        )
      ).message,
    ).toContain("another attempt");
    expect(
      (
        await refusal(
          h.answers.answer(location, { waitId, decision: "choose", outlet: "approved" }, "user"),
        )
      ).message,
    ).toContain("approval or a rejection");
    expect(
      (
        await refusal(
          h.answers.answer(location, { waitId, decision: "approve", value: BRIEF }, "user"),
        )
      ).message,
    ).toContain("Only an edit step");
    expect(
      (
        await refusal(
          h.answers.answer(
            { ...location, activationKey: "nope#iter=1#attempt=1" },
            { waitId, decision: "approve" },
            "user",
          ),
        )
      ).code,
    ).toBe("not-found");
    // Nothing was recorded by the refusals.
    expect(latest((await h.service.get(run.id))!, "check").human?.answer).toBeUndefined();

    await h.answers.answer(location, { waitId, decision: "reject" }, "user");
    expect(
      (await refusal(h.answers.answer(location, { waitId, decision: "approve" }, "user"))).message,
    ).toMatch(/already answered|not waiting/);
    const done = await finish(h, run.id);
    expect(latest(done, "check").outlet).toBe("rejected");
    expect(latest(done, "rework").state).toBe("complete");
    expect(latest(done, "build").state).toBe("skipped");
  });

  test("edit: a valid edit becomes a new artifact with lineage; an invalid one is refused", async () => {
    const h = await harness();
    const { run, check, location } = await waiting(
      h,
      approvalPlan({ kind: "edit", edit: "brief", instructions: "Tighten it." }),
    );
    const waitId = check.human!.id;
    const original = run.bindings.inputs.brief!;
    const pending = graphRunPendingInteractions(run)[0]!;
    expect(pending).toMatchObject({
      kind: "human",
      form: "edit",
      edit: { port: "brief", type: "text@1", artifactId: original },
    });
    const invalid = await refusal(
      h.answers.answer(location, { waitId, decision: "approve", value: { text: 5 } }, "user"),
    );
    expect(invalid.code).toBe("invalid-answer");
    expect(invalid.message).toContain("does not fit text@1");
    expect(latest((await h.service.get(run.id))!, "check").human?.answer).toBeUndefined();
    expect(
      (
        await refusal(
          h.answers.answer(location, { waitId, decision: "reject", value: BRIEF }, "user"),
        )
      ).message,
    ).toContain("Only an approval");

    const edited = await h.answers.answer(
      location,
      { waitId, decision: "approve", value: { text: "Export reports as CSV with a header." } },
      "user",
    );
    const editedId = edited.human!.answer!.edited!.artifactId;
    expect(edited.human!.answer!.edited!.port).toBe("brief");
    expect(editedId).not.toBe(original);
    const stored = await h.world.storage.graphRuns.getGraphArtifact(run.id, editedId);
    expect(stored).toMatchObject({
      type: "text@1",
      inputs: [original],
      producer: { nodeId: "check", activation: check.key, port: "brief" },
      body: { value: { text: "Export reports as CSV with a header." } },
    });
    const done = await finish(h, run.id);
    expect(latest(done, "check")).toMatchObject({
      outlet: "approved",
      outputs: { brief: editedId },
    });
    expect(latest(done, "build").inputs.brief).toBe(editedId);
  });

  test("edit: approving an unchanged value forwards the original", async () => {
    const h = await harness();
    const { run, check, location } = await waiting(
      h,
      approvalPlan({ kind: "edit", edit: "brief" }),
    );
    const answered = await h.answers.answer(
      location,
      { waitId: check.human!.id, decision: "approve", value: { ...BRIEF } },
      "user",
    );
    expect(answered.human!.answer!.edited).toBeUndefined();
    const done = await finish(h, run.id);
    expect(latest(done, "build").inputs.brief).toBe(run.bindings.inputs.brief);
  });

  test("choose routes to the chosen option's outlet; an unknown option is refused", async () => {
    const h = await harness();
    const plan = compiledPlan(
      template(
        {
          form: {
            kind: "choose",
            options: [
              { to: "fast", label: "Ship it" },
              { to: "slow", label: "Review again" },
            ],
          },
        },
        [agent("ship", "brief"), agent("review", "brief")],
        [
          {
            id: "fast",
            from: { node: "check", outlet: "fast", port: "brief" },
            to: { node: "ship", port: "brief" },
          },
          {
            id: "slow",
            from: { node: "check", outlet: "slow", port: "brief" },
            to: { node: "review", port: "brief" },
          },
        ],
      ),
    );
    const { run, check, location } = await waiting(h, plan);
    const waitId = check.human!.id;
    expect(graphRunPendingInteractions(run)[0]).toMatchObject({
      form: "choose",
      options: [{ to: "fast" }, { to: "slow" }],
    });
    expect(
      (
        await refusal(
          h.answers.answer(location, { waitId, decision: "choose", outlet: "sideways" }, "user"),
        )
      ).message,
    ).toContain("one of the step's options");
    expect(
      (await refusal(h.answers.answer(location, { waitId, decision: "approve" }, "user"))).message,
    ).toContain("takes a choice");
    await h.answers.answer(location, { waitId, decision: "choose", outlet: "slow" }, "user");
    const done = await finish(h, run.id);
    expect(latest(done, "check").outlet).toBe("slow");
    expect(latest(done, "review").state).toBe("complete");
    expect(latest(done, "ship").state).toBe("skipped");
  });

  test("a timeout routes to the implicit error port; the outlets' consumers are skipped", async () => {
    const h = await harness();
    const plan = compiledPlan(
      template(
        { form: { kind: "approve" }, timeoutMs: 60_000 },
        [agent("build", "brief"), agent("escalate", "failure", "error@1")],
        [
          {
            id: "approved",
            from: { node: "check", outlet: "approved", port: "brief" },
            to: { node: "build", port: "brief" },
          },
          {
            id: "timed-out",
            from: { node: "check", port: "error" },
            to: { node: "escalate", port: "failure" },
          },
        ],
      ),
    );
    const human = plan.nodes.find((node) => node.id === "check")!;
    expect(human.onFailure).toBe("route");
    expect(human.outputs).toEqual([expect.objectContaining({ name: "error", type: "error@1" })]);
    const { run, check } = await waiting(h, plan);
    expect(graphRunPendingInteractions(run)[0]).toMatchObject({ timeoutAt: expect.any(String) });
    const done = await (async () => {
      await pass(h, run.id, 61_000);
      return finish(h, run.id);
    })();
    const timedOut = latest(done, "check");
    expect(timedOut).toMatchObject({ key: check.key, state: "failed", errorCause: "timeout" });
    expect(timedOut.outputs.error).toBeDefined();
    const error = await h.world.storage.graphRuns.getGraphArtifact(run.id, timedOut.outputs.error!);
    expect(error?.type).toBe("error@1");
    expect(latest(done, "escalate").state).toBe("complete");
    expect(latest(done, "build").state).toBe("skipped");
    expect(done.status).toBe("complete");
  });

  test("an answer recorded before the deadline wins over a timeout observed after it", async () => {
    const h = await harness();
    const { run, check, location } = await waiting(
      h,
      approvalPlan({ kind: "approve" }, { timeoutMs: 60_000 }),
    );
    h.time.jump(30_000);
    await h.answers.answer(location, { waitId: check.human!.id, decision: "approve" }, "user");
    // The next pass happens after the deadline: the timeout cancel honours the answer.
    const after = await pass(h, run.id, 40_000);
    expect(latest(after, "check")).toMatchObject({ state: "complete", outlet: "approved" });
  });

  test("the wait survives a backend restart, and the answer completes it afterwards", async () => {
    const first = await harness();
    const { run, check } = await waiting(first, approvalPlan({ kind: "approve" }));
    await first.service.shutdown();
    // A second process over the same store: recovery observes the stored wait.
    const second = await harness(first.world, first.time);
    let recovered = await pass(second, run.id);
    expect(latest(recovered, "check")).toMatchObject({
      key: check.key,
      state: "awaiting-human",
      human: { id: check.human!.id },
    });
    expect(recovered.status).toBe("waiting");
    await second.answers.answer(
      { runId: run.id, activationKey: check.key },
      { waitId: check.human!.id, decision: "approve" },
      "user",
    );
    recovered = await finish(second, run.id);
    expect(latest(recovered, "build").state).toBe("complete");
  });

  test("restarting a waiting node supersedes its wait; the old wait's answer is refused", async () => {
    const h = await harness();
    const { run, check, location } = await waiting(h, approvalPlan({ kind: "approve" }));
    const restarted = await h.service.restart(run.id, check.key, { requestedBy: "user" });
    expect(restarted.run.activations.find((entry) => entry.key === check.key)?.state).toBe(
      "superseded",
    );
    const stale = await refusal(
      h.answers.answer(location, { waitId: check.human!.id, decision: "approve" }, "user"),
    );
    expect(stale.code).toBe("invalid-answer");
    const again = await pass(h, run.id);
    const next = latest(await pass(h, again.id), "check");
    expect(next.attempt).toBe(2);
    expect(next.state).toBe("awaiting-human");
    expect(next.human?.id).not.toBe(check.human!.id);
    expect(
      (
        await refusal(
          h.answers.answer(
            { runId: run.id, activationKey: next.key },
            { waitId: check.human!.id, decision: "approve" },
            "user",
          ),
        )
      ).message,
    ).toContain("another attempt");
  });

  test("cancelling the run settles a waiting node unanswered", async () => {
    const h = await harness();
    const { run, check, location } = await waiting(h, approvalPlan({ kind: "approve" }));
    await h.service.cancel(run.id);
    const done = await finish(h, run.id);
    expect(done.status).toBe("cancelled");
    expect(latest(done, "check")).toMatchObject({ key: check.key, state: "cancelled" });
    expect(latest(done, "check").human?.answer).toBeUndefined();
    expect(
      (
        await refusal(
          h.answers.answer(location, { waitId: check.human!.id, decision: "approve" }, "user"),
        )
      ).code,
    ).toBe("invalid-answer");
  });
});
