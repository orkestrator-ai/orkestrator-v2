/**
 * Result schemas of the `system` commands (plan item 7009).
 *
 * Records the protocol already types (host maintenance, bug reports, disk
 * usage, scheduled jobs, diagnostics, resource manifests, machine load) are
 * `modelRecord<T>()`: the fields a reader identifies or branches on are
 * validated, every other key passes through, and the decoded type is the
 * protocol's own interface, so the web reads typed results without a cast.
 * Records only the backend types (system and process usage, recurring-work
 * diagnostics, compatibility path usage, progressive read samples) are
 * {@link openRecord}s with the same rule.
 *
 * Values a newer backend may extend (states, kinds, channels, reasons) are
 * `Schema.String`, so an older client still reads them. A field the backend
 * always writes is required; one an older backend leaves out is optional.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  DatabaseStats,
  DiagnosticsBundleChunk,
  DiagnosticsBundlePlan,
} from "../../../backend-diagnostics.js";
import type {
  BugReportDraft,
  BugReportFileResult,
  BugReportSnapshot,
  BugReportSummary,
} from "../../../bug-report.js";
import type {
  DiskUsageEnvironmentSummary,
  EnvironmentDiskUsage,
  ProjectGitMirrorUsage,
  WorktreeLocationsSnapshot,
} from "../../../disk-usage.js";
import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
  HostTask,
  HostUpdateJob,
} from "../../../host-maintenance.js";
import type { MachineLoadReport, MachineLoadWindow } from "../../../machine-load.js";
import type {
  ResourceChange,
  ScopedResourceRevisionManifest,
  ScopedResourceSnapshotBatch,
} from "../../../resource-events.js";
import type {
  ScheduledJob,
  ScheduledJobSummary,
  ScheduleFire,
  SchedulerStatus,
} from "../../../scheduled-jobs.js";
import { modelRecord, type ModelSchema, openRecord } from "../../model-schema.js";

const Count = Schema.Finite;
const NullableString = Schema.NullOr(Schema.String);
const NullableFinite = Schema.NullOr(Schema.Finite);

/** Content-free counts keyed by name. */
export const CountsSchema = Schema.Record(Schema.String, Schema.Finite);

// --- Host maintenance -------------------------------------------------------

export const HostUpdateJobSchema: ModelSchema<HostUpdateJob> = modelRecord<HostUpdateJob>()({
  id: Schema.String,
  state: Schema.String,
  fromVersion: Schema.String,
  requestedVersion: NullableString,
  targetVersion: NullableString,
  drain: Schema.String,
  requestedAt: Schema.String,
  updatedAt: Schema.String,
});

export const HostTaskSchema: ModelSchema<HostTask> = modelRecord<HostTask>()({
  id: Schema.String,
  kind: Schema.String,
  state: Schema.String,
  startedAt: Schema.String,
  updatedAt: Schema.String,
});

export const HostRestartImpactSchema: ModelSchema<HostRestartImpact> =
  modelRecord<HostRestartImpact>()({
    workingAgents: Count,
    waitingAgents: Count,
    unknownAgents: Schema.optionalKey(Count),
    activePipelines: Count,
    terminals: Count,
    containerTerminals: Schema.optionalKey(Count),
    hostServers: Count,
    measuredAt: Schema.String,
  });

export const HostMaintenanceSnapshotSchema: ModelSchema<HostMaintenanceSnapshot> =
  modelRecord<HostMaintenanceSnapshot>()({
    revision: Count,
    version: Schema.String,
    updater: Schema.Struct({
      kind: Schema.String,
      available: Schema.Boolean,
      reason: NullableString,
    }),
    job: Schema.NullOr(HostUpdateJobSchema),
    ghChannel: Schema.String,
    updateChannel: Schema.String,
    impact: Schema.optionalKey(HostRestartImpactSchema),
  });

/** `request_host_update` and `cancel_host_update`: the job and the snapshot after it. */
export const HostUpdateJobResultSchema = Schema.Struct({
  job: HostUpdateJobSchema,
  snapshot: HostMaintenanceSnapshotSchema,
});

