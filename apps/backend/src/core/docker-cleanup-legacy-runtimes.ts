import type {
  LegacyRuntimeExposure,
  LegacyRuntimeRow,
} from "@orkestrator/protocol/container-recovery";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { MAX_CLEANUP_CANDIDATES, type ProtectionSnapshot } from "./docker-cleanup-inventory.js";
import { mapWithConcurrency } from "./environment-process-usage.js";
import { inspectRuntimeShape, legacyExposures } from "./legacy-runtime-shape.js";

/**
 * Environments whose runtime still has an older shape: whole host agent homes
 * bound in, or network policy 1. They stay as they are until the user rebuilds
 * them, so the cleanup review lists them in one place. Only reads Docker; the
 * shape itself is defined in `legacy-runtime-shape.ts`.
 */

const INSPECT_CONCURRENCY = 8;

async function inspectExposures(
  containerId: string,
): Promise<LegacyRuntimeExposure[] | "missing" | "unchecked"> {
  const shape = await inspectRuntimeShape(containerId);
  if (typeof shape === "string") return shape;
  try {
    return legacyExposures(shape.inputsRevision, shape.networkPolicy, shape.mountsJson);
  } catch {
    return "unchecked";
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
