// What a Claude workflow task's frames mean, as opposed to what they look like.
//
// A `local_workflow` task runs its agents inside the workflow. They are not
// tasks: no `task_*` frame names them, and the CLI reports them only as rows of
// the workflow's own `workflow_progress`. Its `task_progress` frames also reuse
// two fields for agent-specific progress (CLI 2.1.326): `description` holds the latest
// agent's "phase: label" and `last_tool_name` holds its label. Read like any
// other task's frames, those renamed the workflow card on every agent update
// and dropped every agent's own details.
//
// Each agent still fires `SubagentStart`/`SubagentStop` hooks, with an
// `agent_id` equal to its row's `agentId` and, unless the script named an
// agent type, the CLI's own type `workflow-subagent`. Recorded as tasks, those
// hooks became cards that could never say anything, so they are not recorded.

import type { NativeAgentWorkflowAgentCounts } from "@orkestrator/protocol/native-agent";
import type { BackgroundTaskSnapshot, BackgroundWorkflowAgent } from "../types/index.js";
import type { BackgroundTaskSystemMessage } from "./session-manager-task-records.js";
import { LIVE_BACKGROUND_TASK_STATUSES } from "./background-task-snapshot.js";

/** The agent type Claude Code gives a workflow's agents when the script names none. */
export const WORKFLOW_SUBAGENT_TYPE = "workflow-subagent";

/**
 * Most agents kept for one workflow. The whole task map is re-sent on every
 * edge, and a workflow can run hundreds of agents; past this running and failed agents
 * take priority over other rows.
 */
export const MAX_WORKFLOW_AGENTS = 64;
/** Most rows read from one frame. The CLI keeps at most 500 log rows beside its agents. */
const MAX_WORKFLOW_PROGRESS_ROWS = 2_048;
const LABEL_MAX_CHARS = 200;
const NAME_MAX_CHARS = 256;
const LINE_MAX_CHARS = 200;
const ERROR_MAX_CHARS = 500;

const AGENT_STATES = new Set<BackgroundWorkflowAgent["state"]>([
  "start",
  "progress",
  "done",
  "error",
]);
const RUN_ENDINGS = new Set<NonNullable<BackgroundWorkflowAgent["endedWithRun"]>>([
  "completed",
  "failed",
  "stopped",
]);

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value
    .slice(0, max * 2)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  return text.length > 0 ? text : undefined;
}

/** A name is kept whole or not at all: a cut name is a different name. */
function boundedName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= NAME_MAX_CHARS && !/[\u0000-\u001f\u007f]/.test(name)
    ? name
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? Math.floor(value)
    : undefined;
}

