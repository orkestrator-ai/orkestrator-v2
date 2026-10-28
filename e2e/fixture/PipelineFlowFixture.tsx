import { useEffect, useState } from "react";
import { DndContext } from "@dnd-kit/core";
import { PaneTree } from "../../apps/web/src/components/pane-layout/PaneTree";
import { usePaneLayoutStore } from "../../apps/web/src/stores/paneLayoutStore";
import type { PaneSplit } from "../../apps/web/src/types/paneLayout";
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { CreateTabOptions } from "../../apps/web/src/contexts/TerminalContext";
import { TerminalProvider, useTerminalContext } from "../../apps/web/src/contexts/TerminalContext";
import { MultiReviewTab } from "../../apps/web/src/components/review/MultiReviewTab";
import { BUILD_PIPELINE_VERSION } from "../../apps/web/src/stores/buildPipelineStore";
import { BuildChatTab } from "../../apps/web/src/components/build-pipeline/BuildChatTab";
import { useBuildPipelineStore } from "../../apps/web/src/stores/buildPipelineStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
import { useKanbanStore } from "../../apps/web/src/stores/kanbanStore";
import { TEST_STRUCTURED_REVIEW_REPORT } from "../../apps/web/src/components/build-pipeline/structured-review-test-fixture";
import { validationRun } from "../../apps/web/src/components/build-pipeline/pipeline-test-fixture";
import { usePrMonitorStore } from "../../apps/web/src/stores/prMonitorStore";
import { useFlowGraphViewStore } from "../../apps/web/src/stores/flowGraphViewStore";
import type { Environment } from "../../apps/web/src/types";

/**
 * A build pipeline in one of a few shapes, for the pipeline flow graph's
 * browser checks. `?scenario=` picks it:
 *
 * - `fanout`: a multi-model review in progress — a running reviewer, a failed
 *   one, one queued and one starting — with Verify, Ship and the PR ahead.
 * - `loops`: a finished pipeline that went round the fix loop once, with its
 *   pull request open and CI failing.
 * - `new`: a pipeline still setting up its environment.
 * - `building`: Build running on Claude Opus at high effort, with live usage;
 *   `&usage=none` before its provider has reported any.
 * - `rewound-loop`: round 1's Verify restarted after round 2 failed, so four
 *   consecutive steps (Verify, Fix 2, Review 2, Verify 2) are one previous
 *   attempt beside the rerun.
 * - `code-rewind`: a finished single-review pipeline whose Build wrote the
 *   package plan and recorded the commit it started from, for "Rewind code to
 *   here" and "Prepare package again".
 *
 * Every backend command lands in `window.__pipelineCommands`, and every tab the
 * graph asks to open in `window.__openedTabs`.
 */

declare global {
  interface Window {
    __pipelineCommands?: Array<{ command: string; args: unknown }>;
    __openedTabs?: Array<{ type: string; options?: CreateTabOptions }>;
  }
}

const START = Date.parse("2026-10-26T09:00:00.000Z");
const at = (seconds: number) => new Date(START + seconds * 1_000).toISOString();

function message(id: string, text: string) {
  return { id, role: "assistant", parts: [{ type: "text", content: text }] };
}

function stage(
  phase: PipelineSession["phase"],
  key: string,
  start: number,
  duration: number | null,
  overrides: Partial<PipelineSession> = {},
): PipelineSession {
  return {
    phase,
    agent: "claude",
    model: "opus",
    iteration: 0,
    sessionKey: key,
    sdkSessionId: `${key}-session`,
    status: duration === null ? "running" : "idle",
    startedAt: at(start),
    ...(duration === null ? {} : { completedAt: at(start + duration) }),
    label: `${key} label`,
    messages: [message(`${key}-1`, `Transcript of ${key}.`)],
    messageRevision: 1,
    ...overrides,
  };
}

const SNAPSHOT = {
  title: "Build pipeline flow graph",
  description:
    "Make the build pipeline tab look like **Multi Review**: a flow graph and an inspector.",
  acceptanceCriteria: "- Left-to-right graph\n- Inspector below",
  comments: [{ text: "Remember the *mobile* layout." }],
  images: [],
};

