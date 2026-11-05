import { describe, expect, test } from "bun:test";
import type { BuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type {
  CoordinatorDelegation,
  CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";
import type { GraphRun } from "@orkestrator/protocol/graphs/run";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { NodeSummary } from "@orkestrator/protocol/node-summaries";
import {
  countCoordinatorWork,
  deriveCoordinatorWorkItems,
  FINISHED_WORK_RETENTION_MS,
  isClearableWorkItem,
  pullRequestStage,
  remoteWorkKey,
  type CoordinatorWorkSources,
  type WorkEnvironment,
  type WorkPrReading,
  type WorkTicket,
  nextWakeLine,
  workAge,
  workerTabTarget,
  type CoordinatorWorkItem,
} from "./coordinator-work-items";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

let sequence = 0;
function association(
  overrides: Partial<CoordinatorWorkflowAssociation> &
    Pick<CoordinatorWorkflowAssociation, "kind" | "resourceId">,
): CoordinatorWorkflowAssociation {
  sequence += 1;
  return {
    id: `association-${sequence}`,
    coordinatorId: "coordinator-1",
    projectId: "project-1",
    conversationId: "conversation-1",
    requestId: `request-${sequence}`,
    createdAt: at(-2 * HOUR),
    ...overrides,
  };
}

function delegated(
  resourceId: string,
  state: "running" | "completed" | "failed" | "stopped",
  extra: Partial<NonNullable<CoordinatorWorkflowAssociation["delegation"]>> = {},
  overrides: Partial<CoordinatorWorkflowAssociation> = {},
): CoordinatorWorkflowAssociation {
  return association({
    kind: "environment",
    resourceId,
    delegation: { requestedAt: at(-HOUR), workerTabId: `tab-${resourceId}`, state, ...extra },
    ...overrides,
  });
}

function environment(id: string, extra: Partial<WorkEnvironment> = {}): WorkEnvironment {
  return { id, projectId: "project-1", name: `env ${id}`, prUrl: null, prState: null, ...extra };
}

function pipeline(id: string, extra: Partial<BuildPipeline> = {}): BuildPipeline {
  return {
    id,
    projectId: "project-1",
    environmentId: `build-env-${id}`,
    taskId: `task-${id}`,
    taskTitle: `Ticket ${id}`,
    phase: "building",
    sessions: [],
    createdAt: at(-3 * HOUR),
    backendRevision: 1,
    ...extra,
  } as unknown as BuildPipeline;
}

function review(id: string, extra: Partial<MultiReviewWorkflow> = {}): MultiReviewWorkflow {
  return {
    id,
    environmentId: "reviewed-env",
    projectId: "project-1",
    targetBranch: "main",
    phase: "reviewing",
    reviewers: [{ id: "a" }, { id: "b" }, { id: "c" }],
    createdAt: at(-HOUR),
    updatedAt: at(-HOUR),
    ...extra,
  } as unknown as MultiReviewWorkflow;
}

function graphRun(id: string, extra: Partial<GraphRun> = {}): GraphRun {
  return {
    id,
    projectId: "project-1",
    environmentId: "graph-env",
    status: "running",
    plan: { template: { name: "Ship it" } },
    createdAt: at(-HOUR),
    updatedAt: at(-HOUR),
    ...extra,
  } as unknown as GraphRun;
}

function node(
  nodeId: string,
  displayName: string,
  environments: Array<Partial<NodeSummary["environments"][number]> & { environmentId: string }>,
): Pick<NodeSummary, "nodeId" | "view" | "environments"> {
  return {
    nodeId: nodeId as NodeSummary["nodeId"],
    view: { displayName } as NodeSummary["view"],
    environments: environments.map(({ environmentId, ...rest }) => ({
      ref: { backendId: nodeId, environmentId },
      projectId: "remote-project",
      name: `remote ${environmentId}`,
      activity: "idle",
      ...rest,
    })) as unknown as NodeSummary["environments"],
  };
}

function sources(overrides: Partial<CoordinatorWorkSources> = {}): CoordinatorWorkSources {
  return {
    coordinatorId: "coordinator-1",
    workflows: [],
    environments: new Map(),
    pipelines: new Map(),
    reviews: new Map(),
    graphRuns: new Map(),
    prReadings: new Map(),
    tickets: new Map(),
    nodes: [],
    remotePipelines: new Map(),
    remoteReviews: new Map(),
    remoteGraphRuns: new Map(),
    promptEnvironmentIds: new Set(),
    now: NOW,
    ...overrides,
  };
}

describe("deriveCoordinatorWorkItems", () => {
  test("lists one row per worker, build, review, graph run and pull request", () => {
    const items = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          delegated("worker-1", "running"),
          association({ kind: "build-pipeline", resourceId: "pipeline-1" }),
          association({ kind: "multi-review", resourceId: "review-1" }),
          association({ kind: "graph-run", resourceId: "run-1" }),
          association({
            kind: "pull-request",
            resourceId: "worker-1",
            pullRequest: { source: "create-pr", prUrl: "https://github.com/o/r/pull/42" },
          }),
        ],
        environments: new Map([
          ["worker-1", environment("worker-1", { agentActivityState: "working" })],
          ["reviewed-env", environment("reviewed-env", { name: "feature branch" })],
        ]),
        pipelines: new Map([["pipeline-1", pipeline("pipeline-1", { phase: "verifying" })]]),
        reviews: new Map([["review-1", review("review-1")]]),
        graphRuns: new Map([["run-1", graphRun("run-1")]]),
        prReadings: new Map<string, WorkPrReading>([
          [
            "worker-1",
            {
              prUrl: "https://github.com/o/r/pull/42",
              prState: "open",
              hasMergeConflicts: false,
              checkSummary: { passed: 1, total: 3, pending: 2 } as WorkPrReading["checkSummary"],
            },
          ],
        ]),
      }),
    );
    const byKind = new Map(items.map((item) => [item.kind, item]));
    expect(items).toHaveLength(5);
    expect(byKind.get("worker")).toMatchObject({
      name: "env worker-1",
      stage: "Worker · working · PR open · checks pending",
      bucket: "running",
      target: {
        type: "worker-tab",
        projectId: "project-1",
        environmentId: "worker-1",
        tabId: "tab-worker-1",
      },
    });
    expect(byKind.get("build")).toMatchObject({
      name: "Ticket pipeline-1",
      stage: "Build · Verify",
      target: { type: "build", pipelineId: "pipeline-1", environmentId: "build-env-pipeline-1" },
    });
    expect(byKind.get("review")).toMatchObject({
      name: "Multi Review of feature branch",
      stage: "Review · 3 reviewers",
      target: { type: "review", environmentId: "reviewed-env", workflowId: "review-1" },
    });
    expect(byKind.get("graph-run")).toMatchObject({
      name: "Ship it",
      stage: "Graph run · running",
      target: { type: "graph-run", runId: "run-1", environmentId: "graph-env" },
    });
    expect(byKind.get("pull-request")).toMatchObject({
      name: "PR #42 · env worker-1",
      stage: "PR open · checks pending",
      bucket: "running",
      target: { type: "pull-request", url: "https://github.com/o/r/pull/42" },
    });
  });

  test("covers every conversation of this coordinator and nothing of another or still pending", () => {
    const items = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          delegated("first", "running"),
          delegated("second", "running", {}, { conversationId: "conversation-2" }),
          delegated("elsewhere", "running", {}, { coordinatorId: "coordinator-2" }),
          delegated("reserved", "running", {}, { pending: true }),
          association({ kind: "feature-plan", resourceId: "plan-1" }),
          // A kind added by a newer backend is skipped, never mistaken for another.
          association({ kind: "future-kind" as never, resourceId: "x" }),
        ],
        environments: new Map([
          ["first", environment("first")],
          ["second", environment("second")],
        ]),
      }),
    );
    expect(items.map((item) => item.name).sort()).toEqual(["env first", "env second"]);
  });

  test("names work on another node with its machine and opens it there", () => {
    const items = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          delegated("remote-worker", "running", {}, { nodeId: "node-b" }),
          association({ kind: "build-pipeline", resourceId: "remote-pipe", nodeId: "node-b" }),
        ],
        nodes: [
          node("node-b", "Studio", [{ environmentId: "remote-worker", activity: "working" }]),
        ],
        remotePipelines: new Map([
          [
            remoteWorkKey("node-b", "remote-pipe"),
            pipeline("remote-pipe", {
              projectId: "remote-project",
              environmentId: "remote-build-env",
              phase: "reviewing",
            }),
          ],
        ]),
      }),
    );
    const worker = items.find((item) => item.kind === "worker")!;
    expect(worker).toMatchObject({
      name: "remote remote-worker",
      machine: "Studio",
      stage: "Worker · working",
      target: {
        type: "remote",
        nodeId: "node-b",
        projectId: "remote-project",
        environmentId: "remote-worker",
      },
    });
    const build = items.find((item) => item.kind === "build")!;
    expect(build).toMatchObject({
      machine: "Studio",
      stage: "Build · Review",
      target: { type: "remote", nodeId: "node-b", environmentId: "remote-build-env" },
    });
  });

  test("a graph run on another node shows its stage and opens its environment there", () => {
    const workflows = [
      association({ kind: "graph-run", resourceId: "g", nodeId: "node-b", createdAt: at(-HOUR) }),
    ];
    const nodes = [node("node-b", "Studio", [{ environmentId: "remote-graph-env" }])];
    const remoteGraphRuns = (extra: Partial<GraphRun>) =>
      new Map([
        [
          remoteWorkKey("node-b", "g"),
          graphRun("g", { environmentId: "remote-graph-env", ...extra }),
        ],
      ]);
    const [running] = deriveCoordinatorWorkItems(
      sources({ workflows, nodes, remoteGraphRuns: remoteGraphRuns({}) }),
    );
    expect(running).toMatchObject({
      kind: "graph-run",
      name: "Ship it",
      machine: "Studio",
      bucket: "running",
      stage: "Graph run · running",
      target: {
        type: "remote",
        nodeId: "node-b",
        projectId: "remote-project",
        environmentId: "remote-graph-env",
        title: "Ship it",
      },
    });
    const [waiting] = deriveCoordinatorWorkItems(
      sources({ workflows, nodes, remoteGraphRuns: remoteGraphRuns({ status: "waiting" }) }),
    );
    expect(waiting).toMatchObject({ bucket: "needs-you", stage: "Graph run · waiting for you" });
    const [failed] = deriveCoordinatorWorkItems(
      sources({
        workflows,
        nodes,
        remoteGraphRuns: remoteGraphRuns({ status: "failed", error: "API error" }),
      }),
    );
    expect(failed).toMatchObject({ bucket: "needs-you", stage: "Failed: API error" });
    // Finished work expires 24 hours after the run finished, not after it started.
    const complete = remoteGraphRuns({ status: "complete", finishedAt: at(-2 * HOUR) });
    expect(
      deriveCoordinatorWorkItems(sources({ workflows, nodes, remoteGraphRuns: complete }))[0],
    ).toMatchObject({ bucket: "finished", stage: "Graph run complete" });
    expect(
      deriveCoordinatorWorkItems(
        sources({ workflows, nodes, remoteGraphRuns: complete, now: NOW + 21 * HOUR }),
      ),
    ).toHaveLength(1);
    expect(
      deriveCoordinatorWorkItems(
        sources({ workflows, nodes, remoteGraphRuns: complete, now: NOW + 22 * HOUR }),
      ),
    ).toEqual([]);
  });

  test("orders work that needs the user first, then running, then finished", () => {
    const items = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          delegated("done", "completed", { completedAt: at(-HOUR) }),
          delegated("busy", "running"),
          delegated("asking", "running", { waiting: { since: at(-60_000) } }),
          association({ kind: "build-pipeline", resourceId: "failed" }),
          association({ kind: "build-pipeline", resourceId: "paused" }),
          delegated("prompted", "running"),
        ],
        environments: new Map(
          ["done", "busy", "asking", "prompted"].map((id) => [id, environment(id)]),
        ),
        pipelines: new Map([
          [
            "failed",
            pipeline("failed", {
              phase: "failed",
              error: "API error",
              failureContext: { phase: "building", kind: "prompt-dispatch" },
            } as Partial<BuildPipeline>),
          ],
          ["paused", pipeline("paused", { phase: "paused", pausedFromPhase: "verifying" })],
        ]),
        promptEnvironmentIds: new Set(["prompted"]),
      }),
    );
    expect(items.map((item) => [item.bucket, item.stage])).toEqual([
      ["needs-you", "Worker · waiting for you"],
      ["needs-you", "Worker · waiting for you"],
      ["needs-you", "Failed: API error"],
      ["needs-you", "Build paused · Verify"],
      ["running", "Worker · running"],
      ["finished", "Worker · finished"],
    ]);
    expect(countCoordinatorWork(items)).toEqual({ running: 1, needsYou: 4, finished: 1 });
  });

  test("counts the build's acceptance criteria from its linked ticket", () => {
    const ticket: WorkTicket = {
      id: "task-7",
      sections: {
        acceptanceCriteria: Array.from({ length: 12 }, (_, index) => ({
          id: `c${index}`,
          text: `criterion ${index}`,
          ...(index < 9
            ? {
                check: {
                  status: "passed" as const,
                  evidence: "ok",
                  checkedAt: at(0),
                  source: "verify" as const,
                },
              }
            : index === 9
              ? {
                  check: {
                    status: "failed" as const,
                    evidence: "no",
                    checkedAt: at(0),
                    source: "verify" as const,
                  },
                }
              : {}),
        })),
      },
    };
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [association({ kind: "build-pipeline", resourceId: "pipe" })],
        pipelines: new Map([
          ["pipe", pipeline("pipe", { source: { type: "kanban", taskId: "task-7" } })],
        ]),
        tickets: new Map([["task-7", ticket]]),
      }),
    );
    expect(item!.criteria).toEqual({ passed: 9, total: 12 });
  });

  test("falls back to the pipeline's own Verify results when the ticket is not loaded", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [association({ kind: "build-pipeline", resourceId: "pipe" })],
        pipelines: new Map([
          [
            "pipe",
            pipeline("pipe", {
              source: { type: "kanban", taskId: "task-7" },
              taskSnapshot: {
                title: "T",
                description: "",
                acceptanceCriteria: "- one\n- two",
                acceptanceCriteriaItems: [
                  { id: "a1", text: "one" },
                  { id: "a2", text: "two" },
                ],
              },
              sessions: [
                {
                  phase: "verify",
                  status: "idle",
                  startedAt: at(-HOUR),
                  completedAt: at(-HOUR),
                  acceptanceCriteriaResults: [{ id: "a1", status: "passed", evidence: "ok" }],
                },
              ],
            } as unknown as Partial<BuildPipeline>),
          ],
        ]),
      }),
    );
    expect(item!.criteria).toEqual({ passed: 1, total: 2 });
  });

  test("drops finished work 24 hours after it finished unless its pull request is still open", () => {
    const finishedAt = at(-25 * HOUR);
    const workflows = [
      delegated("old", "completed", { completedAt: finishedAt }),
      delegated("recent", "completed", { completedAt: at(-23 * HOUR) }),
      delegated("old-open-pr", "completed", { completedAt: finishedAt }),
      association({ kind: "build-pipeline", resourceId: "old-build" }),
      association({
        kind: "pull-request",
        resourceId: "merged-env",
        pullRequest: {
          source: "create-pr",
          prUrl: "https://github.com/o/r/pull/7",
          final: { prUrl: "https://github.com/o/r/pull/7", prState: "merged", at: at(-HOUR) },
        },
      }),
    ];
    const build = pipeline("old-build", {
      phase: "complete",
      sessions: [{ completedAt: finishedAt } as BuildPipeline["sessions"][number]],
    });
    const names = (now: number) =>
      deriveCoordinatorWorkItems(
        sources({
          now,
          workflows,
          environments: new Map([
            ["old", environment("old")],
            ["recent", environment("recent")],
            [
              "old-open-pr",
              environment("old-open-pr", {
                prState: "open",
                prUrl: "https://github.com/o/r/pull/9",
              }),
            ],
          ]),
          pipelines: new Map([["old-build", build]]),
        }),
      ).map((item) => item.name);

    expect(names(NOW).sort()).toEqual(["PR #7", "env old-open-pr", "env recent"]);
    // The merged PR finished an hour ago, so it stays until its own 24 hours pass.
    expect(names(NOW + 24 * HOUR).sort()).toEqual(["env old-open-pr"]);
    expect(FINISHED_WORK_RETENTION_MS).toBe(24 * HOUR);
  });

  test("a finished build stays while its pull request is open and drops once it merges", () => {
    const workflows = [association({ kind: "build-pipeline", resourceId: "pipe" })];
    const build = pipeline("pipe", {
      phase: "complete",
      sessions: [{ completedAt: at(-48 * HOUR) } as BuildPipeline["sessions"][number]],
    });
    const run = (prState: "open" | "merged") =>
      deriveCoordinatorWorkItems(
        sources({
          workflows,
          pipelines: new Map([["pipe", build]]),
          environments: new Map([
            [
              "build-env-pipe",
              environment("build-env-pipe", { prState, prUrl: "https://github.com/o/r/pull/1" }),
            ],
          ]),
        }),
      );
    expect(run("open").map((item) => item.stage)).toEqual(["Build complete · PR open"]);
    expect(run("merged")).toEqual([]);
  });

  test("a deleted worker cannot be opened", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          delegated(
            "gone",
            "completed",
            { completedAt: at(-HOUR) },
            {
              workerOutcome: {
                deletedAt: at(-HOUR),
                ended: { key: "deleted", at: at(-HOUR), notified: true },
              },
            },
          ),
        ],
      }),
    );
    expect(item).toMatchObject({ stage: "Environment deleted", bucket: "finished", target: null });
  });
});

