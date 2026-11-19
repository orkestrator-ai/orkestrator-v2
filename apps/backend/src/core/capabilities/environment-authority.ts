import { kindsFor } from "./scoped-locations.js";
/**
 * A leaf's environments under its command node's authority
 * (docs/architecture/agent-capabilities-management.md, "Authority" and
 * "Runtime connection points").
 *
 * A leaf's store holds no setups and no receipts; its command node's does.
 * Two things about a leaf's environments need them:
 *
 * - **Container staging.** When a leaf creates or rebuilds a container it
 *   asks its command node for the container target's effective manifest on
 *   its own event stream (`node-capability-leaf-requested`, kind
 *   `container-staging`), the way a launch asks. The command node plans the
 *   container against the authoritative state, stages every artifact the
 *   plan names on the leaf through the chunked transfer
 *   (`stage_capability_node_artifact`), then answers
 *   (`answer_capability_node_request`, admitted only at the leaf's current
 *   epoch and controller). The leaf caches the plan per container target and
 *   stages it from its own verified artifacts. Without an answer in time it
 *   stages its last cached plan for that target when every artifact it names
 *   is here, otherwise nothing, with a record saying so: the card shows
 *   "Capabilities not staged: command node unreachable" and required
 *   components block with that reason. Nothing is ever written into a
 *   running container; a rebuild stages again.
 * - **The environment card.** The command node answers for an environment on
 *   any machine from its own receipts and plan (the window asks its command
 *   scope); a container's staged record still comes from the machine that
 *   owns the container (`get_capability_node_container_delivery`). A leaf
 *   asked for its own environment's card forwards the question with its
 *   container's record (kind `environment-delivery`), and without an answer
 *   shows only what it holds, with a notice.
 *
 * On a command node (or a machine with no command node) both fall through to
 * this machine's own staging and view (`environment-delivery.ts`).
 */
import { randomBytes } from "node:crypto";

import { AGENT_PLATFORMS, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  CAPABILITY_LIMITS,
  type CapabilityTarget,
  type ComponentKind,
  type EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityEnvironmentDelivery,
  CapabilityEnvironmentDeliveryItem,
} from "@orkestrator/protocol/capability-resources-api";
import { capabilityLocation } from "@orkestrator/protocol/capability-resources-support";
import { canonicalCapabilityJson } from "@orkestrator/protocol/capability-resources-resolve";
import {
  answerCapabilityNodeRequestCommand,
  getCapabilityNodeContainerDeliveryCommand,
} from "@orkestrator/protocol/contract/domains/capabilities";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

import type { CapabilitiesStorage } from "../storage-capabilities.js";
import type { CapabilityArtifactStore } from "./artifact-store.js";
import {
  containerCapabilityPlan,
  containerPlanDigest,
  stageContainerCapabilities,
  unstagedContainerPlan,
  unstagedContainerRecord,
  type ContainerCapabilityItem,
  type ContainerCapabilityPlan,
  type ContainerCapabilityRecord,
} from "./container-staging.js";
import {
  containerStaging,
  environmentDeliveryView,
  type EnvironmentDeliveryContext,
} from "./environment-delivery.js";
import { handedOverAuthority } from "./handover.js";
import { parseLeafScopedReport } from "./launch-authority.js";
import { remoteTransport, type CapabilityLink } from "./node-transport.js";
import { sha256 } from "./planning.js";
import {
  CONTAINER_UNSTAGED_SUMMARY,
  type ContainerDeliveryEvidence,
  type ScopedEnvironment,
  type ScopedTargetSources,
} from "./scoped-delivery.js";
import { containerCapabilityLocations } from "./scoped-locations.js";
import { CapabilityError } from "./security.js";
import type { CapabilityState, LeafContainerPlanRecord } from "./types.js";

const log = createLogger("capabilities");

/** How long a leaf creating a container waits for the command node's manifest and artifacts. */
export const CONTAINER_MANIFEST_TIMEOUT_MS = 20_000;
/** How long a leaf waits for the command node's environment card. */
export const ENVIRONMENT_CARD_TIMEOUT_MS = 5_000;
/** How long a late answer is still taken (and cached) after the wait gave up. */
const LATE_ANSWER_MS = 60_000;
const MAX_CACHED_CONTAINER_PLANS = 100;
const MAX_PLAN_ITEMS = 2_000;
const MAX_CARD_ITEMS = 500;
const MAX_REASON = 500;

