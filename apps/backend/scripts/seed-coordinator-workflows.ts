import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  coordinatorMainConversation,
  type CoordinatorWorkflowAssociation,
} from "@orkestrator/protocol/coordinator";
import { CoordinatorService } from "../src/core/coordinator-service.js";
import {
  COORDINATOR_WORKFLOW_NEAR_LIMIT,
  COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR,
  MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
} from "../src/core/coordinator-workflow-retention.js";
import { runCommand } from "../src/core/shell.js";
import { createProject, StorageService } from "../src/core/storage.js";
import { isDefaultDataDir } from "../src/data-dir.js";

/**
 * Seeds coordinator workflow records that are still in use into an isolated
 * `dev:test` profile, so the coordinator panel's store banner (near its limit,
 * or full) can be checked on a live stack (to-do 6360, task 4). The launcher
 * runs it for `--seed-workflow-records` before it starts Electron, so no
 * backend has the store open: the records go in through the store's own API
 * (`saveCoordinatorWorkflowAssociation`), never by editing the database.
 *
 *   bun apps/backend/scripts/seed-coordinator-workflows.ts \
 *     --data-dir <profile>/data --checkout <profile>/fixtures/seeded-workflows \
 *     --records near-limit
 *
 * `--records` is a count, or `near-limit` ({@link COORDINATOR_WORKFLOW_NEAR_LIMIT},
 * where the panel's banner says the store is nearly full) or `full`
 * ({@link MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS}, where it refuses new work).
 *
 * The records belong to the coordinator of their own project
 * (`seeded-workflows`, a bare `git init` at `--checkout`), so the fixture
 * project and its environments are untouched. Each is an `environment` launch
 * record with no delegation for an environment that does not exist, and its
 * worker-outcome watch is already over (`workerOutcome.ended`, `untracked`):
 * a live watch would tell the coordinator once per record that its worker
 * "was deleted". So nothing reconciles, wakes or notifies about these
 * records. Each is in use only because it
 * is inside the 24-hour replay window (`COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS`),
 * so every run moves the seeded records' `createdAt` to now: the profile shows
 * the state for a day after its last start. Seeded records beyond `--records`
 * are moved two days back instead, which leaves them as finished history a
 * cleanup may clear, so a smaller count takes effect on the next start.
 *
 * The store's limit is shared with every other project, so the seeded records
 * share it too. When the store reaches its limit, each new record goes in the
 * way any launch's does: the store clears a batch of the oldest finished
 * records, whichever project they belong to, and refuses once every record
 * left is in use. Other projects' records in use are never cleared. When that
 * refusal comes before the requested count, seeding stops there with the
 * store full, which is the state `full` asks for, and the result counts the
 * records it could not add (`refused`) instead of failing part-way.
 *
 * Refuses the platform's default data directory and any directory that is not
 * the `data` folder of a development profile.
 */

/** Marks a `dev`/`dev:test` profile root; the same name as `DEV_PROFILE_SENTINEL`. */
const DEV_PROFILE_SENTINEL = ".orkestrator-dev-profile";
const SEEDED_REQUEST_PREFIX = "dev-test-seeded-workflow-";
const STALE_AGE_MS = 2 * 24 * 60 * 60 * 1000;

export interface SeedCoordinatorWorkflowsResult {
  projectId: string;
  coordinatorId: string;
  /** Seeded records added by this run. */
  added: number;
  /** Seeded records now in use (inside the replay window). */
  inUse: number;
  /** Seeded records left as clearable history. */
  stale: number;
  /**
   * Requested records not added because every record left in the store was
   * in use (other projects' work included): the store is full.
   */
  refused: number;
  /** Every workflow record in the store, seeded or not. */
  storeRecords: number;
}

export function assertProfileDataDir(dataDir: string): void {
  if (isDefaultDataDir(dataDir)) {
    throw new Error("Refusing to seed workflow records into the default data directory");
  }
  if (!existsSync(path.join(path.dirname(path.resolve(dataDir)), DEV_PROFILE_SENTINEL))) {
    throw new Error(
      "Refusing to seed workflow records: --data-dir is not the data folder of a development profile",
    );
  }
}

