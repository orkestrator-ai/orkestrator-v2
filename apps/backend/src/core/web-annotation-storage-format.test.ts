/**
 * The persisted formats: the database rows of an environment, and the lazy
 * import of the file-based format (manifest.json, drafts.json, records/).
 * Legacy fixtures are produced by building state through the service and
 * writing it the way the file engine did (`exportLegacyEnvironment`) into a
 * fresh data directory, which the real import then reads.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEB_ANNOTATION_DEGRADED } from "@orkestrator/protocol/web-annotations";
import { fixtureCaptureInput } from "@orkestrator/protocol/web-annotations-fixtures";
import { WebAnnotationStorage } from "./web-annotation-storage.js";
import { StorageDatabase } from "./storage-database.js";
import { LEGACY_JSON_DIRECTORY } from "./storage-stores.js";
import { webAnnotationStoreName } from "./web-annotation-store-layout.js";
import {
  WEB_ANNOTATION_MANIFEST_VERSION,
  requestTextRecordId,
  type WebAnnotationFaultStage,
} from "./web-annotation-storage.js";
import {
  ENV_A,
  createAnnotation,
  createHarness,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import {
  environmentDir,
  exportLegacyEnvironment,
  legacyRecordPath,
  readJsonFile,
  readStoredEnvironment,
  rejectionDetail,
  sendRequest,
  withDatabase,
} from "./web-annotation-test-helpers.js";

const harnesses: ServiceHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

async function harnessFor(dir?: string, overrides = {}) {
  const harness = await createHarness(overrides, dir ? { dir } : {});
  harnesses.push(harness);
  return harness;
}

/**
 * Build state with `build`, write it in the file format into a new data
 * directory, let `mangle` edit the files, then open a service on it.
 */
async function legacy(
  build: (harness: ServiceHarness) => Promise<void>,
  mangle: (dir: string) => Promise<void> = async () => {},
  options: { previous?: boolean } = {},
) {
  const source = await harnessFor();
  await build(source);
  const dir = await mkdtemp(join(tmpdir(), "ork-wa-legacy-"));
  await exportLegacyEnvironment(source.service, dir, options);
  await mangle(environmentDir(dir));
  const imported = await harnessFor(dir);
  return { source, imported, dir, envDir: environmentDir(dir) };
}

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

async function archivedEnvironments(dir: string): Promise<string[]> {
  const root = join(dir, LEGACY_JSON_DIRECTORY);
  const found: string[] = [];
  for (const stamp of await readdir(root).catch(() => [] as string[])) {
    for (const name of await readdir(join(root, stamp, "web-annotations")).catch(
      () => [] as string[],
    )) {
      found.push(join(root, stamp, "web-annotations", name));
    }
  }
  return found;
}

const SECRET_INSTRUCTION = "SECRET-INSTRUCTION-7f3a make the button bigger";

