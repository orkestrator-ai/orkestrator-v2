import { NativeMessage } from "../../apps/web/src/components/chat/NativeMessage";
import {
  rowlessBackgroundTaskMessages,
  type BackgroundTaskSnapshot,
} from "../../apps/web/src/lib/chat/native-message-adapters";

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

export function WorkflowAgentsFixture() {
  const params = new URLSearchParams(window.location.search);
  const tasks = params.has("before") ? before : [workflow];
  const messages = rowlessBackgroundTaskMessages(tasks, []);
  return (
    <main className="mx-auto max-w-3xl space-y-3 p-4" data-testid="workflow-agents-fixture">
      {messages.map((message) => (
        <NativeMessage key={message.id} message={message} />
      ))}
    </main>
  );
}
