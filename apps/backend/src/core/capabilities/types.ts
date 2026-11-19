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
  PackageSource,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";

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

/** An inspected source not yet added: short-lived, bounded. */
export interface SourceInspectionRecord {
  id: string;
  requestKey?: string;
  secretsFound?: string[];
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
  projectId?: string;
  createdAt: string;
}

export interface CapabilitySettings {
  /** Package id prefixes whose updates may apply without approval when nothing escalates. */
  trustedSources: string[];
  /** System/organisation restrictions. */
  forbiddenSources: string[];
  forbiddenComponents: string[];
  /** Newly enrolled machines follow My setup. */
  enrollNewMachines: boolean;
  lastUpdateCheckAt?: string;
}

/** The frozen effective manifest a session was launched with. */
export interface CapabilityLaunchRecord {
  sessionKey: string;
  target: CapabilityTarget;
  manifestDigest: string;
  permissionPolicyDigest: string;
  packages: Array<{ id: string; artifactDigest: string }>;
  launchedAt: string;
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
