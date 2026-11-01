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
import type { AgentActivity } from "@orkestrator/protocol/node-summaries";
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
  name: string;
  projectHome: boolean;
  environmentType: string | undefined;
  status: string;
  deleting: boolean;
  /** A build pipeline names this environment: the row carries the pipe. */
  buildPipeline: boolean;
  prState: PrState | null;
  autoMerge: boolean;
  /** The displayed agent activity; a working build pipeline reads `working`. */
  activity: AgentActivity;
  /** Local, or a container its machine reports running (with Docker, where known). */
  running: boolean;
  /** The owning machine is reachable; otherwise the row is last-known state. */
  live: boolean;
  /** An action on it is in flight from this client. */
  busy: boolean;
  hasUnreadWork: boolean;
  unreadMail: number;
  failedMail: boolean;
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
      forkLocalDisabled: blocked || isCreating || facts.deleting || !facts.localCheckoutAvailable,
      forkContainerDisabled: blocked || isCreating || facts.deleting || !facts.dockerAvailable,
      powerDisabled: blocked || isTransitioning || !facts.dockerAvailable,
      restartDisabled: blocked || isTransitioning || !facts.dockerAvailable || !facts.running,
      // A deletion that failed keeps its marker; deleting again retries it.
      deleteDisabled: blocked,
    },
  };
}
