/**
 * Efficiency budgets of a graph-engine Multi Review's record side (item 301):
 * what one Multi Review supervision pass costs while it projects a graph run
 * onto its record, held to the budgets the bespoke engine is held to
 * (`multi-review-efficiency.bench.test.ts`, `multi-review-service-efficiency.test.ts`):
 * at most one save per pass, nothing saved over an unchanged run, no
 * whole-store read, and artifacts read only for what the record lacks.
 *
 * The run's own budgets (package verifications per generation, saves per
 * running pass, no run listings) are in `graph-run-efficiency.bench.test.ts`.
 * Deterministic: the real store, compiler, launch path and graph passes with
 * pass-through agents and a manual graph clock; no waits, no timing.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import {
  graphReviewGap,
  graphReviewIssue,
  graphReviewReport,
  graphReviewWorld,
  type GraphReviewWorld,
} from "./multi-review-graph-test-support.js";
import { storageDatabase } from "./storage-test-support.js";

const worlds: GraphReviewWorld[] = [];

afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

/** Every reviewer reports one issue and one gap; consolidation cites two; the Fix completes. */
function scriptFindings(w: GraphReviewWorld): void {
  w.fakes.scripts.set("review", ({ port, branchKey }) =>
    port === "report"
      ? graphReviewReport({
          issues: [graphReviewIssue(`Issue from ${branchKey}`)],
          testCoverageGaps: [graphReviewGap("Failure branch")],
          verdict: { ready: "with-fixes", reasoning: "Fix first" },
        })
      : undefined,
  );
  w.fakes.scripts.set("consolidate", ({ port }) =>
    port === "report"
      ? graphReviewReport({
          issues: [
            {
              ...graphReviewIssue("Merged issue"),
              reviewSourceIds: ["review/panel.1/issue-1", "review/panel.2/issue-1"],
            },
          ],
          verdict: { ready: "with-fixes", reasoning: "Fix first" },
        })
      : undefined,
  );
  w.fakes.scripts.set("fix", ({ port }) =>
    port === "result"
      ? {
          complete: true,
          summary: "Fixed",
          filesChanged: ["src/a.ts"],
          commandsRun: [],
          notes: [],
          limitations: [],
        }
      : undefined,
  );
}

interface ReviewPassCounts {
  /** `workflow.save` events the service recorded. */
  saves: number;
  /** Logical Multi Review row writes underneath them. */
  rowSaves: number;
  /** Single-record Multi Review reads (`getMultiReviewWorkflow`). */
  recordReads: number;
  /** Per-environment Multi Review listings (`listMultiReviewWorkflows`). */
  environmentListings: number;
  /** Whole-store listings of either store (`listAllMultiReviewWorkflows`, `listAllGraphRuns`, run listings). */
  storeListings: number;
  /** Whole-store SQLite reads of `multi-reviews` or `graph-runs`. */
  wholeStoreReads: number;
  /** Graph run reads by id. */
  runReads: number;
  /** Graph artifacts the projection read, by id. */
  artifactReads: string[];
  /** Whether the run's revision moved since the previous Multi Review pass (or it was created). */
  runChanged: boolean;
}

interface ReviewMeasurement {
  width: number;
  /** `start` and the pass that launches the run (it joins the pass `start` schedules). */
  launch: {
    saves: number;
    storeListings: number;
    /** In `start`: creating the record scans the store for an active review, as for bespoke. */
    startWholeStoreReads: number;
    /** In the launching pass. */
    wholeStoreReads: number;
  };
  /** Every later pass. */
  passes: ReviewPassCounts[];
  final: MultiReviewWorkflow;
  /** Artifact id → reads, over the whole review. */
  readsById: Map<string, number>;
  reviewerReports: string[];
  consolidatedReport: string;
  packageId: string;
  fixResult: string;
}

/**
 * Drives a review to the end, measuring every Multi Review pass. Each graph
 * pass is followed by two Multi Review passes: the first projects what the
 * run did, the second sees the same run revision (an unchanged run).
 */
