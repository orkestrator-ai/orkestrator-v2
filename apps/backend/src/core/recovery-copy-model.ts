import type {
  ContainerRuntimeIdentity,
  EnvironmentContainerLifecycle,
  RetainedStorageSet,
} from "@orkestrator/protocol/container-lifecycle";
import type { RecoveryCopy, RecoveryCopyReason } from "@orkestrator/protocol/container-recovery";

/**
 * Groups an environment's retained resources into recovery copies. A retained
 * runtime and the storage set it mounts are one copy (they were kept by the
 * same commit); a legacy runtime is a copy by itself (its writable layer is
 * the data); a storage set whose runtime is gone is a copy by itself. Pure:
 * presence and size come from Docker separately.
 */
export interface RecoveryCopyGroup {
  copyId: string;
  kind: RecoveryCopy["kind"];
  reason: RecoveryCopyReason;
  retainedAt: string | null;
  operationId: string | null;
  runtime: ContainerRuntimeIdentity | null;
  storage: RetainedStorageSet | null;
}

export function groupRecoveryCopies(record: EnvironmentContainerLifecycle): RecoveryCopyGroup[] {
  const storageById = new Map(
    (record.retainedStorage ?? []).map((entry) => [entry.storageSetId, entry]),
  );
  const claimed = new Set<string>();
  const groups: RecoveryCopyGroup[] = [];
  for (const runtime of record.retainedRuntimes ?? []) {
    const storage = runtime.storageSetId ? (storageById.get(runtime.storageSetId) ?? null) : null;
    if (storage) claimed.add(storage.storageSetId);
    groups.push({
      copyId: runtime.storageSetId ?? runtime.containerId,
      kind: runtime.storageSetId ? "storage-set" : "legacy-runtime",
      reason: runtime.retainedReason ?? storage?.reason ?? "rebuild-source",
      retainedAt: runtime.retainedAt ?? storage?.retainedAt ?? null,
      operationId: runtime.retainedByOperationId ?? storage?.operationId ?? null,
      runtime,
      storage,
    });
  }
  for (const storage of record.retainedStorage ?? []) {
    if (claimed.has(storage.storageSetId)) continue;
    groups.push({
      copyId: storage.storageSetId,
      kind: "storage-set",
      reason: storage.reason,
      retainedAt: storage.retainedAt,
      operationId: storage.operationId ?? null,
      runtime: null,
      storage,
    });
  }
  return groups;
}

/** The copy's identity fields, without Docker observations. */
export function describeRecoveryCopy(
  group: RecoveryCopyGroup,
): Omit<RecoveryCopy, "presence" | "sizeBytes" | "restorable"> {
  return {
    copyId: group.copyId,
    kind: group.kind,
    reason: group.reason,
    retainedAt: group.retainedAt,
    operationId: group.operationId,
    containerId: group.runtime?.containerId ?? null,
    storageSetId: group.storage?.storageSetId ?? group.runtime?.storageSetId ?? null,
    volumes: (group.storage?.volumes ?? []).map((volume) => volume.name),
    workspaceGeneration: group.storage?.workspaceGeneration ?? null,
  };
}
