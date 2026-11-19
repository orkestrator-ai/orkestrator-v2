/**
 * Verification and launch preflight for `CapabilityService`
 * (docs/architecture/agent-capabilities-management.md, "Launching a
 * session"). `verify` re-reads a machine's inventory and confirms each
 * component's bytes without running anything. Preflight resolves a native
 * session's frozen effective manifest, blocks a launch whose required
 * components are not verifiably delivered, and records what it launched
 * with. A leaf asks its command node to resolve the launch
 * (`launch-authority.ts`).
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type {
  CapabilityTarget,
  EffectiveAgentResources,
} from "@orkestrator/protocol/capability-resources";
import type { CapabilityVerification } from "@orkestrator/protocol/capability-resources-api";
import { type CapabilityPermissionCeiling } from "@orkestrator/protocol/capability-resources-resolve";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  nativeAgentDeniedCapabilities,
  nativeAgentUserMcpGrant,
} from "@orkestrator/protocol/native-agent";

import {
  permissionCeilingDigest,
  verifyLaunchDeliveries,
  withBlockers,
} from "./launch-authority.js";
import { revisionComponent, scopedRequiredDelivery } from "./scoped-delivery.js";
import {
  pruneSessionPlugins,
  sessionPluginForTurn,
  sessionPluginsRoot,
  stageSessionPlugin,
  withoutPrivateItems,
  type SessionPrivateItem,
  type SessionPrivatePluginRecord,
} from "./session-delivery.js";
import { effectiveReceiptStatus } from "./runtime-evidence.js";
import {
  gradeGrokDiscovery,
  gradeSessionEvidence,
  grokDiscoveredSkills,
  strongerLevel,
  type RuntimeProof,
} from "./runtime-proof.js";
import { CapabilityError } from "./security.js";
import { asRecord, parseTarget, stringList } from "./service-args.js";
import { capabilityLaunchKey, matchingCapabilityLaunch } from "./launch-records.js";
import { inspectCapabilitySession, localCapabilitySessionTarget } from "./session-inspection.js";
import type { CapabilityServiceContext } from "./service-context.js";
import type {
  CapabilityLaunchDelivery,
  CapabilityLaunchRecord,
  CapabilityState,
  InstallationReceipt,
} from "./types.js";

const log = createLogger("capabilities");

export class CapabilityPreflight {
  /** The observed deliveries behind a launch's effective resources, for its record. */
  private readonly launchEvidence = new WeakMap<
    EffectiveAgentResources,
    {
      deliveries: CapabilityLaunchDelivery[];
      resolvedBy?: string;
      /** Components to deliver to this session alone (`session-delivery.ts`). */
      privateItems?: SessionPrivateItem[];
      /** Package ids the session's setups mark required. */
      required?: ReadonlySet<string>;
    }
  >();

  constructor(private readonly ctx: CapabilityServiceContext) {}

  /**
   * Non-destructive checks with the user's consent: re-reads the machine's
   * inventory and confirms each component's bytes at its location. It never
   * starts an MCP server, runs a script or touches a session.
   */
  async verify(args: Record<string, unknown>): Promise<CapabilityVerification> {
    if (args.consent !== true) {
      throw new CapabilityError(
        "approval-required",
        "Testing reads the machine's configuration; confirm to continue.",
      );
    }
    const selfId = await this.ctx.deps.selfId();
    const requested = parseTarget(args.target, selfId);
    const componentIds = stringList(args.componentIds, 200);
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const { target, launch, evidence, remote } = await inspectCapabilitySession(
      this.ctx,
      state,
      requested,
      componentIds,
    );
    const local = target.nodeId === selfId;
    const inventory =
      target.environmentIncarnation === undefined
        ? await this.ctx.observeNode(target.nodeId).catch(() => undefined)
        : undefined;
    const remoteProofs = new Map(remote?.checks.map((check) => [check.componentId, check]));
    // What the provider itself reported: never inferred from what was sent.
    const proofs = local
      ? await this.sessionProofs(target, launch, componentIds, state)
      : new Map<string, RuntimeProof>();
    const checks: CapabilityVerification["checks"] = [];
    const matching = new Set<string>();
    const grokReceipts = new Map<number, InstallationReceipt>();
    for (const componentId of componentIds) {
      const receipts = Object.values(state.receipts).filter(
        (receipt) =>
          receipt.nodeId === target.nodeId &&
          receipt.componentId === componentId &&
          receipt.providers.includes(target.provider) &&
          receipt.environmentId === undefined &&
          receipt.accountHomeId === undefined &&
          (!target.accountHomeId ||
            (evidence?.account !== undefined &&
              [undefined, "linked", "missing"].includes(
                evidence.account.entries[receipt.locationId],
              ))),
      );
      const privateItem = launch?.privatePlugin?.items.find(
        (entry) => entry.componentId === componentId,
      );
      if (privateItem) {
        const proof = proofs.get(componentId);
        checks.push(
          proof
            ? { componentId, level: proof.level, status: proof.status, detail: proof.detail }
            : {
                componentId,
                level: "present",
                status: "installed-next-session",
                detail:
                  "Delivered to this session alone. The session has not reported loading it yet, so loading is not confirmed.",
              },
        );
        continue;
      }
      const remoteProof = remoteProofs.get(componentId);
      if (remoteProof) {
        checks.push(remoteProof);
        continue;
      }
      const staged = evidence?.container?.record?.items.find(
        (item) =>
          item.componentId === componentId &&
          item.providers.includes(target.provider) &&
          item.status === "staged",
      );
      const scopedReceipt = Object.values(state.receipts).find(
        (receipt) =>
          receipt.nodeId === target.nodeId &&
          receipt.providers.includes(target.provider) &&
          receipt.componentId === componentId &&
          ((evidence?.project && receipt.environmentId === evidence.project.environmentId) ||
            (evidence?.account &&
              receipt.accountHomeId === evidence.account.accountHomeId &&
              evidence.account.entries[receipt.locationId] === "private")),
      );
      const component = state.components[componentId];
      const frozen = launch?.packages.find(
        (pkg) => pkg.id === (component?.packageId ?? staged?.packageId),
      );
      const revision =
        staged?.packageDigest ??
        scopedReceipt?.packageDigest ??
        frozen?.artifactDigest ??
        (component ? state.packages[component.packageId]?.artifactDigest : undefined);
      const scoped = revision
        ? scopedRequiredDelivery({
            state,
            target,
            ...(evidence ? { evidence } : {}),
            component: { id: componentId, name: component?.name ?? componentId },
            digest: revision,
          })
        : undefined;
      if (scoped?.kind === "verified") {
        checks.push({
          componentId,
          level: "present",
          status: "installed-next-session",
          detail: "The files match the revision delivered to this target.",
        });
        if (scoped.exclusive || receipts.length === 0) continue;
      } else if (scopedReceipt) {
        checks.push({
          componentId,
          level: "requested",
          status: "drifted",
          detail: "The scoped copy could not be verified against its receipt.",
        });
        if (receipts.length === 0) continue;
      } else if (scoped?.kind === "refused" || target.environmentIncarnation !== undefined) {
        checks.push({
          componentId,
          level: "requested",
          status: "pending",
          detail:
            scoped?.kind === "refused"
              ? scoped.reason
              : "No matching revision was staged into this container.",
        });
        continue;
      }
      if (receipts.length === 0) {
        checks.push({
          componentId,
          level: "requested",
          status: "pending",
          detail: "Not installed for this agent on this machine yet.",
        });
        continue;
      }
      for (const receipt of receipts) {
        const item = inventory?.items.find(
          (entry) =>
            entry.componentId === componentId &&
            entry.locationId === receipt.locationId &&
            entry.packageId === receipt.packageId,
        );
        const effective = effectiveReceiptStatus(receipt);
        const matches = item && !item.drifted && item.digest === receipt.digest;
        if (matches) {
          matching.add(receipt.id);
          if (target.provider === "grok") grokReceipts.set(checks.length, receipt);
        }
        const fileKind =
          !receipt.locationId.startsWith("mcp:") && !receipt.locationId.startsWith("plugin:");
        const proof = matches ? proofs.get(componentId) : undefined;
        checks.push({
          componentId,
          level: proof
            ? strongerLevel(effective.verification, proof.level)
            : effective.verification,
          status:
            !matches &&
            (effective.status === "ready" || effective.status === "installed-next-session")
              ? "drifted"
              : effective.status,
          detail: proof
            ? proof.detail
            : fileKind
              ? item
                ? !matches
                  ? "The files are present but have local changes."
                  : effective.verification === "unverified"
                    ? "The files are present. This agent reports no live inventory, so loading cannot be confirmed until it is used."
                    : "The files are present and match the installed revision."
                : "The files are missing from the machine."
              : matches
                ? "The managed definition matches the recorded revision."
                : "The managed definition could not be verified.",
        });
      }
    }
    if (local && grokReceipts.size > 0) {
      const grok = await this.grokProofs(Array.from(grokReceipts.values()), matching, state);
      for (const [index, receipt] of grokReceipts) {
        const check = checks[index]!;
        const proof = grok.get(check.componentId);
        if (!proof || proof.receiptId !== receipt.id) continue;
        check.level = strongerLevel(check.level, proof.level);
        check.detail = proof.detail;
        proofs.set(check.componentId, proof);
      }
    }
    this.recordObservations(target, proofs);
    return { target, checks, verifiedAt: this.ctx.now() };
  }

  /** Read-only session evidence for this machine's command node. */
  async inspectOwnedSession(environmentId: unknown, value: unknown) {
    const args = asRecord(value, "capabilitySession");
    const selfId = await this.ctx.deps.selfId();
    const requested = parseTarget(args.requested, selfId);
    if (
      !requested.sessionId ||
      !requested.environmentId ||
      requested.environmentId !== environmentId ||
      requested.nodeId !== selfId
    ) {
      throw new CapabilityError("invalid-request", "The session does not belong to this target.");
    }
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const launch = matchingCapabilityLaunch(state, requested);
    const target = await localCapabilitySessionTarget(this.ctx, requested, launch);
    const frozen =
      launch?.target.environmentIncarnation === target.environmentIncarnation ? launch : undefined;
    const privateIds = new Set(frozen?.privatePlugin?.items.map((item) => item.componentId));
    const componentIds = stringList(args.componentIds, 200).filter((id) => privateIds.has(id));
    const [scoped, account, proofs] = await Promise.all([
      this.ctx.remoteScoped.leafReport(target),
      target.accountHomeId
        ? this.ctx.scoped.readEvidence(target).then((item) => item?.account)
        : undefined,
      componentIds.length > 0
        ? this.sessionProofs(target, frozen, componentIds, state)
        : new Map<string, RuntimeProof>(),
    ]);
    const checks = componentIds.map((componentId) => {
      const proof = proofs.get(componentId);
      return {
        componentId,
        level: proof?.level ?? "present",
        status: proof?.status ?? "installed-next-session",
        detail: proof?.detail ?? "Delivered to this session alone. Loading is unconfirmed.",
      };
    });
    return {
      target,
      scoped,
      checks,
      ...(account
        ? { account: { entries: account.entries, observed: Object.fromEntries(account.observed) } }
        : {}),
    };
  }

  async prunePrivatePlugins(): Promise<void> {
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const referenced = new Set(
      Object.values(state.launches).flatMap(({ privatePlugin }) =>
        privatePlugin ? [privatePlugin.digest] : [],
      ),
    );
    await pruneSessionPlugins(sessionPluginsRoot(this.ctx.deps.dataDir), referenced);
  }

  /** A Claude session's own report, graded (`runtime-proof.ts`); empty without one. */
  private async sessionProofs(
    target: CapabilityTarget,
    launch: CapabilityLaunchRecord | undefined,
    componentIds: readonly string[],
    state: CapabilityState,
  ): Promise<Map<string, RuntimeProof>> {
    const read = this.ctx.deps.sessionEvidence;
    if (!read || !target.sessionId || !target.environmentId) return new Map();
    const evidence = await read({
      environmentId: target.environmentId,
      provider: target.provider,
      sessionKey: target.sessionId,
    }).catch(() => ({ state: "none" }) as const);
    if (evidence.state !== "evidence") return new Map();
    return gradeSessionEvidence({ launch, evidence, componentIds, state });
  }

  /** Grok's own discovery listing on this machine, graded; empty when it cannot say. */
  private async grokProofs(
    receipts: readonly InstallationReceipt[],
    matching: ReadonlySet<string>,
    state: CapabilityState,
  ): Promise<Map<string, RuntimeProof>> {
    const cli = this.ctx.deps.providerCli?.("grok");
    if (!cli) return new Map();
    try {
      const discovered = await grokDiscoveredSkills(cli);
      if (!discovered) return new Map();
      return gradeGrokDiscovery({
        receipts,
        matching,
        discovered,
        homes: this.ctx.deps.homes(),
        state,
      });
    } catch (error) {
      log.warn("service.grok-discovery-failed", {
        error: formatLogError(error, { message: false }),
      });
      return new Map();
    }
  }

  /** Keeps the runtime evidence a check found, bounded by the store's observation limit. */
  private recordObservations(target: CapabilityTarget, proofs: ReadonlyMap<string, RuntimeProof>) {
    if (proofs.size === 0) return;
    const now = this.ctx.now();
    try {
      this.ctx.deps.storage.capabilities.mutateCapabilityState((current) => {
        for (const proof of proofs.values()) {
          const id = `${target.nodeId}|${target.provider}|${target.sessionId ?? "machine"}|${proof.componentId}`;
          current.observations[id] = {
            id,
            target,
            componentId: proof.componentId,
            level: proof.level,
            source: proof.source,
            ...(proof.generation ? { generation: proof.generation } : {}),
            observedAt: now,
          };
        }
        return { result: undefined, changed: true };
      });
    } catch (error) {
      log.warn("service.observation-record-failed", {
        error: formatLogError(error, { message: false }),
      });
    }
  }

  /**
   * Launch preflight for a native agent session: resolves the frozen
   * effective manifest. A required component that is missing, unsupported or
   * blocked stops the launch with the reason; optional ones are warnings.
   */
  async preflightLaunch(input: {
    target: CapabilityTarget;
    sessionKey: string;
    ceiling: CapabilityPermissionCeiling;
    templateId?: string;
    graphNode?: string;
    relativeWorktree?: string;
    readOnly?: boolean;
  }): Promise<EffectiveAgentResources> {
    // A leaf's store holds no setups: its command node resolves the launch.
    if (!this.ctx.deps.isAuthority() && input.target.nodeId === (await this.ctx.deps.selfId())) {
      const answer = await this.ctx.leafLaunch.preflight(input);
      const privateItems = answer.privateItems ?? [];
      const required = new Set(answer.privateRequired ?? []);
      const effective = input.readOnly
        ? withoutPrivateItems(
            answer.effective,
            privateItems,
            "Private plugins are unavailable on read-only turns.",
            required,
          )
        : answer.effective;
      this.launchEvidence.set(effective, {
        deliveries: answer.deliveries,
        ...(answer.resolvedBy ? { resolvedBy: answer.resolvedBy } : {}),
        ...(!input.readOnly && privateItems.length > 0 ? { privateItems, required } : {}),
      });
      return effective;
    }
    const resolveInput = {
      target: input.target,
      sessionKey: input.sessionKey,
      ...(input.templateId ? { templateId: input.templateId } : {}),
      ...(input.graphNode ? { graphNode: input.graphNode } : {}),
      ceiling: input.ceiling,
    };
    const launchInventory = await this.ctx.observeNode(input.target.nodeId).catch(() => undefined);
    const scopedEvidence = await this.ctx.scoped
      .launchEvidence(input.target, input.relativeWorktree, (state) =>
        this.ctx.resolveFor(state, {
          ...resolveInput,
          ...(launchInventory ? { launchInventory } : {}),
        }),
      )
      .catch(() => undefined);
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    let required: ReadonlySet<string> = new Set();
    // Only this machine's own launches: the plugin is staged from this node's artifacts.
    const privateItems: SessionPrivateItem[] = [];
    const local = input.target.nodeId === (await this.ctx.deps.selfId());
    const resolved = this.ctx.resolveFor(state, {
      ...resolveInput,
      captureRequired: (ids) => {
        required = ids;
      },
      ...(local && !input.readOnly
        ? {
            privateDelivery: {
              deliverable: () => true,
              capture: (item: SessionPrivateItem) => privateItems.push(item),
            },
          }
        : {}),
      forLaunch: true,
      ...(launchInventory ? { launchInventory } : {}),
      ...(scopedEvidence ? { scopedEvidence } : {}),
    });
    // Every copy of a required package the provider reads must hold the recorded bytes.
    const checked = verifyLaunchDeliveries({
      state,
      effective: resolved,
      inventory: launchInventory,
      required,
      ...(scopedEvidence ? { scopedEvidence } : {}),
    });
    const effective = withBlockers(resolved, checked.blockers);
    this.launchEvidence.set(effective, {
      deliveries: checked.deliveries,
      ...(privateItems.length > 0 ? { privateItems, required } : {}),
    });
    return effective;
  }

  /**
   * Stages the components a launch delivers to its session alone. A required
   * one that cannot be staged stops the launch; an optional one is dropped
   * from the manifest with a warning, never reported delivered.
   */
  private async stagePrivateDelivery(effective: EffectiveAgentResources): Promise<{
    effective: EffectiveAgentResources;
    record?: SessionPrivatePluginRecord;
  }> {
    const evidence = this.launchEvidence.get(effective);
    const delivered = new Set(
      effective.resolvedPackages.flatMap((pkg) =>
        pkg.components.map((componentId) => `${pkg.id}|${componentId}|${pkg.artifactDigest}`),
      ),
    );
    const seen = new Set<string>();
    const items = (evidence?.privateItems ?? []).filter((item) => {
      const key = `${item.packageId}|${item.componentId}|${item.packageDigest}`;
      if (!delivered.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (items.length === 0) return { effective };
    try {
      const staged = await stageSessionPlugin({
        root: sessionPluginsRoot(this.ctx.deps.dataDir),
        items,
        artifacts: this.ctx.artifacts,
      });
      return { effective, record: staged.record };
    } catch (error) {
      const reason =
        error instanceof CapabilityError
          ? error.message
          : "The session's capability files could not be prepared.";
      log.warn("service.private-delivery-failed", {
        error: formatLogError(error, { message: false }),
      });
      const required = evidence?.required ?? new Set<string>();
      const requiredItem = items.find((item) => required.has(item.packageId));
      if (requiredItem) {
        throw new CapabilityError(
          "approval-required",
          `This session's setups require a capability it cannot have: ${requiredItem.name}: ${reason} Change the session's setups in Capabilities, or mark the component optional.`,
        );
      }
      const narrowed = withoutPrivateItems(effective, items, reason, required);
      if (evidence) this.launchEvidence.set(narrowed, { ...evidence, privateItems: [] });
      return { effective: narrowed };
    }
  }

  /**
   * The plugin directories a session's turns pass: its private plugin from
   * the launch record, re-staged when it went missing. Empty for a session
   * launched without one.
   */
  async sessionPlugins(
    sessionKey: string,
    environmentId: string,
    provider: AgentPlatform,
  ): Promise<string[]> {
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const record = matchingCapabilityLaunch(state, {
      nodeId: await this.ctx.deps.selfId(),
      environmentId,
      provider,
      sessionId: sessionKey,
    })?.privatePlugin;
    if (!record) return [];
    const directory = await sessionPluginForTurn({
      root: sessionPluginsRoot(this.ctx.deps.dataDir),
      record,
      state,
      artifacts: this.ctx.artifacts,
      resolveItem: (entry) => {
        const component = revisionComponent(
          state,
          entry.packageId,
          entry.componentId,
          entry.packageDigest,
        );
        return component
          ? {
              packageId: entry.packageId,
              packageDigest: entry.packageDigest,
              componentId: entry.componentId,
              kind: component.kind,
              name: component.name,
              pathOrKey: component.pathOrKey,
            }
          : undefined;
      },
    });
    return [directory];
  }

  /**
   * The native-session and graph launch hook. Resolves resources under the
   * launch policy, blocks unverified required delivery, and records the
   * selected revision digest for diagnostics. Provider homes stay shared.
   */
  async preflightSession(input: {
    environmentId: string;
    projectId?: string;
    environmentIncarnation?: string;
    accountHomeId?: string;
    templateId?: string;
    graphNode?: string;
    relativeWorktree?: string;
    provider: AgentPlatform;
    sessionKey: string;
    policy?: Parameters<typeof nativeAgentDeniedCapabilities>[0] & { id?: string };
    readOnly?: boolean;
  }): Promise<EffectiveAgentResources | null> {
    let effective: EffectiveAgentResources;
    try {
      const readOnly = input.readOnly === true || input.policy?.id === "coordinator-read-only";
      const denied = nativeAgentDeniedCapabilities(input.policy);
      const grant = nativeAgentUserMcpGrant(input.policy);
      const ceiling: CapabilityPermissionCeiling = {
        denied,
        userMcpServers: grant ?? null,
        digest: permissionCeilingDigest(denied, grant ?? null, readOnly),
      };
      effective = await this.preflightLaunch({
        target: {
          nodeId: await this.ctx.deps.selfId(),
          provider: input.provider,
          environmentId: input.environmentId,
          ...(input.environmentIncarnation
            ? { environmentIncarnation: input.environmentIncarnation }
            : {}),
          ...(input.accountHomeId ? { accountHomeId: input.accountHomeId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          sessionId: input.sessionKey,
        },
        sessionKey: input.sessionKey,
        ...(input.templateId ? { templateId: input.templateId } : {}),
        ...(input.graphNode ? { graphNode: input.graphNode } : {}),
        ...(input.relativeWorktree ? { relativeWorktree: input.relativeWorktree } : {}),
        ceiling,
        ...(readOnly ? { readOnly } : {}),
      });
    } catch (error) {
      log.warn("service.preflight-failed", { error: formatLogError(error, { message: false }) });
      throw error;
    }
    if (effective.launchBlockers.length > 0) {
      const first = effective.launchBlockers[0]!;
      throw new CapabilityError(
        "approval-required",
        `This session's setups require a capability it cannot have: ${first.reason} Change the session's setups in Capabilities, or mark the component optional.`,
      );
    }
    const staged = await this.stagePrivateDelivery(effective);
    effective = staged.effective;
    try {
      this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
        state.launches[capabilityLaunchKey(effective.target, input.sessionKey)] = {
          sessionKey: input.sessionKey,
          target: effective.target,
          manifestDigest: effective.manifestDigest,
          permissionPolicyDigest: effective.permissionPolicyDigest,
          packages: effective.resolvedPackages.map((entry) => ({
            id: entry.id,
            artifactDigest: entry.artifactDigest,
          })),
          ...launchRecordEvidence(this.launchEvidence.get(effective)),
          ...(staged.record ? { privatePlugin: staged.record } : {}),
          launchedAt: this.ctx.now(),
        };
        return { result: undefined, changed: true };
      });
    } catch (error) {
      log.warn("service.launch-record-failed", {
        error: formatLogError(error, { message: false }),
      });
      if (staged.record) {
        throw new CapabilityError(
          "source-unavailable",
          "The session's private capabilities could not be recorded. Retry the launch.",
        );
      }
    }
    return effective;
  }
}

/** The fields of a launch's evidence its record keeps. */
function launchRecordEvidence(
  evidence: { deliveries: CapabilityLaunchDelivery[]; resolvedBy?: string } | undefined,
): { deliveries?: CapabilityLaunchDelivery[]; resolvedBy?: string } {
  if (!evidence) return {};
  return {
    deliveries: evidence.deliveries,
    ...(evidence.resolvedBy ? { resolvedBy: evidence.resolvedBy } : {}),
  };
}
