/**
 * This machine's executor commands, called by its command node over the node
 * link (docs/architecture/agent-capabilities-management.md, "Authority").
 * Every call names the controller and its epoch; `CapabilityExecutor`
 * refuses an older authority before anything is read or written.
 */
import type { CapabilityInventory } from "@orkestrator/protocol/capability-resources-api";

import { parseNodePlanTargets } from "./executor.js";
import { MAX_CAPABILITY_INVENTORY_ITEMS } from "./inventory.js";
import type { CapabilityPreflight } from "./preflight.js";
import { asText, stringList } from "./service-args.js";
import type { CapabilityServiceContext } from "./service-context.js";
import { assertDistributableArtifact } from "./source-inspection.js";

export class CapabilityExecutorHandlers {
  constructor(
    private readonly ctx: CapabilityServiceContext,
    private readonly preflight: CapabilityPreflight,
  ) {}

  private admit(args: Record<string, unknown>): void {
    this.ctx.executor.admitEpoch(asText(args.controllerId, "controllerId"), Number(args.epoch));
  }

  private fence(args: Record<string, unknown>): () => Promise<void> {
    const controllerId = asText(args.controllerId, "controllerId");
    const epoch = Number(args.epoch);
    return () => this.ctx.executor.assertEpoch(controllerId, epoch);
  }

  /** `get_capability_node_observation`: this machine's inventory. */
  async observe(args: Record<string, unknown>): Promise<CapabilityInventory> {
    this.admit(args);
    const launch = args.launch === true;
    const managedPluginComponents = stringList(
      args.managedPluginComponents,
      MAX_CAPABILITY_INVENTORY_ITEMS,
      (id) => id.length <= 256,
    );
    const pluginListingScope =
      launch && managedPluginComponents.length > 0 && typeof args.launchRequestId === "string"
        ? this.ctx.leafLaunch.expectManagedPluginEvidence(args.launchRequestId)
        : undefined;
    return this.ctx.observeSelf({
      launch,
      refresh: args.refresh === true,
      managedPluginComponents,
      pluginListingScope,
    });
  }

  /** `stage_capability_node_artifact`: one chunk of a package artifact. */
  async stage(args: Record<string, unknown>): Promise<{ complete: boolean; missing: number[] }> {
    this.admit(args);
    const data = typeof args.data === "string" ? args.data : "";
    return this.ctx.artifacts.stageChunk(
      asText(args.digest, "digest"),
      Number(args.index),
      Number(args.count),
      data,
    );
  }

  /** `apply_capability_node_plan`: this machine's share of a plan. */
  async apply(args: Record<string, unknown>): Promise<{ results: unknown[] }> {
    this.admit(args);
    const targets = parseNodePlanTargets(args.targets);
    return { results: await this.ctx.executor.apply(targets, this.fence(args)) };
  }

  /** `get_capability_node_environment_observation`: this machine's worktrees, for its command node. */
  async observeEnvironments(args: Record<string, unknown>) {
    this.admit(args);
    if (Array.isArray(args.environments) && args.environments.length === 1) {
      const entry = args.environments[0];
      if (entry && typeof entry === "object" && entry.capabilitySession) {
        await this.fence(args)();
        const capabilitySession = await this.preflight.inspectOwnedSession(
          entry.environmentId,
          entry.capabilitySession,
        );
        return { environments: [], capabilitySession };
      }
    }
    return this.ctx.remoteScoped.observeForController(args);
  }

  /** `apply_capability_node_environment_plan`: a project setup into one worktree here. */
  async applyEnvironmentPlan(args: Record<string, unknown>) {
    this.admit(args);
    return this.ctx.remoteScoped.applyForController(args, this.fence(args));
  }

  /** `export_capability_node_item`: one installed item's files, for adoption on the command node. */
  async exportItem(
    args: Record<string, unknown>,
  ): Promise<{ files: Array<{ path: string; executable: boolean; data: string }> }> {
    this.admit(args);
    const files = await this.ctx.drift.exportLocalItem(asText(args.itemId, "itemId"));
    assertDistributableArtifact(files);
    return {
      files: files.map((file) => ({
        path: file.path,
        executable: file.executable,
        data: file.content.toString("base64"),
      })),
    };
  }
}
