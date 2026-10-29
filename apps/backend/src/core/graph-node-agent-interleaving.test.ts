/**
 * Seeded restart interleavings for graph agent activations (items 204, 205),
 * in the spirit of `review-fanout-interleaving.test.ts`. Each seed picks one
 * of two shapes:
 *
 * - **steps**: one to three independent agent steps;
 * - **fan-out**: a replicated agent node (`panel` or `lenses`, 2–4 branches)
 *   whose branches a downstream agent collects (`list<…>` input with an
 *   `all-settled` collect policy), so crashes land mid fan-out: while some
 *   branches are being dispatched, some are running and some have finished.
 *
 * Every step, branch and the collector gets a script (completes, ends
 * without its result, is cut short by a provider restart, fails), the
 * provider may or may not prove an id never arrived, and the backend dies at
 * a send (before or after the prompt reached the provider, whose journal may
 * then retire the id as lost) or at a status read. A fan-out seed always
 * dies at least once during the branches' dispatch. A crash leaves every
 * pending call of the dead process unanswered; a new process starts from the
 * stored run, over the same provider (the environment outlives the backend).
 *
 * Invariants, checked on every seed:
 * - journal before send: a prompt is sent only while the stored activation
 *   names that request `dispatching` (or later);
 * - no request runs twice, and no step or branch runs its original turn twice
 *   (a restart in the middle of a fan-out never re-dispatches a branch);
 * - every run ends; a completed step's, branch's or collector's outputs exist
 *   and verify, and the collector received exactly the branches that
 *   completed;
 * - a step fails only for a reason its script or a disruption explains.
 *
 * Replay a failure with `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=<seed>`;
 * widen a local run with `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=<count>`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GraphRun, GraphRunBindings } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  TEST_DESCRIPTION,
  TEST_TICKET,
  graphAgentWorld,
  turnSlots,
  type FakeAgentProvider,
  type FakeAgentScript,
  type FakeAgentTurn,
  type GraphAgentWorld,
} from "./graph-agent-test-support.js";
import { SeededRandom, interleavingSeeds } from "./review-fanout-interleaving-support.js";

type StepScript = "complete" | "silentOnce" | "restartOnce" | "fail";
const SCRIPTS: readonly StepScript[] = [
  "complete",
  "complete",
  "silentOnce",
  "restartOnce",
  "fail",
];

/** One scheduled unit: a step, a branch of the fan-out node, or the collector. */
interface Unit {
  /** `step-1`, `fan/panel.2`, `fan/lens.l3`, `gather`. */
  label: string;
  nodeId: string;
  branchKey?: string;
  script: StepScript;
}

interface FanOut {
  axis: "panel" | "lenses";
  branches: number;
}

interface Scenario {
  seed: number;
  units: Unit[];
  /** Set for a fan-out seed. */
  fanOut?: FanOut;
  provesAbsence: boolean;
  /** Provider operations (sends and status reads) after which the backend dies. */
  crashes: { atOperation: number; landed: boolean; lost: boolean }[];
}

/** The fan-out node's branch keys, in plan order. */
function branchKeys(fanOut: FanOut): string[] {
  return Array.from({ length: fanOut.branches }, (_, index) =>
    fanOut.axis === "panel" ? `panel.${index + 1}` : `lens.l${index + 1}`,
  );
}

