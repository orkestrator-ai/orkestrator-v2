/**
 * The ⌘K palette's command model: what a command is, what it acts on, and
 * whether it can run now.
 *
 * A command is a typed descriptor around an action the app already has (a
 * sidebar menu item, a toolbar button, a shortcut, a Settings section). Its
 * handler calls that same action through `CommandRuntime`; the palette never
 * implements an action of its own and never interprets typed text as a
 * command line. Availability mirrors the decision the owning menu makes
 * (`environmentRowModel(...).menu` for an environment's power actions), and
 * the owner still validates when the action runs.
 *
 * Targets are frozen when the palette opens (`PaletteSelection`): a command
 * acts on the machine, project and environment the palette was opened over,
 * whatever the window shows by the time it runs. Only live facts about that
 * frozen target (its status, its machine's connection) are re-read.
 */
import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import type { WorkspaceBoardTab, WorkspaceDialog } from "@/lib/federation/workspace-request";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import type { ProjectSearchAvailability } from "@/lib/project-search";
import type {
  EnvironmentRowFacts,
  EnvironmentRowModel,
} from "@/components/environments/environment-row-model";
import type { AppShortcutId } from "@orkestrator/protocol/keyboard-shortcuts";

/** The palette's result groups, in their fixed display order. */
export type PaletteGroup = "destinations" | "actions" | "settings" | "history";

/** What running a command does: moves the view, reads, or changes state. */
export type CommandEffect = "navigation" | "read" | "mutation";

/** The machine a command acts on, as the palette shows it. */
export interface PaletteMachine {
  connectionId: string;
  backendId: string;
  name: string;
  colorToken: string;
  /** The window's own machine. */
  bound: boolean;
  availability: ProjectSearchAvailability;
  /** Accepts writes now (`isMachineWritable`). */
  writable: boolean;
}

/**
 * The ids the palette was opened over. Frozen for the palette's lifetime:
 * names and states are looked up from them, never the other way round.
 */
export interface PaletteSelection {
  /** The node the window showed; null outside a node-qualified selection. */
  nodeId: string | null;
  projectId: string | null;
  environmentId: string | null;
}

export interface PaletteEnvironment {
  id: string;
  name: string;
  projectId: string;
  isLocal: boolean;
  isProjectHome: boolean;
  /** The same facts and model its sidebar row is drawn from. */
  facts: EnvironmentRowFacts;
  model: EnvironmentRowModel;
  /** Another machine's environment, from its summary; null for this window's own. */
  remote: { machine: MachineView; environment: FederatedEnvironment } | null;
}

/** Everything a command's availability is decided from. */
export interface PaletteContext {
  /** Rows are labelled with their machine (a multi-machine view). */
  multiMachine: boolean;
  /** The frozen selection's machine; null in a single-machine client. */
  machine: PaletteMachine | null;
  selection: PaletteSelection;
  machineMissing: boolean;
  agentTabBlock?: "setup" | "limit" | "unavailable";
  project: { id: string; name: string } | null;
  environment: PaletteEnvironment | null;
  /** The frozen selection named a project that no longer resolves. */
  projectMissing: boolean;
  /** The frozen selection named an environment that no longer resolves. */
  environmentMissing: boolean;
  /**
   * The frozen selection names something its machine has not reported (it is
   * offline, stale or loading, or left the view): neither present nor gone.
   */
  targetUnknown: boolean;
  /** The window still shows the frozen selection. */
  selectionCurrent: boolean;
  /** Handlers the palette's host supplied (absent ones make their commands unavailable). */
  handlers: { environmentPower: boolean; addProject: boolean };
  recentCommandCount: number;
  rememberRecentCommands: boolean;
  /** Experimental flags that gate Settings sections. */
  settingsFlags: { experimentalScheduling?: boolean; experimentalSelfImprovement?: boolean };
}

/** A command's frozen target. Display names are presentation only. */
export interface CommandTarget {
  /** Null: this window (a window command, or a single-machine client). */
  machine: PaletteMachine | null;
  project: { id: string; name: string } | null;
  environment: { id: string; name: string; projectId: string } | null;
}

/** Why an unavailable command cannot run, by category (for counts, never content). */
export type UnavailableReasonCode =
  | "no-project"
  | "no-environment"
  | "target-missing"
  | "target-changed"
  | "target-unknown"
  | "machine-offline"
  | "busy"
  | "transitioning"
  | "docker-unavailable"
  | "not-running"
  | "already-running"
  | "not-shown"
  | "handler-missing"
  | "nothing-to-clear";

/** The supported way out of an unavailable command: another category, or another command. */
export type CommandNextStep =
  | { kind: "filter"; label: string; filter: PaletteFilter }
  | { kind: "command"; label: string; commandId: string }
  | { kind: "refresh-context"; label: string };

