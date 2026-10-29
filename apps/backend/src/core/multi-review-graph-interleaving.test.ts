/**
 * Interleaving and dispatch-recovery parity for Multi Review on the graph
 * engine (item 301), in the spirit of `review-fanout-interleaving.test.ts`
 * and `graph-node-agent-interleaving.test.ts`.
 *
 * The reviewer fan-out runs on the real graph agent executor (the shared
 * AgentBranchRunner) against a fake provider; the backend dies at a seeded
 * point — after a reviewer's request is journaled `prepared`, at its send
 * (`dispatching`, before or after the prompt reached the provider, whose
 * journal may retire it as lost or which may receive it late), after it is
 * recorded `sent`, at a status read, or in a Multi Review save — and a new
 * backend (run service, executor and Multi Review service) carries on over
 * the same store and provider.
 *
 * Invariants, checked on every seed:
 * - journal before send, at most one delivery per request id, and the
 *   provider is never sent an id it already holds (except a copy that
 *   arrived late after the provider had proved it absent, which it drops);
 * - recovery is proof-based: a request the provider holds is not resent, one
 *   it proves absent is resent under the same id, one it cannot vouch for
 *   (unknown) or retired (lost) is never resent;
 * - every reviewer settles exactly once and the run ends;
 * - the Multi Review record stays valid, its projected revision never moves
 *   back, a completed reviewer or a settled record never changes, and the
 *   settled record matches the run's activations; one run is ever launched.
 *
 * Seeded scenarios run one executor call at a time within a pass, so a seed
 * replays exactly; the "whole panel mid-dispatch" cases overlap the calls and
 * die once every reviewer's send is in flight. The record recovery tests
 * cover a crash before the launch, after it, and a restarted Multi Review
 * service over a running and a settled review.
 *
 * Replay a failure with `ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=<seed>`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GraphRun, NodeActivation } from "@orkestrator/protocol/graphs/run";
import {
  isMultiReviewWorkflow,
  type MultiReviewModelSelection,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { turnSlots, type FakeAgentScript, type FakeAgentTurn } from "./graph-agent-test-support.js";
import { multiReviewGraphRunId } from "./multi-review-graph-engine.js";
import {
  INTERLEAVING_REPORT,
  multiReviewInterleavingWorld,
  type MultiReviewInterleavingWorld,
  type MultiReviewTestProcess,
} from "./multi-review-graph-interleaving-support.js";
import { SeededRandom, interleavingSeeds } from "./review-fanout-interleaving-support.js";

type ReviewerScript = "complete" | "silentOnce" | "restartOnce" | "fail";
const SCRIPTS: readonly ReviewerScript[] = [
  "complete",
  "complete",
  "silentOnce",
  "restartOnce",
  "fail",
];

type DisruptionKind = "prepared" | "dispatching" | "sent" | "observe" | "workflow-save";
const KINDS: readonly DisruptionKind[] = [
  "prepared",
  "dispatching",
  "dispatching",
  "sent",
  "observe",
  "workflow-save",
];

interface Disruption {
  kind: DisruptionKind;
  /** The kind's Nth event (counted over the whole scenario) fires it. */
  atEvent: number;
  /** `dispatching`: whether the prompt reached the provider, now or after the restart. */
  landed?: "no" | "now" | "late";
  /** `dispatching` that did not land: the provider's journal retires the id. */
  lost?: boolean;
  /** `workflow-save`: the save lands before the process dies. */
  saveLanded?: boolean;
}

interface Scenario {
  seed: number;
  reviewers: ReviewerScript[];
  provesAbsence: boolean;
  disruptions: Disruption[];
  /**
   * Overlapping executor calls, and the backend dies once every reviewer's
   * first send is in flight (all journaled `dispatching`); entry N says
   * whether reviewer N's prompt reached the provider.
   */
  panelCrash?: ("no" | "now" | "late")[];
}

const MODELS: readonly MultiReviewModelSelection[] = [
  { agent: "claude", model: "opus" },
  { agent: "claude", model: "sonnet" },
  { agent: "claude", model: "haiku" },
];