function planScenario(seed: number): Scenario {
  const random = new SeededRandom(seed);
  if (random.chance(0.5)) {
    const count = random.between(1, 3);
    const units = Array.from({ length: count }, (_, index) => ({
      label: `step-${index + 1}`,
      nodeId: `step-${index + 1}`,
      script: random.pick(SCRIPTS),
    }));
    const crashes = Array.from({ length: random.between(0, 2) }, () => ({
      atOperation: random.between(1, 12),
      landed: random.chance(0.5),
      lost: random.chance(0.25),
    })).sort((left, right) => left.atOperation - right.atOperation);
    return { seed, units, provesAbsence: random.chance(0.6), crashes };
  }
  const fanOut: FanOut = {
    axis: random.chance(0.5) ? "panel" : "lenses",
    branches: random.between(2, 4),
  };
  const units: Unit[] = [
    ...branchKeys(fanOut).map((branchKey) => ({
      label: `fan/${branchKey}`,
      nodeId: "fan",
      branchKey,
      script: random.pick(SCRIPTS),
    })),
    { label: "gather", nodeId: "gather", script: random.pick(SCRIPTS) },
  ];
  // The first crash lands while the branches are dispatched (their sends are
  // the first operations); a second one anywhere later, the collector included.
  const crashes = [
    {
      atOperation: random.between(1, fanOut.branches),
      landed: random.chance(0.5),
      lost: random.chance(0.25),
    },
    ...Array.from({ length: random.between(0, 1) }, () => ({
      atOperation: random.between(1, 4 * (fanOut.branches + 1)),
      landed: random.chance(0.5),
      lost: random.chance(0.25),
    })),
  ].sort((left, right) => left.atOperation - right.atOperation);
  return { seed, units, fanOut, provesAbsence: random.chance(0.6), crashes };
}

function stepsTemplate(scenario: Scenario): GraphTemplateV1 {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "interleaving",
    revision: 1,
    name: "Interleaving",
    parameters: [],
    roles: [{ key: "worker", multiplicity: "one" }],
    inputs: [{ name: "ticket", type: "ticket@1" }],
    outputs: [],
    workspace: { kind: "environment" },
    nodes: scenario.units.map((step) => ({
      id: step.nodeId,
      kind: "agent",
      role: "worker",
      capabilities: { profile: "observer" },
      workspaceAccess: "none",
      prompt: { template: `Describe (${step.nodeId}).\n\n{{> input.ticket}}\n` },
      inputs: [{ name: "ticket", type: "ticket@1" }],
      outputs: [{ name: "description", type: "pr-description@1" }],
      onFailure: "skip",
    })),
    edges: scenario.units.map((step) => ({
      id: `ticket-${step.nodeId}`,
      from: { input: "ticket" },
      to: { node: step.nodeId, port: "ticket" },
    })),
    limits: { maxAgentSessions: 20, maxConcurrentAgents: 3 },
  } as GraphTemplateV1;
}

/** `fan` (replicated, 2–4 branches) → `gather` (collects every settled branch). */
function fanOutTemplate(fanOut: FanOut): GraphTemplateV1 {
  const keys = branchKeys(fanOut);
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: "interleaving-fan-out",
    revision: 1,
    name: "Interleaving fan-out",
    parameters: [],
    roles: [
      { key: "worker", multiplicity: "one" },
      ...(fanOut.axis === "panel"
        ? [{ key: "panel", multiplicity: "panel", maxPanel: fanOut.branches }]
        : []),
    ],
    inputs: [{ name: "ticket", type: "ticket@1" }],
    outputs: [],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: "fan",
        kind: "agent",
        role: fanOut.axis === "panel" ? "panel" : "worker",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        replicate:
          fanOut.axis === "panel"
            ? { over: "panel", role: "panel" }
            : {
                over: "lenses",
                lenses: keys.map((key) => ({
                  key: key.slice("lens.".length),
                  label: `Lens ${key.slice("lens.".length)}`,
                  instruction: `Focus on ${key.slice("lens.".length)}.`,
                })),
              },
        prompt: { template: "Describe (fan).\n\n{{> input.ticket}}\n" },
        inputs: [{ name: "ticket", type: "ticket@1" }],
        outputs: [{ name: "description", type: "pr-description@1" }],
        onFailure: "skip",
      },
      {
        id: "gather",
        kind: "agent",
        role: "worker",
        capabilities: { profile: "observer" },
        workspaceAccess: "none",
        prompt: { template: "Describe (gather).\n\n{{> input.descriptions}}\n" },
        inputs: [
          {
            name: "descriptions",
            type: "list<pr-description@1>",
            render: "json-frame",
            collect: { wait: "all-settled", minSuccessful: 1, includeFailures: false },
          },
        ],
        outputs: [{ name: "description", type: "pr-description@1" }],
        onFailure: "skip",
      },
    ],
    edges: [
      { id: "ticket-fan", from: { input: "ticket" }, to: { node: "fan", port: "ticket" } },
      {
        id: "fan-gather",
        from: { node: "fan", port: "description" },
        to: { node: "gather", port: "descriptions" },
      },
    ],
    limits: { maxAgentSessions: 40, maxConcurrentAgents: 5 },
  } as GraphTemplateV1;
}