describe("pullRequestStage", () => {
  test("describes each pull request state in words", () => {
    expect(pullRequestStage({ prState: "merged" })).toBe("PR merged");
    expect(pullRequestStage({ prState: "closed" })).toBe("PR closed");
    expect(pullRequestStage({ prState: "open", hasMergeConflicts: true })).toBe(
      "PR open · merge conflicts",
    );
    expect(
      pullRequestStage({
        prState: "open",
        checkSummary: { passed: 3, total: 4, pending: 0 } as never,
      }),
    ).toBe("PR open · 1 check failing");
    expect(
      pullRequestStage({
        prState: "open",
        checkSummary: { passed: 4, total: 4, pending: 0 } as never,
      }),
    ).toBe("PR open · checks passed");
  });
});

describe("review fixes", () => {
  test("review prompts update bucket, stage, ordering and counts", () => {
    const items = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          association({ kind: "multi-review", resourceId: "r" }),
          delegated("busy", "running"),
        ],
        reviews: new Map([["r", review("r")]]),
        environments: new Map([["busy", environment("busy")]]),
        promptEnvironmentIds: new Set(["reviewed-env"]),
      }),
    );
    expect(items[0]).toMatchObject({
      kind: "review",
      bucket: "needs-you",
      stage: "Review · 3 reviewers · waiting for you",
    });
    expect(countCoordinatorWork(items)).toEqual({ needsYou: 1, running: 1, finished: 0 });
  });
  test("reviews and graphs retain open PRs from monitor or remote summaries", () => {
    for (const remote of [false, true]) {
      const workflows = [
        association({
          kind: "multi-review",
          resourceId: "r",
          ...(remote ? { nodeId: "node-b" } : {}),
        }),
        ...(!remote ? [association({ kind: "graph-run", resourceId: "g" })] : []),
      ];
      const r = review("r", { phase: "completed", updatedAt: at(-48 * HOUR) });
      const run = (prState: "open" | "closed") =>
        deriveCoordinatorWorkItems(
          sources({
            workflows,
            reviews: new Map([["r", r]]),
            remoteReviews: new Map([[remoteWorkKey("node-b", "r"), r]]),
            graphRuns: new Map([
              ["g", graphRun("g", { status: "complete", finishedAt: at(-48 * HOUR) })],
            ]),
            nodes: [node("node-b", "Studio", [{ environmentId: "reviewed-env", prState }])],
            prReadings: new Map(
              ["reviewed-env", "graph-env"].map((id) => [
                id,
                {
                  prState,
                  prUrl: "https://github.com/o/r/pull/1",
                  hasMergeConflicts: false,
                  checkSummary: null,
                },
              ]),
            ),
          }),
        );
      expect(run("open")).toHaveLength(remote ? 1 : 2);
      expect(run("closed")).toEqual([]);
    }
  });
  test.each(["build-pipeline", "multi-review", "graph-run"] as const)(
    "confirmed missing %s expires; loading does not",
    (kind) => {
      const workflows = [association({ kind, resourceId: "gone", createdAt: at(-25 * HOUR) })];
      expect(deriveCoordinatorWorkItems(sources({ workflows }))[0]?.bucket).toBe("running");
      const missingResources = new Set([`${kind}:gone`]);
      const recent = deriveCoordinatorWorkItems(
        sources({ workflows, missingResources, now: NOW - 2 * HOUR }),
      );
      expect(recent[0]).toMatchObject({ bucket: "finished", target: null });
      expect(deriveCoordinatorWorkItems(sources({ workflows, missingResources }))).toEqual([]);
    },
  );
  test("a remote graph run is loading until read, and finished once its node says it is gone", () => {
    const workflows = [
      association({ kind: "graph-run", resourceId: "g", nodeId: "node-b", createdAt: at(-HOUR) }),
    ];
    const nodes = [node("node-b", "Studio", [])];
    const [loading] = deriveCoordinatorWorkItems(sources({ workflows, nodes }));
    expect(loading).toMatchObject({
      machine: "Studio",
      bucket: "running",
      stage: "Graph run · loading",
      target: null,
    });
    const missingResources = new Set([`graph-run:${remoteWorkKey("node-b", "g")}`]);
    const [gone] = deriveCoordinatorWorkItems(sources({ workflows, nodes, missingResources }));
    expect(gone).toMatchObject({ machine: "Studio", bucket: "finished", target: null });
    expect(countCoordinatorWork([gone!]).running).toBe(0);
    expect(
      deriveCoordinatorWorkItems(
        sources({ workflows, nodes, missingResources, now: NOW + 24 * HOUR }),
      ),
    ).toEqual([]);
  });
});

