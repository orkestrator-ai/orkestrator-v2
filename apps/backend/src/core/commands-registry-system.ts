import {
  getAppVersionCommand,
  getArtifactMetricsCommand,
  getCompatibilityPathUsageCommand,
  getDatabaseStatsCommand,
  getEnvironmentProcessUsageCommand,
  getMachineLoadCommand,
  getProgressiveReadMetricsCommand,
  getRecurringWorkDiagnosticsCommand,
  getSystemUsageCommand,
  planDiagnosticsBundleCommand,
  planDiagnosticsBundleWithContainerLogsCommand,
  readDiagnosticsBundleCommand,
  reconcileWorkflowSchedulingCommand,
  recordDomainAdapterUsageCommand,
  recordRendererErrorsCommand,
} from "@orkestrator/protocol/contract/domains/system";
import { APP_VERSION } from "./constants.js";
import { containerLogOptions, normaliseContainerLogChoice } from "./diagnostics-container-logs.js";
import { diagnosticsSources } from "./diagnostics-sources.js";
import { recordRendererDomainAdapterUsage } from "./domain-adapter-usage.js";
import { RendererErrorRecorder } from "./renderer-error-recorder.js";
import type { CommandContext } from "./commands-context.js";
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

/**
 * Builds (or joins) a plan holding `containerLogs`' server logs, and lists the
 * container environments the dialog can offer next to it.
 */
async function planDiagnostics(context: CommandContext, containerLogs: string[]) {
  if (!context.diagnostics) throw new Error("Diagnostics are not available here.");
  const plan = await context.diagnostics.bundles.plan(
    () => diagnosticsSources(context, { containerLogs }),
    JSON.stringify(containerLogs),
  );
  const environments = await context.storage.loadEnvironments().catch(() => []);
  return { ...plan, containerLogs: containerLogOptions(environments, containerLogs) };
}

