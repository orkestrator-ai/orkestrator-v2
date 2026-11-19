/**
 * The command node's persisted Agent Capabilities state
 * (docs/architecture/agent-capabilities-management.md, "Storage"). One
 * `capabilities` envelope store in the existing SQLite database: a small
 * document (revision, single-writer epoch, settings) plus one row per
 * record in each collection below. Large immutable bytes are not here: they
 * live in the content-addressed artifact cache (`artifact-store.ts`), and
 * this state holds only their digests and reference counts.
 *
 * Nothing here holds a credential value. MCP definitions keep environment
 * and header *keys*; each machine supplies its own values.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityActivityEntry,
  CapabilityComponent,
  CapabilityDriftEntry,
  CapabilityOperationSnapshot,
  CapabilityPackage,
  CapabilitySetup,
  CapabilityTarget,
  CapabilityTargetStatus,
  CapabilityUpdateProposal,
  CapabilityVerificationLevel,
  EffectiveAgentResources,
  PackageSource,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";
import type { CapabilityRegistry } from "@orkestrator/protocol/capability-registry";

export const CAPABILITY_STATE_FORMAT_VERSION = 1;

/** One installation written on one machine for one location. */
export interface InstallationReceipt {
  /** `<nodeId>|<locationId>|<componentId>`: one physical copy. */
  id: string;
  nodeId: string;
  locationId: string;
  componentId: string;
  packageId: string;
  /** The digest of the bytes written (the installed subtree or file). */
  digest: string;
  /** The package artifact digest the bytes came from. */
  packageDigest: string;
  /** Who keeps this installation referenced: `setup:<id>`, `account:<id>`, `project:<id>`. */
  references: string[];
  /** Providers the copy serves (requested ones) and that also see it. */
  providers: AgentPlatform[];
  alsoVisibleTo: AgentPlatform[];
  status: CapabilityTargetStatus;
  verification: CapabilityVerificationLevel | "unverified";
  reason?: string;
  operationId: string;
  appliedAt: string;
  verifiedAt?: string;
  /** Present when the node answered in a way that does not prove the write happened. */
  outcomeUnknown?: boolean;
  pendingWrite?: { action: "install" | "update" | "remove"; packageDigest?: string };
  /**
   * A scoped copy (`scoped-delivery.ts`): written into one local worktree's
   * project directories, or into an added account's private directory. The
   * machine-wide reconciler never plans, observes or removes these.
   */
  environmentId?: string;
  accountHomeId?: string;
}

/** True for a receipt the machine-wide reconcile pass owns (not a worktree or account copy). */
export function isMachineWideReceipt(receipt: InstallationReceipt): boolean {
  return receipt.environmentId === undefined && receipt.accountHomeId === undefined;
}

/** Runtime evidence for a component in a provider session generation. */
export interface RuntimeObservation {
  id: string;
  target: CapabilityTarget;
  componentId: string;
  level: CapabilityVerificationLevel;
  source: "bridge-inventory" | "session-use" | "verify-check" | "provider-config";
  generation?: string;
  observedAt: string;
}

export interface CapabilityMachineRecord {
  nodeId: string;
  enrolled: boolean;
  groups: string[];
  lastSeenAt?: string;
  lastObservedAt?: string;
  /** Digest of the manifest the machine last confirmed applied. */
  appliedManifestDigest?: string;
  /** Bounded inventory from the last observation. */
  inventory?: CapabilityInventory;
  /** Reconciliation cursor: the setup revision the machine last fully applied. */
  syncedRevision?: number;
}

/** A package's file listing, kept with its artifact for previews and verification. */
export interface PackageArtifactRecord {
  digest: string;
  bytes: number;
  files: Array<{ path: string; bytes: number; executable: boolean; sha256: string }>;
  /** `package:<id>@<revision>`, `operation:<id>`, `receipt:<id>`. */
  refs: string[];
  createdAt: string;
}

/**
 * What an inspection publishes from a machine's local changes (`drift.ts`):
 * the drift entries it settles and the observed bytes it was made from,
 * re-checked on the machine before the change is applied.
 */
export interface DriftAdoption {
  /** The entry the user acted on. */
  driftId: string;
  /** Its observed digest (absent for a deleted item). */
  digest: string;
  nodeId?: string;
  /** Every local change the revision includes (all of the package's components). */
  driftIds?: string[];
  items?: Array<{ locationId: string; componentId: string; digest?: string }>;
  mode?: "revision" | "variant";
  /** Merged with the configured revision instead of taken as observed. */
  merged?: boolean;
  /** The package the local changes were made to. */
  fromPackageId?: string;
}

/** An inspected source not yet added: short-lived, bounded. */
export interface SourceInspectionRecord {
  id: string;
  requestKey?: string;
  secretsFound?: string[];
  adoption?: DriftAdoption;
  source: PackageSource;
  packageId: string;
  displayName: string;
  description?: string;
  revision: string;
  artifactDigest: string;
  publisher?: string;
  components: CapabilityComponent[];
  createdAt: string;
  expiresAt: string;
}

/** A selection of setups for a narrower scope than My setup. */
export interface CapabilityAssignment {
  /** `<scope>:<scopeId>`. */
  id: string;
  scope: "project" | "environment" | "template" | "graph-node" | "session";
  scopeId: string;
  setupIds: string[];
  revision: number;
  updatedAt: string;
}

export interface CapabilityApprovalRecord {
  id: string;
  operationId: string;
  planDigest: string;
  approvedAt: string;
  approvedBy?: string;
}

export interface CapabilityRequestRecord {
  key: string;
  intentDigest: string;
  operationId?: string;
  inspectionId?: string;
  at: string;
}