test("remote builds and reviews follow waiting summaries without local ID collisions", () => {
  const base = sources({
    workflows: [
      association({ kind: "build-pipeline", resourceId: "b", nodeId: "n" }),
      association({ kind: "multi-review", resourceId: "r", nodeId: "n" }),
    ],
    remotePipelines: new Map([[remoteWorkKey("n", "b"), pipeline("b", { environmentId: "e" })]]),
    remoteReviews: new Map([[remoteWorkKey("n", "r"), review("r", { environmentId: "e" })]]),
    nodes: [node("n", "Remote", [{ environmentId: "e", activity: "waiting" }])],
  });
  expect(countCoordinatorWork(deriveCoordinatorWorkItems(base)).needsYou).toBe(2);
  expect(
    countCoordinatorWork(
      deriveCoordinatorWorkItems({
        ...base,
        nodes: [node("n", "Remote", [{ environmentId: "e", activity: "working" }])],
        promptEnvironmentIds: new Set(["e"]),
      }),
    ).running,
  ).toBe(2);
  for (const item of deriveCoordinatorWorkItems(base))
    expect(item.target).toHaveProperty("workTarget");
});

test("ready reviews surface findings and finish clean reports with bounded retention", () => {
  const base = sources({ workflows: [association({ kind: "multi-review", resourceId: "r" })] });
  const run = (issues: unknown[], updatedAt = at(-HOUR)) =>
    deriveCoordinatorWorkItems({
      ...base,
      reviews: new Map([
        [
          "r",
          review("r", {
            phase: "ready",
            updatedAt,
            consolidatedReport: { issues } as MultiReviewWorkflow["consolidatedReport"],
          }),
        ],
      ]),
    });
  expect(run([{}])[0]?.bucket).toBe("needs-you");
  expect(run([])[0]?.bucket).toBe("finished");
  expect(run([], at(-25 * HOUR))).toEqual([]);
});

