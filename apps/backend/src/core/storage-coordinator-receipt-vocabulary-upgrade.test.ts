import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COORDINATOR_WORKSPACE_VERSION } from "@orkestrator/protocol/coordinator";
import { isCoordinatorSurfaceAction } from "@orkestrator/protocol/coordinator-surfaces";
import { StorageDatabase } from "./storage-database.js";
import { openBackendDatabase, STORAGE_MIGRATIONS, storeLayout } from "./storage-stores.js";
import {
  COORDINATOR_RECEIPT_VOCABULARY_UPGRADE_VERSION,
  upgradeCoordinatorReceiptVocabulary,
} from "./storage-coordinator-receipt-vocabulary-upgrade.js";

const directories: string[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-receipt-vocabulary-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function receipt(requestId: string, action: string): Record<string, unknown> {
  return {
    coordinatorId: "coordinator-1",
    projectId: "project-1",
    conversationId: "conversation-1",
    requestId,
    action,
    payloadHash: `hash-${requestId}`,
    state: "completed",
    result: { outcome: "pending" },
    createdAt: "2026-11-10T00:00:00.000Z",
    completedAt: "2026-11-10T00:00:01.000Z",
  };
}

function formerStore(): Record<string, unknown> {
  return {
    version: COORDINATOR_WORKSPACE_VERSION,
    revision: 3,
    workspaces: {},
    workflows: [],
    actionReceipts: [receipt("custom-1", "custom-fix"), receipt("pr-1", "create-pr")],
  };
}

describe("coordinator receipt vocabulary upgrade", () => {
  test("renames the former custom Fix receipt and keeps every other field", () => {
    const upgraded = upgradeCoordinatorReceiptVocabulary(formerStore()) as {
      actionReceipts: Array<Record<string, unknown>>;
    };
    expect(upgraded.actionReceipts).toEqual([
      receipt("custom-1", "custom-address"),
      receipt("pr-1", "create-pr"),
    ]);
    expect(upgraded.actionReceipts.every((item) => isCoordinatorSurfaceAction(item.action))).toBe(
      true,
    );
    expect(isCoordinatorSurfaceAction("custom-fix")).toBe(false);
  });

  test("leaves current, receipt-free and unreadable stores untouched", () => {
    const current = upgradeCoordinatorReceiptVocabulary(formerStore());
    expect(upgradeCoordinatorReceiptVocabulary(current)).toBe(current);
    const empty = { version: COORDINATOR_WORKSPACE_VERSION, workspaces: {}, workflows: [] };
    expect(upgradeCoordinatorReceiptVocabulary(empty)).toBe(empty);
    expect(upgradeCoordinatorReceiptVocabulary("not a store")).toBe("not a store");
  });

  test("a seeded older database is rewritten once by the migration", async () => {
    const directory = await dataDir();
    const earlier = STORAGE_MIGRATIONS.filter(
      (migration) => migration.version < COORDINATOR_RECEIPT_VOCABULARY_UPGRADE_VERSION,
    );
    const before = new StorageDatabase(directory, { layoutFor: storeLayout, migrations: earlier });
    before.writeStore("coordinators", formerStore());
    before.close();

    const after = openBackendDatabase(directory);
    try {
      expect(after.schemaVersion()).toBeGreaterThanOrEqual(
        COORDINATOR_RECEIPT_VOCABULARY_UPGRADE_VERSION,
      );
      const stored = after.readStore("coordinators")!.value as {
        revision: number;
        actionReceipts: Array<Record<string, unknown>>;
      };
      expect(stored.revision).toBe(3);
      expect(stored.actionReceipts.map((item) => item.action)).toEqual([
        "custom-address",
        "create-pr",
      ]);
    } finally {
      after.close();
    }
  });
});
