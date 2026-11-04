import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RESOURCE_MANIFEST_FILES } from "./storage-changes.js";
import { STORAGE_COLLECTION_MARKER } from "@orkestrator/protocol/node/storage-database";
import { StoreTooLargeError } from "./storage-database.js";
import { StorageContext } from "./storage-context.js";
import type { ResourceChange } from "./storage.js";
import { RESOURCE_MANIFEST_KINDS } from "./storage-shared.js";
import { readStoredValue } from "./storage-test-support.js";

import { nativeSessionInvalidationMetrics } from "./native-session-invalidation-metrics.js";

const directories: string[] = [];
const contexts: StorageContext[] = [];

async function open(directory?: string): Promise<{ context: StorageContext; dataDir: string }> {
  const dataDir =
    directory ?? (await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-context-")));
  if (!directory) directories.push(dataDir);
  const context = new StorageContext(dataDir);
  contexts.push(context);
  await context.open();
  return { context, dataDir };
}

afterEach(async () => {
  for (const context of contexts.splice(0)) context.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("StorageContext", () => {
  test("buffers keyed array inserts, updates and deletes until atomic commit", async () => {
    const { context, dataDir } = await open();
    const file = context.file("environments.json");
    const original = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    await context.saveJson(file, original);

    await context.atomically(async () => {
      expect(
        context.updateStoreRow(file, "c", (current) => {
          expect(current).toBeUndefined();
          return { value: { id: "c", name: "C" }, result: "inserted" };
        }),
      ).toBe("inserted");
      expect(
        context.updateStoreRow(file, "b", (current) => {
          expect(current).toEqual(original[1]);
          return { value: { id: "b", name: "updated" }, result: "updated" };
        }),
      ).toBe("updated");
      expect(
        context.updateStoreRow(file, "a", (current) => ({
          delete: true,
          result: current,
        })),
      ).toEqual(original[0]);
      expect(context.updateStoreRow(file, "c", (current) => ({ result: current }))).toEqual({
        id: "c",
        name: "C",
      });
      expect(context.updateStoreRow(file, "a", (current) => ({ result: current }))).toBeUndefined();
      expect(await context.loadJson<unknown[]>(file, () => [])).toEqual([
        { id: "b", name: "updated" },
        { id: "c", name: "C" },
      ]);
      expect(readStoredValue(dataDir, "environments.json")).toEqual(original);
    });

    expect(readStoredValue(dataDir, "environments.json")).toEqual([
      { id: "b", name: "updated" },
      { id: "c", name: "C" },
    ]);
  });

  test("atomic keyed array no-ops neither create a store nor advance its revision", async () => {
    const { context, dataDir } = await open();
    const file = context.file("environments.json");
    const noOp = async () => {
      await context.atomically(async () => {
        expect(
          context.updateStoreRow(file, "missing", (current) => ({ result: current })),
        ).toBeUndefined();
        expect(
          context.updateStoreRow(file, "missing", () => ({ delete: true, result: "absent" })),
        ).toBe("absent");
      });
    };
    const absentRevision = context.database.storeRevision("environments");
    await noOp();
    expect(readStoredValue(dataDir, "environments.json")).toBeUndefined();
    expect(context.database.storeRevision("environments")).toBe(absentRevision);

    const original = [{ id: "a", name: "A" }];
    await context.saveJson(file, original);
    const revision = context.database.storeRevision("environments");
    await noOp();
    await context.atomically(async () => {
      expect(context.updateStoreRow(file, "a", (current) => ({ result: current }))).toEqual(
        original[0],
      );
      context.updateStoreRow(file, "a", () => ({ value: original[0], result: undefined }));
    });
    expect(readStoredValue(dataDir, "environments.json")).toEqual(original);
    expect(context.database.storeRevision("environments")).toBe(revision);
  });

  test("rolls back buffered keyed array mutations when an atomic scope fails", async () => {
    const { context, dataDir } = await open();
    const file = context.file("environments.json");
    const original = [{ id: "a" }, { id: "b" }];
    await context.saveJson(file, original);
    const revision = context.database.storeRevision("environments");
    await expect(
      context.atomically(async () => {
        context.updateStoreRow(file, "c", () => ({ value: { id: "c" }, result: undefined }));
        context.updateStoreRow(file, "a", () => ({ delete: true, result: undefined }));
        expect(await context.loadJson<unknown[]>(file, () => [])).toEqual([
          { id: "b" },
          { id: "c" },
        ]);
        throw new Error("rollback array");
      }),
    ).rejects.toThrow("rollback array");
    expect(readStoredValue(dataDir, "environments.json")).toEqual(original);
    expect(await context.loadJson<unknown[]>(file, () => [])).toEqual(original);
    expect(context.database.storeRevision("environments")).toBe(revision);
  });

  test("commits an atomic scope whole and announces only after the commit", async () => {
    const { context, dataDir } = await open();
    const seen: ResourceChange[] = [];
    context.changes.addResourceChangeListener((change) => {
      expect(readStoredValue(dataDir, "kanban.json")).toEqual([{ id: "t1" }]);
      seen.push(change);
    });
    await context.atomically(async () => {
      await context.saveJson(context.file("kanban.json"), [{ id: "t1" }]);
      context.updateStore(
        context.file("project-notes.json"),
        (): unknown[] => [],
        (notes) => {
          notes.push({ projectId: "p1", content: "x", updatedAt: "y" });
        },
      );
      expect(readStoredValue(dataDir, "kanban.json")).toBeUndefined();
      context.changes.announce("kanban", "p1");
      expect(seen).toEqual([]);
    });
    expect(seen.map((change) => [change.resource, change.id, change.revision])).toEqual([
      ["kanban", "p1", 1],
    ]);
    expect(readStoredValue(dataDir, "project-notes.json")).toHaveLength(1);
  });

  test("retains native invalidation causes and counts only committed announcements once", async () => {
    const { context } = await open();
    const seen: ResourceChange[] = [];
    context.changes.addResourceChangeListener((change) => seen.push(change));
    const count = () => nativeSessionInvalidationMetrics.snapshot().byCause["record-title"] ?? 0;
    const before = count();
    await context.atomically(async () => {
      context.changes.announce(
        "native-agent-session",
        "e1",
        undefined,
        { agent: "codex", logicalSessionKey: "env-e1:tab" },
        false,
        "record-title",
      );
      expect(seen).toEqual([]);
      expect(count()).toBe(before);
    });
    expect(seen).toEqual([
      expect.objectContaining({
        resource: "native-agent-session",
        cause: "record-title",
        agent: "codex",
        logicalSessionKey: "env-e1:tab",
      }),
    ]);
    expect(count()).toBe(before + 1);
    await expect(
      context.atomically(async () => {
        context.changes.announce(
          "native-agent-session",
          "e1",
          undefined,
          undefined,
          false,
          "record-title",
        );
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(seen).toHaveLength(1);
    expect(count()).toBe(before + 1);
  });

  test("uses the compact UTF-8 byte limit for direct and atomic sensitive saves", async () => {
    const { context, dataDir } = await open();
    const file = context.file("agent-mail.json");
    const row = { body: "é".repeat(40) };
    const value = {
      version: 1,
      mailboxes: { ["long-mailbox-key".repeat(100)]: row },
      idempotency: {},
      counterparts: {},
      pendingInject: [],
    };
    const compactBytes =
      Buffer.byteLength(
        JSON.stringify({
          ...value,
          mailboxes: STORAGE_COLLECTION_MARKER,
          idempotency: STORAGE_COLLECTION_MARKER,
          counterparts: STORAGE_COLLECTION_MARKER,
        }),
        "utf8",
      ) + Buffer.byteLength(JSON.stringify(row), "utf8");
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeGreaterThan(compactBytes);
    await context.saveSensitiveJson(file, value, { maxBytes: compactBytes });
    await context.atomically(async () => {
      await context.saveSensitiveJson(file, value, { maxBytes: compactBytes });
      expect(await context.loadJson<typeof value | null>(file, () => null)).toEqual(value);
      expect(context.loadStoreStrict<typeof value>(file)).toEqual({ value });
      expect(await context.storeExists(file)).toBe(true);
    });
    expect(readStoredValue(dataDir, "agent-mail.json")).toEqual(value);

    await expect(
      context.saveSensitiveJson(file, value, { maxBytes: compactBytes - 1 }),
    ).rejects.toMatchObject({ name: "StoreTooLargeError", bytes: compactBytes });
    const revision = context.database.storeRevision("agent-mail");
    const seen: ResourceChange[] = [];
    context.changes.addResourceChangeListener((change) => seen.push(change));
    let buffered = false;
    await expect(
      context.atomically(async () => {
        await context.saveJson(context.file("kanban.json"), [{ id: "must-rollback" }]);
        await context.saveSensitiveJson(file, value, { maxBytes: compactBytes - 1 });
        context.changes.announce("kanban", "p1");
        buffered = true;
      }),
    ).rejects.toMatchObject({ name: "StoreTooLargeError", bytes: compactBytes });
    expect(buffered).toBe(true);
    expect(context.database.storeRevision("agent-mail")).toBe(revision);
    expect(readStoredValue(dataDir, "agent-mail.json")).toEqual(value);
    expect(readStoredValue(dataDir, "kanban.json")).toBeUndefined();
    expect(seen).toEqual([]);
  });

  test.each(["row", "whole"] as const)(
    "retains a buffered size limit when a later %s mutation enlarges the store",
    async (mutation) => {
      const { context, dataDir } = await open();
      const file = context.file("agent-mail.json");
      await expect(
        context.atomically(async () => {
          await context.saveSensitiveJson(file, { mailboxes: {} }, { maxBytes: 100 });
          if (mutation === "row") {
            context.updateStoreRow(
              file,
              "recipient",
              () => ({ value: { body: "x".repeat(200) }, result: undefined }),
              { collection: "mailboxes" },
            );
          } else {
            context.updateStore(
              file,
              () => ({ mailboxes: {} }),
              (store) => {
                Object.assign(store.mailboxes, { recipient: { body: "x".repeat(200) } });
              },
            );
          }
        }),
      ).rejects.toBeInstanceOf(StoreTooLargeError);
      expect(readStoredValue(dataDir, "agent-mail.json")).toBeUndefined();
    },
  );

  test("runs one target's critical sections in order and forgets the settled queue", async () => {
    const { context } = await open();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = context.serialize(context.file("kanban.json"), "probe", async () => {
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push("first");
    });
    const second = context.serialize(context.file("kanban.json"), "probe", async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tails = (context as unknown as { mutationTails: Map<string, unknown> }).mutationTails;
    expect(tails.size).toBe(0);
  });

  test("excludes a second context on the same data directory through the lease", async () => {
    const { context: first, dataDir } = await open();
    const { context: second } = await open(dataDir);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => (entered = resolve));
    const held = first.serialize(first.file("kanban.json"), "probe", async () => {
      entered();
      await new Promise<void>((resolve) => (releaseFirst = resolve));
      order.push("first");
    });
    await holding;
    const waiting = second.serialize(second.file("kanban.json"), "probe", async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    releaseFirst();
    await Promise.all([held, waiting]);
    expect(order).toEqual(["first", "second"]);
  });

  test("revises every manifest resource by a database store, except the config file", async () => {
    const { context } = await open();
    for (const resource of RESOURCE_MANIFEST_KINDS) {
      const store = context.storeForFile(context.file(RESOURCE_MANIFEST_FILES[resource]));
      if (resource === "config") expect(store).toBeNull();
      else expect(store).not.toBeNull();
    }
    const before = await context.changes.getResourceSnapshotRevision("kanban");
    await context.saveJson(context.file("kanban.json"), [{ id: "t1" }]);
    expect(await context.changes.getResourceSnapshotRevision("kanban")).not.toBe(before);
  });
});
