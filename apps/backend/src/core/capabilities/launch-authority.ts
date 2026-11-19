/**
 * Launch authority (docs/architecture/agent-capabilities-management.md,
 * "Authority" and "Runtime connection points").
 *
 * - {@link verifyLaunchDeliveries}: at launch, every recorded installation of
 *   a required component that the provider can see must be observed with
 *   exactly the recorded bytes: a container's staged record or an account's
 *   private copy when that is all the target reads, otherwise the host's
 *   copies (and a worktree's own copy beside them); the launch record lists
 *   the observed digests.
 * - {@link LeafLaunchAuthority}: a leaf's store holds no setups, so its
 *   native launch asks the command node. A leaf has no link to its command
 *   node (links go from command node to leaf), so the request is an event on
 *   the leaf's own stream, which the command node already follows
 *   (`node-capability-launch-requested`), and the answer is an internal
 *   command the command node invokes on the leaf
 *   (`answer_capability_node_launch`), admitted by the executor's
 *   single-writer epoch. Without an answer the leaf uses its last answer for
 *   the same target only while it is recent and this machine's applied
 *   installations and observed bytes are unchanged; otherwise required
 *   components block the launch and optional ones are a warning.
 * - {@link answerLeafLaunch}: the command node's side: resolves the leaf's
 *   target against the authoritative state, records the launch and answers.
 */
import { randomBytes } from "node:crypto";

import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIMITS,
  type CapabilityTarget,
  type EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityInventory,
  CapabilityObservedItem,
} from "@orkestrator/protocol/capability-resources-api";
import {
  canonicalCapabilityJson,
  type CapabilityPermissionCeiling,
} from "@orkestrator/protocol/capability-resources-resolve";
import { answerCapabilityNodeLaunchCommand } from "@orkestrator/protocol/contract/domains/capabilities";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import { installName } from "./native-ownership.js";
import type { CapabilityLink } from "./node-transport.js";
import { sha256 } from "./planning.js";
import {
  parseContainerCapabilityRecord,
  type ContainerCapabilityRecord,
} from "./container-staging.js";
import {
  containerUnstagedReason,
  revisionComponent,
  scopedRequiredDelivery,
  type ScopedEvidence,
} from "./scoped-delivery.js";
import { projectCapabilityLocation, projectMcpLocation } from "./scoped-locations.js";
import { CapabilityError } from "./security.js";
import type {
  CapabilityExecutorState,
  CapabilityLaunchDelivery,
  CapabilityState,
  LeafLaunchAnswerRecord,
} from "./types.js";

const log = createLogger("capabilities");

/** How long a leaf waits for its command node's answer before falling back. */
export const LEAF_LAUNCH_ANSWER_TIMEOUT_MS = 5_000;
/** A cached answer older than this no longer stands in for the command node. */
export const LEAF_LAUNCH_CACHE_MAX_AGE_MS = 6 * 60 * 60_000;
const MAX_CACHED_ANSWERS = 100;
const MAX_REPORTED_ITEMS = 4_000;

export const COMMAND_NODE_UNREACHABLE_REASON =
  "The command node is unreachable, so this session's required capabilities cannot be confirmed. Reconnect the command node, then launch again.";

export interface LaunchRequest {
  target: CapabilityTarget;
  sessionKey: string;
  relativeWorktree?: string;
  ceiling: CapabilityPermissionCeiling;
  templateId?: string;
  graphNode?: string;
}

/** Whether any setup in this state requires a package (the leaf's fail-closed hint). */
export function stateHasRequired(state: CapabilityState): boolean {
  return Object.values(state.setups).some((setup) =>
    setup.packageSelections.some((selection) => selection.required === true),
  );
}

/**
 * The installed bytes behind the resolved packages, as observed at launch.
 *
 * A target with its own copies answers from them first
 * (`scopedRequiredDelivery`): a container reads only what was staged into
 * its inputs revision, and an account with a private directory only its own
 * copy, so the host's copies are not theirs to check; a stale or missing
 * staged record blocks a required component with the rebuild remedy. A
 * worktree's verified project copy is listed, but the host's copies are
 * still checked: the provider reads both, and Claude ranks a personal skill
 * above a project one. Otherwise, for a required package, every
 * machine-wide copy the provider reads must be observed, managed, unchanged
 * and equal to the recorded digest. The deliveries list exactly what was
 * observed.
 */