function planScenario(seed: number): Scenario {
  const random = new SeededRandom(seed);
  const reviewers = Array.from({ length: random.between(1, 3) }, () => random.pick(SCRIPTS));
  const disruptions = Array.from({ length: random.between(0, 3) }, (): Disruption => {
    const kind = random.pick(KINDS);
    const landed = random.pick(["no", "now", "late"] as const);
    return {
      kind,
      atEvent: random.between(1, kind === "workflow-save" ? 6 : 3),
      ...(kind === "dispatching" ? { landed, lost: landed === "no" && random.chance(0.3) } : {}),
      ...(kind === "workflow-save" ? { saveLanded: random.chance(0.5) } : {}),
    };
  });
  return { seed, reviewers, provesAbsence: random.chance(0.6), disruptions };
}

function turnKind(turn: FakeAgentTurn): "original" | "reminder" | "continuation" {
  if (turn.prompt.includes("Orkestrator has not received your results")) return "reminder";
  if (turn.prompt.includes("Orkestrator restarted while you were working")) return "continuation";
  return "original";
}

/** Panel position (1-based) of a reviewer turn, from its session key. */
function positionOf(turn: FakeAgentTurn): number {
  return Number(/branch=panel\.(\d+)/.exec(turn.sessionKey)?.[1] ?? 0);
}

function scriptFor(scenario: Scenario): FakeAgentScript {
  return async (turn, tools) => {
    const script = scenario.reviewers[positionOf(turn) - 1];
    const original = turnKind(turn) === "original";
    switch (script) {
      case "fail":
        return "error";
      case "silentOnce":
        if (original) return "idle";
        break;
      case "restartOnce":
        if (original) return "restart";
        break;
      default:
        break;
    }
    await tools.call("submit_report", {
      resultKey: turnSlots(turn).report,
      result: INTERLEAVING_REPORT,
    });
    return "idle";
  };
}

interface DispatchCrash {
  requestId: string;
  /** `held`: the provider already held the id (a late copy beat a proved-absent resend). */
  landed: "no" | "now" | "late" | "held";
  lost: boolean;
}

interface Outcome {
  scenario: Scenario;
  workflow: MultiReviewWorkflow;
  run: GraphRun;
  violations: string[];
  fired: string[];
  dispatchCrashes: DispatchCrash[];
  lateDeliveries: number;
  deliveries: number;
}

/** What a settled reviewer record shows for its branch's last activation. */
function expectedReviewerStatus(activation: NodeActivation | undefined): string {
  switch (activation?.state) {
    case "complete":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "cancelled";
  }
}

/** The record without the bookkeeping a lease or save rewrites. */
function content(workflow: MultiReviewWorkflow): string {
  const {
    updatedAt: _updated,
    backendRevision: _revision,
    controllerFence: _fence,
    ...rest
  } = workflow;
  return JSON.stringify(rest);
}

function never(): Promise<never> {
  return new Promise(() => {});
}

