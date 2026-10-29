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