test.each([true, false])(
  "cancellation retains a long-paused or setup build (%s) from its transition",
  (paused) => {
    const base = sources({
      workflows: [
        association({ kind: "build-pipeline", resourceId: "b", createdAt: at(-50 * HOUR) }),
      ],
      pipelines: new Map([
        [
          "b",
          pipeline("b", {
            phase: "failed",
            error: "Build cancelled",
            cancelledAt: at(0),
            sessions: paused
              ? [{ completedAt: at(-48 * HOUR) } as BuildPipeline["sessions"][number]]
              : [],
          }),
        ],
      ]),
    });
    expect(deriveCoordinatorWorkItems(base)[0]?.finishedAt).toBe(NOW);
    expect(deriveCoordinatorWorkItems({ ...base, now: NOW + 23 * HOUR })).toHaveLength(1);
    expect(deriveCoordinatorWorkItems({ ...base, now: NOW + 24 * HOUR })).toHaveLength(0);
  },
);

test("PR follows keep independent URLs, final states and expiry when an environment is reused", () => {
  const a = "https://github.com/o/r/pull/1",
    b = "https://github.com/o/r/pull/2";
  const old = association({
    kind: "pull-request",
    resourceId: "e",
    pullRequest: {
      source: "create-pr",
      prUrl: a,
      final: { prUrl: a, prState: "merged", at: at(-HOUR) } as NonNullable<
        CoordinatorWorkflowAssociation["pullRequest"]
      >["final"],
    },
  });
  const current = association({
    kind: "pull-request",
    resourceId: "e",
    pullRequest: { source: "create-pr", prUrl: b },
  });
  const base = sources({
    workflows: [old, current],
    prReadings: new Map([
      ["e", { prUrl: b, prState: "open", hasMergeConflicts: true, checkSummary: null }],
    ]),
  });
  const items = deriveCoordinatorWorkItems(base);
  expect(items).toHaveLength(2);
  expect(items.find((x) => x.target?.type === "pull-request" && x.target.url === a)?.stage).toBe(
    "PR merged",
  );
  expect(
    items.find((x) => x.target?.type === "pull-request" && x.target.url === b)?.stage,
  ).toContain("merge conflicts");
  expect(deriveCoordinatorWorkItems({ ...base, now: NOW + 24 * HOUR })).toHaveLength(1);
});

