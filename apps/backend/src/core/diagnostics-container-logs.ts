import {
  DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS,
  type DiagnosticsContainerLogOption,
  type DiagnosticsManifestAbsent,
} from "@orkestrator/protocol/backend-diagnostics";
import { dockerExec, isContainerRunning } from "./commands-container-exec.js";
import { containerServerLogFile } from "./commands-containers.js";
import {
  boundDiagnosticTail,
  boundedTailCommand,
  DIAGNOSTIC_TAIL_MAX_BYTES,
  DIAGNOSTIC_TAIL_MAX_LINES,
  previousContainerLogFile,
} from "./container-log-bounds.js";
import type { DiagnosticsTextSource } from "./diagnostics-bundle.js";
import { LOCAL_SERVER_KINDS, type LocalServerKind } from "./local-server-runtime.js";
import type { Environment } from "./models.js";

/**
 * Container server logs for a diagnostics bundle, read only for the
 * environments the user chose in the Export dialog
 * (docs/todo/cross-cutting/6143-diagnostics-bundle-container-logs.md).
 *
 * Each read is a `docker exec` per server, so the cost is the user's choice:
 * nothing here runs for a bundle that chose none. Each file is bounded at the
 * source like every other container log tail ({@link boundedTailCommand}: the
 * newest {@link DIAGNOSTIC_TAIL_MAX_BYTES} bytes and
 * {@link DIAGNOSTIC_TAIL_MAX_LINES} lines), scrubbed by
 * {@link boundDiagnosticTail} as any tail the backend returns, and then goes
 * through the bundle's own redaction and credential check like a log file.
 * The lines are raw provider output, the riskiest content a bundle can hold,
 * which is why they are never read by default.
 *
 * A container bridge has no relay to the essential log, so its essential
 * events (a `session.resume-fell-back`, for one) live only in this log; reading
 * it on request is how they reach the evidence.
 */

/** How long one read may take; a container that does not answer is named as absent. */
const READ_TIMEOUT_MS = 15_000;
/** Bounds the dialog's list whatever the machine holds. */
const MAX_OPTIONS = 64;
/** An id that can name a directory in the archive as it is. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ContainerLogReader {
  getEnvironment(environmentId: string): Promise<Environment | null>;
  isRunning(containerId: string): Promise<boolean>;
  exec(containerId: string, command: string): Promise<string>;
}

export const dockerContainerLogReader = (
  getEnvironment: (environmentId: string) => Promise<Environment | null>,
): ContainerLogReader => ({
  getEnvironment,
  isRunning: isContainerRunning,
  exec: (containerId, command) => dockerExec(containerId, command, READ_TIMEOUT_MS),
});

interface ServerLogFile {
  kind: LocalServerKind;
  file: string;
  previous: boolean;
}

/** Every file a container server writes, current run and the one before it. */
export function containerServerLogFiles(): ServerLogFile[] {
  return LOCAL_SERVER_KINDS.flatMap((kind) => {
    const file = containerServerLogFile(kind);
    return [
      { kind, file, previous: false },
      { kind, file: previousContainerLogFile(file), previous: true },
    ];
  });
}

function isContainerEnvironment(environment: Environment): boolean {
  return environment.environmentType !== "local" && Boolean(environment.containerId);
}

/**
 * Canonical form of a choice: unique, sorted, and refused past the bound, so
 * the same choice in any order joins the same plan.
 */
export function normaliseContainerLogChoice(value: readonly unknown[] | undefined): string[] {
  if (value === undefined) return [];
  const ids = [...new Set(value)];
  if (!ids.every((id): id is string => typeof id === "string" && id.length > 0)) {
    throw new Error("Expected containerLogs to be a list of environment ids");
  }
  if (ids.length > DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS) {
    throw new Error(
      `Choose at most ${DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS} environments for container logs`,
    );
  }
  return ids.sort();
}

/** The container environments the dialog can offer, by name. Reads storage only. */
export function containerLogOptions(
  environments: readonly Environment[],
  included: readonly string[],
): DiagnosticsContainerLogOption[] {
  const chosen = new Set(included);
  return environments
    .filter(isContainerEnvironment)
    .map((environment) => ({
      environmentId: environment.id,
      name: environment.name,
      status: environment.status,
      included: chosen.has(environment.id),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_OPTIONS);
}

export interface CollectedContainerLogs {
  texts: DiagnosticsTextSource[];
  absent: DiagnosticsManifestAbsent[];
}

function describe(server: ServerLogFile): string {
  const run = server.previous
    ? "the run before its last relaunch, where a crash's evidence is"
    : "its current run";
  return `Raw output of the ${server.kind} server in this environment's container, ${run}: the newest ${DIAGNOSTIC_TAIL_MAX_BYTES / 1024} KiB and ${DIAGNOSTIC_TAIL_MAX_LINES} lines. Redacted, but this is provider output, the riskiest content in a bundle: read it before sharing.`;
}

async function collectOne(
  environmentId: string,
  directory: string,
  reader: ContainerLogReader,
  result: CollectedContainerLogs,
): Promise<void> {
  const name = `logs/containers/${directory}`;
  const environment = await reader.getEnvironment(environmentId).catch(() => null);
  if (!environment) {
    result.absent.push({ name, reason: "Chosen, but no environment has this id here." });
    return;
  }
  if (!isContainerEnvironment(environment)) {
    result.absent.push({ name, reason: "Chosen, but this environment has no container." });
    return;
  }
  const containerId = environment.containerId!;
  if (!(await reader.isRunning(containerId).catch(() => false))) {
    result.absent.push({
      name,
      reason: "Chosen, but its container is not running, so its logs could not be read.",
    });
    return;
  }
  const servers = containerServerLogFiles();
  let listed: string;
  try {
    // One exec says which servers have written anything; only those are read.
    listed = await reader.exec(
      containerId,
      `for f in ${servers.map((server) => server.file).join(" ")}; do [ -s "$f" ] && printf '%s\\n' "$f"; done; true`,
    );
  } catch {
    result.absent.push({ name, reason: "Chosen, but Docker did not answer for its container." });
    return;
  }
  const present = new Set(listed.split("\n").map((line) => line.trim()));
  const found = servers.filter((server) => present.has(server.file));
  if (found.length === 0) {
    result.absent.push({ name, reason: "Chosen, but no server has written a log there yet." });
    return;
  }
  for (const server of found) {
    const path = `${name}/${server.file.slice(server.file.lastIndexOf("/") + 1)}`;
    try {
      const tail = boundDiagnosticTail(
        await reader.exec(containerId, boundedTailCommand(server.file)),
      );
      result.texts.push({ path, description: describe(server), text: tail });
    } catch {
      result.absent.push({ name: path, reason: "The log could not be read from its container." });
    }
  }
}

/**
 * Reads the chosen environments' container server logs. Environments are read
 * side by side and their files one at a time; nothing is read when none is
 * chosen. What could not be read is named as absent with the reason.
 */
export async function collectContainerLogs(
  environmentIds: readonly string[],
  reader: ContainerLogReader,
): Promise<CollectedContainerLogs> {
  const perEnvironment = await Promise.all(
    environmentIds.map(async (environmentId, index) => {
      const result: CollectedContainerLogs = { texts: [], absent: [] };
      const directory = SAFE_ID.test(environmentId) ? environmentId : `environment-${index + 1}`;
      await collectOne(environmentId, directory, reader, result);
      return result;
    }),
  );
  return {
    texts: perEnvironment.flatMap((result) => result.texts),
    absent: perEnvironment.flatMap((result) => result.absent),
  };
}