// --- Bug reports ------------------------------------------------------------

const BugReportSummarySchema = modelRecord<BugReportSummary>()({
  id: Schema.String,
  runtimeId: Schema.String,
  tabId: Schema.String,
  createdAt: Schema.String,
  screenshots: Schema.Array(Schema.String),
});

const BugReportDraftSchema = modelRecord<BugReportDraft>()({
  title: Schema.String,
  body: Schema.String,
  updatedAt: Schema.String,
});

export const BugReportSnapshotSchema: ModelSchema<BugReportSnapshot> =
  modelRecord<BugReportSnapshot>()({
    report: Schema.NullOr(BugReportSummarySchema),
    draft: Schema.NullOr(BugReportDraftSchema),
  });

export const BugReportScreenshotResultSchema = Schema.Struct({
  path: Schema.String,
  snapshot: BugReportSnapshotSchema,
});

/** `filed` with the issue URL, or `browser` with the prefilled new-issue URL. */
export const BugReportFileResultSchema: ModelSchema<BugReportFileResult> =
  modelRecord<BugReportFileResult>()({
    kind: Schema.String,
    url: Schema.String,
  });

// --- Disk usage and worktree locations --------------------------------------

export const DiskUsageEnvironmentSummarySchema: ModelSchema<DiskUsageEnvironmentSummary> =
  modelRecord<DiskUsageEnvironmentSummary>()({
    environmentId: Schema.String,
    name: Schema.String,
    projectId: Schema.String,
    projectName: Schema.String,
    environmentType: Schema.String,
    location: NullableString,
    projectHome: Schema.Boolean,
  });

export const ProjectGitMirrorUsageSchema: ModelSchema<ProjectGitMirrorUsage> =
  modelRecord<ProjectGitMirrorUsage>()({
    projectId: Schema.String,
    projectName: NullableString,
    path: Schema.String,
    bytes: NullableFinite,
  });

export const EnvironmentDiskUsageSchema: ModelSchema<EnvironmentDiskUsage> =
  modelRecord<EnvironmentDiskUsage>()({
    environmentId: Schema.String,
    environmentType: Schema.String,
    measuredAt: Schema.String,
    primary: openRecord({ kind: Schema.String, bytes: NullableFinite }),
    dev: openRecord({ worktreeBytes: Count, bytes: Count }),
    totalBytes: NullableFinite,
  });

export const WorktreeLocationsSnapshotSchema: ModelSchema<WorktreeLocationsSnapshot> =
  modelRecord<WorktreeLocationsSnapshot>()({
    environments: openRecord({
      configured: NullableString,
      defaultPath: Schema.String,
      effective: Schema.String,
      startupOverride: NullableString,
    }),
    dev: openRecord({
      configured: NullableString,
      defaultPath: Schema.String,
      readOnly: Schema.optionalKey(Schema.Boolean),
    }),
  });

// --- Scheduled jobs ---------------------------------------------------------

const ScheduleFireSchema = modelRecord<ScheduleFire>()({
  fireId: Schema.String,
  kind: Schema.String,
  scheduledFor: Schema.String,
  state: Schema.String,
  attempts: Count,
});

const scheduleFields = {
  id: Schema.String,
  name: Schema.String,
  ownerKey: Schema.String,
  state: Schema.String,
  nextFireAt: NullableString,
  fireCount: Count,
  revision: Count,
  createdAt: Schema.String,
  updatedAt: Schema.String,
} as const;

export const ScheduledJobSchema: ModelSchema<ScheduledJob> = modelRecord<ScheduledJob>()({
  ...scheduleFields,
  fires: Schema.Array(ScheduleFireSchema),
});

export const ScheduledJobSummarySchema: ModelSchema<ScheduledJobSummary> =
  modelRecord<ScheduledJobSummary>()({
    ...scheduleFields,
    lastFire: Schema.NullOr(ScheduleFireSchema),
    activeFire: Schema.NullOr(ScheduleFireSchema),
  });

/** Whether this backend fires schedules; `reason` names why not. */
export const SchedulerStatusSchema: ModelSchema<SchedulerStatus> = modelRecord<SchedulerStatus>()({
  firing: Schema.Boolean,
});