async function measureReview(width: number): Promise<ReviewMeasurement> {
  const w = await graphReviewWorld();
  worlds.push(w);
  scriptFindings(w);
  const storage = w.fixture.storage;
  const graphRuns = storage.graphRuns;
  const multiReviewStores = new Set(["multi-reviews", "graph-runs"]);
  const database = storageDatabase(storage);
  const spies = {
    rowSaves: spyOn(storage, "saveMultiReviewWorkflow"),
    recordReads: spyOn(storage, "getMultiReviewWorkflow"),
    environmentListings: spyOn(storage, "listMultiReviewWorkflows"),
    listAllReviews: spyOn(storage, "listAllMultiReviewWorkflows"),
    listAllRuns: spyOn(graphRuns, "listAllGraphRuns"),
    listRuns: spyOn(graphRuns, "listGraphRuns"),
    listRunIds: spyOn(graphRuns, "listGraphRunIds"),
    runReads: spyOn(graphRuns, "getGraphRun"),
    readStore: spyOn(database, "readStore"),
    readStoreSerialized: spyOn(database, "readStoreSerialized"),
  };
  const launchSaves = w.efficiency.count("workflow.save");
  const workflow = await w.start({
    autoFix: true,
    reviewers: Array.from({ length: width }, (_, index) => ({
      agent: "claude" as const,
      model: `model-${index + 1}`,
    })),
  });
  const runId = workflow.graphRun!.runId;
  const listings = (): number =>
    spies.listAllReviews.mock.calls.length +
    spies.listAllRuns.mock.calls.length +
    spies.listRuns.mock.calls.length +
    spies.listRunIds.mock.calls.length;
  const wholeStoreReadsOf = (): number =>
    [...spies.readStore.mock.calls, ...spies.readStoreSerialized.mock.calls].filter(([store]) =>
      multiReviewStores.has(store),
    ).length;
  const startWholeStoreReads = wholeStoreReadsOf();
  spies.readStore.mockClear();
  spies.readStoreSerialized.mockClear();
  // `start` schedules the first pass itself; this one joins it and launches
  // the run. Measured as a whole, since the scheduled pass may have begun.
  await w.service.advanceNow(workflow.id);
  const launch = {
    saves: w.efficiency.count("workflow.save") - launchSaves,
    storeListings: listings(),
    startWholeStoreReads,
    wholeStoreReads: wholeStoreReadsOf(),
  };
  const passes: ReviewPassCounts[] = [];
  let lastRevision = (await graphRuns.getGraphRun(runId))?.revision;
  const reviewPass = async (): Promise<MultiReviewWorkflow> => {
    for (const spy of Object.values(spies)) spy.mockClear();
    const saves = w.efficiency.count("workflow.save");
    const reads = w.artifactReads.length;
    await w.service.advanceNow(workflow.id);
    const wholeStoreReads = wholeStoreReadsOf();
    const storeListings = listings();
    // Read after the counts above; excluded from `runReads` below.
    const revision = (await graphRuns.getGraphRun(runId))?.revision;
    passes.push({
      saves: w.efficiency.count("workflow.save") - saves,
      rowSaves: spies.rowSaves.mock.calls.length,
      recordReads: spies.recordReads.mock.calls.length,
      environmentListings: spies.environmentListings.mock.calls.length,
      storeListings,
      wholeStoreReads,
      runReads: spies.runReads.mock.calls.length - 1,
      artifactReads: w.artifactReads.slice(reads),
      runChanged: revision !== lastRevision,
    });
    lastRevision = revision;
    return w.workflow(workflow.id);
  };
  try {
    let final: MultiReviewWorkflow | undefined;
    for (let index = 0; index < 60 && !final; index++) {
      await reviewPass();
      const current = await reviewPass();
      if (current.graphRun?.settled) {
        final = current;
        break;
      }
      w.time.jump(3_000);
      await w.graphRuns.advanceNow(runId);
    }
    if (!final) throw new Error("the review did not settle");
    const run = await w.run(final);
    const output = (nodeId: string, port: string) =>
      run.activations.find((activation) => activation.nodeId === nodeId)!.outputs[port]!;
    const readsById = new Map<string, number>();
    for (const id of w.artifactReads) readsById.set(id, (readsById.get(id) ?? 0) + 1);
    return {
      width,
      launch,
      passes,
      final,
      readsById,
      reviewerReports: run.activations
        .filter((activation) => activation.nodeId === "review")
        .map((activation) => activation.outputs.report!),
      consolidatedReport: output("consolidate", "report"),
      packageId: output("package", "package"),
      fixResult: output("fix", "result"),
    };
  } finally {
    for (const spy of Object.values(spies)) spy.mockRestore();
  }
}