function base(overrides: Partial<BuildPipeline>): BuildPipeline {
  return {
    id: "flow-pipeline",
    taskId: "flow-task",
    projectId: "flow-project",
    environmentId: "flow-environment",
    environmentType: "local",
    agentType: "claude",
    phase: "building",
    sessions: [],
    currentSessionIndex: 0,
    iteration: 0,
    maxIterations: 3,
    createdAt: at(0),
    taskTitle: SNAPSHOT.title,
    taskSnapshot: SNAPSHOT,
    backendRevision: 1,
    controller: "backend",
    ...overrides,
  };
}

const PANEL = [
  { agent: "claude" as const, model: "opus" },
  { agent: "codex" as const, model: "gpt-6.1-sol" },
  { agent: "pi" as const, model: "kimi-k3" },
  { agent: "cursor" as const, model: "grok-4.6" },
];

const FAILURE = "Reviewer process exited with code 137\nOut of memory while reading the package";

function fanout(): BuildPipeline {
  return base({
    phase: "reviewing",
    reviewers: PANEL,
    currentSessionIndex: 2,
    sessions: [
      stage("build", "build", 30, 600),
      stage("fix", "prep", 640, 120, { label: "Package Preparation Session" }),
      stage("review", "rev-1", 800, null, { label: "Review 1", tokenCount: 81_000 }),
      stage("review", "rev-2", 800, 60, {
        label: "Review 2",
        agent: "codex",
        model: "gpt-6.1-sol",
        reviewerOutcome: "failed",
        error: FAILURE,
      }),
    ],
    reviewFanout: {
      reviewers: [
        { id: "r1", agent: "claude", model: "opus", status: "running", sessionKey: "rev-1" },
        {
          id: "r2",
          agent: "codex",
          model: "gpt-6.1-sol",
          status: "failed",
          error: FAILURE,
          sessionKey: "rev-2",
        },
        {
          id: "r3",
          agent: "pi",
          model: "kimi-k3",
          status: "pending",
          admissionState: "queued",
          queuePosition: 1,
        },
        {
          id: "r4",
          agent: "cursor",
          model: "grok-4.6",
          status: "pending",
          admissionState: "admitting",
        },
      ],
    },
  });
}

function loops(): BuildPipeline {
  return base({
    phase: "complete",
    iteration: 1,
    currentSessionIndex: 8,
    sessions: [
      stage("build", "build", 30, 600),
      stage("review", "review", 640, 120, {
        label: "Review Session",
        reviewIssueCounts: { P0: 0, P1: 2, P2: 1 },
      }),
      stage("address", "address", 770, 200),
      stage("verify", "verify", 980, 90),
      stage("fix", "fix", 1080, 300, { iteration: 1 }),
      stage("review", "review-2", 1390, 100, {
        iteration: 1,
        label: "Review Session",
        reviewIssueCounts: { P0: 0, P1: 0, P2: 0 },
      }),
      stage("verify", "verify-2", 1500, 80, { iteration: 1 }),
      stage("pr", "ship", 1590, 60, { iteration: 1 }),
      stage("resolve-conflicts", "conflicts", 1660, 90, { iteration: 1 }),
    ],
    verificationResult: "pass",
  });
}

function nestedRewinds(): BuildPipeline {
  const previous = (id: string) => ({ supersededBy: id, supersededAt: at(1800) });
  return base({
    phase: "verifying",
    currentSessionIndex: 5,
    sessions: [
      stage("build", "outer-build", 30, 50, previous("outer")),
      stage("review", "review-failed", 90, 50, {
        ...previous("inner"),
        label: "Review 1",
        reviewPassId: "pass",
        reviewerOutcome: "failed",
      }),
      stage("review", "review-retry", 150, 50, {
        ...previous("inner"),
        label: "Review 1",
        reviewPassId: "pass",
        reviewerOutcome: "completed",
      }),
      stage("verify", "inner-verify", 210, 50, previous("inner")),
      stage("review", "outer-review", 270, 50, previous("outer")),
      stage("verify", "live-verify", 330, null),
    ],
    rewinds: [
      {
        id: "inner",
        at: at(900),
        fromPhase: "failed",
        fromIteration: 1,
        iteration: 0,
        step: { kind: "session", phase: "review" },
        supersededSessions: 3,
        validationRun: validationRun({ error: "Retained validation failure", status: "failed" }),
      },
      {
        id: "outer",
        at: at(1800),
        fromPhase: "verifying",
        fromIteration: 0,
        iteration: 0,
        step: { kind: "session", phase: "build" },
        supersededSessions: 2,
      },
    ],
  });
}

