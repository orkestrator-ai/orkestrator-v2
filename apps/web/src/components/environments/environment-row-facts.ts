/**
 * The two ways an environment row gets its facts. `localEnvironmentRowFacts`
 * reads this window's full `Environment` record plus what its stores know;
 * `nodeEnvironmentRowFacts` reads another machine's node summary. Both feed
 * `environmentRowModel`, and `environment-row-model.parity.test.ts` checks
 * that the same environment produces the same row either way.
 */
import {
  environmentDeletionFailure,
  environmentDeletionStep,
  environmentHasDeletionTombstone,
  isEnvironmentDeletionStep,
  type AgentActivity,
} from "@orkestrator/protocol/node-summaries";
import { machineStatusText } from "@/components/federation/MachineDot";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { nodeEnvironmentPrMergeState, type PrMergeState } from "@/lib/pr-merge-readiness";
import type { Environment } from "@/types";
import type { EnvironmentRowFacts } from "./environment-row-model";
import type { EnvironmentTooltipDetails } from "./EnvironmentTooltipBody";

/** What this window's stores add to its own `Environment` record. */
export interface LocalEnvironmentRowInputs {
  /** `useEnvironmentStore.isDeleting`: in flight here, or marked on the record. */
  deleting: boolean;
  /** An attempt started in this window, before the backend updates its snapshot. */
  deletingStartedAt?: string;
  /** `isLocalDeletionRetryable`: a failed merge cleanup nothing here is retrying. */
  deletionRetryable: boolean;
  /** `useEnvironmentDisplayActivity`: runtime activity, `working` during a build. */
  activity: AgentActivity;
  running: boolean;
  buildPipeline: boolean;
  unreadMail: number;
  failedMail: boolean;
  prMergeState: PrMergeState | null;
  /** The window's machine, when this client can show machines. */
  machine: { name: string; colorToken: string | undefined } | null;
  dockerAvailable: boolean;
  localCheckoutAvailable: boolean;
}

export function localEnvironmentRowFacts(
  environment: Environment,
  inputs: LocalEnvironmentRowInputs,
): EnvironmentRowFacts {
  const failure = environmentDeletionFailure(environment);
  const deleting = inputs.deleting && (Boolean(inputs.deletingStartedAt) || !failure);
  return {
    environmentId: environment.id,
    name: environment.name,
    projectHome: environment.projectHome === true,
    environmentType: environment.environmentType,
    status: environment.status,
    deletionPending: inputs.deleting || environmentHasDeletionTombstone(environment),
    deleting,
    deleteFailure: deleting ? null : failure,
    deletingSince: deleting
      ? (inputs.deletingStartedAt ?? environment.lifecycleOperationStartedAt ?? null)
      : null,
    deletingStep: deleting ? environmentDeletionStep(environment) : null,
    deletionRetryable: inputs.deletionRetryable,
    buildPipeline: inputs.buildPipeline,
    prState: environment.prState ?? null,
    autoMerge: environment.autoMerge === true,
    activity: inputs.activity,
    running: inputs.running,
    live: true,
    busy: false,
    hasUnreadWork: environment.hasUnreadWork === true,
    unreadMail: inputs.unreadMail,
    failedMail: inputs.failedMail,
    prMergeState: inputs.prMergeState,
    machine: inputs.machine
      ? {
          name: inputs.machine.name,
          colorToken: inputs.machine.colorToken,
          isThisWindow: true,
          status: "This window",
        }
      : null,
    writable: true,
    dockerAvailable: inputs.dockerAvailable,
    localCheckoutAvailable: inputs.localCheckoutAvailable,
  };
}

export function nodeEnvironmentRowFacts(
  machine: MachineView,
  environment: FederatedEnvironment,
  actions: { busy: boolean; writable: boolean },
  /** This machine's auto-merge "Require checks to pass" setting. */
  requireChecks: boolean,
): EnvironmentRowFacts {
  const project = machine.projects.find(
    (candidate) => candidate.ref.projectId === environment.projectId,
  );
  // Relayed by the machine; one that predates the field is treated as having Docker.
  const dockerAvailable = environment.dockerAvailable !== false;
  return {
    environmentId: environment.ref.environmentId,
    name: environment.name,
    projectHome: environment.isProjectHome,
    environmentType: environment.environmentType,
    status: environment.status,
    deleting: environment.deleting && !environment.deleteFailure,
    deletionPending: environment.deleting,
    deleteFailure: environment.deleteFailure ?? null,
    deletingSince:
      environment.deleting && !environment.deleteFailure
        ? (environment.deletingSince ?? null)
        : null,
    // Relayed by another machine: only a step this client knows is shown.
    deletingStep:
      environment.deleting &&
      !environment.deleteFailure &&
      isEnvironmentDeletionStep(environment.deletingStep)
        ? environment.deletingStep
        : null,
    deletionRetryable: environment.deletionRetryable === true,
    buildPipeline: environment.buildPipeline === true,
    prState: environment.prState ?? null,
    autoMerge: environment.autoMerge === true,
    // Pipeline sessions need not project agent activity onto their environment.
    activity: environment.buildActive ? "working" : environment.activity,
    // As `useEnvironmentDisplayActivity` decides it on the machine itself.
    running:
      environment.environmentType === "local" ||
      (dockerAvailable && environment.status === "running"),
    live: machine.transport === "connected",
    busy: actions.busy,
    hasUnreadWork: environment.hasUnreadWork,
    unreadMail: environment.agentMailUnread ?? 0,
    failedMail: environment.agentMailFailed === true,
    // Decided from the machine's relayed PR reading and monitor health.
    prMergeState: nodeEnvironmentPrMergeState(environment, machine, requireChecks),
    machine: {
      name: machine.name,
      colorToken: machine.colorToken,
      isThisWindow: machine.bound,
      status: machineStatusText({
        transport: machine.transport,
        freshness: machine.freshness,
        loadedAt: machine.loadedAt,
      }),
    },
    writable: actions.writable,
    dockerAvailable,
    // A project summary names its checkout; one without has none to own a worktree.
    localCheckoutAvailable: project ? Boolean(project.pathName) : true,
  };
}

/** The hover card's details until the full record has been read from the machine. */
export function nodeEnvironmentTooltipDetails(
  environment: FederatedEnvironment,
): EnvironmentTooltipDetails {
  return {
    projectHome: environment.isProjectHome,
    ...(environment.branch ? { branch: environment.branch } : {}),
    ...(environment.environmentType ? { environmentType: environment.environmentType } : {}),
    ...(environment.createdAt ? { createdAt: environment.createdAt } : {}),
  };
}
