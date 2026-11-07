import { asSystemModel, systemApi, systemApiOn } from "@/lib/node-scope/domains/system";
import { type AccountMachine } from "./agent-accounts";
import { commandBackendClient, type BackendClient } from "./client";

/** Current resource use on the host running the Orkestrator backend. */
export interface SystemUsageSnapshot {
  cpuPercent: number;
  ramPercent: number;
  gpuPercent: number | null;
  diskPercent: number | null;
  sampledAt: string;
}

/** One process sampled inside a running environment. */
export interface EnvironmentProcessUsage {
  pid: number;
  name: string;
  command: string;
  cpuPercent: number;
  ramPercent: number;
  rssKb: number;
}

/** Processes belonging to one environment. */
export interface EnvironmentProcessGroup {
  environmentId: string;
  environmentName: string;
  projectId: string;
  environmentType: "containerized" | "local";
  processes: EnvironmentProcessUsage[];
  /** Summed CPU across every selected process, including omitted rows. */
  totalCpuPercent: number;
  /** Summed RSS across every selected process, including omitted rows. */
  totalRssKb: number;
  /** Selected process count before per-environment or snapshot row clipping. */
  processCount: number;
  /** True when `processes` is a prefix of the selected set. */
  truncated?: boolean;
}

export interface EnvironmentProcessUsageSnapshot {
  environments: EnvironmentProcessGroup[];
  sampledAt: string;
  truncated?: boolean;
}

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createSystemApi(client: BackendClient) {
  const system = () => systemApi(client);
  /** Today's call without an arguments object (the version-0 adapter sends exactly that). */
  const noArgs = undefined as never;

  /** Running Orkestrator version reported by the connected backend. */
  async function getAppVersion(machine?: AccountMachine): Promise<string> {
    return machine === undefined
      ? system().get_app_version(noArgs)
      : systemApiOn(client, machine).get_app_version({});
  }

  async function getSystemUsage(): Promise<SystemUsageSnapshot> {
    return system().get_system_usage(noArgs);
  }

  /** Live CPU/RAM for child processes of every running environment. */
  async function getEnvironmentProcessUsage(): Promise<EnvironmentProcessUsageSnapshot> {
    return asSystemModel<EnvironmentProcessUsageSnapshot>(
      system().get_environment_process_usage(noArgs),
    );
  }

  return { getAppVersion, getSystemUsage, getEnvironmentProcessUsage };
}

export type SystemApi = ReturnType<typeof createSystemApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const { getAppVersion, getSystemUsage, getEnvironmentProcessUsage } =
  createSystemApi(commandBackendClient);
