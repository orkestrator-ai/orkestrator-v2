import {
  MAX_RETAINED_STORAGE_SETS,
  parseContainerLifecycle,
  type ContainerMutationIdentity,
  type ContainerRuntimeIdentity,
  type ContainerStorageIdentity,
  type EnvironmentContainerLifecycle,
} from "@orkestrator/protocol/container-lifecycle";
import type { RecoveryCopy, RecoveryCopyList } from "@orkestrator/protocol/container-recovery";
import {
  DOCKER_LABEL_ENVIRONMENT_ID,
  DOCKER_LABEL_OWNER,
  dockerOwnerNamespace,
  runCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import {
  ContainerLifecycleError,
  beginContainerOperation,
  completeContainerOperation,
  currentRuntimeIdentity,
  nextRuntimeGeneration,
  operationFailureCode,
  probeContainer,
  advanceContainerOperation,
  resolveContainerOwnership,
} from "./container-lifecycle-service.js";
import {
  inspectVolume,
  removeStorageVolumes,
  storageHelperFailureMessage,
  verifyStorageSet,
} from "./container-storage.js";
import { configuredImageRef, resolveDockerImage } from "./docker-image.js";
import { createDockerContainer } from "./commands-containers.js";
import { quiesceRuntime, rollbackCandidate } from "./container-replacement.js";
import {
  groupRecoveryCopies,
  describeRecoveryCopy,
  type RecoveryCopyGroup,
} from "./recovery-copy-model.js";
import { parseDockerPsSize } from "./docker-cleanup-inventory.js";

/**
 * Recovery copies: earlier runtimes and storage sets an environment keeps
 * after a rebuild, migration, reset or restore. They are kept until the user
 * discards them (no age-based expiry), counted against a per-environment cap
 * that blocks further rebuilds rather than evicting anything, and deleted with
 * the environment.
 */

function lifecycleError(
  code: ConstructorParameters<typeof ContainerLifecycleError>[0],
  message: string,
) {
  return new ContainerLifecycleError(code, message);
}

function readRecord(environment: Environment): EnvironmentContainerLifecycle {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) {
    throw lifecycleError(
      "unsupported-format",
      "This environment was changed by a newer version of Orkestrator.",
    );
  }
  return parsed.record;
}

async function requireEnvironment(
  context: Pick<CommandContext, "storage">,
  environmentId: string,
): Promise<Environment> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  return environment;
}

async function containerSize(containerId: string): Promise<number | null> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "ps",
        "-a",
        "--size",
        "--no-trunc",
        "--filter",
        `id=${containerId}`,
        "--format",
        "{{.Size}}",
      ],
      { timeoutMs: 60_000 },
    );
    return parseDockerPsSize(stdout.trim());
  } catch {
    return null;
  }
}

async function observeCopy(
  group: RecoveryCopyGroup,
  measureSize: boolean,
): Promise<Pick<RecoveryCopy, "presence" | "sizeBytes" | "restorable">> {
  const observations: Array<"present" | "missing" | "unknown"> = [];
  if (group.runtime) {
    const probe = await probeContainer(group.runtime.containerId);
    observations.push(
      probe.kind === "present" ? "present" : probe.kind === "missing" ? "missing" : "unknown",
    );
  }
  for (const volume of group.storage?.volumes ?? []) {
    const probe = await inspectVolume(volume.name);
    observations.push(
      probe.kind === "present" ? "present" : probe.kind === "missing" ? "missing" : "unknown",
    );
  }
  const presence: RecoveryCopy["presence"] = observations.includes("unknown")
    ? "unknown"
    : observations.every((entry) => entry === "present")
      ? "present"
      : observations.every((entry) => entry === "missing")
        ? "missing"
        : "partial";
  const expectedVolumes = group.storage?.volumes.length ?? 0;
  const restorable =
    group.reason !== "failed-candidate" &&
    (group.kind === "legacy-runtime"
      ? observations[0] === "present"
      : expectedVolumes >= 2 &&
        (group.storage?.volumes ?? []).length === expectedVolumes &&
        presence !== "missing" &&
        presence !== "unknown" &&
        // A storage copy needs every volume; its runtime is optional.
        observations.slice(group.runtime ? 1 : 0).every((entry) => entry === "present"));
  return {
    presence,
    sizeBytes:
      measureSize &&
      group.kind === "legacy-runtime" &&
      group.runtime &&
      observations[0] === "present"
        ? await containerSize(group.runtime.containerId)
        : null,
    restorable,
  };
}

