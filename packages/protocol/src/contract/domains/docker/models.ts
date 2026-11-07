/**
 * What the `docker` commands answer (plan item 7003): the shapes of
 * `@orkestrator/protocol/docker-availability`, `image-manifest`,
 * `container-host-reachability`, `container-resources` and
 * `container-recovery`, and the backend's container listing and log
 * follower, field for field.
 *
 * Same rules as `../environments/models.ts`: `Schema.Finite` numbers,
 * `Schema.optionalKey` for fields an older backend may leave out, mutable
 * arrays so the inferred types stay assignable to the existing TypeScript
 * types. A client decodes results tolerantly, so every field a caller reads
 * is declared. A new literal in a vocabulary below (availability reason,
 * image state, topology kind, probe outcome, cleanup classification) is a
 * change an older client cannot decode, so it bumps the domain.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import { mutableArray } from "../../model-schema.js";
import { IMAGE_CAPABILITIES, type ImageCapability } from "../../../image-manifest.js";
import { ContainerResourceLimitsSchema } from "../environments/models.js";

const nullableString = Schema.NullOr(Schema.String);
const nullableNumber = Schema.NullOr(Schema.Finite);
const nullableBoolean = Schema.NullOr(Schema.Boolean);

/** `DockerAvailability`: available, or why not. */
export const DockerAvailabilitySchema = Schema.Union([
  Schema.Struct({ available: Schema.Literal(true), reason: Schema.Null }),
  Schema.Struct({
    available: Schema.Literal(false),
    reason: Schema.Literals([
      "not-installed",
      "permission-denied",
      "daemon-unavailable",
      "timed-out",
      "unknown",
    ]),
  }),
]);

const IMAGE_CAPABILITY_NAMES = Object.keys(IMAGE_CAPABILITIES) as [
  ImageCapability,
  ...ImageCapability[],
];

export const ImageCapabilitySchema = Schema.Literals(IMAGE_CAPABILITY_NAMES);

/** `ImageStatus`: the configured image's identity and contract compatibility. */
export const ImageStatusSchema = Schema.Struct({
  state: Schema.Literals(["missing", "compatible", "legacy", "incompatible", "unavailable"]),
  imageRef: Schema.String,
  imageId: nullableString,
  registryDigest: nullableString,
  architecture: nullableString,
  manifest: Schema.NullOr(
    Schema.Struct({
      appVersion: Schema.String,
      sourceRevision: nullableString,
      // Capability names grow with the image; an unknown one is kept by name.
      capabilities: Schema.Record(Schema.String, Schema.Finite),
      agents: Schema.Record(Schema.String, Schema.String),
      runtimes: Schema.Record(Schema.String, Schema.String),
    }),
  ),
  missingCapabilities: mutableArray(ImageCapabilitySchema),
  remediation: nullableString,
});

/** `DockerTopology`: where the daemon runs and what it supports. */
export const DockerTopologySchema = Schema.Struct({
  kind: Schema.Literals(["local-engine", "desktop", "remote", "unknown", "unavailable"]),
  rootless: Schema.Boolean,
  osType: nullableString,
  architecture: nullableString,
  serverVersion: nullableString,
  supportsLocalResources: Schema.Boolean,
  remediation: nullableString,
});

export const ContainerHostProbeSchema = Schema.Struct({
  scope: Schema.Literals(["default-bridge", "environment-network", "environment-container"]),
  network: nullableString,
  subnet: nullableString,
  containerId: nullableString,
  outcome: Schema.Literals(["reachable", "timeout", "refused", "unreachable", "dns", "error"]),
  httpStatus: nullableNumber,
  elapsedMs: Schema.Finite,
  detail: nullableString,
  hostAddress: Schema.optional(nullableString),
});

