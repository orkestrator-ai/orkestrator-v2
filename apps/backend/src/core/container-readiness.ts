import { formatContainerLifecycleError } from "@orkestrator/protocol/container-lifecycle";
import { copyOutBounded, extractSingleTarFile } from "./docker-copy-out.js";
import { runCommand } from "./shell.js";

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
  if (first === "ORKESTRATOR_NO_BOOT_DIR") return { kind: "legacy" };
  // Empty, torn, or foreign output is never positive readiness evidence.
  if (!first.startsWith("{")) return { kind: "pending" };
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

/** Whether the container runs, and when its current (or last) run started. */
async function containerRunState(
  containerId: string,
): Promise<{ running: boolean; startedAt: string }> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", "{{.State.Running}} {{.State.StartedAt}}", containerId],
      { timeoutMs: 10_000 },
    );
    const [running = "", startedAt = ""] = stdout.trim().split(/\s+/, 2);
    return { running: running === "true", startedAt };
  } catch {
    return { running: false, startedAt: "" };
  }
}

const RECORD_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * The failure code an exited container's last boot recorded, or null.
 *
 * PID 1 no longer exists, so the record cannot be matched by its start time
 * the way {@link parseBootProbe} matches a running one. It counts only when it
 * was written during the container's last run: its `updatedAt` (whole seconds,
 * written by the entrypoint) is not before Docker's `State.StartedAt` for that
 * run. A record an earlier start left behind, for an entrypoint that died
 * before writing anything, is never reported as this boot's failure.
 */
export function parseExitedBootRecord(content: string, startedAt: string): string | null {
  const line = content.split("\n", 1)[0] ?? "";
  if (!line.startsWith("{") || line.length > MAX_BOOT_STATUS_BYTES) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (record.version !== 1 || record.phase !== "failed") return null;
  const code = record.failureCode;
  if (typeof code !== "string" || !FAILURE_CODE.test(code)) return null;
  const updatedAt = record.updatedAt;
  const runStartedSecond = `${startedAt.slice(0, 19)}Z`;
  if (typeof updatedAt !== "string" || !RECORD_SECOND.test(updatedAt)) return null;
  if (!RECORD_SECOND.test(runStartedSecond) || runStartedSecond.startsWith("0001-")) return null;
  return Date.parse(updatedAt) >= Date.parse(runStartedSecond) ? code : null;
}

/** Reads the final boot record out of a stopped container (`docker cp` needs no running process). */
async function readExitedBootFailure(
  containerId: string,
  startedAt: string,
): Promise<string | null> {
  const copied = await copyOutBounded(containerId, BOOT_STATUS_PATH, MAX_BOOT_STATUS_BYTES, 10_000);
  if (copied.kind !== "bytes") return null;
  const file = extractSingleTarFile(copied.tar, MAX_BOOT_STATUS_BYTES);
  return file.ok ? parseExitedBootRecord(file.content, startedAt) : null;
}

/** How often a bounded in-container wait re-reads its status file. */
export const IN_CONTAINER_CHECK_MS = 50;
/** The longest one probe exec waits inside the container for a final state. */
export const PROBE_WINDOW_MS = 2_000;

/**
 * Prefix for a probe script: waits in the container, re-reading every
 * {@link IN_CONTAINER_CHECK_MS}, until `condition` (a shell test, run each
 * time) holds or `iterations` checks have passed. Bounded by a count, not a
 * clock, so it is plain POSIX `sh`; a container that stops kills the exec,
 * which ends the wait at once. A `sleep` that refuses a fraction ends the
 * wait instead of stretching it. With 0 iterations it never waits.
 */
export function boundedWaitScript(iterations: number, condition: string): string {
  const count = Math.max(0, Math.floor(iterations));
  const pause = (IN_CONTAINER_CHECK_MS / 1_000).toFixed(2);
  return `i=0; while [ "$i" -lt ${count} ]; do if ${condition}; then break; fi; i=$((i + 1)); sleep ${pause} 2>/dev/null || break; done; `;
}

/** The number of in-container checks that fill a window of `windowMs`. */
export function probeIterations(windowMs: number): number {
  return windowMs > 0 ? Math.ceil(windowMs / IN_CONTAINER_CHECK_MS) : 0;
}

/**
 * The boot probe. With a window it first waits inside the container until
 * the current boot (the record's `pid1Start` is PID 1's) reports `ready` or
 * `failed`, the status directory is missing, or the window ends; then it
 * prints what it saw exactly as a single read would. The match relies on
 * both writers putting `pid1Start` before `phase`, and it is only a cue to
 * stop waiting: {@link parseBootProbe} still decides what the record proves.
 */