describe("database rows", () => {
  test("instructions, response excerpts and draft text live in their own rows, never the files", async () => {
    const harness = await harnessFor();
    const receipt = await createAnnotation(harness.service, ENV_A, "Short summary");
    await sendRequest(harness.service, receipt.annotationId, "req-1", {
      instruction: SECRET_INSTRUCTION,
    });
    harness.dispatch.observe_("req-1", "awaiting-review");
    await harness.service.reconcileOnce();
    await harness.service.requestResponse(ENV_A, "req-1");
    const draft = await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "SECRET-DRAFT-TEXT",
    });
    const stored = readStoredEnvironment(harness.dir)!;
    expect(stored.meta.state).toMatchObject({ revision: expect.any(Number), source: "new" });
    expect(stored.requests["req-1"].instruction).toBe(SECRET_INSTRUCTION);
    expect(stored.requests["req-1"].response.text).toBe("Done.");
    expect(Object.keys(stored.drafts)).toEqual(["ed-1"]);
    expect(JSON.stringify(stored.drafts)).not.toContain("SECRET-DRAFT-TEXT");
    expect(stored.records[`${draft.id}/1`].value.text).toBe("SECRET-DRAFT-TEXT");
    // Nothing but asset files is written beside the database.
    expect(existsSync(join(environmentDir(harness.dir), "manifest.json"))).toBe(false);
    expect(existsSync(join(environmentDir(harness.dir), "records"))).toBe(false);

    const restarted = await harness.restart();
    const { request } = await restarted.getRequest(ENV_A, "req-1");
    expect(request.instruction).toContain("SECRET-INSTRUCTION");
    expect(request.response?.text).toBe("Done.");
    expect((await restarted.getDraft(ENV_A, "ed-1"))?.text).toBe("SECRET-DRAFT-TEXT");
  });

  test("draft autosave writes only draft rows and never moves the environment revision", async () => {
    const harness = await harnessFor();
    await createAnnotation(harness.service, ENV_A);
    const before = readStoredEnvironment(harness.dir)!;
    let draftRevision = 0;
    for (let index = 0; index < 5; index++) {
      const draft = await harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: draftRevision,
        text: `typing ${index}`,
      });
      draftRevision = draft.revision;
    }
    const after = readStoredEnvironment(harness.dir)!;
    expect((await harness.service.storage.environment(ENV_A)).revision).toBe(1);
    expect(after.meta.state.revision).toBe(1);
    expect(after.annotations).toEqual(before.annotations);
    expect(after.receipts).toEqual(before.receipts);
    // Superseded draft text is removed in the same commit: one revision remains.
    const id = (await harness.service.getDraft(ENV_A, "ed-1"))!.id;
    expect(Object.keys(after.records).filter((key) => key.startsWith(`${id}/`))).toEqual([
      `${id}/5`,
    ]);
    expect(after.meta.state.recordBytes).toBe(
      Object.values(after.records).reduce(
        (sum: number, record) => sum + Buffer.byteLength(JSON.stringify(record)),
        0,
      ),
    );
  });

  test("a store written by a newer row format is refused and never rewritten", async () => {
    const harness = await harnessFor();
    await createAnnotation(harness.service, ENV_A, "One", "op-1");
    await harness.service.close();
    const store = webAnnotationStoreName(ENV_A);
    withDatabase(harness.dir, (database) => {
      const rows = database.rows(store);
      const state = JSON.parse(rows.get("state", "meta")!);
      state.version = 99;
      database.transaction(() => rows.put("state", JSON.stringify(state), { collection: "meta" }));
    });
    const restarted = await harness.restart();
    const capabilities = await restarted.capabilities(ENV_A);
    expect(capabilities.storage).toBe("unavailable");
    const listed = await rejectionDetail(restarted.list({ environmentId: ENV_A }));
    expect(listed.detail).toMatchObject({ code: "unsupported-version" });
    await expect(createAnnotation(restarted, ENV_A, "Two", "op-2")).rejects.toThrow();
    expect(readStoredEnvironment(harness.dir)!.meta.state.version).toBe(99);
  });
});