async function runScenario(scenario: Scenario): Promise<Outcome> {
  const world: MultiReviewInterleavingWorld = await multiReviewInterleavingWorld({
    script: scriptFor(scenario),
    serialCalls: scenario.panelCrash === undefined,
  });
  const violations: string[] = [];
  const fired: string[] = [];
  const dispatchCrashes: DispatchCrash[] = [];
  let lateDeliveries = 0;
  try {
    world.provider.provesAbsence = scenario.provesAbsence;
    world.fakes.scripts.set("consolidate", ({ port }) =>
      port === "report" ? INTERLEAVING_REPORT : undefined,
    );
    world.start();
    const started = await world.startReview({
      reviewers: MODELS.slice(0, scenario.reviewers.length),
    });
    const workflowId = started.id;
    const runId = multiReviewGraphRunId(workflowId);

    // Disruptions fire on the Nth event of their kind.
    const pending = [...scenario.disruptions];
    const counts = new Map<DisruptionKind, number>();
    const take = (kind: DisruptionKind): Disruption | undefined => {
      const count = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, count);
      const index = pending.findIndex(
        (disruption) => disruption.kind === kind && disruption.atEvent <= count,
      );
      return index < 0 ? undefined : pending.splice(index, 1)[0];
    };
    const kill = (label: string) => {
      fired.push(label);
      world.current().kill();
    };
    const late: { turn: FakeAgentTurn; afterStep: number }[] = [];
    let step = 0;
    /** Lands (or not) one send the backend dies in, as `landed` says. */
    const dieSending = (turn: FakeAgentTurn, wanted: "no" | "now" | "late", lost: boolean) => {
      const landed = world.provider.journal.has(turn.requestId) ? "held" : wanted;
      const isLost = landed === "no" && lost;
      dispatchCrashes.push({ requestId: turn.requestId, landed, lost: isLost });
      if (landed === "now") {
        // The prompt reached the provider; the backend died before the answer.
        world.provider.deliver(world.provider.session(turn.sessionId), turn);
      } else if (landed === "late") {
        late.push({ turn, afterStep: step });
      } else if (isLost) {
        world.provider.journal.set(turn.requestId, "lost");
      }
      return `dispatching(${landed}${isLost ? ",lost" : ""})`;
    };
    const panelArrivals: FakeAgentTurn[] = [];

    world.provider.beforeSend = async (turn) => {
      // Journal before send: the store already names this request dispatching.
      const stored = await world.run(runId);
      const owner = stored?.activations.find(
        (activation) => activation.session?.requestId === turn.requestId,
      );
      if (!owner || owner.session?.dispatchState === "prepared") {
        violations.push(`request ${turn.requestId.slice(0, 8)} sent before it was journaled`);
      }
      const panel = scenario.panelCrash;
      if (panel && fired.length === 0) {
        // Every reviewer's first send waits here until the last one arrives.
        panelArrivals.push(turn);
        if (panelArrivals.length < panel.length) await never();
        const labels = panelArrivals.map((arrival) =>
          dieSending(arrival, panel[positionOf(arrival) - 1] ?? "no", false),
        );
        kill(`panel[${labels.join(",")}]`);
        await never();
      }
      const disruption = take("dispatching");
      if (!disruption) return;
      kill(dieSending(turn, disruption.landed ?? "no", disruption.lost === true));
      await never();
    };
    world.provider.beforeObserve = async () => {
      if (!take("observe")) return;
      kill("observe");
      await never();
    };
    const seenStates = new Set<string>();
    world.hooks.afterRunSave = (run) => {
      let crash: string | undefined;
      for (const activation of run.activations) {
        const session = activation.session;
        if (activation.nodeId !== "review" || !session?.requestId) continue;
        const state = session.dispatchState;
        if (state !== "prepared" && state !== "sent") continue;
        const key = `${session.requestId}:${state}`;
        if (seenStates.has(key)) continue;
        seenStates.add(key);
        if (!crash && take(state)) crash = state;
      }
      if (!crash) return false;
      kill(crash);
      return true;
    };
    let crashAfterLanding = false;
    world.hooks.workflowSave = (_workflow, landed) => {
      if (landed) {
        if (!crashAfterLanding) return false;
        crashAfterLanding = false;
        kill("workflow-save(landed)");
        return true;
      }
      const disruption = take("workflow-save");
      if (!disruption) return false;
      if (disruption.saveLanded) {
        crashAfterLanding = true;
        return false;
      }
      kill("workflow-save");
      return true;
    };

    // Monotonic record checks across every observation.
    let lastProjected = -1;
    const completed = new Map<string, string>();
    let settledContent: string | undefined;
    const observe = (record: MultiReviewWorkflow) => {
      if (!isMultiReviewWorkflow(record)) violations.push("the record is not a valid workflow");
      const projected = record.graphRun?.projectedRevision ?? -1;
      if (projected < lastProjected) {
        violations.push(`the projected revision moved back (${lastProjected} → ${projected})`);
      }
      lastProjected = Math.max(lastProjected, projected);
      for (const reviewer of record.reviewers) {
        const previous = completed.get(reviewer.id);
        const now = JSON.stringify({ status: reviewer.status, report: reviewer.report });
        if (previous !== undefined && previous !== now) {
          violations.push(`completed reviewer ${reviewer.id} changed to ${reviewer.status}`);
        }
        if (reviewer.status === "completed") completed.set(reviewer.id, now);
      }
      if (settledContent !== undefined && content(record) !== settledContent) {
        violations.push("a settled record changed");
      }
      if (record.graphRun?.settled) settledContent ??= content(record);
    };

    /** Runs `work` on `process`; true when the process died during it. */
    const died = async (process: MultiReviewTestProcess, work: () => Promise<unknown>) => {
      await Promise.race([work().catch(() => undefined), process.died]);
      if (process.alive) return false;
      await world.restart(workflowId);
      return true;
    };

    let record = started;
    for (step = 0; step < 160; step++) {
      const process = world.current();
      await process.ready;
      if (await died(process, () => process.service.advanceNow(workflowId))) continue;
      record = await world.workflow(workflowId);
      observe(record);
      if (record.graphRun?.settled) break;
      if (await world.run(runId)) {
        if (await died(process, () => process.graphRuns.advanceNow(runId))) continue;
        await world.provider.settle();
      }
      // A prompt that reached the provider only after the backend restarted.
      // The provider runs an id once: a copy of one it already holds is dropped.
      for (const entry of late.filter((candidate) => candidate.afterStep < step)) {
        late.splice(late.indexOf(entry), 1);
        if (world.provider.journal.has(entry.turn.requestId)) continue;
        world.provider.deliver(world.provider.session(entry.turn.sessionId), entry.turn);
        lateDeliveries += 1;
        await world.provider.settle();
      }
    }
    const run = (await world.run(runId))!;

    // At most one delivery per request id, and nothing re-sent that the
    // provider already held.
    const deliveries = world.provider.deliveries;
    if (new Set(deliveries).size !== deliveries.length) violations.push("a request ran twice");
    // The one legitimate duplicate: a copy that reached the provider late,
    // after it had proved the id absent and the backend resent it under the
    // same id. The provider drops the second; the turn runs once.
    const lateAfterAbsence = scenario.provesAbsence
      ? dispatchCrashes.filter((crash) => crash.landed === "late").length
      : 0;
    if (world.provider.duplicateDeliveries > lateAfterAbsence) {
      violations.push(`${world.provider.duplicateDeliveries} send(s) of an id the provider held`);
    }
    // No session ran its original turn twice.
    const originals = new Map<string, number>();
    for (const turn of world.provider.turns()) {
      if (turnKind(turn) !== "original") continue;
      originals.set(turn.sessionKey, (originals.get(turn.sessionKey) ?? 0) + 1);
    }
    for (const [key, count] of originals) {
      if (count > 1) violations.push(`${key} ran its original turn ${count} times`);
    }
    // Proof-based recovery of every request the backend died sending.
    for (const crash of dispatchCrashes) {
      const sent = deliveries.filter((id) => id === crash.requestId).length;
      const id = crash.requestId.slice(0, 8);
      if (crash.landed !== "no" && sent !== 1) {
        violations.push(`request ${id} reached the provider but ran ${sent} times`);
      }
      if (crash.lost && sent !== 0) violations.push(`lost request ${id} was resent`);
      if (crash.landed === "no" && !crash.lost && !scenario.provesAbsence && sent !== 0) {
        violations.push(`request ${id} was resent blindly on an unknown answer`);
      }
      if (crash.landed === "no" && !crash.lost && scenario.provesAbsence && sent !== 1) {
        violations.push(`request ${id} proved absent was sent ${sent} times, not once`);
      }
    }

    // Every reviewer settled exactly once and the run ended.
    if (!["complete", "failed"].includes(run.status)) {
      violations.push(`the run did not end (${run.status})`);
    }
    if (!record.graphRun?.settled) violations.push(`the record did not settle (${record.phase})`);
    scenario.reviewers.forEach((script, index) => {
      const branch = `panel.${index + 1}`;
      const activations = run.activations.filter(
        (activation) => activation.nodeId === "review" && activation.branchKey === branch,
      );
      const last = activations.at(-1);
      const complete = activations.filter((activation) => activation.state === "complete");
      if (complete.length > 1) violations.push(`${branch} completed ${complete.length} times`);
      if (!last || !["complete", "failed"].includes(last.state)) {
        violations.push(`${branch} ended ${last?.state ?? "never started"}`);
      }
      if (script === "fail" && last?.state === "complete") {
        violations.push(`${branch} completed despite failing`);
      }
      if (last?.state === "failed" && script !== "fail" && fired.length === 0) {
        violations.push(`${branch} failed without a cause: ${last.error ?? ""}`);
      }
      const reviewer = record.reviewers[index];
      if (reviewer?.status !== expectedReviewerStatus(last)) {
        violations.push(
          `reviewer ${index + 1} shows ${reviewer?.status} for a ${last?.state} activation`,
        );
      }
    });
    // The settled record matches the run.
    if (record.graphRun?.projectedRevision !== run.revision) {
      violations.push("the settled record was not projected from the final run");
    }
    const expectedPhase =
      run.status === "complete" && record.consolidatedReport ? "ready" : "failed";
    if (record.phase !== expectedPhase) {
      violations.push(`the record ended ${record.phase}, not ${expectedPhase}`);
    }
    // A backend restarting over the settled review changes nothing.
    const storedRevision = await world.storedRevision(workflowId);
    const fresh = await world.restart(workflowId);
    await fresh.service.advanceNow(workflowId);
    if ((await world.storedRevision(workflowId)) !== storedRevision) {
      violations.push("a restart over the settled record saved it");
    }
    observe(await world.workflow(workflowId));
    if (world.createdRuns.length !== 1 || world.createdRuns[0] !== runId) {
      violations.push(`launched ${world.createdRuns.length} runs`);
    }
    return {
      scenario,
      workflow: record,
      run,
      violations,
      fired,
      dispatchCrashes,
      lateDeliveries,
      deliveries: deliveries.length,
    };
  } finally {
    await world.cleanup();
  }
}