export const COMMAND_NODE_UNREACHABLE_NOTICE =
  "The command node is unreachable, so this shows only what this machine holds, not whether it is current.";

/** Every stage name a container can have: each provider and the shared skills root. */
const KNOWN_STAGES = new Set<string>([...AGENT_PLATFORMS, "agents-skills"]);
const FILE_KINDS = new Set<ComponentKind>(["skill", "command", "prompt", "subagent"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type LeafRequestKind = "container-staging" | "environment-delivery";

/** What a container is created with (`commands-containers.ts`). */
export interface ContainerStagingInput {
  environmentId: string;
  projectId?: string;
  providers: readonly string[];
  stages: readonly string[];
}

export interface ContainerStaging {
  plan: ContainerCapabilityPlan;
  stage(partialDirectory: string): Promise<ContainerCapabilityRecord>;
}

export interface EnvironmentAuthorityDeps {
  storage: { capabilities: CapabilitiesStorage };
  artifacts: CapabilityArtifactStore;
  selfId(): Promise<string>;
  /** This node follows a command node (`NodeService.isLeaf`). */
  isLeaf(): boolean;
  link(nodeId: string): CapabilityLink | null;
  /** The executor's single-writer epoch check (`CapabilityExecutor.admitEpoch`). */
  admitEpoch(controllerId: string, epoch: number): void;
  /** Leaf: an attached command node was in contact recently enough to answer. */
  controllerReachable(): Promise<boolean>;
  /** Leaf: emits `node-capability-leaf-requested` on this machine's event stream. */
  request?(payload: { requestId: string; kind: LeafRequestKind; request: unknown }): void;
  /** The service's resolution for one target, under no permission ceiling. */
  resolve(state: CapabilityState, target: CapabilityTarget): EffectiveAgentResources;
  /** This machine's environments and its containers' staged records. */
  sources: ScopedTargetSources;
  /** The machines this node controls. */
  machines(): Promise<Array<{ nodeId: string; connected: boolean }>>;
  /** Another machine's environments (federation read model); null when not known. */
  remoteEnvironments?(nodeId: string): Promise<ScopedEnvironment[] | null>;
  now(): string;
}

interface Answered<T> {
  value: T;
  controllerId: string;
  epoch: number;
}

interface PendingRequest {
  kind: LeafRequestKind;
  parse(answer: unknown): unknown;
  /** Runs for every accepted answer, a late one included (the container cache). */
  received?(value: unknown, controllerId: string, epoch: number): void;
  settle(answer: Answered<unknown> | null): void;
}

// --- Peer input ------------------------------------------------------------------

function text(value: unknown, max: number = CAPABILITY_LIMITS.maxIdChars): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function sortedProviders(values: readonly unknown[]) {
  return [...new Set(values.slice(0, 32).filter(isAgentPlatform))].sort();
}

function sortedStages(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values
        .slice(0, 32)
        .filter((value): value is string => typeof value === "string" && KNOWN_STAGES.has(value)),
    ),
  ].sort();
}

/** One cache entry per container target: the environment, its project, providers and stages. */
export function containerTargetKey(input: {
  environmentId: string;
  projectId?: string;
  providers: readonly string[];
  stages: readonly string[];
}): string {
  return sha256(
    canonicalCapabilityJson({
      environmentId: input.environmentId,
      projectId: input.projectId ?? null,
      providers: sortedProviders(input.providers),
      stages: sortedStages(input.stages),
    }),
  );
}

/**
 * The command node's container plan, bounded and rebuilt here: locations
 * come from this machine's own table for the container's stages (a peer
 * never names a directory), only file components are taken, and the digest
 * is computed again over what will be staged.
 */