function validationRewind(reviewing: boolean): BuildPipeline {
  const pipeline = fanout();
  pipeline.rewinds = [
    {
      id: "validation-rewind",
      at: at(780),
      fromPhase: "building",
      fromIteration: 0,
      iteration: 0,
      step: { kind: "validation", implementationPhase: "build" },
      supersededSessions: 0,
      replacementValidationRunId: "replacement-validation",
      validationRun: validationRun({
        id: "retained-validation",
        startedAt: at(765),
        completedAt: at(775),
        status: "failed",
        error: "Retained validation failure",
      }),
    },
  ];
  pipeline.validationRun = validationRun({
    id: "replacement-validation",
    startedAt: at(780),
    status: reviewing ? "completed" : "running",
    completedAt: reviewing ? at(790) : undefined,
  });
  pipeline.sessions = reviewing ? pipeline.sessions : pipeline.sessions.slice(0, 1);
  pipeline.currentSessionIndex = pipeline.sessions.length - 1;
  if (reviewing) {
    pipeline.reviewers = PANEL.slice(0, 2);
    pipeline.reviewFanout!.reviewers = pipeline.reviewFanout!.reviewers.slice(0, 2);
    pipeline.reviewFanout!.reviewers.forEach((reviewer) => {
      reviewer.status = "running";
      delete reviewer.error;
    });
    pipeline.sessions
      .filter((session) => session.phase === "review")
      .forEach((session) => {
        session.status = "running";
        delete session.completedAt;
        delete session.error;
        delete session.reviewerOutcome;
      });
  } else {
    pipeline.phase = "building";
    delete pipeline.reviewFanout;
  }
  return pipeline;
}

