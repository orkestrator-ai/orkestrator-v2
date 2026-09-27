import { createHash, randomUUID } from "node:crypto";
import type {
  CleanupClassification,
  CleanupExecuteResult,
  CleanupPreview,
  CleanupPreviewRow,
  CleanupResourceOutcome,
} from "@orkestrator/protocol/container-recovery";
import {
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_RESOURCE_ROLE,
  dockerOwnerNamespace,
  runCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import {
  MAX_CLEANUP_CANDIDATES,
  listContainerCleanupInventory,
  loadProtection,
  parseLabels,
  removeCleanupCandidates,
  type ProtectionSnapshot,
} from "./docker-cleanup-inventory.js";
import { environmentLifecycleOperations, environmentStartTasks } from "./commands-runtime-state.js";
import { inspectVolume } from "./container-storage.js";

/**
 * Reviewed cleanup: a preview enumerates this registry's containers and
 * volumes, classifies each one, and binds the eligible set to a short-lived
 * selection token. Execution removes only resources the user selected from
 * that exact set, re-checking each one's identity and references at removal
 * time. A resource that became eligible after the preview is not added; a new
 * preview is needed. Nothing here prunes by owner, age or state alone.
 */

type CleanupContext = Pick<CommandContext, "storage" | "strictDockerOwner">;

const TOKEN_TTL_MS = 10 * 60_000;
const MAX_TOKENS = 8;

interface PreviewGrant {
  owner: string;
  expiresAt: number;
  containers: Map<string, { sizeBytes: number | null; state: string }>;
  volumes: Set<string>;
}

const grants = new Map<string, PreviewGrant>();

function pruneGrants(now: number): void {
  for (const [token, grant] of Array.from(grants)) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
  while (grants.size >= MAX_TOKENS) {
    const oldest = grants.keys().next().value;
    if (oldest === undefined) break;
    grants.delete(oldest);
  }
}

/** Test seam. */
export function resetCleanupGrants(): void {
  grants.clear();
}

interface ListedVolume {
  name: string;
  labels: Record<string, string>;
}

async function listAppVolumes(): Promise<ListedVolume[]> {
  const { stdout } = await runCommand(
    "docker",
    [
      "volume",
      "ls",
      "--filter",
      `label=${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
      "--format",
      "{{json .}}",
    ],
    { timeoutMs: 20_000 },
  );
  const volumes: ListedVolume[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (typeof row.Name !== "string" || !row.Name) continue;
      volumes.push({ name: row.Name, labels: parseLabels(row.Labels) });
    } catch {
      continue;
    }
    if (volumes.length >= MAX_CLEANUP_CANDIDATES) break;
  }
  return volumes;
}

function operationInFlight(environmentId: string | null): boolean {
  return (
    !!environmentId &&
    (environmentLifecycleOperations.has(environmentId) || environmentStartTasks.has(environmentId))
  );
}

/**
 * Only a volume this registry labelled for an environment that no longer
 * exists, and that nothing (current storage, recovery copy, unresolved
 * operation or pending deletion) references, is eligible.
 */
export function classifyVolume(
  volume: ListedVolume,
  protection: ProtectionSnapshot,
  owner: string,
): CleanupClassification {
  if (volume.labels[DOCKER_LABEL_APP] !== DOCKER_LABEL_APP_VALUE) return "foreign-owner";
  if (volume.labels[DOCKER_LABEL_OWNER] !== owner) return "foreign-owner";
  if (protection.currentVolumes.has(volume.name)) return "assigned";
  if (protection.retainedVolumes.has(volume.name)) return "retained-recovery";
  if (protection.operationVolumes.has(volume.name)) return "operation-in-flight";
  if (protection.deletionVolumes.has(volume.name)) return "deletion-pending";
  const environmentId = volume.labels[DOCKER_LABEL_ENVIRONMENT_ID] ?? null;
  if (!environmentId) return "identity-uncertain";
  if (protection.deletionEnvironmentIds.has(environmentId)) return "deletion-pending";
  if (protection.environmentIds.has(environmentId)) return "live-environment-label";
  if (operationInFlight(environmentId)) return "operation-in-flight";
  return "eligible";
}

export async function previewDockerCleanup(context: CleanupContext): Promise<CleanupPreview> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  const [containers, volumes, protection] = await Promise.all([
    listContainerCleanupInventory(context, { includeRunning: false, measureSize: true }),
    listAppVolumes(),
    loadProtection(context),
  ]);
  const rows: CleanupPreviewRow[] = [];
  const grant: PreviewGrant = {
    owner,
    expiresAt: Date.now() + TOKEN_TTL_MS,
    containers: new Map(),
    volumes: new Set(),
  };
  for (const container of containers) {
    const classification: CleanupClassification = container.exclusion ?? "eligible";
    // Another profile's resources are not even listed.
    if (classification === "foreign-owner") continue;
    rows.push({
      kind: "container",
      id: container.containerId,
      name: container.name,
      environmentId: container.environmentId,
      role: container.state || null,
      sizeBytes: container.sizeBytes,
      classification,
    });
    if (classification === "eligible") {
      grant.containers.set(container.containerId, {
        sizeBytes: container.sizeBytes,
        state: container.state,
      });
    }
  }
  for (const volume of volumes) {
    const classification = classifyVolume(volume, protection, owner);
    if (classification === "foreign-owner") continue;
    rows.push({
      kind: "volume",
      id: volume.name,
      name: volume.name,
      environmentId: volume.labels[DOCKER_LABEL_ENVIRONMENT_ID] ?? null,
      role: volume.labels[DOCKER_LABEL_RESOURCE_ROLE] ?? null,
      sizeBytes: null,
      classification,
    });
    if (classification === "eligible") grant.volumes.add(volume.name);
  }
  const now = Date.now();
  pruneGrants(now);
  const selectionToken = createHash("sha256")
    .update(randomUUID())
    .update(owner)
    .digest("hex")
    .slice(0, 32);
  grants.set(selectionToken, grant);
  return {
    selectionToken,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    rows,
    truncated:
      containers.length >= MAX_CLEANUP_CANDIDATES || volumes.length >= MAX_CLEANUP_CANDIDATES,
  };
}

export interface CleanupSelection {
  selectionToken: string;
  containerIds: string[];
  volumeNames: string[];
}

function tally(outcomes: CleanupResourceOutcome[], reclaimedBytes: number): CleanupExecuteResult {
  const count = (kind: CleanupResourceOutcome["outcome"]) =>
    outcomes.filter((entry) => entry.outcome === kind).length;
  return {
    outcomes,
    removed: count("removed"),
    alreadyAbsent: count("already-absent"),
    skipped: count("skipped"),
    conflicts: count("conflict"),
    failed: count("failed"),
    reclaimedBytes,
  };
}

/**
 * Removes the selected resources of one preview. The token is consumed: a
 * second execution needs a new preview. Containers go first so a volume a
 * removed container mounted can then be removed; a volume still in use by
 * anything is skipped, never forced.
 */
export async function executeDockerCleanup(
  selection: CleanupSelection,
  context: CleanupContext,
): Promise<CleanupExecuteResult> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  pruneGrants(Date.now());
  const grant = grants.get(selection.selectionToken);
  if (!grant || grant.owner !== owner) {
    throw new Error(
      "ContainerLifecycleError:revision-conflict: The cleanup review expired. Review the resources again.",
    );
  }
  grants.delete(selection.selectionToken);
  const outcomes: CleanupResourceOutcome[] = [];

  const containers = [...new Set(selection.containerIds)];
  const approved = containers.filter((id) => grant.containers.has(id));
  for (const id of containers) {
    if (!grant.containers.has(id)) {
      outcomes.push({ kind: "container", id, outcome: "conflict", reason: "not-in-preview" });
    }
  }
  const containerResult = await removeCleanupCandidates(
    approved.map((containerId) => ({
      containerId,
      name: "",
      // The state reviewed; the recheck refuses a container whose state
      // changed since (for example one that started).
      state: grant.containers.get(containerId)?.state ?? "",
      environmentId: null,
      sizeBytes: grant.containers.get(containerId)?.sizeBytes ?? null,
      exclusion: null,
    })),
    context,
    { includeRunning: false },
  );
  for (const outcome of containerResult.outcomes) {
    outcomes.push({
      kind: "container",
      id: outcome.containerId,
      outcome:
        outcome.outcome === "skipped" && outcome.reason && outcome.reason !== "state-changed"
          ? "conflict"
          : outcome.outcome,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
    });
  }

  for (const name of new Set(selection.volumeNames)) {
    if (!grant.volumes.has(name)) {
      outcomes.push({ kind: "volume", id: name, outcome: "conflict", reason: "not-in-preview" });
      continue;
    }
    const probe = await inspectVolume(name);
    if (probe.kind === "missing") {
      outcomes.push({ kind: "volume", id: name, outcome: "already-absent" });
      continue;
    }
    if (probe.kind === "unreachable") {
      outcomes.push({ kind: "volume", id: name, outcome: "failed", reason: "removal-failed" });
      continue;
    }
    const classification = classifyVolume(
      { name, labels: probe.labels },
      await loadProtection(context),
      owner,
    );
    if (classification !== "eligible") {
      outcomes.push({ kind: "volume", id: name, outcome: "conflict", reason: classification });
      continue;
    }
    try {
      await runCommand("docker", ["volume", "rm", name], { timeoutMs: 60_000 });
      outcomes.push({ kind: "volume", id: name, outcome: "removed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/no such volume/i.test(message)) {
        outcomes.push({ kind: "volume", id: name, outcome: "already-absent" });
      } else if (/in use/i.test(message)) {
        outcomes.push({ kind: "volume", id: name, outcome: "skipped", reason: "in-use" });
      } else {
        outcomes.push({ kind: "volume", id: name, outcome: "failed", reason: "removal-failed" });
      }
    }
  }
  return tally(outcomes, containerResult.reclaimedBytes);
}