function report(outcome: Outcome): string {
  const { scenario } = outcome;
  return [
    `seed ${scenario.seed} broke ${outcome.violations.length} invariant(s).`,
    `Replay: ORKESTRATOR_FANOUT_INTERLEAVING_SEEDS=${scenario.seed}`,
    `reviewers: ${scenario.reviewers.join(", ")}; proves absence: ${scenario.provesAbsence}`,
    `disruptions fired: ${outcome.fired.join(", ") || "none"}`,
    `run: ${outcome.run.status} ${outcome.run.error ?? ""}; record: ${outcome.workflow.phase}`,
    ...outcome.violations.slice(0, 12).map((violation) => `  - ${violation}`),
  ].join("\n");
}

const originalWarn = console.warn;
beforeAll(() => {
  console.warn = () => {};
});
afterAll(() => {
  console.warn = originalWarn;
});

const SEEDS = interleavingSeeds(12);

describe("graph-engine Multi Review reviewer interleavings", () => {
  const outcomes: Outcome[] = [];
  test.each(SEEDS)(
    "seed %i",
    async (seed) => {
      const outcome = await runScenario(planScenario(seed));
      outcomes.push(outcome);
      if (outcome.violations.length > 0) throw new Error(report(outcome));
    },
    30_000,
  );

  test("the seeds exercise crashes, late deliveries and lost answers", () => {
    if (outcomes.length < SEEDS.length || SEEDS.length < 8) return;
    expect(outcomes.filter((outcome) => outcome.fired.length > 0).length).toBeGreaterThan(3);
    expect(outcomes.some((outcome) => outcome.dispatchCrashes.length > 0)).toBe(true);
    expect(outcomes.some((outcome) => outcome.workflow.phase === "ready")).toBe(true);
  });

  test("a seed replays the same outcome", async () => {
    const summary = (outcome: Outcome) => ({
      activations: outcome.run.activations.map((activation) => [activation.key, activation.state]),
      reviewers: outcome.workflow.reviewers.map((reviewer) => reviewer.status),
      phase: outcome.workflow.phase,
      fired: outcome.fired,
      deliveries: outcome.deliveries,
    });
    for (const seed of SEEDS.slice(0, 2)) {
      const first = await runScenario(planScenario(seed));
      const second = await runScenario(planScenario(seed));
      expect(summary(second)).toEqual(summary(first));
    }
  }, 60_000);
});

