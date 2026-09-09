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