export type CommandAvailability =
  | { available: true }
  | {
      available: false;
      reason: string;
      code: UnavailableReasonCode;
      nextStep?: CommandNextStep;
    };

export const AVAILABLE: CommandAvailability = { available: true };

/** The palette's category filter: every group, a destination kind, or one command group. */
export type PaletteFilter =
  "all" | "projects" | "environments" | "actions" | "settings" | "history";

export const PALETTE_FILTERS: readonly PaletteFilter[] = [
  "all",
  "projects",
  "environments",
  "actions",
  "settings",
  "history",
];

export const PALETTE_FILTER_LABELS: Readonly<Record<PaletteFilter, string>> = {
  all: "All",
  projects: "Projects",
  environments: "Environments",
  actions: "Actions",
  settings: "Settings",
  history: "History",
};

export function nextPaletteFilter(current: PaletteFilter, step: 1 | -1): PaletteFilter {
  const index = PALETTE_FILTERS.indexOf(current);
  const next = (index + step + PALETTE_FILTERS.length) % PALETTE_FILTERS.length;
  return PALETTE_FILTERS[next] ?? "all";
}

export function isPaletteFilter(value: unknown): value is PaletteFilter {
  return PALETTE_FILTERS.includes(value as PaletteFilter);
}

/** Which groups a filter shows. */
export function filterShowsGroup(filter: PaletteFilter, group: PaletteGroup): boolean {
  switch (filter) {
    case "all":
      return true;
    case "projects":
    case "environments":
      return group === "destinations";
    default:
      return group === filter;
  }
}

/**
 * The app's own actions a command may call. The palette's host builds it from
 * the same handlers the sidebar rows, menus and shortcuts use.
 */
export interface CommandRuntime {
  /** Open the target environment (on its own machine), then optionally a panel, dialog or tab. */
  openEnvironment: (
    target: CommandTarget,
    options?: {
      filesPanelTab?: "changes" | "all-files";
      dialog?: Extract<WorkspaceDialog, "environment-settings" | "environment-rebuild">;
    },
  ) => void;
  /** Open the target project (on its own machine) on a board tab, or one of its dialogs. */
  openProject: (
    target: CommandTarget,
    options?: {
      boardTab?: WorkspaceBoardTab;
      dialog?: "repository-settings";
      createEnvironment?: boolean;
    },
  ) => void;
  openGlobalSettings: (section: GlobalSettingsSection, machine?: PaletteMachine | null) => void;
  requestAppShortcut: (id: AppShortcutId) => void;
  /** Start, stop or restart the target environment through its row's own handler. */
  environmentPower: (action: "start" | "stop", target: CommandTarget) => Promise<void>;
  addProject: () => void;
  copyText: (text: string, successMessage: string) => void;
  clearRecentCommands: () => void;
  setRememberRecentCommands: (remember: boolean) => void;
}

export interface CommandDescriptor {
  /** Stable: recents, logs and tests name commands by it. */
  id: string;
  label: string;
  /** Curated synonyms the search also matches. */
  aliases: readonly string[];
  group: Exclude<PaletteGroup, "destinations" | "history">;
  effect: CommandEffect;
  /** What the command needs from the context, and so what its target names. */
  requires: "window" | "machine" | "project" | "environment";
  /** Activation hands focus to a dialog or workspace. */
  movesFocus?: boolean;
  /**
   * The command writes to its machine or opens a dialog that does, so it
   * needs a live machine (the rule the sidebar menu applies to Settings).
   * Defaults to true for mutations.
   */
  needsLiveMachine?: boolean;
  /** Shown on an empty query while available. */
  suggested?: boolean;
  /** The app shortcut that runs the same handler, shown on the row. */
  shortcut?: AppShortcutId;
  /** Ask in the palette first, naming the frozen target. */
  confirm?: { title: string; verb: string };
  /** The command does not apply here at all (not merely unavailable). */
  hidden?: (context: PaletteContext) => boolean;
  /** Prerequisites beyond `requires` and `needsLiveMachine`. */
  availability?: (context: PaletteContext) => CommandAvailability;
  run: (target: CommandTarget, runtime: CommandRuntime) => void | Promise<void>;
}

/** The target a command would act on in `context`. */
export function commandTarget(command: CommandDescriptor, context: PaletteContext): CommandTarget {
  if (command.requires === "window") {
    return { machine: null, project: null, environment: null };
  }
  return {
    machine: context.machine,
    project: command.requires === "machine" ? null : context.project,
    environment:
      command.requires === "environment" && context.environment
        ? {
            id: context.environment.id,
            name: context.environment.name,
            projectId: context.environment.projectId,
          }
        : null,
  };
}

const CHOOSE_ENVIRONMENT: CommandNextStep = {
  kind: "filter",
  label: "Choose an environment",
  filter: "environments",
};
const CHOOSE_PROJECT: CommandNextStep = {
  kind: "filter",
  label: "Choose a project",
  filter: "projects",
};

