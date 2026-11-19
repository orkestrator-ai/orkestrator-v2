/**
 * Agent Capabilities: the provider-neutral vocabulary of the packages a user
 * adds once and uses wherever an agent supports them
 * (docs/architecture/agent-capabilities-management.md).
 *
 * A *capability package* is something installable: an Agent Skill, a native
 * plugin, an MCP server definition, a command, prompt or hook, or a bundle of
 * several of those. It is **not** a permission. Operation-level permissions
 * (`file.write`, `network`, `mcp:<server>`) are `NativeAgentCapability` in
 * `native-agent-capabilities.ts`; a capability package can only ask for
 * resources, and the resolver (`capability-resources-resolve.ts`) narrows the
 * request with that permission policy, never the other way round.
 *
 * The vocabulary keeps four things apart that are easy to blur:
 *
 * - in the library (a package record exists),
 * - assigned (a setup selects it for a target),
 * - present on disk (a receipt says the files were written),
 * - available to a running agent (runtime evidence says it loaded).
 *
 * Every status and verification level below names exactly one of those, so
 * the UI never shows "Ready" on the strength of a file copy.
 *
 * Browser-safe: no Node or Bun imports.
 */
import type { AgentPlatform } from "./agent-platforms.js";
import { AGENT_PLATFORMS, isAgentPlatform } from "./agent-platforms.js";

// --- Families and components ---------------------------------------------

/** The four resource families the manager covers. */
export const CAPABILITY_FAMILIES = ["skill", "native-plugin", "mcp-server", "command"] as const;
export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];

/** One part of a package. A plugin is a package with several of these. */
export const COMPONENT_KINDS = [
  "skill",
  "native-plugin",
  "mcp-server",
  "command",
  "prompt",
  "hook",
  "subagent",
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** Which family a component kind is managed under. */
export const COMPONENT_FAMILY: Readonly<Record<ComponentKind, CapabilityFamily>> = Object.freeze({
  skill: "skill",
  "native-plugin": "native-plugin",
  subagent: "native-plugin",
  "mcp-server": "mcp-server",
  command: "command",
  prompt: "command",
  hook: "command",
});

export const COMPONENT_KIND_LABELS: Readonly<Record<ComponentKind, string>> = Object.freeze({
  skill: "Skill",
  "native-plugin": "Plugin",
  "mcp-server": "MCP server",
  command: "Command",
  prompt: "Prompt",
  hook: "Hook",
  subagent: "Subagent",
});

export function isComponentKind(value: unknown): value is ComponentKind {
  return typeof value === "string" && (COMPONENT_KINDS as readonly string[]).includes(value);
}

/**
 * How much a package can do, highest wins. `instructions` is text an agent
 * reads; `network` contacts a service (an HTTP MCP server); `executable` runs
 * a program (scripts, a stdio MCP server, a hook); `privileged` runs one
 * without the agent asking (a hook fires on its own trigger).
 */
export const CAPABILITY_RISKS = ["instructions", "network", "executable", "privileged"] as const;
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];

export function capabilityRiskRank(risk: CapabilityRisk): number {
  return CAPABILITY_RISKS.indexOf(risk);
}

export function maxCapabilityRisk(risks: Iterable<CapabilityRisk>): CapabilityRisk {
  let best: CapabilityRisk = "instructions";
  for (const risk of risks) if (capabilityRiskRank(risk) > capabilityRiskRank(best)) best = risk;
  return best;
}

export const CAPABILITY_PROVENANCES = ["managed", "external", "project", "administrator"] as const;
export type CapabilityProvenance = (typeof CAPABILITY_PROVENANCES)[number];

// --- Sources and identity -------------------------------------------------

export type PackageSource =
  | { kind: "git"; repo: string; subpath: string; channel?: string }
  | { kind: "provider-marketplace"; provider: AgentPlatform; qualifiedId: string }
  | { kind: "registry"; registryId: string; qualifiedId: string }
  | { kind: "local"; sourceMachineId: string; sourceId: string }
  | { kind: "managed"; managedId: string };

export type PackageSourceKind = PackageSource["kind"];

export const PACKAGE_SOURCE_KINDS: readonly PackageSourceKind[] = Object.freeze([
  "git",
  "provider-marketplace",
  "registry",
  "local",
  "managed",
]);

