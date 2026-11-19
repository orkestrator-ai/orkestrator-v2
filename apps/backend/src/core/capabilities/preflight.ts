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
    { deliveries: CapabilityLaunchDelivery[]; resolvedBy?: string }
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
  }): Promise<EffectiveAgentResources> {
    // A leaf's store holds no setups: its command node resolves the launch.
    if (!this.ctx.deps.isAuthority() && input.target.nodeId === (await this.ctx.deps.selfId())) {
      const answer = await this.ctx.leafLaunch.preflight(input);
      this.launchEvidence.set(answer.effective, {
        deliveries: answer.deliveries,
        ...(answer.resolvedBy ? { resolvedBy: answer.resolvedBy } : {}),
      });
      return answer.effective;
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
    const resolved = this.ctx.resolveFor(state, {
      ...resolveInput,
      captureRequired: (ids) => {
        required = ids;
      },
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
    this.launchEvidence.set(effective, { deliveries: checked.deliveries });
    return effective;
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
    policy?: Parameters<typeof nativeAgentDeniedCapabilities>[0];
  }): Promise<EffectiveAgentResources | null> {
    let effective: EffectiveAgentResources;
    try {
      const denied = nativeAgentDeniedCapabilities(input.policy);
      const grant = nativeAgentUserMcpGrant(input.policy);
      const ceiling: CapabilityPermissionCeiling = {
        denied,
        userMcpServers: grant ?? null,
        digest: sha256(
          canonicalCapabilityJson({ denied: [...denied].sort(), grant: grant ?? null }),
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
          ...this.launchEvidence.get(effective),
          launchedAt: this.ctx.now(),
        };
        return { result: undefined, changed: true };
      });
    } catch (error) {
      log.warn("service.launch-record-failed", {
        error: formatLogError(error, { message: false }),
      });
    }
    return effective;
  }
}
