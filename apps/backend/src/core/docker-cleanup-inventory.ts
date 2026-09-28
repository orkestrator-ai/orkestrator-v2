import {
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_OWNER,
  dockerOwnerNamespace,
  runCommand,
} from "./commands-dependencies.js";
import { environmentCleanupLedger } from "./environment-cleanup-ledger.js";
import { environmentLifecycleOperations, environmentStartTasks } from "./commands-runtime-state.js";
import { containerIdMatches } from "./commands-review.js";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";

/**
 * Why a container is not offered for routine cleanup. Absence of a reason is
 * the only thing that makes a container a candidate: stopped status, age or
 * the lack of an open tab never do, because a stopped environment's container
 * is still the only copy of its workspace.
 */
export type CleanupExclusionReason =
  | "assigned"
  | "retained-recovery"
  | "live-environment-label"
  | "operation-in-flight"
  | "deletion-pending"
  | "running"
  | "foreign-owner"
  | "identity-uncertain"
  | "legacy-unadopted";

export interface CleanupInventoryRow {
  containerId: string;
  name: string;
  state: string;
  /** Environment id from the container's label, when it has one. */
  environmentId: string | null;
  /** Writable-layer bytes when the listing measured them. */
  sizeBytes: number | null;
  exclusion: CleanupExclusionReason | null;
}

export type CleanupOutcomeKind = "removed" | "already-absent" | "skipped" | "failed";

export interface CleanupOutcome {
  containerId: string;
  outcome: CleanupOutcomeKind;
  /** Exclusion that appeared between the inventory and the removal. */
  reason?: CleanupExclusionReason | "state-changed" | "removal-failed";
}

export interface CleanupRunResult {
  removed: number;
  alreadyAbsent: number;
  skipped: number;
  failed: number;
  outcomes: CleanupOutcome[];
  /** Bytes of the writable layers actually removed, when measured. */
  reclaimedBytes: number;
}

type CleanupContext = Pick<CommandContext, "storage" | "strictDockerOwner">;

/** Upper bound on containers examined in one cleanup; the rest wait for the next. */
export const MAX_CLEANUP_CANDIDATES = 500;

const STOPPED_STATES = new Set(["created", "exited", "dead"]);

interface ListedContainer {
  id: string;
  name: string;
  state: string;
  labels: Record<string, string>;
  sizeBytes: number | null;
}

export function parseLabels(value: unknown): Record<string, string> {
  if (typeof value !== "string") return {};
  const labels: Record<string, string> = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    labels[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return labels;
}

/** `12.3kB (virtual 2.1GB)` → bytes of the writable layer. */
export function parseDockerPsSize(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?b)/i.exec(value);
  if (!match) return null;
  const power = ["b", "kb", "mb", "gb", "tb", "pb"].indexOf(match[2]!.toLowerCase());
  if (power < 0) return null;
  return Math.round(Number(match[1]) * 1000 ** power);
}