function roles(fanOut: FanOut | undefined): GraphRunBindings["roles"] | undefined {
  if (fanOut?.axis !== "panel") return undefined;
  return {
    worker: { platform: "claude", model: "model" },
    panel: Array.from({ length: fanOut.branches }, (_, index) => ({
      platform: "claude" as const,
      model: `panel-model-${index + 1}`,
    })),
  };
}

function turnKind(turn: FakeAgentTurn): "original" | "reminder" | "continuation" {
  if (turn.prompt.includes("Orkestrator has not received your results")) return "reminder";
  if (turn.prompt.includes("Orkestrator restarted while you were working")) return "continuation";
  return "original";
}

/** The unit a turn belongs to: its step, its fan-out branch (by lens or panel model), or the collector. */
function unitOf(turn: FakeAgentTurn, provider: FakeAgentProvider): string {
  const node = /Describe \(([a-z0-9-]+)\)/.exec(turn.prompt)?.[1] ?? "unknown";
  if (node !== "fan") return node;
  const lens = /Lens: Lens (l\d)/.exec(turn.prompt)?.[1];
  if (lens) return `fan/lens.${lens}`;
  const model = String(provider.session(turn.sessionId).createOptions.model);
  const panel = /^panel-model-(\d)$/.exec(model)?.[1];
  return panel ? `fan/panel.${panel}` : "fan/unknown";
}

function scriptFor(scenario: Scenario): FakeAgentScript {
  return async (turn, tools, provider) => {
    const step = scenario.units.find((candidate) => candidate.label === unitOf(turn, provider));
    const kind = turnKind(turn);
    const firstTurn = kind === "original";
    switch (step?.script) {
      case "fail":
        return "error";
      case "silentOnce":
        if (firstTurn) return "idle";
        break;
      case "restartOnce":
        if (firstTurn) return "restart";
        break;
      default:
        break;
    }
    await tools.call("submit_description", {
      resultKey: turnSlots(turn).description,
      result: TEST_DESCRIPTION,
    });
    return "idle";
  };
}

interface Outcome {
  scenario: Scenario;
  run: GraphRun;
  violations: string[];
  fired: string[];
  absentResends: number;
  lateDeliveries: number;
  lostAnswers: number;
  /** Crashes that landed while a fan-out branch was still unsettled. */
  midFanOutCrashes: number;
}

