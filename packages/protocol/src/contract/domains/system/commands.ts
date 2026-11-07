/**
 * `system` commands (plan item 7009): the host and its maintenance, usage,
 * load and diagnostics, scheduled jobs, bug reports, disk usage and worktree
 * locations, and the resource manifests every client reconciles from.
 *
 * Argument schemas declare every key the handler reads and decode tolerantly
 * (§11.4): the handlers that refused unknown keys (`assertOnlyKeys`) now drop
 * them. A key the handler required with `asString` is `Schema.String` (the
 * same "Expected reportId to be a string" text); a key it reads leniently or
 * checks with its own message (`channel must be stable, beta or unstable`,
 * `scheduleId is required`, the manifest cursors) is
 * `optionalKey(Unknown)`, so nothing accepted today is refused and every
 * message is unchanged.
 *
 * `access`: the machine's own administration (host updates and dependency
 * maintenance, diagnostics bundles, database figures, worktree locations,
 * renderer error and adapter counts) is `admin`, as the old grant deny-lists
 * refused it to workspace clients; so are the machine-wide
 * diagnostics no workspace client reads (compatibility path usage,
 * recurring-work, progressive-read and artifact metrics, the scheduling
 * reconciliation). Everything a workspace window reads or runs (usage and
 * load, host status, bug reports, schedules, disk usage, resource manifests)
 * is `workspace`. `read` equals `isNodeReadCommand(name)`.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { recordDomainAdapterUsageCommand } from "../../client-usage.js";
import { defineCommand } from "../../command.js";
import { MACHINE_LOAD_COMMAND } from "../../../machine-load.js";
import { RECORD_RENDERER_ERRORS_COMMAND } from "../../../renderer-errors.js";
import { systemDomain } from "./domain.js";
import { getFleetUpdatePolicyCommand, setFleetUpdatePolicyCommand } from "./fleet-update-policy.js";
import {
  ArtifactMetricsSchema,
  BugReportFileResultSchema,
  BugReportScreenshotResultSchema,
  BugReportSnapshotSchema,
  CompatibilityPathUsageSnapshotSchema,
  DatabaseStatsSchema,
  DiagnosticsBundleChunkSchema,
  DiagnosticsBundlePlanSchema,
  DiskUsageEnvironmentSummarySchema,
  EnvironmentDiskUsageSchema,
  EnvironmentProcessUsageSnapshotSchema,
  HostMaintenanceSnapshotSchema,
  HostRestartImpactSchema,
  HostTaskSchema,
  HostUpdateJobResultSchema,
  MachineLoadReportSchema,
  ProgressiveReadMetricsSchema,
  ProjectGitMirrorUsageSchema,
  RecordRendererErrorsResultSchema,
  RecurringWorkDiagnosticsSchema,
  ResourceRevisionManifestSchema,
  ScheduledJobCreateResultSchema,
  ScheduledJobDeleteResultSchema,
  ScheduledJobListSchema,
  ScheduledJobRunResultSchema,
  ScheduledJobSchema,
  ScopedResourceRevisionManifestSchema,
  ScopedResourceSnapshotBatchSchema,
  SystemUsageSnapshotSchema,
  WorkflowSchedulingReconcileSchema,
  WorktreeLocationsSnapshotSchema,
} from "./schemas.js";

export { recordDomainAdapterUsageCommand } from "../../client-usage.js";
export * from "./fleet-update-policy.js";
export * from "./schemas.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const NoArgs = Schema.Struct({});

// --- Host and diagnostics ---------------------------------------------------

/** The running Orkestrator version. */
export const getAppVersionCommand = defineCommand({
  domain: systemDomain,
  name: "get_app_version",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: Schema.String,
  critical: [],
});

/** Host CPU, RAM, GPU and disk use. */
export const getSystemUsageCommand = defineCommand({
  domain: systemDomain,
  name: "get_system_usage",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: SystemUsageSnapshotSchema,
  critical: [],
});

/** The machine's OS and average load, from the sampler's history (no I/O). */
export const getMachineLoadCommand = defineCommand({
  domain: systemDomain,
  name: MACHINE_LOAD_COMMAND,
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: MachineLoadReportSchema,
  critical: [],
});

