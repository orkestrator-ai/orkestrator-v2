import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { runCommand } from "./commands-dependencies.js";

/**
 * Generation-bound container readiness and graceful drain.
 *
 * An image with the `boot-status` capability writes one status record per
 * boot. A record counts only when its `pid1Start` equals the start time of the
 * container's current PID 1, which changes on every container start, so a
 * record (or legacy marker) left by an earlier boot can never release setup or
 * an agent launch. Readiness is orchestration evidence, not a security
 * boundary against the container user.
 */

export const BOOT_STATUS_PATH = "/run/orkestrator/boot-status.json";
const MAX_BOOT_STATUS_BYTES = 4 * 1024;

export type BootPhase = "initializing" | "network-ready" | "inputs-ready" | "ready" | "failed";

export type BootObservation =
  /** The image writes no boot status (predates the capability). */
  | { kind: "legacy" }
  /** No record for this boot yet (the entrypoint has not written one). */
  | { kind: "pending" }
  | { kind: "current"; bootId: string; phase: BootPhase; failureCode: string | null }
  | { kind: "unreachable" };

const BOOT_PHASES: readonly BootPhase[] = [
  "initializing",
  "network-ready",
  "inputs-ready",
  "ready",
  "failed",
];

const FAILURE_CODE = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Parses the output of the boot probe: the status file (or a sentinel when
 * absent), then PID 1's current start time.
 */
export function parseBootProbe(output: string): BootObservation {
  const [statusLine = "", startLine = ""] = output.split("\n", 2);
  const pid1Start = startLine.trim();
  const first = statusLine.trim();
  if (first === "ORKESTRATOR_NO_BOOT_STATUS") return { kind: "pending" };
  // The probe prints either a sentinel or a JSON record. Anything else (no
  // output, an unrelated line) is not this contract, so it gates nothing —
  // exactly like an image without the boot-status capability.
  if (first === "ORKESTRATOR_NO_BOOT_DIR" || !first.startsWith("{")) return { kind: "legacy" };
  if (statusLine.length > MAX_BOOT_STATUS_BYTES || !/^\d+$/.test(pid1Start)) {
    return { kind: "pending" };
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(statusLine) as Record<string, unknown>;
  } catch {
    // A torn or foreign file is not evidence of readiness.
    return { kind: "pending" };
  }
  if (record.version !== 1 || record.pid1Start !== pid1Start) return { kind: "pending" };
  const bootId = typeof record.bootId === "string" ? record.bootId : "";
  if (!/^[0-9a-f-]{8,64}$/i.test(bootId)) return { kind: "pending" };
  const phase = BOOT_PHASES.find((candidate) => candidate === record.phase);
  if (!phase) return { kind: "pending" };
  const failureCode =
    typeof record.failureCode === "string" && FAILURE_CODE.test(record.failureCode)
      ? record.failureCode
      : null;
  return { kind: "current", bootId, phase, failureCode };
}

async function containerIsRunning(containerId: string): Promise<boolean> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", "{{.State.Running}}", containerId],
      { timeoutMs: 10_000 },
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function observeContainerBoot(containerId: string): Promise<BootObservation> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "exec",
        containerId,
        "sh",
        "-c",
        `if [ ! -d /run/orkestrator ]; then echo ORKESTRATOR_NO_BOOT_DIR; elif [ -f ${BOOT_STATUS_PATH} ]; then head -c ${MAX_BOOT_STATUS_BYTES} ${BOOT_STATUS_PATH} | head -n 1; else echo ORKESTRATOR_NO_BOOT_STATUS; fi; awk '{print $22}' /proc/1/stat`,
      ],
      { timeoutMs: 10_000 },
    );
    return parseBootProbe(stdout);
  } catch {
    return { kind: "unreachable" };
  }
}

export class ContainerInitializationError extends Error {
  constructor(
    readonly reason: "failed" | "timed-out",
    readonly failureCode: string | null,
  ) {
    super(
      formatContainerLifecycleError(
        "not-ready",
        reason === "failed"
          ? `Container initialization failed (${failureCode ?? "unknown"}). Check the container logs, then retry.`
          : "Container initialization did not complete in time. Retry once the container is ready.",
      ),
    );
    this.name = "ContainerInitializationError";
  }
}

/** Default budget for one boot, separate from clone, setup and bridge deadlines. */
export const BOOT_WAIT_TIMEOUT_MS = 120_000;

/**
 * Waits for the current boot to reach `ready`. Returns `null` for a legacy
 * image (no boot status), the boot id otherwise. A failed boot or a timeout is
 * a typed, retryable error; nothing proceeds on an unfinished container.
 */