/** One crash per dispatch state the bespoke suites cover, over a two-reviewer panel. */
const NAMED: { name: string; provesAbsence: boolean; disruption: Disruption }[] = [
  { name: "prepared", provesAbsence: true, disruption: { kind: "prepared", atEvent: 1 } },
  {
    name: "dispatching, never arrived, absence proved",
    provesAbsence: true,
    disruption: { kind: "dispatching", atEvent: 1, landed: "no" },
  },
  {
    name: "dispatching, never arrived, answer unknown",
    provesAbsence: false,
    disruption: { kind: "dispatching", atEvent: 1, landed: "no" },
  },
  {
    name: "dispatching, retired as lost",
    provesAbsence: true,
    disruption: { kind: "dispatching", atEvent: 1, landed: "no", lost: true },
  },
  {
    name: "dispatching, arrived before the crash",
    provesAbsence: false,
    disruption: { kind: "dispatching", atEvent: 2, landed: "now" },
  },
  {
    name: "dispatching, arrived after the restart, absence proved",
    provesAbsence: true,
    disruption: { kind: "dispatching", atEvent: 1, landed: "late" },
  },
  {
    name: "dispatching, arrived after the restart, answer unknown",
    provesAbsence: false,
    disruption: { kind: "dispatching", atEvent: 1, landed: "late" },
  },
  { name: "sent", provesAbsence: false, disruption: { kind: "sent", atEvent: 1 } },
  { name: "status read", provesAbsence: false, disruption: { kind: "observe", atEvent: 2 } },
  {
    name: "Multi Review save, before it landed",
    provesAbsence: true,
    disruption: { kind: "workflow-save", atEvent: 2, saveLanded: false },
  },
  {
    name: "Multi Review save, after it landed",
    provesAbsence: true,
    disruption: { kind: "workflow-save", atEvent: 3, saveLanded: true },
  },
];

