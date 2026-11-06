import type { LegacyRuntimeExposure } from "@orkestrator/protocol/container-recovery";
import { DOCKER_LABEL_INPUTS_REVISION, DOCKER_LABEL_NETWORK_POLICY } from "./constants.js";
import { runCommand } from "./shell.js";

/**
 * The one definition of an older runtime shape, read from Docker: whole host
 * agent homes bound in (no inputs-revision label and a bind at one of the old
 * mount points), or network policy 1 (no network-policy label). The cleanup
 * review's list and an environment's inputs section both read it, so they
 * cannot disagree about the same runtime. Only reads Docker.
 */

/** Where images from before staged inputs took each host home or file. */
const LEGACY_HOST_MOUNT_TARGETS = new Set([
  "/claude-config",
  "/claude-config.json",
  "/codex-home",
  "/grok-home",
  "/grok-config",
  "/pi-config",
  "/opencode-config",
  "/opencode-data",
  "/opencode-state/model.json",
  "/tmp/gitconfig",
]);

function labelValue(value: string | undefined): string {
  return value && value !== "<no value>" ? value : "";
}

/** What one `docker inspect` says about a runtime's shape. */
export interface RuntimeShape {
  /** Empty when the label is absent. */
  inputsRevision: string;
  /** Empty when the label is absent. */
  networkPolicy: string;
  /** Docker's `.Mounts` JSON, parsed only when it is needed. */
  mountsJson: string;
}

/**
 * Staged inputs bind the same targets from a private revision, so a target
 * counts only on a runtime with no revision label. Throws on mounts JSON it
 * cannot parse. The mount sources are host paths and never leave this function.
 */
export function hasLegacyHostMounts(inputsRevision: string, mountsJson: string): boolean {
  if (inputsRevision) return false;
  const mounts = JSON.parse(mountsJson) as Array<{ Type?: unknown; Destination?: unknown }>;
  return mounts.some(
    (mount) =>
      mount.Type === "bind" &&
      typeof mount.Destination === "string" &&
      LEGACY_HOST_MOUNT_TARGETS.has(mount.Destination),
  );
}

export function legacyExposures(
  inputsRevision: string,
  networkPolicy: string,
  mountsJson: string,
): LegacyRuntimeExposure[] {
  return [
    ...(hasLegacyHostMounts(inputsRevision, mountsJson) ? (["host-mounts"] as const) : []),
    ...(networkPolicy ? [] : (["shared-bridge"] as const)),
  ];
}

/**
 * Reads a runtime's labels and mounts in one inspect. `missing` when Docker
 * says the container does not exist; `unchecked` for any other failure, which
 * is Docker's silence and never evidence either way.
 */
export async function inspectRuntimeShape(
  containerId: string,
): Promise<RuntimeShape | "missing" | "unchecked"> {
  try {
    const { stdout } = await runCommand(
      "docker",
      [
        "inspect",
        "-f",
        `{{ index .Config.Labels "${DOCKER_LABEL_INPUTS_REVISION}" }}\t{{ index .Config.Labels "${DOCKER_LABEL_NETWORK_POLICY}" }}\t{{ json .Mounts }}`,
        containerId,
      ],
      { timeoutMs: 10_000 },
    );
    // Only the end: an absent label is an empty leading field.
    const [inputsRevision, networkPolicy, mountsJson = ""] = stdout.trimEnd().split("\t");
    return {
      inputsRevision: labelValue(inputsRevision?.trim()),
      networkPolicy: labelValue(networkPolicy?.trim()),
      mountsJson,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /no such (object|container)/i.test(message) ? "missing" : "unchecked";
  }
}