export const ScheduledJobListSchema = Schema.Struct({
  schedules: Schema.Array(ScheduledJobSummarySchema),
  // Additive: absent from older backends, and while no writer lease is known.
  scheduler: Schema.optional(SchedulerStatusSchema),
  revision: Schema.optionalKey(Count),
});

export const ScheduledJobCreateResultSchema = Schema.Struct({
  schedule: ScheduledJobSchema,
  replayed: Schema.Boolean,
});

export const ScheduledJobRunResultSchema = Schema.Struct({
  job: ScheduledJobSchema,
  fire: ScheduleFireSchema,
});

export const ScheduledJobDeleteResultSchema = Schema.Struct({
  scheduleId: Schema.String,
  deleted: Schema.Boolean,
});

// --- Usage, load and diagnostics --------------------------------------------

/** Host CPU, RAM, GPU and disk use (`SystemUsageSnapshot`, backend `system-usage.ts`). */
export const SystemUsageSnapshotSchema = openRecord({
  cpuPercent: Schema.Finite,
  ramPercent: Schema.Finite,
  gpuPercent: NullableFinite,
  diskPercent: NullableFinite,
  sampledAt: Schema.String,
});

const EnvironmentProcessUsageSchema = openRecord({
  pid: Schema.Finite,
  name: Schema.String,
  command: Schema.String,
  cpuPercent: Schema.Finite,
  ramPercent: Schema.Finite,
  rssKb: Schema.Finite,
});

const EnvironmentProcessGroupSchema = openRecord({
  environmentId: Schema.String,
  environmentName: Schema.String,
  projectId: Schema.String,
  environmentType: Schema.String,
  processes: Schema.Array(EnvironmentProcessUsageSchema),
  totalCpuPercent: Schema.Finite,
  totalRssKb: Schema.Finite,
  processCount: Schema.Finite,
  // Absent from older backends.
  truncated: Schema.optionalKey(Schema.Boolean),
});

/** Child processes of every running environment (`EnvironmentProcessUsageSnapshot`). */
export const EnvironmentProcessUsageSnapshotSchema = openRecord({
  environments: Schema.Array(EnvironmentProcessGroupSchema),
  sampledAt: Schema.String,
  truncated: Schema.optionalKey(Schema.Boolean),
});

const MachineLoadWindowSchema = modelRecord<MachineLoadWindow>()({
  window: Schema.String,
  windowSeconds: Schema.Finite,
  coveredSeconds: Schema.Finite,
  cpuPercent: NullableFinite,
  ramPercent: NullableFinite,
});

export const MachineLoadReportSchema: ModelSchema<MachineLoadReport> =
  modelRecord<MachineLoadReport>()({
    osFamily: Schema.String,
    os: Schema.String,
    arch: Schema.String,
    cpuCores: Schema.Finite,
    totalRamGb: Schema.Finite,
    latestSampleAgeSeconds: NullableFinite,
    load: Schema.Array(MachineLoadWindowSchema),
  });

/**
 * Bounded, content-free recurring-work diagnostics (`RecurringWorkDiagnostics`,
 * backend `recurring-diagnostics.ts`): the sections are listed, their entries
 * stay open records.
 */
export const RecurringWorkDiagnosticsSchema = openRecord({
  metrics: openRecord({}),
  schedulers: Schema.Array(openRecord({})),
  admission: Schema.Array(openRecord({})),
  fetchPolicies: Schema.Array(openRecord({ name: Schema.String })),
  signals: Schema.Array(openRecord({ name: Schema.String })),
  sessionInvalidations: openRecord({}),
  caches: Schema.Array(openRecord({ name: Schema.String, sources: Schema.Finite })),
  droppedSources: Schema.Finite,
  faultedSources: Schema.Finite,
});

/** One compatibility path's persisted usage. */
export const CompatibilityPathUsageEntrySchema = openRecord({
  count: Schema.Finite,
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
});

