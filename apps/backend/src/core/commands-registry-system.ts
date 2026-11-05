import { MACHINE_LOAD_COMMAND } from "@orkestrator/protocol/machine-load";
import { APP_VERSION } from "./constants.js";
import { asString, assertOnlyKeys } from "./commands-validation.js";
import { diagnosticsSources } from "./diagnostics-sources.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  readEnvironmentProcessUsage as defaultReadEnvironmentProcessUsage,
  type EnvironmentProcessUsageSnapshot,
  type ProcessUsageEnvironment,
} from "./environment-process-usage.js";
import {
  createSystemUsageReader,
  hostRamReader,
  type SystemUsageSnapshot,
} from "./system-usage.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { recurringWorkDiagnostics } from "./recurring-diagnostics.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import type { KeyedWorkflowOwner } from "./workflow-supervisor.js";

export function registerSystemCommands(
  register: CommandRegistrar,
  readSystemUsage?: (diskPath: string) => Promise<SystemUsageSnapshot>,
  readEnvironmentProcessUsage?: (
    environments: ProcessUsageEnvironment[],
  ) => Promise<EnvironmentProcessUsageSnapshot>,
): void {
  const readUsage = readSystemUsage ?? createSystemUsageReader({ ramReader: hostRamReader });
  const readProcesses = readEnvironmentProcessUsage ?? defaultReadEnvironmentProcessUsage;
  register("get_app_version", (args) => {
    assertOnlyKeys(args, [], "arguments");
    return APP_VERSION;
  });
  register("get_system_usage", (_args, context) => readUsage(context.storage.getDataDir()));
  // Answered from the sampler's history, with no I/O, so it costs a coordinator
  // one round trip per machine. Read by `list_nodes`, here and over the node link.
  register(MACHINE_LOAD_COMMAND, (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    if (!context.machineLoad) throw new Error("Machine load sampling is not running here.");
    return context.machineLoad.report();
  });
  // Every client's open process panel asks for the same thing: the child
  // processes of every running environment. A read already in flight is
  // joined rather than repeated; nothing completed is cached, so a later
  // request always enumerates afresh (CPU figures are point samples).
  let pendingProcessRead: Promise<EnvironmentProcessUsageSnapshot> | null = null;
  register("get_environment_process_usage", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    recurringWorkMetrics.requested("process-usage");
    if (pendingProcessRead) {
      recurringWorkMetrics.coalesced("process-usage");
      return pendingProcessRead;
    }
    const read = recurringWorkMetrics.observe("process-usage", async () =>
      readProcesses(await context.storage.loadEnvironments()),
    );
    pendingProcessRead = read;
    const clear = () => {
      if (pendingProcessRead === read) pendingProcessRead = null;
    };
    void read.then(clear, clear);
    return read;
  });
  /**
   * Bounded, content-free recurring-work diagnostics: per-kind counters, active
   * attempts and worst ages, plus scheduler and admission-pool status. Reading
   * it performs no I/O. Also served additively on the gateway's `/__orkestrator/metrics`.
   */
  register("get_recurring_work_diagnostics", (args) => {
    assertOnlyKeys(args, [], "arguments");
    return recurringWorkDiagnostics();
  });
  /**
   * Content-free usage of each mixed-version compatibility path: a count and
   * the first and last time it was taken, persisted across restarts. Retiring
   * a path rests on this (`docs/architecture/version-compatibility.md`). Also
   * served additively on the gateway's `/__orkestrator/metrics`.
   */
  register("get_compatibility_path_usage", (args) => {
    assertOnlyKeys(args, [], "arguments");
    return compatibilityPathUsage.snapshot();
  });
  /**
   * Database size, free pages, backups and retention of both databases, from
   * the summary `/__orkestrator/metrics` reads, and lease waits per family.
   */
  register("get_database_stats", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    if (!context.diagnostics) throw new Error("Database figures are not available here.");
    return context.diagnostics.databaseStats();
  });
  /**
   * Bounded, content-free timings of the last progressive reads per domain. They
   * have no other record, and a read that reaches this only reads memory.
   */
  register("get_progressive_read_metrics", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    if (!context.nativeAgents) throw new Error("Native agents are not available here.");
    return { samples: context.nativeAgents.progressiveReadSamples() };
  });
  /** Content-free transcript artifact counters; an empty set where artifacts do not run. */
  register("get_artifact_metrics", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return context.transcriptArtifacts?.metrics.snapshot() ?? { counters: {}, droppedSeries: 0 };
  });
  /**
   * Builds a diagnostics bundle and holds it in memory, answering with the
   * manifest that is byte for byte the bundle's own. Nothing reaches the disk
   * or the network here; {@link read_diagnostics_bundle} hands the bytes to the
   * client that asked. Refused to workspace clients (`workspace-grant-scope.ts`).
   */
  register("plan_diagnostics_bundle", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    if (!context.diagnostics) throw new Error("Diagnostics are not available here.");
    return context.diagnostics.bundles.plan(() => diagnosticsSources(context));
  });
  register("read_diagnostics_bundle", (args, context) => {
    assertOnlyKeys(args, ["planId", "offset"], "arguments");
    if (!context.diagnostics) throw new Error("Diagnostics are not available here.");
    return context.diagnostics.bundles.read(asString(args.planId, "planId"), Number(args.offset));
  });
  /**
   * Full diagnostic reconciliation for keyed scheduling (step 08). Every keyed
   * owner re-reads authoritative storage now, independent of its safety
   * cadence, and reports content-free counts: obligations by kind, wakes by
   * reason, what the pass recovered or dropped. Safe to call at any time.
   */
  register("reconcile_workflow_scheduling", async (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    const owners: [string, KeyedWorkflowOwner | undefined][] = [
      ["feature-planning", context.featurePlanning],
      ["build-pipeline", context.buildPipelines],
      ["multi-review", context.multiReviews],
      ["native-queues", context.nativeAgents],
    ];
    const result: Record<string, unknown> = {};
    for (const [domain, owner] of owners) {
      if (!owner) continue;
      const reconciled = await owner.reconcileScheduling().catch(() => null);
      result[domain] = { reconciled, status: owner.schedulingStatus() };
    }
    return result;
  });
}
