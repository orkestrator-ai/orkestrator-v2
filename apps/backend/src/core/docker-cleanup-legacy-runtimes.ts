import type {
  LegacyRuntimeExposure,
  LegacyRuntimeRow,
} from "@orkestrator/protocol/container-recovery";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { DOCKER_LABEL_INPUTS_REVISION, DOCKER_LABEL_NETWORK_POLICY } from "./constants.js";
import { MAX_CLEANUP_CANDIDATES, type ProtectionSnapshot } from "./docker-cleanup-inventory.js";
import { mapWithConcurrency } from "./environment-process-usage.js";
import { runCommand } from "./shell.js";

/**
 * Environments whose runtime still has an older shape: whole host agent homes
 * bound in, or network policy 1. They stay as they are until the user rebuilds
 * them, so the cleanup review lists them in one place. Only reads Docker.
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

const INSPECT_CONCURRENCY = 8;

function labelValue(value: string | undefined): string {
  return value && value !== "<no value>" ? value : "";
}

/**
 * Staged inputs bind the same targets from a private revision, so a target
 * counts only on a runtime with no revision label. The mount sources are host
 * paths and never leave this function.
 */
export function legacyExposures(
  inputsRevision: string,
  networkPolicy: string,
  mountsJson: string,
): LegacyRuntimeExposure[] {
  const mounts = JSON.parse(mountsJson) as Array<{ Type?: unknown; Destination?: unknown }>;
  const hostMounts =
    !inputsRevision &&
    mounts.some(
      (mount) =>
        mount.Type === "bind" &&
        typeof mount.Destination === "string" &&
        LEGACY_HOST_MOUNT_TARGETS.has(mount.Destination),
    );
  return [
    ...(hostMounts ? (["host-mounts"] as const) : []),
    ...(networkPolicy ? [] : (["shared-bridge"] as const)),
  ];
}

async function inspectExposures(
  containerId: string,
): Promise<LegacyRuntimeExposure[] | "missing" | "unchecked"> {
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
    return legacyExposures(labelValue(inputsRevision), labelValue(networkPolicy), mountsJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /no such (object|container)/i.test(message) ? "missing" : "unchecked";
  }
}

export async function listLegacyRuntimes(
  protection: Pick<
    ProtectionSnapshot,
    "environments" | "deletionEnvironmentIds" | "operationInFlight"
  >,
): Promise<{ rows: LegacyRuntimeRow[]; unchecked: number; truncated: boolean }> {
  const assigned = protection.environments.filter(
    (environment) =>
      environment.environmentType === "containerized" &&
      environment.containerId &&
      !protection.deletionEnvironmentIds.has(environment.id),
  );
  const candidates = assigned.slice(0, MAX_CLEANUP_CANDIDATES);
  const inspected = await mapWithConcurrency(candidates, INSPECT_CONCURRENCY, (environment) =>
    inspectExposures(environment.containerId!),
  );
  const rows: LegacyRuntimeRow[] = [];
  let unchecked = 0;
  candidates.forEach((environment, index) => {
    const exposures = inspected[index]!;
    if (exposures === "unchecked") unchecked += 1;
    if (typeof exposures === "string" || exposures.length === 0) return;
    const lifecycle = parseContainerLifecycle(environment.containerLifecycle);
    rows.push({
      environmentId: environment.id,
      environmentName: environment.name,
      containerId: environment.containerId!,
      exposures,
      busy:
        protection.operationInFlight(environment.id) ||
        (lifecycle.supported && Boolean(lifecycle.record.operation)),
    });
  });
  rows.sort(
    (a, b) =>
      a.environmentName.localeCompare(b.environmentName) ||
      a.environmentId.localeCompare(b.environmentId),
  );
  return { rows, unchecked, truncated: assigned.length > candidates.length };
}