describe("a backend that dies at each reviewer dispatch state", () => {
  test.each(NAMED.map((entry, index) => [entry.name, index] as const))(
    "%s",
    async (_name, index) => {
      const entry = NAMED[index]!;
      const outcome = await runScenario({
        seed: 1_000 + index,
        reviewers: ["complete", "complete"],
        provesAbsence: entry.provesAbsence,
        disruptions: [entry.disruption],
      });
      if (outcome.violations.length > 0) throw new Error(report(outcome));
      expect(outcome.fired).toHaveLength(1);
      if (entry.disruption.kind === "dispatching") expect(outcome.dispatchCrashes).toHaveLength(1);
      // A crash that leaves a request recoverable ends with every reviewer's report.
      const unrecoverable =
        entry.disruption.lost === true ||
        (entry.disruption.landed === "no" && !entry.provesAbsence);
      if (!unrecoverable) {
        expect(outcome.workflow.phase).toBe("ready");
        expect(outcome.workflow.reviewers.map((reviewer) => reviewer.status)).toEqual([
          "completed",
          "completed",
        ]);
      }
    },
    30_000,
  );
});

describe("a backend that dies with the whole panel mid-dispatch", () => {
  const cases: { name: string; provesAbsence: boolean; panel: ("no" | "now" | "late")[] }[] = [
    { name: "one prompt landed, one proved absent", provesAbsence: true, panel: ["now", "no"] },
    { name: "one prompt landed, one unknown", provesAbsence: false, panel: ["no", "now"] },
    {
      name: "three prompts: late, absent, landed",
      provesAbsence: true,
      panel: ["late", "no", "now"],
    },
  ];
  test.each(cases.map((entry, index) => [entry.name, index] as const))(
    "%s",
    async (_name, index) => {
      const entry = cases[index]!;
      const outcome = await runScenario({
        seed: 2_000 + index,
        reviewers: entry.panel.map(() => "complete"),
        provesAbsence: entry.provesAbsence,
        disruptions: [],
        panelCrash: entry.panel,
      });
      if (outcome.violations.length > 0) throw new Error(report(outcome));
      expect(outcome.dispatchCrashes).toHaveLength(entry.panel.length);
      // A reviewer whose prompt never arrived and whose provider cannot prove
      // it is the one reviewer left without a report.
      expect(outcome.workflow.reviewers.map((reviewer) => reviewer.status)).toEqual(
        entry.panel.map((landed) =>
          landed === "no" && !entry.provesAbsence ? "failed" : "completed",
        ),
      );
      expect(outcome.workflow.phase).toBe("ready");
    },
    30_000,
  );
});

