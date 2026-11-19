/**
 * `capabilities` commands: the Agent Capabilities manager
 * (docs/architecture/agent-capabilities-management.md, "Public contracts").
 *
 * Every handler hands its arguments to `CapabilityService`, which checks each
 * one itself and answers a structured error with its own message, so every
 * argument key is `optionalKey(Unknown)`: the decode never refuses what the
 * service accepts, and nothing undeclared reaches it (§11.4). No key is
 * critical: mutations carry their own compare-and-swap revisions, plan
 * digests and request keys, which every version of the service reads.
 *
 * Mutation arguments name things by opaque id (package, setup, operation,
 * inspection, location). No command takes a destination path or a shell
 * command; a local source is named by an opaque source id the machine's own
 * inventory issued.
 *
 * Access:
 * - reads and the per-session selection are `workspace`: a window reaches
 *   them on the node it shows;
 * - fleet mutations (library, setups, machines, updates, import) are
 *   `admin`: they change what every enrolled machine installs;
 * - the per-machine executor (`*_capability_node_*`) is `internal`: only a
 *   command node calls it over its node link, with its single-writer epoch.
 *
 * `read` equals `isNodeReadCommand(name)`, so the router never retries a
 * write it cannot prove did not happen.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";
import type {
  CapabilityActivityList,
  CapabilityChangeResult,
  CapabilityDriftList,
  CapabilityExport,
  CapabilityImportPreview,
  CapabilityInventory,
  CapabilityLibrary,
  CapabilityMachineList,
  CapabilityOperationList,
  CapabilitySessionView,
  CapabilitySetupList,
  CapabilitySourceInspection,
  CapabilityTargetSupportResult,
  CapabilityUpdateList,
  CapabilityVerification,
} from "../../../capability-resources-api.js";
import type {
  CapabilityDriftEntry,
  CapabilityMachineSummary,
  CapabilityOperationSnapshot,
  CapabilityPackageDetail,
  CapabilityPackageSummary,
  CapabilitySetup,
  EffectiveAgentResources,
} from "../../../capability-resources.js";
import { isNodeReadCommand } from "../../../command-nodes.js";
import { defineCommand, type CommandAccess, type WireSchema } from "../../command.js";
import { modelRecord, OpenObject } from "../../model-schema.js";
import { capabilitiesDomain } from "./domain.js";

const optionalUnknown = Schema.optionalKey(Schema.Unknown);
const Strings = Schema.Array(Schema.String);

// --- Result schemas -----------------------------------------------------------

export const CapabilityLibrarySchema = modelRecord<CapabilityLibrary>()({
  revision: Schema.Finite,
  packages: Schema.Array(OpenObject),
  truncated: Schema.Finite,
  epoch: Schema.Finite,
});

export const CapabilityPackageSummarySchema = modelRecord<CapabilityPackageSummary>()({
  id: Schema.String,
  displayName: Schema.String,
  revision: Schema.String,
  artifactDigest: Schema.String,
});

export const CapabilityPackageDetailSchema = modelRecord<CapabilityPackageDetail>()({
  package: OpenObject,
  components: Schema.Array(OpenObject),
  availability: Schema.Array(OpenObject),
});

export const CapabilitySetupSchema = modelRecord<CapabilitySetup>()({
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Finite,
  packageSelections: Schema.Array(OpenObject),
});

export const CapabilitySetupListSchema = modelRecord<CapabilitySetupList>()({
  revision: Schema.Finite,
  setups: Schema.Array(OpenObject),
});

export const CapabilityInventorySchema = modelRecord<CapabilityInventory>()({
  nodeId: Schema.String,
  observedAt: Schema.String,
  items: Schema.Array(OpenObject),
});

export const CapabilityTargetSupportSchema = modelRecord<CapabilityTargetSupportResult>()({
  nodeId: Schema.String,
  matrices: Schema.Array(OpenObject),
});

export const EffectiveAgentResourcesSchema = modelRecord<EffectiveAgentResources>()({
  target: OpenObject,
  manifestDigest: Schema.String,
  resolvedPackages: Schema.Array(OpenObject),
  launchBlockers: Schema.Array(OpenObject),
});

export const CapabilitySourceInspectionSchema = modelRecord<CapabilitySourceInspection>()({
  inspectionId: Schema.String,
  packageId: Schema.String,
  artifactDigest: Schema.String,
  components: Schema.Array(OpenObject),
  secretsFound: Strings,
});

export const CapabilityOperationSchema = modelRecord<CapabilityOperationSnapshot>()({
  id: Schema.String,
  kind: Schema.String,
  state: Schema.String,
  planDigest: Schema.String,
  targets: Schema.Array(OpenObject),
  requiresApproval: Schema.Boolean,
});

export const CapabilityChangeResultSchema = modelRecord<CapabilityChangeResult>()({
  operation: CapabilityOperationSchema,
  replayed: Schema.Boolean,
});

export const CapabilityOperationListSchema = modelRecord<CapabilityOperationList>()({
  operations: Schema.Array(OpenObject),
  truncated: Schema.Finite,
});

export const CapabilityUpdateListSchema = modelRecord<CapabilityUpdateList>()({
  updates: Schema.Array(OpenObject),
});

export const CapabilityActivityListSchema = modelRecord<CapabilityActivityList>()({
  entries: Schema.Array(OpenObject),
  truncated: Schema.Finite,
});

export const CapabilityMachineSummarySchema = modelRecord<CapabilityMachineSummary>()({
  nodeId: Schema.String,
  name: Schema.String,
  enrolled: Schema.Boolean,
});

export const CapabilityMachineListSchema = modelRecord<CapabilityMachineList>()({
  machines: Schema.Array(OpenObject),
  groups: Strings,
});

export const CapabilityDriftListSchema = modelRecord<CapabilityDriftList>()({
  drift: Schema.Array(OpenObject),
});

export const CapabilityDriftEntrySchema = modelRecord<CapabilityDriftEntry>()({
  id: Schema.String,
  state: Schema.String,
});

export const CapabilityExportSchema = modelRecord<CapabilityExport>()({
  intentFile: Schema.String,
  intent: Schema.String,
  lockFile: Schema.String,
  lock: Schema.String,
});

export const CapabilityImportPreviewSchema = modelRecord<CapabilityImportPreview>()({
  previewId: Schema.String,
  issues: Schema.Array(OpenObject),
  valid: Schema.Boolean,
});

export const CapabilityVerificationSchema = modelRecord<CapabilityVerification>()({
  target: OpenObject,
  checks: Schema.Array(OpenObject),
  verifiedAt: Schema.String,
});

export const CapabilitySessionViewSchema = modelRecord<CapabilitySessionView>()({
  sessionKey: Schema.String,
  setupIds: Strings,
  readiness: Schema.String,
});

export const CapabilityFileSchema = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  truncated: Schema.Boolean,
});

// --- Definitions ----------------------------------------------------------------

function capabilityCommand<
  const Name extends string,
  const Keys extends readonly string[],
  R extends WireSchema,
>(name: Name, access: CommandAccess, keys: Keys, result: R) {
  const fields = Object.fromEntries(keys.map((key) => [key, optionalUnknown])) as {
    readonly [K in Keys[number]]: typeof optionalUnknown;
  };
  return defineCommand({
    domain: capabilitiesDomain,
    name,
    since: 1,
    access,
    read: isNodeReadCommand(name),
    critical: [],
    args: Schema.Struct(fields),
    result,
  });
}

// Library and inventory (reads).
export const listCapabilityPackagesCommand = capabilityCommand(
  "list_capability_packages",
  "workspace",
  ["query", "kind", "setupId", "limit"],
  CapabilityLibrarySchema,
);
export const getCapabilityPackageCommand = capabilityCommand(
  "get_capability_package",
  "workspace",
  ["packageId"],
  CapabilityPackageDetailSchema,
);
export const readCapabilityFileCommand = capabilityCommand(
  "read_capability_file",
  "workspace",
  ["packageId", "path"],
  CapabilityFileSchema,
);
export const listCapabilitySetupsCommand = capabilityCommand(
  "list_capability_setups",
  "workspace",
  [],
  CapabilitySetupListSchema,
);
export const getCapabilityInventoryCommand = capabilityCommand(
  "get_capability_inventory",
  "workspace",
  ["nodeId", "refresh"],
  CapabilityInventorySchema,
);
export const getCapabilityTargetSupportCommand = capabilityCommand(
  "get_capability_target_support",
  "workspace",
  ["nodeId", "location"],
  CapabilityTargetSupportSchema,
);
export const getEffectiveAgentResourcesCommand = capabilityCommand(
  "get_effective_agent_resources",
  "workspace",
  ["target", "setupIds", "selections", "exclusions", "templateId", "graphNode", "ceiling"],
  EffectiveAgentResourcesSchema,
);
export const getCapabilitySessionViewCommand = capabilityCommand(
  "get_capability_session_view",
  "workspace",
  ["sessionKey", "target", "sessionRunning", "catalogue", "ceiling"],
  CapabilitySessionViewSchema,
);
export const listCapabilityMachinesCommand = capabilityCommand(
  "list_capability_machines",
  "workspace",
  [],
  CapabilityMachineListSchema,
);
export const listCapabilityDriftCommand = capabilityCommand(
  "list_capability_drift",
  "workspace",
  ["nodeId"],
  CapabilityDriftListSchema,
);
export const listCapabilityActivityCommand = capabilityCommand(
  "list_capability_activity",
  "workspace",
  ["limit", "packageId"],
  CapabilityActivityListSchema,
);
export const listCapabilityOperationsCommand = capabilityCommand(
  "list_capability_operations",
  "workspace",
  ["limit", "active"],
  CapabilityOperationListSchema,
);
export const getCapabilityOperationCommand = capabilityCommand(
  "get_capability_operation",
  "workspace",
  ["operationId"],
  CapabilityOperationSchema,
);
export const listCapabilityUpdatesCommand = capabilityCommand(
  "list_capability_updates",
  "workspace",
  [],
  CapabilityUpdateListSchema,
);

// Adding, previewing and applying.
export const inspectCapabilitySourceCommand = capabilityCommand(
  "inspect_capability_source",
  "admin",
  ["source", "localItem", "requestKey"],
  CapabilitySourceInspectionSchema,
);
export const authorCapabilityPackageCommand = capabilityCommand(
  "author_capability_package",
  "admin",
  ["managedId", "kind", "name", "description", "content", "files", "hook", "mcp"],
  CapabilitySourceInspectionSchema,
);
export const previewCapabilityChangeCommand = capabilityCommand(
  "preview_capability_change",
  "admin",
  ["change", "requestKey"],
  CapabilityChangeResultSchema,
);
export const applyCapabilityChangeCommand = capabilityCommand(
  "apply_capability_change",
  "admin",
  ["operationId", "approvedDigest", "requestKey"],
  CapabilityChangeResultSchema,
);
export const cancelCapabilityOperationCommand = capabilityCommand(
  "cancel_capability_operation",
  "admin",
  ["operationId"],
  CapabilityOperationSchema,
);

// Setups, exceptions and machines.
export const setCapabilitySetupCommand = capabilityCommand(
  "set_capability_setup",
  "admin",
  ["setup", "expectedRevision"],
  CapabilitySetupSchema,
);
export const deleteCapabilitySetupCommand = capabilityCommand(
  "delete_capability_setup",
  "admin",
  ["setupId", "expectedRevision"],
  CapabilitySetupListSchema,
);
export const assignCapabilitySetupCommand = capabilityCommand(
  "assign_capability_setup",
  "workspace",
  ["scope", "scopeId", "setupIds", "expectedRevision"],
  OpenObject,
);
export const manageCapabilityExceptionCommand = capabilityCommand(
  "manage_capability_exception",
  "admin",
  ["setupId", "expectedRevision", "exception", "action"],
  CapabilitySetupSchema,
);
export const setCapabilityMachineEnrollmentCommand = capabilityCommand(
  "set_capability_machine_enrollment",
  "admin",
  ["nodeId", "enrolled", "groups"],
  CapabilityMachineSummarySchema,
);
export const setCapabilityPackageStateCommand = capabilityCommand(
  "set_capability_package_state",
  "admin",
  ["packageId", "pinned", "paused"],
  CapabilityPackageSummarySchema,
);
export const adoptExternalCapabilityCommand = capabilityCommand(
  "adopt_external_capability",
  "admin",
  ["nodeId", "itemId", "requestKey"],
  CapabilitySourceInspectionSchema,
);
export const resolveCapabilityDriftCommand = capabilityCommand(
  "resolve_capability_drift",
  "admin",
  ["driftId", "decision"],
  CapabilityDriftEntrySchema,
);

// Updates and rollback.
export const refreshCapabilityUpdatesCommand = capabilityCommand(
  "refresh_capability_updates",
  "admin",
  ["packageId"],
  CapabilityUpdateListSchema,
);
export const previewCapabilityUpdateCommand = capabilityCommand(
  "preview_capability_update",
  "admin",
  ["updateId"],
  CapabilityChangeResultSchema,
);
export const approveCapabilityUpdateCommand = capabilityCommand(
  "approve_capability_update",
  "admin",
  ["updateId", "approvedDigest", "dismiss"],
  CapabilityChangeResultSchema,
);
export const setCapabilityUpdatePolicyCommand = capabilityCommand(
  "set_capability_update_policy",
  "admin",
  ["setupId", "policy", "trustedSources", "expectedRevision"],
  CapabilitySetupSchema,
);
export const rollbackCapabilityPackageCommand = capabilityCommand(
  "rollback_capability_package",
  "admin",
  ["packageId", "toRevision", "requestKey"],
  CapabilityChangeResultSchema,
);

// Import, export and verification.
export const exportCapabilitySetupCommand = capabilityCommand(
  "export_capability_setup",
  "admin",
  ["setupIds", "projectId", "write"],
  CapabilityExportSchema,
);
export const previewCapabilityImportCommand = capabilityCommand(
  "preview_capability_import",
  "admin",
  ["intent", "lock", "projectId"],
  CapabilityImportPreviewSchema,
);
export const importCapabilitySetupCommand = capabilityCommand(
  "import_capability_setup",
  "admin",
  ["previewId"],
  CapabilitySetupListSchema,
);
export const verifyAgentCapabilityCommand = capabilityCommand(
  "verify_agent_capability",
  "workspace",
  ["target", "componentIds", "consent"],
  CapabilityVerificationSchema,
);

// The per-machine executor, called by the command node over its node link.
export const getCapabilityNodeObservationCommand = capabilityCommand(
  "get_capability_node_observation",
  "internal",
  ["controllerId", "epoch"],
  CapabilityInventorySchema,
);
export const stageCapabilityNodeArtifactCommand = capabilityCommand(
  "stage_capability_node_artifact",
  "internal",
  ["controllerId", "epoch", "digest", "index", "count", "data", "manifest"],
  OpenObject,
);
export const applyCapabilityNodePlanCommand = capabilityCommand(
  "apply_capability_node_plan",
  "internal",
  ["controllerId", "epoch", "operationId", "targets"],
  OpenObject,
);

/** One installed item's files, for adopting an installation that exists only on that machine. */
export const exportCapabilityNodeItemCommand = capabilityCommand(
  "export_capability_node_item",
  "internal",
  ["controllerId", "epoch", "itemId"],
  OpenObject,
);

