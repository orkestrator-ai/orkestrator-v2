/**
 * Deterministic graph-run control-plane benchmark (skeleton, item 203).
 *
 * Measures what the scheduler costs around the work itself, per pass, as
 * fan-out width and retained history grow: run-row reads and their SQLite
 * row fetches, saves, executor calls (starts, observations) and their
 * concurrency, artifact reads, planning rounds. Pass-through executors, a
 * temporary store and a manual clock: no provider, no wall-clock wait, no
 * timing assertion, so it fits the default suite.
 *
 * Structure follows `multi-review-efficiency.bench.test.ts`: the default run
 * asserts structural gates; `GRAPH_RUN_BENCH_REPORT_ONLY=1` only measures
 * (to compare an older build); `GRAPH_RUN_BENCH_OUT=<file>` writes the
 * content-free result table as JSON. Reproduce with:
 *
 *   GRAPH_RUN_BENCH_OUT=/tmp/graph-run-bench.json \
 *     mise run test:logged -- --name graph-run-bench -- \
 *     bun test --cwd apps/backend ./src/core/graph-run-efficiency.bench.test.ts
 *
 * Later items extend it: real agent executors behind fake providers (204),
 * replication and collect policies (205), loops and gates (206).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { promises as fs } from "node:fs";
import {
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import {
  bindAllRoles,
  compiledPlan,
  graphFanOutTemplate,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import { ManualTime } from "./recurring-test-support.js";
import { storageDatabase } from "./storage-test-support.js";

const REPORT_ONLY = process.env.GRAPH_RUN_BENCH_REPORT_ONLY === "1";
const OUTPUT_PATH = process.env.GRAPH_RUN_BENCH_OUT;
const RUNNING_PASSES = 5;

interface BenchResult {
  width: number;
  retainedRuns: number;
  passes: number;
  /** The pass that admitted the panel. */
  admission: PassCounts;
  /** Mean over the passes that only observed running reviewers. */
  running: PassCounts;
  /** Totals over the whole run, launch to completion. */
  total: PassCounts;
  maxConcurrentStarts: number;
  maxConcurrentObserves: number;
}

interface PassCounts {
  runReads: number;
  /** SQLite rows fetched from the `graph-runs` store. */
  runRowsFetched: number;
  /** Whole-store or per-environment run listings (should stay zero in passes). */
  runListings: number;
  saves: number;
  starts: number;
  observes: number;
  artifactReads: number;
}

const results: BenchResult[] = [];
const worlds: GraphRunWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup();
});

function zero(): PassCounts {
  return {
    runReads: 0,
    runRowsFetched: 0,
    runListings: 0,
    saves: 0,
    starts: 0,
    observes: 0,
    artifactReads: 0,
  };
}

/** Finished runs already in the store: the retained history. */
async function retain(world: GraphRunWorld, count: number, plan: GraphRun["plan"]): Promise<void> {
  const at = "2026-10-29T00:00:00.000Z";
  for (let index = 0; index < count; index++) {
    await world.storage.graphRuns.createGraphRun({
      format: GRAPH_RUN_FORMAT,
      formatVersion: GRAPH_RUN_FORMAT_VERSION,
      id: `retained-${index}`,
      projectId: "p1",
      environmentId: "e1",
      template: { id: plan.template.id, revision: 1, digest: plan.templateDigest },
      plan,
      bindings: { roles: bindAllRoles(plan, 8), params: {}, inputs: {} },
      status: "complete",
      mock: false,
      activations: [],
      rewinds: [],
      loopIterations: {},
      usage: { agentSessions: 0, tokens: 0 },
      revision: 0,
      createdAt: at,
      updatedAt: at,
      finishedAt: at,
    });
  }
}

