/**
 * What an environment row shows, decided once for every row in the app.
 *
 * A row is reached two ways: from this window's own stores (`EnvironmentItem`)
 * and from the node summary of another machine seen through a command node
 * (`RemoteEnvironmentItem`). Each adapter only gathers the facts below; this
 * function decides the presentation, so a rule written here applies to both
 * and a new fact must be supplied by both or the code does not compile.
 * `environment-row-model.parity.test.ts` checks the two adapters agree.
 */
import type { AgentPendingInteractionSummary } from "@orkestrator/protocol/agent-registry";
import {
  NODE_DELETE_FAILURE,
  type AgentActivity,
  type EnvironmentDeletionStep,
  type NodeUnreadReason,
} from "@orkestrator/protocol/node-summaries";
import type { PrState } from "@orkestrator/protocol/pr-monitor";
import type { EnvironmentTooltipMachine } from "./EnvironmentTooltipBody";
import { environmentNameSignal, type EnvironmentNameSignal } from "@/lib/environment-name-signal";
import type { PrMergeState } from "@/lib/pr-merge-readiness";

export interface EnvironmentRowMachine {
  name: string;
  colorToken: string | undefined;
  /** The window's own machine. */
  isThisWindow: boolean;
  /** Its connection, e.g. "Connected" or "Unavailable · last seen 2m ago". */
  status: string;
}

/** The facts a row is drawn from, whichever machine the environment is on. */
export interface EnvironmentRowFacts {
  /** The environment's ID on its owning machine. */
  environmentId: string;
  name: string;
  projectHome: boolean;
  environmentType: string | undefined;
  status: string;
  deleting: boolean;
  /** Availability fence retained after a delete fails; independent of progress. */
  deletionPending?: boolean;
  /** Why its last delete failed. The row stops spinning and offers a retry. */
  deleteFailure: string | null;
  /** When the running delete started, if known. */
  deletingSince: string | null;
  /** Which step the running delete is on, if its machine reports one. */
  deletingStep: EnvironmentDeletionStep | null;
  /** `deleting` is left over from a failed merge cleanup: a bulk delete can retry it. */
  deletionRetryable: boolean;
  /** A build pipeline names this environment: the row carries the pipe. */
  buildPipeline: boolean;
  prState: PrState | null;
  autoMerge: boolean;
  /** The displayed agent activity; a working build pipeline reads `working`. */
  activity: AgentActivity;
  hasWaitingNativeTab?: boolean;
  /** Local, or a container its machine reports running (with Docker, where known). */
  running: boolean;
  /** The owning machine is reachable; otherwise the row is last-known state. */
  live: boolean;
  /** An action on it is in flight from this client. */
  busy: boolean;
  hasUnreadWork: boolean;
  /** What lit `hasUnreadWork`, when its machine says. */
  unreadReason: NodeUnreadReason | null;
  /** The last prompt, completion or waiting edge (the owner's clock). */
  lastActivityAt: string | null;
  prMergeState: PrMergeState | null;
  /** The owning machine, whenever this client can show machines. */
  machine: EnvironmentRowMachine | null;
  /** The owning machine accepts writes. */
  writable: boolean;
  /** Docker can run containers there; `true` when this client cannot know. */
  dockerAvailable: boolean;
  /** Its project has a checkout that can own a local worktree; `true` when unknown. */
  localCheckoutAvailable: boolean;
}

export interface EnvironmentRowModel {
  environmentId: string;
  /** The environment's name for cards and dialogs ("Project home" for a home). */
  displayName: string;
  /** The name in the row, without a build pipeline's "Build:" prefix. */
  rowName: string;
  isLocal: boolean;
  isProjectHome: boolean;
  isRunning: boolean;
  isCreating: boolean;
  isTransitioning: boolean;
  /** The status marker's state; a stopped or unreachable environment is inactive. */
  markerState: AgentActivity | "inactive";
  nameSignal: EnvironmentNameSignal | null;
  /** Faded while it stops or is deleted. */
  dimmed: boolean;
  /** A spinner replaces the marker. */
  spinner: "deleting" | "transition" | null;
  /** Shown under the name when its last delete failed. */
  deleteFailureText: string | null;
  /**
   * The line under the name saying what it needs from the user: waiting on
   * them, or unread work that needs more than the bell to explain (a failure,
   * a question, setup approval). `null` while it works, while it is idle and
   * seen, while it is being deleted, and for a plain unread finish, which the
   * bell beside the name marks on its own.
   */
  attention: EnvironmentRowAttention | null;
  /** Multi-select can take it: not a delete in flight. */
  selectable: boolean;
  /** What the row's button announces after its name, e.g. "Working". */
  activityText: string;
  /** The button's label where machines are shown: name, machine and activity. */
  accessibleLabel: string | undefined;
  /** The status marker's machine and its tooltip. */
  markerMachine: EnvironmentTooltipMachine | null;
  /** The hover card's machine line: "this window", or the status while it is unreachable. */
  cardMachine: EnvironmentTooltipMachine | null;
  menu: {
    settingsDisabled: boolean;
    forkLocalDisabled: boolean;
    forkContainerDisabled: boolean;
    powerDisabled: boolean;
    restartDisabled: boolean;
    deleteDisabled: boolean;
  };
}