export function parseContainerPlanAnswer(
  value: unknown,
  input: { providers: readonly string[]; stages: readonly string[] },
): ContainerCapabilityPlan | null {
  const plan = ((value ?? {}) as Record<string, unknown>).plan as
    Record<string, unknown> | undefined;
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.items)) return null;
  const providers = sortedProviders(input.providers);
  const stages = sortedStages(input.stages);
  const table = new Map(
    containerCapabilityLocations(new Set(stages)).map((location) => [location.id, location]),
  );
  const byKey = new Map<string, ContainerCapabilityItem>();
  for (const raw of plan.items.slice(0, MAX_PLAN_ITEMS)) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const location = table.get(text(item.locationId, 128) ?? "");
    const componentId = text(item.componentId);
    const packageId = text(item.packageId);
    const packageDigest = text(item.packageDigest, 200);
    const componentName = text(item.componentName, CAPABILITY_LIMITS.maxNameChars);
    const kind = item.kind as ComponentKind;
    const pathOrKey = typeof item.pathOrKey === "string" ? item.pathOrKey.slice(0, 512) : "";
    const itemProviders = Array.isArray(item.providers)
      ? providers.filter((provider) => (item.providers as unknown[]).includes(provider))
      : [];
    if (
      !location ||
      !componentId ||
      !packageId ||
      !packageDigest ||
      !DIGEST.test(packageDigest) ||
      !componentName ||
      !FILE_KINDS.has(kind) ||
      !kindsFor(kind).includes(location.kind) ||
      itemProviders.length === 0
    ) {
      continue;
    }
    const key = `${location.id}|${componentId}`;
    byKey.set(key, {
      key,
      locationId: location.id,
      relative: location.relative,
      layout: location.layout,
      componentId,
      packageId,
      packageDigest,
      kind,
      componentName,
      pathOrKey,
      providers: itemProviders,
    });
  }
  const items = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  const undeliverable = Array.isArray(plan.undeliverable)
    ? plan.undeliverable.slice(0, MAX_PLAN_ITEMS).flatMap((raw: unknown) => {
        const entry = (raw ?? {}) as Record<string, unknown>;
        const componentId = text(entry.componentId);
        const reason = text(entry.reason, MAX_REASON);
        return isAgentPlatform(entry.provider) && componentId && reason
          ? [{ provider: entry.provider, componentId, reason }]
          : [];
      })
    : [];
  return {
    digest: containerPlanDigest(providers, stages, items),
    providers,
    stages,
    items,
    undeliverable,
  };
}

const DELIVERY_KINDS = new Set(["worktree", "container", "none"]);

/** The command node's environment card, bounded: it is input from a peer. */
function parseDeliveryAnswer(
  value: unknown,
  environmentId: string,
): CapabilityEnvironmentDelivery | null {
  const view = ((value ?? {}) as Record<string, unknown>).view as
    Record<string, unknown> | undefined;
  if (!view || typeof view !== "object" || !Array.isArray(view.items)) return null;
  if (view.environmentId !== environmentId || !DELIVERY_KINDS.has(view.kind as string)) return null;
  const optional = (key: string, max = 200) => {
    const entry = text(view[key], max);
    return entry ? { [key]: entry } : {};
  };
  const items = view.items.slice(0, MAX_CARD_ITEMS).flatMap((raw: unknown) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    const componentId = text(item.componentId);
    const name = text(item.name, CAPABILITY_LIMITS.maxNameChars);
    const packageId = text(item.packageId);
    const status = text(item.status, 64);
    if (!componentId || !name || !packageId || !status) return [];
    const entry: CapabilityEnvironmentDeliveryItem = {
      componentId,
      name,
      kind: (text(item.kind, 64) ?? "skill") as ComponentKind,
      packageId,
      providers: Array.isArray(item.providers) ? item.providers.filter(isAgentPlatform) : [],
      status: status as CapabilityEnvironmentDeliveryItem["status"],
    };
    for (const key of ["locationId", "locationLabel", "installedDigest", "currentDigest"] as const)
      if (text(item[key], 200)) entry[key] = item[key] as string;
    if (text(item.reason, MAX_REASON)) entry.reason = item.reason as string;
    if (Array.isArray(item.alsoVisibleTo))
      entry.alsoVisibleTo = item.alsoVisibleTo.filter(isAgentPlatform);
    return [entry];
  });
  return {
    environmentId,
    kind: view.kind as CapabilityEnvironmentDelivery["kind"],
    stale: view.stale === true,
    ...optional("installedDigest"),
    ...optional("currentDigest"),
    ...optional("stagedAt", 64),
    ...optional("notStagedReason", MAX_REASON),
    ...optional("stagedFromCacheAt", 64),
    ...optional("notice", MAX_REASON),
    items,
  };
}

/** A container's record as it travels: ids, digests, statuses and bounded reasons. */
function wireContainer(evidence: ContainerDeliveryEvidence) {
  return {
    containerId: evidence.containerId,
    labelDigest: evidence.labelDigest,
    record: evidence.record,
  };
}