export function verifyLaunchDeliveries(input: {
  state: CapabilityState;
  effective: EffectiveAgentResources;
  inventory: Pick<CapabilityInventory, "items"> | undefined;
  required: ReadonlySet<string>;
  /** The target's own copies (`ScopedCapabilityDelivery.launchEvidence`). */
  scopedEvidence?: ScopedEvidence;
}): {
  deliveries: CapabilityLaunchDelivery[];
  blockers: Array<{ componentId: string; reason: string }>;
} {
  const { state, effective, inventory } = input;
  const target = effective.target;
  const deliveries: CapabilityLaunchDelivery[] = [];
  const blockers: Array<{ componentId: string; reason: string }> = [];
  for (const pkg of effective.resolvedPackages) {
    const required = input.required.has(pkg.id);
    for (const componentId of pkg.components) {
      const component = revisionComponent(state, pkg.id, componentId, pkg.artifactDigest) ??
        state.components[componentId] ?? { id: componentId, name: componentId };
      const scoped = scopedRequiredDelivery({
        state,
        target,
        ...(input.scopedEvidence ? { evidence: input.scopedEvidence } : {}),
        component,
        digest: pkg.artifactDigest,
      });
      if (scoped.kind === "refused") {
        if (required) blockers.push({ componentId, reason: scoped.reason });
        continue;
      }
      if (
        required &&
        target.provider === "claude" &&
        "kind" in component &&
        component.kind === "skill" &&
        scoped.kind === "verified" &&
        !scoped.exclusive &&
        inventory?.items.some((item) => {
          if (item.locationId !== "claude-user-skills") return false;
          const receipt = Object.values(state.receipts).find(
            (entry) =>
              entry.nodeId === target.nodeId &&
              entry.locationId === item.locationId &&
              entry.componentId === item.componentId &&
              entry.environmentId === undefined &&
              entry.accountHomeId === target.accountHomeId,
          );
          const observedComponent =
            receipt &&
            revisionComponent(state, receipt.packageId, receipt.componentId, receipt.packageDigest);
          const observedName =
            item.name ||
            (observedComponent
              ? installName(observedComponent.name, observedComponent.pathOrKey, "directory")
              : "");
          return (
            (item.componentId === componentId ||
              observedName === installName(component.name, component.pathOrKey, "directory")) &&
            (receipt?.packageDigest !== pkg.artifactDigest ||
              item.drifted ||
              item.digest !== receipt?.digest)
          );
        })
      ) {
        blockers.push({
          componentId,
          reason: `A personal copy of ${component.name} shadows the required project revision.`,
        });
      }
      if (scoped.kind === "verified") {
        for (const entry of scoped.deliveries) {
          deliveries.push({ packageId: pkg.id, componentId, ...entry });
        }
        if (scoped.exclusive) continue;
      }
      const receipts = Object.values(state.receipts).filter(
        (receipt) =>
          receipt.nodeId === target.nodeId &&
          receipt.componentId === componentId &&
          receipt.packageDigest === pkg.artifactDigest &&
          receipt.providers.includes(target.provider) &&
          receipt.environmentId === undefined &&
          receipt.accountHomeId === undefined &&
          !receipt.outcomeUnknown,
      );
      for (const receipt of receipts) {
        const observed = inventory?.items.find(
          (item) =>
            item.ownership === "managed" &&
            item.componentId === componentId &&
            item.locationId === receipt.locationId,
        );
        if (observed?.digest) {
          deliveries.push({
            packageId: pkg.id,
            componentId,
            locationId: receipt.locationId,
            digest: observed.digest,
          });
        }
        if (!required) continue;
        if (!observed || observed.drifted || observed.digest !== receipt.digest) {
          const name = state.components[componentId]?.name ?? componentId;
          blockers.push({
            componentId,
            reason: `The installed copy of ${name} does not match the revision recorded for this launch.`,
          });
        }
      }
    }
  }
  deliveries.sort((a, b) =>
    `${a.packageId}|${a.componentId}|${a.locationId}`.localeCompare(
      `${b.packageId}|${b.componentId}|${b.locationId}`,
    ),
  );
  return { deliveries, blockers: dedupeBlockers(blockers) };
}