/**
 * A row's attention line before its pending interaction is known.
 *
 * `waiting`: the agent is blocked on the user now (amber). `unread`: work
 * finished that nobody has opened. `failed`: a turn ended in an error nobody
 * has opened. `setup`: setup commands wait for approval.
 */
export interface EnvironmentRowAttention {
  tone: "waiting" | "unread" | "failed" | "setup";
  /** The text when no pending interaction adds detail, e.g. "Waiting for you". */
  text: string;
  /** When it started waiting, for "· 8 min"; only for `waiting`. */
  since: string | null;
  /** The agent is blocked now, so the tab and request it waits on are worth reading. */
  readsPending: boolean;
}

/**
 * Words for unread work the agent is no longer blocked on. `null` draws no
 * line: a plain finish is marked by the unread bell beside the name alone.
 */
const UNREAD_TEXT: Record<
  NodeUnreadReason,
  { tone: EnvironmentRowAttention["tone"]; text: string } | null
> = {
  agent_finished: null,
  agent_ready: { tone: "unread", text: "Ready for input · unread" },
  terminal_finished: null,
  agent_failed: { tone: "failed", text: "Failed · error unread" },
  agent_waiting: { tone: "unread", text: "Stopped for input · unread" },
  agent_question: { tone: "unread", text: "Asked a question · unread" },
  marked_unread: { tone: "unread", text: "Marked unread" },
  setup_approval: { tone: "setup", text: "Setup needs your approval" },
};

function rowAttention(facts: EnvironmentRowFacts): EnvironmentRowAttention | null {
  if (facts.deleting || facts.deleteFailure) return null;
  const waiting =
    facts.running && facts.live && (facts.activity === "waiting" || facts.hasWaitingNativeTab);
  if (waiting) {
    return {
      tone: "waiting",
      text:
        facts.unreadReason === "agent_question"
          ? "Question for you"
          : facts.unreadReason === "setup_approval"
            ? "Setup needs your approval"
            : "Waiting for you",
      since: facts.lastActivityAt,
      readsPending: true,
    };
  }
  // A working row shows its spinner; what it finished earlier waits until it stops.
  if (!facts.hasUnreadWork || (facts.running && facts.live && facts.activity === "working")) {
    return null;
  }
  const unread = facts.unreadReason
    ? UNREAD_TEXT[facts.unreadReason]
    : { tone: "unread" as const, text: "New activity · unread" };
  return unread ? { ...unread, since: null, readsPending: false } : null;
}

const MINUTE_MS = 60_000;

/** "just now", "8 min", "3 h", "2 d": how long something has been waiting. */
export function formatWaitingDuration(sinceMs: number, nowMs: number): string | null {
  if (!Number.isFinite(sinceMs)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - sinceMs) / MINUTE_MS);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/**
 * The attention line's text in two parts: `head` says what is needed and may
 * be cut short in a narrow sidebar; `tail` (how long, how many) is short and
 * always shown. A waiting row names the request it waits on when its machine
 * reported one ("Needs approval: Run bun install", "8 min"), and otherwise its
 * generic wording with how long it has waited.
 */