/** Bounds every reader and writer of the capability records shares. */
export const CAPABILITY_LIMITS = Object.freeze({
  maxPackages: 2_000,
  maxComponentsPerPackage: 200,
  maxSetups: 100,
  maxSelectionsPerSetup: 500,
  maxSelectorsPerSetup: 64,
  maxExclusionsPerSetup: 500,
  maxParentSetups: 16,
  maxSetupDepth: 8,
  maxOperations: 500,
  maxTargetsPerOperation: 2_000,
  maxActivity: 1_000,
  maxUpdates: 500,
  maxDrift: 1_000,
  maxReceipts: 20_000,
  maxObservations: 5_000,
  /** One package's file tree. */
  maxPackageFiles: 2_000,
  maxPackageBytes: 32 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxPathChars: 512,
  maxPathDepth: 24,
  /** One chunk of an artifact sent to another machine. */
  artifactChunkBytes: 1024 * 1024,
  maxIdChars: 512,
  maxNameChars: 200,
  maxDescriptionChars: 2_000,
  maxReasonChars: 600,
  maxPreviewChars: 64 * 1024,
});

const SAFE_SEGMENT = /^[A-Za-z0-9@][A-Za-z0-9@._+-]*$/;

/** A path segment safe to join under a root: no separators, no `..`, no hidden escape. */
export function isSafeCapabilitySegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "." &&
    value !== ".." &&
    SAFE_SEGMENT.test(value)
  );
}

/**
 * A relative path inside a package: forward slashes, no empty, `.` or `..`
 * segment, not absolute, no backslash or NUL, bounded.
 */
export function isSafeCapabilityRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > CAPABILITY_LIMITS.maxPathChars) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  if (segments.length > CAPABILITY_LIMITS.maxPathDepth) return false;
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * The canonical form of a Git repository address, so `git@github.com:Org/Repo.git`,
 * `https://github.com/org/repo` and `https://github.com/org/repo/` name one
 * repository. Hosts are case-insensitive; the path keeps its case except on
 * the hosts that ignore it (GitHub, GitLab, Bitbucket).
 */
export function canonicalGitRepo(repo: string): string {
  let value = repo.trim();
  const scp = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(value);
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    value = `ssh://${scp[2]}/${scp[3]}`;
  }
  let host = "";
  let pathPart = value;
  const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?(\/.*)?$/.exec(value);
  if (url) {
    host = url[1]!.toLowerCase();
    pathPart = url[2] ?? "";
  }
  pathPart = pathPart
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  if (/^(github\.com|gitlab\.com|bitbucket\.org)$/.test(host)) pathPart = pathPart.toLowerCase();
  return host ? `${host}/${pathPart}` : pathPart;
}