function dedupeBlockers(
  blockers: Array<{ componentId: string; reason: string }>,
): Array<{ componentId: string; reason: string }> {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.componentId}|${blocker.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Adds blockers the resolver did not already report. */
export function withBlockers(
  effective: EffectiveAgentResources,
  blockers: Array<{ componentId: string; reason: string }>,
): EffectiveAgentResources {
  if (blockers.length === 0) return effective;
  return {
    ...effective,
    launchBlockers: dedupeBlockers([...effective.launchBlockers, ...blockers]),
  };
}

/** What the leaf reports about its own managed copies: ids and digests only. */
export function compactInventory(
  inventory: CapabilityInventory | undefined,
): Pick<CapabilityInventory, "os" | "providers" | "items"> | undefined {
  if (!inventory) return undefined;
  return {
    os: inventory.os,
    providers: inventory.providers.map((entry) => ({
      provider: entry.provider,
      available: entry.available,
      ...(entry.version ? { version: entry.version } : {}),
    })),
    items: inventory.items
      .filter((item) => item.ownership === "managed")
      .slice(0, MAX_REPORTED_ITEMS)
      .map((item) => ({
        // Ids and digests only: no names, labels or paths leave the machine.
        id: `${item.locationId}/${item.componentId ?? ""}`,
        provider: item.provider,
        kind: item.kind,
        name: "",
        locationId: item.locationId,
        locationLabel: "",
        ownership: item.ownership,
        ...(item.packageId ? { packageId: item.packageId } : {}),
        ...(item.componentId ? { componentId: item.componentId } : {}),
        ...(item.digest ? { digest: item.digest } : {}),
        ...(item.drifted ? { drifted: true } : {}),
        visibleTo: item.visibleTo,
      })),
  };
}

/** Digest of what this machine's executor has applied: changes when any installation does. */
export function appliedDigest(executor: CapabilityExecutorState): string {
  return sha256(
    canonicalCapabilityJson(
      Object.entries(executor.applied)
        .map(([key, entry]) => [key, entry.digest, entry.action])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
  );
}

/** One cache entry per target and logical assignment. */
export function launchCacheKey(request: LaunchRequest): string {
  const { sessionId: _sessionId, ...target } = request.target;
  return sha256(
    canonicalCapabilityJson({
      target,
      sessionKey: request.sessionKey,
      relativeWorktree: request.relativeWorktree ?? null,
      templateId: request.templateId ?? null,
      graphNode: request.graphNode ?? null,
      ceiling: request.ceiling.digest,
    }),
  );
}

function manifestDigestFor(effective: EffectiveAgentResources): string {
  return sha256(
    canonicalCapabilityJson({
      target: effective.target,
      packages: effective.resolvedPackages,
      policy: effective.permissionPolicyDigest,
    }),
  );
}

// --- A leaf's own copies (worktree, container) --------------------------------

/**
 * What a leaf reports with a launch about the target's own copies, ids and
 * digests only: the managed copies in the environment's worktree (project
 * directories and project MCP files), or the capability record staged into
 * its container with the container's label.
 */
export interface LeafScopedReport {
  project?: Array<{ locationId: string; componentId: string; digest: string }>;
  container?: {
    containerId: string;
    labelDigest: string | null;
    record: ContainerCapabilityRecord | null;
  };
}

const MAX_REPORTED_SCOPED = 2_000;

/** A leaf's report, bounded: it is input from a peer. */
export function parseLeafScopedReport(value: unknown): LeafScopedReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const report: LeafScopedReport = {};
  if (Array.isArray(record.project)) {
    report.project = record.project.slice(0, MAX_REPORTED_SCOPED).flatMap((raw: unknown) => {
      const entry = (raw ?? {}) as Record<string, unknown>;
      const locationId = text(entry.locationId);
      const componentId = text(entry.componentId);
      const digest = text(entry.digest, 200);
      return locationId && componentId && digest ? [{ locationId, componentId, digest }] : [];
    });
  }
  const container = (record.container ?? null) as Record<string, unknown> | null;
  const containerId = container ? text(container.containerId) : undefined;
  if (container && containerId) {
    report.container = {
      containerId,
      labelDigest: text(container.labelDigest, 200) ?? null,
      record: parseContainerCapabilityRecord(container.record),
    };
  }
  return report;
}

/** The scoped evidence a leaf's report gives for its launch target, against the receipts here. */
export function scopedEvidenceFromReport(
  state: CapabilityState,
  target: CapabilityTarget,
  report: LeafScopedReport | undefined,
): ScopedEvidence | undefined {
  if (!report) return undefined;
  const evidence: ScopedEvidence = {};
  if (report.container && target.environmentIncarnation !== undefined) {
    evidence.container = { ...report.container, inputsRevision: "" };
  }
  if (report.project && target.environmentId && target.environmentIncarnation === undefined) {
    const observed = new Map<string, string | null>();
    for (const receipt of Object.values(state.receipts)) {
      if (receipt.nodeId !== target.nodeId || receipt.environmentId !== target.environmentId)
        continue;
      const seen = report.project.find(
        (entry) =>
          entry.locationId === receipt.locationId && entry.componentId === receipt.componentId,
      );
      observed.set(receipt.id, seen?.digest ?? null);
    }
    evidence.project = { environmentId: target.environmentId, observed };
  }
  return evidence;
}

/** The digest a scoped delivery holds now, from the leaf's own report; undefined: not scoped. */
function scopedDeliveryDigest(
  delivery: CapabilityLaunchDelivery,
  report: LeafScopedReport | undefined,
): string | null | undefined {
  if (delivery.locationId.startsWith("container:")) {
    const container = report?.container;
    if (!container?.record || container.labelDigest !== container.record.digest) return null;
    const locationId = delivery.locationId.slice("container:".length);
    const item = container.record.items.find(
      (entry) =>
        entry.componentId === delivery.componentId &&
        entry.locationId === locationId &&
        entry.status === "staged",
    );
    return item ? (item.digest ?? item.packageDigest) : null;
  }
  if (projectCapabilityLocation(delivery.locationId) || projectMcpLocation(delivery.locationId)) {
    return (
      report?.project?.find(
        (entry) =>
          entry.locationId === delivery.locationId && entry.componentId === delivery.componentId,
      )?.digest ?? null
    );
  }
  return undefined;
}

// --- Validation of peer input --------------------------------------------------

function text(value: unknown, max: number = CAPABILITY_LIMITS.maxIdChars): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function parseTarget(value: unknown, nodeId: string): CapabilityTarget | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!isAgentPlatform(record.provider)) return null;
  const target: CapabilityTarget = { nodeId, provider: record.provider };
  for (const key of [
    "accountHomeId",
    "projectId",
    "environmentId",
    "environmentIncarnation",
    "sessionId",
  ] as const) {
    const entry = text(record[key]);
    if (entry) target[key] = entry;
  }
  return target;
}

