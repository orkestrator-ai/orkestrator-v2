/**
 * What a machine reports about itself so a coordinator can choose where to put
 * work: its OS and size, and its average CPU and RAM use over three windows.
 *
 * Each backend samples itself (`apps/backend/src/core/machine-load.ts`) and
 * answers `get_machine_load`; `list_nodes` shows this machine's answer and each
 * connected node's. See `docs/architecture/coordinator.md`, "Multiple machines".
 */

/** The backend command; its read verb makes routed calls count as reads. */
export const MACHINE_LOAD_COMMAND = "get_machine_load";

/** A worker runs for hours, so these run longer than `os.loadavg()`'s 1, 5 and 15 minutes. */
export const MACHINE_LOAD_WINDOW_SHORT = { window: "5m", seconds: 5 * 60 } as const;
export const MACHINE_LOAD_WINDOW_MEDIUM = { window: "1h", seconds: 60 * 60 } as const;
export const MACHINE_LOAD_WINDOW_LONG = { window: "24h", seconds: 24 * 60 * 60 } as const;
export const MACHINE_LOAD_WINDOWS = [
  MACHINE_LOAD_WINDOW_SHORT,
  MACHINE_LOAD_WINDOW_MEDIUM,
  MACHINE_LOAD_WINDOW_LONG,
] as const;

export const MACHINE_OS_FAMILIES = ["macos", "linux", "windows", "other"] as const;
export type MachineOsFamily = (typeof MACHINE_OS_FAMILIES)[number];

export interface MachineLoadWindow {
  /** A short name, such as `5m`. A newer node's windows pass through unchanged. */
  window: string;
  windowSeconds: number;
  /**
   * How much of the window the average is built from. Below `windowSeconds`
   * the machine has less history than the window: a restart, or the host asleep.
   */
  coveredSeconds: number;
  /** Percent of the whole machine, so machines of different sizes compare. Null with no history. */
  cpuPercent: number | null;
  ramPercent: number | null;
}

export interface MachineLoadReport {
  osFamily: MachineOsFamily;
  /** Readable OS name and version: `macOS 26.1`, `Arch Linux`. */
  os: string;
  arch: string;
  cpuCores: number;
  totalRamGb: number;
  /** Seconds since the newest reading; null before the first one. */
  latestSampleAgeSeconds: number | null;
  load: MachineLoadWindow[];
}

/** Why no figures are shown for a machine. Never stale figures in their place. */
export type MachineUnavailableReason = "offline" | "timeout" | "older-version" | "error";

export type MachineLoadView =
  | ({ status: "ok" } & MachineLoadReport)
  | { status: "unavailable"; reason: MachineUnavailableReason; detail: string };

const MAX_WINDOWS = 8;
const MAX_OS_LENGTH = 120;
const MAX_ARCH_LENGTH = 32;

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parsePercent(value: unknown): number | null | undefined {
  if (value === null) return null;
  return isCount(value) && value <= 100 ? value : undefined;
}

function parseWindow(value: unknown): MachineLoadWindow | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const cpuPercent = parsePercent(entry.cpuPercent);
  const ramPercent = parsePercent(entry.ramPercent);
  if (
    typeof entry.window !== "string" ||
    !/^[0-9a-z]{1,8}$/.test(entry.window) ||
    !isCount(entry.windowSeconds) ||
    !isCount(entry.coveredSeconds) ||
    cpuPercent === undefined ||
    ramPercent === undefined
  ) {
    return null;
  }
  return {
    window: entry.window,
    windowSeconds: entry.windowSeconds,
    coveredSeconds: entry.coveredSeconds,
    cpuPercent,
    ramPercent,
  };
}

/**
 * A node's answer, keeping only the documented fields: nothing else a node
 * might send reaches a coordinator. An answer of the wrong shape is null.
 */
export function parseMachineLoadReport(value: unknown): MachineLoadReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  const age = report.latestSampleAgeSeconds;
  if (
    !MACHINE_OS_FAMILIES.includes(report.osFamily as MachineOsFamily) ||
    typeof report.os !== "string" ||
    !report.os ||
    typeof report.arch !== "string" ||
    !report.arch ||
    !isCount(report.cpuCores) ||
    !isCount(report.totalRamGb) ||
    !(age === null || isCount(age)) ||
    !Array.isArray(report.load) ||
    report.load.length > MAX_WINDOWS
  ) {
    return null;
  }
  const load = report.load.map(parseWindow);
  if (load.some((entry) => entry === null)) return null;
  return {
    osFamily: report.osFamily as MachineOsFamily,
    os: report.os.slice(0, MAX_OS_LENGTH),
    arch: report.arch.slice(0, MAX_ARCH_LENGTH),
    cpuCores: report.cpuCores,
    totalRamGb: report.totalRamGb,
    latestSampleAgeSeconds: age as number | null,
    load: load as MachineLoadWindow[],
  };
}