function canonicalSubpath(subpath: string): string {
  return subpath
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

/**
 * A package's identity: its source and subpath, never its display name. Two
 * marketplaces that both publish `review` are two packages; one package used
 * by five providers is one identity. Mutable tags (`channel`) are update
 * channels, not identities, so they are not part of it.
 */
export function capabilityPackageId(source: PackageSource): string {
  switch (source.kind) {
    case "git": {
      const sub = canonicalSubpath(source.subpath);
      return `git:${canonicalGitRepo(source.repo)}${sub ? `//${sub}` : ""}`;
    }
    case "provider-marketplace":
      return `marketplace:${source.provider}:${source.qualifiedId.trim()}`;
    case "registry":
      return `registry:${source.registryId.trim()}:${source.qualifiedId.trim()}`;
    case "local":
      return `local:${source.sourceMachineId.trim()}:${source.sourceId.trim()}`;
    case "managed":
      return `managed:${source.managedId.trim()}`;
  }
}

/** A component's identity: its package plus its kind and key inside the package. */
export function capabilityComponentId(packageId: string, kind: ComponentKind, key: string): string {
  return `${packageId}#${kind}:${key}`;
}

/** Splits a component id back into its package id and `kind:key`, or `null`. */
export function parseCapabilityComponentId(
  componentId: string,
): { packageId: string; kind: ComponentKind; key: string } | null {
  const hash = componentId.lastIndexOf("#");
  if (hash <= 0) return null;
  const rest = componentId.slice(hash + 1);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  const kind = rest.slice(0, colon);
  if (!isComponentKind(kind)) return null;
  return { packageId: componentId.slice(0, hash), kind, key: rest.slice(colon + 1) };
}

export function isPackageSource(value: unknown): value is PackageSource {
  if (!isPlainRecord(value)) return false;
  const text = (key: string) =>
    typeof value[key] === "string" &&
    (value[key] as string).trim().length > 0 &&
    (value[key] as string).length <= CAPABILITY_LIMITS.maxIdChars;
  switch (value.kind) {
    case "git":
      return (
        text("repo") &&
        typeof value.subpath === "string" &&
        (value.subpath === "" || isSafeCapabilityRelativePath(canonicalSubpath(value.subpath))) &&
        (value.channel === undefined || text("channel"))
      );
    case "provider-marketplace":
      return isAgentPlatform(value.provider) && text("qualifiedId");
    case "registry":
      return text("registryId") && text("qualifiedId");
    case "local":
      return text("sourceMachineId") && text("sourceId");
    case "managed":
      return text("managedId");
    default:
      return false;
  }
}

/** A short human description of a source, for rows and previews. Never a host path. */
export function describePackageSource(source: PackageSource): string {
  switch (source.kind) {
    case "git": {
      const sub = canonicalSubpath(source.subpath);
      return `${canonicalGitRepo(source.repo)}${sub ? ` / ${sub}` : ""}${source.channel ? ` @ ${source.channel}` : ""}`;
    }
    case "provider-marketplace":
      return `${source.provider} marketplace: ${source.qualifiedId}`;
    case "registry":
      return `${source.registryId}: ${source.qualifiedId}`;
    case "local":
      return "Local installation";
    case "managed":
      return "Authored in Orkestrator";
  }
}

// --- Packages, components and setups --------------------------------------

export interface CapabilityComponent {
  /** `packageId#kind:key`. */
  id: string;
  packageId: string;
  kind: ComponentKind;
  /** The component's path inside the package, or its key (an MCP server name). */
  pathOrKey: string;
  name: string;
  description?: string;
  /** Component ids inside the same package this one needs. */
  dependencies: string[];
  /** Providers the package says it was written for; empty means any. */
  providerHints: AgentPlatform[];
  requirements: { os?: string[]; binaries?: string[]; envRefs?: string[] };
  risk: CapabilityRisk;
  /** What the component runs, when it runs anything (hook command, MCP launcher). */
  executes?: string[];
  /** Hosts a networked component connects to. */
  endpoints?: string[];
  /** Hook triggers (`PreToolUse`, ...). */
  triggers?: string[];
}

export interface CapabilityPackage {
  /** Canonical source + subpath identity (`capabilityPackageId`). */
  id: string;
  source: PackageSource;
  displayName: string;
  description?: string;
  /** Immutable: a commit or package version plus the content digest. */
  revision: string;
  /** SHA-256 of the canonical file tree (`sha256:<hex>`). */
  artifactDigest: string;
  componentIds: string[];
  provenance: CapabilityProvenance;
  risk: CapabilityRisk;
  publisher?: string;
  /** Revisions kept for rollback, newest first. */
  previousRevisions?: Array<{ revision: string; artifactDigest: string; replacedAt: string }>;
  /** Pinned: updates are proposed but never applied, even under a trusted-source rule. */
  pinned?: boolean;
  /** Paused: kept in every setup but not delivered anywhere until resumed. */
  paused?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityPackageSelection {
  packageId: string;
  /** An exact revision, or `"latest"` to follow the package's current revision. */
  version: string;
  /** Component ids to use; absent means every component. */
  components?: string[];
  /** A required component missing at launch blocks the session; optional ones are skipped with a warning. */
  required?: boolean;
}

/**
 * A target selector, as text so setups stay portable: `*`, `provider:<p>`,
 * `machine:<nodeId>`, `group:<name>`, `project:<id>`, `environment:<id>`,
 * `template:<id>`, `graph-node:<graphId>/<nodeId>`, `session:<id>`.
 */
export type CapabilitySelector = string;

export const CAPABILITY_SELECTOR_KINDS = [
  "provider",
  "machine",
  "group",
  "project",
  "environment",
  "template",
  "graph-node",
  "session",
  "account",
] as const;
export type CapabilitySelectorKind = (typeof CAPABILITY_SELECTOR_KINDS)[number];

export function isCapabilitySelector(value: unknown): value is CapabilitySelector {
  if (typeof value !== "string" || value.length > 300) return false;
  if (value === "*") return true;
  const colon = value.indexOf(":");
  if (colon <= 0) return false;
  const kind = value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (!(CAPABILITY_SELECTOR_KINDS as readonly string[]).includes(kind) || rest.length === 0) {
    return false;
  }
  if (kind === "provider") return isAgentPlatform(rest);
  return /^[A-Za-z0-9_.:/@-]+$/.test(rest);
}

export interface CapabilitySetup {
  id: string;
  name: string;
  description?: string;
  /** `my-setup` is the built-in default every enrolled machine follows. */
  builtIn?: boolean;
  /** Compare-and-swap revision: a stale write is refused. */
  revision: number;
  packageSelections: CapabilityPackageSelection[];
  providerSelectors: CapabilitySelector[];
  machineSelectors: CapabilitySelector[];
  /** Other targets this setup applies to (projects, templates, sessions). */
  targetSelectors?: CapabilitySelector[];
  /** `<selector>|<componentId or packageId>`: one exception per target. */
  exclusions: string[];
  parentSetupIds: string[];
  updatePolicy: CapabilityUpdatePolicy;
  updatedAt: string;
  updatedBy?: string;
}

export const MY_SETUP_ID = "my-setup";

export const CAPABILITY_UPDATE_POLICIES = ["approve", "trusted-auto", "pinned"] as const;
export type CapabilityUpdatePolicy = (typeof CAPABILITY_UPDATE_POLICIES)[number];

export interface CapabilityTarget {
  nodeId: string;
  provider: AgentPlatform;
  accountHomeId?: string;
  projectId?: string;
  environmentId?: string;
  environmentIncarnation?: string;
  sessionId?: string;
}

export function capabilityTargetKey(target: CapabilityTarget): string {
  return [
    target.nodeId,
    target.provider,
    target.accountHomeId ?? "",
    target.projectId ?? "",
    target.environmentId ?? "",
    target.environmentIncarnation ?? "",
    target.sessionId ?? "",
  ].join("|");
}

export interface EffectiveAgentResources {
  target: CapabilityTarget;
  setupRevisions: Array<{ id: string; revision: number }>;
  resolvedPackages: Array<{ id: string; artifactDigest: string; components: string[] }>;
  permissionPolicyDigest: string;
  manifestDigest: string;
  unsupported: Array<{ componentId: string; reason: string }>;
  blocked: Array<{ componentId: string; reason: string }>;
  /** Required components that are missing or blocked: a launch must stop. */
  launchBlockers: Array<{ componentId: string; reason: string }>;
  warnings: string[];
  resolvedAt: string;
}

// --- Statuses and verification --------------------------------------------

/** One target's state for one component. Never inferred from a file copy alone. */
export const CAPABILITY_TARGET_STATUSES = [
  "ready",
  "installed-next-session",
  "queued-until-idle",
  "restart-required",
  "needs-auth",
  "needs-approval",
  "offline",
  "unsupported",
  "blocked-policy",
  "drifted",
  "failed",
  "outcome-unknown",
  "pending",
] as const;
export type CapabilityTargetStatus = (typeof CAPABILITY_TARGET_STATUSES)[number];

export const CAPABILITY_TARGET_STATUS_LABELS: Readonly<Record<CapabilityTargetStatus, string>> =
  Object.freeze({
    ready: "Ready",
    "installed-next-session": "Next session",
    "queued-until-idle": "Queued until idle",
    "restart-required": "Restart required",
    "needs-auth": "Needs sign-in",
    "needs-approval": "Needs approval",
    offline: "Waiting for machine",
    unsupported: "Unsupported",
    "blocked-policy": "Blocked by policy",
    drifted: "Local changes",
    failed: "Failed",
    "outcome-unknown": "Checking",
    pending: "Pending",
  });

/** Statuses that need the user (or a later event) before the target is usable. */
export function capabilityStatusNeedsAttention(status: CapabilityTargetStatus): boolean {
  return (
    status === "needs-auth" ||
    status === "needs-approval" ||
    status === "blocked-policy" ||
    status === "drifted" ||
    status === "failed" ||
    status === "restart-required"
  );
}

/**
 * How far the evidence for one component on one target goes. Each level
 * implies the ones before it. `unverified` is what an adapter with no live
 * inventory reports after `present`/`enabled`: it never fabricates
 * `advertised` or `load-confirmed`.
 */
export const CAPABILITY_VERIFICATION_LEVELS = [
  "requested",
  "present",
  "enabled",
  "allowed",
  "advertised",
  "load-confirmed",
  "observed-in-use",
] as const;
export type CapabilityVerificationLevel = (typeof CAPABILITY_VERIFICATION_LEVELS)[number];

export const CAPABILITY_VERIFICATION_LABELS: Readonly<
  Record<CapabilityVerificationLevel | "unverified", string>
> = Object.freeze({
  requested: "Assigned",
  present: "Files present",
  enabled: "Enabled",
  allowed: "Allowed by policy",
  advertised: "Listed by the agent",
  "load-confirmed": "Load confirmed",
  "observed-in-use": "Used in a session",
  unverified: "Installed; not runtime-verified",
});

export function verificationRank(level: CapabilityVerificationLevel): number {
  return CAPABILITY_VERIFICATION_LEVELS.indexOf(level);
}

/**
 * The status a receipt may claim from its evidence. `ready` needs at least
 * `advertised` evidence for a running generation; a copy that no runtime has
 * reported yet is `installed-next-session` at best.
 */
export function statusFromEvidence(input: {
  level: CapabilityVerificationLevel;
  runtimeInventory: boolean;
  sessionRunning: boolean;
}): CapabilityTargetStatus {
  if (verificationRank(input.level) >= verificationRank("advertised")) return "ready";
  if (verificationRank(input.level) < verificationRank("present")) return "pending";
  return input.sessionRunning ? "queued-until-idle" : "installed-next-session";
}

// --- Live change semantics -------------------------------------------------

/** What a change to a running session means for one component. */
export const CAPABILITY_LIVE_SEMANTICS = [
  "available-next-turn",
  "queued-until-idle",
  "reload-supported",
  "new-session-required",
  "cannot-enforce-without-isolated-home",
  "blocked-by-policy",
] as const;
export type CapabilityLiveSemantics = (typeof CAPABILITY_LIVE_SEMANTICS)[number];

export const CAPABILITY_LIVE_SEMANTICS_LABELS: Readonly<Record<CapabilityLiveSemantics, string>> =
  Object.freeze({
    "available-next-turn": "Available next turn",
    "queued-until-idle": "Queued until idle",
    "reload-supported": "Reload supported",
    "new-session-required": "New session required",
    "cannot-enforce-without-isolated-home": "Cannot enforce without an isolated home",
    "blocked-by-policy": "Blocked by policy",
  });

// --- Operations ------------------------------------------------------------

export const CAPABILITY_OPERATION_STATES = [
  "planned",
  "awaiting-approval",
  "approved",
  "preparing",
  "applying",
  "observing",
  "completed",
  "partially-completed",
  "failed",
  "cancelled",
  "superseded",
] as const;
export type CapabilityOperationState = (typeof CAPABILITY_OPERATION_STATES)[number];

export function isTerminalCapabilityOperationState(state: CapabilityOperationState): boolean {
  return (
    state === "completed" ||
    state === "partially-completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "superseded"
  );
}

export const CAPABILITY_CHANGE_KINDS = [
  "add-to-setup",
  "remove-from-setup",
  "update",
  "rollback",
  "pause",
  "resume",
  "pin",
  "unpin",
  "reconcile",
  "adopt",
  "import",
] as const;
export type CapabilityChangeKind = (typeof CAPABILITY_CHANGE_KINDS)[number];

/** One target's planned action. */
export type CapabilityTargetAction = "install" | "update" | "remove" | "keep" | "skip";

export interface CapabilityPlannedTarget {
  /** Stable per (operation, target, component): the idempotency key of the write. */
  key: string;
  target: CapabilityTarget;
  componentId: string;
  packageId: string;
  action: CapabilityTargetAction;
  fromDigest?: string;
  toDigest?: string;
  /** Opaque physical location id (`claude-user`, `agents-shared`), never a host path. */
  locationId?: string;
  /** Providers that also see this location although the setup did not ask for them. */
  alsoVisibleTo?: AgentPlatform[];
  status: CapabilityTargetStatus;
  reason?: string;
  liveSemantics?: CapabilityLiveSemantics;
  /** Shared files: other setups or accounts that keep this installation referenced. */
  sharedWith?: number;
}

export interface CapabilityOperationSnapshot {
  id: string;
  kind: CapabilityChangeKind;
  state: CapabilityOperationState;
  /** SHA-256 of the plan: approval is recorded for exactly this digest. */
  planDigest: string;
  setupId?: string;
  setupRevision?: number;
  packageIds: string[];
  targets: CapabilityPlannedTarget[];
  requiresApproval: boolean;
  approvalReasons: string[];
  approvedDigest?: string;
  approvedBy?: string;
  summary: CapabilityOperationSummary;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  supersededBy?: string;
  error?: string;
}

export interface CapabilityOperationSummary {
  total: number;
  byStatus: Partial<Record<CapabilityTargetStatus, number>>;
}

export function summarizeCapabilityTargets(
  targets: readonly Pick<CapabilityPlannedTarget, "status">[],
): CapabilityOperationSummary {
  const byStatus: Partial<Record<CapabilityTargetStatus, number>> = {};
  for (const target of targets) byStatus[target.status] = (byStatus[target.status] ?? 0) + 1;
  return { total: targets.length, byStatus };
}

// --- Client DTOs -------------------------------------------------------------

export interface CapabilityPackageSummary {
  id: string;
  displayName: string;
  description?: string;
  source: PackageSource;
  sourceLabel: string;
  revision: string;
  artifactDigest: string;
  provenance: CapabilityProvenance;
  risk: CapabilityRisk;
  kinds: ComponentKind[];
  componentCount: number;
  components: Array<Pick<CapabilityComponent, "id" | "kind" | "name" | "risk">>;
  assignedSetupIds: string[];
  readiness: "ready" | "needs-attention" | "pending" | "unassigned";
  attention: number;
  updateAvailable: boolean;
  pinned: boolean;
  paused: boolean;
  updatedAt: string;
}

export interface CapabilityAvailabilityCell {
  target: CapabilityTarget;
  nodeName?: string;
  componentId: string;
  status: CapabilityTargetStatus;
  verification: CapabilityVerificationLevel | "unverified";
  installedDigest?: string;
  locationId?: string;
  alsoVisibleTo?: AgentPlatform[];
  reason?: string;
  remedy?: string;
  lastVerifiedAt?: string;
}

export interface CapabilityPackageDetail {
  package: CapabilityPackageSummary;
  components: CapabilityComponent[];
  availability: CapabilityAvailabilityCell[];
  previousRevisions: Array<{ revision: string; artifactDigest: string; replacedAt: string }>;
  files: Array<{ path: string; bytes: number; executable: boolean }>;
}

export interface CapabilityMachineSummary {
  nodeId: string;
  name: string;
  enrolled: boolean;
  groups: string[];
  connection: "self" | "connected" | "offline" | "unknown";
  lastSeenAt?: string;
  lastObservedAt?: string;
  appliedManifestDigest?: string;
  desiredManifestDigest?: string;
  pendingOperationIds: string[];
  os?: string;
  providers: Array<{ provider: AgentPlatform; version?: string; available: boolean }>;
  counts: Partial<Record<CapabilityTargetStatus, number>>;
}

export interface CapabilityActivityEntry {
  id: string;
  at: string;
  actor?: string;
  action: string;
  summary: string;
  packageIds: string[];
  setupIds: string[];
  operationId?: string;
  correlationId: string;
}

export interface CapabilityUpdateProposal {
  id: string;
  packageId: string;
  fromRevision: string;
  toRevision: string;
  fromDigest: string;
  toDigest: string;
  detectedAt: string;
  state: "pending" | "approved" | "applied" | "dismissed" | "failed";
  requiresApproval: boolean;
  reasons: string[];
  changes: CapabilityComponentChange[];
}

export interface CapabilityComponentChange {
  componentId: string;
  kind: ComponentKind;
  change: "added" | "removed" | "modified";
  /** Risk raised (new executable, hook, network endpoint or permission). */
  escalation?: string;
}

export interface CapabilityDriftEntry {
  id: string;
  nodeId: string;
  provider: AgentPlatform;
  locationId: string;
  componentId?: string;
  packageId?: string;
  name: string;
  kind: "modified" | "removed" | "unmanaged";
  expectedDigest?: string;
  observedDigest?: string;
  detectedAt: string;
  state: "open" | "kept-local" | "adopted" | "replaced";
}

export function allAgentPlatforms(): AgentPlatform[] {
  return [...AGENT_PLATFORMS];
}

export const CAPABILITY_MANAGEMENT_CHANGED_EVENT = "capability-management-changed";

export interface CapabilityManagementChangedEvent {
  revision: number;
  packageIds: string[];
  setupIds: string[];
  operationIds: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
