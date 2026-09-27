import { randomBytes } from "node:crypto";
import {
  formatContainerLifecycleError,
  type ContainerStorageIdentity,
} from "@orkestrator/protocol/container-lifecycle";
import type { ImageManifest } from "@orkestrator/protocol/image-manifest";
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
import type { DockerTopology } from "@orkestrator/protocol/image-manifest";
import { PROVIDER_STATE_LAYOUT } from "./container-state-layout.js";

/**
 * Persistent environment storage (format `volume-v1`).
 *
 * A storage set is two owner-labelled named volumes:
 *
 * - `workspace` — mounted at `/workspace`: the Git database, tracked,
 *   untracked and ignored files, environment-private `.orkestrator` state.
 * - `state` — mounted by sub-path only at the verified provider session paths
 *   in `PROVIDER_STATE_LAYOUT`; never a whole home directory, never imported
 *   credentials.
 *
 * Volumes are created explicitly before the workload, initialized once by a
 * helper container (`/usr/local/bin/orkestrator-storage.sh`, entrypoint
 * overridden, no network) and verified against their private marker before
 * every read-write mount. Named volumes are persistence, not backup.
 */

export const STORAGE_SET_LABEL = "orkestrator-storage-set";
export const STORAGE_FORMAT_LABEL = "orkestrator-storage-format";
export const STORAGE_HELPER_ROLE = "storage-helper";
export const STORAGE_ROLES = ["workspace", "state"] as const;
export type StorageRole = (typeof STORAGE_ROLES)[number];

/** Docker volume sub-path mounts need Engine 26+. */
export const MIN_ENGINE_FOR_VOLUME_SUBPATH = 26;

function storageError(message: string): Error {
  return new Error(formatContainerLifecycleError("needs-attention", message));
}

export function newStorageSetId(): string {
  return randomBytes(6).toString("hex");
}

function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "") || "environment"
  );
}

/** Volume names from owner, environment and storage set; bounded for Docker. */
export function storageVolumeName(
  owner: string,
  environmentId: string,
  storageSetId: string,
  role: StorageRole,
): string {
  const suffix = `-${storageSetId}-${role}`;
  return `ork-${owner}-${safeName(environmentId)}`.slice(0, 200 - suffix.length) + suffix;
}

export function planStorageSet(
  environmentId: string,
  owner: string,
  workspaceGeneration: number,
  storageSetId = newStorageSetId(),
): ContainerStorageIdentity {
  return {
    format: "volume-v1",
    workspaceGeneration,
    storageSetId,
    volumes: STORAGE_ROLES.map((role) => ({
      role,
      name: storageVolumeName(owner, environmentId, storageSetId, role),
    })),
  };
}

export type StorageFormatDecision =
  | { format: "volume-v1" }
  | {
      format: "legacy-layer";
      reason:
        | "disabled-by-configuration"
        | "image-without-storage-contract"
        | "engine-without-volume-subpath";
    };

/**
 * New runtimes use persistent volumes only when the image implements the
 * storage contract, the daemon supports sub-path mounts, and the rollout
 * switch has not disabled it. Existing legacy runtimes are never migrated here.
 */
/**
 * Release safety switch: `ORKESTRATOR_CONTAINER_REPLACEMENT=paused` refuses
 * new rebuilds and migrations while everything that recovers data — listing,
 * restoring and discarding recovery copies, resolving an interrupted
 * operation — keeps working.
 */
export function replacementAdmissionPaused(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.ORKESTRATOR_CONTAINER_REPLACEMENT === "paused";
}

export function selectStorageFormat(
  capabilities: ImageManifest["capabilities"] | null,
  topology: Pick<DockerTopology, "serverVersion" | "kind">,
  environment: NodeJS.ProcessEnv = process.env,
): StorageFormatDecision {
  if (environment.ORKESTRATOR_CONTAINER_STORAGE === "legacy-layer") {
    return { format: "legacy-layer", reason: "disabled-by-configuration" };
  }
  if (!capabilities?.["persistent-workspace"]) {
    return { format: "legacy-layer", reason: "image-without-storage-contract" };
  }
  const major = Number.parseInt(topology.serverVersion?.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < MIN_ENGINE_FOR_VOLUME_SUBPATH) {
    return { format: "legacy-layer", reason: "engine-without-volume-subpath" };
  }
  return { format: "volume-v1" };
}

