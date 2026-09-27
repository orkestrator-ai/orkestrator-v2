import { withEnvironmentReplacement } from "./container-readiness.js";
import { withContainerAdmission } from "./container-admission.js";
import {
  MAX_RETAINED_STORAGE_SETS,
  formatContainerLifecycleError,
  parseContainerLifecycle,
  type ContainerMutationIdentity,
  type ContainerRuntimeIdentity,
  type ContainerStorageIdentity,
  type EnvironmentContainerLifecycle,
  type RebuildPreview,
  type RebuildUnavailableReason,
} from "@orkestrator/protocol/container-lifecycle";
import {
  DOCKER_LABEL_APP,
  DOCKER_LABEL_APP_VALUE,
  DOCKER_LABEL_OWNER,
  DOCKER_LABEL_RESOURCE_ROLE,
  dockerOwnerNamespace,
  runCommand,
  shutdownClaudeStatePolling,
  spawnCommand,
} from "./commands-dependencies.js";
import type { CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";
import {
  ContainerLifecycleError,
  advanceContainerOperation,
  beginContainerOperation,
  completeContainerOperation,
  currentRuntimeIdentity,
  findOperationContainers,
  nextRuntimeGeneration,
  operationFailureCode,
  resolveContainerOwnership,
} from "./container-lifecycle-service.js";
import {
  ensureStorageVolumes,
  initializeStorageSet,
  planStorageSet,
  removeStorageVolumes,
  replacementAdmissionPaused,
  selectStorageFormat,
  storageHelperFailureMessage,
  STORAGE_HELPER_ROLE,
} from "./container-storage.js";
import { PROVIDER_PRESERVATION, PROVIDER_STATE_LAYOUT } from "./container-state-layout.js";
import { groupRecoveryCopies } from "./recovery-copy-model.js";
import {
  containerStopWasForced,
  drainContainerProcesses,
  waitForContainerBoot,
  withEnvironmentDraining,
} from "./container-readiness.js";
import {
  configuredImageRef,
  detectDockerTopology,
  imageCapabilities,
  resolveDockerImage,
} from "./docker-image.js";
import { createDockerContainer } from "./commands-containers.js";
import { containerGitFetchPolicy } from "./commands-runtime-state.js";
import { stopEnvironmentReviewValidation } from "./review-validation-service.js";
import { stopEnvironmentExecWorkers } from "./public-api/exec-control.js";
import { parseDockerPsSize } from "./docker-cleanup-inventory.js";

/**
 * Transactional runtime replacement that preserves the workspace and the
 * declared provider state.
 *
 * Docker and backend storage cannot share a transaction, so replacement is a
 * durable sequence of idempotent phases, each persisted before its effect.
 * The only logical commit is one storage write that moves the runtime and
 * storage pointers together. Before it, the original runtime and its data are
 * untouched (only stopped) and any failure removes the incomplete candidate;
 * after it, the candidate is authoritative and the original is kept stopped as
 * a recovery copy until the user retires it.
 *
 * The candidate always gets a new storage set — a copy — so candidate setup can
 * never corrupt the only pre-rebuild copy, and old and candidate workloads are
 * never writers at the same time: the source is stopped before copying.
 */

export type ReplacementKind = "migrate" | "rebuild";

export interface ReplacementRequest extends ContainerMutationIdentity {
  environmentId: string;
  /** The runtime the user reviewed; a different one conflicts. */
  expectedContainerId: string;
  /** Proceed even when free space on the daemon cannot be measured. */
  allowUnknownCapacity?: boolean;
}

export const REPLACEMENT_PHASES = [
  "requested",
  "preflight",
  "quiescing",
  "source-stopped",
  "copying",
  "verified",
  "candidate-prepared",
  "candidate-healthy",
  "committed",
] as const;

/** Largest amount of work one copy step may take. */
const COPY_TIMEOUT_MS = 60 * 60_000;
/** Capacity headroom on top of the estimated copy size. */
const CAPACITY_HEADROOM_BYTES = 512 * 1024 * 1024;

/** Operations whose user asked to stop before commit. */
const cancellationRequests = new Set<string>();

export function requestReplacementCancellation(operationId: string): void {
  cancellationRequests.add(operationId);
}

class ReplacementCancelled extends Error {
  constructor() {
    super(formatContainerLifecycleError("operation-unknown", "The rebuild was cancelled."));
  }
}

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

// ---------------------------------------------------------------------------
// Copy plan
// ---------------------------------------------------------------------------

export interface CopyStep {
  /** Path in a stopped legacy container, or a source volume role. */
  source: { kind: "container-path"; path: string } | { kind: "volume"; role: string };
  /** Destination role and directory inside the candidate volume. */
  target: { role: "workspace" | "state"; subdir: string };
  /** Wildcards selecting members (legacy relocations only). */
  select?: string[];
}

/**
 * What a replacement copies. A volume-backed source copies both whole volumes.
 * A legacy source copies `/workspace` and every provider state path from the
 * stopped container's filesystem, relocating the SQLite stores that the
 * persistent layout moves out of their home roots.
 */
export function replacementCopyPlan(sourceFormat: ContainerStorageIdentity["format"]): CopyStep[] {
  if (sourceFormat === "volume-v1") {
    return [
      { source: { kind: "volume", role: "workspace" }, target: { role: "workspace", subdir: "" } },
      { source: { kind: "volume", role: "state" }, target: { role: "state", subdir: "" } },
    ];
  }
  const steps: CopyStep[] = [
    {
      source: { kind: "container-path", path: "/workspace" },
      target: { role: "workspace", subdir: "" },
    },
  ];
  for (const entry of PROVIDER_STATE_LAYOUT) {
    if (entry.subdir === "codex/sqlite") {
      steps.push({
        source: { kind: "container-path", path: "/home/node/.codex" },
        target: { role: "state", subdir: entry.subdir },
        select: [".codex/*.sqlite", ".codex/*.sqlite-wal", ".codex/*.sqlite-shm"],
      });
    } else if (entry.subdir === "opencode/db") {
      steps.push({
        source: { kind: "container-path", path: "/home/node/.local/share/opencode" },
        target: { role: "state", subdir: entry.subdir },
        select: ["opencode/opencode.db", "opencode/opencode.db-wal", "opencode/opencode.db-shm"],
      });
    } else {
      steps.push({
        source: { kind: "container-path", path: entry.containerPath },
        target: { role: "state", subdir: entry.subdir },
      });
    }
  }
  return steps;
}

export type CopyResult =
  | { ok: true; files: number; bytes: number; absent?: boolean }
  | { ok: false; reason: string };

export function parseCopyOutput(output: string): CopyResult {
  const match = /ORKESTRATOR_COPY status=([a-z-]+)((?: [a-z_]+=\S+)*)/.exec(output);
  if (!match) return { ok: false, reason: "helper-failed" };
  const fields = Object.fromEntries(
    (match[2] ?? "")
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((pair) => pair.split("=") as [string, string]),
  );
  if (match[1] !== "ok") {
    return {
      ok: false,
      reason: fields.kind ? `${match[1]}:${fields.kind}` : (match[1] ?? "failed"),
    };
  }
  return { ok: true, files: Number(fields.files ?? 0), bytes: Number(fields.bytes ?? 0) };
}

function helperArguments(
  context: Pick<CommandContext, "storage">,
  imageId: string,
  mounts: string[],
  script: string[],
  interactive: boolean,
): string[] {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  return [
    "run",
    "--rm",
    ...(interactive ? ["-i"] : []),
    "--network",
    "none",
    "--user",
    "root",
    "--label",
    `${DOCKER_LABEL_APP}=${DOCKER_LABEL_APP_VALUE}`,
    "--label",
    `${DOCKER_LABEL_OWNER}=${owner}`,
    "--label",
    `${DOCKER_LABEL_RESOURCE_ROLE}=${STORAGE_HELPER_ROLE}`,
    "--entrypoint",
    "/usr/local/bin/orkestrator-migrate.sh",
    ...mounts,
    imageId,
    ...script,
  ];
}

/**
 * Streams `docker cp <container>:<path> -` into a helper's stdin. Bounded by a
 * deadline; the producer's "could not find" is reported as an absent path
 * (nothing to preserve), not a failure.
 */
async function pipeContainerPath(
  containerId: string,
  sourcePath: string,
  consumerArgs: string[],
): Promise<{ absent: true } | { absent: false; output: string; producerFailed: boolean }> {
  return new Promise((resolve) => {
    const producer = spawnCommand("docker", ["cp", `${containerId}:${sourcePath}`, "-"]);
    const consumer = spawnCommand("docker", consumerArgs);
    let producerErr = "";
    let output = "";
    let producerCode: number | null = null;
    let consumerCode: number | null = null;
    const timer = setTimeout(() => {
      producer.kill("SIGKILL");
      consumer.kill("SIGKILL");
    }, COPY_TIMEOUT_MS);
    producer.stdout.pipe(consumer.stdin);
    consumer.stdin.on("error", () => undefined);
    producer.stderr.on("data", (chunk: Buffer) => {
      if (producerErr.length < 4096) producerErr += chunk.toString();
    });
    consumer.stdout.on("data", (chunk: Buffer) => {
      if (output.length < 16_384) output += chunk.toString();
    });
    consumer.stderr.on("data", () => undefined);
    const finish = () => {
      if (producerCode === null || consumerCode === null) return;
      clearTimeout(timer);
      if (producerCode !== 0 && /could not find the file|no such file/i.test(producerErr)) {
        resolve({ absent: true });
        return;
      }
      resolve({ absent: false, output, producerFailed: producerCode !== 0 });
    };
    producer.on("close", (code) => {
      producerCode = code ?? 1;
      finish();
    });
    consumer.on("close", (code) => {
      consumerCode = code ?? 1;
      finish();
    });
    producer.on("error", () => {
      producerCode = 1;
      finish();
    });
    consumer.on("error", () => {
      consumerCode = 1;
      finish();
    });
  });
}

function volumeNamed(storage: ContainerStorageIdentity, role: string): string {
  const volume = storage.volumes?.find((entry) => entry.role === role);
  if (!volume) throw lifecycleError("needs-attention", "The storage set is incomplete.");
  return volume.name;
}

async function runCopyStep(
  context: Pick<CommandContext, "storage">,
  imageId: string,
  step: CopyStep,
  source: { containerId: string; storage: ContainerStorageIdentity },
  candidate: ContainerStorageIdentity,
): Promise<CopyResult> {
  const destinationVolume = volumeNamed(candidate, step.target.role);
  const destination = `/storage/${step.target.role}${step.target.subdir ? `/${step.target.subdir}` : ""}`;
  const destinationMount = [
    "--mount",
    `type=volume,src=${destinationVolume},dst=/storage/${step.target.role},volume-nocopy`,
  ];
  if (step.source.kind === "volume") {
    const sourceVolume = volumeNamed(source.storage, step.source.role);
    const { stdout } = await runCommand(
      "docker",
      helperArguments(
        context,
        imageId,
        [
          "--mount",
          `type=volume,src=${sourceVolume},dst=/source,readonly,volume-nocopy`,
          ...destinationMount,
        ],
        ["copy-volume", "/source", destination],
        false,
      ),
      { timeoutMs: COPY_TIMEOUT_MS },
    ).catch((error: unknown) => ({ stdout: error instanceof Error ? error.message : "" }));
    return parseCopyOutput(stdout);
  }
  const piped = await pipeContainerPath(
    source.containerId,
    step.source.path,
    helperArguments(
      context,
      imageId,
      destinationMount,
      ["copy-stream", destination, "1", ...(step.select ?? [])],
      true,
    ),
  );
  if (piped.absent) return { ok: true, files: 0, bytes: 0, absent: true };
  if (piped.producerFailed) return { ok: false, reason: "source-read-failed" };
  return parseCopyOutput(piped.output);
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

export interface CapacityCheck {
  estimateBytes: number | null;
  availableBytes: number | null;
}

async function measureVolume(
  context: Pick<CommandContext, "storage">,
  imageId: string,
  volume: string,
): Promise<{ bytes: number | null; available: number | null }> {
  try {
    const { stdout } = await runCommand(
      "docker",
      helperArguments(
        context,
        imageId,
        ["--mount", `type=volume,src=${volume},dst=/measure,readonly,volume-nocopy`],
        ["measure", "/measure"],
        false,
      ),
      { timeoutMs: 10 * 60_000 },
    );
    const match = /bytes=(\d*) available=(\d*)/.exec(stdout);
    return {
      bytes: match?.[1] ? Number(match[1]) : null,
      available: match?.[2] ? Number(match[2]) : null,
    };
  } catch {
    return { bytes: null, available: null };
  }
}

async function legacyWritableLayerBytes(containerId: string): Promise<number | null> {
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
      { timeoutMs: 120_000 },
    );
    return parseDockerPsSize(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Free space is measured where the volumes live — on the daemon's filesystem
 * (inside the VM for Docker Desktop) — never on the backend host.
 */
export function capacityVerdict(
  check: CapacityCheck,
  allowUnknown: boolean,
): { ok: true } | { ok: false; message: string } {
  if (check.estimateBytes === null || check.availableBytes === null) {
    return allowUnknown
      ? { ok: true }
      : {
          ok: false,
          message:
            "Free space on the Docker host could not be measured. Free space or confirm the rebuild explicitly.",
        };
  }
  const required = Math.ceil(check.estimateBytes * 1.1) + CAPACITY_HEADROOM_BYTES;
  return check.availableBytes >= required
    ? { ok: true }
    : {
        ok: false,
        message: `The rebuild needs about ${Math.ceil(required / 1024 ** 2)} MiB free on the Docker host; ${Math.floor(check.availableBytes / 1024 ** 2)} MiB is available. Free space and retry.`,
      };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Removes an uncommitted candidate: its container (found by the operation's
 * exact label) and its storage set. A candidate volume that will not remove is
 * kept referenced as a failed candidate rather than orphaned.
 */
export async function rollbackCandidate(
  context: Pick<CommandContext, "storage" | "emit">,
  environmentId: string,
  operationId: string,
  candidateStorage: ContainerStorageIdentity | undefined,
): Promise<NonNullable<EnvironmentContainerLifecycle["retainedStorage"]>[number] | undefined> {
  const search = await findOperationContainers(context, operationId);
  const containerIds =
    search.kind === "one"
      ? [search.containerId]
      : search.kind === "many"
        ? search.containerIds
        : [];
  for (const id of containerIds) {
    await runCommand("docker", ["rm", "-f", id], { timeoutMs: 60_000 }).catch(() => undefined);
  }
  if (!candidateStorage?.volumes?.length) return undefined;
  const kept = await removeStorageVolumes(context, environmentId, candidateStorage);
  if (!kept || kept.length === 0) return undefined;
  return {
    storageSetId: candidateStorage.storageSetId ?? "unknown",
    workspaceGeneration: candidateStorage.workspaceGeneration,
    volumes: kept,
    retainedAt: new Date().toISOString(),
    reason: "failed-candidate",
    operationId,
  };
}

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

/**
 * Fences and stops a runtime before its data is copied or swapped: review
 * validation and exec workers are cancelled, previews detached, processes
 * drained (graceful-shutdown images) under the draining fence, then the
 * container is stopped. It is never restarted to export its files.
 */
export async function quiesceRuntime(
  environmentId: string,
  containerId: string,
  imageId: string | undefined,
  context: CommandContext,
): Promise<{ forced: boolean }> {
  await stopEnvironmentReviewValidation(environmentId, context);
  await stopEnvironmentExecWorkers(environmentId, context);
  context.previews?.registry.beforeEnvironmentTargetChange(environmentId);
  const capabilities = await imageCapabilities(imageId, context);
  const drain = await withEnvironmentDraining(environmentId, containerId, async () => {
    const result = capabilities?.["graceful-shutdown"]
      ? await drainContainerProcesses(containerId)
      : null;
    await runCommand("docker", ["stop", containerId], { timeoutMs: 60_000 });
    return result;
  });
  shutdownClaudeStatePolling(containerId);
  return {
    forced: (drain?.remaining ?? 0) > 0 || (await containerStopWasForced(containerId)) === true,
  };
}

export interface ReplacementOutcome {
  kind: ReplacementKind;
  containerId: string;
  runtimeGeneration: number;
  files: number;
  bytes: number;
}

/**
 * Replaces an environment's runtime, preserving its workspace and declared
 * provider state. Must run inside the environment's lifecycle queue.
 */
export async function replaceRuntimePreservingState(
  request: ReplacementRequest,
  context: CommandContext,
): Promise<ReplacementOutcome | undefined> {
  // No agent prompt reaches this environment while its runtime is replaced.
  // At most a few copies run at once across environments; the fence holds
  // while this one waits for a slot.
  return withEnvironmentReplacement(request.environmentId, () =>
    withContainerAdmission("copy", () => replaceRuntimePreservingStateUnfenced(request, context)),
  );
}

async function replaceRuntimePreservingStateUnfenced(
  request: ReplacementRequest,
  context: CommandContext,
): Promise<ReplacementOutcome | undefined> {
  if (replacementAdmissionPaused()) {
    throw lifecycleError(
      "capability-unavailable",
      "New rebuilds and migrations are paused on this installation. Recovery copies can still be restored or discarded.",
    );
  }
  const environment = await context.storage.getEnvironment(request.environmentId);
  if (!environment) throw new Error(`Environment not found: ${request.environmentId}`);
  if (environment.environmentType !== "containerized" || !environment.containerId) return undefined;
  if (environment.containerId !== request.expectedContainerId) {
    throw lifecycleError(
      "runtime-changed",
      "The container changed after it was reviewed. Review the environment again before rebuilding it.",
    );
  }
  const record = readRecord(environment);
  const sourceContainerId = environment.containerId;
  const ownership = await resolveContainerOwnership(sourceContainerId, context);
  if (ownership.verdict !== "owned") {
    throw lifecycleError(
      ownership.verdict === "unknown" ? "daemon-unavailable" : "not-owned",
      "The container cannot be rebuilt because its ownership could not be confirmed.",
    );
  }
  if (groupRecoveryCopies(record).length >= MAX_RETAINED_STORAGE_SETS) {
    throw lifecycleError(
      "resource-exhausted",
      "This environment already keeps the maximum number of recovery copies. Review and discard old copies before rebuilding again.",
    );
  }
  const kind: ReplacementKind = record.storage.format === "volume-v1" ? "rebuild" : "migrate";
  const source: ContainerRuntimeIdentity = currentRuntimeIdentity(environment, context) ?? {
    containerId: sourceContainerId,
    runtimeGeneration: record.lastRuntimeGeneration,
    owner: dockerOwnerNamespace(context.storage.getDataDir()),
  };
  const admission = await beginContainerOperation(context, environment.id, kind, {
    ...request,
    source,
    details: { expectedContainerId: request.expectedContainerId },
  });
  if (admission.kind === "replayed") return undefined;
  const { operationId } = admission.operation;
  const checkCancelled = () => {
    if (cancellationRequests.has(operationId)) throw new ReplacementCancelled();
  };
  const phase = (name: (typeof REPLACEMENT_PHASES)[number], patch = {}) =>
    advanceContainerOperation(context, environment.id, operationId, { phase: name, ...patch });

  let candidateStorage: ContainerStorageIdentity | undefined;
  let sourceStopped = false;
  try {
    // Preflight: read-only checks before anything is touched.
    await phase("preflight");
    const image = await resolveDockerImage(configuredImageRef(context));
    if (image.kind !== "present") {
      throw lifecycleError("capability-unavailable", "The environment image is not available.");
    }
    const topology = await detectDockerTopology();
    if (topology.kind === "remote" || topology.kind === "unavailable") {
      throw lifecycleError(
        "unsupported-topology",
        "A preserving rebuild needs a reachable local Docker engine. The original container was not changed.",
      );
    }
    const decision = selectStorageFormat(await imageCapabilities(image.imageId, context), topology);
    if (decision.format !== "volume-v1") {
      throw lifecycleError(
        "capability-unavailable",
        `A preserving rebuild needs an image and Docker Engine that support persistent storage (${decision.reason}). The original container was not changed.`,
      );
    }
    const estimate =
      kind === "migrate"
        ? await legacyWritableLayerBytes(sourceContainerId)
        : await Promise.all(
            (record.storage.volumes ?? []).map((volume) =>
              measureVolume(context, image.imageId, volume.name).then((measure) => measure.bytes),
            ),
          ).then((sizes) =>
            sizes.some((size) => size === null)
              ? null
              : sizes.reduce<number>((sum, size) => sum + (size ?? 0), 0),
          );
    candidateStorage = planStorageSet(
      environment.id,
      dockerOwnerNamespace(context.storage.getDataDir()),
      record.storage.workspaceGeneration,
    );
    await phase("preflight", {
      candidateStorage,
      details: { imageId: image.imageId, estimateBytes: estimate },
    });
    await ensureStorageVolumes(context, environment.id, candidateStorage);
    const available = (
      await measureVolume(context, image.imageId, volumeNamed(candidateStorage, "workspace"))
    ).available;
    const capacity = capacityVerdict(
      { estimateBytes: estimate, availableBytes: available },
      request.allowUnknownCapacity === true,
    );
    if (!capacity.ok) throw lifecycleError("resource-exhausted", capacity.message);
    const initialized = await initializeStorageSet(
      context,
      image.imageId,
      environment.id,
      candidateStorage,
    );
    if (!initialized.ok)
      throw lifecycleError("needs-attention", storageHelperFailureMessage(initialized));
    checkCancelled();

    // Quiesce: fence new work, drain what runs, stop the source. The source is
    // never restarted to export it; stopped-container files are copied.
    await phase("quiescing", { boot: { phase: "draining" } });
    const { forced } = await quiesceRuntime(
      environment.id,
      sourceContainerId,
      source.imageId,
      context,
    );
    sourceStopped = true;
    await phase("source-stopped", {
      boot: { phase: "stopped" },
      environment: { status: "stopped" },
      details: { forced },
    });
    checkCancelled();

    // Copy and verify every step against the stopped source.
    await phase("copying");
    let files = 0;
    let bytes = 0;
    for (const step of replacementCopyPlan(record.storage.format)) {
      const copied = await runCopyStep(
        context,
        image.imageId,
        step,
        { containerId: sourceContainerId, storage: record.storage },
        candidateStorage,
      );
      if (!copied.ok) {
        throw lifecycleError(
          "needs-attention",
          `Copying the environment's files failed verification (${copied.reason}). The original container was kept unchanged.`,
        );
      }
      files += copied.files;
      bytes += copied.bytes;
      checkCancelled();
    }
    await phase("verified", { details: { files, bytes } });

    // Candidate: a new runtime generation from the pinned image, with the
    // copied storage. The source is stopped, so fixed host ports are free.
    const current = (await context.storage.getEnvironment(environment.id)) ?? environment;
    const runtimeGeneration = nextRuntimeGeneration(current);
    const candidateId = await createDockerContainer(current, context, {
      operationId,
      runtimeGeneration,
      imageId: image.imageId,
      storage: candidateStorage,
    });
    const candidate: ContainerRuntimeIdentity = {
      containerId: candidateId,
      runtimeGeneration,
      owner: dockerOwnerNamespace(context.storage.getDataDir()),
      imageRef: image.imageRef,
      imageId: image.imageId,
      ...(image.registryDigest ? { registryDigest: image.registryDigest } : {}),
      createdByOperationId: operationId,
    };
    await phase("candidate-prepared", { candidate });
    checkCancelled();

    // Health without dispatch: current-boot readiness and a mounted workspace.
    // No setup, agent launch or queued prompt runs before the commit.
    await runCommand("docker", ["start", candidateId], { timeoutMs: 60_000 });
    const bootId = await waitForContainerBoot(candidateId);
    await runCommand("docker", ["exec", candidateId, "sh", "-c", "mountpoint -q /workspace"], {
      timeoutMs: 30_000,
    });
    // Stopped again before commit: the normal start path launches setup and
    // agent servers against the committed runtime, never against a candidate.
    await runCommand("docker", ["stop", candidateId], { timeoutMs: 60_000 });
    await phase("candidate-healthy", {
      candidate: { ...candidate, ...(bootId ? { bootId } : {}) },
    });
    checkCancelled();

    // Commit: runtime and storage pointers move together, and the original
    // runtime (and storage set, for a rebuild) are kept as recovery copies.
    await completeContainerOperation(context, environment.id, operationId, "succeeded", {
      phase: "committed",
      runtime: { ...candidate, ...(bootId ? { bootId } : {}) },
      storage: candidateStorage,
      retainRuntime: {
        ...source,
        ...(record.storage.storageSetId ? { storageSetId: record.storage.storageSetId } : {}),
        retainedAt: new Date().toISOString(),
        retainedByOperationId: operationId,
        retainedReason: kind === "migrate" ? "migrate-source" : "rebuild-source",
      },
      ...(kind === "rebuild" && record.storage.storageSetId
        ? {
            retainStorage: {
              storageSetId: record.storage.storageSetId,
              workspaceGeneration: record.storage.workspaceGeneration,
              volumes: record.storage.volumes ?? [],
              retainedAt: new Date().toISOString(),
              reason: "rebuild-source" as const,
              operationId,
            },
          }
        : {}),
      boot: { phase: "stopped" },
      environment: { containerId: candidateId, status: "stopped", lifecycleError: null },
    });
    // The old generation's handles must not connect to the replacement.
    await context.storage.clearBackendTerminalSessionIds?.(environment.id);
    containerGitFetchPolicy.forgetContainer(sourceContainerId);
    cancellationRequests.delete(operationId);
    return { kind, containerId: candidateId, runtimeGeneration, files, bytes };
  } catch (error) {
    cancellationRequests.delete(operationId);
    const failedCandidate = await rollbackCandidate(
      context,
      environment.id,
      operationId,
      candidateStorage,
    ).catch(() => undefined);
    // Before commit the original is authoritative and untouched apart from
    // being stopped. The caller restarts it through the normal start path.
    await completeContainerOperation(
      context,
      environment.id,
      operationId,
      error instanceof ReplacementCancelled ? "cancelled" : "failed",
      {
        failureCode:
          error instanceof ReplacementCancelled ? undefined : operationFailureCode(error),
        ...(failedCandidate ? { retainStorage: failedCandidate } : {}),
        environment: sourceStopped ? { status: "stopped" } : {},
      },
    ).catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const NOT_PRESERVED = [
  "Tools and packages installed outside /workspace (setup runs again on the new container)",
  "Running processes, terminal sessions and servers (they restart)",
  "Provider configuration and credentials in the container (refreshed from the host)",
];

/**
 * Read-only description of a preserving rebuild. The decisive checks are
 * repeated by the operation itself; this only lets the user see, before
 * confirming, what survives and whether it is possible at all.
 */
export async function rebuildPreview(
  environmentId: string,
  context: Pick<CommandContext, "storage" | "dockerImage">,
): Promise<RebuildPreview> {
  const environment = await context.storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  const record = parsed.supported ? parsed.record : undefined;
  const retainedCopies = record ? groupRecoveryCopies(record).length : 0;
  const preview: RebuildPreview = {
    environmentId,
    containerId: environment.containerId ?? null,
    available: false,
    kind: record?.storage.format === "volume-v1" ? "rebuild" : "migrate",
    preservedPaths: [
      "/workspace — tracked, untracked and ignored files, Git history and unpushed commits",
      ...PROVIDER_STATE_LAYOUT.map((entry) => `${entry.containerPath} — ${entry.holds}`),
    ],
    notPreserved: NOT_PRESERVED,
    providers: Object.entries(PROVIDER_PRESERVATION).map(([provider, entry]) => ({
      provider,
      level: entry.level,
      limitations: entry.limitations,
      // No provider has been exercised resuming a preserved session against
      // its real CLI/SDK after a rebuild yet (qualification C13).
      resumeQualified: false,
    })),
    retainedCopies,
    retainedCopyLimit: MAX_RETAINED_STORAGE_SETS,
  };
  const refuse = (reason: RebuildUnavailableReason): RebuildPreview => ({
    ...preview,
    unavailableReason: reason,
  });
  if (!record) return refuse("unsupported-format");
  if (environment.environmentType !== "containerized") return refuse("not-containerized");
  if (!environment.containerId) return refuse("no-container");
  if (record.operation) return refuse("operation-in-progress");
  if (retainedCopies >= MAX_RETAINED_STORAGE_SETS) return refuse("retention-limit");
  if (replacementAdmissionPaused()) return refuse("admission-paused");
  const topology = await detectDockerTopology();
  if (topology.kind === "remote" || topology.kind === "unavailable") {
    return refuse("unsupported-topology");
  }
  const image = await resolveDockerImage(configuredImageRef(context));
  if (image.kind !== "present") return refuse("image-unavailable");
  const decision = selectStorageFormat(await imageCapabilities(image.imageId, context), topology);
  if (decision.format !== "volume-v1") return refuse(decision.reason);
  return { ...preview, available: true };
}
