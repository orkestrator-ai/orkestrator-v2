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
import {
  canonicalCapabilityJson,
  type CapabilityPermissionCeiling,
} from "@orkestrator/protocol/capability-resources-resolve";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import {
  nativeAgentDeniedCapabilities,
  nativeAgentUserMcpGrant,
} from "@orkestrator/protocol/native-agent";

import { verifyLaunchDeliveries, withBlockers } from "./launch-authority.js";
import { sha256 } from "./planning.js";
import { revisionComponent } from "./scoped-delivery.js";
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
import { CapabilityError } from "./security.js";
import { parseTarget, stringList } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import type { CapabilityLaunchDelivery } from "./types.js";

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
    const target = parseTarget(args.target, await this.ctx.deps.selfId());
    const componentIds = stringList(args.componentIds, 200);
    const inventory = await this.ctx.observeNode(target.nodeId);
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const checks: CapabilityVerification["checks"] = [];
    for (const componentId of componentIds) {
      const receipts = Object.values(state.receipts).filter(
        (receipt) =>
          receipt.nodeId === target.nodeId &&
          receipt.componentId === componentId &&
          receipt.providers.includes(target.provider),
      );
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
          (entry) => entry.componentId === componentId && entry.locationId === receipt.locationId,
        );
        const effective = effectiveReceiptStatus(receipt);
        const matches = item && !item.drifted && item.digest === receipt.digest;
        const fileKind =
          !receipt.locationId.startsWith("mcp:") && !receipt.locationId.startsWith("plugin:");
        checks.push({
          componentId,
          level: effective.verification,
          status:
            !matches &&
            (effective.status === "ready" || effective.status === "installed-next-session")
              ? "drifted"
              : effective.status,
          detail: fileKind
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
    return { target, checks, verifiedAt: this.ctx.now() };
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
  async sessionPlugins(sessionKey: string): Promise<string[]> {
    const state = await this.ctx.deps.storage.capabilities.loadCapabilityState();
    const record = state.launches[sessionKey]?.privatePlugin;
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
        digest: sha256(
          canonicalCapabilityJson({
            denied: [...denied].sort(),
            grant: grant ?? null,
            ...(readOnly ? { readOnly } : {}),
          }),
        ),
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
      throw new CapabilityError(
        "source-unavailable",
        "The session’s capabilities could not be verified. Try again after reconnecting the machine.",
      );
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
    let referenced: Set<string> | undefined;
    try {
      this.ctx.deps.storage.capabilities.mutateCapabilityState((state) => {
        state.launches[input.sessionKey] = {
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
        referenced = new Set(
          Object.values(state.launches).flatMap((launch) =>
            launch.privatePlugin ? [launch.privatePlugin.digest] : [],
          ),
        );
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
    if (referenced) {
      void pruneSessionPlugins(sessionPluginsRoot(this.ctx.deps.dataDir), referenced);
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
