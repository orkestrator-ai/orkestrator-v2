/**
 * Child process for container-live-rebuild-faults.test.ts (C15): runs one
 * preserving rebuild the way a backend does — the SQLite storage service over
 * a private data directory, holding the registry writer lease — and parks
 * immediately before or immediately after the commit write so the parent can
 * SIGKILL it there.
 *
 * The pause is a storage wrapper this script installs on its own storage
 * instance; production code has no hook for it.
 *
 * Usage: bun container-live-rebuild-kill-driver.ts '<json config>'
 * Reports one JSON object per stdout line.
 */
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { replaceRuntimePreservingState } from "../src/core/container-replacement";
import { openRegistryWriter } from "../src/core/registry-writer-lease";
import { StorageService } from "../src/core/storage";
import { durableLifecycleContext } from "./container-live-rebuild-fixtures";

export interface KillDriverConfig {
  dataDir: string;
  environmentId: string;
  expectedContainerId: string;
  image: string;
  pauseAt: "before-commit" | "after-commit";
  leaseStaleMs: number;
}

export type KillDriverEvent =
  | { event: "started"; pid: number }
  | { event: "phase"; phase: string; operationId: string }
  | {
      event: "paused";
      at: KillDriverConfig["pauseAt"];
      operationId: string;
      candidateContainerId: string;
      candidateStorageSetId: string | undefined;
    }
  | { event: "finished" }
  | { event: "error"; message: string };

function report(event: KillDriverEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Never returns; a ref'd timer keeps the process alive until it is killed. */
async function park(): Promise<never> {
  setInterval(() => undefined, 60_000);
  return new Promise<never>(() => undefined);
}

async function main(): Promise<void> {
  const config = JSON.parse(process.argv[2] ?? "{}") as KillDriverConfig;
  report({ event: "started", pid: process.pid });
  const storage = new StorageService(config.dataDir);
  await storage.init();
  const writer = await openRegistryWriter(config.dataDir, { staleMs: config.leaseStaleMs });
  if (!writer.isHeld()) throw new Error("registry writer lease is busy");

  let operationId: string | undefined;
  const context = durableLifecycleContext(storage, writer, config.image, (_event, payload) => {
    const operation = (
      payload as { snapshot?: { operation?: { operationId: string; phase: string } } }
    )?.snapshot?.operation;
    if (operation)
      report({ event: "phase", phase: operation.phase, operationId: operation.operationId });
  });

  // The commit is the one write that clears the replacement's operation and
  // records its success with the candidate as the runtime.
  const update = storage.updateEnvironment.bind(storage);
  storage.updateEnvironment = async (environmentId, updates, shouldUpdate) => {
    const parsed = parseContainerLifecycle(updates.containerLifecycle);
    const record = parsed.supported ? parsed.record : undefined;
    if (record?.operation && ["migrate", "rebuild"].includes(record.operation.kind)) {
      operationId = record.operation.operationId;
    }
    const outcome = record?.outcomes.at(-1);
    const commit =
      operationId !== undefined &&
      record !== undefined &&
      !record.operation &&
      outcome?.operationId === operationId &&
      outcome.status === "succeeded" &&
      record.runtime?.createdByOperationId === operationId;
    const pause = () =>
      report({
        event: "paused",
        at: config.pauseAt,
        operationId: operationId!,
        candidateContainerId: record!.runtime!.containerId,
        candidateStorageSetId: record!.storage.storageSetId,
      });
    if (commit && config.pauseAt === "before-commit") {
      pause();
      return park();
    }
    const result = await update(environmentId, updates, shouldUpdate);
    if (commit && config.pauseAt === "after-commit") {
      pause();
      return park();
    }
    return result;
  };

  await replaceRuntimePreservingState(
    { environmentId: config.environmentId, expectedContainerId: config.expectedContainerId },
    context,
  );
  report({ event: "finished" });
  await writer.release();
  storage.close();
}

main().catch((error: unknown) => {
  report({ event: "error", message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
