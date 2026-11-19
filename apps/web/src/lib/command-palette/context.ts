/**
 * Builds the palette's `PaletteContext` from its frozen selection and the
 * live sources the sidebar draws from: this window's own stores for its
 * machine, another machine's summary for that machine. The environment facts
 * go through the sidebar row's own builders (`localEnvironmentRowFacts`,
 * `nodeEnvironmentRowFacts`) and `environmentRowModel`, so an action is
 * available here exactly when the row's menu enables it.
 */
import {
  environmentRowModel,
  environmentDisplayName,
} from "@/components/environments/environment-row-model";
import {
  localEnvironmentRowFacts,
  nodeEnvironmentRowFacts,
} from "@/components/environments/environment-row-facts";
import { isMachineWritable, type MachineView } from "@/lib/federation/aggregate";
import { machineAvailability } from "@/lib/project-search";
import type { Environment, Project } from "@/types";
import type { PaletteContext, PaletteEnvironment, PaletteMachine, PaletteSelection } from "./model";

export function paletteMachine(machine: MachineView): PaletteMachine {
  return {
    connectionId: machine.connectionId,
    backendId: machine.backendId,
    name: machine.name,
    colorToken: machine.colorToken,
    bound: machine.bound,
    availability: machineAvailability(machine),
    writable: isMachineWritable(machine),
  };
}

export interface PaletteContextSources {
  selection: PaletteSelection;
  /** The selection the window shows now, to tell whether the frozen one is still on show. */
  shownSelection: PaletteSelection;
  /** Every machine in a multi-machine view; empty otherwise. */
  machines: readonly MachineView[];
  /** This window's machine is the selection's node (or nothing is node-qualified). */
  onWindowMachine: boolean;
  localProjects: readonly Project[];
  localEnvironments: readonly Environment[];
  /** `environmentStore.deletingEnvironments`. */
  localDeleting: ReadonlySet<string>;
  /** Actions in flight from this client (`sidebarActionStore.pending`). */
  pending: ReadonlySet<string>;
  dockerAvailable: boolean;
  /** The auto-merge "Require checks to pass" setting the rows read. */
  requireChecks: boolean;
  handlers: PaletteContext["handlers"];
  recentCommandCount: number;
  rememberRecentCommands: boolean;
  settingsFlags: PaletteContext["settingsFlags"];
}

function sameSelection(a: PaletteSelection, b: PaletteSelection): boolean {
  return (
    a.nodeId === b.nodeId && a.projectId === b.projectId && a.environmentId === b.environmentId
  );
}

function localEnvironment(
  environment: Environment,
  sources: PaletteContextSources,
  machine: MachineView | null,
): PaletteEnvironment {
  const facts = localEnvironmentRowFacts(environment, {
    deleting: sources.localDeleting.has(environment.id),
    deletionRetryable: false,
    // Availability reads no activity; the row's own value only colours its marker.
    activity: "idle",
    running:
      environment.environmentType === "local" ||
      (sources.dockerAvailable && environment.status === "running"),
    buildPipeline: false,
    prMergeState: null,
    machine: machine ? { name: machine.name, colorToken: machine.colorToken } : null,
    dockerAvailable: sources.dockerAvailable,
    localCheckoutAvailable: true,
  });
  const withBusy = { ...facts, busy: sources.pending.has(environment.id) };
  return {
    id: environment.id,
    name: environmentDisplayName(environment.name, environment.projectHome === true),
    projectId: environment.projectId,
    isLocal: environment.environmentType === "local",
    isProjectHome: environment.projectHome === true,
    facts: withBusy,
    model: environmentRowModel(withBusy),
    remote: null,
  };
}

export function buildPaletteContext(sources: PaletteContextSources): PaletteContext {
  const { selection } = sources;
  const multiMachine = sources.machines.length > 0;
  const boundView = sources.machines.find((machine) => machine.bound) ?? null;
  const machineView = sources.onWindowMachine
    ? boundView
    : (sources.machines.find((machine) => machine.backendId === selection.nodeId) ?? null);
  // Another machine's selection whose machine has left the view cannot be resolved.
  const machineGone = !sources.onWindowMachine && !machineView;
  const useLocal = sources.onWindowMachine;

  let project: PaletteContext["project"] = null;
  if (selection.projectId && !machineGone) {
    if (useLocal) {
      const found = sources.localProjects.find((entry) => entry.id === selection.projectId);
      if (found) project = { id: found.id, name: found.name };
    } else if (machineView) {
      const found = machineView.projects.find(
        (entry) => entry.ref.projectId === selection.projectId,
      );
      if (found) project = { id: found.ref.projectId, name: found.name };
    }
  }

  let environment: PaletteEnvironment | null = null;
  if (selection.environmentId && !machineGone) {
    if (useLocal) {
      const found = sources.localEnvironments.find((entry) => entry.id === selection.environmentId);
      if (found) environment = localEnvironment(found, sources, boundView);
    } else if (machineView) {
      const found = Array.from(machineView.environmentsByProject.values())
        .flat()
        .find((entry) => entry.ref.environmentId === selection.environmentId);
      if (found) {
        const busy = sources.pending.has(found.key);
        const facts = nodeEnvironmentRowFacts(
          machineView,
          found,
          { busy, writable: isMachineWritable(machineView) },
          sources.requireChecks,
        );
        environment = {
          id: found.ref.environmentId,
          name: environmentDisplayName(found.name, found.isProjectHome),
          projectId: found.projectId,
          isLocal: found.environmentType === "local",
          isProjectHome: found.isProjectHome,
          facts,
          model: environmentRowModel(facts),
          remote: { machine: machineView, environment: found },
        };
      }
    }
  }

  // A machine that is offline, stale or still loading may simply not have
  // reported the target yet: its absence is unknown, not a deletion.
  const confirmed =
    !machineGone &&
    (useLocal || (machineView !== null && machineAvailability(machineView) === "live"));
  const projectUnresolved = selection.projectId !== null && project === null;
  const environmentUnresolved = selection.environmentId !== null && environment === null;
  return {
    multiMachine,
    machine: machineView ? paletteMachine(machineView) : null,
    selection,
    project,
    environment,
    projectMissing: projectUnresolved && confirmed,
    environmentMissing: environmentUnresolved && confirmed,
    targetUnknown: (projectUnresolved || environmentUnresolved) && !confirmed,
    selectionCurrent: sameSelection(selection, sources.shownSelection),
    handlers: sources.handlers,
    recentCommandCount: sources.recentCommandCount,
    rememberRecentCommands: sources.rememberRecentCommands,
    settingsFlags: sources.settingsFlags,
  };
}
