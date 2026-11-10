import { resolveLogDetail } from "@orkestrator/protocol/log-policy";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { APP_VERSION } from "./constants.js";
import type { DiagnosticsSources } from "./diagnostics-bundle.js";
import {
  collectContainerLogs,
  dockerContainerLogReader,
  type ContainerLogReader,
} from "./diagnostics-container-logs.js";
import { getLogStorageStats } from "./log-storage.js";

const NOT_CHOSEN_CONTAINER_LOGS = {
  name: "container server logs",
  reason:
    "Not chosen: add them per environment in Settings → Debug → Export diagnostics. Reading them takes a docker exec per server, and they are raw provider lines.",
};
const NEVER_COLLECTED = {
  name: "prompts, transcripts, terminal output, files and credentials",
  reason: "Never collected.",
};

/**
 * What one backend's bundle holds, read in-process through the same functions
 * `/metrics` and the commands use. No loopback call and no credential: this
 * works the same on a standalone backend. Container server logs are read only
 * for the environments the user chose (`diagnostics-container-logs.ts`).
 */
export async function diagnosticsSources(
  context: CommandContext,
  options: {
    /** Environments whose container server logs the user chose to add; canonical. */
    containerLogs?: readonly string[];
    reader?: ContainerLogReader;
  } = {},
): Promise<DiagnosticsSources> {
  const diagnostics = context.diagnostics;
  const dataDir = context.storage.getDataDir();
  const logsDir = context.storage.getLogDirectory();
  const config = await context.storage.loadConfig().catch(() => null);
  const logging = {
    debugLogging: config?.global?.debugLogging,
    logDetail: config?.global?.logDetail,
  };
  const logStorage = await getLogStorageStats(logsDir).catch(() => null);
  const tracking = context.runtime.changeTracking;
  const chosen = options.containerLogs ?? [];
  const containerLogs =
    chosen.length > 0
      ? await collectContainerLogs(
          chosen,
          options.reader ??
            dockerContainerLogReader((environmentId) =>
              context.storage.getEnvironment(environmentId),
            ),
        )
      : null;
  return {
    now: () => new Date(),
    appVersion: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    bunVersion: process.versions.bun ?? null,
    redaction: {
      dataDir: path.resolve(dataDir),
      homeDir: os.homedir(),
      userName: os.userInfo().username,
      hostName: os.hostname(),
    },
    logsDir,
    debugLogging: logging.debugLogging === true,
    json: [
      {
        path: "metrics.json",
        description:
          "What /__orkestrator/metrics answers: gateway, recurring work, compatibility paths, the event loop, console output and the databases.",
        read: () => diagnostics?.metricsSnapshot(),
        absentAs: "This backend could not read its metrics.",
      },
      {
        path: "health-summary.json",
        description:
          "The rolling health rows: memory, CPU, stalls, database sizes and job kinds, with start and clean-exit markers.",
        read: () => diagnostics?.healthRows(),
        absentAs: "This backend could not read its health rows.",
      },
      {
        path: "database.json",
        description:
          "Size, free pages, backups, retention and top tables of both databases, and lease waits per family.",
        read: () => diagnostics?.databaseStats(),
        absentAs: "This backend could not read its database figures.",
      },
      {
        path: "change-tracking.json",
        description: "Change tracking's counters.",
        read: () => tracking?.diagnostics() ?? null,
        absentAs: "Change tracking is not running in this backend.",
      },
      {
        path: "progressive-reads.json",
        description: "Timings of the latest transcript, state and discovery reads.",
        read: () =>
          context.nativeAgents ? { samples: context.nativeAgents.progressiveReadSamples() } : null,
        absentAs: "Native agents are not running in this backend.",
      },
      {
        path: "artifact-metrics.json",
        description: "Transcript artifact counters by kind and outcome.",
        read: () => context.transcriptArtifacts?.metrics.snapshot() ?? null,
        absentAs: "Transcript artifacts are not running in this backend.",
      },
      {
        path: "log-policy.json",
        description: "Whether logs are saved, and the levels in force: names and levels only.",
        read: () => ({
          saveLogsToDisk: logging.debugLogging === true,
          retentionDays: config?.global?.debugLogRetentionDays ?? null,
          detail: resolveLogDetail(logging),
        }),
        absentAs: "The logging settings could not be read.",
      },
      {
        path: "log-storage.json",
        description: "How much the logs take up. Sizes and counts only.",
        read: () => logStorage,
        absentAs: "The log directory could not be measured.",
      },
    ],
    texts: containerLogs?.texts ?? [],
    notCollected: [
      ...(containerLogs ? containerLogs.absent : [NOT_CHOSEN_CONTAINER_LOGS]),
      NEVER_COLLECTED,
    ],
  };
}