/** Child processes of every running environment; a read in flight is joined. */
export const getEnvironmentProcessUsageCommand = defineCommand({
  domain: systemDomain,
  name: "get_environment_process_usage",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: EnvironmentProcessUsageSnapshotSchema,
  critical: [],
});

/** Bounded, content-free recurring-work diagnostics. */
export const getRecurringWorkDiagnosticsCommand = defineCommand({
  domain: systemDomain,
  name: "get_recurring_work_diagnostics",
  since: 1,
  access: "admin",
  read: true,
  args: NoArgs,
  result: RecurringWorkDiagnosticsSchema,
  critical: [],
});

/** Each mixed-version compatibility path's persisted usage. */
export const getCompatibilityPathUsageCommand = defineCommand({
  domain: systemDomain,
  name: "get_compatibility_path_usage",
  since: 1,
  access: "admin",
  read: true,
  args: NoArgs,
  result: CompatibilityPathUsageSnapshotSchema,
  critical: [],
});

/** Database sizes, backups, retention, lease waits and slow operations. */
export const getDatabaseStatsCommand = defineCommand({
  domain: systemDomain,
  name: "get_database_stats",
  since: 1,
  access: "admin",
  read: true,
  args: NoArgs,
  result: DatabaseStatsSchema,
  critical: [],
});

/** Timings of the last progressive reads per domain. */
export const getProgressiveReadMetricsCommand = defineCommand({
  domain: systemDomain,
  name: "get_progressive_read_metrics",
  since: 1,
  access: "admin",
  read: true,
  args: NoArgs,
  result: ProgressiveReadMetricsSchema,
  critical: [],
});

/** Transcript artifact counters. */
export const getArtifactMetricsCommand = defineCommand({
  domain: systemDomain,
  name: "get_artifact_metrics",
  since: 1,
  access: "admin",
  read: true,
  args: NoArgs,
  result: ArtifactMetricsSchema,
  critical: [],
});

/** Builds a diagnostics bundle in memory; answers its manifest. */
export const planDiagnosticsBundleCommand = defineCommand({
  domain: systemDomain,
  name: "plan_diagnostics_bundle",
  since: 1,
  access: "admin",
  read: false,
  args: NoArgs,
  result: DiagnosticsBundlePlanSchema,
  critical: [],
});

/** One chunk of a planned bundle's archive, from `offset`. */
export const readDiagnosticsBundleCommand = defineCommand({
  domain: systemDomain,
  name: "read_diagnostics_bundle",
  since: 1,
  access: "admin",
  read: true,
  args: Schema.Struct({
    planId: Schema.String,
    // Read with `Number(offset)`: an absent or odd value is the bundle's own refusal.
    offset: optionalUnknown,
  }),
  result: DiagnosticsBundleChunkSchema,
  critical: [],
});

/** Every keyed scheduling owner re-reads storage now and reports content-free counts. */
export const reconcileWorkflowSchedulingCommand = defineCommand({
  domain: systemDomain,
  name: "reconcile_workflow_scheduling",
  since: 1,
  access: "admin",
  read: false,
  args: NoArgs,
  result: WorkflowSchedulingReconcileSchema,
  critical: [],
});

/** A desktop window's new renderer error counts, into the essential log. */
export const recordRendererErrorsCommand = defineCommand({
  domain: systemDomain,
  name: RECORD_RENDERER_ERRORS_COMMAND,
  since: 1,
  access: "admin",
  read: false,
  // Parsed by the recorder, which keeps its own message for a malformed batch.
  args: Schema.Struct({ entries: optionalUnknown }),
  result: RecordRendererErrorsResultSchema,
  critical: [],
});

/** The backend's greeting, a connectivity check. */
export const greetCommand = defineCommand({
  domain: systemDomain,
  name: "greet",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ name: Schema.String }),
  result: Schema.String,
  critical: [],
});

// --- Host maintenance -------------------------------------------------------