export async function listRecoveryCopies(
  environmentId: string,
  context: Pick<CommandContext, "storage">,
  options: { measureSize?: boolean } = {},
): Promise<RecoveryCopyList> {
  const environment = await requireEnvironment(context, environmentId);
  const record = readRecord(environment);
  const copies: RecoveryCopy[] = [];
  for (const group of groupRecoveryCopies(record)) {
    copies.push({
      ...describeRecoveryCopy(group),
      ...(await observeCopy(group, options.measureSize ?? false)),
    });
  }
  return { environmentId, revision: record.revision, copies, limit: MAX_RETAINED_STORAGE_SETS };
}

function findCopy(record: EnvironmentContainerLifecycle, copyId: string): RecoveryCopyGroup {
  const group = groupRecoveryCopies(record).find((entry) => entry.copyId === copyId);
  if (!group) {
    throw lifecycleError(
      "revision-conflict",
      "That recovery copy is no longer listed for this environment. Review the list again.",
    );
  }
  return group;
}

export interface RecoveryCopyRequest extends ContainerMutationIdentity {
  environmentId: string;
  copyId: string;
}

export interface DiscardCopyResult {
  copyId: string;
  /** Resources still referenced because Docker did not remove them. */
  kept: { containerId: string | null; volumes: string[] };
  discarded: boolean;
}

/**
 * Permanently deletes one recovery copy. Each resource is removed only while
 * its labels still name this owner and environment; a volume in use is never
 * forced. Whatever does not remove stays referenced for a retry. Must run
 * inside the environment's lifecycle queue.
 */
export async function discardRecoveryCopy(
  request: RecoveryCopyRequest,
  context: CommandContext,
): Promise<DiscardCopyResult | undefined> {
  const environment = await requireEnvironment(context, request.environmentId);
  const group = findCopy(readRecord(environment), request.copyId);
  const admission = await beginContainerOperation(context, environment.id, "delete", {
    ...request,
    phase: "discarding-copy",
    details: { copyId: request.copyId },
  });
  if (admission.kind === "replayed") return undefined;
  const { operationId } = admission.operation;
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  let keptContainer: string | null = null;
  try {
    if (group.runtime) {
      const probe = await probeContainer(group.runtime.containerId);
      if (probe.kind === "present") {
        const labels = await containerLabels(group.runtime.containerId);
        const environmentLabel = labels[DOCKER_LABEL_ENVIRONMENT_ID];
        if (
          probe.labels[DOCKER_LABEL_OWNER] !== owner ||
          (environmentLabel !== undefined && environmentLabel !== environment.id)
        ) {
          keptContainer = group.runtime.containerId;
        } else {
          await runCommand("docker", ["rm", "-f", group.runtime.containerId], {
            timeoutMs: 60_000,
          }).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            if (!/no such (object|container)/i.test(message)) {
              keptContainer = group.runtime!.containerId;
            }
          });
        }
      } else if (probe.kind !== "missing") {
        keptContainer = group.runtime.containerId;
      }
    }
    const keptVolumes = group.storage
      ? ((await removeStorageVolumes(context, environment.id, {
          format: "volume-v1",
          workspaceGeneration: group.storage.workspaceGeneration,
          storageSetId: group.storage.storageSetId,
          volumes: group.storage.volumes,
        })) ?? [])
      : [];
    const discarded = !keptContainer && keptVolumes.length === 0;
    await completeContainerOperation(
      context,
      environment.id,
      operationId,
      discarded ? "succeeded" : "failed",
      {
        ...(discarded ? {} : { failureCode: "removal-failed" }),
        releaseRetained: {
          containerIds: group.runtime && !keptContainer ? [group.runtime.containerId] : [],
          storageSetIds:
            group.storage && keptVolumes.length === 0 ? [group.storage.storageSetId] : [],
        },
        ...(group.storage && keptVolumes.length > 0
          ? {
              keepRetainedVolumes: [
                { storageSetId: group.storage.storageSetId, volumes: keptVolumes },
              ],
            }
          : {}),
      },
    );
    return {
      copyId: request.copyId,
      kept: { containerId: keptContainer, volumes: keptVolumes.map((volume) => volume.name) },
      discarded,
    };
  } catch (error) {
    await completeContainerOperation(context, environment.id, operationId, "failed", {
      failureCode: operationFailureCode(error),
    }).catch(() => undefined);
    throw error;
  }
}