function parseCeiling(value: unknown): CapabilityPermissionCeiling {
  const record = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const denied = Array.isArray(record.denied)
    ? record.denied.filter((entry): entry is string => typeof entry === "string").slice(0, 64)
    : [];
  const userMcpServers = Array.isArray(record.userMcpServers)
    ? record.userMcpServers
        .filter((entry): entry is string => typeof entry === "string")
        .slice(0, 32)
    : null;
  return {
    denied,
    userMcpServers,
    digest:
      text(record.digest, 200) ??
      sha256(canonicalCapabilityJson({ denied: [...denied].sort(), userMcpServers })),
  };
}

function parseItems(value: unknown): CapabilityObservedItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_REPORTED_ITEMS).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const locationId = text(item.locationId);
    if (!locationId || item.ownership !== "managed") return [];
    return [
      {
        id: text(item.id) ?? locationId,
        provider: isAgentPlatform(item.provider) ? item.provider : "claude",
        kind: (text(item.kind, 64) ?? "skill") as CapabilityObservedItem["kind"],
        name: text(item.name, CAPABILITY_LIMITS.maxNameChars) ?? "",
        locationId,
        locationLabel: "",
        ownership: "managed" as const,
        ...(text(item.packageId) ? { packageId: text(item.packageId)! } : {}),
        ...(text(item.componentId) ? { componentId: text(item.componentId)! } : {}),
        ...(text(item.digest, 200) ? { digest: text(item.digest, 200)! } : {}),
        ...(item.drifted === true ? { drifted: true } : {}),
        visibleTo: Array.isArray(item.visibleTo) ? item.visibleTo.filter(isAgentPlatform) : [],
      },
    ];
  });
}

function blockerList(value: unknown): Array<{ componentId: string; reason: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 500).flatMap((entry: unknown) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const componentId = text(record.componentId);
    const reason = text(record.reason, CAPABILITY_LIMITS.maxReasonChars);
    return componentId && reason ? [{ componentId, reason }] : [];
  });
}