describe("legacy file import", () => {
  test("imports a version 2 environment once and archives its files", async () => {
    const { source, imported, dir, envDir } = await legacy(async (harness) => {
      const receipt = await createAnnotation(harness.service, ENV_A, "Legacy note", "op-1");
      await sendRequest(harness.service, receipt.annotationId, "req-1", {
        instruction: SECRET_INSTRUCTION,
      });
      await harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 0,
        text: "legacy draft",
      });
      await harness.service.stageAsset({
        environmentId: ENV_A,
        operationId: "op-img",
        mediaType: "image/png",
        data: (await import("./web-annotation-test-support.js")).makePng().toString("base64"),
      });
    });
    const original = await source.service.list({ environmentId: ENV_A });
    const list = await imported.service.list({ environmentId: ENV_A });
    expect(list.items.map((item) => item.id)).toEqual(original.items.map((item) => item.id));
    const got = await imported.service.get(ENV_A, list.items[0]!.id);
    expect(got.entries[0]?.body).toBe("Legacy note");
    expect(got.annotation.unavailable).toBeUndefined();
    expect((await imported.service.getRequest(ENV_A, "req-1")).request.instruction).toBe(
      SECRET_INSTRUCTION,
    );
    expect((await imported.service.getDraft(ENV_A, "ed-1"))?.text).toBe("legacy draft");
    expect((await imported.service.capabilities(ENV_A)).storage).toBe("ready");
    const store = await imported.service.storage.environment(ENV_A);
    const [assetId] = Object.keys(store.manifest.assets);
    expect((await imported.service.getAsset(ENV_A, assetId!)).asset.id).toBe(assetId!);
    // The environment revision continues, so a new commit is the next one.
    const revision = store.revision;
    expect(revision).toBe((await source.service.storage.environment(ENV_A)).revision);
    await createAnnotation(imported.service, ENV_A, "after import", "op-2");
    expect(store.revision).toBe(revision + 1);
    expect(readStoredEnvironment(dir)!.meta.state).toMatchObject({
      source: "legacy-v2",
      importedAt: expect.any(String),
    });
    // Index files and records moved to the archive; assets stayed.
    expect(existsSync(join(envDir, "manifest.json"))).toBe(false);
    expect(existsSync(join(envDir, "records"))).toBe(false);
    expect(existsSync(join(envDir, "assets", `${assetId}.png`))).toBe(true);
    const [archived] = await archivedEnvironments(dir);
    expect((await readdir(archived!)).sort()).toEqual(["drafts.json", "manifest.json", "records"]);
    // A restart reads rows only.
    const again = await imported.restart();
    expect((await again.list({ environmentId: ENV_A })).total).toBe(2);
  });

  test.each([false, true])(
    "legacy import batches survive interruption or concurrent deletion (delete=%s)",
    async (deleting) => {
      const source = await harnessFor();
      const captures: string[] = [];
      for (let index = 0; index < 6; index++) {
        const receipt = await createAnnotation(
          source.service,
          ENV_A,
          `Note ${index}`,
          `op-${index}`,
        );
        captures.push(receipt.captureId!);
      }
      const dir = await mkdtemp(join(tmpdir(), "ork-wa-legacy-batches-"));
      await exportLegacyEnvironment(source.service, dir);
      // Valid legacy records large enough to require more than one import batch.
      for (const id of captures) {
        const file = legacyRecordPath(dir, id);
        const record = JSON.parse(await readFile(file, "utf8"));
        record.value.padding = "x".repeat(900_000);
        await writeFile(file, JSON.stringify(record));
      }
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let batches = 0;
      const importing = harnessFor(dir, {
        faults: async (stage: WebAnnotationFaultStage) => {
          if (stage !== "after-legacy-record-batch" || ++batches !== 1) return;
          entered();
          await gate;
          if (!deleting) throw new Error("interrupted legacy batch");
        },
      });
      await started;
      const peer = new WebAnnotationStorage({ dataDir: dir });
      try {
        if (deleting) await peer.deleteEnvironment(ENV_A);
      } finally {
        release();
        await peer.close();
      }
      const imported = await importing;
      expect(batches).toBe(1);
      if (deleting) {
        expect(readStoredEnvironment(dir)).toBeUndefined();
        expect(existsSync(join(environmentDir(dir), "manifest.json"))).toBe(false);
        await expect(imported.service.storage.environment(ENV_A)).rejects.toThrow("deleted");
      } else {
        expect(readStoredEnvironment(dir)?.meta.state).toBeUndefined();
        expect(existsSync(join(environmentDir(dir), "manifest.json"))).toBe(true);
        const restarted = await imported.restart();
        expect((await restarted.list({ environmentId: ENV_A })).total).toBe(6);
        expect((await restarted.capabilities(ENV_A)).storage).toBe("ready");
        expect(Object.keys(readStoredEnvironment(dir)!.records)).toHaveLength(12);
      }
    },
  );

  test("two backends opening the same legacy environment import it exactly once", async () => {
    const source = await harnessFor();
    for (let index = 0; index < 5; index++) {
      await createAnnotation(source.service, ENV_A, `Note ${index}`, `op-${index}`);
    }
    const dir = await mkdtemp(join(tmpdir(), "ork-wa-legacy-"));
    await exportLegacyEnvironment(source.service, dir);
    const first = await createHarness({}, { dir });
    harnesses.push(first);
    const second = await first.peer();
    const [a, b] = await Promise.all([
      first.service.list({ environmentId: ENV_A }),
      second.list({ environmentId: ENV_A }),
    ]);
    expect(a.total).toBe(5);
    expect(b.total).toBe(5);
    expect(readStoredEnvironment(dir)!.meta.state.revision).toBe(5);
    await createAnnotation(second, ENV_A, "after", "op-after");
    expect((await first.service.list({ environmentId: ENV_A })).total).toBe(6);
    expect(await archivedEnvironments(dir)).toHaveLength(1);
  });

  test("an interrupted import leaves no store and is retried", async () => {
    const source = await harnessFor();
    await createAnnotation(source.service, ENV_A, "Note", "op-1");
    const dir = await mkdtemp(join(tmpdir(), "ork-wa-legacy-"));
    await exportLegacyEnvironment(source.service, dir);
    // The import's final commit fails (a crash at the commit point).
    const rows = StorageDatabase.prototype.rows;
    const spy = spyOn(StorageDatabase.prototype, "rows").mockImplementation(function (
      this: StorageDatabase,
      name: string,
    ) {
      const real = rows.call(this, name);
      return {
        ...real,
        put(key, value, options) {
          if (options?.collection === "meta") throw new Error("injected crash");
          real.put(key, value, options);
        },
      };
    });
    let harness: ServiceHarness;
    try {
      harness = await harnessFor(dir);
      await expect(harness.service.list({ environmentId: ENV_A })).rejects.toThrow(
        "injected crash",
      );
    } finally {
      spy.mockRestore();
    }
    expect(readStoredEnvironment(dir)).toBeUndefined();
    expect(existsSync(join(environmentDir(dir), "manifest.json"))).toBe(true);
    expect((await harness.service.list({ environmentId: ENV_A })).total).toBe(1);
    expect(existsSync(join(environmentDir(dir), "manifest.json"))).toBe(false);
  });

  test("legacy files appearing beside an imported store are archived, not imported", async () => {
    const { imported, dir, envDir } = await legacy(async (harness) => {
      await createAnnotation(harness.service, ENV_A, "Note", "op-1");
    });
    expect((await imported.service.list({ environmentId: ENV_A })).total).toBe(1);
    await imported.service.close();
    // An older backend still running against the directory writes its file.
    await writeFile(join(envDir, "manifest.json"), "{}");
    const restarted = await imported.restart();
    expect((await restarted.list({ environmentId: ENV_A })).total).toBe(1);
    expect(existsSync(join(envDir, "manifest.json"))).toBe(false);
    expect((await archivedEnvironments(dir)).length).toBeGreaterThanOrEqual(1);
  });

  test("a corrupt manifest imports the previous copy read-only and keeps the files", async () => {
    const { imported, envDir } = await legacy(
      async (harness) => {
        await createAnnotation(harness.service, ENV_A, "One", "op-1");
      },
      async (envDir) => {
        await writeFile(join(envDir, "manifest.json"), "{ not json");
      },
      { previous: true },
    );
    const list = await imported.service.list({ environmentId: ENV_A });
    expect(list.items.map((item) => item.title)).toEqual(["One"]);
    expect((await imported.service.capabilities(ENV_A)).storage).toBe("degraded");
    await expect(createAnnotation(imported.service, ENV_A, "Two", "op-2")).rejects.toThrow(
      WEB_ANNOTATION_DEGRADED,
    );
    // Nothing a manual repair could still recover is moved or overwritten.
    expect(await readFile(join(envDir, "manifest.json"), "utf8")).toBe("{ not json");
    expect(existsSync(join(envDir, "manifest.prev.json"))).toBe(true);
    const restarted = await imported.restart();
    expect((await restarted.capabilities(ENV_A)).storage).toBe("degraded");
  });

  test("repairing retained legacy files restores ready and writable status on reopen", async () => {
    const { imported, envDir } = await legacy(
      async (harness) => {
        await createAnnotation(harness.service, ENV_A, "One", "op-1");
        await harness.service.saveDraft({
          environmentId: ENV_A,
          editorId: "ed",
          expectedRevision: 0,
          text: "recovered",
        });
      },
      async (dir) => {
        await writeFile(join(dir, "manifest.json"), "corrupt");
        await writeFile(join(dir, "drafts.json"), "corrupt");
      },
      { previous: true },
    );
    expect((await imported.service.capabilities(ENV_A)).storage).toBe("degraded");
    await writeFile(
      join(envDir, "manifest.json"),
      await readFile(join(envDir, "manifest.prev.json")),
    );
    await writeFile(join(envDir, "drafts.json"), await readFile(join(envDir, "drafts.prev.json")));
    const reopened = await imported.restart();
    expect((await reopened.capabilities(ENV_A)).storage).toBe("ready");
    expect((await reopened.getDraft(ENV_A, "ed"))?.text).toBe("recovered");
    await createAnnotation(reopened, ENV_A, "Two", "op-2");
    await reopened.saveDraft({
      environmentId: ENV_A,
      editorId: "new",
      expectedRevision: 0,
      text: "writable",
    });
    expect(existsSync(join(envDir, "manifest.json"))).toBe(false);
  });

  test("unreadable legacy storage becomes unavailable, never an empty collection", async () => {
    const { imported, dir, envDir } = await legacy(
      async (harness) => {
        await createAnnotation(harness.service, ENV_A, "One", "op-1");
      },
      async (envDir) => {
        await writeFile(join(envDir, "manifest.json"), "{}");
        await writeFile(join(envDir, "manifest.prev.json"), "garbage");
      },
    );
    await expect(imported.service.list({ environmentId: ENV_A })).rejects.toThrow(
      WEB_ANNOTATION_DEGRADED,
    );
    const capabilities = await imported.service.capabilities(ENV_A);
    expect(capabilities.storage).toBe("unavailable");
    expect(capabilities.operations.author).toBe(false);
    await expect(createAnnotation(imported.service, ENV_A, "Two", "op-2")).rejects.toThrow();
    expect(readStoredEnvironment(dir)).toBeUndefined();
    expect(await readFile(join(envDir, "manifest.json"), "utf8")).toBe("{}");
  });

  test("a manifest written by a newer version is refused and never overwritten", async () => {
    let newer = "";
    const { imported, envDir, dir } = await legacy(
      async (harness) => {
        await createAnnotation(harness.service, ENV_A, "One", "op-1");
      },
      async (envDir) => {
        const manifest = await readJsonFile(join(envDir, "manifest.json"));
        manifest.version = WEB_ANNOTATION_MANIFEST_VERSION + 1;
        newer = JSON.stringify(manifest);
        await writeFile(join(envDir, "manifest.json"), newer);
      },
      { previous: true },
    );
    const capabilities = await imported.service.capabilities(ENV_A);
    expect(capabilities.storage).toBe("unavailable");
    expect(capabilities.operations.author).toBe(false);
    // Not served from the older previous copy.
    const listed = await rejectionDetail(imported.service.list({ environmentId: ENV_A }));
    expect(listed.detail).toMatchObject({ code: "unsupported-version", format: "manifest" });
    expect(listed.message).toContain(WEB_ANNOTATION_DEGRADED);
    await expect(createAnnotation(imported.service, ENV_A, "Three", "op-3")).rejects.toThrow();
    expect(await readFile(join(envDir, "manifest.json"), "utf8")).toBe(newer);
    expect(readStoredEnvironment(dir)).toBeUndefined();
  });

  test("an annotation with an unknown schema version is refused, not guessed", async () => {
    const { imported } = await legacy(
      async (harness) => {
        await createAnnotation(harness.service, ENV_A);
      },
      async (envDir) => {
        const manifest = await readJsonFile(join(envDir, "manifest.json"));
        for (const annotation of Object.values(manifest.annotations) as Array<
          Record<string, unknown>
        >) {
          annotation.schemaVersion = 99;
        }
        await writeFile(join(envDir, "manifest.json"), JSON.stringify(manifest));
      },
    );
    expect((await imported.service.capabilities(ENV_A)).storage).toBe("unavailable");
    const listed = await rejectionDetail(imported.service.list({ environmentId: ENV_A }));
    expect(listed.detail).toMatchObject({ code: "unsupported-version", format: "annotation" });
  });

  test("a draft index from a newer version makes drafts unavailable without losing them", async () => {
    let newer = "";
    const { imported, envDir } = await legacy(
      async (harness) => {
        await harness.service.saveDraft({
          environmentId: ENV_A,
          editorId: "ed-1",
          expectedRevision: 0,
          text: "keep me",
        });
        await createAnnotation(harness.service, ENV_A);
      },
      async (envDir) => {
        const drafts = await readJsonFile(join(envDir, "drafts.json"));
        drafts.version = 99;
        newer = JSON.stringify(drafts);
        await writeFile(join(envDir, "drafts.json"), newer);
      },
    );
    await expect(imported.service.getDraft(ENV_A, "ed-1")).rejects.toThrow(WEB_ANNOTATION_DEGRADED);
    await expect(
      imported.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 1,
        text: "overwrite",
      }),
    ).rejects.toThrow(WEB_ANNOTATION_DEGRADED);
    // Threads stay writable; the unreadable draft index is never replaced.
    await createAnnotation(imported.service, ENV_A);
    expect(await readFile(join(envDir, "drafts.json"), "utf8")).toBe(newer);
  });

  test("a version 1 manifest (inline requests and drafts) imports", async () => {
    const { imported } = await legacy(
      async (harness) => {
        const receipt = await createAnnotation(harness.service, ENV_A);
        await sendRequest(harness.service, receipt.annotationId, "req-1", {
          instruction: "legacy instruction",
        });
        await harness.service.saveDraft({
          environmentId: ENV_A,
          editorId: "ed-1",
          expectedRevision: 0,
          text: "legacy draft",
        });
        const store = await harness.service.storage.environment(ENV_A);
        (globalThis as Record<string, unknown>).__v1 = structuredClone(store.manifest);
      },
      async (envDir) => {
        // Reconstruct what a version 1 backend wrote: everything inline.
        const snapshot = (globalThis as Record<string, any>).__v1;
        delete (globalThis as Record<string, unknown>).__v1;
        snapshot.version = 1;
        delete snapshot.consumedDrafts;
        await writeFile(join(envDir, "manifest.json"), JSON.stringify(snapshot));
        await rm(join(envDir, "drafts.json"), { force: true });
        await rm(legacyRecordPath(join(envDir, "..", ".."), requestTextRecordId("req-1")), {
          force: true,
        });
      },
    );
    expect((await imported.service.getRequest(ENV_A, "req-1")).request.instruction).toBe(
      "legacy instruction",
    );
    expect((await imported.service.getDraft(ENV_A, "ed-1"))?.text).toBe("legacy draft");
    await createAnnotation(imported.service, ENV_A);
    const again = await imported.restart();
    expect((await again.getRequest(ENV_A, "req-1")).request.instruction).toBe("legacy instruction");
    expect((await again.getDraft(ENV_A, "ed-1"))?.text).toBe("legacy draft");
    expect(readStoredEnvironment(imported.dir)!.meta.state.source).toBe("legacy-v1");
  });

  test("drafts a manifest commit consumed are not resurrected from drafts.json", async () => {
    let consumedId = "";
    const { imported } = await legacy(
      async (harness) => {
        const draft = await harness.service.saveDraft({
          environmentId: ENV_A,
          editorId: "ed-1",
          expectedRevision: 0,
          text: "Publish me",
        });
        consumedId = draft.id;
        await harness.service.saveDraft({
          environmentId: ENV_A,
          editorId: "ed-2",
          expectedRevision: 0,
          text: "still a draft",
        });
      },
      async (envDir) => {
        // The listing index committed the publish; the drafts.json write was lost.
        const manifest = await readJsonFile(join(envDir, "manifest.json"));
        manifest.consumedDrafts = [consumedId];
        await writeFile(join(envDir, "manifest.json"), JSON.stringify(manifest));
      },
    );
    expect(await imported.service.getDraft(ENV_A, "ed-1")).toBeNull();
    expect((await imported.service.getDraft(ENV_A, "ed-2"))?.text).toBe("still a draft");
  });

  test("a parseable capture record for the wrong annotation is detected", async () => {
    let ids: { first: string; second: string; secondCapture: string } | undefined;
    const { imported } = await legacy(
      async (harness) => {
        const first = await createAnnotation(harness.service, ENV_A, "First", "op-1");
        const second = await createAnnotation(harness.service, ENV_A, "Second", "op-2");
        ids = {
          first: first.annotationId,
          second: second.annotationId,
          secondCapture: second.captureId!,
        };
      },
      async (envDir) => {
        const path = legacyRecordPath(join(envDir, "..", ".."), ids!.secondCapture);
        const record = await readJsonFile(path);
        // A well-formed record that belongs to another annotation.
        record.value.annotationId = ids!.first;
        await writeFile(path, JSON.stringify(record));
      },
    );
    const list = await imported.service.list({ environmentId: ENV_A });
    const byId = new Map(list.items.map((item) => [item.id, item]));
    expect(byId.get(ids!.second)?.unavailable).toBe("capture record unreadable");
    expect(byId.get(ids!.first)?.unavailable).toBeUndefined();
    // An imperfect import keeps the legacy files in place.
    expect(existsSync(join(environmentDir(imported.dir), "manifest.json"))).toBe(true);
  });

  test("a missing capture record is detected and the note is read-only", async () => {
    let receipt: Awaited<ReturnType<typeof createAnnotation>> | undefined;
    const { imported } = await legacy(
      async (harness) => {
        receipt = await createAnnotation(harness.service, ENV_A, "Note", "op-1");
      },
      async (envDir) => {
        await rm(legacyRecordPath(join(envDir, "..", ".."), receipt!.captureId!), { force: true });
      },
    );
    const list = await imported.service.list({ environmentId: ENV_A });
    expect(list.items[0]?.unavailable).toBe("capture record missing");
    expect((await imported.service.get(ENV_A, receipt!.annotationId)).capture).toBeNull();
    await expect(
      imported.service.appendEntryCommand({
        environmentId: ENV_A,
        operationId: "op-more",
        annotationId: receipt!.annotationId,
        expectedContentRevision: receipt!.contentRevision,
        body: "more",
      }),
    ).rejects.toThrow("read-only");
    // The degraded state survives a restart (it is stored as an unreadable row).
    const restarted = await imported.restart();
    expect((await restarted.list({ environmentId: ENV_A })).items[0]?.unavailable).toBe(
      "capture record missing",
    );
  });

  test("a damaged active request keeps its reservation and marks its note read-only", async () => {
    let receipt: Awaited<ReturnType<typeof createAnnotation>> | undefined;
    const { imported } = await legacy(
      async (harness) => {
        receipt = await createAnnotation(harness.service, ENV_A);
        await sendRequest(harness.service, receipt.annotationId, "req-1", { instruction: "go" });
      },
      async (envDir) => {
        const dataDir = join(envDir, "..", "..");
        await writeFile(legacyRecordPath(dataDir, "req-1"), "{ corrupt");
        await writeFile(legacyRecordPath(dataDir, requestTextRecordId("req-1")), "{}");
      },
    );
    const got = await imported.service.get(ENV_A, receipt!.annotationId);
    expect(got.annotation.unavailable).toBe("request record unreadable");
    // Never cleared as if execution had not happened.
    expect(got.annotation.activeRequestId).toBe("req-1");
    expect(got.requests[0]?.reservation).toBe(true);
    expect(got.requests[0]?.state).toBe("queued");
    await expect(
      imported.service.appendEntryCommand({
        environmentId: ENV_A,
        operationId: "op-more",
        annotationId: receipt!.annotationId,
        expectedContentRevision: got.annotation.contentRevision,
        body: "more",
      }),
    ).rejects.toThrow("read-only");
    // A later commit does not touch the damaged legacy files.
    await createAnnotation(imported.service, ENV_A);
    expect(
      await readFile(legacyRecordPath(imported.dir, requestTextRecordId("req-1")), "utf8"),
    ).toBe("{}");
  });
});