/** `ContainerHostReachability`: can containers reach the agent tools server. */
export const ContainerHostReachabilitySchema = Schema.Struct({
  status: Schema.Literals(["checking", "reachable", "blocked", "unverified", "not-applicable"]),
  reason: Schema.NullOr(
    Schema.Literals([
      "not-linux",
      "docker-remote",
      "docker-unavailable",
      "agent-tools-not-listening",
      "probe-image-unavailable",
      "probe-failed",
      "not-checked",
    ]),
  ),
  summary: Schema.String,
  checkedAt: nullableString,
  trigger: Schema.NullOr(Schema.Literals(["boot", "manual", "recheck"])),
  port: nullableNumber,
  url: nullableString,
  probeImage: nullableString,
  probes: mutableArray(ContainerHostProbeSchema),
  firewall: Schema.Struct({
    kind: Schema.Literals(["ufw", "firewalld", "nftables", "iptables", "unknown"]),
    detail: nullableString,
  }),
  subnets: mutableArray(Schema.String),
  remediation: Schema.NullOr(
    Schema.Struct({
      title: Schema.String,
      steps: mutableArray(Schema.String),
      commands: mutableArray(Schema.String),
    }),
  ),
  dockerRootless: Schema.optional(Schema.Boolean),
  hostAddress: Schema.optional(nullableString),
}).annotate({ identifier: "ContainerHostReachability" });

/** The `support` of `ResourceEnforcement` and `DockerCapacity`. */
const ResourceSupportSchema = Schema.Struct({
  cpuQuota: nullableBoolean,
  memoryLimit: nullableBoolean,
  pidsLimit: nullableBoolean,
});

export const DockerDiskUsageSchema = Schema.Struct({
  imagesBytes: nullableNumber,
  containersBytes: nullableNumber,
  volumesBytes: nullableNumber,
  buildCacheBytes: nullableNumber,
  measuredAt: nullableString,
});

/** `DockerCapacity`: the daemon's capacity (on Docker Desktop, its VM) and disk use. */
export const DockerCapacitySchema = Schema.Struct({
  scope: Schema.Literal("docker-daemon"),
  cpus: nullableNumber,
  memoryBytes: nullableNumber,
  operatingSystem: nullableString,
  rootless: Schema.Boolean,
  cgroupVersion: nullableString,
  support: ResourceSupportSchema,
  logDrivers: mutableArray(Schema.String),
  disk: DockerDiskUsageSchema,
  builtInDefault: Schema.optional(
    Schema.Struct({
      limits: ContainerResourceLimitsSchema,
      unenforced: mutableArray(Schema.Literals(["cpus", "memoryMiB", "pids"])),
    }),
  ),
});

export const ContainerUsageSampleSchema = Schema.Struct({
  containerId: Schema.String,
  environmentId: nullableString,
  state: Schema.String,
  cpuCores: nullableNumber,
  memoryBytes: nullableNumber,
  memoryLimitBytes: nullableNumber,
  pids: nullableNumber,
  oomKilled: nullableBoolean,
  oomEvents: nullableNumber,
  exitCode: nullableNumber,
});

/** `ContainerUsageSnapshot`: one bounded sample of this installation's containers. */
export const ContainerUsageSnapshotSchema = Schema.Struct({
  scope: Schema.Literal("installation"),
  sampledAt: nullableString,
  stale: Schema.Boolean,
  containers: mutableArray(ContainerUsageSampleSchema),
  error: nullableString,
});

/**
 * `get_docker_system_stats`: daemon capacity with this installation's usage.
 * Every figure Docker would not report is `null`, never zero. The fields
 * after `imagesTotal` were added later; older backends leave them out.
 */
export const DockerSystemStatsSchema = Schema.Struct({
  memoryUsed: nullableNumber,
  memoryTotal: nullableNumber,
  cpus: nullableNumber,
  cpuUsagePercent: nullableNumber,
  diskUsed: nullableNumber,
  diskTotal: nullableNumber,
  containersRunning: Schema.Finite,
  containersTotal: Schema.Finite,
  imagesTotal: nullableNumber,
  scope: Schema.optional(
    Schema.Struct({
      capacity: Schema.Literal("docker-daemon"),
      usage: Schema.Literal("installation"),
      disk: Schema.Literal("docker-daemon"),
    }),
  ),
  sampledAt: Schema.optional(nullableString),
  stale: Schema.optional(Schema.Boolean),
  cpuCoresUsed: Schema.optional(nullableNumber),
  memoryTotalKnown: Schema.optional(Schema.Boolean),
  diskKnown: Schema.optional(Schema.Boolean),
  diskBreakdown: Schema.optional(DockerDiskUsageSchema),
});