function volumeLabels(
  owner: string,
  environmentId: string,
  storage: ContainerStorageIdentity,
  role: StorageRole,
): Record<string, string> {
  return {
    [DOCKER_LABEL_APP]: DOCKER_LABEL_APP_VALUE,
    [DOCKER_LABEL_OWNER]: owner,
    [DOCKER_LABEL_ENVIRONMENT_ID]: environmentId,
    [DOCKER_LABEL_RESOURCE_ROLE]: role,
    [STORAGE_SET_LABEL]: storage.storageSetId ?? "",
    [STORAGE_FORMAT_LABEL]: storage.format,
  };
}

export type VolumeProbe =
  | { kind: "present"; labels: Record<string, string> }
  | { kind: "missing" }
  | { kind: "unreachable" };

export async function inspectVolume(name: string): Promise<VolumeProbe> {
  try {
    const { stdout } = await runCommand(
      "docker",
      ["volume", "inspect", "--format", "{{json .Labels}}", name],
      { timeoutMs: 15_000 },
    );
    const parsed = JSON.parse(stdout.trim() || "null") as unknown;
    const labels: Record<string, string> = {};
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") labels[key] = value;
      }
    }
    return { kind: "present", labels };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such volume|not found/i.test(message)) return { kind: "missing" };
    return { kind: "unreachable" };
  }
}

function labelsMatch(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}

/**
 * Creates each planned volume, or adopts one that already exists with exactly
 * the expected labels (an earlier attempt that timed out). A volume with the
 * planned name but different labels is never adopted.
 */
export async function ensureStorageVolumes(
  context: Pick<CommandContext, "storage">,
  environmentId: string,
  storage: ContainerStorageIdentity,
): Promise<void> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  for (const volume of storage.volumes ?? []) {
    const role = volume.role as StorageRole;
    const expected = volumeLabels(owner, environmentId, storage, role);
    const existing = await inspectVolume(volume.name);
    if (existing.kind === "unreachable") {
      throw new Error(
        formatContainerLifecycleError("daemon-unavailable", "Docker could not be reached."),
      );
    }
    if (existing.kind === "present") {
      if (!labelsMatch(existing.labels, expected)) {
        throw storageError(
          "A volume with this environment's storage name exists but belongs to something else. It was left untouched.",
        );
      }
      continue;
    }
    try {
      await runCommand(
        "docker",
        [
          "volume",
          "create",
          ...Object.entries(expected).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          volume.name,
        ],
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      // An ambiguous create is resolved by exact identity.
      const after = await inspectVolume(volume.name);
      if (after.kind === "present" && labelsMatch(after.labels, expected)) continue;
      throw error;
    }
  }
}

function helperMountArguments(storage: ContainerStorageIdentity): string[] {
  return (storage.volumes ?? []).flatMap((volume) => [
    "--mount",
    `type=volume,src=${volume.name},dst=/storage/${volume.role},volume-nocopy`,
  ]);
}

export type StorageHelperResult =
  | { ok: true }
  | {
      ok: false;
      status:
        | "unknown-content"
        | "foreign-marker"
        | "owner-mismatch"
        | "missing-marker"
        | "helper-failed";
      role?: string;
    };

