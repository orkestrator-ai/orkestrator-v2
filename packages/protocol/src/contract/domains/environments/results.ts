/**
 * Result shapes of the `environments` commands besides the environment
 * itself (plan item 7003): container recovery, resources, network policy,
 * portable inputs, setup approval and sessions, log storage, extensions and
 * tab teardown. Each mirrors the TypeScript type named in its comment
 * (`@orkestrator/protocol/container-*` or the backend service), field for
 * field. Browser-safe.
 */
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { mutableArray } from "../../model-schema.js";
import { AGENT_PLATFORMS, type AgentPlatform } from "../../../agent-platforms.js";
import {
  AgentPlatformSchema,
  ContainerResourceLimitsSchema,
  NetworkAccessModeSchema,
} from "./models.js";

const optionalString = Schema.optional(Schema.String);
const optionalBoolean = Schema.optional(Schema.Boolean);
const nullableString = Schema.NullOr(Schema.String);
const nullableNumber = Schema.NullOr(Schema.Finite);

/** `RecoveryCopy` (`container-recovery.ts`). */
export const RecoveryCopySchema = Schema.Struct({
  copyId: Schema.String,
  kind: Schema.Literals(["legacy-runtime", "storage-set"]),
  reason: Schema.Literals([
    "rebuild-source",
    "workspace-reset",
    "restore-source",
    "failed-candidate",
    "migrate-source",
  ]),
  retainedAt: nullableString,
  operationId: nullableString,
  containerId: nullableString,
  storageSetId: nullableString,
  volumes: mutableArray(Schema.String),
  workspaceGeneration: nullableNumber,
  presence: Schema.Literals(["present", "partial", "missing", "unknown"]),
  sizeBytes: nullableNumber,
  restorable: Schema.Boolean,
});

/** `RecoveryCopyList`. */
export const RecoveryCopyListSchema = Schema.Struct({
  environmentId: Schema.String,
  revision: Schema.Finite,
  copies: mutableArray(RecoveryCopySchema),
  limit: Schema.Finite,
});

/** `DiscardCopyResult` (`recovery-copies.ts`). */
export const DiscardCopyResultSchema = Schema.Struct({
  copyId: Schema.String,
  kept: Schema.Struct({ containerId: nullableString, volumes: mutableArray(Schema.String) }),
  discarded: Schema.Boolean,
});

/** `RebuildPreview` (`container-lifecycle.ts`). */
export const RebuildPreviewSchema = Schema.Struct({
  environmentId: Schema.String,
  containerId: nullableString,
  available: Schema.Boolean,
  unavailableReason: Schema.optional(
    Schema.Literals([
      "not-containerized",
      "no-container",
      "operation-in-progress",
      "image-unavailable",
      "image-without-storage-contract",
      "engine-without-volume-subpath",
      "disabled-by-configuration",
      "unsupported-topology",
      "retention-limit",
      "unsupported-format",
      "admission-paused",
    ]),
  ),
  kind: Schema.Literals(["migrate", "rebuild"]),
  preservedPaths: mutableArray(Schema.String),
  notPreserved: mutableArray(Schema.String),
  providers: mutableArray(
    Schema.Struct({
      provider: Schema.String,
      level: Schema.Literals(["full", "partial"]),
      limitations: nullableString,
      resumeQualified: Schema.Boolean,
    }),
  ),
  retainedCopies: Schema.Finite,
  retainedCopyLimit: Schema.Finite,
});

export const ResourceAxisSchema = Schema.Literals(["cpus", "memoryMiB", "pids"]);

/** `EnvironmentResourcePolicy` (`container-resources.ts`). */
export const EnvironmentResourcePolicySchema = Schema.Struct({
  environmentId: Schema.String,
  requested: ContainerResourceLimitsSchema,
  source: Schema.Literals(["environment", "global", "default", "none"]),
  applied: Schema.NullOr(ContainerResourceLimitsSchema),
  unsupported: mutableArray(ResourceAxisSchema),
  daemonRootless: optionalBoolean,
});