/** The command node's answer, bounded: it is input from a peer. */
function parseAnswer(value: unknown, target: CapabilityTarget): LeafAnswer | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const raw = (record.effective ?? null) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.resolvedPackages)) return null;
  const resolvedPackages = raw.resolvedPackages
    .slice(0, CAPABILITY_LIMITS.maxPackages)
    .flatMap((entry: unknown) => {
      const pkg = (entry ?? {}) as Record<string, unknown>;
      const id = text(pkg.id);
      const artifactDigest = text(pkg.artifactDigest, 200);
      if (!id || !artifactDigest || !Array.isArray(pkg.components)) return [];
      return [
        {
          id,
          artifactDigest,
          components: pkg.components
            .filter((component): component is string => typeof component === "string")
            .slice(0, CAPABILITY_LIMITS.maxComponentsPerPackage),
        },
      ];
    });
  const setupRevisions = Array.isArray(raw.setupRevisions)
    ? raw.setupRevisions.slice(0, CAPABILITY_LIMITS.maxSetups).flatMap((entry: unknown) => {
        const setup = (entry ?? {}) as Record<string, unknown>;
        const id = text(setup.id);
        return id && typeof setup.revision === "number" ? [{ id, revision: setup.revision }] : [];
      })
    : [];
  const effective: EffectiveAgentResources = {
    target,
    setupRevisions,
    resolvedPackages,
    permissionPolicyDigest: text(raw.permissionPolicyDigest, 200) ?? "unknown",
    manifestDigest: text(raw.manifestDigest, 200) ?? "unknown",
    unsupported: blockerList(raw.unsupported),
    blocked: blockerList(raw.blocked),
    launchBlockers: blockerList(raw.launchBlockers),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.slice(0, CAPABILITY_LIMITS.maxReasonChars))
          .slice(0, 100)
      : [],
    resolvedAt: text(raw.resolvedAt, 64) ?? new Date().toISOString(),
  };
  const deliveries = Array.isArray(record.deliveries)
    ? record.deliveries.slice(0, MAX_REPORTED_ITEMS).flatMap((entry: unknown) => {
        const delivery = (entry ?? {}) as Record<string, unknown>;
        const packageId = text(delivery.packageId);
        const componentId = text(delivery.componentId);
        const locationId = text(delivery.locationId);
        const digest = text(delivery.digest, 200);
        return packageId && componentId && locationId && digest
          ? [{ packageId, componentId, locationId, digest }]
          : [];
      })
    : [];
  const required = Array.isArray(record.required)
    ? record.required.filter((id): id is string => typeof id === "string").slice(0, 2_000)
    : [];
  return { effective, deliveries, required, requiredOnNode: record.requiredOnNode === true };
}

interface LeafAnswer {
  effective: EffectiveAgentResources;
  deliveries: CapabilityLaunchDelivery[];
  required: string[];
  requiredOnNode: boolean;
}

// --- Leaf side -------------------------------------------------------------------

export interface LeafLaunchAuthorityDeps {
  storage: { capabilities: CapabilitiesStorage };
  observeSelf(): Promise<CapabilityInventory>;
  admitEpoch(controllerId: string, epoch: number): void;
  /** Whether an attached command node has been in contact recently enough to answer. */
  controllerReachable(): Promise<boolean>;
  /** Emits `node-capability-launch-requested` on this machine's event stream. */
  request?(payload: { requestId: string; request: unknown }): void;
  /** The target's own copies on this machine (`RemoteScopedDelivery.leafReport`). */
  scopedReport?(
    target: CapabilityTarget,
    relativeWorktree?: string,
  ): Promise<LeafScopedReport | undefined>;
  now(): string;
}

interface PendingRequest {
  key: string;
  target: CapabilityTarget;
  settle(answer: { answer: LeafAnswer; controllerId: string; epoch: number } | null): void;
}

export interface LeafLaunchResult {
  effective: EffectiveAgentResources;
  deliveries: CapabilityLaunchDelivery[];
  resolvedBy?: string;
}

