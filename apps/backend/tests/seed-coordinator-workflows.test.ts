import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import {
  assertProfileDataDir,
  resolveSeedRecordCount,
  seedCoordinatorWorkflowRecords,
} from "../scripts/seed-coordinator-workflows.js";
import {
  COORDINATOR_WORKFLOW_NEAR_LIMIT,
  MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
} from "../src/core/coordinator-workflow-retention.js";
import { workerOutcomeOwners } from "../src/core/coordinator-worker-outcomes.js";
import { StorageService } from "../src/core/storage.js";

const roots: string[] = [];
const stores: StorageService[] = [];

afterEach(async () => {
  for (const storage of stores.splice(0)) storage.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A development profile root: the sentinel beside an empty `data` folder. */
async function profile() {
  const root = await mkdtemp(path.join(tmpdir(), "ork-seed-workflows-"));
  roots.push(root);
  await writeFile(path.join(root, ".orkestrator-dev-profile"), "{}");
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  stores.push(storage);
  return { root, storage, checkout: path.join(root, "fixtures", "seeded-workflows") };
}

describe("seeding in-use coordinator workflow records", () => {
  test("near-limit and full resolve to the banner's own thresholds", () => {
    expect(resolveSeedRecordCount("near-limit")).toBe(COORDINATOR_WORKFLOW_NEAR_LIMIT);
    expect(resolveSeedRecordCount("full")).toBe(MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS);
    expect(resolveSeedRecordCount("12")).toBe(12);
    expect(resolveSeedRecordCount("lots")).toBeNaN();
    // Written as the launcher's parser requires: no sign, no leading zeros.
    expect(resolveSeedRecordCount("0012")).toBeNaN();
    expect(resolveSeedRecordCount("0")).toBeNaN();
    expect(resolveSeedRecordCount("+5")).toBeNaN();
    expect(resolveSeedRecordCount(undefined)).toBeNaN();
  });

  test("refuses a directory that is not a development profile's data folder", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ork-seed-workflows-refused-"));
    roots.push(root);
    expect(() => assertProfileDataDir(path.join(root, "data"))).toThrow(
      "not the data folder of a development profile",
    );
    await writeFile(path.join(root, ".orkestrator-dev-profile"), "{}");
    expect(() => assertProfileDataDir(path.join(root, "data"))).not.toThrow();
  });

  test("rejects counts outside the store's limit", async () => {
    const { storage, checkout } = await profile();
    for (const records of [0, MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS + 1, 1.5, Number.NaN]) {
      await expect(seedCoordinatorWorkflowRecords(storage, { checkout, records })).rejects.toThrow(
        "records must be a whole number",
      );
    }
  });

  test("the store reports near-limit, then full, then ok as the seeded count changes", async () => {
    const { storage, checkout } = await profile();
    expect(await storage.coordinators.getCoordinatorWorkflowStoreState()).toBe("ok");

    const nearLimit = await seedCoordinatorWorkflowRecords(storage, {
      checkout,
      records: COORDINATOR_WORKFLOW_NEAR_LIMIT,
    });
    expect(nearLimit).toMatchObject({
      added: COORDINATOR_WORKFLOW_NEAR_LIMIT,
      inUse: COORDINATOR_WORKFLOW_NEAR_LIMIT,
      stale: 0,
      storeRecords: COORDINATOR_WORKFLOW_NEAR_LIMIT,
    });
    expect(await storage.coordinators.getCoordinatorWorkflowStoreState()).toBe("near-limit");
    // The records sit under their own project's coordinator, which is not
    // given an agent, so nothing would run there.
    const project = (await storage.loadProjects()).find((entry) => entry.localPath === checkout);
    expect(project?.id).toBe(nearLimit.projectId);
    const workspace = await storage.coordinators.getCoordinatorWorkspace(nearLimit.projectId);
    expect(workspace?.id).toBe(nearLimit.coordinatorId);
    expect(workspace?.conversations.every((item) => !item.agent)).toBe(true);
    // Nothing reconciles or wakes them: they are not delegations.
    expect(await storage.coordinators.listOpenCoordinatorDelegations()).toEqual([]);
    expect(await storage.coordinators.listUnwokenCoordinatorDelegations()).toEqual([]);
    // No worker-outcome watch is live, so none reports a missing worker as
    // deleted (one notice per record otherwise).
    const { workflows } = await storage.coordinators.getCoordinatorReconciliationState();
    const live = [...workerOutcomeOwners(workflows).values()]
      .flat()
      .filter((owner) => !owner.workerOutcome?.ended);
    expect(live).toEqual([]);

    const full = await seedCoordinatorWorkflowRecords(storage, {
      checkout,
      records: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
    });
    expect(full).toMatchObject({
      projectId: nearLimit.projectId,
      added: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - COORDINATOR_WORKFLOW_NEAR_LIMIT,
      inUse: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
    });
    expect(await storage.coordinators.getCoordinatorWorkflowStoreState()).toBe("full");

    // A smaller count leaves the rest as history a cleanup may clear.
    const few = await seedCoordinatorWorkflowRecords(storage, { checkout, records: 10 });
    expect(few).toMatchObject({
      added: 0,
      inUse: 10,
      stale: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - 10,
      storeRecords: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
    });
    expect(await storage.coordinators.getCoordinatorWorkflowStoreState()).toBe("ok");
  }, 60_000);

  test("records stay in use for the replay window after the seeding run", async () => {
    const { storage, checkout } = await profile();
    const day = 24 * 60 * 60 * 1000;
    // Seeded two days ago and not refreshed since: finished history.
    await seedCoordinatorWorkflowRecords(storage, {
      checkout,
      records: COORDINATOR_WORKFLOW_NEAR_LIMIT,
      now: Date.now() - 2 * day,
    });
    expect(await storage.coordinators.getCoordinatorWorkflowStoreState()).toBe("ok");
    // The next start moves them back into the window.
    const refreshed = await seedCoordinatorWorkflowRecords(storage, {
      checkout,
      records: COORDINATOR_WORKFLOW_NEAR_LIMIT,
    });
    expect(refreshed).toMatchObject({ added: 0, inUse: COORDINATOR_WORKFLOW_NEAR_LIMIT });
    expect(await storage.coordinators.getCoordinatorWorkflowStoreState()).toBe("near-limit");
  }, 60_000);

  test("full shares the store with other projects' records and stops when it is full", async () => {
    const { storage, checkout } = await profile();
    const day = 24 * 60 * 60 * 1000;
    // Another project's launch records for environments that no longer
    // exist: some still inside the replay window (in use), some finished.
    const other = (index: number, createdAt: number): CoordinatorWorkflowAssociation => ({
      id: `other-${index}`,
      projectId: "other-project",
      coordinatorId: "other-coordinator",
      kind: "environment",
      resourceId: `other-environment-${index}`,
      requestId: `other-request-${index}`,
      createdAt: new Date(createdAt).toISOString(),
      workerOutcome: {
        ended: { key: "untracked", at: new Date(createdAt).toISOString(), notified: false },
      },
    });
    const inUse = 30;
    const finished = 50;
    for (let index = 0; index < inUse; index += 1) {
      await storage.coordinators.saveCoordinatorWorkflowAssociation(other(index, Date.now()));
    }
    for (let index = inUse; index < inUse + finished; index += 1) {
      await storage.coordinators.saveCoordinatorWorkflowAssociation(
        other(index, Date.now() - 3 * day),
      );
    }

    const full = await seedCoordinatorWorkflowRecords(storage, {
      checkout,
      records: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
    });
    // The store made room by clearing the other project's finished records,
    // as it does for any launch, then refused once only records in use were
    // left: seeding stops there instead of failing part-way.
    expect(full).toMatchObject({
      added: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - inUse,
      inUse: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - inUse,
      stale: 0,
      refused: inUse,
      storeRecords: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
    });
    expect(await storage.coordinators.getCoordinatorWorkflowStoreState()).toBe("full");
    const { workflows } = await storage.coordinators.getCoordinatorReconciliationState();
    const others = workflows
      .filter((association) => association.projectId === "other-project")
      .map((association) => association.id)
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    // Every record the other project still uses is kept.
    expect(others).toEqual(Array.from({ length: inUse }, (_, index) => `other-${index}`));

    // A repeat start refreshes what it seeded and refuses the same shortfall.
    const again = await seedCoordinatorWorkflowRecords(storage, {
      checkout,
      records: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS,
    });
    expect(again).toMatchObject({
      added: 0,
      inUse: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - inUse,
      refused: inUse,
    });
  }, 60_000);
});
