import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import { isDesignError } from "./design-errors.js";
import { designExportDigest, planDefaultDesignExportPath } from "./design-export-writer.js";
import {
  exportPreview,
  exportSave,
  openDesignFile,
  reconcileExport,
  type DesignExportContext,
} from "./design-exports.js";
import {
  createDesignHarness,
  deferred,
  trackUnhandledRejections,
  type DesignHarness,
} from "./design-test-support.js";

const frameInput = { name: "Page", x: 0, y: 0, width: 400, height: 300, html: "<h1>Page</h1>" };

describe("design exports to a repository worktree", () => {
  let harness: DesignHarness;
  let worktree: string;
  let context: DesignExportContext;
  const writerFaults: { beforePublish?: () => void | Promise<void> } = {};
  const recordFaults: { beforeRename?: (file: string) => void | Promise<void> } = {};
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;
  const serviceOptions = () => ({
    faults: { beforeRename: (file: string) => recordFaults.beforeRename?.(file) },
  });

  beforeEach(async () => {
    rejections.install();
    delete writerFaults.beforePublish;
    delete recordFaults.beforeRename;
    harness = await createDesignHarness({
      prefix: "ork-design-exports-",
      service: serviceOptions(),
    });
    worktree = await mkdtemp(join(tmpdir(), "ork-design-exports-repo-"));
    context = {
      destination: { kind: "local", worktreePath: worktree },
      writerOptions: { faults: { beforePublish: () => writerFaults.beforePublish?.() } },
    };
  });
  afterEach(async () => {
    delete writerFaults.beforePublish;
    delete recordFaults.beforeRename;
    await harness.close();
    await rm(worktree, { recursive: true, force: true });
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const setup = async (name = "Landing page", environmentId = "env-1") => {
    const canvas = await service().create(environmentId, name, undefined, "user");
    const { frame } = await service().createFrame(canvas.id, environmentId, 1, frameInput, "user");
    return { canvasId: canvas.id, frameId: frame.id };
  };
  const save = (canvasId: string, relativePath: string, revision: number, replace?: string) =>
    exportSave(service(), "env-1", canvasId, context, {
      relativePath,
      revision,
      expected: replace ? { state: "present", digest: replace } : { state: "absent" },
    });
  const readExport = async (relativePath: string) =>
    JSON.parse(await readFile(join(worktree, relativePath), "utf8")) as DesignCanvas;
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  test("preview suggests a sanitized name with an id suffix; default names never collide", async () => {
    const first = await setup("Untitled design");
    const second = await setup("Untitled design");
    const previewA = await exportPreview(service(), "env-1", first.canvasId, context);
    const previewB = await exportPreview(service(), "env-1", second.canvasId, context);
    expect(previewA.suggestedPath).toBe(
      planDefaultDesignExportPath("Untitled design", first.canvasId),
    );
    expect(previewA.suggestedPath).toMatch(/^designs\/Untitled-design-[0-9a-f]{8}\.orkdes$/);
    expect(previewA.suggestedPath).not.toBe(previewB.suggestedPath);
    expect(previewA).toMatchObject({
      revision: 2,
      target: { exists: false, needsReplaceConfirmation: false },
    });
    await save(first.canvasId, previewA.suggestedPath, 2);
    await save(second.canvasId, previewB.suggestedPath, 2);
    expect((await readExport(previewA.suggestedPath)).id).toBe(first.canvasId);
    expect((await readExport(previewB.suggestedPath)).id).toBe(second.canvasId);
    // Names that sanitize identically still get distinct suggestions.
    const punctuated = await setup("Untitled   design!!");
    const previewC = await exportPreview(service(), "env-1", punctuated.canvasId, context);
    expect(previewC.suggestedPath).not.toBe(previewA.suggestedPath);
    // The saved association becomes the next suggestion.
    expect((await exportPreview(service(), "env-1", first.canvasId, context)).suggestedPath).toBe(
      previewA.suggestedPath,
    );
  });

  test("another canvas's file or a non-design file needs explicit replacement", async () => {
    const a = await setup("Alpha");
    const b = await setup("Beta");
    const receipt = await save(a.canvasId, "shared.orkdes", 2);
    expect(receipt).toMatchObject({
      relativePath: "shared.orkdes",
      revision: 2,
      replaced: false,
      currentRevision: 2,
    });
    const preview = await exportPreview(service(), "env-1", b.canvasId, context, "shared.orkdes");
    expect(preview.target).toMatchObject({
      exists: true,
      canvasId: a.canvasId,
      sameCanvas: false,
      needsReplaceConfirmation: true,
      reason: "other-canvas",
      fingerprint: receipt.digest,
    });
    const collision = await failureOf(save(b.canvasId, "shared.orkdes", 2));
    expect(isDesignError(collision, "export-collision")).toBe(true);
    expect((await readExport("shared.orkdes")).id).toBe(a.canvasId);
    // A stale fingerprint is still a collision.
    const stale = await failureOf(
      save(b.canvasId, "shared.orkdes", 2, designExportDigest(Buffer.from("other"))),
    );
    expect(isDesignError(stale, "export-collision")).toBe(true);
    const replaced = await save(b.canvasId, "shared.orkdes", 2, preview.target.fingerprint);
    expect(replaced.replaced).toBe(true);
    expect((await readExport("shared.orkdes")).id).toBe(b.canvasId);
    await writeFile(join(worktree, "notes.orkdes"), "just some notes");
    expect(
      (await exportPreview(service(), "env-1", a.canvasId, context, "notes.orkdes")).target,
    ).toMatchObject({
      exists: true,
      needsReplaceConfirmation: true,
      reason: "not-design",
    });
    // The overwritten file is kept privately so the replacement is recoverable.
    await service().close();
    const backups = await readdir(service().store.exportBackupDir(b.canvasId));
    expect(backups).toHaveLength(1);
  });

  test("repeat saves of the same canvas need the observed fingerprint; external edits are detected", async () => {
    const { canvasId, frameId } = await setup();
    const first = await save(canvasId, "page.orkdes", 2);
    const preview = await exportPreview(service(), "env-1", canvasId, context);
    expect(preview.target).toMatchObject({
      sameCanvas: true,
      needsReplaceConfirmation: false,
      reason: "same-canvas",
    });
    expect(preview.association).toMatchObject({
      relativePath: "page.orkdes",
      lastExportedRevision: 2,
      digest: first.digest,
    });
    await service().mutate(canvasId, "env-1", frameId, 1, { x: 10 }, "user");
    expect(
      isDesignError(await failureOf(save(canvasId, "page.orkdes", 3)), "export-collision"),
    ).toBe(true);
    await save(canvasId, "page.orkdes", 3, preview.target.fingerprint);
    expect((await readExport("page.orkdes")).revision).toBe(3);
    // Someone edits the exported file outside Orkestrator.
    const outside = await readExport("page.orkdes");
    await writeFile(
      join(worktree, "page.orkdes"),
      JSON.stringify({ ...outside, name: "Edited elsewhere" }, null, 2),
    );
    expect((await exportPreview(service(), "env-1", canvasId, context)).target).toMatchObject({
      sameCanvas: true,
      needsReplaceConfirmation: true,
      reason: "changed-since-export",
    });
  });

  test("saving revision N while N+1 commits writes exactly N and reports it outdated", async () => {
    const { canvasId, frameId } = await setup();
    const writing = deferred();
    const release = deferred();
    writerFaults.beforePublish = async () => {
      writing.resolve();
      await release.promise;
    };
    const saving = save(canvasId, "exact.orkdes", 2);
    await writing.promise;
    expect(await service().snapshot("env-1", canvasId)).toMatchObject({
      workspace: { pendingExport: { state: "writing", revision: 2, relativePath: "exact.orkdes" } },
    });
    // Editing continues while the export is in flight.
    await service().mutate(canvasId, "env-1", frameId, 1, { x: 55 }, "user");
    const concurrent = await failureOf(save(canvasId, "other.orkdes", 3));
    expect(isDesignError(concurrent, "capacity")).toBe(true);
    release.resolve();
    const receipt = await saving;
    expect(receipt).toMatchObject({ revision: 2, currentRevision: 3 });
    const file = await readExport("exact.orkdes");
    expect(file.revision).toBe(2);
    expect(file.frames[0]!.x).toBe(0);
    expect(designExportDigest(await readFile(join(worktree, "exact.orkdes")))).toBe(receipt.digest);
    const snapshot = await service().snapshot("env-1", canvasId);
    expect(snapshot).toMatchObject({
      workspace: { export: { lastExportedRevision: 2, relativePath: "exact.orkdes" } },
    });
    expect(snapshot).not.toHaveProperty("workspace.pendingExport");
    expect((await service().libraryPage("env-1", {})).entries[0]).toMatchObject({
      export: { relativePath: "exact.orkdes", revision: 2, outdated: true },
    });
    await save(canvasId, "exact.orkdes", 3, receipt.digest);
    expect((await service().libraryPage("env-1", {})).entries[0]).toMatchObject({
      export: { revision: 3, outdated: false },
    });
    // Saving a revision that is no longer current is refused before writing.
    expect(isDesignError(await failureOf(save(canvasId, "late.orkdes", 2)), "conflict")).toBe(true);
    await expect(readFile(join(worktree, "late.orkdes"))).rejects.toThrow();
  });

  test("a lost settlement is reconciled from the exact destination digest, never by rewriting", async () => {
    const { canvasId } = await setup();
    writerFaults.beforePublish = () => {
      delete writerFaults.beforePublish;
      // The next private record write (the settlement) fails as if the process died.
      recordFaults.beforeRename = (file) => {
        if (!file.endsWith(`${canvasId}.orkrec`)) return;
        delete recordFaults.beforeRename;
        throw new Error("injected crash before settlement");
      };
    };
    await expect(save(canvasId, "lost.orkdes", 2)).rejects.toThrow("injected");
    const restarted = await harness.restart(serviceOptions());
    const pending = await restarted.snapshot("env-1", canvasId);
    // A dead process's "writing" export is surfaced as unknown at startup.
    expect(pending).toMatchObject({
      workspace: { pendingExport: { state: "unknown", relativePath: "lost.orkdes" } },
    });
    const before = await readFile(join(worktree, "lost.orkdes"));
    const reconciled = await reconcileExport(restarted, "env-1", canvasId, context);
    expect(reconciled).toMatchObject({
      state: "exported",
      receipt: { relativePath: "lost.orkdes", revision: 2 },
    });
    expect(await readFile(join(worktree, "lost.orkdes"))).toEqual(before);
    expect(await restarted.snapshot("env-1", canvasId)).toMatchObject({
      workspace: { export: { relativePath: "lost.orkdes", lastExportedRevision: 2 } },
    });
    expect(await reconcileExport(restarted, "env-1", canvasId, context)).toEqual({ state: "none" });
  });

  test("a lost settlement whose destination no longer matches reconciles to not-exported", async () => {
    const { canvasId } = await setup();
    writerFaults.beforePublish = () => {
      delete writerFaults.beforePublish;
      recordFaults.beforeRename = (file) => {
        if (!file.endsWith(`${canvasId}.orkrec`)) return;
        delete recordFaults.beforeRename;
        throw new Error("injected crash before settlement");
      };
    };
    await expect(save(canvasId, "changed.orkdes", 2)).rejects.toThrow("injected");
    await writeFile(join(worktree, "changed.orkdes"), "replaced by someone else");
    expect(await reconcileExport(service(), "env-1", canvasId, context)).toEqual({
      state: "not-exported",
    });
    expect(await readFile(join(worktree, "changed.orkdes"), "utf8")).toBe(
      "replaced by someone else",
    );
    const snapshot = await service().snapshot("env-1", canvasId);
    expect(snapshot).not.toHaveProperty("workspace.pendingExport");
    expect(snapshot).not.toHaveProperty("workspace.export");
  });

  test("an export settling after deletion never restores the canvas", async () => {
    const { canvasId } = await setup();
    const doomed = await setup("Doomed", "env-gone");
    const writing = deferred();
    const release = deferred();
    writerFaults.beforePublish = async () => {
      writing.resolve();
      await release.promise;
    };
    const saving = save(canvasId, "deleted.orkdes", 2);
    await writing.promise;
    await service().delete(canvasId, "env-1", "user");
    release.resolve();
    expect(await saving).toMatchObject({ revision: 2 });
    expect(await service().snapshot("env-1", canvasId)).toMatchObject({ kind: "deleted" });
    expect(await service().list("env-1")).toEqual([]);
    // Environment deletion fences a late settlement entirely.
    const writingGone = deferred();
    const releaseGone = deferred();
    writerFaults.beforePublish = async () => {
      writingGone.resolve();
      await releaseGone.promise;
    };
    const gone = failureOf(
      exportSave(service(), "env-gone", doomed.canvasId, context, {
        relativePath: "gone.orkdes",
        revision: 2,
        expected: { state: "absent" },
      }),
    );
    await writingGone.promise;
    expect(await service().deleteEnvironment("env-gone")).toBe(1);
    releaseGone.resolve();
    expect(isDesignError(await gone, "not-found")).toBe(true);
    expect(await service().snapshot("env-gone", doomed.canvasId)).toMatchObject({
      kind: "missing",
    });
    await service().close();
    const leftovers = (
      await readdir(join(harness.dir, "design-canvases"), { recursive: true })
    ).filter((file) => String(file).includes(doomed.canvasId));
    expect(leftovers).toEqual([]);
  });

  test("saves into the designs folder and nested folders, creating them", async () => {
    const { canvasId } = await setup();
    const preview = await exportPreview(service(), "env-1", canvasId, context);
    expect(preview.suggestedPath.startsWith("designs/")).toBe(true);
    await save(canvasId, preview.suggestedPath, 2);
    expect((await readExport(preview.suggestedPath)).id).toBe(canvasId);
    expect(await readdir(join(worktree, "designs"))).toHaveLength(1);

    const other = await setup("Elsewhere");
    await save(other.canvasId, "mocks/v2/elsewhere.orkdes", 2);
    expect((await readExport("mocks/v2/elsewhere.orkdes")).id).toBe(other.canvasId);
    // The remembered location wins over the default on the next preview.
    const again = await exportPreview(service(), "env-1", other.canvasId, context);
    expect(again.suggestedPath).toBe("mocks/v2/elsewhere.orkdes");
  });

  test("opening a design file reuses its canvas and imports foreign files once", async () => {
    const { canvasId } = await setup("Mine");
    await save(canvasId, "designs/mine.orkdes", 2);
    const reopened = await openDesignFile(service(), "env-1", context, "designs/mine.orkdes");
    expect(reopened).toEqual({ canvasId, imported: false });

    // A file this environment never exported becomes a new canvas bound to that path.
    const foreign = {
      ...(await readExport("designs/mine.orkdes")),
      id: "11111111-1111-4111-8111-111111111111",
      name: "Teammate design",
    };
    await mkdir(join(worktree, "shared"), { recursive: true });
    await writeFile(join(worktree, "shared/theirs.orkdes"), JSON.stringify(foreign));
    const first = await openDesignFile(service(), "env-1", context, "shared/theirs.orkdes");
    expect(first.imported).toBe(true);
    expect(first.canvasId).not.toBe(foreign.id);
    expect((await service().get(first.canvasId, "env-1")).name).toBe("Teammate design");
    const second = await openDesignFile(service(), "env-1", context, "shared/theirs.orkdes");
    expect(second).toEqual({ canvasId: first.canvasId, imported: false });
    // Saving writes back to the file it was opened from.
    const preview = await exportPreview(service(), "env-1", first.canvasId, context);
    expect(preview.suggestedPath).toBe("shared/theirs.orkdes");
    expect(preview.target.needsReplaceConfirmation).toBe(false);

    expect(
      isDesignError(
        await failureOf(openDesignFile(service(), "env-1", context, "designs/missing.orkdes")),
        "not-found",
      ),
    ).toBe(true);
    await writeFile(join(worktree, "bad.orkdes"), "not json");
    expect(
      isDesignError(
        await failureOf(openDesignFile(service(), "env-1", context, "bad.orkdes")),
        "invalid-input",
      ),
    ).toBe(true);
  });

  test("export paths stay confined to the repository root", async () => {
    const { canvasId } = await setup();
    for (const path of [
      "../escape.orkdes",
      "nested/../escape.orkdes",
      "nested/.git/dir.orkdes",
      "/abs.orkdes",
      "no-extension",
    ])
      expect(isDesignError(await failureOf(save(canvasId, path, 2)), "invalid-input")).toBe(true);
    expect(await readdir(worktree)).toEqual([]);
    await expect(exportPreview(service(), "env-2", canvasId, context)).rejects.toThrow("not found");
  });

  test("overlapping opens share one canvas and release the destination after failure", async () => {
    const original = await service().create("env-2", "Shared", undefined, "user");
    await writeFile(join(worktree, "shared.orkdes"), JSON.stringify(original));
    const entered = deferred(),
      release = deferred();
    let inspections = 0;
    const openingContext: DesignExportContext = {
      ...context,
      writerOptions: {
        faults: {
          afterParentsOpened: async () => {
            if (++inspections === 1) {
              entered.resolve();
              await release.promise;
            }
          },
        },
      },
    };
    const first = openDesignFile(service(), "env-1", openingContext, "shared.orkdes");
    await entered.promise;
    const rest = Array.from({ length: 5 }, () =>
      openDesignFile(service(), "env-1", openingContext, "shared.orkdes"),
    );
    expect(inspections).toBe(1);
    release.resolve();
    const results = await Promise.all([first, ...rest]);
    expect(new Set(results.map((result) => result.canvasId)).size).toBe(1);
    expect(results.filter((result) => result.imported)).toHaveLength(1);
    expect(await service().list("env-1")).toHaveLength(1);

    await writeFile(join(worktree, "bad.orkdes"), "not json");
    const failed = await Promise.allSettled(
      Array.from({ length: 2 }, () => openDesignFile(service(), "env-1", context, "bad.orkdes")),
    );
    expect(failed.every((result) => result.status === "rejected")).toBe(true);
    await writeFile(join(worktree, "bad.orkdes"), JSON.stringify(original));
    expect((await openDesignFile(service(), "env-1", context, "bad.orkdes")).imported).toBe(true);
  });

  test("an association failure retires the created canvas before queued opens retry", async () => {
    const original = await service().create("env-2", "Shared", undefined, "user");
    await writeFile(join(worktree, "shared.orkdes"), JSON.stringify(original));
    const store = service().store;
    const write = store.write.bind(store);
    let failedCanvasId: string | undefined;
    const associating = deferred(),
      release = deferred();
    // Arm the filesystem fault for the association record itself. Counting all
    // record writes can consume the fault during canvas creation or recovery.
    const writes = spyOn(store, "write").mockImplementation(async (record) => {
      if (
        record.environmentId === "env-1" &&
        record.export?.relativePath === "shared.orkdes" &&
        !failedCanvasId
      ) {
        failedCanvasId = record.canvasId;
        recordFaults.beforeRename = async (file) => {
          if (file !== store.recordFile(record.canvasId)) return;
          delete recordFaults.beforeRename;
          associating.resolve();
          await release.promise;
          throw new Error("association failed");
        };
      }
      return write(record);
    });
    try {
      const first = openDesignFile(service(), "env-1", context, "shared.orkdes");
      // Destination resolution is asynchronous: invocation order alone does not
      // guarantee lock admission order. Hold the first association before retrying.
      await Promise.race([associating.promise, first]);
      const second = openDesignFile(service(), "env-1", context, "shared.orkdes");
      const outcomes = Promise.allSettled([first, second]);
      release.resolve();
      const results = await outcomes;
      expect(results[0]!.status).toBe("rejected");
      if (results[0]!.status === "rejected")
        expect(results[0]!.reason.message).toBe("association failed");
      expect(results[1]!.status).toBe("fulfilled");
      const live = await service().list("env-1");
      expect(live).toHaveLength(1);
      expect(live[0]!.id).not.toBe(failedCanvasId);
      expect(await store.read(failedCanvasId!)).toEqual({ kind: "missing" });
    } finally {
      release.resolve();
      writes.mockRestore();
      delete recordFaults.beforeRename;
    }
  });

  test("changed file content creates one new canvas while retaining private edits", async () => {
    const { canvasId } = await setup("Original");
    await save(canvasId, "changed.orkdes", 2);
    const document = await readExport("changed.orkdes");
    await service().createFrame(
      canvasId,
      "env-1",
      2,
      { ...frameInput, name: "Private edit" },
      "user",
    );
    await writeFile(
      join(worktree, "changed.orkdes"),
      JSON.stringify({ ...document, name: "External edit" }),
    );
    const [first, second] = await Promise.all(
      Array.from({ length: 2 }, () =>
        openDesignFile(service(), "env-1", context, "changed.orkdes"),
      ),
    );
    expect(first!.canvasId).not.toBe(canvasId);
    expect(second!.canvasId).toBe(first!.canvasId);
    expect((await service().get(canvasId, "env-1")).frames).toHaveLength(2);
    expect((await service().get(first!.canvasId, "env-1")).name).toBe("External edit");
  });

  test("container opens inspect, import and associate through the Docker helper", async () => {
    const original = await service().create("env-2", "Container design", undefined, "user");
    await mkdir(join(worktree, "designs"));
    await writeFile(join(worktree, "designs/shared.orkdes"), JSON.stringify(original));
    const containerContext: DesignExportContext = {
      destination: { kind: "container", containerId: "test-container" },
      writerOptions: {
        spawn: (command, args) => {
          expect(command).toBe("docker");
          expect(args.slice(0, 5)).toEqual(["exec", "-i", "test-container", "node", "-e"]);
          expect(args[7]).toBe("/workspace");
          return spawn(process.execPath, ["-e", args[5]!, "--", worktree, ...args.slice(8)], {
            stdio: "pipe",
          });
        },
      },
    };
    const [first, second] = await Promise.all(
      Array.from({ length: 2 }, () =>
        openDesignFile(service(), "env-1", containerContext, "designs/shared.orkdes"),
      ),
    );
    expect(second!.canvasId).toBe(first!.canvasId);
    expect(await service().list("env-1")).toHaveLength(1);
    const preview = await exportPreview(service(), "env-1", first!.canvasId, containerContext);
    expect(preview.suggestedPath).toBe("designs/shared.orkdes");
    expect(preview.target.needsReplaceConfirmation).toBe(false);
  });
});
