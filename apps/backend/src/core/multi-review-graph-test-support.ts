/**
 * A Multi Review service on the graph engine over a real store, the real
 * template compiler and launch path, real graph passes and the real gate
 * executor, with pass-through agent and system executors whose outputs the
 * tests script (item 301). Deterministic: a manual graph clock, no waits.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type {
  MultiReviewModelSelection,
  MultiReviewWorkflow,
  StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { GraphArtifactStore } from "./graph-artifacts.js";
import { createGraphGateExecutor } from "./graph-node-gate.js";
import { createGraphMergeExecutor } from "./graph-node-merge.js";
import { FakeGraphExecutors } from "./graph-run-executor-test-support.js";
import { GraphRunLaunchService } from "./graph-run-launch.js";
import { GraphRunService } from "./graph-run-service.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import {
  createGraphTemplateFixture,
  type GraphTemplateFixture,
} from "./graph-template-test-support.js";
import { RecordingEfficiencyObserver } from "./multi-review-efficiency.js";
import { MultiReviewGraphEngine } from "./multi-review-graph-engine.js";
import { MultiReviewService, type MultiReviewServiceOptions } from "./multi-review-service.js";
import { ManualTime } from "./recurring-test-support.js";
import { runCommand } from "./shell.js";

export const GRAPH_REVIEW_HEAD = "1".repeat(40);
const FINGERPRINT = "a".repeat(64);

/** A clean report every reviewer can return; tests add findings. */
export function graphReviewReport(
  overrides: Partial<StructuredReviewReport> = {},
): StructuredReviewReport {
  return {
    reviewScope: {
      targetBranch: "main",
      baseRef: "origin/main...HEAD",
      commit: null,
      filesReviewed: ["src/a.ts"],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
    },
    whatChanged: {
      overview: "Change",
      before: "Before",
      after: "After",
      keyCodeChanges: [],
      userImpact: "Impact",
    },
    riskProfile: {
      changeTypes: ["feature"],
      riskAreas: [],
      overallRisk: "medium",
      reasoning: "Changed",
    },
    testResults: { total: 0, passed: 0, failed: 0, notRun: 0, failures: [] },
    strengths: [],
    issues: [],
    testCoverageGaps: [],
    verdict: { ready: "yes", reasoning: "Ready" },
    summaryOfChange: "Change",
    reviewSummary: "Clean",
    ...overrides,
  };
}

/** One issue as a reviewer reports it (no source ids, no model labels). */
export function graphReviewIssue(title: string): StructuredReviewReport["issues"][number] {
  return {
    severity: "P1",
    confidence: 90,
    category: "correctness",
    title,
    file: "src/a.ts",
    line: 10,
    symbol: "run",
    description: `${title} description`,
    evidence: "Observed",
    suggestion: "Fix it",
    verification: "Run the test",
    // The provider schema's nullable keys, as a reviewer submits them.
    alternativeFixes: null,
    reviewModels: null,
    reviewSourceIds: null,
  } as unknown as StructuredReviewReport["issues"][number];
}

/** One coverage gap as a reviewer reports it. */
export function graphReviewGap(
  untestedBehavior: string,
): StructuredReviewReport["testCoverageGaps"][number] {
  return {
    file: "src/a.test.ts",
    untestedBehavior,
    reviewModels: null,
    reviewSourceIds: null,
  } as unknown as StructuredReviewReport["testCoverageGaps"][number];
}

export interface GraphReviewWorld {
  fixture: GraphTemplateFixture;
  projectId: string;
  environmentId: string;
  fakes: FakeGraphExecutors;
  time: ManualTime;
  graphRuns: GraphRunService;
  service: MultiReviewService;
  engine: MultiReviewGraphEngine;
  efficiency: RecordingEfficiencyObserver;
  /** Graph-run artifact reads the projection made, by artifact id. */
  artifactReads: string[];
  /** The engine `start` resolves for every start. */
  setEngine(engine: "bespoke" | "graph"): void;
  start(input?: Partial<StartMultiReviewInput>): Promise<MultiReviewWorkflow>;
  workflow(id: string): Promise<MultiReviewWorkflow>;
  run(workflow: MultiReviewWorkflow): Promise<GraphRun>;
  /** Alternates graph passes and Multi Review passes until `until` holds. */
  drive(
    workflowId: string,
    until: (workflow: MultiReviewWorkflow) => boolean,
    passes?: number,
  ): Promise<MultiReviewWorkflow>;
  /** Drives until the run settled and the record shows it. */
  settle(workflowId: string, passes?: number): Promise<MultiReviewWorkflow>;
  close(): Promise<void>;
}