/** Why cleanup would refuse a container (`CleanupExclusionReason`). */
export const CleanupExclusionReasonSchema = Schema.Literals([
  "assigned",
  "retained-recovery",
  "live-environment-label",
  "operation-in-flight",
  "deletion-pending",
  "running",
  "foreign-owner",
  "identity-uncertain",
  "legacy-unadopted",
]);

/** One row of `get_orkestrator_containers`. Fields after `isAssigned` came later. */
export const ContainerInfoSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  state: Schema.String,
  image: Schema.String,
  created: nullableNumber,
  environmentId: nullableString,
  projectId: nullableString,
  isAssigned: Schema.Boolean,
  cleanupExclusion: Schema.optional(Schema.NullOr(CleanupExclusionReasonSchema)),
  cpuPercent: nullableNumber,
  memoryBytes: Schema.optional(nullableNumber),
  oomKilled: Schema.optional(nullableBoolean),
  oomEvents: Schema.optional(nullableNumber),
});

/** A followed container log: the subscription, its source and the start cursor. */
export const ContainerLogSubscriptionSchema = Schema.Struct({
  subscriptionId: Schema.String,
  sourceId: Schema.String,
  cursor: Schema.Finite,
});

const ContainerLogRecordSchema = Schema.Struct({ seq: Schema.Finite, text: Schema.String });

/** `LogReadResult`: records after a cursor, or a gap and the retained tail. */
export const ContainerLogReadSchema = Schema.Struct({
  kind: Schema.Literals(["records", "gap"]),
  sourceId: Schema.String,
  records: mutableArray(ContainerLogRecordSchema),
  cursor: Schema.Finite,
  ended: Schema.Boolean,
});

export const CleanupResourceKindSchema = Schema.Literals(["container", "volume", "network"]);

export const CleanupClassificationSchema = Schema.Literals([
  "eligible",
  "assigned",
  "retained-recovery",
  "live-environment-label",
  "operation-in-flight",
  "deletion-pending",
  "running",
  "foreign-owner",
  "identity-uncertain",
  "legacy-unadopted",
  "in-use",
]);

/** `CleanupPreview`: the reviewed set, bound to a short-lived selection token. */
export const CleanupPreviewSchema = Schema.Struct({
  selectionToken: Schema.String,
  expiresAt: Schema.String,
  rows: mutableArray(
    Schema.Struct({
      kind: CleanupResourceKindSchema,
      id: Schema.String,
      name: Schema.String,
      environmentId: nullableString,
      role: nullableString,
      sizeBytes: nullableNumber,
      classification: CleanupClassificationSchema,
    }),
  ),
  truncated: Schema.Boolean,
  legacyRuntimes: Schema.optional(
    mutableArray(
      Schema.Struct({
        environmentId: Schema.String,
        environmentName: Schema.String,
        containerId: Schema.String,
        exposures: mutableArray(Schema.Literals(["host-mounts", "shared-bridge"])),
        busy: Schema.Boolean,
      }),
    ),
  ),
  legacyRuntimesUnchecked: Schema.optional(Schema.Finite),
});

/** `CleanupExecuteResult`: one outcome per selected resource, and the totals. */
export const CleanupExecuteResultSchema = Schema.Struct({
  outcomes: mutableArray(
    Schema.Struct({
      kind: CleanupResourceKindSchema,
      id: Schema.String,
      outcome: Schema.Literals(["removed", "already-absent", "skipped", "conflict", "failed"]),
      reason: Schema.optional(
        Schema.Union([
          CleanupClassificationSchema,
          Schema.Literals(["not-in-preview", "state-changed", "removal-failed"]),
        ]),
      ),
    }),
  ),
  removed: Schema.Finite,
  alreadyAbsent: Schema.Finite,
  skipped: Schema.Finite,
  conflicts: Schema.Finite,
  failed: Schema.Finite,
  reclaimedBytes: Schema.Finite,
});

/** `propagate_github_token_to_containers`: environments updated, and `[id, error]` failures. */
export const PropagateTokenResultSchema = Schema.Struct({
  updated: mutableArray(Schema.String),
  failed: mutableArray(Schema.mutable(Schema.Tuple([Schema.String, Schema.String]))),
});