async function runBenchmark(width: number, retainedRuns: number): Promise<BenchResult> {
  const world = await graphRunWorld();
  worlds.push(world);
  const plan = compiledPlan(graphFanOutTemplate(32));
  await retain(world, retainedRuns, plan);
  const time = new ManualTime(0);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  await service.init();
  const run = await service.create({
    projectId: "p1",
    environmentId: "e1",
    template: { id: plan.template.id, revision: 1, digest: plan.templateDigest },
    plan,
    roles: bindAllRoles(plan, width, ["claude", "codex"]),
    inputs: { target: graphTypeExample(plan, "workspace@1") },
  });

  const graphRuns = world.storage.graphRuns;
  let counts = zero();
  const spies = [
    spyOn(graphRuns, "getGraphRun"),
    spyOn(graphRuns, "saveGraphRun"),
    spyOn(graphRuns, "listAllGraphRuns"),
    spyOn(graphRuns, "listGraphRuns"),
    spyOn(graphRuns, "getGraphArtifact"),
  ];
  const [reads, saves, listAll, listEnvironment, artifactReads] = spies;
  const sqlite = storageDatabase(world.storage).db;
  const query = sqlite.query.bind(sqlite);
  let rowsFetched = 0;
  const observe = spyOn(sqlite, "query").mockImplementation(function <
    Result,
    Params extends SQLQueryBindings | SQLQueryBindings[],
  >(sql: string) {
    const statement = query<Result, Params>(sql);
    if (!/^\s*SELECT\b/i.test(sql) || !/\bFROM\s+store_rows\b/i.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== "get" && property !== "all") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...bindings: unknown[]) => {
          const result = Reflect.apply(target[property], target, bindings) as unknown;
          if (bindings[0] === "graph-runs") {
            rowsFetched += Array.isArray(result) ? result.length : result ? 1 : 0;
          }
          return result;
        };
      },
    });
  });
  const fakes = world.fakes;
  const startsBefore = () => fakes.callsOf("start").length;
  const observesBefore = () => fakes.callsOf("observe").length;
  const measure = async (): Promise<PassCounts> => {
    for (const spy of spies) spy.mockClear();
    rowsFetched = 0;
    const starts = startsBefore();
    const observes = observesBefore();
    time.jump(3_000);
    await service.advanceNow(run.id);
    return {
      runReads: reads!.mock.calls.length,
      runRowsFetched: rowsFetched,
      runListings: listAll!.mock.calls.length + listEnvironment!.mock.calls.length,
      saves: saves!.mock.calls.length,
      starts: startsBefore() - starts,
      observes: observesBefore() - observes,
      artifactReads: artifactReads!.mock.calls.length,
    };
  };
  const add = (into: PassCounts, from: PassCounts) => {
    for (const key of Object.keys(into) as (keyof PassCounts)[]) into[key] += from[key];
  };
  try {
    const total = zero();
    fakes.held.add("review");
    const admission = await measure();
    add(total, admission);
    const running = zero();
    for (let index = 0; index < RUNNING_PASSES; index++) {
      const pass = await measure();
      add(running, pass);
      add(total, pass);
    }
    fakes.held.delete("review");
    let passes = 1 + RUNNING_PASSES;
    for (; passes < 1 + RUNNING_PASSES + 10; passes++) {
      add(total, await measure());
      if ((await graphRuns.getGraphRun(run.id))?.status === "complete") break;
    }
    counts = running;
    for (const key of Object.keys(counts) as (keyof PassCounts)[]) {
      counts[key] = counts[key] / RUNNING_PASSES;
    }
    return {
      width,
      retainedRuns,
      passes: passes + 1,
      admission,
      running: counts,
      total,
      maxConcurrentStarts: Math.max(0, ...fakes.callsOf("start").map((call) => call.concurrent)),
      maxConcurrentObserves: Math.max(
        0,
        ...fakes.callsOf("observe").map((call) => call.concurrent),
      ),
    };
  } finally {
    observe.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
}

describe("graph run control-plane benchmark", () => {
  for (const width of [1, 2, 4, 8, 16, 32]) {
    test(`fan-out of ${width}`, async () => {
      const result = await runBenchmark(width, 0);
      results.push(result);
      if (REPORT_ONLY) return;
      // A pass reads its own row once and never lists the store.
      expect(result.admission.runReads).toBe(1);
      expect(result.running.runReads).toBe(1);
      expect(result.running.runListings).toBe(0);
      // Admission journals once before starting and saves the starts once.
      expect(result.admission.saves).toBeLessThanOrEqual(2);
      expect(result.admission.starts).toBe(width);
      // A pass that only observes unchanged work writes nothing.
      expect(result.running.saves).toBe(0);
      // Each running reviewer is observed once per due pass, never more.
      expect(result.running.observes).toBe(width);
      expect(result.running.artifactReads).toBe(0);
      // The per-operation caps: 4 starting, 8 observing.
      expect(result.maxConcurrentStarts).toBeLessThanOrEqual(4);
      expect(result.maxConcurrentObserves).toBeLessThanOrEqual(8);
    });
  }

  test("retained run history does not change a pass's storage work", async () => {
    const fresh = await runBenchmark(8, 0);
    const retained = await runBenchmark(8, 50);
    results.push(retained);
    if (REPORT_ONLY) return;
    expect(retained.running.runRowsFetched).toBe(fresh.running.runRowsFetched);
    expect(retained.admission.runRowsFetched).toBe(fresh.admission.runRowsFetched);
    expect(retained.running.runListings).toBe(0);
    expect(retained.total.saves).toBe(fresh.total.saves);
  });

  test("records the benchmark table", async () => {
    if (OUTPUT_PATH) await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`);
    expect(results.length).toBeGreaterThan(0);
  });
});