export interface CapabilityImportRecord {
  verified?: true;
  id: string;
  digest: string;
  intent: unknown;
  lock: unknown;
  /** The lockfile signature's status at preview (`manifest-signing.ts`). */
  signatureStatus?: "unsigned" | "trusted" | "untrusted" | "invalid";
  projectId?: string;
  createdAt: string;
}

export interface CapabilitySettings {
  /** Package id prefixes whose updates may apply without approval when nothing escalates. */
  trustedSources: string[];
  /**
   * System/organisation restrictions (`admin-policy.ts`): package id prefixes,
   * and exact package or component ids or `kind:<kind>`.
   */
  forbiddenSources: string[];
  forbiddenComponents: string[];
  /** Bumped on every policy change; `set_capability_admin_policy` compares it. Absent is 0. */
  policyRevision?: number;
  policyUpdatedAt?: string;
  /** Newly enrolled machines follow My setup. */
  enrollNewMachines: boolean;
  lastUpdateCheckAt?: string;
  /** Trusted package registries (`registry.ts`); absent means none. */
  registries?: CapabilityRegistry[];
  /** Imports refuse unsigned manifests and manifests signed by an untrusted key. */
  requireSignedManifests?: boolean;
}

/** The frozen effective manifest a session was launched with. */
export interface CapabilityLaunchRecord {
  sessionKey: string;
  target: CapabilityTarget;
  manifestDigest: string;
  permissionPolicyDigest: string;
  packages: Array<{ id: string; artifactDigest: string }>;
  /**
   * The installed bytes observed on the host at launch for each required
   * component (`launch-authority.ts`): exactly what the provider can load.
   */
  deliveries?: CapabilityLaunchDelivery[];
  /** The command node that resolved a leaf's launch; absent when resolved locally. */
  resolvedBy?: string;
  launchedAt: string;
}

export interface CapabilityLaunchDelivery {
  packageId: string;
  componentId: string;
  locationId: string;
  digest: string;
}

/**
 * The capability side of a command-node handover (`handover.ts`). On the
 * node handing over: `sending` while the state travels, `sent` once the new
 * command node accepted; either stops this node acting as the authority. On
 * the node taking over: `received`, so a retried install is a no-op.
 */
export interface CapabilityHandoverMarker {
  id: string;
  role: "sending" | "sent" | "received";
  peerId: string;
  /** The epoch the authority moved to (`sent`, `received`) or from (`sending`). */
  epoch: number;
  at: string;
}

/** A leaf's last authoritative launch answers (`launch-authority.ts`), bounded. */
export interface LeafLaunchAuthorityCache {
  answers: Record<string, LeafLaunchAnswerRecord>;
  /** The command node said required capabilities apply on this machine. */
  requiredOnNode?: { value: boolean; at: string; controllerId: string };
}

export interface LeafLaunchAnswerRecord {
  key: string;
  controllerId: string;
  epoch: number;
  receivedAt: string;
  /** Digest of this machine's applied executor keys when the answer arrived. */
  appliedDigest: string;
  effective: EffectiveAgentResources;
  deliveries: CapabilityLaunchDelivery[];
  required: string[];
}

export interface CapabilityState {
  formatVersion: number;
  /** Bumped on every committed change; clients detect missed events by it. */
  revision: number;
  /**
   * The single-writer epoch. A command-node handover raises it; a machine
   * refuses an executor call carrying an older epoch than the one it saw.
   */
  epoch: number;
  controllerId?: string;
  settings: CapabilitySettings;
  packages: Record<string, CapabilityPackage>;
  components: Record<string, CapabilityComponent>;
  setups: Record<string, CapabilitySetup>;
  assignments: Record<string, CapabilityAssignment>;
  operations: Record<string, CapabilityOperationSnapshot>;
  receipts: Record<string, InstallationReceipt>;
  observations: Record<string, RuntimeObservation>;
  updates: Record<string, CapabilityUpdateProposal>;
  drift: Record<string, CapabilityDriftEntry>;
  activity: Record<string, CapabilityActivityEntry>;
  artifacts: Record<string, PackageArtifactRecord>;
  machines: Record<string, CapabilityMachineRecord>;
  inspections: Record<string, SourceInspectionRecord>;
  approvals: Record<string, CapabilityApprovalRecord>;
  requests: Record<string, CapabilityRequestRecord>;
  imports: Record<string, CapabilityImportRecord>;
  launches: Record<string, CapabilityLaunchRecord>;
  /** Command-node handover of this state (`handover.ts`). */
  handover?: CapabilityHandoverMarker;
  /** Leaf only: cached launch answers from the command node. */
  leafAuthority?: LeafLaunchAuthorityCache;
}

export const CAPABILITY_COLLECTIONS = [
  "packages",
  "components",
  "setups",
  "assignments",
  "operations",
  "receipts",
  "observations",
  "updates",
  "drift",
  "activity",
  "artifacts",
  "machines",
  "inspections",
  "approvals",
  "requests",
  "imports",
  "launches",
] as const satisfies ReadonlyArray<keyof CapabilityState>;

/**
 * What a machine records about the command node it takes capability plans
 * from: the highest epoch it has seen, so a stale controller is refused.
 */
export interface CapabilityMcpOwnership {
  sourceId: string;
  fingerprint: string;
  provider: AgentPlatform;
  name: string;
  /** A worktree's project MCP file Orkestrator created (`project-mcp.ts`): excluded from Git, deleted when empty. */
  createdFile?: boolean;
}

export interface CapabilityExecutorState {
  controllerId?: string;
  epoch: number;
  /** Idempotency: plan keys already applied, with their receipts' digests. */
  applied: Record<
    string,
    {
      digest: string;
      at: string;
      action: string;
      mcp?: CapabilityMcpOwnership;
      packageId?: string;
      componentId?: string;
    }
  >;
}
