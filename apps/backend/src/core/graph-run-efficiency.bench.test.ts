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
 * The Multi Review shape (item 301) runs the graph-engine Multi Review
 * template and holds it to the bespoke engine's budgets where it can.
 *
 * Later items extend it: real agent executors behind fake providers (204),
 * replication and collect policies (205), loops and gates (206).
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  GRAPH_RUN_FORMAT,
  GRAPH_RUN_FORMAT_VERSION,
  isGraphRunTerminal,
  type GraphRun,
} from "@orkestrator/protocol/graphs/run";
import { loadGraphAgentInputs } from "./graph-agent-prompt.js";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import {
  bindAllRoles,
  compiledPlan,
  FakeGraphExecutors,
  graphFanOutTemplate,
  graphRunWorld,
  graphTypeExample,
  type GraphRunWorld,
} from "./graph-run-executor-test-support.js";
import { GraphNodeExecutorRegistry, type GraphNodeExecutor } from "./graph-run-executors.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import { multiReviewGraphEngineTemplate } from "./multi-review-graph-template.js";
import { ManualTime } from "./recurring-test-support.js";
import { runCommand } from "./shell.js";
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
});

// ------------------------------------------------------------ Multi Review shape

/**
 * The Multi Review shape (item 301): the compiled graph-engine Multi Review
 * template (prepare, seal one `review-package@2` reference artifact, a
 * reviewer panel, consolidation, the findings gate) through real passes.
 *
 * Agents are pass-through, but every agent start first runs the real
 * `loadGraphAgentInputs` — the one function the real agent host calls, once
 * per activation, to verify and load its inputs before it builds the prompt —
 * so the counted verifications are the ones a real run performs. The package
 * is sealed as a real file in a Git worktree, so a verification hashes it.
 */
interface MultiReviewBenchResult {
  shape: "multi-review";
  width: number;
  retainedRuns: number;
  /** Passes from launch until every reviewer runs (prepare, seal, admit the panel). */
  admissionPasses: number;
  /** Passes after the panel was released until the run completed. */
  settlingPasses: number;
  /** Mean over the passes that only observed the running panel. */
  running: MultiReviewPassCounts;
  total: MultiReviewPassCounts;
  /** Verifications (SHA-256 of the sealed file) of the one package generation, by consumer. */
  packageVerifications: { reviewers: number; consolidation: number; total: number };
  /** Consumer checks of the package (envelope checks; a permit answers most without hashing). */
  packageChecks: { reviewers: number; consolidation: number; total: number };
  /** Distinct package generations sealed (no rewind here: one). */
  packageGenerations: number;
}

interface MultiReviewPassCounts extends PassCounts {
  verifications: number;
  /** Per-run artifact listings (`listGraphArtifacts`, `graphArtifactUsage`). */
  artifactListings: number;
  /** The most `graph-runs` rows one statement returned: 1 unless something scans. */
  largestRunFetch: number;
}

const multiReviewResults: MultiReviewBenchResult[] = [];

function zeroMultiReview(): MultiReviewPassCounts {
  return { ...zero(), verifications: 0, artifactListings: 0, largestRunFetch: 0 };
}

/** The fake agent executor, verifying and loading its inputs on start as the real host does. */
function verifyingAgentExecutor(fakes: FakeGraphExecutors): GraphNodeExecutor {
  const scratch = new GraphNodeExecutorRegistry();
  fakes.register(scratch);
  const fake = scratch.resolve("agent");
  if (!fake) throw new Error("the fake agent executor is missing");
  return {
    ...fake,
    kind: "agent",
    async start(context) {
      if (context.node.kind === "agent") {
        await loadGraphAgentInputs(
          context.run,
          context.node,
          context.activation,
          context.artifacts,
        );
      }
      return fake.start(context);
    },
  };
}

