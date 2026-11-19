/**
 * The bounded, redacted results the `capabilities` commands return
 * (`contract/domains/capabilities`). Every list is capped; every location is
 * an opaque id or a home-relative display label, never an absolute host
 * path, and no result carries a credential value.
 *
 * Browser-safe.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import type {
  CapabilityActivityEntry,
  CapabilityComponent,
  CapabilityDriftEntry,
  CapabilityMachineSummary,
  CapabilityOperationSnapshot,
  CapabilityPackageDetail,
  CapabilityPackageSummary,
  CapabilityRisk,
  CapabilitySetup,
  CapabilityTargetStatus,
  CapabilityUpdateProposal,
  ComponentKind,
  EffectiveAgentResources,
  PackageSource,
} from "./capability-resources.js";
import type { CapabilityManifestIssue } from "./capability-resources-manifest.js";
import type { CapabilitySupportMatrix } from "./capability-resources-support.js";

export interface CapabilityLibrary {
  revision: number;
  packages: CapabilityPackageSummary[];
  truncated: number;
  /** The single-writer epoch of this command node's authority. */
  epoch: number;
}

export interface CapabilitySetupList {
  revision: number;
  setups: CapabilitySetup[];
}

/** One thing found on a machine: managed by Orkestrator, or external. */
export interface CapabilityObservedItem {
  /** Opaque: `<locationId>/<name>` or `<provider>:plugin:<qualifiedId>`. */
  id: string;
  provider: AgentPlatform;
  kind: ComponentKind;
  name: string;
  description?: string;
  /** Opaque location id, or `plugin`/`mcp` for provider-owned stores. */
  locationId: string;
  /** Home-relative display label. */
  locationLabel: string;
  ownership: "managed" | "external" | "administrator" | "system" | "plugin";
  packageId?: string;
  componentId?: string;
  /** Digest of the installed bytes, when Orkestrator could read them. */
  digest?: string;
  expectedDigest?: string;
  drifted?: boolean;
  shadowed?: boolean;
  enabled?: boolean | null;
  /** Fully qualified plugin id (`name@marketplace`). */
  qualifiedId?: string;
  /** The providers that see this location. */
  visibleTo: AgentPlatform[];
}

export interface CapabilityInventory {
  nodeId: string;
  nodeName?: string;
  observedAt: string;
  os: string;
  providers: Array<{ provider: AgentPlatform; available: boolean; version?: string }>;
  items: CapabilityObservedItem[];
  truncated: number;
  errors: Array<{ provider?: AgentPlatform; message: string }>;
  /**
   * Providers with work in flight on the machine when it was observed. The
   * reconciler holds writes to shared locations they read until the work
   * ends. Absent from a machine that predates the field: nothing is held.
   */
  busyProviders?: AgentPlatform[];
}

export interface CapabilityTargetSupportResult {
  nodeId: string;
  matrices: CapabilitySupportMatrix[];
}

export interface CapabilitySourceInspection {
  inspectionId: string;
  expiresAt: string;
  source: PackageSource;
  packageId: string;
  displayName: string;
  description?: string;
  revision: string;
  artifactDigest: string;
  risk: CapabilityRisk;
  publisher?: string;
  components: CapabilityComponent[];
  files: Array<{ path: string; bytes: number; executable: boolean }>;
  totalBytes: number;
  compatibleProviders: AgentPlatform[];
  unsupported: Array<{ provider: AgentPlatform; componentId: string; reason: string }>;
  approvalReasons: string[];
  warnings: string[];
  /** Kinds of secret detected in the content (never the value); a non-empty list blocks adding it. */
  secretsFound: string[];
  /** Already in the library: the same identity. */
  existing?: { revision: string; artifactDigest: string };
}

export interface CapabilityChangeResult {
  operation: CapabilityOperationSnapshot;
  /** True when the request key had already been processed. */
  replayed: boolean;
}

export interface CapabilityOperationList {
  operations: CapabilityOperationSnapshot[];
  truncated: number;
}

export interface CapabilityUpdateList {
  updates: CapabilityUpdateProposal[];
  lastCheckedAt?: string;
}

export interface CapabilityActivityList {
  entries: CapabilityActivityEntry[];
  truncated: number;
}

export interface CapabilityMachineList {
  machines: CapabilityMachineSummary[];
  groups: string[];
}

export interface CapabilityDriftList {
  drift: CapabilityDriftEntry[];
}

/** How adopted local changes are published (`adopt-drift`). */
export type CapabilityDriftAdoptionMode =
  /** The package's next revision; a Git or registry package then diverges from its source. */
  | "revision"
  /** A new package of its own (a local variant) that replaces the original in its setups. */
  | "variant";

/** One file of a three-way merge of local changes (`merge_capability_drift`). */
export interface CapabilityDriftMergeFile {
  /** The path inside the package. */
  path: string;
  componentId: string;
  outcome: "unchanged" | "local" | "configured" | "merged" | "deleted" | "conflict";
  /** Present for `conflict`. */
  conflict?: {
    kind: "text" | "binary" | "deleted-locally" | "deleted-in-revision" | "too-large";
    /** Text of each side (absent when that side has no file, or for binary files). */
    base?: string;
    local?: string;
    configured?: string;
    /** `text`: the merge with `<<<<<<<`/`|||||||`/`=======`/`>>>>>>>` markers, to edit. */
    merged?: string;
    /** `text`: the conflicting regions, with their first line in the marked-up text. */
    hunks?: Array<{ line: number; base: string; local: string; configured: string }>;
  };
}

