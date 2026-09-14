import { commandMatchesRecordedServer, type LocalServerPidField } from "./local-server-reaper.js";
import { runCommand } from "./shell.js";

export interface EnvironmentProcessUsage {
  pid: number;
  name: string;
  command: string;
  cpuPercent: number;
  ramPercent: number;
  rssKb: number;
}

export interface EnvironmentProcessGroup {
  environmentId: string;
  environmentName: string;
  projectId: string;
  environmentType: "containerized" | "local";
  processes: EnvironmentProcessUsage[];
}

export interface EnvironmentProcessUsageSnapshot {
  environments: EnvironmentProcessGroup[];
  sampledAt: string;
  truncated: boolean;
}

export interface ProcessUsageEnvironment {
  id: string;
  projectId: string;
  name: string;
  status: string;
  environmentType: "containerized" | "local";
  containerId?: string | null;
  worktreePath?: string;
  opencodePid?: number;
  claudeBridgePid?: number;
  codexBridgePid?: number;
  cursorBridgePid?: number;
  grokBridgePid?: number;
  piBridgePid?: number;
}

interface ProcessUsageDependencies {
  platform: NodeJS.Platform;
  now: () => number;
  runCommand: (
    command: string,
    args: string[],
    options: { timeoutMs: number },
  ) => Promise<{ stdout: string }>;
  maxConcurrentContainerProbes?: number;
}

const PROCESS_PROBE_TIMEOUT_MS = 2_000;
export const MAX_PROCESSES_PER_ENVIRONMENT = 40;
export const MAX_CONCURRENT_CONTAINER_PROBES = 4;
export const MAX_COMMAND_DISPLAY_LENGTH = 240;
export const MAX_SNAPSHOT_PROCESSES = 200;
export const MAX_SNAPSHOT_BYTES = 64_000;
const PS_COLUMNS = "pid=,ppid=,pcpu=,pmem=,rss=,args=";

const ROOT_PID_FIELDS = [
  "opencodePid",
  "claudeBridgePid",
  "codexBridgePid",
  "cursorBridgePid",
  "grokBridgePid",
  "piBridgePid",
] as const satisfies readonly LocalServerPidField[];

const SECRET_FLAG_PATTERN =
  /(--(?:token|api-?key|password|passwd|secret|authorization|auth-token)|-p)(=|\s+)\S+/gi;
const AUTHORIZATION_HEADER_PATTERN = /\bAuthorization\s+\S+/gi;