export async function seedCoordinatorWorkflowRecords(
  storage: StorageService,
  options: { checkout: string; records: number; now?: number },
): Promise<SeedCoordinatorWorkflowsResult> {
  const { checkout, records } = options;
  if (
    !Number.isInteger(records) ||
    records < 1 ||
    records > MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS
  ) {
    throw new Error(
      `records must be a whole number from 1 to ${MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS}`,
    );
  }
  const now = options.now ?? Date.now();
  const at = new Date(now).toISOString();
  const staleAt = new Date(now - STALE_AGE_MS).toISOString();
  // There is no worker to watch: the watch ends before it starts, unannounced.
  const endedWatch = { key: "untracked", at, notified: false };

  let project = (await storage.loadProjects()).find((entry) => entry.localPath === checkout);
  if (!project) {
    await mkdir(checkout, { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(checkout, ".git"))) {
      await runCommand("git", ["init", "-q", "-b", "main"], { cwd: checkout });
    }
    project = await storage.addProject(createProject(checkout, checkout));
  }
  // No agent tools server, host or worker activity: `ensure` only needs the
  // store, and it leaves the new main without an agent, so nothing runs.
  const coordinator = new CoordinatorService(
    storage,
    () => ({ enabled: false, running: false, error: null }),
    undefined,
    undefined,
    {},
  );
  const snapshot = await coordinator.ensure(project.id);
  const workspace = snapshot.workspace;
  const main = coordinatorMainConversation(workspace);

  const seeded = (await storage.coordinators.listCoordinatorWorkflowAssociations(project.id))
    .filter(
      (association) =>
        association.coordinatorId === workspace.id &&
        association.requestId.startsWith(SEEDED_REQUEST_PREFIX),
    )
    .sort((a, b) => a.requestId.localeCompare(b.requestId, "en", { numeric: true }));
  const keep = new Set(seeded.slice(0, records).map((association) => association.id));
  // One write moves every existing seeded record, in or out of the window.
  await storage.coordinators.updateCoordinatorWorkflowAssociations(
    seeded.map((association) => ({
      associationId: association.id,
      mutate: (current) => {
        const createdAt = keep.has(current.id) ? at : staleAt;
        if (current.createdAt === createdAt && current.workerOutcome?.ended) return false;
        current.createdAt = createdAt;
        current.workerOutcome ??= {};
        current.workerOutcome.ended ??= endedWatch;
        return true;
      },
    })),
  );

  const taken = new Set(seeded.map((association) => association.requestId));
  let added = 0;
  for (let index = 0; keep.size + added < records; index += 1) {
    const requestId = `${SEEDED_REQUEST_PREFIX}${index}`;
    if (taken.has(requestId)) continue;
    const association: CoordinatorWorkflowAssociation = {
      id: `${requestId}-${workspace.id}`,
      projectId: project.id,
      coordinatorId: workspace.id,
      ...(main ? { conversationId: main.id } : {}),
      kind: "environment",
      resourceId: `seeded-environment-${index}`,
      requestId,
      createdAt: at,
      workerOutcome: { ended: endedWatch },
    };
    try {
      await storage.coordinators.saveCoordinatorWorkflowAssociation(association);
    } catch (error) {
      // Every record left is in use: the store is full, which is as far as
      // seeding can go. Anything else is a real failure.
      if (error instanceof Error && error.message === COORDINATOR_WORKFLOW_STORE_IN_USE_ERROR)
        break;
      throw error;
    }
    added += 1;
  }

  const storeRecords = (await storage.coordinators.getCoordinatorReconciliationState()).workflows
    .length;
  return {
    projectId: project.id,
    coordinatorId: workspace.id,
    added,
    inUse: keep.size + added,
    stale: seeded.length - keep.size,
    refused: records - keep.size - added,
    storeRecords,
  };
}

/** `--records`: a count, `near-limit` or `full`. */
export function resolveSeedRecordCount(value: string | undefined): number {
  if (value === "near-limit") return COORDINATOR_WORKFLOW_NEAR_LIMIT;
  if (value === "full") return MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

if (import.meta.main) {
  const dataDir = argument("data-dir");
  const checkout = argument("checkout");
  const records = resolveSeedRecordCount(argument("records"));
  if (!dataDir || !checkout) {
    console.error(
      "Usage: seed-coordinator-workflows.ts --data-dir <dir> --checkout <dir> --records <n>",
    );
    process.exit(2);
  }
  try {
    assertProfileDataDir(dataDir);
    const storage = new StorageService(path.resolve(dataDir));
    await storage.init();
    try {
      const result = await seedCoordinatorWorkflowRecords(storage, {
        checkout: path.resolve(checkout),
        records,
      });
      console.log(JSON.stringify({ type: "orkestrator-seeded-workflow-records", ...result }));
    } finally {
      storage.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