function expectRecordBudgets(result: ReviewMeasurement): void {
  const { width, passes, final } = result;
  expect(final.phase).toBe("completed");
  expect(final.reviewers.every((reviewer) => reviewer.status === "completed")).toBe(true);
  expect(final.consolidatedReport).toBeDefined();
  expect(final.fixResult?.complete).toBe(true);
  expect(final.reviewPackage).toBeDefined();

  for (const pass of passes) {
    // At most one save per pass, and no pass reads or lists a whole store
    // (neither Multi Review records nor graph runs).
    expect(pass.saves).toBeLessThanOrEqual(1);
    expect(pass.rowSaves).toBe(pass.saves);
    expect(pass.storeListings).toBe(0);
    expect(pass.wholeStoreReads).toBe(0);
    // Its own record once, and once more under the controller lease when
    // the run moved and the record is projected — as a bespoke pass does.
    expect(pass.recordReads).toBe(pass.runChanged ? 2 : 1);
  }
  // Launching saves nothing yet (the run at revision 0 shows nothing new)
  // and lists nothing. The one whole-store read is `start` creating the
  // record (`createMultiReviewWorkflowIfNoActive` must see every review to
  // refuse a second active one), shared with the bespoke engine; the
  // launching pass reads no whole store.
  expect(result.launch).toEqual({
    saves: 0,
    storeListings: 0,
    startWholeStoreReads: 1,
    wholeStoreReads: 0,
  });
  // Every later pass reads the run once by id, until the record is settled:
  // a settled record is no longer projected, so its pass reads no run.
  for (const pass of passes.slice(0, -1)) expect(pass.runReads).toBe(1);
  expect(passes.at(-1)!.runReads).toBe(0);

  // A pass over a run whose revision did not move (the second pass after
  // every graph pass, and the first pass, before any graph pass) saves
  // nothing, reads no artifact and lists nothing.
  const unchanged = passes.filter((pass) => !pass.runChanged);
  expect(unchanged).toHaveLength(passes.length / 2 + 1);
  for (const pass of unchanged) {
    expect(pass).toMatchObject({ saves: 0, rowSaves: 0, environmentListings: 0 });
    expect(pass.artifactReads).toEqual([]);
  }

  // Artifacts are read only for what the record lacks, and never again once
  // it holds them. The package, the consolidated report and the fix result
  // are read once each. A reviewer's report is read once when that reviewer
  // completes, and once more when the consolidated report is projected: the
  // consolidation cites graph item ids, and translating them to Multi
  // Review's source ids needs each report artifact's recorded item ids and
  // producer, which the record does not keep.
  expect(result.readsById.get(result.packageId)).toBe(1);
  expect(result.readsById.get(result.consolidatedReport)).toBe(1);
  expect(result.readsById.get(result.fixResult)).toBe(1);
  expect(result.reviewerReports).toHaveLength(width);
  for (const report of result.reviewerReports) expect(result.readsById.get(report)).toBe(2);
  expect([...result.readsById.values()].reduce((total, reads) => total + reads, 0)).toBe(
    2 * width + 3,
  );
  // The re-read happens in the one pass that projects the consolidated report.
  const consolidating = passes.filter((pass) =>
    pass.artifactReads.includes(result.consolidatedReport),
  );
  expect(consolidating).toHaveLength(1);
  for (const report of result.reviewerReports) {
    expect(consolidating[0]!.artifactReads).toContain(report);
  }
}

describe("a graph-engine Multi Review's record-side budgets", () => {
  for (const width of [8, 32]) {
    test(`a full review with ${width} reviewers`, async () => {
      const result = await measureReview(width);
      expectRecordBudgets(result);
      // Saves are bounded by the passes that saw the run move, not by width.
      const changed = result.passes.filter((pass) => pass.runChanged).length;
      const saves = result.passes.reduce((total, pass) => total + pass.saves, 0);
      expect(saves).toBeLessThanOrEqual(changed);
    });
  }
});