async function runStorageHelper(
  context: Pick<CommandContext, "storage">,
  imageId: string,
  storage: ContainerStorageIdentity,
  args: string[],
): Promise<StorageHelperResult> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  let output = "";
  try {
    output = (
      await runCommand(
        "docker",
        [
          "run",
          "--rm",
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
          "/usr/local/bin/orkestrator-storage.sh",
          ...helperMountArguments(storage),
          imageId,
          ...args,
        ],
        { timeoutMs: 120_000 },
      )
    ).stdout;
  } catch (error) {
    output = error instanceof Error ? error.message : String(error);
  }
  const match = /ORKESTRATOR_STORAGE status=([a-z-]+)(?: [a-z]+=\S+)*?(?: role=(\S+))?/.exec(
    output,
  );
  const status = match?.[1];
  if (status === "ok") return { ok: true };
  if (
    status === "unknown-content" ||
    status === "foreign-marker" ||
    status === "owner-mismatch" ||
    status === "missing-marker"
  ) {
    return { ok: false, status, ...(match?.[2] ? { role: match[2] } : {}) };
  }
  return { ok: false, status: "helper-failed" };
}

export function initializeStorageSet(
  context: Pick<CommandContext, "storage">,
  imageId: string,
  environmentId: string,
  storage: ContainerStorageIdentity,
): Promise<StorageHelperResult> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  return runStorageHelper(context, imageId, storage, [
    "init",
    environmentId,
    owner,
    storage.storageSetId ?? "",
    String(storage.workspaceGeneration),
    ...PROVIDER_STATE_LAYOUT.map((entry) => entry.subdir),
  ]);
}

export function verifyStorageSet(
  context: Pick<CommandContext, "storage">,
  imageId: string,
  environmentId: string,
  storage: ContainerStorageIdentity,
): Promise<StorageHelperResult> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  return runStorageHelper(context, imageId, storage, [
    "verify",
    environmentId,
    owner,
    storage.storageSetId ?? "",
  ]);
}

export function storageHelperFailureMessage(
  result: Exclude<StorageHelperResult, { ok: true }>,
): string {
  switch (result.status) {
    case "unknown-content":
      return "The environment's storage volume already holds files that Orkestrator did not initialize. They were left untouched.";
    case "foreign-marker":
      return "The environment's storage volume belongs to another environment. It was left untouched.";
    case "owner-mismatch":
      return "The environment's storage volume has unexpected file ownership. It was left untouched.";
    case "missing-marker":
      return "The environment's storage volume has lost its marker. It was left untouched for recovery.";
    default:
      return "The environment's storage could not be checked. Retry once Docker is healthy.";
  }
}

/** `--mount` arguments for the workload container. */
export function storageMountArguments(storage: ContainerStorageIdentity): string[] {
  const workspace = storage.volumes?.find((volume) => volume.role === "workspace");
  const state = storage.volumes?.find((volume) => volume.role === "state");
  if (!workspace || !state) {
    throw storageError("The environment's storage set is incomplete.");
  }
  return [
    "--mount",
    `type=volume,src=${workspace.name},dst=/workspace,volume-nocopy`,
    ...PROVIDER_STATE_LAYOUT.flatMap((entry) => [
      "--mount",
      `type=volume,src=${state.name},dst=${entry.containerPath},volume-subpath=${entry.subdir},volume-nocopy`,
    ]),
  ];
}

/**
 * Removes a storage set's volumes after the runtime using them is gone.
 * Label-verified; never forced. Returns the volumes that could not be removed
 * so the caller keeps a reference to them instead of orphaning data.
 */
export async function removeStorageVolumes(
  context: Pick<CommandContext, "storage">,
  environmentId: string,
  storage: ContainerStorageIdentity,
): Promise<ContainerStorageIdentity["volumes"]> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  const kept: NonNullable<ContainerStorageIdentity["volumes"]> = [];
  for (const volume of storage.volumes ?? []) {
    const probe = await inspectVolume(volume.name);
    if (probe.kind === "missing") continue;
    if (
      probe.kind === "unreachable" ||
      probe.labels[DOCKER_LABEL_OWNER] !== owner ||
      probe.labels[DOCKER_LABEL_ENVIRONMENT_ID] !== environmentId
    ) {
      kept.push(volume);
      continue;
    }
    await runCommand("docker", ["volume", "rm", volume.name], { timeoutMs: 60_000 }).catch(
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such volume/i.test(message)) kept.push(volume);
      },
    );
  }
  return kept;
}