/** `get_compatibility_path_usage`: every taken path by id (`CompatibilityPathUsageSnapshot`). */
export const CompatibilityPathUsageSnapshotSchema = openRecord({
  version: Schema.Finite,
  // `Partial<Record<…>>` in the backend: a path never taken is absent.
  paths: Schema.Record(Schema.String, Schema.UndefinedOr(CompatibilityPathUsageEntrySchema)),
});

/** Database figures; the sections stay open records (`DatabaseStats`). */
export const DatabaseStatsSchema: ModelSchema<DatabaseStats> = modelRecord<DatabaseStats>()({
  generatedAt: Schema.String,
  leaseWaits: openRecord({}),
});

/** The last progressive reads' timings per domain (`ProgressiveReadMetric`). */
export const ProgressiveReadMetricsSchema = Schema.Struct({
  samples: Schema.Array(
    openRecord({
      domain: Schema.String,
      cacheTier: Schema.String,
      outcome: Schema.String,
      durationMs: Schema.Finite,
    }),
  ),
});

/** Transcript artifact counters; empty where artifacts do not run. */
export const ArtifactMetricsSchema = Schema.Struct({
  counters: CountsSchema,
  droppedSeries: Schema.Finite,
});

const DiagnosticsArchiveSchema = Schema.Struct({ bytes: Count, sha256: Schema.String });

export const DiagnosticsBundlePlanSchema: ModelSchema<DiagnosticsBundlePlan> =
  modelRecord<DiagnosticsBundlePlan>()({
    planId: Schema.String,
    fileName: Schema.String,
    expiresAt: Schema.String,
    archive: DiagnosticsArchiveSchema,
    manifest: openRecord({
      schemaVersion: Schema.Finite,
      createdAt: Schema.String,
      entries: Schema.Array(openRecord({ path: Schema.String, bytes: Count })),
    }),
  });

export const DiagnosticsBundleChunkSchema: ModelSchema<DiagnosticsBundleChunk> =
  modelRecord<DiagnosticsBundleChunk>()({
    planId: Schema.String,
    fileName: Schema.String,
    archive: DiagnosticsArchiveSchema,
    offset: Count,
    data: Schema.String,
    nextOffset: NullableFinite,
  });

/**
 * `reconcile_workflow_scheduling`: per keyed scheduling owner that runs here,
 * what the pass recovered (`null` when it failed) and the owner's status.
 */
export const WorkflowSchedulingReconcileSchema = Schema.Record(
  Schema.String,
  Schema.Struct({
    reconciled: Schema.NullOr(
      openRecord({
        scanned: Count,
        complete: Schema.Boolean,
        keys: Count,
        recovered: Count,
        dropped: Count,
      }),
    ),
    status: Schema.NullOr(openRecord({ domain: Schema.String, started: Schema.Boolean })),
  }),
);

/** `record_renderer_errors`: how many entries the essential log took and dropped. */
export const RecordRendererErrorsResultSchema = Schema.Struct({
  accepted: Count,
  dropped: Count,
});

// --- Resource manifests -----------------------------------------------------

const RevisionMapSchema = Schema.Record(Schema.String, Schema.String);

const ResourceChangeSchema = modelRecord<ResourceChange>()({
  resource: Schema.String,
  id: Schema.String,
  revision: Schema.Finite,
});

export const ScopedResourceRevisionManifestSchema: ModelSchema<ScopedResourceRevisionManifest> =
  modelRecord<ScopedResourceRevisionManifest>()({
    generation: Schema.String,
    cursor: Count,
    highWater: Count,
    reset: Schema.Boolean,
    resetResources: Schema.Array(Schema.String),
    changes: Schema.Array(ResourceChangeSchema),
    revisions: RevisionMapSchema,
    hasMore: Schema.Boolean,
  });

/** Each entry is `ok` with its snapshot, or `deferred`/`failed` with no body. */
export const ScopedResourceSnapshotBatchSchema: ModelSchema<ScopedResourceSnapshotBatch> =
  modelRecord<ScopedResourceSnapshotBatch>()({
    entries: Schema.Array(
      openRecord({ resource: Schema.String, id: Schema.String, status: Schema.String }),
    ),
  });