function containerEvidence(value: unknown): ContainerDeliveryEvidence | null {
  const parsed = parseLeafScopedReport({ container: value })?.container;
  return parsed ? { ...parsed, inputsRevision: "" } : null;
}

/** A component id's own kind and key (`<packageId>#<kind>:<key>`), for a card without names. */
function componentLabel(componentId: string): { name: string; kind: ComponentKind } {
  const local = componentId.slice(componentId.lastIndexOf("#") + 1);
  const colon = local.indexOf(":");
  const kind = colon > 0 ? local.slice(0, colon) : "skill";
  return {
    name: (colon > 0 ? local.slice(colon + 1) : local) || componentId,
    kind: (FILE_KINDS.has(kind as ComponentKind) ? kind : "skill") as ComponentKind,
  };
}

// --- The collaborator --------------------------------------------------------------

export class CapabilityEnvironmentAuthority {
  private readonly pending = new Map<string, PendingRequest>();
  /** How long container creation waits for the command node (tests shorten it). */
  containerAnswerTimeoutMs = CONTAINER_MANIFEST_TIMEOUT_MS;
  /** How long the environment card waits for the command node (tests shorten it). */
  cardAnswerTimeoutMs = ENVIRONMENT_CARD_TIMEOUT_MS;

  constructor(private readonly deps: EnvironmentAuthorityDeps) {}

  private context(): EnvironmentDeliveryContext {
    return {
      storage: this.deps.storage,
      artifacts: this.deps.artifacts,
      selfId: () => this.deps.selfId(),
      resolve: (state, target) => this.deps.resolve(state, target),
      sources: this.deps.sources,
      now: () => this.deps.now(),
    };
  }

  /** The command node, or a machine with none: its own store is the authority. */
  private async isAuthority(): Promise<boolean> {
    if (this.deps.isLeaf()) return false;
    return !handedOverAuthority(await this.deps.storage.capabilities.loadCapabilityState());
  }

  private async ownEnvironment(environmentId: string): Promise<ScopedEnvironment | undefined> {
    const environments = (await this.deps.sources.environments?.().catch(() => [])) ?? [];
    return environments.find((environment) => environment.id === environmentId);
  }

  // --- Leaf: asking the command node ------------------------------------------

