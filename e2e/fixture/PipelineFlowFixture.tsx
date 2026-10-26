import { useEffect, useState } from "react";
import type { BuildPipeline, PipelineSession } from "@orkestrator/protocol/build-pipeline";
import type { CreateTabOptions } from "../../apps/web/src/contexts/TerminalContext";
import { TerminalProvider, useTerminalContext } from "../../apps/web/src/contexts/TerminalContext";
import { BuildChatTab } from "../../apps/web/src/components/build-pipeline/BuildChatTab";
import { useBuildPipelineStore } from "../../apps/web/src/stores/buildPipelineStore";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";
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

function scenario(): BuildPipeline {
  const name = new URLSearchParams(window.location.search).get("scenario");
  if (name === "loops") return loops();
  if (name === "new") return base({ phase: "waiting-for-setup", sessions: [] });
  return fanout();
}

function installBackend(pipeline: BuildPipeline) {
  window.__pipelineCommands = [];
  window.orkestrator = {
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      window.__pipelineCommands!.push({ command, args });
      const current = useBuildPipelineStore.getState().pipelines.get(pipeline.id) ?? pipeline;
      const next = (changes: Partial<BuildPipeline>) =>
        ({ ...current, ...changes, backendRevision: current.backendRevision + 1 }) as T;
      switch (command) {
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

function TabRecorder() {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    window.__openedTabs = [];
    setCreateTab((type, options) => {
      window.__openedTabs!.push({ type, options });
      return true;
    });
    return () => setCreateTab(null);
  }, [setCreateTab]);
  return null;
}

export function PipelineFlowFixture() {
  const [pipeline] = useState(scenario);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    installBackend(pipeline);
    useFlowGraphViewStore.setState({ views: new Map(), collapsed: new Set() });
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set([pipeline.environmentId]),
    });
    const shipped = pipeline.sessions.some((session) => session.phase === "pr");
    useEnvironmentStore.setState({
      environments: [
        {
          id: pipeline.environmentId,
          projectId: pipeline.projectId,
          prUrl: shipped ? "https://github.com/acme/app/pull/42" : null,
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
              prUrl: "https://github.com/acme/app/pull/42",
              prState: "open",
              hasMergeConflicts: false,
              checkSummary: { passed: 2, total: 4, pending: 1 },
            },
          ],
        ]),
      });
    }
    setReady(true);
  }, [pipeline]);
  if (!ready) return null;
  return (
    <TerminalProvider>
      <TabRecorder />
      <main className="h-screen w-full bg-background text-foreground">
        <BuildChatTab
          data={{
            pipelineId: pipeline.id,
            environmentId: pipeline.environmentId,
            taskId: pipeline.taskId,
            isLocal: true,
          }}
          isActive
        />
      </main>
    </TerminalProvider>
  );
}