/** A user's resolution of one conflicted file. */
export interface CapabilityDriftMergeResolution {
  path: string;
  /** The resolved text; absent with `delete`. */
  content?: string;
  delete?: boolean;
}

/**
 * A three-way merge of one package's local changes on one machine: base is
 * the revision the copy was installed from, local is the machine's files,
 * configured is the package's current revision. A clean merge (or one whose
 * conflicts were all resolved) comes back with `operation`, the previewed new
 * revision to approve; otherwise `conflicts` lists what needs resolving.
 */
export interface CapabilityDriftMerge {
  driftId: string;
  nodeId: string;
  packageId: string;
  displayName: string;
  baseRevision: string;
  configuredRevision: string;
  /** Digest of the three sides; resolutions must name it, so a moved side is refused. */
  basis: string;
  files: CapabilityDriftMergeFile[];
  conflicts: number;
  /** Binary files both sides changed: they cannot be merged; keep, adopt or replace instead. */
  unmergeable: string[];
  operation?: CapabilityOperationSnapshot;
}

export interface CapabilityExport {
  intentFile: string;
  intent: string;
  lockFile: string;
  lock: string;
  /** Written into the project checkout as well (project exports only). */
  written?: boolean;
  /** The lockfile format written: 1 when it suffices, 2 for mixed revisions or a signature. */
  formatVersion?: 1 | 2;
  /** The lockfile is signed with this installation's sharing key. */
  signed?: { keyId: string; fingerprint: string };
}

/**
 * A lockfile signature as an import preview reports it. `invalid` blocks the
 * import; `unsigned` and `untrusted` block it when the policy requires signed
 * manifests.
 */
export interface CapabilityManifestSignatureCheck {
  status: "unsigned" | "trusted" | "untrusted" | "invalid";
  keyId?: string;
  /** The signer's raw Ed25519 public key (base64url), so the preview can offer to trust it. */
  publicKey?: string;
  fingerprint?: string;
  /** The trusted key's label, or "This installation". */
  label?: string;
  own?: boolean;
  reason?: string;
}

/** A registry's packages, for the Add dialog (bounded). */
export interface CapabilityRegistryPackageList {
  registryId: string;
  packages: Array<{
    qualifiedId: string;
    displayName?: string;
    description?: string;
    latest: string;
    versions: string[];
  }>;
  truncated: number;
}

export interface CapabilityImportPreview {
  previewId: string;
  issues: CapabilityManifestIssue[];
  setups: Array<{ name: string; action: "create" | "update" | "unchanged"; packages: number }>;
  packages: Array<{
    packageId: string;
    action: "add" | "update" | "unchanged" | "conflict";
    revision: string;
    artifactDigest: string;
    reason?: string;
  }>;
  approvalReasons: string[];
  /** The lockfile's signature; absent when the files could not be read. */
  signature?: CapabilityManifestSignatureCheck;
  /** Imports require a trusted signature on this installation. */
  requireSignedManifests?: boolean;
  valid: boolean;
}

export interface CapabilityVerification {
  target: EffectiveAgentResources["target"];
  checks: Array<{
    componentId: string;
    level: string;
    status: string;
    detail: string;
  }>;
  verifiedAt: string;
}

export interface CapabilitySessionView {
  sessionKey: string;
  setupIds: string[];
  label: string;
  effective: EffectiveAgentResources | null;
  readiness: "ready" | "next-session" | "needs-attention" | "blocked" | "unresolved";
  /** The manifest the running session was launched with; differs when a change waits for a new session. */
  launchManifestDigest?: string;
  components: Array<{
    componentId: string;
    name: string;
    kind: ComponentKind;
    status: string;
    liveSemantics?: string;
    reason?: string;
  }>;
}

/**
 * One environment's own copies (`get_capability_environment_delivery`): the
 * project setup written into a local worktree, or the manifest staged into a
 * container's inputs, with what the current setup would put there.
 */
export interface CapabilityEnvironmentDelivery {
  environmentId: string;
  kind: "worktree" | "container" | "none";
  /** Container: the manifest digest staged into the running container, absent when none was. */
  installedDigest?: string;
  /** Container: the digest the current setup stages on the next rebuild. */
  currentDigest?: string;
  /** Container: the installed manifest differs from the current one; a rebuild re-stages it. */
  stale: boolean;
  stagedAt?: string;
  /**
   * Container: why nothing was staged into it ("Capabilities not staged:
   * command node unreachable" when its machine, a leaf, could not reach the
   * command node at creation and had no cached manifest for it).
   */
  notStagedReason?: string;
  /** Container: staged from the command node's last answer for it, received at this time. */
  stagedFromCacheAt?: string;
  /** The machine the environment is on, when it is not the one that answered. */
  nodeId?: string;
  /** Why what is shown may not be current (the command node could not be asked). */
  notice?: string;
  items: CapabilityEnvironmentDeliveryItem[];
}

export interface CapabilityEnvironmentDeliveryItem {
  componentId: string;
  name: string;
  kind: ComponentKind;
  packageId: string;
  providers: AgentPlatform[];
  /** A location id: a project directory in the worktree, or a user location in the container. */
  locationId?: string;
  /** Display only: worktree-relative (`.claude/skills`) or home-relative. */
  locationLabel?: string;
  status: CapabilityTargetStatus;
  installedDigest?: string;
  currentDigest?: string;
  alsoVisibleTo?: AgentPlatform[];
  reason?: string;
}

export type { CapabilityPackageDetail };
