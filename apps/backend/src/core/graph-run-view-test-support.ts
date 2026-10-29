/**
 * A small run world for the run view's backend tests (item 211): a plan whose
 * `build` fails as told beside an independent `slow` node, a harness with
 * hand-driven passes, and helpers to launch and advance. Test-only.
 */
import type { CompiledGraphPlan } from "@orkestrator/protocol/graphs/compile";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import type {
  GraphAgentNode,
  GraphNodeSpec,
  GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import {
  bindAllRoles,
  compiledPlan,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import type { GraphRunService } from "./graph-run-service.js";
import { ManualTime } from "./recurring-test-support.js";

const CODE = { name: "code", type: "workspace@1" };
const ERROR = { name: "error", type: "error@1" };

function agent(
  id: string,
  access: "read" | "write" | "none",
  inputs: { name: string; type: string }[],
  outputs: { name: string; type: string }[],
  extra: Partial<GraphAgentNode> = {},
): GraphNodeSpec {
  return {
    id,
    kind: "agent",
    role: "worker",
    capabilities: {
      profile: access === "write" ? "builder" : access === "read" ? "reviewer" : "observer",
    },
    workspaceAccess: access,
    prompt: {
      template: `Do ${id}.\n\n${inputs.map((input) => `{{> input.${input.name}}}`).join("\n\n")}\n`,
    },
    inputs,
    outputs,
    ...extra,
  } as GraphNodeSpec;
}

function edge(id: string, from: unknown, to: [string, string]) {
  return { id, from, to: { node: to[0], port: to[1] } };
}

/**
 * build (write; fails as told) → after; build's `error` → recover; `slow`
 * runs beside them from the run's target, held open so the run stays live.
 */
export function failingPlan(
  build: Partial<GraphAgentNode>,
  maxConcurrentAgents = 4,
): CompiledGraphPlan {
  return compiledPlan({
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "retryable",
    revision: 1,
    name: "Retryable",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [
      { name: "notes", type: "text@1", required: false, from: { node: "after", port: "notes" } },
      {
        name: "recovered",
        type: "text@1",
        required: false,
        from: { node: "recover", port: "notes" },
      },
      { name: "slow", type: "text@1", required: false, from: { node: "slow", port: "notes" } },
    ],
    workspace: { kind: "environment" },
    nodes: [
      agent("build", "write", [CODE], [CODE, ERROR], build),
      agent("after", "read", [CODE], [{ name: "notes", type: "text@1" }]),
      agent("recover", "none", [ERROR], [{ name: "notes", type: "text@1" }]),
      agent(
        "slow",
        "none",
        [{ name: "target", type: "workspace@1" }],
        [{ name: "notes", type: "text@1" }],
      ),
    ],
    edges: [
      edge("target-build", { input: "target" }, ["build", "code"]),
      edge("target-slow", { input: "target" }, ["slow", "target"]),
      edge("build-after", { node: "build", port: "code" }, ["after", "code"]),
      edge("build-recover", { node: "build", port: "error" }, ["recover", "error"]),
    ],
    limits: { maxAgentSessions: 40, maxConcurrentAgents },
  } as unknown as GraphTemplateV1);
}

export interface Harness {
  world: GraphRunWorld;
  service: GraphRunService;
  time: ManualTime;
}

export async function harness(worlds: GraphRunWorld[]): Promise<Harness> {
  const world = await graphRunWorld();
  worlds.push(world);
  const time = new ManualTime(0);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  await service.init();
  return { world, service, time };
}

export async function launch(h: Harness, plan: CompiledGraphPlan): Promise<GraphRun> {
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
    inputs: Object.fromEntries(
      plan.inputs.map((input) => [input.name, graphTypeExample(plan, input.type)]),
    ),
  });
}

/** Passes, one observation period apart, until `done` holds. */
export async function advanceUntil(
  h: Harness,
  runId: string,
  done: (run: GraphRun) => boolean,
  passes = 40,
): Promise<GraphRun> {
  for (let index = 0; index < passes; index++) {
    h.time.jump(3_000);
    const run = await h.service.advanceNow(runId);
    if (!run) throw new Error("the run disappeared");
    if (done(run)) return run;
  }
  throw new Error("the run never got there");
}

export function latest(run: GraphRun, nodeId: string): NodeActivation | undefined {
  return run.activations
    .filter((activation) => activation.nodeId === nodeId && activation.state !== "superseded")
    .sort((left, right) => right.attempt - left.attempt)[0];
}