async function containerLabels(containerId: string): Promise<Record<string, string>> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["inspect", "-f", "{{json .Config.Labels}}", containerId],
      { timeoutMs: 10_000 },
    );
    const parsed = JSON.parse(stdout.trim() || "{}") as Record<string, unknown> | null;
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (typeof value === "string") labels[key] = value;
    }
    return labels;
  } catch {
    return {};
  }
}

/** The retained entries a runtime and its storage become. */
export function retainedEntriesFor(
  runtime: ContainerRuntimeIdentity | undefined,
  storage: ContainerStorageIdentity,
  reason: "workspace-reset" | "restore-source",
  operationId: string,
  now = new Date().toISOString(),
): {
  retainRuntime?: ContainerRuntimeIdentity;
  retainStorage?: NonNullable<EnvironmentContainerLifecycle["retainedStorage"]>[number];
} {
  const volumeBacked = storage.format === "volume-v1" && !!storage.storageSetId;
  return {
    ...(runtime
      ? {
          retainRuntime: {
            ...runtime,
            ...(volumeBacked ? { storageSetId: storage.storageSetId } : {}),
            retainedAt: now,
            retainedByOperationId: operationId,
            retainedReason: reason,
          },
        }
      : {}),
    ...(volumeBacked
      ? {
          retainStorage: {
            storageSetId: storage.storageSetId!,
            workspaceGeneration: storage.workspaceGeneration,
            volumes: storage.volumes ?? [],
            retainedAt: now,
            reason,
            operationId,
          },
        }
      : {}),
  };
}

/** Throws when another copy would exceed the per-environment cap. */
export function assertRecoveryCapacity(record: EnvironmentContainerLifecycle): void {
  if (groupRecoveryCopies(record).length >= MAX_RETAINED_STORAGE_SETS) {
    throw lifecycleError(
      "resource-exhausted",
      "This environment already keeps the maximum number of recovery copies. Discard old copies before keeping another.",
    );
  }
}

export interface RestoreCopyRequest extends RecoveryCopyRequest {
  /** The runtime the user reviewed; it becomes a recovery copy itself. */
  expectedContainerId: string | null;
}

/**
 * Makes a recovery copy the environment's workspace again. The current
 * runtime and storage are kept as a `restore-source` copy in the same commit,
 * so nothing current is lost. A retained runtime that still exists is swapped
 * back in; a storage set whose runtime is gone gets a new runtime from the
 * current image. Must run inside the lifecycle queue; the caller starts the
 * environment afterwards.
 */
