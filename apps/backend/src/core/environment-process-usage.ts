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
}

const PROCESS_PROBE_TIMEOUT_MS = 2_000;
const MAX_PROCESSES_PER_ENVIRONMENT = 40;
const PS_COLUMNS = "pid=,ppid=,pcpu=,pmem=,rss=,args=";

interface ListedProcess extends EnvironmentProcessUsage {
  ppid: number;
}

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

export function processDisplayName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return base || "process";
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
      command,
      cpuPercent: clampPercent(cpuPercent),
      ramPercent: clampPercent(ramPercent),
      rssKb,
    });
  }
  return processes;
}

export function environmentRootPids(environment: ProcessUsageEnvironment): number[] {
  return [
    environment.opencodePid,
    environment.claudeBridgePid,
    environment.codexBridgePid,
    environment.cursorBridgePid,
    environment.grokBridgePid,
    environment.piBridgePid,
  ].filter((pid): pid is number => typeof pid === "number" && Number.isFinite(pid) && pid > 1);
}

export function collectDescendantPids(roots: readonly number[], processes: ListedProcess[]): Set<number> {
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

export function commandTouchesWorktree(command: string, worktreePath: string | undefined): boolean {
  if (!worktreePath || worktreePath.length === 0) return false;
  return command.includes(worktreePath);
}

export function selectLocalProcesses(
  processes: ListedProcess[],
  environment: ProcessUsageEnvironment,
): EnvironmentProcessUsage[] {
  const owned = collectDescendantPids(environmentRootPids(environment), processes);
  return rankProcesses(
    processes.filter(
      (process) => owned.has(process.pid) || commandTouchesWorktree(process.command, environment.worktreePath),
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
  return platform === "darwin"
    ? ["-axo", PS_COLUMNS]
    : ["-eo", PS_COLUMNS, "--no-headers"];
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

/**
 * Live CPU/RAM for processes that belong to each running environment.
 *
 * Containerized environments are sampled inside the container. Local
 * environments reuse one host `ps` and keep descendants of the persisted
 * bridge/server PIDs plus anything whose argv still names the worktree.
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

  const groups = await Promise.all(
    running.map(async (environment): Promise<EnvironmentProcessGroup> => {
      let listed: ListedProcess[] = [];
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
    }),
  );

  return {
    environments: groups,
    sampledAt: new Date(now()).toISOString(),
  };
}
