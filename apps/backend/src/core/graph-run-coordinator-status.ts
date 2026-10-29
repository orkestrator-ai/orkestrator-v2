/**
 * A graph run reduced to a coordinator status (item 208, plan P2.8, P2.14):
 * what a coordinator that launched the run hears through its status wake
 * (`coordinator-status-wakes.ts`, `graph-run` associations).
 *
 * - **Waiting for a person.** One notice per wait: the key names the newest
 *   open wait (a human node's wait, or an agent's `ask_human` question) with
 *   the time it opened, and {@link graphRunWaitNoticeIsNew} lets a wait
 *   through only when it opened after the one last reported. A wait that
 *   stays open while another is answered, a restart of the backend, or a
 *   second observer therefore never repeats a notice; a new wait (a later
 *   node, or a restarted one) always sends one.
 * - **Finished.** `complete`, `failed` or `cancelled`, once (terminal).
 *
 * Running is progress, not a status. Details are content-free: node names,
 * form kinds, counts and the run's bounded error, never a question's text, a
 * node's instructions or an answer.
 */
import {
  graphPendingInteractionId,
  graphRunPendingInteractions,
  type GraphRun,
  type GraphRunPendingInteraction,
} from "@orkestrator/protocol/graphs/run";
import type { CoordinatorStatus } from "./coordinator-status-wakes.js";

const WAITING_PREFIX = "waiting:";

function describe(interaction: GraphRunPendingInteraction): string {
  const who =
    interaction.title === interaction.nodeId
      ? interaction.nodeId
      : `${interaction.title} (${interaction.nodeId})`;
  if (interaction.kind === "question") return `${who} asks a question (ask_human).`;
  switch (interaction.form) {
    case "approve":
      return `${who} waits for an approval.`;
    case "edit":
      return `${who} waits for a review: edit${interaction.edit ? ` ${interaction.edit.port}` : ""} and approve, or reject.`;
    case "choose":
      return `${who} waits for a choice between ${(interaction.options ?? []).map((option) => option.to).join(", ")}.`;
  }
}

function tools(run: GraphRun): string[] {
  return [`get_graph_run({"runId":"${run.id}"})`];
}

/** The waiting key of the newest open wait: `waiting:<openedAt>:<id>`. */
function waitingKey(pending: readonly GraphRunPendingInteraction[]): string {
  const newest = [...pending].sort((left, right) =>
    left.openedAt === right.openedAt
      ? graphPendingInteractionId(left).localeCompare(graphPendingInteractionId(right))
      : left.openedAt.localeCompare(right.openedAt),
  )[pending.length - 1]!;
  return `${WAITING_PREFIX}${newest.openedAt}:${graphPendingInteractionId(newest)}`;
}

/** The status of `run` for its coordinator, or null while it simply runs. */
export function graphRunCoordinatorStatus(run: GraphRun): CoordinatorStatus | null {
  switch (run.status) {
    case "complete":
      return {
        key: "complete",
        state: "completed",
        tone: "success",
        terminal: true,
        headline: "completed",
        details: [
          `${run.usage.agentSessions} agent session${run.usage.agentSessions === 1 ? "" : "s"}, ${run.usage.tokens} tokens.`,
        ],
        tools: tools(run),
        mode: "settled",
      };
    case "failed":
      return {
        key: "failed",
        state: "failed",
        tone: "failure",
        terminal: true,
        headline: "failed",
        details: run.error ? [`Error: ${run.error}`] : [],
        tools: tools(run),
        mode: "settled",
      };
    case "cancelled":
      return {
        key: "cancelled",
        state: "cancelled",
        tone: "info",
        terminal: true,
        headline: "was cancelled",
        details: [],
        tools: tools(run),
        mode: "settled",
      };
    default:
      break;
  }
  const pending = graphRunPendingInteractions(run);
  if (pending.length === 0) return null;
  return {
    key: waitingKey(pending),
    state: "waiting",
    tone: "attention",
    terminal: false,
    headline: "is waiting for a person",
    details: [
      ...pending.slice(0, 6).map(describe),
      ...(pending.length > 6 ? [`And ${pending.length - 6} more.`] : []),
      "The user answers in the run view; nothing downstream runs until then.",
    ],
    tools: tools(run),
    mode: "settled",
  };
}

/**
 * Whether a waiting status names a wait newer than the last one reported
 * (`sentKey`, the association's last notice key). Non-waiting statuses are
 * always new to this check; the caller still skips an identical key.
 */
export function graphRunWaitNoticeIsNew(nextKey: string, sentKey: string | undefined): boolean {
  if (!nextKey.startsWith(WAITING_PREFIX) || !sentKey?.startsWith(WAITING_PREFIX)) return true;
  return nextKey.slice(WAITING_PREFIX.length) > sentKey.slice(WAITING_PREFIX.length);
}
