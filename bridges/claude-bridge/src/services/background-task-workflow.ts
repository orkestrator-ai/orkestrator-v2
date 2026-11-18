// What a Claude workflow task's frames mean, as opposed to what they look like.
//
// A `local_workflow` task runs its agents inside the workflow. They are not
// tasks: no `task_*` frame names them, and the CLI reports them only as rows of
// the workflow's own `workflow_progress`. Its `task_progress` frames also reuse
// two fields for that progress (CLI 2.1.326): `description` holds the latest
// agent's "phase: label" and `last_tool_name` holds its label. Read like any
// other task's frames, those renamed the workflow card on every agent update
// and dropped every agent's own details.
//
// Each agent still fires `SubagentStart`/`SubagentStop` hooks, with an
// `agent_id` equal to its row's `agentId` and, unless the script named an
// agent type, the CLI's own type `workflow-subagent`. Recorded as tasks, those
// hooks became cards that could never say anything, so they are not recorded.

import type { BackgroundTaskSnapshot, BackgroundWorkflowAgent } from "../types/index.js";
import type { BackgroundTaskSystemMessage } from "./session-manager-messages.js";

/** The agent type Claude Code gives a workflow's agents when the script names none. */
export const WORKFLOW_SUBAGENT_TYPE = "workflow-subagent";

/**
 * Most agents kept for one workflow. The whole task map is re-sent on every
 * edge, and a workflow can run hundreds of agents; past this the live ones,
 * then the failed ones, then the most recent are kept.
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
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function workflowAgentRow(raw: unknown): BackgroundWorkflowAgent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (row.type !== "workflow_agent") return undefined;
  const index = row.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return undefined;
  if (!AGENT_STATES.has(row.state as BackgroundWorkflowAgent["state"])) return undefined;
  const label = boundedText(row.label, LABEL_MAX_CHARS) ?? `agent ${index}`;
  const phaseTitle = boundedText(row.phaseTitle, LABEL_MAX_CHARS);
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

function isLiveAgent(agent: BackgroundWorkflowAgent): boolean {
  return agent.state === "start" || agent.state === "progress";
}

/**
 * The agents one frame's `workflow_progress` lists, or nothing when the frame
 * carries no list. Each frame carries the whole list, so it replaces the last.
 * `omitted` adds the rows the CLI says it left out (`workflow_progress_omitted`,
 * on a terminal frame) to those this bound drops.
 */
export function parseWorkflowProgress(
  value: unknown,
  cliOmitted?: unknown,
): { agents: BackgroundWorkflowAgent[]; omitted: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const byIndex = new Map<number, BackgroundWorkflowAgent>();
  for (const raw of value.slice(0, MAX_WORKFLOW_PROGRESS_ROWS)) {
    const agent = workflowAgentRow(raw);
    // The CLI replaces a row in place; a repeat is the newer state.
    if (agent) byIndex.set(agent.index, agent);
  }
  let agents = [...byIndex.values()];
  let omitted = count(cliOmitted) ?? 0;
  if (agents.length > MAX_WORKFLOW_AGENTS) {
    const kept = new Set(
      [...agents]
        .sort(
          (left, right) =>
            Number(isLiveAgent(right)) - Number(isLiveAgent(left)) ||
            Number(right.state === "error") - Number(left.state === "error") ||
            right.index - left.index,
        )
        .slice(0, MAX_WORKFLOW_AGENTS),
    );
    omitted += agents.length - kept.size;
    agents = agents.filter((agent) => kept.has(agent));
  }
  agents.sort((left, right) => left.index - right.index);
  return { agents, omitted };
}

type WorkflowEdge = Pick<BackgroundTaskSystemMessage, "subtype" | "task_type" | "workflow_agents">;

/** Whether an edge belongs to a workflow task, from the edge or what came before it. */
export function isWorkflowTaskEdge(
  message: WorkflowEdge,
  previous: BackgroundTaskSnapshot | undefined,
): boolean {
  return (
    message.task_type === "local_workflow" ||
    previous?.taskType === "local_workflow" ||
    message.workflow_agents !== undefined ||
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
  agents: readonly BackgroundWorkflowAgent[] | undefined,
): string[] {
  if (!tasks || !agents) return [];
  const ids: string[] = [];
  for (const agent of agents) {
    const task = agent.agentId ? tasks[agent.agentId] : undefined;
    if (task && task.taskType === undefined && task.subagentType !== undefined) ids.push(task.id);
  }
  return ids;
}

/** Whether a `SubagentStart` hook announces one of a workflow's agents. */
export function isWorkflowAgentLaunch(
  tasks: Record<string, BackgroundTaskSnapshot> | undefined,
  agentId: string,
  agentType: string | undefined,
): boolean {
  if (agentType === WORKFLOW_SUBAGENT_TYPE) return true;
  for (const task of Object.values(tasks ?? {})) {
    if (task.workflowAgents?.some((agent) => agent.agentId === agentId)) return true;
  }
  return false;
}