export async function graphReviewWorld(
  options: { serviceOptions?: Partial<MultiReviewServiceOptions> } = {},
): Promise<GraphReviewWorld> {
  const fixture = await createGraphTemplateFixture();
  const storage = fixture.storage;
  const projectId = fixture.projectId;
  const worktree = path.join(fixture.root, "worktree");
  await fs.mkdir(worktree);
  await runCommand("git", ["init", "-q", "-b", "main", worktree]);
  const environmentId = "review-env";
  await storage.addEnvironment(
    graphEnvironmentFixture({
      id: environmentId,
      projectId,
      branch: "change",
      worktreePath: worktree,
      networkAccessMode: "full",
    }),
  );
  const artifacts = new GraphArtifactStore({
    storage,
    fence: { beginMutation: () => () => undefined },
  });
  const fakes = new FakeGraphExecutors();
  fakes.withSessions = true;
  fakes.withProviderSessions = true;
  fakes.skipKinds.add("gate");
  fakes.skipKinds.add("merge");
  const time = new ManualTime(0);
  const graphRuns = new GraphRunService(storage, {
    artifacts,
    autoAdvance: false,
    schedulerClock: { now: time.now, timers: time.timerFactory },
  });
  fakes.register(graphRuns.executors);
  graphRuns.executors.register(createGraphGateExecutor());
  graphRuns.executors.register(createGraphMergeExecutor());
  await graphRuns.init();
  const launches = new GraphRunLaunchService({
    storage,
    templates: fixture.service,
    runs: graphRuns,
    settingsTiers: async () => ({}),
    workspaceHead: async (environment) => ({
      branch: environment.branch,
      headRef: GRAPH_REVIEW_HEAD,
    }),
    linkTicket: async () => undefined,
    host: () => ({ claudeSandbox: true }),
  });
  const artifactReads: string[] = [];
  const engine = new MultiReviewGraphEngine({
    launches,
    runs: graphRuns,
    storage: {
      graphRuns: {
        getGraphArtifact: (runId, artifactId) => {
          artifactReads.push(artifactId);
          return storage.graphRuns.getGraphArtifact(runId, artifactId);
        },
      },
    },
  });
  let selected: "bespoke" | "graph" = "graph";
  const efficiency = new RecordingEfficiencyObserver();
  const service = new MultiReviewService(
    storage,
    async <T>(command: string): Promise<T> => {
      if (command === "get_environment_uncommitted_paths") {
        return { head: GRAPH_REVIEW_HEAD, paths: [], fingerprint: FINGERPRINT } as T;
      }
      throw new Error(`unexpected command ${command}`);
    },
    {
      autoAdvance: false,
      efficiency,
      graph: { engine: async () => selected, runtime: () => engine },
      ...options.serviceOptions,
    },
  );
  const read = async (id: string) =>
    (await storage.getMultiReviewWorkflow(id))?.snapshot as MultiReviewWorkflow;
  const opus: MultiReviewModelSelection = { agent: "claude", model: "opus" };
  const world: GraphReviewWorld = {
    fixture,
    projectId,
    environmentId,
    fakes,
    time,
    graphRuns,
    service,
    engine,
    efficiency,
    artifactReads,
    setEngine(engine) {
      selected = engine;
    },
    start: (input = {}) =>
      service.start({
        environmentId,
        projectId,
        targetBranch: "main",
        reviewers: [opus, { agent: "claude", model: "sonnet" }],
        fixModel: opus,
        ...input,
      }),
    workflow: read,
    async run(workflow) {
      const run = await graphRuns.get(workflow.graphRun!.runId);
      if (!run) throw new Error("the graph run does not exist");
      return run;
    },
    async drive(workflowId, until, passes = 120) {
      for (let index = 0; index < passes; index++) {
        await service.advanceNow(workflowId);
        const current = await read(workflowId);
        if (until(current)) return current;
        const runId = current.graphRun?.runId;
        if (runId) {
          time.jump(3_000);
          await graphRuns.advanceNow(runId);
        }
      }
      throw new Error("the review did not reach the expected state");
    },
    settle(workflowId, passes) {
      return world.drive(workflowId, (workflow) => workflow.graphRun?.settled === true, passes);
    },
    async close() {
      await service.shutdown();
      await graphRuns.shutdown();
      await fixture.close();
    },
  };
  return world;
}