/** `set_container_resource_limits`: the saved default, and axes this daemon cannot enforce. */
export const ContainerResourceDefaultResultSchema = Schema.Struct({
  limits: Schema.NullOr(ContainerResourceLimitsSchema),
  unenforceable: Schema.optional(mutableArray(ResourceAxisSchema)),
});

const effectiveNetworkPolicy = Schema.Struct({
  mode: NetworkAccessModeSchema,
  state: Schema.NullOr(Schema.Literals(["applied", "failed"])),
  appliedAt: nullableString,
  resolvedDomains: nullableNumber,
  unresolvedDomains: nullableNumber,
  allowedEntries: nullableNumber,
  hostServicePorts: nullableString,
  ipv6: Schema.NullOr(Schema.Literals(["blocked", "disabled"])),
  githubRanges: Schema.NullOr(Schema.Literals(["seed", "live", "seed-stale", "cached"])),
  domainsRevision: nullableString,
  refreshedAt: nullableString,
  nextRefreshAt: nullableString,
  carriedDomains: nullableNumber,
  carriedUntil: nullableString,
  refreshFailures: nullableNumber,
  revokedEntries: nullableNumber,
  revocation: Schema.NullOr(Schema.Literals(["conntrack", "unavailable"])),
  egressFilter: Schema.optional(Schema.NullOr(Schema.Literals(["enforced", "off", "unavailable"]))),
  refusals: Schema.optional(
    Schema.NullOr(Schema.Struct({ connections: Schema.Finite, queries: Schema.Finite })),
  ),
});

/** `EnvironmentNetworkPolicy` (`container-recovery.ts`). */
export const EnvironmentNetworkPolicySchema = Schema.Struct({
  environmentId: Schema.String,
  configured: Schema.Struct({
    mode: NetworkAccessModeSchema,
    domains: Schema.Finite,
    domainsRevision: Schema.String,
  }),
  policyVersion: Schema.NullOr(Schema.Literals([1, 2, 3])),
  enforcement: Schema.optional(Schema.Literals(["gateway", "container", "none"])),
  network: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ name: Schema.String, subnet: nullableString, gateway: nullableString }),
    ),
  ),
  domains: Schema.NullOr(Schema.Literals(["applied", "pending", "rebuild-required"])),
  effective: Schema.NullOr(effectiveNetworkPolicy),
}).annotate({ identifier: "EnvironmentNetworkPolicy" });

/** `AllowedDomainsApplyResult` (`container-network.ts`). */
export const AllowedDomainsApplyResultSchema = Schema.Struct({
  kind: Schema.Literals(["applied", "not-applicable", "rebuild-required", "not-running", "failed"]),
  policy: EnvironmentNetworkPolicySchema,
});

const INPUT_SKIP_REASONS = [
  "symlink",
  "not-regular",
  "too-large",
  "too-many-entries",
  "aggregate-budget",
  "unreadable",
  "changed-while-reading",
  "login-withheld",
] as const;

/** `Partial<Record<InputSkipReason, number>>`: counts only. */
const inputSkipCounts = Schema.Struct(
  Object.fromEntries(
    INPUT_SKIP_REASONS.map((reason) => [reason, Schema.optional(Schema.Finite)]),
  ) as { [Reason in (typeof INPUT_SKIP_REASONS)[number]]: Schema.optional<Schema.Finite> },
);

/** `EnvironmentInputStatus` (`container-recovery.ts`). */
export const EnvironmentInputStatusSchema = Schema.Struct({
  environmentId: Schema.String,
  mode: Schema.Literals(["staged", "host-mounts", "none", "unknown"]),
  revision: nullableString,
  stagedAt: nullableString,
  providers: mutableArray(
    Schema.Struct({
      provider: Schema.String,
      files: Schema.Finite,
      bytes: Schema.Finite,
      skipped: inputSkipCounts,
    }),
  ),
  missingProviders: mutableArray(Schema.String),
  disabledProviders: mutableArray(Schema.String),
  revokedProviders: mutableArray(Schema.String),
  unreadableOnRootless: optionalBoolean,
});