/** True while the stored run has a fan-out branch that has not settled. */
function fanOutUnsettled(run: GraphRun): boolean {
  return run.activations.some(
    (activation) =>
      activation.nodeId === "fan" &&
      !["complete", "failed", "skipped", "cancelled", "superseded"].includes(activation.state),
  );
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const world: GraphAgentWorld = await graphAgentWorld({ script: scriptFor(scenario) });
  const violations: string[] = [];
  const fired: string[] = [];
  let lateDeliveries = 0;
  let lostAnswers = 0;
  let midFanOutCrashes = 0;
  try {
    world.provider.provesAbsence = scenario.provesAbsence;
    world.start();
    const run = await world.launch(
      scenario.fanOut ? fanOutTemplate(scenario.fanOut) : stepsTemplate(scenario),
      { ticket: TEST_TICKET },
      roles(scenario.fanOut),
    );
    let operations = 0;
    const pending = [...scenario.crashes];
    let crash: (() => void) | undefined;
    const dying = () => {
      const next = pending[0];
      if (!next || operations < next.atOperation) return undefined;
      pending.shift();
      return next;
    };
    const die = async () => {
      fired.push(`crash@${operations}`);
      if (scenario.fanOut && fanOutUnsettled(await world.run(run.id))) midFanOutCrashes += 1;
      crash?.();
      await new Promise(() => {});
    };
    world.provider.beforeSend = async (turn) => {
      operations += 1;
      // Journal before send: the store already names this request dispatching.
      const stored = await world.run(run.id);
      const owner = stored.activations.find(
        (activation) => activation.session?.requestId === turn.requestId,
      );
      if (!owner || owner.session?.dispatchState === "prepared") {
        violations.push(`request ${turn.requestId.slice(0, 8)} sent before it was journaled`);
      }
      const disruption = dying();
      if (!disruption) return;
      if (disruption.landed) {
        // The prompt reached the provider; the backend died before the answer.
        world.provider.deliver(world.provider.session(turn.sessionId), turn);
        lateDeliveries += 1;
      } else if (disruption.lost) {
        world.provider.journal.set(turn.requestId, "lost");
        lostAnswers += 1;
      }
      await die();
    };
    world.provider.beforeObserve = async () => {
      operations += 1;
      if (dying()) await die();
    };

    let current = run;
    for (let step = 0; step < 120; step++) {
      if (["complete", "failed", "cancelled"].includes(current.status)) break;
      let crashed = false;
      const signal = new Promise<void>((resolve) => {
        crash = () => {
          crashed = true;
          resolve();
        };
      });
      const pass = world
        .current()
        .service.advanceNow(run.id)
        .catch(() => null);
      await Promise.race([pass, signal]);
      if (crashed) {
        world.restart();
      } else {
        await world.provider.settle();
      }
      current = await world.run(run.id);
    }

    // No request ran twice; no step or branch ran its original turn twice.
    const deliveries = world.provider.deliveries;
    if (new Set(deliveries).size !== deliveries.length) violations.push("a request ran twice");
    const originals = new Map<string, number>();
    for (const turn of world.provider.turns()) {
      if (turnKind(turn) !== "original") continue;
      const unit = unitOf(turn, world.provider);
      originals.set(unit, (originals.get(unit) ?? 0) + 1);
    }
    for (const [unit, count] of originals) {
      if (count > 1) violations.push(`${unit} ran its original turn ${count} times`);
    }
    if (!["complete", "failed"].includes(current.status)) {
      violations.push(`the run did not end (${current.status})`);
    }
    const latest = (unit: Unit) =>
      current.activations
        .filter((entry) => entry.nodeId === unit.nodeId && entry.branchKey === unit.branchKey)
        .at(-1);
    const completedBranches = scenario.units.filter(
      (unit) => unit.nodeId === "fan" && latest(unit)?.state === "complete",
    );
    for (const unit of scenario.units) {
      const activation = latest(unit);
      const collector = unit.nodeId === "gather";
      if (!activation) {
        // The collector is never created when the run ended before it could be.
        if (!collector || current.status !== "failed") violations.push(`${unit.label} never ran`);
        continue;
      }
      if (activation.state === "complete") {
        const id = activation.outputs.description;
        const verified = id ? await world.artifacts.verify(run.id, id) : { ok: false };
        if (!verified.ok) violations.push(`${unit.label} completed without a verified output`);
        if (unit.script === "fail") violations.push(`${unit.label} completed despite failing`);
        if (collector) {
          // The fan-in received exactly the branches that completed, each verified.
          const collected = activation.inputs.descriptions;
          const ids = Array.isArray(collected) ? collected : [];
          const expected = completedBranches.map((branch) => latest(branch)!.outputs.description);
          if (JSON.stringify([...ids].sort()) !== JSON.stringify([...expected].sort())) {
            violations.push(
              `gather collected ${ids.length} of ${expected.length} completed branches`,
            );
          }
          for (const input of ids) {
            if (!(await world.artifacts.verify(run.id, input)).ok) {
              violations.push("gather collected an output that does not verify");
            }
          }
        }
      } else if (activation.state === "failed") {
        // Too few branches succeeded: the collect policy fails the collector's input.
        const shortfall =
          collector &&
          completedBranches.length === 0 &&
          activation.error?.startsWith("Input descriptions:") === true;
        const explained =
          shortfall ||
          unit.script === "fail" ||
          fired.length > 0 ||
          activation.error?.includes("acceptance could not be confirmed") === true;
        if (!explained) {
          violations.push(`${unit.label} failed without a cause: ${activation.error ?? ""}`);
        }
        if (activation.errorCause === "system-error" && !shortfall) {
          violations.push(`${unit.label} failed as a system error: ${activation.error ?? ""}`);
        }
      } else if (activation.state !== "skipped") {
        violations.push(`${unit.label} ended ${activation.state}`);
      }
    }
    const absentResends = world.provider
      .turns()
      .filter((turn) => turnKind(turn) === "original").length;
    return {
      scenario,
      run: current,
      violations,
      fired,
      absentResends,
      lateDeliveries,
      lostAnswers,
      midFanOutCrashes,
    };
  } finally {
    await world.cleanup();
  }
}

