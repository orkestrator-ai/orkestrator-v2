import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_LIMITS,
} from "@orkestrator/protocol/web-annotations";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { storageFilesContain } from "./storage-test-support.js";
import { webAnnotationStoreName } from "./web-annotation-store-layout.js";
import { readIndexSnapshot } from "./web-annotation-store-rows.js";
import type { WebAnnotationFaultStage } from "./web-annotation-storage.js";
import {
  ENV_A,
  ENV_B,
  createAnnotation,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import {
  damageStoredRow,
  environmentDir,
  readStoredEnvironment,
  sendRequest,
} from "./web-annotation-test-helpers.js";

let harness: ServiceHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function faultOnce(stage: WebAnnotationFaultStage) {
  const state = { armed: false, fired: 0 };
  return {
    state,
    hook: (current: WebAnnotationFaultStage) => {
      if (state.armed && current === stage) {
        state.armed = false;
        state.fired++;
        throw new Error(`injected ${stage}`);
      }
    },
  };
}

function recordRowCount(dataDir: string, environmentId = ENV_A): number {
  return Object.keys(readStoredEnvironment(dataDir, environmentId)?.records ?? {}).length;
}

async function stage(service: ServiceHarness["service"], seed: number, environmentId = ENV_A) {
  return service.stageAsset({
    environmentId,
    operationId: `op-stage-${seed}`,
    mediaType: "image/png",
    data: makePng(4, 3, seed).toString("base64"),
  });
}

describe("web annotation storage commit protocol", () => {
  test("a failure before the rows are written commits nothing and a retry creates exactly one", async () => {
    const fault = faultOnce("before-record-write");
    harness = await createHarness({ faults: fault.hook });
    fault.state.armed = true;
    await expect(createAnnotation(harness.service, ENV_A, "Note", "op-1")).rejects.toThrow(
      "injected",
    );
    const restarted = await harness.restart({ faults: fault.hook });
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(0);
    const receipt = await createAnnotation(restarted, ENV_A, "Note", "op-1");
    expect(receipt.environmentRevision).toBe(1);
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(1);
  });

  test("a failure after the rows are written rolls the whole commit back, records included", async () => {
    const fault = faultOnce("before-manifest-replace");
    harness = await createHarness({ faults: fault.hook });
    await createAnnotation(harness.service, ENV_A, "First", "op-1");
    expect(recordRowCount(harness.dir)).toBe(2); // capture + entry
    fault.state.armed = true;
    await expect(createAnnotation(harness.service, ENV_A, "Second", "op-2")).rejects.toThrow(
      "injected",
    );
    // The same process keeps serving the committed state.
    expect((await harness.service.list({ environmentId: ENV_A })).total).toBe(1);
    const restarted = await harness.restart({ faults: fault.hook });
    const list = await restarted.list({ environmentId: ENV_A });
    expect(list.items.map((item) => item.title)).toEqual(["First"]);
    expect(await restarted.receipt(ENV_A, "op-2")).toBeNull();
    // No orphaned record rows: nothing is left for garbage collection.
    expect(recordRowCount(harness.dir)).toBe(2);
    const got = await restarted.get(ENV_A, list.items[0]!.id);
    expect(got.entries[0]?.body).toBe("First");
  });

  test("a database failure at the commit point leaves memory and storage at the previous state", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A, "First", "op-1");
    const store = await harness.service.storage.environment(ENV_A);
    const database = harness.service.storage.database();
    const rows = database.rows.bind(database);
    let armed = true;
    // Fails the meta row write: after the record rows, inside the commit.
    const spy = spyOn(database, "rows").mockImplementation((name: string) => {
      const real = rows(name);
      return {
        ...real,
        put(key, value, options) {
          if (armed && options?.collection === "meta") {
            armed = false;
            throw new Error("injected disk I/O error");
          }
          real.put(key, value, options);
        },
      };
    });
    try {
      await expect(createAnnotation(harness.service, ENV_A, "Second", "op-2")).rejects.toThrow(
        "injected disk I/O error",
      );
    } finally {
      spy.mockRestore();
    }
    expect(store.revision).toBe(1);
    expect((await harness.service.list({ environmentId: ENV_A })).total).toBe(1);
    expect(await harness.service.receipt(ENV_A, "op-2")).toBeNull();
    expect(recordRowCount(harness.dir)).toBe(2);
    const retried = await createAnnotation(harness.service, ENV_A, "Second", "op-2");
    expect(retried.environmentRevision).toBe(2);
  });

  test("crash after commit before response is recovered through the operation receipt", async () => {
    const fault = faultOnce("after-commit");
    harness = await createHarness({ faults: fault.hook });
    fault.state.armed = true;
    await expect(createAnnotation(harness.service, ENV_A, "Note", "op-lost")).rejects.toThrow(
      "injected",
    );
    const restarted = await harness.restart({ faults: fault.hook });
    const receipt = await restarted.receipt(ENV_A, "op-lost");
    expect(receipt?.annotationId).toBeDefined();
    const retried = await createAnnotation(restarted, ENV_A, "Note", "op-lost");
    expect(retried).toEqual(receipt!);
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(1);
    await expect(createAnnotation(restarted, ENV_A, "Different", "op-lost")).rejects.toThrow(
      "different request body",
    );
  });

  test("a crash during cleanup leaves committed data intact", async () => {
    const fault = faultOnce("during-cleanup");
    harness = await createHarness({ faults: fault.hook });
    const receipt = await createAnnotation(harness.service, ENV_A, "Keep me", "op-1");
    fault.state.armed = true;
    await expect(harness.service.collectGarbage(ENV_A)).rejects.toThrow("injected");
    const restarted = await harness.restart({ faults: fault.hook });
    expect((await restarted.get(ENV_A, receipt.annotationId)).entries[0]?.body).toBe("Keep me");
    await restarted.collectGarbage(ENV_A);
  });

  test("a damaged record row marks only that item unavailable and read-only", async () => {
    harness = await createHarness();
    const broken = await createAnnotation(harness.service, ENV_A, "Broken", "op-1");
    const healthy = await createAnnotation(harness.service, ENV_A, "Healthy", "op-2");
    damageStoredRow(harness.dir, "records", `${broken.captureId}/1`, "{ corrupt");
    const restarted = await harness.restart();
    const got = await restarted.get(ENV_A, broken.annotationId);
    expect(got.capture).toBeNull();
    expect(got.annotation.unavailable).toBe("capture record unreadable");
    await expect(
      restarted.appendEntryCommand({
        environmentId: ENV_A,
        operationId: "op-3",
        annotationId: broken.annotationId,
        expectedContentRevision: broken.contentRevision,
        body: "more",
      }),
    ).rejects.toThrow("read-only");
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(2);
    expect(
      (await restarted.get(ENV_A, healthy.annotationId)).annotation.unavailable,
    ).toBeUndefined();
  });

  test("a mutation body that returns a promise is refused and commits nothing", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    await expect(
      store.mutate(async (tx) => {
        tx.markDirty();
      }),
    ).rejects.toThrow("synchronous");
    expect(store.revision).toBe(0);
  });

  test("the write queue is bounded", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    const results = await Promise.allSettled(
      Array.from({ length: WEB_ANNOTATION_LIMITS.queuedMutations + 8 }, () =>
        store.mutate((tx) => {
          tx.markDirty();
        }),
      ),
    );
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected.length).toBe(8);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      WEB_ANNOTATION_CAPACITY,
    );
    expect(store.revision).toBe(WEB_ANNOTATION_LIMITS.queuedMutations);
  });

  test("index reads retry until no other process committed between them", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A, "First", "op-1");
    const database = harness.service.storage.database();
    const store = webAnnotationStoreName(ENV_A);
    const other = openBackendDatabase(harness.dir);
    const rows = database.rows.bind(database);
    let commits = 0;
    // Another process commits while the first listing is half done.
    const spy = spyOn(database, "rows").mockImplementation((name: string) => {
      const real = rows(name);
      return {
        ...real,
        list(options) {
          if (options?.collection === "receipts" && commits < 1) {
            commits++;
            other.transaction(() =>
              other.rows(store).put("late", JSON.stringify({ title: "late" }), {
                collection: "annotations",
              }),
            );
          }
          return real.list(options);
        },
      };
    });
    let snapshot: ReturnType<typeof readIndexSnapshot>;
    try {
      snapshot = readIndexSnapshot(database, store);
    } finally {
      spy.mockRestore();
      other.close();
    }
    expect(commits).toBe(1);
    expect(snapshot!.revision).toBe(database.storeRevision(store)!);
    expect(
      snapshot!.rows.some((row) => row.collection === "annotations" && row.key === "late"),
    ).toBe(true);
  });

  test("a commit writes only the rows it changed", async () => {
    harness = await createHarness();
    const receipts = [];
    for (let index = 0; index < 30; index++) {
      receipts.push(await createAnnotation(harness.service, ENV_A, `Note ${index}`, `op-${index}`));
    }
    const database = harness.service.storage.database();
    const changes = () =>
      (database.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    const target = receipts[7]!;
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-reply",
      annotationId: target.annotationId,
      expectedContentRevision: target.contentRevision,
      body: "one more reply",
    });
    // Entry record + entry index + annotation + changed + receipt + meta + header.
    expect(changes() - before).toBeLessThanOrEqual(8);
  });

  test("a mutation that writes into a committed row is refused and commits nothing", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A);
    const store = await harness.service.storage.environment(ENV_A);
    const committed = store.manifest;
    const revision = store.revision;
    // Committed rows are frozen: an in-place write cannot slip past the row
    // plan or corrupt the committed manifest; it throws and rolls back.
    await expect(
      store.mutate((tx) => {
        tx.edit("annotations", receipt.annotationId)!.title = "Edited first";
        tx.touch({ annotationIds: [receipt.annotationId] });
        tx.manifest.annotations[receipt.annotationId] = {
          ...tx.manifest.annotations[receipt.annotationId]!,
        };
        Object.assign(committed.annotations[receipt.annotationId]!, { title: "In place" });
      }),
    ).rejects.toThrow(TypeError);
    expect(store.revision).toBe(revision);
    expect(store.manifest).toBe(committed);
    expect(store.manifest.annotations[receipt.annotationId]!.title).not.toBe("In place");
    expect(store.manifest.annotations[receipt.annotationId]!.title).not.toBe("Edited first");
    const reloaded = await (await harness.restart()).get(ENV_A, receipt.annotationId);
    expect(reloaded.annotation.title).toBe(committed.annotations[receipt.annotationId]!.title);
  });

  test("stale staging uploads are removed only after the grace period", async () => {
    harness = await createHarness();
    const store = await harness.service.storage.environment(ENV_A);
    const staged = await store.stageFile(Buffer.from("x"));
    const orphan = join(store.dir, "staging", "orphan.png");
    await writeFile(orphan, "y");
    const old = new Date(Date.now() - WEB_ANNOTATION_LIMITS.stagingGraceMs - 60_000);
    await utimes(orphan, old, old);
    await utimes(staged, old, old);
    await store.cleanup();
    const remaining = await readdir(join(store.dir, "staging"));
    // The active operation's upload survives; the abandoned one is removed.
    expect(remaining).toEqual([staged.split(/[\\/]/).at(-1)!]);
    await store.releaseStaged(staged);
  });

  test("files are private to the user", async () => {
    harness = await createHarness();
    const staged = await stage(harness.service, 1);
    const envDir = environmentDir(harness.dir);
    expect((await stat(envDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(envDir, "assets"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(envDir, "assets", `${staged.asset.id}.png`))).mode & 0o777).toBe(0o600);
    expect((await stat(join(harness.dir, STORAGE_DATABASE_FILE))).mode & 0o777).toBe(0o600);
  });
});

