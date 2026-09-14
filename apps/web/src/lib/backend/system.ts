import { invoke } from "@/lib/native/backend";

/** Running Orkestrator version reported by the connected backend. */
export async function getAppVersion(): Promise<string> {
  return invoke<string>("get_app_version");
}

/** Current resource use on the host running the Orkestrator backend. */
export interface SystemUsageSnapshot {
  cpuPercent: number;
  ramPercent: number;
  gpuPercent: number | null;
  diskPercent: number | null;
  sampledAt: string;
}

export async function getSystemUsage(): Promise<SystemUsageSnapshot> {
  return invoke<SystemUsageSnapshot>("get_system_usage");
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

/** Live CPU/RAM for child processes of every running environment. */
export async function getEnvironmentProcessUsage(): Promise<EnvironmentProcessUsageSnapshot> {
  return invoke<EnvironmentProcessUsageSnapshot>("get_environment_process_usage");
}