interface ListedProcess extends EnvironmentProcessUsage {
  ppid: number;
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/** Per-process CPU can exceed 100% on multicore hosts; keep it nonnegative. */
function roundProcessCpuPercent(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

export function processDisplayName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return base || "process";
}

export function sanitizeProcessCommand(command: string): string {
  const redacted = command
    .replace(SECRET_FLAG_PATTERN, (_, flag: string, separator: string) => `${flag}${separator}***`)
    .replace(AUTHORIZATION_HEADER_PATTERN, "Authorization ***");
  if (redacted.length <= MAX_COMMAND_DISPLAY_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_COMMAND_DISPLAY_LENGTH)}…`;
}

export function parsePsUsageLines(output: string): ListedProcess[] {
  const processes: ListedProcess[] = [];
  for (const line of output.split("\n")) {
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(.*)$/,
    );
    if (!match) continue;
    const command = match[6]?.trim() ?? "";
    if (command.length === 0) continue;
    const name = processDisplayName(command);
    if (name === "ps") continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuPercent = Number(match[3]);
    const ramPercent = Number(match[4]);
    const rssKb = Number(match[5]);
    if (![pid, ppid, cpuPercent, ramPercent, rssKb].every(Number.isFinite)) continue;
    processes.push({
      pid,
      ppid,
      name,
      command: sanitizeProcessCommand(command),
      cpuPercent: roundProcessCpuPercent(cpuPercent),
      ramPercent: clampPercent(ramPercent),
      rssKb,
    });
  }
  return processes;
}

export function environmentRootPids(
  environment: ProcessUsageEnvironment,
  processes?: readonly ListedProcess[],
): number[] {
  const pids: number[] = [];
  for (const field of ROOT_PID_FIELDS) {
    const pid = environment[field];
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 1) continue;
    if (processes) {
      const listed = processes.find((process) => process.pid === pid);
      if (!listed || !commandMatchesRecordedServer(field, listed.command)) continue;
    }
    pids.push(pid);
  }
  return pids;
}

export function collectDescendantPids(
  roots: readonly number[],
  processes: ListedProcess[],
): Set<number> {
  const children = new Map<number, number[]>();
  for (const process of processes) {
    const siblings = children.get(process.ppid);
    if (siblings) siblings.push(process.pid);
    else children.set(process.ppid, [process.pid]);
  }
  const owned = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    for (const child of children.get(pid) ?? []) {
      if (owned.has(child)) continue;
      owned.add(child);
      pending.push(child);
    }
  }
  return owned;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

function tokenTouchesWorktree(token: string, worktreePath: string): boolean {
  const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
  if (value === worktreePath) return true;
  const prefix = worktreePath.endsWith("/") ? worktreePath : `${worktreePath}/`;
  return value.startsWith(prefix);
}

export function commandTouchesWorktree(command: string, worktreePath: string | undefined): boolean {
  if (!worktreePath || worktreePath.length === 0) return false;
  const normalized = worktreePath.replace(/\/+$/, "");
  if (normalized.length === 0) return false;
  return tokenizeCommand(command).some((token) => tokenTouchesWorktree(token, normalized));
}

export function selectLocalProcesses(
  processes: ListedProcess[],
  environment: ProcessUsageEnvironment,
): EnvironmentProcessUsage[] {
  const owned = collectDescendantPids(environmentRootPids(environment, processes), processes);
  return rankProcesses(
    processes.filter(
      (process) =>
        owned.has(process.pid) || commandTouchesWorktree(process.command, environment.worktreePath),
    ),
  );
}

function rankProcesses(processes: ListedProcess[]): EnvironmentProcessUsage[] {
  return processes
    .slice()
    .sort((left, right) => {
      if (right.cpuPercent !== left.cpuPercent) return right.cpuPercent - left.cpuPercent;
      if (right.ramPercent !== left.ramPercent) return right.ramPercent - left.ramPercent;
      if (right.rssKb !== left.rssKb) return right.rssKb - left.rssKb;
      return left.name.localeCompare(right.name);
    })
    .slice(0, MAX_PROCESSES_PER_ENVIRONMENT)
    .map(({ ppid: _ppid, ...process }) => process);
}

function hostPsArgs(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["-axo", PS_COLUMNS] : ["-eo", PS_COLUMNS, "--no-headers"];
}

async function listHostProcesses(
  dependencies: Required<Pick<ProcessUsageDependencies, "platform" | "runCommand">>,
): Promise<ListedProcess[]> {
  const result = await dependencies.runCommand("ps", hostPsArgs(dependencies.platform), {
    timeoutMs: PROCESS_PROBE_TIMEOUT_MS,
  });
  return parsePsUsageLines(result.stdout);
}

async function listContainerProcesses(
  containerId: string,
  execute: ProcessUsageDependencies["runCommand"],
): Promise<ListedProcess[]> {
  const result = await execute(
    "docker",
    ["exec", containerId, "ps", "-eo", PS_COLUMNS, "--no-headers"],
    { timeoutMs: PROCESS_PROBE_TIMEOUT_MS },
  );
  return parsePsUsageLines(result.stdout);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await mapper(items[index]!);
      }
    }),
  );
  return results;
}

function boundSnapshot(groups: EnvironmentProcessGroup[]): {
  environments: EnvironmentProcessGroup[];
  truncated: boolean;
} {
  let remaining = MAX_SNAPSHOT_PROCESSES;
  let bytes = 2;
  let truncated = false;
  const environments: EnvironmentProcessGroup[] = [];
  for (const group of groups) {
    const processes: EnvironmentProcessUsage[] = [];
    for (const process of group.processes) {
      const encoded = JSON.stringify(process).length + 1;
      if (remaining <= 0 || bytes + encoded > MAX_SNAPSHOT_BYTES) {
        truncated = true;
        break;
      }
      processes.push(process);
      remaining -= 1;
      bytes += encoded;
    }
    if (processes.length < group.processes.length) truncated = true;
    environments.push({ ...group, processes });
  }
  return { environments, truncated };
}

/**
 * Live CPU/RAM for processes that belong to each running environment.
 *
 * Containerized environments are sampled inside the container. Local
 * environments reuse one host `ps` and keep descendants of verified
 * bridge/server PIDs plus anything whose argv names the worktree with
 * path-boundary semantics.
 */
export async function readEnvironmentProcessUsage(
  environments: readonly ProcessUsageEnvironment[],
  dependencies: Partial<ProcessUsageDependencies> = {},
): Promise<EnvironmentProcessUsageSnapshot> {
  const platform = dependencies.platform ?? process.platform;
  const execute = dependencies.runCommand ?? runCommand;
  const now = dependencies.now ?? Date.now;
  const running = environments.filter((environment) => environment.status === "running");
  const needsHostListing = running.some((environment) => environment.environmentType === "local");
  let hostProcesses: ListedProcess[] = [];
  if (needsHostListing) {
    try {
      hostProcesses = await listHostProcesses({ platform, runCommand: execute });
    } catch {
      hostProcesses = [];
    }
  }

  const groups = await mapWithConcurrency(
    running,
    dependencies.maxConcurrentContainerProbes ?? MAX_CONCURRENT_CONTAINER_PROBES,
    async (environment): Promise<EnvironmentProcessGroup> => {
      let listed: EnvironmentProcessUsage[] = [];
      if (environment.environmentType === "local") {
        listed = selectLocalProcesses(hostProcesses, environment);
      } else if (environment.containerId) {
        try {
          listed = rankProcesses(await listContainerProcesses(environment.containerId, execute));
        } catch {
          listed = [];
        }
      }
      return {
        environmentId: environment.id,
        environmentName: environment.name,
        projectId: environment.projectId,
        environmentType: environment.environmentType,
        processes: listed,
      };
    },
  );

  const bounded = boundSnapshot(groups);
  return {
    environments: bounded.environments,
    sampledAt: new Date(now()).toISOString(),
    truncated: bounded.truncated,
  };
}