describe("two backends sharing a data directory", () => {
  test("each sees the other's commits without a restart", async () => {
    harness = await createHarness();
    const peer = await harness.peer();
    expect((await peer.list({ environmentId: ENV_A })).total).toBe(0);
    const receipt = await createAnnotation(harness.service, ENV_A, "From the first", "op-1");
    const seen = await peer.get(ENV_A, receipt.annotationId);
    expect(seen.entries[0]?.body).toBe("From the first");
    await peer.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-2",
      annotationId: receipt.annotationId,
      expectedContentRevision: seen.annotation.contentRevision,
      body: "From the second",
    });
    const back = await harness.service.get(ENV_A, receipt.annotationId);
    expect(back.entries.map((entry) => entry.body)).toEqual(["From the first", "From the second"]);
    expect(await harness.service.receipt(ENV_A, "op-2")).not.toBeNull();
  });

  test("a read that observes the other backend's commit emits a change hint for it", async () => {
    harness = await createHarness();
    const peerEvents: unknown[] = [];
    const peer = await harness.peer({ emit: (_event, payload) => peerEvents.push(payload) });
    await harness.service.list({ environmentId: ENV_A });
    const receipt = await createAnnotation(peer, ENV_A, "From the peer", "op-1");
    expect(peerEvents).toHaveLength(1);
    expect(harness.events).toHaveLength(0);
    await harness.service.list({ environmentId: ENV_A });
    await Promise.resolve();
    expect(harness.events.map((event) => event.payload)).toEqual([
      expect.objectContaining({ revision: 1, annotationIds: [receipt.annotationId] }),
    ]);
    const changes = await harness.service.changes(ENV_A, harness.service.generation, 0);
    expect(changes).toMatchObject({ resetRequired: false, revision: 1 });
    // A jump over several foreign revisions never claims the skipped ones.
    await createAnnotation(peer, ENV_A, "two", "op-2");
    await createAnnotation(peer, ENV_A, "three", "op-3");
    expect(
      (await harness.service.changes(ENV_A, harness.service.generation, 1)).resetRequired,
    ).toBe(true);
  });

  test("concurrent commits from both never lose an update", async () => {
    harness = await createHarness();
    const peer = await harness.peer();
    await Promise.all([
      harness.service.list({ environmentId: ENV_A }),
      peer.list({ environmentId: ENV_A }),
    ]);
    const work: Array<Promise<unknown>> = [];
    for (let index = 0; index < 12; index++) {
      const service = index % 2 === 0 ? harness.service : peer;
      work.push(createAnnotation(service, ENV_A, `Note ${index}`, `op-${index}`));
    }
    await Promise.all(work);
    for (const service of [harness.service, peer]) {
      const list = await service.list({ environmentId: ENV_A, limit: 50 });
      expect(list.total).toBe(12);
      for (let index = 0; index < 12; index++) {
        expect(await service.receipt(ENV_A, `op-${index}`)).not.toBeNull();
      }
    }
    expect((await peer.storage.environment(ENV_A)).revision).toBe(12);
    expect(readStoredEnvironment(harness.dir)?.meta.state.revision).toBe(12);
  });

  test("a commit on a stale model reloads the other backend's change instead of overwriting it", async () => {
    harness = await createHarness();
    const peer = await harness.peer();
    const receipt = await createAnnotation(harness.service, ENV_A, "Shared", "op-1");
    const mine = await harness.service.storage.environment(ENV_A);
    const theirs = await peer.storage.environment(ENV_A);
    expect(theirs.manifest.annotations[receipt.annotationId]).toBeDefined();
    // The first backend replies; the second never reads before its own write.
    await harness.service.appendEntryCommand({
      environmentId: ENV_A,
      operationId: "op-2",
      annotationId: receipt.annotationId,
      expectedContentRevision: receipt.contentRevision,
      body: "reply",
    });
    await theirs.mutate((tx) => {
      tx.edit("annotations", receipt.annotationId)!.hidden = true;
      tx.touch({ annotationIds: [receipt.annotationId] });
    });
    const annotation = mine.manifest.annotations[receipt.annotationId]!;
    expect(annotation.hidden).toBe(true);
    expect(annotation.entryCount).toBe(2);
    expect(mine.manifest.entries[receipt.annotationId]).toHaveLength(2);
    expect(mine.revision).toBe(3);
  });

  test("drafts saved by both backends are both kept", async () => {
    harness = await createHarness();
    const peer = await harness.peer();
    await Promise.all([
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 0,
        text: "first backend",
      }),
      peer.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-2",
        expectedRevision: 0,
        text: "second",
      }),
    ]);
    expect((await harness.service.getDraft(ENV_A, "ed-2"))?.text).toBe("second");
    expect((await peer.getDraft(ENV_A, "ed-1"))?.text).toBe("first backend");
    // The same editor on both: the stale revision conflicts instead of overwriting.
    await expect(
      peer.saveDraft({ environmentId: ENV_A, editorId: "ed-1", expectedRevision: 0, text: "lost" }),
    ).rejects.toThrow("stale");
  });

  test("garbage collection never deletes an asset the other backend committed", async () => {
    harness = await createHarness();
    const peer = await harness.peer();
    // The peer has the environment loaded before the asset exists.
    await peer.list({ environmentId: ENV_A });
    const staged = await stage(harness.service, 5);
    const receipt = await createAnnotation(harness.service, ENV_A, "with image", "op-img", [
      staged.asset.id,
    ]);
    const file = join(environmentDir(harness.dir), "assets", `${staged.asset.id}.png`);
    const old = new Date(Date.now() - 2 * WEB_ANNOTATION_LIMITS.assetGcGraceMs);
    await utimes(file, old, old);
    harness.clock.advance(2 * WEB_ANNOTATION_LIMITS.assetGcGraceMs);
    await peer.collectGarbage(ENV_A);
    expect(existsSync(file)).toBe(true);
    expect((await harness.service.getAsset(ENV_A, staged.asset.id)).asset.id).toBe(staged.asset.id);
    expect((await peer.get(ENV_A, receipt.annotationId)).capture?.assetIds).toEqual([
      staged.asset.id,
    ]);
    // A file no row references is still collected after the grace period.
    const stray = join(environmentDir(harness.dir), "assets", "asset-stray.png");
    await writeFile(stray, makePng());
    await utimes(stray, old, old);
    await peer.collectGarbage(ENV_A);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  test("a peer's empty cached environment cannot be recreated by first or queued writes", async () => {
    harness = await createHarness();
    const peer = await harness.peer();
    await peer.list({ environmentId: ENV_A });
    const store = await peer.storage.environment(ENV_A);
    // Both calls enqueue while the authoritative store is still absent.
    let resume!: () => void;
    (store as unknown as { tail: Promise<void> }).tail = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const queued = store.mutate((tx) => {
      tx.touch({});
    });
    const outcome = queued.catch((error: unknown) => error);
    await harness.service.deleteEnvironment(ENV_A);
    resume();
    expect(await outcome).toBeInstanceOf(Error);
    await expect(
      peer.saveDraft({
        environmentId: ENV_A,
        editorId: "first",
        expectedRevision: 0,
        text: "late",
      }),
    ).rejects.toThrow("deleted");
    await expect(createAnnotation(peer, ENV_A, "late", "late-op")).rejects.toThrow("deleted");
    expect(readStoredEnvironment(harness.dir)).toBeUndefined();
  });

  test("an environment deleted by one backend refuses writes in the other", async () => {
    harness = await createHarness();
    const peer = await harness.peer();
    await createAnnotation(harness.service, ENV_A, "Note", "op-1");
    expect((await peer.list({ environmentId: ENV_A })).total).toBe(1);
    await harness.service.deleteEnvironment(ENV_A);
    await expect(createAnnotation(peer, ENV_A, "Again", "op-2")).rejects.toThrow("deleted");
    expect(readStoredEnvironment(harness.dir)).toBeUndefined();
    expect(peer.storage.isDeleted(ENV_A)).toBe(true);
  });
});

