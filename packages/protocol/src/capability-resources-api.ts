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

export interface CapabilityExport {
  intentFile: string;
  intent: string;
  lockFile: string;
  lock: string;
  /** Written into the project checkout as well (project exports only). */
  written?: boolean;
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

export type { CapabilityPackageDetail };