function scenario(): BuildPipeline {
  const name = new URLSearchParams(window.location.search).get("scenario");
  if (name === "nested-rewinds") return nestedRewinds();
  if (name === "validation-rewind") return validationRewind(false);
  if (name === "review-after-validation-rewind") return validationRewind(true);
  if (name === "failed-review") {
    const pipeline = fanout();
    pipeline.phase = "failed";
    pipeline.error = "Consolidation could not read the review package";
    pipeline.failureContext = {
      phase: "reviewing",
      kind: "stage-transition",
      sessionId: "consolidation-session",
    };
    pipeline.sessions = [
      ...pipeline.sessions.map((session) =>
        session.phase === "review"
          ? {
              ...session,
              status: "idle" as const,
              reviewerOutcome: "completed" as const,
            }
          : session,
      ),
      stage("review", "consolidation", 900, 30, { label: "Consolidation", status: "error" }),
    ];
    pipeline.currentSessionIndex = pipeline.sessions.length - 1;
    pipeline.reviewFanout!.reviewers = pipeline.reviewFanout!.reviewers.map((reviewer) => ({
      ...reviewer,
      status: "completed",
      report: TEST_STRUCTURED_REVIEW_REPORT,
    }));
    return pipeline;
  }
  if (name === "validation") {
    const pipeline = fanout();
    pipeline.sessions = pipeline.sessions.slice(0, 2);
    pipeline.currentSessionIndex = 1;
    delete pipeline.reviewFanout;
    pipeline.validationRun = validationRun({
      status: "running",
      startedAt: at(770),
      completedAt: undefined,
    });
    return pipeline;
  }
  if (name === "images") {
    const pipeline = fanout();
    pipeline.taskSnapshot = {
      ...SNAPSHOT,
      images: [
        {
          filename: "reference.svg",
          data: btoa(
            '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
          ),
        },
        {
          filename: "reference.bmp",
          data: "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==",
        },
      ],
    };
    return pipeline;
  }
  if (name === "building") {
    const reported = new URLSearchParams(window.location.search).get("usage") !== "none";
    return base({
      phase: "building",
      sessions: [
        stage("build", "build", 30, null, {
          reasoningEffort: "high",
          ...(reported ? { tokenCount: 48_200 } : {}),
        }),
      ],
    });
  }
  if (name === "rewound-loop") {
    const previous = { supersededBy: "loop-rewind", supersededAt: at(1500) };
    return base({
      phase: "verifying",
      currentSessionIndex: 6,
      sessions: [
        stage("build", "build", 30, 300),
        stage("review", "review", 340, 200),
        stage("verify", "verify-1", 560, 100, { ...previous, verificationResult: "fail" }),
        stage("fix", "fix-2", 680, 200, { ...previous, iteration: 1 }),
        stage("review", "review-2", 900, 200, { ...previous, iteration: 1 }),
        stage("verify", "verify-2", 1120, 100, {
          ...previous,
          iteration: 1,
          status: "error",
          error: "Verification failed after 2 iterations",
        }),
        stage("verify", "verify-1-rerun", 1510, null),
      ],
      rewinds: [
        {
          id: "loop-rewind",
          at: at(1500),
          fromPhase: "failed",
          fromIteration: 1,
          iteration: 0,
          step: { kind: "session", phase: "verify" },
          sessionKey: "verify-1",
          supersededSessions: 4,
        },
      ],
    });
  }
  if (name === "code-rewind") {
    return base({
      phase: "complete",
      currentSessionIndex: 2,
      sessions: [
        stage("build", "build", 30, 600, {
          headAtStart: "a".repeat(40),
          producedReviewPackagePlan: true,
        }),
        stage("review", "review", 640, 300, { headAtStart: "b".repeat(40) }),
        stage("verify", "verify", 960, 200, { headAtStart: "c".repeat(40) }),
      ],
    });
  }
  if (name === "loops") return loops();
  if (name === "new") return base({ phase: "waiting-for-setup", sessions: [] });
  return fanout();
}

function installBackend(pipeline: BuildPipeline) {
  let authoritative = pipeline;
  const save = (next: BuildPipeline) => {
    authoritative = next;
    sessionStorage.setItem("pipeline-flow-snapshot", JSON.stringify(next));
    return next;
  };
  window.__pipelineCommands = [];
  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      window.__pipelineCommands!.push({ command, args });
      const current = authoritative;
      const next = (changes: Partial<BuildPipeline>) =>
        save({ ...current, ...changes, backendRevision: current.backendRevision + 1 }) as T;
      switch (command) {
        case "get_build_pipeline":
          return {
            id: current.id,
            projectId: current.projectId,
            environmentId: current.environmentId,
            version: BUILD_PIPELINE_VERSION,
            revision: current.backendRevision,
            updatedAt: at(1800),
            snapshot: current,
          } as T;
        case "restart_build_pipeline_step":
          return next({});
        case "preview_build_pipeline_code_rewind":
          return {
            pipelineId: current.id,
            sessionKey: args?.stageId,
            iteration: 0,
            targetCommit: "a".repeat(40),
            head: "c".repeat(40),
            commits: [
              { sha: "c".repeat(40), subject: "fix: address the review" },
              { sha: "b".repeat(40), subject: "feat: draw the flow graph" },
            ],
            commitCount: 2,
            upstream: { ref: "origin/flow", droppedCommits: 2 },
          } as T;
        case "rewind_build_pipeline_code":
          return next({ phase: "building" });
        case "cancel_build_pipeline":
          return next({
            phase: "failed",
            error: "Build cancelled by user",
            failureContext: undefined,
            pausedFromPhase: undefined,
          });
        case "fixture_progress": {
          const nextPipeline = save({
            ...current,
            backendRevision: current.backendRevision + 1,
            reviewFanout: {
              ...current.reviewFanout!,
              reviewers: current.reviewFanout!.reviewers.map((reviewer) =>
                reviewer.id === "r1"
                  ? {
                      ...reviewer,
                      status: "completed" as const,
                      report: TEST_STRUCTURED_REVIEW_REPORT,
                    }
                  : reviewer,
              ),
            },
            sessions: current.sessions.map((session) =>
              session.sessionKey === "rev-1"
                ? {
                    ...session,
                    status: "idle" as const,
                    completedAt: at(1000),
                    reviewerOutcome: "completed" as const,
                    messages: [message("rev-1-final", "Finished while inactive.")],
                    messageRevision: 2,
                  }
                : session,
            ),
          });
          // Simulate a tab eviction/missed event: the next mount must read the backend.
          useBuildPipelineStore.setState({ pipelines: new Map() });
          return nextPipeline as T;
        }
        case "pause_build_pipeline":
          return next({ phase: "paused", pausedFromPhase: "reviewing" });
        case "resume_build_pipeline":
          return next({ phase: "reviewing", pausedFromPhase: undefined });
        case "retry_build_pipeline_reviewer":
          return next({
            reviewFanout: {
              reviewers: current.reviewFanout!.reviewers.map((reviewer) =>
                reviewer.id === args?.reviewerId
                  ? {
                      id: reviewer.id,
                      agent: reviewer.agent,
                      model: reviewer.model,
                      status: "pending",
                    }
                  : reviewer,
              ),
            },
          });
        default:
          // Catalogue and status reads have nothing to say in this fixture.
          if (/^(get|list)_/.test(command)) return null as T;
          throw new Error(`Unexpected fixture command: ${command}`);
      }
    },
    listen: () => () => undefined,
  } as unknown as Window["orkestrator"];
}