const originalWarn = console.warn;
beforeAll(() => {
  console.warn = () => {};
});
afterAll(() => {
  console.warn = originalWarn;
});

const SEEDS = interleavingSeeds(24);

describe("graph agent activation interleavings", () => {
  const outcomes: Outcome[] = [];
  test.each(SEEDS)(
    "seed %i",
    async (seed) => {
      const outcome = await runScenario(planScenario(seed));
      outcomes.push(outcome);
      if (outcome.violations.length > 0) {
        throw new Error(
          [
            `seed ${seed} broke ${outcome.violations.length} invariant(s).`,
            `Replay: ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=${seed}`,
            `fan-out: ${outcome.scenario.fanOut ? `${outcome.scenario.fanOut.axis} × ${outcome.scenario.fanOut.branches}` : "none"}`,
            `units: ${outcome.scenario.units.map((unit) => `${unit.label}=${unit.script}`).join(", ")}`,
            `proves absence: ${outcome.scenario.provesAbsence}; disruptions: ${outcome.fired.join(", ") || "none"}`,
            `run: ${outcome.run.status} ${outcome.run.error ?? ""}`,
            ...outcome.violations.slice(0, 12).map((violation) => `  - ${violation}`),
          ].join("\n"),
        );
      }
    },
    30_000,
  );

  test("the seeds exercise crashes, late deliveries, lost answers and mid fan-out restarts", () => {
    if (outcomes.length < SEEDS.length || SEEDS.length < 8) return;
    expect(outcomes.filter((outcome) => outcome.fired.length > 0).length).toBeGreaterThan(2);
    expect(outcomes.some((outcome) => outcome.lateDeliveries > 0)).toBe(true);
    expect(outcomes.some((outcome) => outcome.run.status === "complete")).toBe(true);
    const fanOuts = outcomes.filter((outcome) => outcome.scenario.fanOut);
    expect(fanOuts.length).toBeGreaterThan(2);
    expect(fanOuts.filter((outcome) => outcome.midFanOutCrashes > 0).length).toBeGreaterThan(1);
    // Both axes, and a collector that completed after a mid fan-out restart.
    expect(new Set(fanOuts.map((outcome) => outcome.scenario.fanOut!.axis)).size).toBe(2);
    expect(
      fanOuts.some(
        (outcome) =>
          outcome.midFanOutCrashes > 0 &&
          outcome.run.activations.some(
            (activation) => activation.nodeId === "gather" && activation.state === "complete",
          ),
      ),
    ).toBe(true);
  });

  test("a seed replays the same outcome", async () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const first = await runScenario(planScenario(seed));
      const second = await runScenario(planScenario(seed));
      const summary = (outcome: Outcome) =>
        outcome.run.activations.map((activation) => [activation.nodeId, activation.state]);
      expect(summary(second)).toEqual(summary(first));
      expect(second.fired).toEqual(first.fired);
    }
  }, 60_000);
});