export async function waitForContainerBoot(
  containerId: string,
  options: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? BOOT_WAIT_TIMEOUT_MS);
  const pollMs = options.pollMs ?? 250;
  let unreachableStreak = 0;
  while (true) {
    const observation = await observeContainerBoot(containerId);
    if (observation.kind === "legacy") return null;
    if (observation.kind === "current") {
      if (observation.phase === "ready") return observation.bootId;
      if (observation.phase === "failed") {
        throw new ContainerInitializationError("failed", observation.failureCode);
      }
    }
    unreachableStreak = observation.kind === "unreachable" ? unreachableStreak + 1 : 0;
    // A failed entrypoint exits, which stops the container; an exec into it
    // then fails for as long as we care to wait.
    if (observation.kind === "unreachable" && !(await containerIsRunning(containerId))) {
      throw new ContainerInitializationError("failed", "container-exited");
    }
    if (now() >= deadline) throw new ContainerInitializationError("timed-out", null);
    await new Promise((resolve) =>
      setTimeout(resolve, pollMs * Math.min(unreachableStreak + 1, 4)),
    );
  }
}

/**
 * Recheck immediately before dispatching work into a container: if Docker
 * restarted it since readiness was established, wait for the new boot instead
 * of launching into an uninitialized one.
 */
export async function ensureCurrentBootReady(
  containerId: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  const observation = await observeContainerBoot(containerId);
  // No contract, or no answer: the dispatch that follows reports its own
  // failure. Only positive evidence of an unfinished boot is waited on.
  if (observation.kind === "legacy" || observation.kind === "unreachable") return null;
  if (observation.kind === "current" && observation.phase === "ready") return observation.bootId;
  return waitForContainerBoot(containerId, options);
}

// ---------------------------------------------------------------------------
// Draining
// ---------------------------------------------------------------------------

/**
 * Environments and containers being drained. New workload (bridges,
 * terminals, setup) is fenced while an explicit stop is draining. The fence is
 * in memory on purpose: a drain only exists inside one lifecycle operation.
 */
const drainingEnvironments = new Set<string>();
const drainingContainers = new Set<string>();

function drainingError(): Error {
  return new Error(
    formatContainerLifecycleError(
      "operation-in-progress",
      "The environment is stopping. New work is refused until it has stopped.",
    ),
  );
}

export function isEnvironmentDraining(environmentId: string): boolean {
  return drainingEnvironments.has(environmentId);
}

export function assertEnvironmentNotDraining(environmentId: string): void {
  if (drainingEnvironments.has(environmentId)) throw drainingError();
}

export function assertContainerNotDraining(containerId: string): void {
  if (drainingContainers.has(containerId)) throw drainingError();
}

export async function withEnvironmentDraining<T>(
  environmentId: string,
  containerId: string,
  run: () => Promise<T>,
): Promise<T> {
  drainingEnvironments.add(environmentId);
  drainingContainers.add(containerId);
  try {
    return await run();
  } finally {
    drainingEnvironments.delete(environmentId);
    drainingContainers.delete(containerId);
  }
}

export interface DrainResult {
  signalled: number;
  remaining: number;
}

export const DEFAULT_DRAIN_GRACE_SECONDS = 10;

/**
 * Signals every workload process in the container with SIGTERM and waits up
 * to the grace period. Returns what remained; escalation is the caller's
 * `docker stop`. `null` when the image has no drain script or the exec failed.
 */
export async function drainContainerProcesses(
  containerId: string,
  graceSeconds = DEFAULT_DRAIN_GRACE_SECONDS,
): Promise<DrainResult | null> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "exec",
        "--user",
        "root",
        containerId,
        "/usr/local/bin/orkestrator-drain.sh",
        String(Math.max(0, Math.min(60, Math.floor(graceSeconds)))),
      ],
      { timeoutMs: (graceSeconds + 15) * 1_000 },
    );
    const match = /ORKESTRATOR_DRAIN signalled=(\d+) remaining=(\d+)/.exec(stdout);
    return match ? { signalled: Number(match[1]), remaining: Number(match[2]) } : null;
  } catch {
    return null;
  }
}

/** Exit code 137 after `docker stop` means Docker had to SIGKILL. */
export async function containerStopWasForced(containerId: string): Promise<boolean | null> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", "{{.State.ExitCode}}", containerId],
      { timeoutMs: 10_000 },
    );
    const code = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(code) ? code === 137 : null;
  } catch {
    return null;
  }
}