function TabRecorder({ onOpen }: { onOpen: (options: CreateTabOptions) => void }) {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    window.__openedTabs = [];
    setCreateTab((type, options) => {
      window.__openedTabs!.push({ type, options });
      if (type === "multi-review" && options) onOpen(options);
      return true;
    });
    return () => setCreateTab(null);
  }, [setCreateTab, onOpen]);
  return null;
}

/** Seeds the stores and the fake backend before the first render. */
function seed(): BuildPipeline {
  const params = new URLSearchParams(window.location.search);
  const stored = params.has("restore") ? sessionStorage.getItem("pipeline-flow-snapshot") : null;
  const pipeline: BuildPipeline = stored ? JSON.parse(stored) : scenario();
  if (params.has("remote")) {
    pipeline.environmentId = "remote-environment";
    pipeline.id = "remote-pipeline";
    pipeline.environmentType = "containerized";
    pipeline.sessions = pipeline.sessions.map((session) => ({
      ...session,
      sdkSessionId: `remote-${session.sessionKey}-session`,
    }));
    window.orkestratorWorkspaceTarget = {
      nodeId: "bk_leaf",
      nodeName: "Remote build node",
      path: "direct",
    };
    window.orkestratorPortal = {
      invoke: async () => {
        throw new Error("Pipeline command reached the command node instead of its workspace");
      },
      listen: () => () => undefined,
    } as unknown as Window["orkestratorPortal"];
  }
  installBackend(pipeline);
  useKanbanStore.setState({
    tasks:
      params.get("scenario") === "images"
        ? ([{ id: pipeline.taskId, ...SNAPSHOT, title: "Edited live ticket" }] as never)
        : [],
  });
  useFlowGraphViewStore.setState({ views: new Map(), collapsed: new Set() });
  useBuildPipelineStore.setState({
    pipelines: params.has("restore") ? new Map() : new Map([[pipeline.id, pipeline]]),
    buildEnvironmentIds: new Set([pipeline.environmentId]),
  });
  const shipped = pipeline.sessions.some((session) => session.phase === "pr");
  const prUrl = shipped ? "https://github.com/acme/app/pull/42" : null;
  useEnvironmentStore.setState({
    environments: [
      {
        id: pipeline.environmentId,
        projectId: pipeline.projectId,
        containerId: params.has("remote") ? "remote-container" : undefined,
        prUrl,
        prState: shipped ? "open" : null,
      } as Environment,
    ],
  });
  if (shipped) {
    usePrMonitorStore.setState({
      states: new Map([
        [
          pipeline.environmentId,
          {
            environmentId: pipeline.environmentId,
            mode: "normal",
            checkInProgress: false,
            consecutiveErrors: 0,
            lastCheckAt: at(1800),
            prUrl,
            prState: "open",
            hasMergeConflicts: false,
            checkSummary: { passed: 2, total: 4, pending: 1 },
          },
        ],
      ]),
    });
  }
  return pipeline;
}