async function runMultiReviewBenchmark(
  width: number,
  retainedRuns: number,
): Promise<MultiReviewBenchResult> {
  const world = await graphRunWorld();
  worlds.push(world);
  const worktree = path.join(world.dataDir, "worktree");
  await fs.mkdir(worktree);
  await runCommand("git", ["init", "-q", "-b", "main", worktree]);
  await world.storage.addEnvironment(
    graphEnvironmentFixture({ id: "review-env", order: 2, worktreePath: worktree }),
  );
  const plan = compiledPlan(multiReviewGraphEngineTemplate({ targetBranch: "main" }));
  await retain(world, retainedRuns, plan);
  const fakes = world.fakes;
  fakes.skipKinds.add("gate");
  fakes.skipKinds.add("merge");
  const agent = verifyingAgentExecutor(fakes);
  fakes.skipKinds.add("agent");
  const time = new ManualTime(0);
  const service = world.service({
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  service.executors.register(agent);
  service.executors.register(createGraphGateExecutor());
  service.executors.register(createGraphMergeExecutor());
  await service.init();
  const run = await service.create({
    projectId: "p1",
    environmentId: "review-env",
    template: {
      id: plan.template.id,
      revision: plan.template.revision,
      digest: plan.templateDigest,
    },
    plan,
    roles: bindAllRoles(plan, width, ["claude", "codex"]),
    params: { autoFix: false, autoPr: false, targetBranch: "main" },
    inputs: { target: graphTypeExample(plan, "workspace@1") },
  });

  const graphRuns = world.storage.graphRuns;
  const spies = [
    spyOn(graphRuns, "getGraphRun"),
    spyOn(graphRuns, "saveGraphRun"),
    spyOn(graphRuns, "listAllGraphRuns"),
    spyOn(graphRuns, "listGraphRuns"),
    spyOn(graphRuns, "listGraphRunIds"),
    spyOn(graphRuns, "getGraphArtifact"),
    spyOn(graphRuns, "listGraphArtifacts"),
    spyOn(graphRuns, "graphArtifactUsage"),
  ];
  const [reads, saves, listAll, listEnvironment, listIds, artifactReads, listArtifacts, usage] =
    spies;
  const verify = spyOn(world.artifacts, "verify");
  /** Every verified artifact id, in order. */
  const verified: string[] = [];
  // A verification that hashes a sealed file (a permit answers the rest).
  const hash = spyOn(
    world.artifacts as unknown as { verifySealedFile: (...args: unknown[]) => Promise<unknown> },
    "verifySealedFile",
  );
  let hashes = 0;
  const sqlite = storageDatabase(world.storage).db;
  const query = sqlite.query.bind(sqlite);
  let rowsFetched = 0;
  let largestFetch = 0;
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
            const rows = Array.isArray(result) ? result.length : result ? 1 : 0;
            rowsFetched += rows;
            largestFetch = Math.max(largestFetch, rows);
          }
          return result;
        };
      },
    });
  });
  const measure = async (): Promise<{ counts: MultiReviewPassCounts; run: GraphRun }> => {
    for (const spy of spies) spy.mockClear();
    verify.mockClear();
    hash.mockClear();
    rowsFetched = 0;
    largestFetch = 0;
    const starts = fakes.callsOf("start").length;
    const observes = fakes.callsOf("observe").length;
    time.jump(3_000);
    const after = await service.advanceNow(run.id);
    if (!after) throw new Error("the run disappeared");
    verified.push(...verify.mock.calls.map((call) => call[1]));
    hashes += hash.mock.calls.length;
    return {
      run: after,
      counts: {
        runReads: reads!.mock.calls.length,
        runRowsFetched: rowsFetched,
        runListings:
          listAll!.mock.calls.length +
          listEnvironment!.mock.calls.length +
          listIds!.mock.calls.length,
        saves: saves!.mock.calls.length,
        starts: fakes.callsOf("start").length - starts,
        observes: fakes.callsOf("observe").length - observes,
        artifactReads: artifactReads!.mock.calls.length,
        verifications: verify.mock.calls.length,
        artifactListings: listArtifacts!.mock.calls.length + usage!.mock.calls.length,
        largestRunFetch: largestFetch,
      },
    };
  };
  const add = (into: MultiReviewPassCounts, from: MultiReviewPassCounts) => {
    for (const key of Object.keys(into) as (keyof MultiReviewPassCounts)[]) {
      into[key] =
        key === "largestRunFetch" ? Math.max(into[key], from[key]) : into[key] + from[key];
    }
  };
  const reviewing = (current: GraphRun) =>
    current.activations.filter(
      (activation) => activation.nodeId === "review" && activation.state === "running",
    ).length === width;
  try {
    const total = zeroMultiReview();
    fakes.held.add("review");
    let admissionPasses = 0;
    for (let current = run; !reviewing(current);) {
      if (++admissionPasses > 20) throw new Error("the panel was not admitted");
      const pass = await measure();
      add(total, pass.counts);
      current = pass.run;
    }
    const verifiedAtAdmission = verified.length;
    const hashedAtAdmission = hashes;
    const running = zeroMultiReview();
    for (let index = 0; index < RUNNING_PASSES; index++) {
      const pass = await measure();
      add(running, pass.counts);
      add(total, pass.counts);
    }
    const verifiedWhileRunning = verified.length - verifiedAtAdmission;
    const hashedWhileRunning = hashes - hashedAtAdmission;
    fakes.held.delete("review");
    let settlingPasses = 0;
    let final: GraphRun = run;
    for (; settlingPasses < 20 && !isGraphRunTerminal(final.status); settlingPasses++) {
      const pass = await measure();
      add(total, pass.counts);
      final = pass.run;
    }
    expect(final.error ?? final.status).toBe("complete");
    for (const key of Object.keys(running) as (keyof MultiReviewPassCounts)[]) {
      if (key !== "largestRunFetch") running[key] = running[key] / RUNNING_PASSES;
    }
    const packages = new Set(
      final.activations.flatMap((activation) =>
        activation.nodeId === "package" && activation.outputs.package
          ? [activation.outputs.package]
          : [],
      ),
    );
    const isPackage = (id: string) => packages.has(id);
    const checksAtAdmission = verified.slice(0, verifiedAtAdmission).filter(isPackage).length;
    const checksAfterRelease = verified
      .slice(verifiedAtAdmission + verifiedWhileRunning)
      .filter(isPackage).length;
    return {
      shape: "multi-review",
      width,
      retainedRuns,
      admissionPasses,
      settlingPasses,
      running,
      total,
      // The package is the shape's only sealed file, so every hash is its.
      packageVerifications: {
        reviewers: hashedAtAdmission,
        consolidation: hashes - hashedAtAdmission - hashedWhileRunning,
        total: hashes,
      },
      packageChecks: {
        reviewers: checksAtAdmission,
        consolidation: checksAfterRelease,
        total: verified.filter(isPackage).length,
      },
      packageGenerations: packages.size,
    };
  } finally {
    observe.mockRestore();
    verify.mockRestore();
    hash.mockRestore();
    for (const spy of spies) spy.mockRestore();
  }
}