/** The host's version, updater, job and tasks; `detail: true` adds live readings. */
export const getHostMaintenanceCommand = defineCommand({
  domain: systemDomain,
  name: "get_host_maintenance",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ detail: optionalUnknown }),
  result: HostMaintenanceSnapshotSchema,
  critical: [],
});

/** What restarting the host would interrupt; `null` when it cannot be measured. */
export const getHostRestartImpactCommand = defineCommand({
  domain: systemDomain,
  name: "get_host_restart_impact",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: Schema.NullOr(HostRestartImpactSchema),
  critical: [],
});

export const requestHostUpdateCheckCommand = defineCommand({
  domain: systemDomain,
  name: "request_host_update_check",
  since: 1,
  access: "admin",
  read: false,
  args: NoArgs,
  result: HostMaintenanceSnapshotSchema,
  critical: [],
});

/** Starts installing an update; the host restarts after its countdown. */
export const requestHostUpdateCommand = defineCommand({
  domain: systemDomain,
  name: "request_host_update",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    version: optionalUnknown,
    drain: optionalUnknown,
    maxWaitSeconds: optionalUnknown,
  }),
  result: HostUpdateJobResultSchema,
  critical: ["version", "drain"],
});

export const cancelHostUpdateCommand = defineCommand({
  domain: systemDomain,
  name: "cancel_host_update",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ jobId: optionalUnknown }),
  result: HostUpdateJobResultSchema,
  critical: ["jobId"],
});

export const startHostToolchainRepairCommand = defineCommand({
  domain: systemDomain,
  name: "start_host_toolchain_repair",
  since: 1,
  access: "admin",
  read: false,
  args: NoArgs,
  result: HostTaskSchema,
  critical: [],
});

export const startHostImageUpdateCommand = defineCommand({
  domain: systemDomain,
  name: "start_host_image_update",
  since: 1,
  access: "admin",
  read: false,
  args: NoArgs,
  result: HostTaskSchema,
  critical: [],
});

export const setHostUpdateChannelCommand = defineCommand({
  domain: systemDomain,
  name: "set_host_update_channel",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ channel: optionalUnknown }),
  result: HostMaintenanceSnapshotSchema,
  critical: [],
});

export const setHostGhChannelCommand = defineCommand({
  domain: systemDomain,
  name: "set_host_gh_channel",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ channel: optionalUnknown }),
  result: HostTaskSchema,
  critical: [],
});

// --- Bug reports ------------------------------------------------------------

export const getBugReportCommand = defineCommand({
  domain: systemDomain,
  name: "get_bug_report",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: BugReportSnapshotSchema,
  critical: [],
});

export const createBugReportCommand = defineCommand({
  domain: systemDomain,
  name: "create_bug_report",
  since: 1,
  access: "workspace",
  read: false,
  // Sanitised by the service (`sanitizeBugReportClientContext`).
  args: Schema.Struct({ clientContext: optionalUnknown }),
  result: BugReportSnapshotSchema,
  critical: [],
});

export const assignBugReportAgentCommand = defineCommand({
  domain: systemDomain,
  name: "assign_bug_report_agent",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ reportId: Schema.String, agent: optionalUnknown }),
  result: BugReportSnapshotSchema,
  critical: [],
});

export const saveBugReportScreenshotCommand = defineCommand({
  domain: systemDomain,
  name: "save_bug_report_screenshot",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ reportId: Schema.String, base64Data: optionalUnknown }),
  result: BugReportScreenshotResultSchema,
  critical: [],
});

/** Writes a file into the report's scratch directory; answers its path. */
export const writeBugReportAttachmentCommand = defineCommand({
  domain: systemDomain,
  name: "write_bug_report_attachment",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    reportId: Schema.String,
    filename: Schema.String,
    base64Data: Schema.String,
  }),
  result: Schema.String,
  critical: [],
});

/** Files the issue with `gh`, or answers the prefilled browser URL (`via: "browser"`). */
export const fileBugReportCommand = defineCommand({
  domain: systemDomain,
  name: "file_bug_report",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    reportId: Schema.String,
    title: optionalUnknown,
    body: optionalUnknown,
    via: optionalUnknown,
  }),
  result: BugReportFileResultSchema,
  critical: ["via"],
});