/** Production pane focus and lazy tab boundary, with deterministic pipeline data. */
function SplitPipelineViews({ pipeline }: { pipeline: BuildPipeline }) {
  useState(() => {
    const root: PaneSplit = {
      kind: "split",
      id: "pipeline-split",
      direction: "horizontal",
      sizes: [50, 50],
      depth: 1,
      children: [
        {
          kind: "leaf",
          id: "pipeline-build-pane",
          activeTabId: "build-tab",
          tabs: [
            {
              id: "build-tab",
              type: "claude-build",
              displayTitle: "Build",
              buildTabData: {
                pipelineId: pipeline.id,
                environmentId: pipeline.environmentId,
                taskId: pipeline.taskId,
                isLocal: true,
              },
            },
          ],
        },
        {
          kind: "leaf",
          id: "pipeline-review-pane",
          activeTabId: "review-tab",
          tabs: [
            {
              id: "review-tab",
              type: "multi-review",
              displayTitle: "Review pass",
              multiReviewTabData: {
                workflowId: pipeline.id,
                environmentId: pipeline.environmentId,
                pipelinePass: "review-pass-1",
                isLocal: true,
              },
            },
          ],
        },
      ],
    };
    usePaneLayoutStore.setState({
      activeEnvironmentId: pipeline.environmentId,
      environments: new Map([
        [pipeline.environmentId, { containerId: null, activePaneId: "pipeline-build-pane", root }],
      ]),
    });
    return null;
  });
  const root = usePaneLayoutStore((state) => state.environments.get(pipeline.environmentId)?.root);
  const viewed = useBuildPipelineStore((state) => state.viewedSessionIds.get(pipeline.id));
  return (
    <div className="flex h-screen flex-col">
      <output aria-label="Shell selected session">{viewed ?? "none"}</output>
      <div className="relative min-h-0 flex-1">
        <DndContext>
          {root ? (
            <PaneTree
              node={root}
              containerId={null}
              environmentId={pipeline.environmentId}
              isActive
            />
          ) : null}
        </DndContext>
      </div>
    </div>
  );
}

export function PipelineFlowFixture() {
  const [pipeline] = useState(seed);
  const [review, setReview] = useState<CreateTabOptions | null>(() =>
    new URLSearchParams(window.location.search).has("restore")
      ? { multiReviewId: pipeline.id, multiReviewPipelinePass: "review-pass-1" }
      : null,
  );
  const [visible, setVisible] = useState(true);
  return (
    <TerminalProvider>
      <TabRecorder onOpen={setReview} />
      <main className="h-screen w-full bg-background text-foreground">
        {new URLSearchParams(window.location.search).has("split") ? (
          <SplitPipelineViews pipeline={pipeline} />
        ) : review ? (
          <>
            <button onClick={() => setVisible((value) => !value)}>
              {visible ? "Switch away" : "Return to review"}
            </button>
            {!visible ? (
              <button onClick={() => void window.orkestrator!.invoke("fixture_progress")}>
                Finish in background
              </button>
            ) : null}
            {visible ? (
              <MultiReviewTab
                data={{
                  environmentId: pipeline.environmentId,
                  workflowId: pipeline.id,
                  pipelinePass: review.multiReviewPipelinePass!,
                  isLocal: true,
                }}
                isActive
              />
            ) : (
              <p>Another tab</p>
            )}
          </>
        ) : (
          <BuildChatTab
            data={{
              pipelineId: pipeline.id,
              environmentId: pipeline.environmentId,
              taskId: pipeline.taskId,
              isLocal: true,
            }}
            isActive
          />
        )}
      </main>
    </TerminalProvider>
  );
}