export function registerSystemCommands(
  register: CommandRegistrar,
  readSystemUsage?: (diskPath: string) => Promise<SystemUsageSnapshot>,
  readEnvironmentProcessUsage?: (
    environments: ProcessUsageEnvironment[],
  ) => Promise<EnvironmentProcessUsageSnapshot>,
): void {
  const readUsage = readSystemUsage ?? createSystemUsageReader({ ramReader: hostRamReader });
  const readProcesses = readEnvironmentProcessUsage ?? defaultReadEnvironmentProcessUsage;
  const rendererErrors = new RendererErrorRecorder();
  /**
   * A renderer's new error counts (a desktop window's own, or a browser tab
   * signed in to this backend), into the essential log. Only content-free
   * fields are accepted, and the write is rate-bound, per renderer when it
   * sends its `client` id. Refused to workspace clients
   * (`workspace-grant-scope.ts`): this machine's log is its own.
   */
  register(recordRendererErrorsCommand, (args) => rendererErrors.record(args.entries, args.client));
  /**
   * A renderer's new domain client adapter counts (plan item 1009), into the
   * compatibility-path counters: names and numbers only. Refused to workspace
   * clients (`workspace-grant-scope.ts`): the counters are this machine's own.
   */
  register(recordDomainAdapterUsageCommand, (args) =>
    recordRendererDomainAdapterUsage(args.entries),
  );
  register(getAppVersionCommand, () => APP_VERSION);
  register(getSystemUsageCommand, (_args, context) => readUsage(context.storage.getDataDir()));
  // Answered from the sampler's history, with no I/O, so it costs a coordinator
  // one round trip per machine. Read by `list_nodes`, here and over the node link.
  register(getMachineLoadCommand, (_args, context) => {
    if (!context.machineLoad) throw new Error("Machine load sampling is not running here.");
    return context.machineLoad.report();
  });
  // Every client's open process panel asks for the same thing: the child
  // processes of every running environment. A read already in flight is
  // joined rather than repeated; nothing completed is cached, so a later
  // request always enumerates afresh (CPU figures are point samples).
  let pendingProcessRead: Promise<EnvironmentProcessUsageSnapshot> | null = null;
  register(getEnvironmentProcessUsageCommand, async (_args, context) => {
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
  register(getRecurringWorkDiagnosticsCommand, () => {
    return recurringWorkDiagnostics();
  });
  /**
   * Content-free usage of each mixed-version compatibility path: a count and
   * the first and last time it was taken, persisted across restarts. Retiring
   * a path rests on this (`docs/architecture/version-compatibility.md`). Also
   * served additively on the gateway's `/__orkestrator/metrics`.
   */
  register(getCompatibilityPathUsageCommand, () => {
    return compatibilityPathUsage.snapshot();
  });
  /**
   * Database size, free pages, backups and retention of both databases, from
   * the summary `/__orkestrator/metrics` reads, and lease waits per family.
   */
  register(getDatabaseStatsCommand, (_args, context) => {
    if (!context.diagnostics) throw new Error("Database figures are not available here.");
    return context.diagnostics.databaseStats();
  });
  /**
   * Bounded, content-free timings of the last progressive reads per domain. They
   * have no other record, and a read that reaches this only reads memory.
   */
  register(getProgressiveReadMetricsCommand, (_args, context) => {
    if (!context.nativeAgents) throw new Error("Native agents are not available here.");
    return { samples: context.nativeAgents.progressiveReadSamples() };
  });
  /** Content-free transcript artifact counters; an empty set where artifacts do not run. */
  register(getArtifactMetricsCommand, (_args, context) => {
    return context.transcriptArtifacts?.metrics.snapshot() ?? { counters: {}, droppedSeries: 0 };
  });
  /**
   * Builds a diagnostics bundle and holds it in memory, answering with the
   * manifest that is byte for byte the bundle's own, and the container
   * environments whose server logs the user may add by planning again.
   * Nothing reaches the disk or the network here; {@link read_diagnostics_bundle} hands the bytes to the
   * client that asked. Refused to workspace clients (`workspace-grant-scope.ts`).
   */
  register(planDiagnosticsBundleCommand, (_args, context) => planDiagnostics(context, []));
  /**
   * The same, with the container server logs of the environments the user
   * chose: opt-in per environment, read only now (todo 6143).
   */
  register(planDiagnosticsBundleWithContainerLogsCommand, async (args, context) =>
    planDiagnostics(context, normaliseContainerLogChoice(args.containerLogs)),
  );
  register(readDiagnosticsBundleCommand, (args, context) => {
    if (!context.diagnostics) throw new Error("Diagnostics are not available here.");
    return context.diagnostics.bundles.read(args.planId, Number(args.offset));
  });
  /**
   * Full diagnostic reconciliation for keyed scheduling (step 08). Every keyed
   * owner re-reads authoritative storage now, independent of its safety
   * cadence, and reports content-free counts: obligations by kind, wakes by
   * reason, what the pass recovered or dropped. Safe to call at any time.
   */
  register(reconcileWorkflowSchedulingCommand, async (_args, context) => {
    const owners: [string, KeyedWorkflowOwner | undefined][] = [
      ["feature-planning", context.featurePlanning],
      ["build-pipeline", context.buildPipelines],
      ["multi-review", context.multiReviews],
      ["native-queues", context.nativeAgents],
    ];
    const result: Record<
      string,
      {
        reconciled: Awaited<ReturnType<KeyedWorkflowOwner["reconcileScheduling"]>>;
        status: ReturnType<KeyedWorkflowOwner["schedulingStatus"]>;
      }
    > = {};
    for (const [domain, owner] of owners) {
      if (!owner) continue;
      const reconciled = await owner.reconcileScheduling().catch(() => null);
      result[domain] = { reconciled, status: owner.schedulingStatus() };
    }
    return result;
  });
}