test.each(["pending", "launched", "failed"] as const)(
  "clean ready review follows automatic PR delivery %s",
  (state) => {
    const items = deriveCoordinatorWorkItems(
      sources({
        workflows: [association({ kind: "multi-review", resourceId: "r" })],
        reviews: new Map([
          [
            "r",
            review("r", {
              phase: "ready",
              consolidatedReport: {
                issues: [],
              } as unknown as MultiReviewWorkflow["consolidatedReport"],
              autoPrLaunch: { state, fixIdentity: "f", requestId: "r", basis: "clean-review" },
            }),
          ],
        ]),
      }),
    );
    expect(items[0]?.bucket).toBe(
      state === "pending" ? "running" : state === "failed" ? "needs-you" : "finished",
    );
  },
);

test.each(["build-pipeline", "multi-review"] as const)(
  "confirmed missing remote %s has no target and expires",
  (kind) => {
    const base = sources({
      workflows: [
        association({ kind, resourceId: "gone", nodeId: "n", createdAt: at(-23 * HOUR) }),
      ],
      missingResources: new Set([`${kind}:${remoteWorkKey("n", "gone")}`]),
    });
    const item = deriveCoordinatorWorkItems(base)[0]!;
    expect(item.bucket).toBe("finished");
    expect(item.target).toBeNull();
    expect(countCoordinatorWork([item]).running).toBe(0);
    expect(deriveCoordinatorWorkItems({ ...base, now: NOW + HOUR })).toEqual([]);
  },
);

test("ready coverage gaps also need a decision", () => {
  const items = deriveCoordinatorWorkItems(
    sources({
      workflows: [association({ kind: "multi-review", resourceId: "r" })],
      reviews: new Map([
        [
          "r",
          review("r", {
            phase: "ready",
            consolidatedReport: {
              issues: [],
              testCoverageGaps: [{}],
            } as unknown as MultiReviewWorkflow["consolidatedReport"],
          }),
        ],
      ]),
    }),
  );
  expect(items[0]?.bucket).toBe("needs-you");
});

test("an unqualified remote PR summary cannot label a followed URL with another PR state", () => {
  const url = "https://github.com/o/r/pull/1";
  const items = deriveCoordinatorWorkItems(
    sources({
      workflows: [
        association({
          kind: "pull-request",
          resourceId: "e",
          nodeId: "n",
          pullRequest: { source: "create-pr", prUrl: url },
        }),
      ],
      nodes: [node("n", "Remote", [{ environmentId: "e", prState: "merged" }])],
    }),
  );
  expect(items[0]?.stage).toBe("PR · status unavailable");
  expect(items[0]?.target).toEqual({ type: "pull-request", url });
});

