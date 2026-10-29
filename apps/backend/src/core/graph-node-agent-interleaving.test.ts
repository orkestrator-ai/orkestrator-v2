/**
 * Seeded restart interleavings for graph agent activations (item 204), in the
 * spirit of `review-fanout-interleaving.test.ts`: each seed picks a graph of
 * one to three independent agent steps, a script per step (completes, ends
 * without its result, is cut short by a provider restart, fails), whether the
 * provider can prove an id never arrived, and where the backend dies — at a
 * send (before or after the prompt reached the provider, whose journal may
 * then retire the id as lost) or at a status read. A crash leaves every
 * pending call of the dead process unanswered; a new process starts from the
 * stored run, over the same provider (the environment outlives the backend).
 *
 * Invariants, checked on every seed:
 * - journal before send: a prompt is sent only while the stored activation
 *   names that request `dispatching` (or later);
 * - no request runs twice, and no step runs its original turn twice;
 * - every run ends; a completed step's outputs exist and verify;
 * - a step fails only for a reason its script or a disruption explains.
 *
 * Replay a failure with `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=<seed>`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import {
  TEST_DESCRIPTION,
  TEST_TICKET,
  graphAgentWorld,
  turnSlots,
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

interface Scenario {
  seed: number;
  steps: { id: string; script: StepScript }[];
  provesAbsence: boolean;
  /** Provider operations (sends and status reads) after which the backend dies. */
  crashes: { atOperation: number; landed: boolean; lost: boolean }[];
}

function planScenario(seed: number): Scenario {
  const random = new SeededRandom(seed);
  const count = random.between(1, 3);
  const steps = Array.from({ length: count }, (_, index) => ({
    id: `step-${index + 1}`,
    script: random.pick(SCRIPTS),
  }));
  const crashes = Array.from({ length: random.between(0, 2) }, () => ({
    atOperation: random.between(1, 12),
    landed: random.chance(0.5),
    lost: random.chance(0.25),
  })).sort((left, right) => left.atOperation - right.atOperation);
  return { seed, steps, provesAbsence: random.chance(0.6), crashes };
}

function template(scenario: Scenario): GraphTemplateV1 {
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
    nodes: scenario.steps.map((step) => ({
      id: step.id,
      kind: "agent",
      role: "worker",
      capabilities: { profile: "observer" },
      workspaceAccess: "none",
      prompt: { template: `Describe (${step.id}).\n\n{{> input.ticket}}\n` },
      inputs: [{ name: "ticket", type: "ticket@1" }],
      outputs: [{ name: "description", type: "pr-description@1" }],
      onFailure: "skip",
    })),
    edges: scenario.steps.map((step) => ({
      id: `ticket-${step.id}`,
      from: { input: "ticket" },
      to: { node: step.id, port: "ticket" },
    })),
    limits: { maxAgentSessions: 20, maxConcurrentAgents: 3 },
  } as GraphTemplateV1;
}

function turnKind(turn: FakeAgentTurn): "original" | "reminder" | "continuation" {
  if (turn.prompt.includes("Orkestrator has not received your results")) return "reminder";
  if (turn.prompt.includes("Orkestrator restarted while you were working")) return "continuation";
  return "original";
}

function stepOf(turn: FakeAgentTurn): string {
  return /Describe \((step-\d)\)/.exec(turn.prompt)?.[1] ?? "unknown";
}

function scriptFor(scenario: Scenario): FakeAgentScript {
  return async (turn, tools) => {
    const step = scenario.steps.find((candidate) => candidate.id === stepOf(turn));
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
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const world: GraphAgentWorld = await graphAgentWorld({ script: scriptFor(scenario) });
  const violations: string[] = [];
  const fired: string[] = [];
  let lateDeliveries = 0;
  let lostAnswers = 0;
  try {
    world.provider.provesAbsence = scenario.provesAbsence;
    world.start();
    const run = await world.launch(template(scenario), { ticket: TEST_TICKET });
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

    // No request ran twice; no step ran its original turn twice.
    const deliveries = world.provider.deliveries;
    if (new Set(deliveries).size !== deliveries.length) violations.push("a request ran twice");
    const originals = new Map<string, number>();
    for (const turn of world.provider.turns()) {
      if (turnKind(turn) !== "original") continue;
      originals.set(stepOf(turn), (originals.get(stepOf(turn)) ?? 0) + 1);
    }
    for (const [step, count] of originals) {
      if (count > 1) violations.push(`${step} ran its original turn ${count} times`);
    }
    if (!["complete", "failed"].includes(current.status)) {
      violations.push(`the run did not end (${current.status})`);
    }
    for (const step of scenario.steps) {
      const activation = current.activations.filter((entry) => entry.nodeId === step.id).at(-1);
      if (!activation) {
        violations.push(`${step.id} never ran`);
        continue;
      }
      if (activation.state === "complete") {
        const id = activation.outputs.description;
        const verified = id ? await world.artifacts.verify(run.id, id) : { ok: false };
        if (!verified.ok) violations.push(`${step.id} completed without a verified output`);
        if (step.script === "fail") violations.push(`${step.id} completed despite failing`);
      } else if (activation.state === "failed") {
        const explained =
          step.script === "fail" ||
          fired.length > 0 ||
          activation.error?.includes("acceptance could not be confirmed") === true;
        if (!explained) {
          violations.push(`${step.id} failed without a cause: ${activation.error ?? ""}`);
        }
        if (activation.errorCause === "system-error") {
          violations.push(`${step.id} failed as a system error: ${activation.error ?? ""}`);
        }
      } else if (activation.state !== "skipped") {
        violations.push(`${step.id} ended ${activation.state}`);
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

const SEEDS = interleavingSeeds(16);

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
            `steps: ${outcome.scenario.steps.map((step) => `${step.id}=${step.script}`).join(", ")}`,
            `proves absence: ${outcome.scenario.provesAbsence}; disruptions: ${outcome.fired.join(", ") || "none"}`,
            `run: ${outcome.run.status} ${outcome.run.error ?? ""}`,
            ...outcome.violations.slice(0, 12).map((violation) => `  - ${violation}`),
          ].join("\n"),
        );
      }
    },
    30_000,
  );

  test("the seeds exercise crashes, late deliveries and lost answers", () => {
    if (outcomes.length < SEEDS.length || SEEDS.length < 8) return;
    expect(outcomes.filter((outcome) => outcome.fired.length > 0).length).toBeGreaterThan(2);
    expect(outcomes.some((outcome) => outcome.lateDeliveries > 0)).toBe(true);
    expect(outcomes.some((outcome) => outcome.run.status === "complete")).toBe(true);
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
