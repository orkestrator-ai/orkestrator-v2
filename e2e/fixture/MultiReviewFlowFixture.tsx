import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MultiReviewPhase,
  MultiReviewReviewerTranscript,
  MultiReviewStepKind,
  MultiReviewStepTranscript,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { ReviewIssue, StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import { MultiReviewTab } from "../../apps/web/src/components/review/MultiReviewTab";
import { useMultiReviewStore } from "../../apps/web/src/stores/multiReviewStore";

/**
 * A Multi Review in any phase, for the flow graph's browser checks and
 * screenshots. `?phase=` picks the phase (`paused-prepare`, `paused-consolidate`
 * and `paused-fix` choose the paused step), `?reviewers=` the panel size.
 */

type FixturePhase = Exclude<MultiReviewPhase, "paused"> | `paused-${MultiReviewStepKind}`;

const PANEL: Array<
  Pick<MultiReviewWorkflow["reviewers"][number], "agent" | "model" | "reasoningEffort">
> = [
  { agent: "claude", model: "opus", reasoningEffort: "high" },
  { agent: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" },
  { agent: "cursor", model: "grok-4.6", reasoningEffort: "high" },
  { agent: "opencode", model: "deepseek-v4.1-flash-preview-with-a-very-long-model-name" },
  { agent: "grok", model: "grok-code-fast-2", reasoningEffort: "medium" },
  { agent: "pi", model: "kimi-k3" },
  { agent: "claude", model: "sonnet", reasoningEffort: "medium" },
  { agent: "codex", model: "gpt-6-luna", reasoningEffort: "xhigh" },
];

function issue(
  severity: ReviewIssue["severity"],
  title: string,
  file: string,
  line: number,
): ReviewIssue {
  return {
    severity,
    confidence: 90,
    category: "correctness",
    title,
    file,
    line,
    symbol: "",
    description: title,
    evidence: "Observed in the diff",
    suggestion: "Address it",
    verification: "Run the focused test",
  };
}

const ISSUES: ReviewIssue[][] = [
  [
    issue("P0", "Restart resets runtime for shared fix session", "MultiReviewTab.tsx", 312),
    issue("P1", "Paused prepare step never clears validation stop flag", "supervisor.rs", 884),
    issue(
      "P2",
      "Reviewer progress summary ignores cancelled reviewers",
      "MultiReviewTab.tsx",
      1306,
    ),
  ],
  [issue("P1", "Paused prepare step never clears validation stop flag", "supervisor.rs", 884)],
  [
    issue(
      "P1",
      "Consolidation drops coverage gaps from stopped reviewers",
      "review-fanout.ts",
      412,
    ),
    issue("P2", 'Inconsistent "Abandon" vs "Cancel" copy in footer', "MultiReviewTab.tsx", 1634),
  ],
];

function report(issues: ReviewIssue[]): StructuredReviewReport {
  return {
    reviewScope: {
      targetBranch: "main",
      baseRef: "origin/main...HEAD",
      commit: null,
      filesReviewed: ["apps/web/src/components/review/MultiReviewTab.tsx"],
      filesSkipped: [],
      filesLeftUncommitted: [],
      commandsRun: [],
      commandsNotRun: [],
      limitations: [],
    },
    whatChanged: {
      overview: "Redesigns the Multi Review tab as a flow graph",
      before: "Stacked cards",
      after: "Flow graph with an inspector",
      keyCodeChanges: [],
      userImpact: "The pipeline reads at a glance",
    },
    riskProfile: {
      changeTypes: ["ui"],
      riskAreas: [],
      overallRisk: "medium",
      reasoning: "Layout only",
    },
    testResults: { total: 12, passed: 12, failed: 0, notRun: 0, failures: [] },
    strengths: [],
    issues,
    testCoverageGaps: [{ file: "MultiReviewTab.tsx", untestedBehavior: "Stacked layout" }],
    verdict: { ready: "with-fixes", reasoning: "A few findings remain" },
    summaryOfChange: "Flow graph redesign",
    reviewSummary: "Merged reviewer findings",
  };
}

const minutesAgo = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

/** A finding a reviewer reported through `report_finding` before its report. */
function reported(issueValue: ReviewIssue, index: number, now: number) {
  return {
    id: index.toString(16).padStart(24, "a"),
    reportedAt: minutesAgo(now, 1),
    issue: issueValue,
  };
}

export function multiReviewFlowWorkflow(
  phase: FixturePhase,
  reviewerCount: number,
  now = Date.now(),
): MultiReviewWorkflow {
  const paused = phase.startsWith("paused-")
    ? (phase.slice("paused-".length) as MultiReviewStepKind)
    : undefined;
  const workflowPhase: MultiReviewPhase = paused ? "paused" : (phase as MultiReviewPhase);
  const reached = (step: "review" | "consolidate" | "fix"): boolean => {
    const order = ["prepare", "review", "consolidate", "fix"];
    const position =
      paused === "prepare"
        ? 0
        : paused === "consolidate"
          ? 2
          : paused === "fix"
            ? 3
            : (
                {
                  preparing: 0,
                  reviewing: 1,
                  consolidating: 2,
                  ready: 2,
                  fixing: 3,
                  interactive: 3,
                  completed: 3,
                  cancelling: 1,
                  cancelled: 1,
                  failed: 1,
                } as const
              )[workflowPhase as Exclude<MultiReviewPhase, "paused">];
    return order.indexOf(step) <= position;
  };
  const reviewersDone = reached("consolidate") || phase === "failed";
  // Panels larger than the eight models repeat them, up to the 32-reviewer maximum.
  const panel = Array.from({ length: reviewerCount }, (_, index) => PANEL[index % PANEL.length]!);
  const reviewers = panel.map((selection, index) => {
    const id = `reviewer-${index + 1}`;
    const base = { id, ...selection };
    if (!reached("review")) return { ...base, status: "pending" as const };
    const startedAt = minutesAgo(now, 6 - index * 0.4);
    if (phase === "failed" && index === 0) {
      return {
        ...base,
        status: "failed" as const,
        providerSessionId: `${id}-session`,
        startedAt,
        completedAt: minutesAgo(now, 2),
        tokenCount: 41_200,
        provisionalFindings: [
          reported(
            issue("P1", "Fix tab id ignores a custom fix launch", "multi-review-service.ts", 2_471),
            1,
            now,
          ),
        ],
        error:
          "The reviewer session ended before it filed a report: the provider closed the stream after 3 retries (HTTP 529, overloaded)",
      };
    }
    if (reviewersDone || index === 0 || index === 2) {
      return {
        ...base,
        status: "completed" as const,
        providerSessionId: `${id}-session`,
        startedAt,
        completedAt: minutesAgo(now, 2 - index * 0.2),
        tokenCount: 88_000 - index * 7_300,
        report: report(ISSUES[index % ISSUES.length]!),
      };
    }
    if ((phase === "cancelled" || phase === "cancelling") && index === 1) {
      return {
        ...base,
        status: "cancelled" as const,
        providerSessionId: `${id}-session`,
        startedAt,
      };
    }
    if (index === 1) {
      return {
        ...base,
        status: "running" as const,
        providerSessionId: `${id}-session`,
        dispatchState: "sent" as const,
        startedAt: minutesAgo(now, 2.8),
        tokenCount: 81_000,
        provisionalFindings: [
          reported(ISSUES[1]![0]!, 2, now),
          reported(
            issue(
              "P2",
              "Zoom level label reads 99% after reset",
              "MultiReviewFlowViewport.tsx",
              88,
            ),
            3,
            now,
          ),
        ],
      };
    }
    return { ...base, status: "pending" as const };
  });
  // While the panel is admitted, the first waiting reviewer is starting and
  // the rest hold their place in the admission queue.
  if (workflowPhase === "reviewing") {
    let position = 0;
    for (const reviewer of reviewers) {
      if (reviewer.status !== "pending") continue;
      Object.assign(
        reviewer,
        position === 0
          ? { admissionState: "admitting" }
          : { admissionState: "queued", queuePosition: position },
      );
      position += 1;
    }
  }

  const stepRuntimes: MultiReviewWorkflow["stepRuntimes"] = {
    prepare: {
      startedAt: minutesAgo(now, 8),
      ...(workflowPhase === "preparing" || paused === "prepare"
        ? { tokenCount: 21_000 }
        : { completedAt: minutesAgo(now, 6.1), tokenCount: 53_000 }),
    },
  };
  if (reached("consolidate")) {
    stepRuntimes.consolidate = {
      startedAt: minutesAgo(now, 1.8),
      ...(workflowPhase === "consolidating" || paused === "consolidate"
        ? { tokenCount: 12_400 }
        : { completedAt: minutesAgo(now, 0.9), tokenCount: 36_000 }),
    };
  }
  if (reached("fix")) {
    stepRuntimes.fix = {
      startedAt: minutesAgo(now, 0.8),
      ...(workflowPhase === "completed"
        ? { completedAt: minutesAgo(now, 0.1), tokenCount: 64_000 }
        : {}),
    };
  }
  const consolidated =
    reached("consolidate") && workflowPhase !== "consolidating" && paused !== "consolidate";
  const reviewModel = { agent: "codex" as const, model: "gpt-6-luna", reasoningEffort: "high" };
  const fixModel = { agent: "codex" as const, model: "gpt-6.1-sol", reasoningEffort: "high" };

  return {
    version: 1,
    controller: "backend",
    id: `multi-review-flow-${phase}-${reviewerCount}`,
    environmentId: "fixture-environment",
    projectId: "fixture-project",
    targetBranch: "main",
    phase: workflowPhase,
    ...(paused ? { pausedStep: paused } : {}),
    reviewers,
    reviewModel,
    reviewSessionKey: "multi-review:fixture:review",
    reviewSession: {
      ...reviewModel,
      sessionKey: "multi-review:fixture:review",
      providerSessionId: "review-session",
      requestIds: ["prepare-1"],
      status:
        workflowPhase === "preparing" || workflowPhase === "consolidating" ? "running" : "idle",
      startedAt: minutesAgo(now, 8),
    },
    fixModel,
    ...(reached("fix")
      ? {
          fixSessionKey: "multi-review:fixture:fix",
          fixSession: {
            ...fixModel,
            sessionKey: "multi-review:fixture:fix",
            providerSessionId: "fix-session",
            requestIds: ["fix-1"],
            status: workflowPhase === "fixing" ? ("running" as const) : ("idle" as const),
            startedAt: minutesAgo(now, 0.8),
          },
        }
      : {}),
    stepRuntimes,
    ...(reached("review") || workflowPhase === "preparing"
      ? {
          validationRun: {
            id: "validation-1",
            status: workflowPhase === "preparing" ? ("running" as const) : ("completed" as const),
            startedAt: minutesAgo(now, 7.5),
            plan: { headRef: "a".repeat(40), commands: [], limitations: [] },
            results: [
              ["typecheck", "passed"],
              ["lint", "passed"],
              ["test:unit", workflowPhase === "preparing" ? "running" : "passed"],
              ["cargo", "skipped"],
            ].map(([id, status]) => ({
              id: id!,
              command: `mise run ${id}`,
              status: status as "passed",
              exitCode: status === "passed" ? 0 : null,
              stdoutPath: null,
              stderrPath: null,
              stdoutBytes: 0,
              stderrBytes: 0,
              durationMs: 4_000,
              limitation: status === "skipped" ? "No Rust changes" : null,
            })),
          },
        }
      : {}),
    ...(consolidated ? { consolidatedReport: report([...ISSUES[0]!, ...ISSUES[2]!]) } : {}),
    ...(workflowPhase === "completed"
      ? { fixResult: { summary: "Addressed every finding and added regression tests." } }
      : {}),
    ...(phase === "failed"
      ? { error: "A reviewer failed; retry the failed stage to continue" }
      : {}),
    createdAt: minutesAgo(now, 8.2),
    updatedAt: minutesAgo(now, 0.1),
    backendRevision: 1,
  } as MultiReviewWorkflow;
}

const TRANSCRIPT_LINES: Array<[string, Record<string, string>] | string> = [
  ["Read", { file_path: "review-package/summary.md" }],
  ["Read", { file_path: "apps/web/src/components/review/MultiReviewTab.tsx" }],
  ["Grep", { pattern: '"pausedStep" apps/web/src' }],
  ["Read", { file_path: "apps/backend/src/core/multi-review-service.ts" }],
  "restartStep resets stepRuntimes but fixSession.startedAt is shared between the three steps…",
  ["Read", { file_path: "packages/protocol/src/multi-review.ts" }],
];

async function fixtureTranscript(
  workflowId: string,
  reviewerId: string,
  messageCount = 40,
): Promise<MultiReviewReviewerTranscript> {
  const createdAt = new Date().toISOString();
  const longTranscript = new URLSearchParams(window.location.search).has("longTranscript");
  return {
    workflowId,
    reviewerId,
    workflowPhase: "reviewing",
    agent: "codex",
    model: "gpt-6.1-sol",
    status: longTranscript ? "completed" : "running",
    transcript: "snapshot",
    sourceToken: `fixture-${messageCount}`,
    messages: longTranscript
      ? Array.from({ length: messageCount }, (_, index) => ({
          id: `long-line-${index}`,
          role: "assistant",
          content: `Transcript entry ${index + 1}. ${"Checked the review implementation and recorded the validation result. ".repeat(8)}`,
          createdAt,
        }))
      : TRANSCRIPT_LINES.map((line, index) => ({
          id: `line-${index}`,
          role: "assistant",
          content: typeof line === "string" ? line : line[0],
          createdAt,
          parts: [
            typeof line === "string"
              ? { type: "thinking", content: line }
              : {
                  type: "tool-invocation",
                  content: line[0],
                  toolName: line[0],
                  toolArgs: line[1],
                  toolState: "success",
                  toolUseId: `tool-${index}`,
                },
          ],
        })),
  };
}

const STEP_LINES: Record<MultiReviewStepKind, string[]> = {
  prepare: ["Discovering validation commands from mise.toml", "Running typecheck and lint"],
  consolidate: [
    "Merging four reviewer reports",
    "Two reviewers raised the paused-prepare finding; keeping the higher severity",
  ],
  fix: ["Addressing the P0 shared fix session runtime", "Running the focused tests"],
};

async function fixtureStepTranscript(
  workflowId: string,
  step: MultiReviewStepKind,
  messageCount = 40,
): Promise<MultiReviewStepTranscript> {
  const createdAt = new Date().toISOString();
  const longTranscript = new URLSearchParams(window.location.search).has("longTranscript");
  return {
    workflowId,
    step,
    workflowPhase: "consolidating",
    session: "own",
    agent: "codex",
    model: "gpt-6-luna",
    transcript: "snapshot",
    sourceToken: `fixture-${messageCount}`,
    messages: longTranscript
      ? Array.from({ length: messageCount }, (_, index) => ({
          id: `${step}-${index}`,
          role: "assistant",
          content: `Package transcript entry ${index + 1}. ${"Checked the validation command and recorded its output. ".repeat(8)}`,
          createdAt,
        }))
      : STEP_LINES[step].map((text, index) => ({
          id: `${step}-${index}`,
          role: "assistant",
          content: text,
          createdAt,
          parts: [{ type: "thinking", content: text }],
        })),
  };
}

export function MultiReviewFlowFixture() {
  const params = new URLSearchParams(window.location.search);
  const phase = (params.get("phase") ?? "reviewing") as FixturePhase;
  const count = Number(params.get("reviewers") ?? "4");
  const packageControls = params.has("packageControls");
  const [workflow] = useState(() => {
    const snapshot = multiReviewFlowWorkflow(phase, count);
    if (packageControls) snapshot.validationRun = undefined;
    if (params.has("manyFindings")) {
      snapshot.reviewers[0]!.report = {
        ...snapshot.reviewers[0]!.report!,
        issues: [
          ...snapshot.reviewers[0]!.report!.issues,
          ...Array.from({ length: 35 }, (_, index) =>
            issue("P2", `Additional finding ${index + 1}`, "src/additional.ts", index + 1),
          ),
        ],
      };
    }
    if (params.has("cleanReviewPr")) {
      snapshot.autoPr = true;
      snapshot.autoPrLaunch = {
        basis: "clean-review",
        state: "launched",
        requestId: `multi-review-pr:${snapshot.id}`,
        tabId: "earlier-pr",
      };
      if (params.has("cleanReport")) {
        snapshot.consolidatedReport = { ...report([]), issues: [], testCoverageGaps: [] };
      }
    }
    return snapshot;
  });
  const [isActive, setIsActive] = useState(true);
  const paneControls = params.has("paneControls");
  const transcriptControls = params.has("transcriptControls");
  const transcriptEntries = useRef(transcriptControls ? 32 : 40);
  const loadReviewerTranscript = useCallback(
    (workflowId: string, reviewerId: string) =>
      fixtureTranscript(workflowId, reviewerId, transcriptEntries.current),
    [],
  );
  const loadStepTranscript = useCallback(
    (workflowId: string, step: MultiReviewStepKind) =>
      fixtureStepTranscript(workflowId, step, transcriptEntries.current),
    [],
  );

  useEffect(() => {
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    return () => useMultiReviewStore.getState().removeWorkflow(workflow.id);
  }, [workflow]);

  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      {packageControls && (
        <div>
          <button
            onClick={() => {
              const current = useMultiReviewStore.getState().workflows.get(workflow.id)!;
              const validationRun = multiReviewFlowWorkflow("preparing", count).validationRun!;
              validationRun.results[0]!.command = `mise run ${"long-validation-command-".repeat(30)}`;
              useMultiReviewStore.getState().replaceWorkflow({
                ...current,
                validationRun,
                backendRevision: current.backendRevision + 1,
              });
            }}
          >
            Publish validation
          </button>
          <button
            onClick={() => {
              transcriptEntries.current += 1;
              const current = useMultiReviewStore.getState().workflows.get(workflow.id)!;
              useMultiReviewStore.getState().replaceWorkflow({
                ...current,
                backendRevision: current.backendRevision + 1,
              });
            }}
          >
            Append package transcript
          </button>
        </div>
      )}
      {transcriptControls && (
        <button
          onClick={() => {
            transcriptEntries.current += 1;
            const current = useMultiReviewStore.getState().workflows.get(workflow.id)!;
            useMultiReviewStore.getState().replaceWorkflow({
              ...current,
              backendRevision: (current.backendRevision ?? 0) + 1,
            });
          }}
        >
          Append transcript entry
        </button>
      )}
      {paneControls && (
        <div>
          <button onClick={() => setIsActive(!isActive)}>
            {isActive ? "Activate other pane" : "Activate review pane"}
          </button>
          <button
            onClick={() => {
              const current = useMultiReviewStore.getState().workflows.get(workflow.id)!;
              const next = multiReviewFlowWorkflow("consolidating", count);
              useMultiReviewStore.getState().replaceWorkflow({
                ...next,
                id: current.id,
                backendRevision: current.backendRevision + 1,
              });
            }}
          >
            Advance to consolidation
          </button>
          <input aria-label="Other pane input" />
        </div>
      )}
      <div hidden={!isActive} data-testid="review-pane" className="min-h-0 flex-1">
        <MultiReviewTab
          data={{ environmentId: workflow.environmentId, workflowId: workflow.id, isLocal: true }}
          isActive={isActive}
          hydrateWorkflow={async () => workflow}
          loadReviewerTranscript={loadReviewerTranscript}
          loadStepTranscript={loadStepTranscript}
        />
      </div>
    </main>
  );
}