export function environmentAttentionParts(
  attention: EnvironmentRowAttention,
  pending: AgentPendingInteractionSummary | null,
  nowMs: number,
  /** Pending requests across the environment's tabs, this one included. */
  pendingCount = pending?.count ?? 0,
): { head: string; tail: string | null } {
  if (attention.tone !== "waiting") return { head: attention.text, tail: null };
  const head = pending
    ? `${pending.label}${pending.detail ? `: ${pending.detail}` : ""}`
    : attention.text;
  const since = pending ? pending.since : Date.parse(attention.since ?? "");
  const tail = [
    formatWaitingDuration(since, nowMs),
    pendingCount > 1 ? `${pendingCount} waiting` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return { head, tail: tail || null };
}

/** The whole attention line on one line, e.g. "Needs approval: Run bun install · 8 min". */
export function environmentAttentionText(
  attention: EnvironmentRowAttention,
  pending: AgentPendingInteractionSummary | null,
  nowMs: number,
  pendingCount = pending?.count ?? 0,
): string {
  const { head, tail } = environmentAttentionParts(attention, pending, nowMs, pendingCount);
  return tail ? `${head} · ${tail}` : head;
}

const ACTIVITY_TEXT: Record<AgentActivity, string> = {
  working: "Working",
  waiting: "Awaiting input",
  idle: "Idle",
};

/** Shown for a project's home environment instead of its stored name. */
export function environmentDisplayName(name: string, projectHome: boolean): string {
  return projectHome && name === "project-home" ? "Project home" : name;
}

export function environmentRowModel(facts: EnvironmentRowFacts): EnvironmentRowModel {
  const isLocal = facts.environmentType === "local";
  const isCreating = facts.status === "creating";
  const isStopping = facts.status === "stopping";
  // Local environments have no container to create or stop.
  const isTransitioning = !isLocal && (isCreating || isStopping);
  const displayName = environmentDisplayName(facts.name, facts.projectHome);
  const activityText = facts.live
    ? ACTIVITY_TEXT[facts.activity]
    : `Connection lost; last observed ${ACTIVITY_TEXT[facts.activity].toLowerCase()}`;
  // Yellow while the agent waits for an answer, else red or green for the PR.
  const nameSignal = facts.deleting
    ? null
    : environmentNameSignal({
        waitingOnUser: facts.running && facts.live && facts.activity === "waiting",
        prMergeState: facts.prMergeState,
      });
  const blocked = !facts.writable || facts.busy;
  const machine = facts.machine;
  return {
    environmentId: facts.environmentId,
    displayName,
    rowName: facts.buildPipeline ? displayName.replace(/^Build:\s*/, "") : displayName,
    isLocal,
    isProjectHome: facts.projectHome,
    isRunning: facts.running,
    isCreating,
    isTransitioning,
    markerState: facts.running && facts.live ? facts.activity : "inactive",
    nameSignal,
    dimmed: facts.deleting || isStopping,
    spinner: facts.deleting ? "deleting" : isTransitioning || facts.busy ? "transition" : null,
    deleteFailureText:
      !facts.deleting && facts.deleteFailure
        ? facts.deleteFailure === NODE_DELETE_FAILURE
          ? facts.deleteFailure
          : `Delete failed: ${facts.deleteFailure}`
        : null,
    attention: rowAttention(facts),
    selectable: !(facts.deletionPending ?? facts.deleting) || facts.deletionRetryable,
    activityText,
    accessibleLabel: machine ? `${displayName}, on ${machine.name}, ${activityText}` : undefined,
    markerMachine: machine
      ? {
          name: machine.name,
          colorToken: machine.colorToken,
          status: machine.isThisWindow ? "This window" : machine.status,
        }
      : null,
    cardMachine: machine
      ? {
          name: machine.name,
          colorToken: machine.colorToken,
          ...(machine.isThisWindow
            ? { status: "this window" }
            : facts.live
              ? {}
              : { status: machine.status }),
        }
      : null,
    menu: {
      settingsDisabled: !facts.writable,
      forkLocalDisabled:
        blocked ||
        isCreating ||
        facts.deletionPending === true ||
        facts.deleting ||
        !facts.localCheckoutAvailable,
      forkContainerDisabled:
        blocked ||
        isCreating ||
        facts.deletionPending === true ||
        facts.deleting ||
        !facts.dockerAvailable,
      powerDisabled: blocked || isTransitioning || !facts.dockerAvailable,
      restartDisabled: blocked || isTransitioning || !facts.dockerAvailable || !facts.running,
      // A deletion that failed keeps its marker; deleting again retries it.
      deleteDisabled: blocked,
    },
  };
}