describe("environment deletion privacy", () => {
  test("deleting an environment leaves none of its content in the database files", async () => {
    harness = await createHarness();
    const receipt = await createAnnotation(harness.service, ENV_A, "SECRET-NOTE-c41d body");
    await sendRequest(harness.service, receipt.annotationId, "req-1", {
      instruction: "SECRET-INSTRUCTION-9e02",
    });
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "SECRET-DRAFT-55ab",
    });
    await createAnnotation(harness.service, ENV_B, "kept in the other environment");
    const secrets = ["SECRET-NOTE-c41d", "SECRET-INSTRUCTION-9e02", "SECRET-DRAFT-55ab"];
    for (const secret of secrets) expect(storageFilesContain(harness.dir, secret)).toBe(true);
    await harness.service.deleteEnvironment(ENV_A);
    for (const secret of secrets) expect(storageFilesContain(harness.dir, secret)).toBe(false);
    expect(existsSync(environmentDir(harness.dir))).toBe(false);
    expect(readStoredEnvironment(harness.dir)).toBeUndefined();
    expect((await harness.service.list({ environmentId: ENV_B })).total).toBe(1);
  });
});

describe("web annotation storage startup", () => {
  test("removes stores whose environment no longer exists instead of loading them", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_A);
    await createAnnotation(harness.service, ENV_B);
    harness.host.environments.delete(ENV_B);

    await harness.restart();
    expect(harness.service.storage.loadedEnvironmentIds()).toEqual([ENV_A]);
    expect(readStoredEnvironment(harness.dir, ENV_B)).toBeUndefined();
    expect(readStoredEnvironment(harness.dir, ENV_A)).toBeDefined();
  });

  test("keeps every store when the environment lookup fails", async () => {
    harness = await createHarness();
    await createAnnotation(harness.service, ENV_B);
    harness.host.getEnvironment = async () => {
      throw new Error("environment store unreadable");
    };

    await harness.restart();
    expect(harness.service.storage.loadedEnvironmentIds()).toEqual([ENV_B]);
    expect(readStoredEnvironment(harness.dir, ENV_B)).toBeDefined();
  });
});