export const markBugReportFiledCommand = defineCommand({
  domain: systemDomain,
  name: "mark_bug_report_filed",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ reportId: Schema.String, url: optionalUnknown }),
  result: BugReportSnapshotSchema,
  critical: [],
});

export const discardBugReportCommand = defineCommand({
  domain: systemDomain,
  name: "discard_bug_report",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({ reportId: Schema.String }),
  result: BugReportSnapshotSchema,
  critical: [],
});

// --- Scheduled jobs ---------------------------------------------------------

/** The trigger, naming and catch-up keys create and update share (own messages). */
const scheduleTimingFields = {
  at: optionalUnknown,
  cron: optionalUnknown,
  everySeconds: optionalUnknown,
  startAt: optionalUnknown,
  timeZone: optionalUnknown,
  name: optionalUnknown,
  catchUpMinutes: optionalUnknown,
} as const;

/** `scheduleId is required`: the handler's own message. */
const scheduleIdArgs = Schema.Struct({ scheduleId: optionalUnknown });

export const listScheduledJobsCommand = defineCommand({
  domain: systemDomain,
  name: "list_scheduled_jobs",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    projectId: optionalUnknown,
    environmentId: optionalUnknown,
    state: optionalUnknown,
    ownerKind: optionalUnknown,
  }),
  result: ScheduledJobListSchema,
  critical: [],
});

export const getScheduledJobCommand = defineCommand({
  domain: systemDomain,
  name: "get_scheduled_job",
  since: 1,
  access: "workspace",
  read: true,
  args: scheduleIdArgs,
  result: ScheduledJobSchema,
  critical: [],
});

export const createScheduledJobCommand = defineCommand({
  domain: systemDomain,
  name: "create_scheduled_job",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    requestId: optionalUnknown,
    ...scheduleTimingFields,
    paused: optionalUnknown,
    action: optionalUnknown,
  }),
  result: ScheduledJobCreateResultSchema,
  critical: ["requestId"],
});

export const updateScheduledJobCommand = defineCommand({
  domain: systemDomain,
  name: "update_scheduled_job",
  since: 1,
  access: "workspace",
  read: false,
  args: Schema.Struct({
    scheduleId: optionalUnknown,
    ...scheduleTimingFields,
    action: optionalUnknown,
    expectedRevision: optionalUnknown,
  }),
  result: ScheduledJobSchema,
  critical: ["expectedRevision"],
});

export const pauseScheduledJobCommand = defineCommand({
  domain: systemDomain,
  name: "pause_scheduled_job",
  since: 1,
  access: "workspace",
  read: false,
  args: scheduleIdArgs,
  result: ScheduledJobSchema,
  critical: [],
});

export const resumeScheduledJobCommand = defineCommand({
  domain: systemDomain,
  name: "resume_scheduled_job",
  since: 1,
  access: "workspace",
  read: false,
  args: scheduleIdArgs,
  result: ScheduledJobSchema,
  critical: [],
});

export const runScheduledJobCommand = defineCommand({
  domain: systemDomain,
  name: "run_scheduled_job",
  since: 1,
  access: "workspace",
  read: false,
  args: scheduleIdArgs,
  result: ScheduledJobRunResultSchema,
  critical: [],
});

export const deleteScheduledJobCommand = defineCommand({
  domain: systemDomain,
  name: "delete_scheduled_job",
  since: 1,
  access: "workspace",
  read: false,
  args: scheduleIdArgs,
  result: ScheduledJobDeleteResultSchema,
  critical: [],
});

// --- Disk usage and worktree locations --------------------------------------

export const listDiskUsageEnvironmentsCommand = defineCommand({
  domain: systemDomain,
  name: "list_disk_usage_environments",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: Schema.Array(DiskUsageEnvironmentSummarySchema),
  critical: [],
});

export const listProjectGitMirrorUsageCommand = defineCommand({
  domain: systemDomain,
  name: "list_project_git_mirror_usage",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: Schema.Array(ProjectGitMirrorUsageSchema),
  critical: [],
});