/** `RevocationResult` (`portable-input-status.ts`; `CredentialRevocationResult` on the wire). */
export const CredentialRevocationResultSchema = Schema.Struct({
  provider: AgentPlatformSchema,
  removed: Schema.Boolean,
  pendingRebuild: Schema.Boolean,
  processesStopped: Schema.Boolean,
});

export const CredentialRestoreResultSchema = Schema.Struct({
  provider: AgentPlatformSchema,
  pendingRebuild: Schema.Boolean,
});

export const ContainerOperationCancelResultSchema = Schema.Struct({
  cancelled: Schema.Boolean,
  pending: optionalBoolean,
});

/** `EnvironmentSetupApproval` (`setup-approval.ts`). */
export const EnvironmentSetupApprovalSchema = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  hash: Schema.String,
  commands: mutableArray(Schema.String),
  defaultBranch: Schema.String,
  defaultBranchCommands: Schema.NullOr(mutableArray(Schema.String)),
  approvalRequired: Schema.Boolean,
});

/** `EnvironmentSetupSession` plus whether its terminal still runs. */
export const EnvironmentSetupSessionSnapshotSchema = Schema.Struct({
  environmentId: Schema.String,
  sessionId: Schema.String,
  running: Schema.Boolean,
  startedAt: Schema.String,
  completedAt: optionalString,
  success: optionalBoolean,
  error: optionalString,
  terminalRunning: Schema.Boolean,
  hasOutput: optionalBoolean,
});
/** `EnvironmentSetupSession`: a setup terminal's state, as the web's types re-export it. */
export type EnvironmentSetupSessionSnapshot = Mutable<
  typeof EnvironmentSetupSessionSnapshotSchema.Type
>;

/** `LogStorageStats` (`log-storage.ts`). */
export const LogStorageStatsSchema = Schema.Struct({
  totalBytes: Schema.Finite,
  fileCount: Schema.Finite,
  essentialBytes: Schema.Finite,
  essentialFileCount: Schema.Finite,
});

const extensionItem = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["connected", "configured", "disabled", "failed", "pending"]),
  source: optionalString,
});

/** `AgentExtensionCatalog` (`extension-discovery.ts`). */
export const AgentExtensionCatalogSchema = Schema.Struct({
  agent: Schema.Literals(
    AGENT_PLATFORMS as unknown as readonly [AgentPlatform, ...AgentPlatform[]],
  ),
  mcpServers: mutableArray(extensionItem),
  plugins: mutableArray(extensionItem),
  mcpError: optionalString,
  pluginError: optionalString,
});

/** The persisted `claude-terminal` activity of a container's environment. */
export const ClaudeTerminalStateSchema = Schema.Struct({
  state: Schema.Literals(["idle", "working", "waiting"]),
  occurredAt: Schema.String,
});

/** A merged or closed environment's PR, kept after the environment is gone. */
export const FinalEnvironmentPrSchema = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
  prUrl: Schema.String,
  prState: Schema.Literals(["merged", "closed"]),
  finalPrState: Schema.Literal(true),
});

/** Always `{ completed: true }` once the teardown finished. */
export const TabTeardownResultSchema = Schema.Struct({ completed: Schema.Boolean });

export const TabTeardownReconcileResultSchema = Schema.Struct({ completed: Schema.Finite });

export const OrphanedTabResourcesResultSchema = Schema.Struct({
  terminals: Schema.Finite,
  nativeSessions: Schema.Finite,
  tmuxSessions: Schema.Finite,
  /** `true` when the pane layouts could not be read and nothing was reaped. */
  skipped: optionalBoolean,
});