// ------------------------------------------------------------ record recovery

async function recordWorld(): Promise<MultiReviewInterleavingWorld> {
  const world = await multiReviewInterleavingWorld({
    script: scriptFor({
      seed: 0,
      reviewers: ["silentOnce", "complete"],
      provesAbsence: true,
      disruptions: [],
    }),
  });
  world.fakes.scripts.set("consolidate", ({ port }) =>
    port === "report" ? INTERLEAVING_REPORT : undefined,
  );
  return world;
}

/** Multi Review passes, then graph passes, on the current process until `until` holds. */
async function drive(
  world: MultiReviewInterleavingWorld,
  workflowId: string,
  until: (workflow: MultiReviewWorkflow) => boolean,
): Promise<MultiReviewWorkflow> {
  const runId = multiReviewGraphRunId(workflowId);
  for (let pass = 0; pass < 60; pass++) {
    const process = world.current();
    await process.service.advanceNow(workflowId);
    const record = await world.workflow(workflowId);
    if (until(record)) return record;
    if (await world.run(runId)) await process.graphRuns.advanceNow(runId);
    await world.provider.settle();
  }
  throw new Error("the review did not reach the expected state");
}

describe("graph-engine Multi Review record recovery", () => {
  test("a backend that died between the record and the launch: the next one launches one run", async () => {
    const world = await recordWorld();
    try {
      world.start();
      const started = await world.startReview();
      const runId = multiReviewGraphRunId(started.id);
      expect(started.graphRun).toEqual({ runId });
      expect(world.createdRuns).toEqual([]);

      // A backend whose graph runtime is not up yet leaves the record alone.
      world.graphRuntimeAvailable = false;
      const unavailable = await world.restart(started.id);
      const before = await world.storedRevision(started.id);
      await unavailable.service.advanceNow(started.id);
      expect(world.createdRuns).toEqual([]);
      expect(await world.storedRevision(started.id)).toBe(before);
      expect(await world.workflow(started.id)).toMatchObject({ graphRun: { runId } });

      world.graphRuntimeAvailable = true;
      const next = await world.restart(started.id);
      await next.service.advanceNow(started.id);
      expect(world.createdRuns).toEqual([runId]);
      expect(await world.run(runId)).not.toBeNull();
      // A run that shows nothing new yet costs no save.
      const launched = await world.workflow(started.id);
      expect(launched.graphRun?.runId).toBe(runId);
      expect(launched.phase).toBe("preparing");
      expect(isMultiReviewWorkflow(launched)).toBe(true);

      // Another restart finds the run; it never launches a second.
      await world.restart(started.id);
      const settled = await drive(world, started.id, (record) => record.graphRun?.settled === true);
      expect(world.createdRuns).toEqual([runId]);
      expect(settled.phase).toBe("ready");
      expect(settled.reviewers.map((reviewer) => reviewer.status)).toEqual([
        "completed",
        "completed",
      ]);
    } finally {
      await world.cleanup();
    }
  }, 30_000);

  test("a backend that died after the launch, before the record showed it, re-projects without relaunching", async () => {
    const world = await recordWorld();
    try {
      const first = world.start();
      const started = await world.startReview();
      const runId = multiReviewGraphRunId(started.id);
      // The first pass launches the run; nothing the record shows changed yet.
      await first.service.advanceNow(started.id);
      expect(world.createdRuns).toEqual([runId]);
      expect((await world.workflow(started.id)).graphRun?.projectedRevision).toBeUndefined();

      // Dies before its next pass: the next backend finds the run.
      const second = await world.restart(started.id);
      await second.service.advanceNow(started.id);
      expect(world.createdRuns).toEqual([runId]);

      // Dies in its first projection save, before it lands.
      world.hooks.workflowSave = (_workflow, landed) => !landed;
      for (let pass = 0; pass < 20 && second.alive; pass++) {
        await Promise.race([
          second.graphRuns.advanceNow(runId).catch(() => undefined),
          second.died,
        ]);
        if (!second.alive) break;
        await world.provider.settle();
        await Promise.race([
          second.service.advanceNow(started.id).catch(() => undefined),
          second.died,
        ]);
      }
      expect(second.alive).toBe(false);
      expect((await world.workflow(started.id)).graphRun?.projectedRevision).toBeUndefined();

      world.hooks.workflowSave = undefined;
      const third = await world.restart(started.id);
      await third.service.advanceNow(started.id);
      const run = (await world.run(runId))!;
      expect((await world.workflow(started.id)).graphRun?.projectedRevision).toBe(run.revision);
      const settled = await drive(world, started.id, (record) => record.graphRun?.settled === true);
      expect(settled.phase).toBe("ready");
      expect(world.createdRuns).toEqual([runId]);
    } finally {
      await world.cleanup();
    }
  }, 30_000);

  test("a restarted Multi Review service resumes from the stored projected revision and never regresses a settled record", async () => {
    const world = await recordWorld();
    try {
      world.start();
      const started = await world.startReview();
      const runId = multiReviewGraphRunId(started.id);
      await drive(world, started.id, (record) => record.phase === "reviewing");
      // Project the run's current revision, then restart.
      await world.current().service.advanceNow(started.id);
      const midReview = await world.workflow(started.id);
      expect(midReview.graphRun?.projectedRevision).toBe((await world.run(runId))!.revision);
      const revision = await world.storedRevision(started.id);
      const restarted = await world.restart(started.id);
      // The new process has no memory of the revision; the record's own
      // projected revision spares it a projection and a save.
      await restarted.service.advanceNow(started.id);
      expect(await world.storedRevision(started.id)).toBe(revision);
      expect(content(await world.workflow(started.id))).toBe(content(midReview));

      const settled = await drive(world, started.id, (record) => record.graphRun?.settled === true);
      expect(settled.phase).toBe("ready");
      const settledRevision = await world.storedRevision(started.id);

      // A later save of the run (its revision moves) and a restart change nothing.
      const run = (await world.run(runId))!;
      await world.storage.graphRuns.saveGraphRun(run, run.revision);
      const fresh = await world.restart(started.id);
      await fresh.service.advanceNow(started.id);
      await fresh.service.advanceNow(started.id);
      expect(await world.storedRevision(started.id)).toBe(settledRevision);
      expect(content(await world.workflow(started.id))).toBe(content(settled));
      expect(world.createdRuns).toEqual([runId]);
    } finally {
      await world.cleanup();
    }
  }, 30_000);
});

// Every seed above runs the template's built-in reviewer prompt; this one
// pins that a reviewer reaches dispatch and completes on the sealed package.
test("the built-in reviewer prompt reaches dispatch on a sealed package", async () => {
  const world = await multiReviewInterleavingWorld({
    script: scriptFor({ seed: 0, reviewers: ["complete"], provesAbsence: true, disruptions: [] }),
  });
  try {
    world.fakes.scripts.set("consolidate", ({ port }) =>
      port === "report" ? INTERLEAVING_REPORT : undefined,
    );
    const process = world.start();
    await process.ready;
    const started = await world.startReview({ reviewers: [MODELS[0]!] });
    let record = started;
    for (let pass = 0; pass < 20 && !record.graphRun?.settled; pass++) {
      await process.service.advanceNow(started.id);
      await process.graphRuns.advanceNow(multiReviewGraphRunId(started.id)).catch(() => null);
      await world.provider.settle();
      record = await world.workflow(started.id);
    }
    expect(record.reviewers[0]?.error).toBeUndefined();
    expect(record.reviewers[0]?.status).toBe("completed");
  } finally {
    await world.cleanup();
  }
}, 30_000);