function progressRow(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function rowIndex(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function workflowAgentRow(
  row: Record<string, unknown>,
  phases?: ReadonlyMap<number, string>,
): BackgroundWorkflowAgent | undefined {
  if (row.type !== "workflow_agent") return undefined;
  const index = rowIndex(row.index);
  if (index === undefined) return undefined;
  if (!AGENT_STATES.has(row.state as BackgroundWorkflowAgent["state"])) return undefined;
  const label = boundedText(row.label, LABEL_MAX_CHARS) ?? `agent ${index}`;
  const phaseTitle =
    boundedText(row.phaseTitle, LABEL_MAX_CHARS) ?? phases?.get(rowIndex(row.phaseIndex) ?? -1);
  const agentId = boundedName(row.agentId);
  const agentType = boundedName(row.agentType);
  const model = boundedName(row.model);
  const lastToolName = boundedName(row.lastToolName);
  const lastToolSummary = boundedText(row.lastToolSummary, LINE_MAX_CHARS);
  const error = boundedText(row.error, ERROR_MAX_CHARS);
  const tokens = count(row.tokens);
  const toolCalls = count(row.toolCalls);
  const startedAt = count(row.startedAt);
  const durationMs = count(row.durationMs);
  const endedWithRun = RUN_ENDINGS.has(row.endedWithRun as never)
    ? (row.endedWithRun as BackgroundWorkflowAgent["endedWithRun"])
    : undefined;
  return {
    index,
    label,
    state: row.state as BackgroundWorkflowAgent["state"],
    ...(phaseTitle ? { phaseTitle } : {}),
    ...(agentId ? { agentId } : {}),
    ...(agentType ? { agentType } : {}),
    ...(model ? { model } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    ...(lastToolSummary ? { lastToolSummary } : {}),
    ...(error ? { error } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(row.cached === true ? { cached: true } : {}),
    ...(row.skipped === true ? { skipped: true } : {}),
    ...(row.blocked === true ? { blocked: true } : {}),
    ...(endedWithRun ? { endedWithRun } : {}),
  };
}

function isRunningAgent(agent: BackgroundWorkflowAgent): boolean {
  return agent.state === "progress" || (agent.state === "start" && agent.startedAt !== undefined);
}

function isFailedAgent(agent: BackgroundWorkflowAgent): boolean {
  return agent.state === "error" && !agent.skipped && agent.endedWithRun === undefined;
}

type WorkflowAgentLabels = NonNullable<BackgroundTaskSnapshot["workflowAgentLabels"]>;

export interface WorkflowProgress {
  agents: BackgroundWorkflowAgent[];
  omitted: number;
  counts: NativeAgentWorkflowAgentCounts;
  ids: ReadonlySet<string>;
  labels: WorkflowAgentLabels;
}

/** Read ownership and counts before applying the display bound. */
export function parseWorkflowProgress(
  value: unknown,
  cliOmitted?: unknown,
): WorkflowProgress | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.slice(0, MAX_WORKFLOW_PROGRESS_ROWS);
  const phases = new Map<number, string>();
  for (const raw of rows) {
    const row = progressRow(raw);
    if (row?.type !== "workflow_phase") continue;
    const index = rowIndex(row.index);
    const title = boundedText(row.title, LABEL_MAX_CHARS);
    if (index !== undefined && title) phases.set(index, title);
  }
  const byIndex = new Map<number, BackgroundWorkflowAgent>();
  const ids = new Set<string>();
  for (const raw of rows) {
    const row = progressRow(raw);
    const agent = row && workflowAgentRow(row, phases);
    if (!agent) continue;
    if (agent.agentId) ids.add(agent.agentId);
    // The CLI replaces a row in place; a repeat is the newer state.
    byIndex.set(agent.index, agent);
  }

  const labels = new Map<number, Pick<BackgroundWorkflowAgent, "phaseTitle" | "agentType">>();
  const providerOmitted = count(cliOmitted) ?? 0;
  const counts: NativeAgentWorkflowAgentCounts = {
    total: byIndex.size,
    running: 0,
    queued: 0,
    finished: 0,
    failed: 0,
  };
  if (providerOmitted > 0 || value.length > rows.length) counts.partial = true;
  for (const agent of byIndex.values()) {
    const { phaseTitle, agentType } = agent;
    if (phaseTitle || agentType) labels.set(agent.index, { phaseTitle, agentType });
    if (isRunningAgent(agent)) counts.running++;
    else if (agent.state === "start") counts.queued++;
    else counts.finished++;
    if (isFailedAgent(agent)) counts.failed++;
  }

  const agents = [...byIndex.values()];
  if (agents.length > MAX_WORKFLOW_AGENTS) {
    agents.sort(
      (left, right) =>
        Number(isRunningAgent(right)) - Number(isRunningAgent(left)) ||
        Number(isFailedAgent(right)) - Number(isFailedAgent(left)) ||
        right.index - left.index,
    );
    agents.length = MAX_WORKFLOW_AGENTS;
  }
  agents.sort((left, right) => left.index - right.index);
  return {
    agents,
    omitted: Math.min(Number.MAX_SAFE_INTEGER, providerOmitted + byIndex.size - agents.length),
    counts,
    ids,
    labels,
  };
}

export function mergeWorkflowProgress(
  progress: WorkflowProgress,
  previous?: BackgroundTaskSnapshot,
) {
  const ids = new Set(progress.ids);
  for (const id of previous?.workflowAgentIds ?? []) {
    if (ids.size >= MAX_WORKFLOW_PROGRESS_ROWS) break;
    ids.add(id);
  }
  const labels = new Map(progress.labels);
  for (const [index, prior] of previous?.workflowAgentLabels ?? []) {
    const current = labels.get(index);
    if (!current && labels.size >= MAX_WORKFLOW_PROGRESS_ROWS) continue;
    labels.set(index, {
      phaseTitle: current?.phaseTitle ?? prior.phaseTitle,
      agentType: current?.agentType ?? prior.agentType,
    });
  }
  return {
    workflowAgentIds: ids,
    workflowAgentLabels: labels,
    workflowAgentCounts: progress.counts,
    workflowAgents: progress.agents.map((agent) => ({ ...agent, ...labels.get(agent.index) })),
    workflowAgentsOmitted: progress.omitted || undefined,
  };
}

/** Terminal row details the pinned CLI sends over SDK but does not write to its rollout. */
export interface WorkflowTaskDetails {
  taskId: string;
  toolUseId: string;
  workflowAgents: BackgroundWorkflowAgent[];
  workflowAgentsOmitted?: number;
  usage?: BackgroundTaskSnapshot["usage"];
}

export const MAX_WORKFLOW_TASK_DETAILS = 32;
const MAX_WORKFLOW_TASK_DETAILS_BYTES = 256 * 1024;

export function parseWorkflowTaskDetails(raw: unknown): WorkflowTaskDetails | undefined {
  const entry = progressRow(raw);
  const taskId = boundedName(entry?.taskId);
  const toolUseId = boundedName(entry?.toolUseId);
  if (!taskId || !toolUseId || !Array.isArray(entry?.workflowAgents)) return undefined;
  const workflowAgents = entry.workflowAgents.slice(0, MAX_WORKFLOW_AGENTS).flatMap((raw) => {
    const row = progressRow(raw);
    const agent = row && workflowAgentRow({ ...row, type: "workflow_agent" });
    return agent ? [agent] : [];
  });
  const workflowAgentsOmitted = count(entry.workflowAgentsOmitted);
  const usage = progressRow(entry.usage);
  const totalTokens = count(usage?.totalTokens);
  const toolUses = count(usage?.toolUses);
  const durationMs = count(usage?.durationMs);
  return {
    taskId,
    toolUseId,
    workflowAgents,
    ...(workflowAgentsOmitted ? { workflowAgentsOmitted } : {}),
    ...(totalTokens !== undefined && toolUses !== undefined && durationMs !== undefined
      ? { usage: { totalTokens, toolUses, durationMs } }
      : {}),
  };
}

export function boundWorkflowTaskDetails(entries: WorkflowTaskDetails[]): WorkflowTaskDetails[] {
  let bytes = 2;
  let first = entries.length;
  while (first > 0 && entries.length - first < MAX_WORKFLOW_TASK_DETAILS) {
    bytes += Buffer.byteLength(JSON.stringify(entries[first - 1])) + 1;
    if (bytes > MAX_WORKFLOW_TASK_DETAILS_BYTES) break;
    first--;
  }
  return entries.slice(first);
}

type WorkflowEdge = Pick<
  BackgroundTaskSystemMessage,
  "subtype" | "task_type" | "workflow_progress"
>;

/** An explicit start can replace a workflow even if its previous run still looks live. */
export function isTaskRelaunch(
  message: BackgroundTaskSystemMessage,
  previous: BackgroundTaskSnapshot,
): boolean {
  if (message.subtype !== "task_started") return false;
  if (
    isWorkflowTaskEdge(message, previous) &&
    message.run_id !== undefined &&
    previous.workflowRunId !== undefined
  ) {
    return message.run_id !== previous.workflowRunId;
  }
  return (
    message.tool_use_id !== undefined &&
    message.tool_use_id !== previous.toolUseId &&
    (!LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) ||
      (previous.toolUseId !== undefined && isWorkflowTaskEdge(message, previous)))
  );
}

/** Older runs and progress arriving after settlement cannot change a workflow. */
export function ignoreWorkflowTaskEdge(
  message: BackgroundTaskSystemMessage,
  previous: BackgroundTaskSnapshot | undefined,
): boolean {
  if (!previous || !isWorkflowTaskEdge(message, previous)) return false;
  if (message.subtype === "task_progress" && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)) {
    return true;
  }
  if (message.run_id !== undefined && previous.workflowRunId !== undefined) {
    return message.run_id !== previous.workflowRunId;
  }
  return (
    message.tool_use_id !== undefined &&
    previous.toolUseId !== undefined &&
    message.tool_use_id !== previous.toolUseId
  );
}

/** A settled workflow cannot still own queued or running work. */
export function settleWorkflowAgents(
  task: BackgroundTaskSnapshot,
  reason?: string,
): BackgroundTaskSnapshot {
  const agents = task.workflowAgents;
  if (!agents || LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) return task;
  const counts = task.workflowAgentCounts;
  const explanation = reason ?? "Workflow ended before this agent finished";
  return {
    ...task,
    workflowAgents: agents.map((agent) =>
      agent.state === "start" || agent.state === "progress"
        ? { ...agent, state: "error", endedWithRun: "stopped", error: agent.error ?? explanation }
        : agent,
    ),
    workflowAgentCounts: counts && {
      ...counts,
      finished: counts.finished + counts.running + counts.queued,
      running: 0,
      queued: 0,
    },
  };
}

/** Whether an edge belongs to a workflow task, from the edge or what came before it. */
export function isWorkflowTaskEdge(
  message: WorkflowEdge,
  previous: BackgroundTaskSnapshot | undefined,
): boolean {
  return (
    message.task_type === "local_workflow" ||
    previous?.taskType === "local_workflow" ||
    message.workflow_progress !== undefined ||
    previous?.workflowAgents !== undefined
  );
}

/**
 * The task's name after a start, progress or update edge.
 *
 * A workflow's progress `description` is its latest agent, not its name, so
 * the name its start edge gave stands. Only with no name at all is that agent
 * better than nothing.
 */
export function taskEdgeDescription(
  message: WorkflowEdge & Pick<BackgroundTaskSystemMessage, "description" | "patch">,
  previous: BackgroundTaskSnapshot | undefined,
): string | undefined {
  if (
    message.subtype === "task_progress" &&
    previous?.description &&
    isWorkflowTaskEdge(message, previous)
  ) {
    return message.patch?.description ?? previous.description;
  }
  return message.patch?.description ?? message.description ?? previous?.description;
}

/**
 * Hook-born records for agents a workflow now lists.
 *
 * A script that names an agent type gives its agents that type rather than
 * `workflow-subagent`, so their `SubagentStart` hook is recorded like any
 * other agent's until a workflow row claims the id. A record with a `taskType`
 * came from the CLI's own task frames and is a real task, so it is kept.
 */
export function workflowAgentHookTaskIds(
  tasks: Record<string, BackgroundTaskSnapshot> | undefined,
  agentIds: ReadonlySet<string> | undefined,
): string[] {
  if (!tasks || !agentIds) return [];
  const ids: string[] = [];
  for (const id of agentIds) {
    const task = tasks[id];
    if (task && task.taskType === undefined && task.subagentType !== undefined) ids.push(task.id);
  }
  return ids;
}

/** Whether a subagent hook belongs to a workflow. */
export function isWorkflowAgentHook(
  tasks: Record<string, BackgroundTaskSnapshot> | undefined,
  agentId: string,
  agentType: string | undefined,
): boolean {
  if (agentType === WORKFLOW_SUBAGENT_TYPE) return true;
  for (const task of Object.values(tasks ?? {})) {
    if (task.workflowAgentIds?.has(agentId)) return true;
  }
  return false;
}