describe("draft commit atomicity", () => {
  test("a failure while committing a draft keeps the previous draft", async () => {
    const fault = faultOnce("before-drafts-replace");
    const harness = await harnessFor(undefined, { faults: fault.hook });
    await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "saved",
    });
    fault.state.armed = true;
    await expect(
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 1,
        text: "lost in the crash",
      }),
    ).rejects.toThrow("injected");
    expect((await harness.service.getDraft(ENV_A, "ed-1"))?.text).toBe("saved");
    const restarted = await harness.restart({ faults: fault.hook });
    const draft = await restarted.getDraft(ENV_A, "ed-1");
    expect(draft).toMatchObject({ revision: 1, text: "saved" });
    // No orphaned text record of the failed revision.
    expect(Object.keys(readStoredEnvironment(harness.dir)!.records)).toEqual([`${draft!.id}/1`]);
    await restarted.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 1,
      text: "retried",
    });
    expect((await restarted.getDraft(ENV_A, "ed-1"))?.text).toBe("retried");
  });

  test("publishing a note from its draft commits both or neither", async () => {
    const fault = faultOnce("before-drafts-replace");
    const harness = await harnessFor(undefined, { faults: fault.hook });
    const draft = await harness.service.saveDraft({
      environmentId: ENV_A,
      editorId: "ed-1",
      expectedRevision: 0,
      text: "Publish me",
    });
    const publish = () =>
      harness.service.create({
        environmentId: ENV_A,
        operationId: "op-publish",
        capture: fixtureCaptureInput(),
        body: "Publish me",
        draftId: draft.id,
      });
    fault.state.armed = true;
    await expect(publish()).rejects.toThrow("injected");
    expect(fault.state.fired).toBe(1);
    // Neither the note nor the draft removal committed.
    expect((await harness.service.list({ environmentId: ENV_A })).total).toBe(0);
    expect((await harness.service.getDraft(ENV_A, "ed-1"))?.text).toBe("Publish me");
    const receipt = await publish();
    expect(await harness.service.getDraft(ENV_A, "ed-1")).toBeNull();
    const restarted = await harness.restart({ faults: fault.hook });
    expect(await restarted.getDraft(ENV_A, "ed-1")).toBeNull();
    expect((await restarted.get(ENV_A, receipt.annotationId)).entries[0]?.body).toBe("Publish me");
    expect(readStoredEnvironment(harness.dir)!.drafts).toEqual({});
  });

  test("a crash before draft record write commits nothing", async () => {
    const fault = faultOnce("before-record-write");
    const harness = await harnessFor(undefined, { faults: fault.hook });
    fault.state.armed = true;
    await expect(
      harness.service.saveDraft({
        environmentId: ENV_A,
        editorId: "ed-1",
        expectedRevision: 0,
        text: "never",
      }),
    ).rejects.toThrow("injected");
    const restarted = await harness.restart({ faults: fault.hook });
    expect(await restarted.getDraft(ENV_A, "ed-1")).toBeNull();
  });
});