export const getEnvironmentDiskUsageCommand = defineCommand({
  domain: systemDomain,
  name: "get_environment_disk_usage",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ environmentId: Schema.String, refresh: optionalUnknown }),
  result: EnvironmentDiskUsageSchema,
  critical: [],
});

export const getWorktreeLocationsCommand = defineCommand({
  domain: systemDomain,
  name: "get_worktree_locations",
  since: 1,
  access: "workspace",
  read: true,
  args: NoArgs,
  result: WorktreeLocationsSnapshotSchema,
  critical: [],
});

/** Replaces both settings; an absent or null one goes back to its default. */
export const updateWorktreeLocationsCommand = defineCommand({
  domain: systemDomain,
  name: "update_worktree_locations",
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({ environments: optionalUnknown, dev: optionalUnknown }),
  result: WorktreeLocationsSnapshotSchema,
  critical: [],
});

// --- Resource manifests -----------------------------------------------------

/** Revisions that differ from the client's known ones (all of them on a generation reset). */
export const getResourceRevisionManifestCommand = defineCommand({
  domain: systemDomain,
  name: "get_resource_revision_manifest",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ knownGeneration: optionalUnknown, knownRevisions: optionalUnknown }),
  result: ResourceRevisionManifestSchema,
  critical: [],
});

/** The changed resource scopes after `cursor`, bounded by `highWater`. */
export const getScopedResourceRevisionManifestCommand = defineCommand({
  domain: systemDomain,
  name: "get_scoped_resource_revision_manifest",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({
    knownGeneration: optionalUnknown,
    cursor: optionalUnknown,
    highWater: optionalUnknown,
    knownRevisions: optionalUnknown,
  }),
  result: ScopedResourceRevisionManifestSchema,
  critical: [],
});

/** The authoritative snapshots of at most 32 changed scopes, each with its revision. */
export const getScopedResourceSnapshotsCommand = defineCommand({
  domain: systemDomain,
  name: "get_scoped_resource_snapshots",
  since: 1,
  access: "workspace",
  read: true,
  args: Schema.Struct({ changes: optionalUnknown }),
  result: ScopedResourceSnapshotBatchSchema,
  critical: [],
});

/** Every defined `system` command. */
export const SYSTEM_COMMANDS = [
  recordDomainAdapterUsageCommand,
  getFleetUpdatePolicyCommand,
  setFleetUpdatePolicyCommand,
  getAppVersionCommand,
  getSystemUsageCommand,
  getMachineLoadCommand,
  getEnvironmentProcessUsageCommand,
  getRecurringWorkDiagnosticsCommand,
  getCompatibilityPathUsageCommand,
  getDatabaseStatsCommand,
  getProgressiveReadMetricsCommand,
  getArtifactMetricsCommand,
  planDiagnosticsBundleCommand,
  readDiagnosticsBundleCommand,
  reconcileWorkflowSchedulingCommand,
  recordRendererErrorsCommand,
  greetCommand,
  getHostMaintenanceCommand,
  getHostRestartImpactCommand,
  requestHostUpdateCheckCommand,
  requestHostUpdateCommand,
  cancelHostUpdateCommand,
  startHostToolchainRepairCommand,
  startHostImageUpdateCommand,
  setHostUpdateChannelCommand,
  setHostGhChannelCommand,
  getBugReportCommand,
  createBugReportCommand,
  assignBugReportAgentCommand,
  saveBugReportScreenshotCommand,
  writeBugReportAttachmentCommand,
  fileBugReportCommand,
  markBugReportFiledCommand,
  discardBugReportCommand,
  listScheduledJobsCommand,
  getScheduledJobCommand,
  createScheduledJobCommand,
  updateScheduledJobCommand,
  pauseScheduledJobCommand,
  resumeScheduledJobCommand,
  runScheduledJobCommand,
  deleteScheduledJobCommand,
  listDiskUsageEnvironmentsCommand,
  listProjectGitMirrorUsageCommand,
  getEnvironmentDiskUsageCommand,
  getWorktreeLocationsCommand,
  updateWorktreeLocationsCommand,
  getResourceRevisionManifestCommand,
  getScopedResourceRevisionManifestCommand,
  getScopedResourceSnapshotsCommand,
] as const;