export const CAPABILITIES_COMMANDS = [
  listCapabilityPackagesCommand,
  getCapabilityPackageCommand,
  readCapabilityFileCommand,
  listCapabilitySetupsCommand,
  getCapabilityInventoryCommand,
  getCapabilityTargetSupportCommand,
  getEffectiveAgentResourcesCommand,
  getCapabilitySessionViewCommand,
  listCapabilityMachinesCommand,
  listCapabilityDriftCommand,
  listCapabilityActivityCommand,
  listCapabilityOperationsCommand,
  getCapabilityOperationCommand,
  listCapabilityUpdatesCommand,
  inspectCapabilitySourceCommand,
  authorCapabilityPackageCommand,
  previewCapabilityChangeCommand,
  applyCapabilityChangeCommand,
  cancelCapabilityOperationCommand,
  setCapabilitySetupCommand,
  deleteCapabilitySetupCommand,
  assignCapabilitySetupCommand,
  manageCapabilityExceptionCommand,
  setCapabilityMachineEnrollmentCommand,
  setCapabilityPackageStateCommand,
  adoptExternalCapabilityCommand,
  resolveCapabilityDriftCommand,
  refreshCapabilityUpdatesCommand,
  previewCapabilityUpdateCommand,
  approveCapabilityUpdateCommand,
  setCapabilityUpdatePolicyCommand,
  rollbackCapabilityPackageCommand,
  exportCapabilitySetupCommand,
  previewCapabilityImportCommand,
  importCapabilitySetupCommand,
  verifyAgentCapabilityCommand,
  getCapabilityNodeObservationCommand,
  stageCapabilityNodeArtifactCommand,
  applyCapabilityNodePlanCommand,
  exportCapabilityNodeItemCommand,
] as const;