async function listAppContainers(options: { measureSize: boolean }): Promise<ListedContainer[]> {
  const { stdout } = await runCommand(
    "docker",
    [
      "ps",
      "-a",
      "--no-trunc",
      ...(options.measureSize ? ["--size"] : []),
      "--filter",
      `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
      "--format",
      "{{json .}}",
    ],
    { timeoutMs: options.measureSize ? 120_000 : 20_000 },
  );
  const rows: ListedContainer[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = typeof row.ID === "string" ? row.ID : "";
    if (!id) continue;
    rows.push({
      id,
      name: typeof row.Names === "string" ? row.Names : "",
      state: typeof row.State === "string" ? row.State.toLowerCase() : "",
      labels: parseLabels(row.Labels),
      sizeBytes: options.measureSize ? parseDockerPsSize(row.Size) : null,
    });
    if (rows.length >= MAX_CLEANUP_CANDIDATES) break;
  }
  return rows;
}

export interface ProtectionSnapshot {
  environments: Environment[];
  environmentIds: Set<string>;
  deletionContainerIds: string[];
  deletionEnvironmentIds: Set<string>;
  /** Earlier runtimes kept as recovery copies by live environments. */
  retainedContainerIds: string[];
  /** Volumes a live environment mounts now. */
  currentVolumes: Set<string>;
  /** Volumes of recovery copies. */
  retainedVolumes: Set<string>;
  /** Candidate volumes of unresolved operations. */
  operationVolumes: Set<string>;
  /** Volumes a pending deletion still owes. */
  deletionVolumes: Set<string>;
}

export async function loadProtection(context: CleanupContext): Promise<ProtectionSnapshot> {
  const environments = await context.storage.loadEnvironments();
  const ledger = await environmentCleanupLedger(context.storage.getDataDir())
    .list()
    .catch(() => null);
  if (!ledger) {
    // A ledger that cannot be read may name a container whose deletion is
    // still owed; nothing is safe to classify without it.
    throw new Error("Cleanup refused: the environment deletion ledger could not be read");
  }
  const owesContainer = ledger.filter((entry) => entry.pending.includes("container"));
  const retainedContainerIds: string[] = [];
  const currentVolumes = new Set<string>();
  const retainedVolumes = new Set<string>();
  const operationVolumes = new Set<string>();
  for (const environment of environments) {
    const parsed = parseContainerLifecycle(environment.containerLifecycle);
    if (!parsed.supported) {
      // A record this version cannot read may reference anything; protect
      // every resource labelled for it through the live-environment rule.
      continue;
    }
    const record = parsed.record;
    for (const volume of record.storage.volumes ?? []) currentVolumes.add(volume.name);
    for (const runtime of record.retainedRuntimes ?? []) {
      retainedContainerIds.push(runtime.containerId);
    }
    for (const retained of record.retainedStorage ?? []) {
      for (const volume of retained.volumes) retainedVolumes.add(volume.name);
    }
    for (const volume of record.operation?.candidateStorage?.volumes ?? []) {
      operationVolumes.add(volume.name);
    }
  }
  return {
    environments,
    environmentIds: new Set(environments.map((environment) => environment.id)),
    deletionContainerIds: owesContainer.flatMap((entry) => [
      ...(entry.containerId ? [entry.containerId] : []),
      ...(entry.retainedContainers ?? []),
    ]),
    deletionEnvironmentIds: new Set(
      ledger
        .filter((entry) => entry.pending.includes("container") || entry.pending.includes("volumes"))
        .map((entry) => entry.environmentId),
    ),
    retainedContainerIds,
    currentVolumes,
    retainedVolumes,
    operationVolumes,
    deletionVolumes: new Set(
      ledger.filter((entry) => entry.pending.includes("volumes")).flatMap((entry) => entry.volumes),
    ),
  };
}

function operationInFlight(environmentId: string | null): boolean {
  if (!environmentId) return false;
  return (
    environmentLifecycleOperations.has(environmentId) || environmentStartTasks.has(environmentId)
  );
}

export function classify(
  container: Pick<ListedContainer, "id" | "state" | "labels">,
  protection: ProtectionSnapshot,
  owner: string,
  options: { includeRunning: boolean; strictDockerOwner: boolean },
): CleanupExclusionReason | null {
  // Only this app writes its label; a container without it was not created
  // here, whatever id the caller supplied.
  if (container.labels[DOCKER_LABEL_APP] !== DOCKER_LABEL_APP_VALUE) return "foreign-owner";
  const ownerLabel = container.labels[DOCKER_LABEL_OWNER];
  if (ownerLabel !== undefined && ownerLabel !== owner) return "foreign-owner";
  if (ownerLabel === undefined && options.strictDockerOwner) return "foreign-owner";
  // A container from before owner labels could belong to any installation on
  // this daemon. It is listed for the user to adopt, never removed as clutter.
  if (ownerLabel === undefined) return "legacy-unadopted";
  const labelledEnvironmentId = container.labels[DOCKER_LABEL_ENVIRONMENT_ID] ?? null;
  if (
    protection.environments.some(
      (environment) =>
        environment.containerId && containerIdMatches(environment.containerId, container.id),
    )
  ) {
    return "assigned";
  }
  if (protection.retainedContainerIds.some((id) => containerIdMatches(id, container.id))) {
    return "retained-recovery";
  }
  if (
    protection.deletionContainerIds.some((id) => containerIdMatches(id, container.id)) ||
    (labelledEnvironmentId && protection.deletionEnvironmentIds.has(labelledEnvironmentId))
  ) {
    return "deletion-pending";
  }
  if (labelledEnvironmentId && protection.environmentIds.has(labelledEnvironmentId)) {
    // The record is live but does not reference this container: an interrupted
    // create, or a replacement whose pointer was never written. The container
    // may hold that environment's work, so it is never garbage by default.
    return "live-environment-label";
  }
  if (operationInFlight(labelledEnvironmentId)) return "operation-in-flight";
  if (!container.state) return "identity-uncertain";
  if (!options.includeRunning && !STOPPED_STATES.has(container.state)) return "running";
  return null;
}

/**
 * Enumerates this registry's containers and classifies each one. Only rows
 * with `exclusion: null` may be removed by routine cleanup.
 */
export async function listContainerCleanupInventory(
  context: CleanupContext,
  options: { includeRunning: boolean; measureSize?: boolean },
): Promise<CleanupInventoryRow[]> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  const [containers, protection] = await Promise.all([
    listAppContainers({ measureSize: options.measureSize ?? false }),
    loadProtection(context),
  ]);
  return containers.map((container) => ({
    containerId: container.id,
    name: container.name,
    state: container.state,
    environmentId: container.labels[DOCKER_LABEL_ENVIRONMENT_ID] ?? null,
    sizeBytes: container.sizeBytes,
    exclusion: classify(container, protection, owner, {
      includeRunning: options.includeRunning,
      strictDockerOwner: Boolean(context.strictDockerOwner),
    }),
  }));
}

async function inspectForRemoval(
  containerId: string,
): Promise<{ state: string; labels: Record<string, string> } | "absent"> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", "{{.State.Status}}\t{{json .Config.Labels}}", containerId],
      { timeoutMs: 10_000 },
    );
    const [state = "", labelsJson = "{}"] = stdout.trim().split("\t", 2);
    const parsed = JSON.parse(labelsJson) as unknown;
    const labels: Record<string, string> = {};
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") labels[key] = value;
      }
    }
    return { state: state.toLowerCase(), labels };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such (object|container)/i.test(message)) return "absent";
    throw error;
  }
}

/**
 * Removes exactly the given candidates, re-checking each one's identity and
 * assignment immediately before removal. A container that became assigned,
 * gained a live operation or changed state since the inventory is skipped.
 */
export async function removeCleanupCandidates(
  candidates: readonly CleanupInventoryRow[],
  context: CleanupContext,
  options: { includeRunning: boolean },
): Promise<CleanupRunResult> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  const result: CleanupRunResult = {
    removed: 0,
    alreadyAbsent: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
    reclaimedBytes: 0,
  };
  const record = (outcome: CleanupOutcome, sizeBytes: number | null = null) => {
    result.outcomes.push(outcome);
    if (outcome.outcome === "removed") {
      result.removed += 1;
      result.reclaimedBytes += sizeBytes ?? 0;
    } else if (outcome.outcome === "already-absent") result.alreadyAbsent += 1;
    else if (outcome.outcome === "skipped") result.skipped += 1;
    else result.failed += 1;
  };

  for (const candidate of candidates) {
    if (candidate.exclusion) {
      record({
        containerId: candidate.containerId,
        outcome: "skipped",
        reason: candidate.exclusion,
      });
      continue;
    }
    let current: Awaited<ReturnType<typeof inspectForRemoval>>;
    let protection: ProtectionSnapshot;
    try {
      [current, protection] = await Promise.all([
        inspectForRemoval(candidate.containerId),
        loadProtection(context),
      ]);
    } catch {
      record({ containerId: candidate.containerId, outcome: "failed", reason: "removal-failed" });
      continue;
    }
    if (current === "absent") {
      record({ containerId: candidate.containerId, outcome: "already-absent" });
      continue;
    }
    const exclusion = classify(
      { id: candidate.containerId, state: current.state, labels: current.labels },
      protection,
      owner,
      {
        includeRunning: options.includeRunning,
        strictDockerOwner: Boolean(context.strictDockerOwner),
      },
    );
    if (exclusion) {
      record({ containerId: candidate.containerId, outcome: "skipped", reason: exclusion });
      continue;
    }
    if (!options.includeRunning && current.state !== candidate.state) {
      record({ containerId: candidate.containerId, outcome: "skipped", reason: "state-changed" });
      continue;
    }
    try {
      // Without -f Docker refuses a container that started after the recheck,
      // which is exactly the race this must not win.
      await runCommand(
        "docker",
        ["rm", ...(options.includeRunning ? ["-f"] : []), candidate.containerId],
        { timeoutMs: 60_000 },
      );
      record({ containerId: candidate.containerId, outcome: "removed" }, candidate.sizeBytes);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such (object|container)/i.test(message)) {
        record({ containerId: candidate.containerId, outcome: "already-absent" });
      } else {
        record({ containerId: candidate.containerId, outcome: "failed", reason: "removal-failed" });
      }
    }
  }
  return result;
}

/**
 * Removes one explicitly selected container only if nothing claims it. The
 * same classification as routine cleanup applies, evaluated at removal time.
 */
export async function removeUnclaimedContainer(
  containerId: string,
  context: CleanupContext,
): Promise<CleanupOutcome> {
  const result = await removeCleanupCandidates(
    [
      {
        containerId,
        name: "",
        state: "",
        environmentId: null,
        sizeBytes: null,
        exclusion: null,
      },
    ],
    context,
    { includeRunning: true },
  );
  return result.outcomes[0] ?? { containerId, outcome: "failed", reason: "removal-failed" };
}

/** All labels of one container; empty when it cannot be read. */
export async function readContainerLabels(containerId: string): Promise<Record<string, string>> {
  const current = await inspectForRemoval(containerId).catch(() => "absent" as const);
  return current === "absent" ? {} : current.labels;
}