export class LeafLaunchAuthority {
  private readonly pending = new Map<string, PendingRequest>();
  /** How long a launch waits for the command node (tests shorten it). */
  answerTimeoutMs = LEAF_LAUNCH_ANSWER_TIMEOUT_MS;
  /** How old a cached answer may be to stand in for an unreachable command node. */
  cacheMaxAgeMs = LEAF_LAUNCH_CACHE_MAX_AGE_MS;

  constructor(private readonly deps: LeafLaunchAuthorityDeps) {}

  /** Resolves a launch on this leaf: the command node's answer, a valid cached one, or fail closed. */
  async preflight(request: LaunchRequest): Promise<LeafLaunchResult> {
    const inventory = await this.deps.observeSelf().catch(() => undefined);
    const report = await this.deps
      .scopedReport?.(request.target, request.relativeWorktree)
      .catch(() => undefined);
    const key = launchCacheKey(request);
    const answered =
      this.deps.request && (await this.deps.controllerReachable().catch(() => false))
        ? await this.ask(request, key, inventory, report)
        : null;
    if (answered) {
      // The command node judged our report; check the bytes did not move since.
      const local = this.localDeliveryCheck(answered.answer, inventory, report);
      return {
        effective: withBlockers(
          { ...answered.answer.effective, target: request.target },
          local.blockers,
        ),
        deliveries: answered.answer.deliveries,
        resolvedBy: answered.controllerId,
      };
    }
    return this.fromCache(request, key, inventory, report);
  }

