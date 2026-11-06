import {
  isActiveHostUpdateJob,
  type HostMaintenanceSnapshot,
  type HostUpdateDrain,
} from "@orkestrator/protocol/host-maintenance";
import type { HostMaintenanceClient } from "@/lib/host-maintenance-client";
import type { BulkUpdateOutcome } from "@/stores/machineBulkUpdateStore";

/** How long a machine has to answer the check before its own updater picks the release. */
const CHECK_TIMEOUT_MS = 90_000;
const CHECK_POLL_MS = 1_500;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface UpdateToLatestOptions {
  drain?: HostUpdateDrain;
  maxWaitSeconds?: number;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  checkTimeoutMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Brings one machine to the newest Orkestrator release on its own update
 * channel. It checks first, so a machine already on that release is left
 * alone, then asks the host to install it. The host's own updater (the
 * desktop app where it runs one, otherwise the backend service) downloads,
 * restarts and reports progress in the machine's maintenance snapshot.
 */
export async function updateMachineToLatest(
  client: HostMaintenanceClient,
  options: UpdateToLatestOptions = {},
  onProgress: (outcome: BulkUpdateOutcome, snapshot: HostMaintenanceSnapshot | null) => void = () =>
    undefined,
): Promise<BulkUpdateOutcome> {
  const sleep = options.sleep ?? wait;
  const now = options.now ?? Date.now;
  const timeout = options.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
  try {
    let snapshot = await client.getHostMaintenance();
    if (!snapshot.updater.available) {
      const outcome: BulkUpdateOutcome = {
        state: "skipped",
        reason: snapshot.updater.reason ?? "This machine cannot update Orkestrator itself",
      };
      onProgress(outcome, snapshot);
      return outcome;
    }
    if (isActiveHostUpdateJob(snapshot.job)) {
      const outcome: BulkUpdateOutcome = { state: "busy" };
      onProgress(outcome, snapshot);
      return outcome;
    }

    onProgress({ state: "checking" }, snapshot);
    snapshot = await client.requestHostUpdateCheck();
    const deadline = now() + timeout;
    while (snapshot.checkRequest !== null && now() < deadline) {
      await sleep(CHECK_POLL_MS);
      snapshot = await client.getHostMaintenance();
    }
    const answered = snapshot.checkRequest === null;
    if (answered && snapshot.updater.checkError) {
      const outcome: BulkUpdateOutcome = {
        state: "failed",
        error: `The check failed: ${snapshot.updater.checkError}`,
      };
      onProgress(outcome, snapshot);
      return outcome;
    }
    if (answered && snapshot.updater.updateAvailable === false) {
      const outcome: BulkUpdateOutcome = { state: "current", version: snapshot.version };
      onProgress(outcome, snapshot);
      return outcome;
    }

    // An unanswered check leaves the choice of release to the host, which
    // fails the job itself when nothing newer exists.
    const version = answered ? snapshot.updater.latestVersion : null;
    const result = await client.requestHostUpdate({
      ...(version ? { version } : {}),
      ...(options.drain === "when-idle"
        ? { drain: "when-idle" as const, maxWaitSeconds: options.maxWaitSeconds }
        : {}),
    });
    const outcome: BulkUpdateOutcome = { state: "requested", version };
    onProgress(outcome, result.snapshot);
    return outcome;
  } catch (error) {
    const outcome: BulkUpdateOutcome = { state: "failed", error: errorText(error) };
    onProgress(outcome, null);
    return outcome;
  }
}

export interface BulkUpdateTarget {
  key: string;
  client: HostMaintenanceClient;
  /**
   * The machine this window is served by. Its restart drops this page, so it
   * is asked only once every other machine has its request.
   */
  last: boolean;
}

/** Updates every target to its newest release; machines run side by side. */
export async function updateMachinesToLatest(
  targets: BulkUpdateTarget[],
  options: UpdateToLatestOptions,
  onProgress: (
    key: string,
    outcome: BulkUpdateOutcome,
    snapshot: HostMaintenanceSnapshot | null,
  ) => void,
): Promise<Map<string, BulkUpdateOutcome>> {
  const outcomes = new Map<string, BulkUpdateOutcome>();
  const run = async (target: BulkUpdateTarget) => {
    outcomes.set(
      target.key,
      await updateMachineToLatest(target.client, options, (outcome, snapshot) =>
        onProgress(target.key, outcome, snapshot),
      ),
    );
  };
  await Promise.all(targets.filter((target) => !target.last).map(run));
  for (const target of targets.filter((target) => target.last)) await run(target);
  return outcomes;
}

/** "Started on 2 machines · 1 already current · 1 failed". */
export function summarizeBulkUpdate(outcomes: Iterable<BulkUpdateOutcome>): string {
  const counts = { requested: 0, current: 0, busy: 0, skipped: 0, failed: 0 };
  for (const outcome of outcomes) {
    if (outcome.state !== "checking") counts[outcome.state] += 1;
  }
  const machines = (count: number) => `${count} machine${count === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (counts.requested) parts.push(`Started on ${machines(counts.requested)}`);
  if (counts.current) parts.push(`${counts.current} already current`);
  if (counts.busy) parts.push(`${counts.busy} already updating`);
  if (counts.skipped) parts.push(`${counts.skipped} cannot update`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
  return parts.join(" · ") || "Nothing to update";
}