  private async ask<T>(
    kind: LeafRequestKind,
    request: unknown,
    timeoutMs: number,
    parse: (answer: unknown) => T | null,
    received?: (value: T, controllerId: string, epoch: number) => void,
  ): Promise<Answered<T> | null> {
    if (!this.deps.request) return null;
    if (!(await this.deps.controllerReachable().catch(() => false))) return null;
    const requestId = `cap_leaf_${randomBytes(12).toString("hex")}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A late answer is still accepted (and a container plan cached) for a while.
        const entry = this.pending.get(requestId);
        if (entry) entry.settle = () => this.pending.delete(requestId);
        setTimeout(() => this.pending.delete(requestId), LATE_ANSWER_MS).unref?.();
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, {
        kind,
        parse,
        ...(received
          ? {
              received: (value, controllerId, epoch) => received(value as T, controllerId, epoch),
            }
          : {}),
        settle: (answer) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          resolve(answer as Answered<T> | null);
        },
      });
      try {
        this.deps.request!({ requestId, kind, request });
      } catch (error) {
        log.warn("leaf-request.failed", { error: formatLogError(error, { message: false }) });
        this.pending.get(requestId)?.settle(null);
      }
    });
  }

  /** `answer_capability_node_request`: only this machine's current authority is heard. */
  async receiveAnswer(args: Record<string, unknown>): Promise<{ accepted: boolean }> {
    const controllerId = text(args.controllerId);
    const requestId = text(args.requestId, 128);
    if (!controllerId || !requestId)
      throw new CapabilityError("invalid-request", "controllerId and requestId are required.");
    this.deps.admitEpoch(controllerId, Number(args.epoch));
    const pending = this.pending.get(requestId);
    if (!pending) return { accepted: false };
    const value = pending.parse(args.answer);
    if (value === null)
      throw new CapabilityError("invalid-request", "The command node's answer is malformed.");
    const epoch = Number(args.epoch);
    pending.received?.(value, controllerId, epoch);
    pending.settle({ value, controllerId, epoch });
    return { accepted: true };
  }

  // --- Container staging -------------------------------------------------------

  /**
   * The manifest a container being created or rebuilt on this machine
   * stages, and the hook that stages it into the partial inputs revision.
   */
  async prepareContainerStaging(input: ContainerStagingInput): Promise<ContainerStaging> {
    if (await this.isAuthority()) {
      return containerStaging(this.context(), {
        environmentId: input.environmentId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        providers: sortedProviders(input.providers),
        stages: input.stages,
      });
    }
    const providers = sortedProviders(input.providers);
    const stages = sortedStages(input.stages);
    const key = containerTargetKey(input);
    const answered = await this.ask(
      "container-staging",
      {
        environmentId: input.environmentId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        providers,
        stages,
      },
      this.containerAnswerTimeoutMs,
      (answer) => parseContainerPlanAnswer(answer, { providers, stages }),
      (plan, controllerId, epoch) =>
        this.rememberPlan(key, input.environmentId, plan, controllerId, epoch),
    );
    if (answered) {
      return this.staging(answered.value, {
        kind: "command-node",
        controllerId: answered.controllerId,
        receivedAt: this.deps.now(),
      });
    }
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const cached = state.leafAuthority?.containers?.[key];
    if (cached && (await this.holdsArtifacts(cached.plan))) {
      log.info("container.staged-from-cache", { environmentId: input.environmentId });
      return this.staging(cached.plan, {
        kind: "cached",
        controllerId: cached.controllerId,
        receivedAt: cached.receivedAt,
      });
    }
    log.warn("container.unstaged", {
      environmentId: input.environmentId,
      code: "command-node-unreachable",
    });
    const plan = unstagedContainerPlan(providers, stages, "command-node-unreachable");
    return {
      plan,
      stage: async () => unstagedContainerRecord(plan, "command-node-unreachable", this.deps.now),
    };
  }

  private staging(
    plan: ContainerCapabilityPlan,
    source: NonNullable<ContainerCapabilityRecord["source"]>,
  ): ContainerStaging {
    return {
      plan,
      stage: async (partialDirectory) => ({
        ...(await stageContainerCapabilities(
          plan,
          this.deps.artifacts,
          partialDirectory,
          this.deps.now,
        )),
        source,
      }),
    };
  }

  private async holdsArtifacts(plan: ContainerCapabilityPlan): Promise<boolean> {
    for (const digest of new Set(plan.items.map((item) => item.packageDigest))) {
      if (!(await this.deps.artifacts.has(digest).catch(() => false))) return false;
    }
    return true;
  }

  private rememberPlan(
    key: string,
    environmentId: string,
    plan: ContainerCapabilityPlan,
    controllerId: string,
    epoch: number,
  ): void {
    const receivedAt = this.deps.now();
    this.deps.storage.capabilities.mutateCapabilityState((state) => {
      const cache = (state.leafAuthority ??= { answers: {} });
      const containers = (cache.containers ??= {});
      containers[key] = {
        key,
        environmentId,
        controllerId,
        epoch,
        receivedAt,
        plan,
      } satisfies LeafContainerPlanRecord;
      const entries = Object.values(containers).sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      );
      for (const stale of entries.slice(MAX_CACHED_CONTAINER_PLANS)) delete containers[stale.key];
      return { result: undefined, changed: true };
    });
  }

  // --- The environment card ------------------------------------------------------

  /**
   * `get_capability_environment_delivery`. The command node answers for its
   * own environments and for those on the machines it controls; a leaf
   * forwards the question about its own environment to its command node.
   */
  async getEnvironmentDelivery(
    args: Record<string, unknown>,
  ): Promise<CapabilityEnvironmentDelivery> {
    const environmentId = text(args.environmentId);
    if (!environmentId) throw new CapabilityError("invalid-request", "environmentId is required.");
    const none: CapabilityEnvironmentDelivery = {
      environmentId,
      kind: "none",
      stale: false,
      items: [],
    };
    const environment = await this.ownEnvironment(environmentId);
    if (await this.isAuthority()) {
      if (environment) return environmentDeliveryView(this.context(), environment);
      return (await this.remoteEnvironmentView(environmentId)) ?? none;
    }
    if (!environment) return none;
    const container =
      environment.environmentType !== "local" && environment.containerId
        ? ((await this.deps.sources.containerDelivery?.(environmentId).catch(() => null)) ?? null)
        : null;
    const answered = await this.ask(
      "environment-delivery",
      {
        environmentId,
        projectId: environment.projectId,
        environmentType: environment.environmentType,
        ...(container ? { container: wireContainer(container) } : {}),
      },
      this.cardAnswerTimeoutMs,
      (answer) => parseDeliveryAnswer(answer, environmentId),
    );
    return answered?.value ?? this.ownView(environment, container);
  }

  /** What this leaf holds for its environment when the command node cannot be asked. */
  private ownView(
    environment: ScopedEnvironment,
    container: ContainerDeliveryEvidence | null,
  ): CapabilityEnvironmentDelivery {
    const base = {
      environmentId: environment.id,
      stale: false,
      notice: COMMAND_NODE_UNREACHABLE_NOTICE,
    };
    if (environment.environmentType === "local") return { ...base, kind: "none", items: [] };
    const record =
      container?.record && container.labelDigest === container.record.digest
        ? container.record
        : null;
    const items = (record?.items ?? [])
      .slice(0, MAX_CARD_ITEMS)
      .map((staged): CapabilityEnvironmentDeliveryItem => ({
        componentId: staged.componentId,
        ...componentLabel(staged.componentId),
        packageId: staged.packageId,
        providers: staged.providers,
        locationId: staged.locationId,
        locationLabel: capabilityLocation(staged.locationId)?.label ?? staged.locationId,
        status: staged.status === "staged" ? "installed-next-session" : "failed",
        installedDigest: staged.packageDigest,
        ...(staged.reason ? { reason: staged.reason } : {}),
      }));
    return {
      ...base,
      kind: environment.containerId ? "container" : "none",
      ...(record ? { installedDigest: record.digest, stagedAt: record.stagedAt } : {}),
      ...(record?.unstaged ? { notStagedReason: CONTAINER_UNSTAGED_SUMMARY } : {}),
      ...(record?.source?.kind === "cached" ? { stagedFromCacheAt: record.source.receivedAt } : {}),
      items,
    };
  }

  /** Command node: an environment on a machine it controls, from its receipts and plan. */
  private async remoteEnvironmentView(
    environmentId: string,
  ): Promise<CapabilityEnvironmentDelivery | null> {
    const selfId = await this.deps.selfId();
    const machines = await this.deps.machines().catch(() => []);
    for (const machine of machines) {
      if (machine.nodeId === selfId) continue;
      const listed = await this.deps.remoteEnvironments?.(machine.nodeId).catch(() => null);
      const environment = listed?.find((entry) => entry.id === environmentId);
      if (!environment) continue;
      if (environment.environmentType === "local") {
        return environmentDeliveryView(this.context(), environment, { nodeId: machine.nodeId });
      }
      const read = await this.readRemoteContainer(machine.nodeId, environmentId);
      const view = await environmentDeliveryView(
        this.context(),
        { ...environment, containerId: read.evidence?.containerId ?? null },
        { nodeId: machine.nodeId, container: read.evidence },
      );
      return read.unknown
        ? {
            ...view,
            notice:
              "That machine could not be asked what is staged in its container; this shows what the current setup would stage.",
          }
        : view;
    }
    return null;
  }

  private async readRemoteContainer(
    nodeId: string,
    environmentId: string,
  ): Promise<{ evidence: ContainerDeliveryEvidence | null; unknown: boolean }> {
    const link = this.deps.link(nodeId);
    if (!link?.connected) return { evidence: null, unknown: true };
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    try {
      const answer = (await link.invokeCommand(getCapabilityNodeContainerDeliveryCommand, {
        controllerId: await this.deps.selfId(),
        epoch: state.epoch,
        environmentId,
      })) as { found?: unknown; container?: unknown } | null;
      if (answer?.found !== true) return { evidence: null, unknown: false };
      return { evidence: containerEvidence(answer.container), unknown: false };
    } catch (error) {
      // Offline, refused, or a machine that predates this command.
      log.warn("environment-card.container-read-failed", {
        error: formatLogError(error, { message: false }),
      });
      return { evidence: null, unknown: true };
    }
  }

  /** `get_capability_node_container_delivery`: one of this machine's containers, for its command node. */
  async containerDeliveryForController(
    args: Record<string, unknown>,
  ): Promise<{ found: boolean; container?: unknown }> {
    const controllerId = text(args.controllerId);
    if (!controllerId) throw new CapabilityError("invalid-request", "controllerId is required.");
    this.deps.admitEpoch(controllerId, Number(args.epoch));
    const environmentId = text(args.environmentId);
    if (!environmentId) throw new CapabilityError("invalid-request", "environmentId is required.");
    const environment = await this.ownEnvironment(environmentId);
    if (!environment) return { found: false };
    const evidence = environment.containerId
      ? await this.deps.sources.containerDelivery?.(environmentId).catch(() => null)
      : null;
    return { found: true, ...(evidence ? { container: wireContainer(evidence) } : {}) };
  }

  // --- Command side ------------------------------------------------------------------

  /**
   * A leaf asked (`node-capability-leaf-requested`): plan its container and
   * stage the artifacts on it before answering, or answer its environment
   * card from this node's receipts.
   */
  async answerLeafRequest(nodeId: string, payload: unknown): Promise<{ answered: boolean }> {
    try {
      return await this.answerLeafRequestNow(nodeId, payload);
    } catch (error) {
      log.warn("leaf-request.answer-failed", { error: formatLogError(error, { message: false }) });
      return { answered: false };
    }
  }

  private async answerLeafRequestNow(
    nodeId: string,
    payload: unknown,
  ): Promise<{ answered: boolean }> {
    if (!(await this.isAuthority())) return { answered: false };
    const record = (payload && typeof payload === "object" ? payload : {}) as Record<
      string,
      unknown
    >;
    const requestId = text(record.requestId, 128);
    const request = (record.request ?? null) as Record<string, unknown> | null;
    const environmentId = request ? text(request.environmentId) : undefined;
    if (!requestId || !request || !environmentId) return { answered: false };
    const link = this.deps.link(nodeId);
    if (!link?.connected) return { answered: false };
    const selfId = await this.deps.selfId();
    const state = await this.deps.storage.capabilities.loadCapabilityState();
    const projectId = text(request.projectId);
    let answer: Record<string, unknown>;
    if (record.kind === "container-staging") {
      const providers = sortedProviders(Array.isArray(request.providers) ? request.providers : []);
      const stages = sortedStages(Array.isArray(request.stages) ? request.stages : []);
      const plan = containerCapabilityPlan(
        state,
        {
          nodeId,
          environmentId,
          ...(projectId ? { projectId } : {}),
          providers,
          stages: new Set(stages),
        },
        (current, target) => this.deps.resolve(current, target),
      );
      // Every artifact the plan names is on the leaf before it is told to stage.
      const transport = remoteTransport({
        selfId: () => this.deps.selfId(),
        link: (id) => this.deps.link(id),
        artifacts: this.deps.artifacts,
      });
      for (const digest of new Set(plan.items.map((item) => item.packageDigest))) {
        await transport.stage(nodeId, state.epoch, digest).catch((error: unknown) => {
          // The leaf records the component as failed: its artifact is not there.
          log.warn("container.artifact-transfer-failed", {
            error: formatLogError(error, { message: false }),
          });
        });
      }
      answer = {
        kind: "container-staging",
        plan: {
          digest: plan.digest,
          providers: plan.providers,
          stages: plan.stages,
          items: plan.items.map((item) => ({
            locationId: item.locationId,
            componentId: item.componentId,
            packageId: item.packageId,
            packageDigest: item.packageDigest,
            kind: item.kind,
            componentName: item.componentName,
            pathOrKey: item.pathOrKey,
            providers: item.providers,
          })),
          undeliverable: plan.undeliverable,
        },
      };
    } else if (record.kind === "environment-delivery") {
      const environmentType = text(request.environmentType, 64);
      if (!projectId || !environmentType) return { answered: false };
      // The leaf's own container: its staged record is its fact, not ours.
      const container =
        environmentType === "local" ? null : containerEvidence(request.container ?? null);
      const view = await environmentDeliveryView(
        this.context(),
        {
          id: environmentId,
          projectId,
          environmentType,
          containerId: container?.containerId ?? null,
        },
        { nodeId, container },
      );
      answer = { kind: "environment-delivery", view };
    } else {
      return { answered: false };
    }
    await link.invokeCommand(answerCapabilityNodeRequestCommand, {
      controllerId: selfId,
      epoch: state.epoch,
      requestId,
      answer: answer as never,
    });
    return { answered: true };
  }
}