/** Whether `command` can run in `context`, and if not, why and what to do instead. */
export function commandAvailability(
  command: CommandDescriptor,
  context: PaletteContext,
): CommandAvailability {
  if (command.requires === "machine" && context.machineMissing) {
    return {
      available: false,
      reason: "Its machine is no longer available",
      code: "target-unknown",
      nextStep: { kind: "refresh-context", label: "Use the machine now shown" },
    };
  }
  const needsEnvironment = command.requires === "environment" && !context.environment;
  const needsProject = command.requires === "project" && !context.project;
  if ((needsEnvironment || needsProject) && context.targetUnknown) {
    return {
      available: false,
      reason: context.machine
        ? `Not yet known on ${context.machine.name} (${context.machine.availability})`
        : "Its machine is not available",
      code: "target-unknown",
      nextStep: needsEnvironment ? CHOOSE_ENVIRONMENT : CHOOSE_PROJECT,
    };
  }
  if (command.requires === "environment") {
    if (context.environmentMissing) {
      return {
        available: false,
        reason: "This environment no longer exists",
        code: "target-missing",
        nextStep: CHOOSE_ENVIRONMENT,
      };
    }
    if (!context.environment) {
      return {
        available: false,
        reason: "Choose an environment first",
        code: "no-environment",
        nextStep: CHOOSE_ENVIRONMENT,
      };
    }
  }
  if (command.requires === "project") {
    if (context.projectMissing) {
      return {
        available: false,
        reason: "This project no longer exists",
        code: "target-missing",
        nextStep: CHOOSE_PROJECT,
      };
    }
    if (!context.project) {
      return {
        available: false,
        reason: "Choose a project first",
        code: "no-project",
        nextStep: CHOOSE_PROJECT,
      };
    }
  }
  const needsLive = command.needsLiveMachine ?? command.effect === "mutation";
  if (needsLive && command.requires !== "window" && context.machine && !context.machine.writable) {
    return {
      available: false,
      reason: `${context.machine.name} is offline`,
      code: "machine-offline",
      nextStep: {
        kind: "command",
        label: "Open Machines settings",
        commandId: "settings.machines",
      },
    };
  }
  return command.availability?.(context) ?? AVAILABLE;
}

/**
 * Why the sidebar menu disables an environment's Start/Stop or Restart,
 * read from the same facts (`environmentRowModel` decides; this names the
 * first prerequisite that fails, in the model's order).
 */
export function environmentPowerAvailability(
  environment: PaletteEnvironment,
  action: "start" | "stop" | "restart",
): CommandAvailability {
  const disabled =
    action === "restart"
      ? environment.model.menu.restartDisabled
      : environment.model.menu.powerDisabled;
  if (!disabled) {
    if (action === "start" && environment.model.isRunning) {
      return {
        available: false,
        reason: "The environment is already running",
        code: "already-running",
      };
    }
    if (action === "stop" && !environment.model.isRunning) {
      return { available: false, reason: "The environment is not running", code: "not-running" };
    }
    return AVAILABLE;
  }
  const { facts, model } = environment;
  const machineName = facts.machine?.name ?? "this machine";
  if (!facts.writable) {
    return {
      available: false,
      reason: `${machineName} is offline`,
      code: "machine-offline",
      nextStep: {
        kind: "command",
        label: "Open Machines settings",
        commandId: "settings.machines",
      },
    };
  }
  if (facts.busy) {
    return {
      available: false,
      reason: "Another action on this environment is still running",
      code: "busy",
    };
  }
  if (model.isTransitioning) {
    return {
      available: false,
      reason: model.isCreating
        ? "The environment is still being created"
        : "The environment is stopping",
      code: "transitioning",
    };
  }
  if (!facts.dockerAvailable) {
    return {
      available: false,
      reason: `Docker is not available on ${machineName}`,
      code: "docker-unavailable",
      nextStep: { kind: "command", label: "Open Docker settings", commandId: "settings.docker" },
    };
  }
  return {
    available: false,
    reason: "The environment is not running",
    code: "not-running",
    nextStep: { kind: "command", label: "Start environment", commandId: "environment.start" },
  };
}

/** One line naming what a target is, for rows and confirmations. */
export function describeTarget(target: CommandTarget): string {
  const parts: string[] = [];
  if (target.environment) parts.push(target.environment.name);
  if (target.project) parts.push(target.project.name);
  return parts.join(" · ");
}

/** The target's machine as words: "this window", or the machine with its state. */
export function describeTargetMachine(target: CommandTarget): string {
  if (!target.machine) return target.project || target.environment ? "this machine" : "this window";
  const state = target.machine.availability === "live" ? "" : ` (${target.machine.availability})`;
  return `${target.machine.name}${target.machine.bound ? ", this machine" : ""}${state}`;
}