describe("graph run control-plane benchmark: the Multi Review shape (item 301)", () => {
  for (const width of [1, 8, 32]) {
    test(`Multi Review panel of ${width}`, async () => {
      const result = await runMultiReviewBenchmark(width, 10);
      multiReviewResults.push(result);
      if (REPORT_ONLY) return;
      expect(result.packageGenerations).toBe(1);
      // Two verifications per generation at any width, the bespoke budget:
      // every consumer checks the package before its prompt reads it, but the
      // reviewer panel's branches share one sealed-file permit
      // (`GraphArtifactStore.verify({ permit })`), so the file is hashed once
      // for the panel and once more, independently, for consolidation.
      expect(result.packageVerifications).toEqual({ reviewers: 1, consolidation: 1, total: 2 });
      expect(result.packageChecks).toEqual({
        reviewers: width,
        consolidation: 1,
        total: width + 1,
      });
      // A pass that only observes the running panel reads its own row once,
      // from the cache the previous keyed write carried forward, so it fetches
      // nothing (ten retained runs are never scanned), lists nothing, verifies
      // and reads no artifact and saves nothing: within the bespoke budget of
      // at most one save per running pass.
      expect(result.running).toMatchObject({
        runReads: 1,
        runRowsFetched: 0,
        runListings: 0,
        saves: 0,
        starts: 0,
        observes: width,
        artifactReads: 0,
        verifications: 0,
        artifactListings: 0,
        largestRunFetch: 0,
      });
      // No pass of the whole run lists or scans the store: no listing, and no
      // statement returns more than the one row it asked for by id (a scan
      // would return the ten retained runs too).
      expect(result.total.runListings).toBe(0);
      expect(result.total.largestRunFetch).toBe(1);
    });
  }
});

test("records the benchmark table", async () => {
  if (OUTPUT_PATH) {
    await fs.writeFile(
      OUTPUT_PATH,
      `${JSON.stringify([...results, ...multiReviewResults], null, 2)}\n`,
    );
  }
  expect(results.length + multiReviewResults.length).toBeGreaterThan(0);
});