describe("a followed pull request whose worker is gone", () => {
  const url = "https://github.com/o/r/pull/420";
  const followed = (
    overrides: Partial<CoordinatorWorkflowAssociation> = {},
    follow: Partial<NonNullable<CoordinatorWorkflowAssociation["pullRequest"]>> = {},
  ) =>
    association({
      kind: "pull-request",
      resourceId: "gone",
      createdAt: at(-5 * HOUR),
      pullRequest: { source: "create-pr", prUrl: url, ...follow },
      ...overrides,
    });
  const merged = {
    statusNotice: { key: "merged:abc", notifiedAt: at(-HOUR) },
    terminalNotifiedAt: at(-HOUR),
  };

  test("is merged, not running, when its recorded notice says so", () => {
    const [item] = deriveCoordinatorWorkItems(sources({ workflows: [followed(merged)] }));
    expect(item).toMatchObject({
      bucket: "finished",
      stage: "PR merged",
      name: "PR #420",
      prOpen: false,
      finishedAt: NOW - HOUR,
      target: { type: "pull-request", url },
    });
  });

  test.each([false, true])(
    "newer final merge supersedes a closed notice (grouped: %s)",
    (grouped) => {
      const old = followed({
        statusNotice: { key: "closed:abc", notifiedAt: at(-3 * HOUR) },
        terminalNotifiedAt: at(-3 * HOUR),
      });
      const captured = { prUrl: url, prState: "merged" as const, at: at(-HOUR) };
      const workflows = grouped
        ? [
            old,
            followed(
              { createdAt: at(-2 * HOUR), terminalNotifiedAt: at(-HOUR) },
              { final: captured },
            ),
          ]
        : [{ ...old, pullRequest: { ...old.pullRequest!, final: captured } }];
      expect(deriveCoordinatorWorkItems(sources({ workflows }))[0]?.stage).toBe("PR merged");
    },
  );

  test.each([false, true])(
    "a newer follow supersedes old closed history (merged: %s)",
    (isMerged) => {
      const old = followed({
        statusNotice: { key: "closed:abc", notifiedAt: at(-3 * HOUR) },
        terminalNotifiedAt: at(-3 * HOUR),
      });
      const newer = followed({
        createdAt: at(-2 * HOUR),
        ...(isMerged ? merged : {}),
      });
      for (const workflows of [
        [old, newer],
        [newer, old],
      ]) {
        expect(deriveCoordinatorWorkItems(sources({ workflows }))[0]).toMatchObject({
          bucket: isMerged ? "finished" : "running",
          stage: isMerged ? "PR merged" : "PR · status unavailable",
        });
      }
    },
  );

  test("capturing a deletion reading does not revive expired terminal history", () => {
    const old = at(-FINISHED_WORK_RETENTION_MS - HOUR);
    expect(
      deriveCoordinatorWorkItems(
        sources({
          workflows: [
            followed(
              {
                createdAt: old,
                statusNotice: { key: "merged:abc", notifiedAt: old },
                terminalNotifiedAt: old,
              },
              { final: { prUrl: url, prState: "merged", at: at(0) } },
            ),
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("a final outcome at creation time wins the timestamp tie", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          followed(
            {
              createdAt: at(-HOUR),
              terminalNotifiedAt: at(-HOUR),
            },
            { final: { prUrl: url, prState: "merged", at: at(-HOUR) } },
          ),
        ],
      }),
    );
    expect(item?.stage).toBe("PR merged");
  });

  test("a deletion with unavailable state keeps the last known outcome", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          followed(merged, {
            final: { prUrl: url, prState: null, at: at(0) },
          }),
        ],
      }),
    );
    expect(item?.stage).toBe("PR merged");
  });

  test("is closed when its recorded notice says so", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          followed({
            statusNotice: { key: "closed:abc", notifiedAt: at(-HOUR) },
            terminalNotifiedAt: at(-HOUR),
          }),
        ],
      }),
    );
    expect(item).toMatchObject({ bucket: "finished", stage: "PR closed" });
  });

  test("uses the final reading captured at deletion when no notice recorded the end", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          followed(
            { terminalNotifiedAt: at(-HOUR) },
            { final: { prUrl: url, prState: "merged", name: "feature", at: at(-HOUR) } },
          ),
        ],
      }),
    );
    expect(item).toMatchObject({
      bucket: "finished",
      stage: "PR merged",
      name: "PR #420 · feature",
    });
  });

  test("does not take the state of another pull request from its final reading", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          followed(
            { terminalNotifiedAt: at(-HOUR) },
            { final: { prUrl: `${url}0`, prState: "merged", at: at(-HOUR) } },
          ),
        ],
      }),
    );
    expect(item).toMatchObject({ bucket: "finished", stage: "PR · no longer followed" });
  });

  test.each([
    ["no reading at all", {}],
    ["a last reading of open", { final: { prUrl: url, prState: "open" as const, at: at(-HOUR) } }],
  ])("an ended follow with %s is finished and does not claim an outcome", (_name, follow) => {
    const [item] = deriveCoordinatorWorkItems(
      sources({ workflows: [followed({ terminalNotifiedAt: at(-HOUR) }, follow)] }),
    );
    expect(item).toMatchObject({
      bucket: "finished",
      stage: "PR · no longer followed",
      prOpen: false,
      target: { type: "pull-request", url },
    });
  });

  test("an ended follow that never saw a pull request says so", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          association({
            kind: "pull-request",
            resourceId: "gone",
            terminalNotifiedAt: at(-HOUR),
            pullRequest: { source: "create-pr" },
          }),
        ],
      }),
    );
    expect(item).toMatchObject({
      bucket: "finished",
      target: null,
      unavailableReason: "No pull request was recorded.",
    });
  });

  test("a live follow with no reading stays running", () => {
    const [item] = deriveCoordinatorWorkItems(sources({ workflows: [followed()] }));
    expect(item).toMatchObject({ bucket: "running", stage: "PR · status unavailable" });
  });

  test("a live reading of the same pull request wins over a recorded end", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [followed(merged)],
        environments: new Map([["gone", environment("gone", { prUrl: url, prState: "open" })]]),
      }),
    );
    expect(item).toMatchObject({ bucket: "running", prOpen: true });
  });

  test("drops off 24 hours after its end", () => {
    const base = sources({ workflows: [followed(merged)] });
    const justBefore = NOW - HOUR + FINISHED_WORK_RETENTION_MS - 1;
    expect(deriveCoordinatorWorkItems({ ...base, now: justBefore })).toHaveLength(1);
    expect(deriveCoordinatorWorkItems({ ...base, now: justBefore + 1 })).toEqual([]);
  });
});