  private ask(
    request: LaunchRequest,
    key: string,
    inventory: CapabilityInventory | undefined,
    report: LeafScopedReport | undefined,
  ): Promise<{ answer: LeafAnswer; controllerId: string; epoch: number } | null> {
    const requestId = `cap_launch_${randomBytes(12).toString("hex")}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A late answer is still cached by `receiveAnswer` for the next launch.
        const entry = this.pending.get(requestId);
        if (entry) entry.settle = () => this.pending.delete(requestId);
        setTimeout(() => this.pending.delete(requestId), 60_000).unref?.();
        resolve(null);
      }, this.answerTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        key,
        target: request.target,
        settle: (answer) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(answer);
        },
      });
      try {
        this.deps.request!({
          requestId,
          request: {
            target: request.target,
            sessionKey: request.sessionKey,
            ceiling: request.ceiling,
            ...(request.templateId ? { templateId: request.templateId } : {}),
            ...(request.graphNode ? { graphNode: request.graphNode } : {}),
            inventory: compactInventory(inventory),
            ...(report ? { scoped: report } : {}),
          },
        });
      } catch (error) {
        log.warn("launch.request-failed", { error: formatLogError(error, { message: false }) });
        this.pending.get(requestId)?.settle(null);
      }
    });
  }

  /** `answer_capability_node_launch`: only this machine's current authority is heard. */
  async receiveAnswer(args: Record<string, unknown>): Promise<{ accepted: boolean }> {
    const controllerId = text(args.controllerId);
    const requestId = text(args.requestId, 128);
    if (!controllerId || !requestId)
      throw new CapabilityError("invalid-request", "controllerId and requestId are required.");
    const epoch = Number(args.epoch);
    this.deps.admitEpoch(controllerId, epoch);
    const pending = this.pending.get(requestId);
    if (!pending) return { accepted: false };
    const answer = parseAnswer(args.answer, pending.target);
    if (!answer) throw new CapabilityError("invalid-request", "The launch answer is malformed.");
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    this.remember(pending.key, controllerId, epoch, answer, appliedDigest(executor));
    pending.settle({ answer, controllerId, epoch });
    return { accepted: true };
  }

  private remember(
    key: string,
    controllerId: string,
    epoch: number,
    answer: LeafAnswer,
    applied: string,
  ): void {
    const now = this.deps.now();
    this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const cache = (state.leafAuthority ??= { answers: {} });
      cache.answers[key] = {
        key,
        controllerId,
        epoch,
        receivedAt: now,
        appliedDigest: applied,
        effective: answer.effective,
        deliveries: answer.deliveries,
        required: answer.required,
      };
      cache.requiredOnNode = { value: answer.requiredOnNode, at: now, controllerId };
      const entries = Object.values(cache.answers).sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      );
      for (const stale of entries.slice(MAX_CACHED_ANSWERS)) delete cache.answers[stale.key];
      return { result: undefined, changed: true };
    });
  }

  /** The recorded deliveries of required components must still be what this machine holds. */
  private localDeliveryCheck(
    answer: Pick<LeafAnswer, "deliveries" | "required">,
    inventory: CapabilityInventory | undefined,
    report: LeafScopedReport | undefined,
  ): { blockers: Array<{ componentId: string; reason: string }> } {
    const required = new Set(answer.required);
    const blockers: Array<{ componentId: string; reason: string }> = [];
    const changed = (componentId: string) =>
      blockers.push({
        componentId,
        reason: "A required capability changed on this machine since the command node checked it.",
      });
    for (const delivery of answer.deliveries) {
      if (!required.has(delivery.componentId)) continue;
      // A worktree's or container's own copy is checked against this machine's report.
      const scoped = scopedDeliveryDigest(delivery, report);
      if (scoped !== undefined) {
        if (scoped !== delivery.digest) changed(delivery.componentId);
        continue;
      }
      const observed = inventory?.items.find(
        (item) =>
          item.ownership === "managed" &&
          item.componentId === delivery.componentId &&
          item.locationId === delivery.locationId,
      );
      if (!observed || observed.drifted || observed.digest !== delivery.digest) {
        blockers.push({
          componentId: delivery.componentId,
          reason:
            "A required capability changed on this machine since the command node checked it.",
        });
      }
    }
    return { blockers };
  }

  private async fromCache(
    request: LaunchRequest,
    key: string,
    inventory: CapabilityInventory | undefined,
    report: LeafScopedReport | undefined,
  ): Promise<LeafLaunchResult> {
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const executor = await this.deps.storage.capabilities.loadCapabilityExecutorState();
    const cached: LeafLaunchAnswerRecord | undefined = state.leafAuthority?.answers[key];
    const maxAge = this.cacheMaxAgeMs;
    const fresh =
      cached !== undefined &&
      Date.parse(this.deps.now()) - Date.parse(cached.receivedAt) <= maxAge &&
      cached.controllerId === executor.controllerId &&
      cached.epoch === executor.epoch &&
      cached.appliedDigest === appliedDigest(executor);
    if (cached && fresh) {
      const local = this.localDeliveryCheck(cached, inventory, report);
      const effective: EffectiveAgentResources = {
        ...cached.effective,
        target: request.target,
        warnings: [
          ...cached.effective.warnings,
          "The command node is unreachable; this launch uses its last answer for this target.",
        ],
        resolvedAt: this.deps.now(),
      };
      effective.manifestDigest = manifestDigestFor(effective);
      return {
        effective: withBlockers(effective, local.blockers),
        deliveries: cached.deliveries,
        resolvedBy: cached.controllerId,
      };
    }
    const requiredKnown =
      state.leafAuthority?.requiredOnNode?.value === true || (cached?.required.length ?? 0) > 0;
    // A container this machine created while the command node was away holds nothing.
    const container = report?.container;
    const unstaged =
      container?.record?.unstaged !== undefined &&
      container.labelDigest === container.record.digest &&
      container.containerId === request.target.environmentIncarnation;
    const effective: EffectiveAgentResources = {
      target: request.target,
      setupRevisions: [],
      resolvedPackages: [],
      permissionPolicyDigest: request.ceiling.digest,
      manifestDigest: "",
      unsupported: [],
      blocked: [],
      launchBlockers: requiredKnown
        ? [
            {
              componentId: "command-node",
              reason: unstaged
                ? containerUnstagedReason("this session's required capabilities")
                : COMMAND_NODE_UNREACHABLE_REASON,
            },
          ]
        : [],
      warnings: [
        "The command node is unreachable; capabilities on this machine are as last applied and are not confirmed for this session.",
      ],
      resolvedAt: this.deps.now(),
    };
    effective.manifestDigest = manifestDigestFor(effective);
    return { effective, deliveries: [] };
  }
}

// --- Command side ----------------------------------------------------------------

export interface LeafLaunchAnswerDeps {
  storage: { capabilities: CapabilitiesStorage };
  selfId(): Promise<string>;
  isAuthority(): boolean;
  link(nodeId: string): CapabilityLink | null;
  resolve(
    state: CapabilityState,
    input: {
      target: CapabilityTarget;
      sessionKey: string;
      ceiling: CapabilityPermissionCeiling;
      templateId?: string;
      graphNode?: string;
      launchInventory?: CapabilityInventory;
      scopedEvidence?: ScopedEvidence;
      forLaunch: true;
      captureRequired?: (ids: ReadonlySet<string>) => void;
    },
  ): EffectiveAgentResources;
  now(): string;
}

/**
 * The command node answers a leaf's launch request: resolves its target
 * against the authoritative state with the leaf's reported deliveries,
 * records the launch, and sends the answer back over the link.
 */
export async function answerLeafLaunch(
  deps: LeafLaunchAnswerDeps,
  nodeId: string,
  payload: unknown,
): Promise<{ answered: boolean }> {
  if (!deps.isAuthority()) return { answered: false };
  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const requestId = text(record.requestId, 128);
  const request = (record.request ?? null) as Record<string, unknown> | null;
  const target = request ? parseTarget(request.target, nodeId) : null;
  const sessionKey = request ? text(request.sessionKey) : undefined;
  if (!requestId || !request || !target || !sessionKey) return { answered: false };
  const link = deps.link(nodeId);
  if (!link?.connected) return { answered: false };
  const selfId = await deps.selfId();
  const state = await deps.storage.capabilities.loadCapabilityState();
  const machine = state.machines[nodeId];
  const reported = (request.inventory ?? null) as Record<string, unknown> | null;
  const launchInventory: CapabilityInventory | undefined = reported
    ? {
        nodeId,
        observedAt: deps.now(),
        os: text(reported.os, 64) ?? machine?.inventory?.os ?? "unknown",
        providers: Array.isArray(reported.providers)
          ? reported.providers.slice(0, 16).flatMap((entry: unknown) => {
              const provider = (entry ?? {}) as Record<string, unknown>;
              return isAgentPlatform(provider.provider)
                ? [
                    {
                      provider: provider.provider,
                      available: provider.available === true,
                      ...(text(provider.version, 64)
                        ? { version: text(provider.version, 64)! }
                        : {}),
                    },
                  ]
                : [];
            })
          : (machine?.inventory?.providers ?? []),
        items: parseItems(reported.items),
        truncated: 0,
        errors: [],
      }
    : undefined;
  const ceiling = parseCeiling(request.ceiling);
  const templateId = text(request.templateId);
  const graphNode = text(request.graphNode);
  // The worktree's or container's own copies, as the leaf reported them.
  const scopedEvidence = scopedEvidenceFromReport(
    state,
    target,
    parseLeafScopedReport(request.scoped),
  );
  let required: ReadonlySet<string> = new Set();
  const resolved = deps.resolve(state, {
    captureRequired: (ids) => {
      required = ids;
    },
    target,
    sessionKey,
    ceiling,
    forLaunch: true,
    ...(templateId ? { templateId } : {}),
    ...(graphNode ? { graphNode } : {}),
    ...(launchInventory ? { launchInventory } : {}),
    ...(scopedEvidence ? { scopedEvidence } : {}),
  });
  const checked = verifyLaunchDeliveries({
    state,
    effective: resolved,
    inventory: launchInventory,
    required,
    ...(scopedEvidence ? { scopedEvidence } : {}),
  });
  const effective = withBlockers(resolved, checked.blockers);
  const requiredComponents = effective.resolvedPackages
    .filter((pkg) => required.has(pkg.id))
    .flatMap((pkg) => pkg.components);
  if (effective.launchBlockers.length === 0) {
    deps.storage.capabilities.mutateCapabilityState((current) => {
      current.launches[`${nodeId}|${sessionKey}`] = {
        sessionKey,
        target: effective.target,
        manifestDigest: effective.manifestDigest,
        permissionPolicyDigest: effective.permissionPolicyDigest,
        packages: effective.resolvedPackages.map((entry) => ({
          id: entry.id,
          artifactDigest: entry.artifactDigest,
        })),
        deliveries: checked.deliveries,
        resolvedBy: selfId,
        launchedAt: deps.now(),
      };
      return { result: undefined, changed: true };
    });
  }
  try {
    await link.invokeCommand(answerCapabilityNodeLaunchCommand, {
      controllerId: selfId,
      epoch: state.epoch,
      requestId,
      answer: {
        effective,
        deliveries: checked.deliveries,
        required: requiredComponents,
        requiredOnNode: stateHasRequired(state),
      } as never,
    });
  } catch (error) {
    log.warn("launch.answer-failed", { error: formatLogError(error, { message: false }) });
    return { answered: false };
  }
  return { answered: true };
}