export function bootProbeScript(windowMs = 0): string {
  const settled =
    `[ ! -d /run/orkestrator ] || case "$(head -c ${MAX_BOOT_STATUS_BYTES} ${BOOT_STATUS_PATH} 2>/dev/null | head -n 1)" in ` +
    `*"\\"pid1Start\\":\\"$p\\""*'"phase":"ready"'*|*"\\"pid1Start\\":\\"$p\\""*'"phase":"failed"'*) true ;; *) false ;; esac`;
  const wait =
    windowMs > 0
      ? `p=$(awk '{print $22}' /proc/1/stat); ${boundedWaitScript(probeIterations(windowMs), settled)}`
      : "";
  return `${wait}if [ ! -d /run/orkestrator ]; then echo ORKESTRATOR_NO_BOOT_DIR; elif [ -f ${BOOT_STATUS_PATH} ]; then head -c ${MAX_BOOT_STATUS_BYTES} ${BOOT_STATUS_PATH} | head -n 1; else echo ORKESTRATOR_NO_BOOT_STATUS; fi; awk '{print $22}' /proc/1/stat`;
}

/**
 * One read of the current boot's status. With `waitMs`, the exec waits up to
 * that long inside the container for the boot to finish or fail, so a wait
 * sees the change within {@link IN_CONTAINER_CHECK_MS} and spends one Docker
 * call per window rather than one per host-side poll.
 */
export async function observeContainerBoot(
  containerId: string,
  options: { waitMs?: number } = {},
): Promise<BootObservation> {
  const waitMs = Math.max(0, Math.min(options.waitMs ?? 0, PROBE_WINDOW_MS));
  try {
    const { stdout } = await runCommand(
      "docker",
      ["exec", containerId, "sh", "-c", bootProbeScript(waitMs)],
      { timeoutMs: 10_000 + waitMs },
    );
    const observation = parseBootProbe(stdout);
    if (observation.kind !== "legacy") return observation;
    // A missing status directory is legacy only when the image does not
    // advertise the boot-status contract. An initialized capable image can
    // temporarily lose /run during restart.
    try {
      const { stdout: capabilities } = await runCommand(
        "docker",
        [
          "inspect",
          "-f",
          '{{ index .Config.Labels "org.orkestrator.image.capabilities" }}',
          containerId,
        ],
        { timeoutMs: 10_000 },
      );
      return /(?:^|,)boot-status=[1-9][0-9]*(?:,|$)/.test(capabilities.trim())
        ? { kind: "pending" }
        : observation;
    } catch {
      return { kind: "unreachable" };
    }
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
 *
 * Each probe waits inside the container for up to {@link PROBE_WINDOW_MS}
 * (`windowMs`), so readiness is seen within {@link IN_CONTAINER_CHECK_MS} of
 * the entrypoint writing it. `pollMs` is only a floor between probes that
 * came back early without a final state, and the base of the backoff while
 * the container cannot be reached.
 */
export async function waitForContainerBoot(
  containerId: string,
  options: { timeoutMs?: number; pollMs?: number; windowMs?: number; now?: () => number } = {},
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? BOOT_WAIT_TIMEOUT_MS);
  const pollMs = options.pollMs ?? 250;
  const windowMs = options.windowMs ?? PROBE_WINDOW_MS;
  let unreachableStreak = 0;
  while (true) {
    const probedAt = now();
    const observation = await observeContainerBoot(containerId, {
      waitMs: Math.min(windowMs, Math.max(0, deadline - probedAt)),
    });
    if (observation.kind === "legacy") return null;
    if (observation.kind === "current") {
      if (observation.phase === "ready") return observation.bootId;
      if (observation.phase === "failed") {
        throw new ContainerInitializationError("failed", observation.failureCode);
      }
    }
    unreachableStreak = observation.kind === "unreachable" ? unreachableStreak + 1 : 0;
    // A failed entrypoint exits, which stops the container; an exec into it
    // then fails for as long as we care to wait. Its last record usually
    // still names why (a fail-closed firewall exits at once, before the next
    // poll), so that code is reported when this run wrote it.
    if (observation.kind === "unreachable") {
      const state = await containerRunState(containerId);
      if (!state.running) {
        const recorded = await readExitedBootFailure(containerId, state.startedAt);
        throw new ContainerInitializationError("failed", recorded ?? "container-exited");
      }
    }
    if (now() >= deadline) throw new ContainerInitializationError("timed-out", null);
    // A probe that waited out its window probes again at once. One that came
    // back early with no final state (a capable image's missing status
    // directory, a record the parser refused) or could not reach the
    // container is spaced as before, so neither turns into a busy loop.
    const pause =
      observation.kind === "unreachable"
        ? pollMs * Math.min(unreachableStreak + 1, 4)
        : pollMs - (now() - probedAt);
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
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
  if (observation.kind === "legacy") return null;
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