describe("clearing finished work", () => {
  const hidden = { workHiddenAt: at(-HOUR) };

  test("a cleared finished row is not listed or counted", () => {
    const items = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          delegated("cleared", "completed", { completedAt: at(-HOUR) }, hidden),
          delegated("kept", "completed", { completedAt: at(-HOUR) }),
        ],
        environments: new Map([
          ["cleared", environment("cleared")],
          ["kept", environment("kept")],
        ]),
      }),
    );
    expect(items.map((item) => item.name)).toEqual(["env kept"]);
    expect(countCoordinatorWork(items).finished).toBe(1);
  });

  test("a row lists every record behind it, and a new one brings it back", () => {
    const first = delegated("worker", "completed", { completedAt: at(-2 * HOUR) });
    const second = delegated("worker", "completed", { completedAt: at(-HOUR) }, hidden);
    const environments = new Map([["worker", environment("worker")]]);
    const [item] = deriveCoordinatorWorkItems(
      sources({ workflows: [first, second], environments }),
    );
    expect(item?.associationIds).toEqual([first.id, second.id]);
    expect(
      deriveCoordinatorWorkItems(
        sources({ workflows: [{ ...first, ...hidden }, second], environments }),
      ),
    ).toEqual([]);
  });

  test("a cleared row comes back when its work is running again", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [delegated("worker", "completed", { completedAt: at(-HOUR) }, hidden)],
        environments: new Map([
          ["worker", environment("worker", { agentActivityState: "working" })],
        ]),
      }),
    );
    expect(item?.bucket).toBe("running");
  });

  test("finished work whose pull request is open cannot be cleared", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [delegated("worker", "completed", { completedAt: at(-HOUR) }, hidden)],
        environments: new Map([
          [
            "worker",
            environment("worker", {
              prUrl: "https://github.com/o/r/pull/1",
              prState: "open",
            }),
          ],
        ]),
      }),
    );
    expect(item).toMatchObject({ bucket: "finished", prOpen: true });
    expect(isClearableWorkItem(item!)).toBe(false);
  });
});

describe("what a worker row says about its request", () => {
  const row = (extra: Partial<CoordinatorDelegation>, createdAt = at(-HOUR)) =>
    deriveCoordinatorWorkItems(
      sources({
        workflows: [
          {
            ...delegated("worker-1", "running", extra),
            createdAt,
          },
        ],
        environments: new Map([["worker-1", environment("worker-1")]]),
      }),
    )[0]!;

  test("shows the summary, agent, model and age from the delegation", () => {
    expect(
      row({
        request: {
          summary: "Fix the parser",
          agent: "codex",
          model: "gpt-5",
          source: "requested",
        },
      }),
    ).toMatchObject({
      summary: "Fix the parser",
      agent: "codex",
      model: "gpt-5",
      overridden: true,
      age: "1h",
    });
  });

  test("a record from before the fields still renders, with an age from its request time", () => {
    const item = row({});
    expect(item.summary).toBeUndefined();
    expect(item.agent).toBeUndefined();
    expect(item.model).toBeUndefined();
    expect(item.overridden).toBeUndefined();
    expect(item.age).toBe("1h");
    expect(item.stage).toBe("Worker · running");
  });

  test("the summary is the newest request's; the selection keeps the newest that named a model", () => {
    const launched = {
      ...delegated("worker-1", "completed", {
        request: { summary: "Build it", agent: "claude", model: "opus" },
      }),
      id: "launch",
    };
    const followUp = {
      ...delegated("worker-1", "running", {
        requestedAt: at(-60_000),
        request: { summary: "Now add tests", agent: "claude" },
      }),
      id: "follow-up",
    };
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [launched, followUp],
        environments: new Map([["worker-1", environment("worker-1")]]),
      }),
    );
    expect(item).toMatchObject({ summary: "Now add tests", agent: "claude", model: "opus" });
  });

  test("a finished row says how long ago, and offers no Stop", () => {
    const item = row({ completedAt: at(-2 * HOUR), state: "completed" });
    expect(item.bucket).toBe("finished");
    expect(item.age).toBe("2h ago");
    expect(item.stop).toBeUndefined();
  });

  test("a build row shows its agent", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [association({ kind: "build-pipeline", resourceId: "p1" })],
        pipelines: new Map([["p1", pipeline("p1", { agentType: "claude" })]]),
      }),
    );
    expect(item).toMatchObject({ kind: "build", agent: "claude", age: "2h" });
  });

  test("an unreadable creation time has no age rather than a fifty-year one", () => {
    expect(workAge(0, false, NOW)).toBeUndefined();
    expect(workAge(NOW, false, NOW)).toBe("under 1m");
    expect(workAge(NOW, true, NOW)).toBe("just now");
    expect(workAge(NOW - 3 * 24 * HOUR, false, NOW)).toBe("3d");
  });
});

