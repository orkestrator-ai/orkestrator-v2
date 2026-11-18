import { useState } from "react";
import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import {
  applyClaudeBackgroundTaskStates,
  normalizeNativeMessages,
  rowlessBackgroundTaskMessages,
  type BackgroundTaskSnapshot,
} from "../../apps/web/src/lib/chat/native-message-adapters";

import type { NativeMessage as TranscriptMessage } from "../../apps/web/src/lib/chat/native-message-types";

/*
 * A Claude workflow mid-run, as the snapshot describes it.
 *
 * `?before` is the shape the bridge produced before it read the workflow's
 * own progress: the latest agent as the workflow's name, and each agent's
 * `SubagentStart` hook as a card of its own with nothing to say.
 */
const startedAt = new Date(Date.now() - 691_000).toISOString();
const agentStartedAt = new Date(Date.now() - 83_000).toISOString();

const workflow = {
  id: "wz29ruejm",
  toolUseId: "toolu_fixture_workflow",
  status: "running",
  kind: "workflow",
  description: "Build investor Discover/Saved/Introductions with info requests and founder tags",
  workflowName: "build-discover",
  startedAt,
  progressSummary: "Build: introductions",
  usage: { totalTokens: 541_000, toolUses: 153, durationMs: 691_000 },
  workflowAgents: [
    {
      index: 0,
      label: "Schema and server reads",
      status: "completed",
      phase: "Foundations",
      agentRole: "Explore",
      toolUses: 41,
      totalTokens: 182_000,
      durationMs: 608_000,
    },
    {
      index: 1,
      label: "Build: discover",
      status: "running",
      phase: "Build",
      activity: "Editing src/components/discover/info-request-section.tsx",
      startedAt: agentStartedAt,
      toolUses: 38,
      totalTokens: 121_000,
    },
    {
      index: 2,
      label: "Build: saved",
      status: "running",
      phase: "Build",
      lastToolName: "Read",
      startedAt: agentStartedAt,
      toolUses: 29,
      totalTokens: 96_000,
    },
    {
      index: 3,
      label: "Build: introductions",
      status: "running",
      phase: "Build",
      activity: "Running bun test src/lib/discover",
      startedAt: agentStartedAt,
      toolUses: 45,
      totalTokens: 142_000,
    },
    { index: 4, label: "Verify and lint", status: "queued", phase: "Verify" },
  ],
} satisfies BackgroundTaskSnapshot;

const before: BackgroundTaskSnapshot[] = [
  {
    id: "a5e1",
    status: "completed",
    kind: "agent",
    agentRole: "workflow-subagent",
    startedAt,
    settledAt: new Date(Date.now() - 83_000).toISOString(),
  },
  {
    id: workflow.id,
    status: "running",
    kind: "workflow",
    description: "Build: introductions",
    workflowName: workflow.workflowName,
    startedAt,
    progressSummary: workflow.description,
    usage: workflow.usage,
  },
  ...["a10ac450e5746d4a4", "a10ac450e5746d4a5", "a10ac450e5746d4a6"].map(
    (id): BackgroundTaskSnapshot => ({
      id,
      status: "running",
      kind: "agent",
      agentRole: "workflow-subagent",
      startedAt: agentStartedAt,
    }),
  ),
];

const launch: TranscriptMessage = {
  id: "workflow-launch",
  role: "assistant",
  content: "",
  createdAt: startedAt,
  parts: [
    {
      type: "tool-invocation",
      content: "Workflow",
      toolName: "Workflow",
      toolUseId: workflow.toolUseId,
      toolArgs: { script: "fixture script" },
      toolState: "success",
      detailRef: "fixture-workflow-receipt",
    },
  ],
};

async function loadWorkflowReceipt(detailRef: string) {
  return {
    detailRef,
    toolOutput: [
      `Workflow launched in background. Task ID: ${workflow.id}`,
      `Summary: ${workflow.description}`,
      "Transcript dir: /fixture/transcripts",
      "Script file: /fixture/workflow.js",
      '(Edit this file and re-invoke Workflow with {scriptPath: "/fixture/workflow.js"}.)',
      "Run ID: fixture-run-123",
      'To resume after editing the script: Workflow({scriptPath: "/fixture/workflow.js", resumeFromRunId: "fixture-run-123"})',
    ].join("\n"),
  };
}

const settled: BackgroundTaskSnapshot = {
  ...workflow,
  status: "killed",
  settledAt: new Date().toISOString(),
  workflowAgents: [
    workflow.workflowAgents[0]!,
    {
      ...workflow.workflowAgents[1]!,
      status: "stopped",
      error: "Workflow ended before this agent finished",
      toolUses: 0,
      totalTokens: 0,
    },
    { index: 2, label: "Build: saved", status: "failed", error: "Fixture check failed" },
  ],
};

export function WorkflowAgentsFixture() {
  const params = new URLSearchParams(window.location.search);
  const [isSettled, setIsSettled] = useState(params.has("settled"));
  const outline = params.has("outline");
  const task: BackgroundTaskSnapshot = outline
    ? {
        id: workflow.id,
        description: workflow.description,
        kind: "workflow",
        status: "running",
        startedAt,
        workflowAgentCounts: { total: 5, running: 3, queued: 1, finished: 1, failed: 0 },
        workflowAgentsOmitted: 5,
      }
    : isSettled
      ? settled
      : workflow;
  const launchRows = outline
    ? []
    : normalizeNativeMessages(applyClaudeBackgroundTaskStates([launch], { [task.id]: task }));
  const messages = params.has("before")
    ? rowlessBackgroundTaskMessages(before, [])
    : [...launchRows, ...rowlessBackgroundTaskMessages([task], launchRows)];
  return (
    <main className="mx-auto max-w-3xl space-y-3 p-4" data-testid="workflow-agents-fixture">
      {messages.map((message) => (
        <NativeMessage key={message.id} message={message} loadToolDetails={loadWorkflowReceipt} />
      ))}
      {!params.has("before") && !outline && !isSettled ? (
        <button
          type="button"
          onClick={() => {
            window.history.replaceState(null, "", "?settled");
            setIsSettled(true);
          }}
        >
          Settle workflow
        </button>
      ) : null}
    </main>
  );
}