export async function restoreRecoveryCopy(
  request: RestoreCopyRequest,
  context: CommandContext,
): Promise<{ containerId: string } | undefined> {
  const environment = await requireEnvironment(context, request.environmentId);
  if (environment.containerId !== request.expectedContainerId) {
    throw lifecycleError(
      "runtime-changed",
      "The container changed after it was reviewed. Review the environment again before restoring.",
    );
  }
  const record = readRecord(environment);
  const group = findCopy(record, request.copyId);
  const observed = await observeCopy(group, false);
  if (!observed.restorable) {
    throw lifecycleError(
      "needs-attention",
      "That recovery copy cannot be restored: some of its resources are missing, or it is an incomplete rebuild.",
    );
  }
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  let reuseRuntime = false;
  if (group.runtime) {
    const ownership = await resolveContainerOwnership(group.runtime.containerId, context);
    reuseRuntime = ownership.verdict === "owned";
    if (!reuseRuntime && group.kind === "legacy-runtime") {
      throw lifecycleError("not-owned", "The recovery copy's container could not be verified.");
    }
  }
  const current = currentRuntimeIdentity(environment, context);
  const admission = await beginContainerOperation(context, environment.id, "restore", {
    ...request,
    ...(current ? { source: current } : {}),
    details: { copyId: request.copyId },
  });
  if (admission.kind === "replayed") return undefined;
  const { operationId } = admission.operation;
  let createdCandidate = false;
  try {
    if (environment.containerId) {
      await advanceContainerOperation(context, environment.id, operationId, {
        phase: "quiescing",
        boot: { phase: "draining" },
      });
      await quiesceRuntime(environment.id, environment.containerId, current?.imageId, context);
      await advanceContainerOperation(context, environment.id, operationId, {
        phase: "source-stopped",
        boot: { phase: "stopped" },
        environment: { status: "stopped" },
      });
    }
    const copyStorage: ContainerStorageIdentity = group.storage
      ? {
          format: "volume-v1",
          workspaceGeneration: group.storage.workspaceGeneration,
          storageSetId: group.storage.storageSetId,
          volumes: group.storage.volumes,
        }
      : { format: "legacy-layer", workspaceGeneration: record.storage.workspaceGeneration };
    let target: ContainerRuntimeIdentity;
    if (reuseRuntime && group.runtime) {
      const {
        retainedAt: _at,
        retainedByOperationId: _by,
        retainedReason: _reason,
        storageSetId: _set,
        ...runtime
      } = group.runtime;
      target = runtime;
    } else {
      const image = await resolveDockerImage(configuredImageRef(context));
      if (image.kind !== "present") {
        throw lifecycleError("capability-unavailable", "The environment image is not available.");
      }
      const verified = await verifyStorageSet(context, image.imageId, environment.id, copyStorage);
      if (!verified.ok) {
        throw lifecycleError("needs-attention", storageHelperFailureMessage(verified));
      }
      const runtimeGeneration = nextRuntimeGeneration(environment);
      await advanceContainerOperation(context, environment.id, operationId, {
        phase: "candidate-prepared",
        details: { generation: runtimeGeneration },
      });
      createdCandidate = true;
      const containerId = await createDockerContainer(environment, context, {
        operationId,
        runtimeGeneration,
        imageId: image.imageId,
        storage: copyStorage,
      });
      target = {
        containerId,
        runtimeGeneration,
        owner,
        imageRef: image.imageRef,
        imageId: image.imageId,
        createdByOperationId: operationId,
      };
    }
    const retained = retainedEntriesFor(current, record.storage, "restore-source", operationId);
    await completeContainerOperation(context, environment.id, operationId, "succeeded", {
      phase: "committed",
      runtime: target,
      storage: copyStorage,
      releaseRetained: {
        containerIds: group.runtime ? [group.runtime.containerId] : [],
        storageSetIds: group.storage ? [group.storage.storageSetId] : [],
      },
      ...retained,
      boot: { phase: "stopped" },
      environment: { containerId: target.containerId, status: "stopped", lifecycleError: null },
    });
    await context.storage.clearBackendTerminalSessionIds?.(environment.id);
    return { containerId: target.containerId };
  } catch (error) {
    if (createdCandidate) {
      // Only a runtime this operation created is removed; the copy's storage
      // and the original are never touched by the rollback.
      await rollbackCandidate(context, environment.id, operationId, undefined).catch(
        () => undefined,
      );
    }
    await completeContainerOperation(context, environment.id, operationId, "failed", {
      failureCode: operationFailureCode(error),
    }).catch(() => undefined);
    throw error;
  }
}