describe("Stop on a worker row", () => {
  test("names every tab with a running turn the coordinator has not already stopped", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          { ...delegated("worker-1", "running"), id: "one" },
          {
            ...delegated("worker-1", "running", { workerTabId: "second" }),
            id: "two",
          },
          {
            ...delegated("worker-1", "running", {
              workerTabId: "stopping",
              stopRequestedAt: at(-1),
            }),
            id: "three",
          },
        ],
        environments: new Map([["worker-1", environment("worker-1")]]),
      }),
    );
    expect(item?.stop).toEqual({
      environmentId: "worker-1",
      tabIds: ["tab-worker-1", "second"],
    });
  });

  test("carries the node for a remote worker", () => {
    const [item] = deriveCoordinatorWorkItems(
      sources({
        workflows: [{ ...delegated("leaf-env", "running"), nodeId: "bk_leaf" }],
        nodes: [node("bk_leaf", "Studio", [{ environmentId: "leaf-env" }])],
      }),
    );
    expect(item?.stop).toEqual({
      environmentId: "leaf-env",
      tabIds: ["tab-leaf-env"],
      nodeId: "bk_leaf",
    });
  });

  test("a row already stopping or whose environment is gone offers no Stop", () => {
    const stopping = deriveCoordinatorWorkItems(
      sources({
        workflows: [delegated("worker-1", "running", { stopRequestedAt: at(-1) })],
        environments: new Map([["worker-1", environment("worker-1")]]),
      }),
    )[0]!;
    expect(stopping.stage).toBe("Worker · stopping");
    expect(stopping.stop).toBeUndefined();
    const gone = deriveCoordinatorWorkItems(
      sources({
        workflows: [
          {
            ...delegated("worker-1", "running"),
            workerOutcome: { deletedAt: at(-1) } as never,
          },
        ],
      }),
    )[0]!;
    expect(gone.stop).toBeUndefined();
  });
});

describe("a remote worker's waiting prompt", () => {
  const workflows = [{ ...delegated("leaf-env", "running"), nodeId: "bk_leaf" }];
  const nodes = [node("bk_leaf", "Studio", [{ environmentId: "leaf-env" }])];

  test("moves its row to Needs you by the node's key, not a local id", () => {
    expect(
      deriveCoordinatorWorkItems(
        sources({
          workflows,
          nodes,
          promptEnvironmentIds: new Set([remoteWorkKey("bk_leaf", "leaf-env")]),
        }),
      )[0]?.bucket,
    ).toBe("needs-you");
    // A local environment with the same id says nothing about the remote one.
    expect(
      deriveCoordinatorWorkItems(
        sources({ workflows, nodes, promptEnvironmentIds: new Set(["leaf-env"]) }),
      )[0]?.bucket,
    ).toBe("running");
  });
});

describe("workerTabTarget", () => {
  const environments = [{ id: "local", projectId: "project-1" }];
  const remoteNode = {
    nodeId: "bk_leaf" as NodeSummary["nodeId"],
    available: true,
    environments: [
      {
        ref: { backendId: "bk_leaf", environmentId: "leaf-env" },
        projectId: "leaf-project",
        deleting: false,
      },
    ] as NodeSummary["environments"],
  };
  const lookup = { environments, nodes: [remoteNode] };

  test("a worker here opens its tab", () => {
    expect(workerTabTarget({ environmentId: "local", tabId: "t", title: "w" }, lookup)).toEqual({
      type: "worker-tab",
      projectId: "project-1",
      environmentId: "local",
      tabId: "t",
    });
  });

  test("a worker on a node opens through that node, with its project", () => {
    expect(
      workerTabTarget(
        { environmentId: "leaf-env", tabId: "t", nodeId: "bk_leaf", title: "w" },
        lookup,
      ),
    ).toEqual({
      type: "remote",
      nodeId: "bk_leaf",
      projectId: "leaf-project",
      environmentId: "leaf-env",
      title: "w",
      workTarget: {
        type: "worker-tab",
        projectId: "leaf-project",
        environmentId: "leaf-env",
        tabId: "t",
      },
    });
  });

  test("anything it cannot reach is null", () => {
    // A remote id with no node named (an older notice) is not a local worker.
    expect(workerTabTarget({ environmentId: "leaf-env", title: "w" }, lookup)).toBeNull();
    expect(
      workerTabTarget({ environmentId: "gone", nodeId: "bk_leaf", title: "w" }, lookup),
    ).toBeNull();
    expect(
      workerTabTarget({ environmentId: "leaf-env", nodeId: "bk_other", title: "w" }, lookup),
    ).toBeNull();
    expect(
      workerTabTarget(
        { environmentId: "leaf-env", nodeId: "bk_leaf", title: "w" },
        { environments, nodes: [{ ...remoteNode, available: false }] },
      ),
    ).toBeNull();
    expect(
      workerTabTarget(
        { environmentId: "leaf-env", nodeId: "bk_leaf", title: "w" },
        {
          environments,
          nodes: [
            {
              ...remoteNode,
              environments: [{ ...remoteNode.environments[0]!, deleting: true }],
            },
          ],
        },
      ),
    ).toBeNull();
    expect(
      workerTabTarget(
        { environmentId: "local", title: "w" },
        { environments: [{ ...environments[0]!, deletionRequestedAt: at(-1) }], nodes: [] },
      ),
    ).toBeNull();
  });
});

describe("nextWakeLine", () => {
  const worker = (name: string, openDelegations: number) =>
    ({ kind: "worker", name, openDelegations }) as CoordinatorWorkItem;

  test("names one worker, counts several, and says nothing with none out", () => {
    expect(nextWakeLine([])).toBeNull();
    expect(nextWakeLine([worker("api-fix", 0)])).toBeNull();
    expect(nextWakeLine([worker("api-fix", 1)])).toBe("Next wake when api-fix finishes");
    expect(nextWakeLine([worker("api-fix", 1), worker("b", 1)])).toBe(
      "Next wake when api-fix or 1 other finish",
    );
    expect(nextWakeLine([worker("api-fix", 2), worker("b", 1), worker("c", 1)])).toBe(
      "Next wake when api-fix or 2 others finish",
    );
    expect(
      nextWakeLine([{ kind: "build", name: "x", openDelegations: 1 } as CoordinatorWorkItem]),
    ).toBeNull();
  });
});
