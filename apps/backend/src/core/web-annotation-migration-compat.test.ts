/**
 * Step 09 migration robustness and client compatibility: bounded pages,
 * per-draft failure isolation, older clients writing during and after
 * migration, dirty in-memory draft reconciliation, interrupted upgrades, and
 * the content-free migration receipt (screenshot references + ownership).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT } from "@orkestrator/protocol/web-annotations";
import {
  WEB_ANNOTATION_MIGRATION_PAGE,
  extractLegacyBrowserAnnotations,
} from "./web-annotation-migration.js";
import type { WebAnnotationFaultStage } from "./web-annotation-storage.js";
import {
  ENV_A,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";
import { environmentDir, readJsonFile } from "./web-annotation-test-helpers.js";

let harness: ServiceHarness | undefined;
let worktree: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "ork-wa-compat-"));
  await mkdir(join(worktree, ".orkestrator", "annotations"), { recursive: true });
});
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  await rm(worktree, { recursive: true, force: true });
});

const draftKey = (tab: string) => `claude:${ENV_A}:${encodeURIComponent(`env-${ENV_A}:${tab}`)}`;

function note(id: string, comment = "make it bigger", screenshot: string | null = null) {
  return {
    id,
    source: "browser",
    text: `Browser element annotation ${id}\n\nCSS path: form > button`,
    comment,
    ...(screenshot ? { screenshotPath: screenshot } : {}),
  };
}

function draft(notes: ReturnType<typeof note>[], text = "unrelated") {
  return {
    text,
    annotations: notes,
    attachments: notes
      .filter((item) => item.screenshotPath)
      .map((item) => ({
        id: `att-${item.id}`,
        type: "image",
        path: item.screenshotPath,
        name: `${item.id}.png`,
        annotationId: item.id,
      })),
  };
}

async function setup(faults?: (stage: WebAnnotationFaultStage) => void) {
  harness = await createHarness(faults ? { faults } : {});
  harness.host.environments.set(ENV_A, {
    id: ENV_A,
    environmentType: "local",
    worktreePath: worktree,
    containerId: null,
  });
}

async function importedCount() {
  const list = await harness!.service.list({
    environmentId: ENV_A,
    filter: { importedOnly: true, state: "all" },
  });
  return list.total;
}

describe("bounded, isolated migration passes", () => {
  test("runs longer than one 25-draft page and resumes until complete", async () => {
    await setup();
    const total = WEB_ANNOTATION_MIGRATION_PAGE + 6;
    for (let index = 0; index < total; index++) {
      harness!.host.putDraft(draftKey(`tab-${index}`), ENV_A, draft([note(`legacy-${index}`)]));
    }
    const first = await harness!.service.migrate(ENV_A);
    expect(first.pendingDrafts).toBe(6);
    expect(first.completedAt).toBeNull();
    expect(await importedCount()).toBe(WEB_ANNOTATION_MIGRATION_PAGE);
    const second = await harness!.service.migrate(ENV_A);
    expect(second).toMatchObject({ pendingDrafts: 0, failedDrafts: 0 });
    expect(second.completedAt).not.toBeNull();
    expect(await importedCount()).toBe(total);
  });

  test("a corrupt draft fails only that item; malformed values are skipped", async () => {
    await setup();
    const broken = draftKey("broken");
    harness!.host.putDraft(draftKey("a"), ENV_A, draft([note("legacy-a")]));
    harness!.host.putDraft(broken, ENV_A, draft([note("legacy-broken")]));
    harness!.host.putDraft(draftKey("c"), ENV_A, draft([note("legacy-c")]));
    // Unparseable shapes are not legacy notes and never abort the pass.
    harness!.host.putDraft(draftKey("junk"), ENV_A, { annotations: "not an array" });
    harness!.host.putDraft(draftKey("junk-2"), ENV_A, {
      annotations: [{ source: "browser", id: 42 }, null],
    });
    harness!.host.onGetDraft = (key) => {
      if (key === broken) throw new Error("draft store read failed");
    };
    const status = await harness!.service.migrate(ENV_A);
    expect(status).toMatchObject({ failedDrafts: 1, pendingDrafts: 0 });
    for (const key of [draftKey("a"), draftKey("c")]) {
      expect(extractLegacyBrowserAnnotations(harness!.host.drafts.get(key)!.value)).toEqual([]);
    }
    // The failing draft is untouched and its note is still imported read-only.
    expect(extractLegacyBrowserAnnotations(harness!.host.drafts.get(broken)!.value)).toHaveLength(
      1,
    );
    const manifest = await readJsonFile(join(environmentDir(harness!.dir), "manifest.json"));
    expect(manifest.migration.drafts[broken]).toMatchObject({ state: "failed", reason: "other" });
    // Retried once the draft changes revision (the item's own failure only).
    harness!.host.onGetDraft = null;
    const current = harness!.host.drafts.get(broken)!;
    harness!.host.putDraft(broken, ENV_A, current.value, current.revision + 1);
    expect((await harness!.service.migrate(ENV_A)).failedDrafts).toBe(0);
    expect(await importedCount()).toBe(3);
  });
});

describe("older clients and dirty drafts", () => {
  test("an older client re-persisting an imported note is mapped to its thread", async () => {
    await setup();
    const key = draftKey("tab-1");
    harness!.host.putDraft(key, ENV_A, draft([note("legacy-1")]));
    await harness!.service.migrate(ENV_A);
    const [thread] = (
      await harness!.service.list({ environmentId: ENV_A, filter: { importedOnly: true } })
    ).items;
    // An old UI still holds the original note in memory and saves it again.
    const stale = draft([note("legacy-1")], "user text from the old client");
    const mapped = await harness!.service.mapMigratedComposeDraft("environment", ENV_A, stale);
    expect(mapped.references).toEqual([{ legacyId: "legacy-1", annotationId: thread!.id }]);
    const value = mapped.value as ReturnType<typeof draft>;
    expect(value.text).toBe("user text from the old client");
    expect(value.annotations[0]).toEqual({
      id: "legacy-1",
      source: "browser",
      text: WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT,
      comment: "",
      migratedTo: thread!.id,
    } as never);
    // Unknown notes, project drafts, and unmigrated environments pass through.
    const fresh = draft([note("legacy-new")]);
    expect(
      (await harness!.service.mapMigratedComposeDraft("environment", ENV_A, fresh)).value,
    ).toBe(fresh);
    expect((await harness!.service.mapMigratedComposeDraft("project", ENV_A, stale)).value).toBe(
      stale,
    );
    // Persisted through the mapping, another pass creates no new thread.
    harness!.host.putDraft(key, ENV_A, mapped.value, 9);
    await harness!.service.migrate(ENV_A);
    expect(await importedCount()).toBe(1);
    expect(harness!.host.drafts.get(key)!.revision).toBe(9);
  });

  test("an older client editing a migrated note during migration adds a variant, not a thread", async () => {
    await setup();
    const key = draftKey("tab-1");
    harness!.host.putDraft(key, ENV_A, draft([note("legacy-1", "first")]));
    harness!.host.onGetDraft = (read) => {
      if (read !== key) return;
      harness!.host.onGetDraft = null;
      // The old client saves an edited comment between import and cleanup.
      const current = harness!.host.drafts.get(key)!;
      harness!.host.putDraft(key, ENV_A, draft([note("legacy-1", "edited")]), current.revision + 1);
    };
    await harness!.service.migrate(ENV_A);
    await harness!.service.migrate(ENV_A);
    expect(await importedCount()).toBe(1);
    const [thread] = (
      await harness!.service.list({ environmentId: ENV_A, filter: { importedOnly: true } })
    ).items;
    const got = await harness!.service.get(ENV_A, thread!.id);
    expect(
      got.entries.filter((entry) => entry.kind === "legacy-comment").map((entry) => entry.body),
    ).toEqual(["first", "edited"]);
    expect(extractLegacyBrowserAnnotations(harness!.host.drafts.get(key)!.value)).toEqual([]);
  });

  test("a dirty in-memory draft reconciles through the same import without touching drafts", async () => {
    await setup();
    await writeFile(join(worktree, ".orkestrator", "annotations", "dirty.png"), makePng());
    harness!.host.putDraft(draftKey("tab-1"), ENV_A, draft([note("legacy-1")]));
    await harness!.service.migrate(ENV_A);
    const dirty = draft(
      [
        note("legacy-1"),
        note(
          "legacy-dirty",
          "only in memory",
          join(worktree, ".orkestrator/annotations/dirty.png"),
        ),
      ],
      "unsaved typing",
    );
    const before = new Map(harness!.host.drafts);
    const result = await harness!.service.reconcileDraft(ENV_A, dirty);
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.references.map((reference) => reference.legacyId).sort()).toEqual([
      "legacy-1",
      "legacy-dirty",
    ]);
    const value = result.value as ReturnType<typeof draft>;
    expect(value.text).toBe("unsaved typing");
    expect(value.attachments).toEqual([]);
    expect(extractLegacyBrowserAnnotations(value)).toEqual([]);
    expect(harness!.host.drafts).toEqual(before);
    const thread = await harness!.service.get(
      ENV_A,
      result.references.find((reference) => reference.legacyId === "legacy-dirty")!.annotationId,
    );
    expect(thread.capture).toMatchObject({ state: "stale", assetIds: [expect.any(String)] });
    // Idempotent.
    const again = await harness!.service.reconcileDraft(ENV_A, dirty);
    expect(again.imported).toBe(0);
    expect(await importedCount()).toBe(2);
  });
});

describe("archived imports", () => {
  test("a later divergent variant of an archived imported note joins its continuation", async () => {
    await setup();
    harness!.host.putDraft(draftKey("tab-1"), ENV_A, draft([note("legacy-1", "first")]));
    await harness!.service.migrate(ENV_A);
    const [thread] = (
      await harness!.service.list({ environmentId: ENV_A, filter: { importedOnly: true } })
    ).items;
    const archived = await harness!.service.archive({
      environmentId: ENV_A,
      operationId: "op-archive",
      annotationId: thread!.id,
      expectedMetadataRevision: thread!.metadataRevision,
    });
    harness!.host.putDraft(draftKey("tab-2"), ENV_A, draft([note("legacy-1", "a stale copy")]));
    await harness!.service.migrate(ENV_A);
    const continuation = await harness!.service.get(ENV_A, archived.continuation.annotationId);
    expect(
      continuation.entries
        .filter((entry) => entry.kind === "legacy-comment")
        .map((entry) => [entry.provenance, entry.body]),
    ).toEqual([["legacy-page-comment", "a stale copy"]]);
    // No new thread: the default list shows only the (imported) continuation.
    expect(await importedCount()).toBe(1);
  });
});

describe("upgrade compatibility", () => {
  test("an old frontend writing new legacy notes after completion is migrated again", async () => {
    await setup();
    harness!.host.putDraft(draftKey("tab-1"), ENV_A, draft([note("legacy-1")]));
    const done = await harness!.service.migrate(ENV_A);
    expect(done.completedAt).not.toBeNull();
    // An old desktop build (no annotation service) still fans notes out.
    harness!.host.putDraft(draftKey("tab-2"), ENV_A, draft([note("legacy-2")]));
    expect((await harness!.service.migrationStatus(ENV_A)).pendingDrafts).toBe(1);
    const again = await harness!.service.migrate(ENV_A);
    expect(again).toMatchObject({ pendingDrafts: 0, importedAnnotations: 2 });
    expect(again.completedAt).not.toBeNull();
  });

  test("an upgrade interrupted after draft cleanup completes without duplicating or re-transforming", async () => {
    const state = { armed: false };
    let commits = 0;
    await setup((stage) => {
      if (stage !== "after-commit" || !state.armed) return;
      // Second commit of the draft: the `cleaned` receipt after the CAS.
      if (++commits === 2) {
        state.armed = false;
        throw new Error("injected crash");
      }
    });
    const key = draftKey("tab-1");
    harness!.host.putDraft(key, ENV_A, draft([note("legacy-1")]));
    state.armed = true;
    await harness!.service.migrate(ENV_A);
    const cleaned = harness!.host.drafts.get(key)!;
    const restarted = await harness!.restart();
    const status = await restarted.migrate(ENV_A);
    expect(status).toMatchObject({ pendingDrafts: 0, importedAnnotations: 1 });
    expect(harness!.host.drafts.get(key)).toEqual(cleaned);
    expect(
      (await restarted.list({ environmentId: ENV_A, filter: { importedOnly: true } })).total,
    ).toBe(1);
  });
});

describe("migration receipts", () => {
  test("record screenshot references and native ownership without paths or text", async () => {
    await setup();
    const shot = join(worktree, ".orkestrator", "annotations", "with-shot.png");
    await writeFile(shot, makePng());
    const owned = draftKey("owned");
    harness!.host.putDraft(
      draftKey("tab-1"),
      ENV_A,
      draft([note("with-shot", "a", shot), note("no-shot")]),
    );
    harness!.host.putDraft(owned, ENV_A, draft([note("owned-note")]));
    harness!.host.sessions = [
      {
        environmentId: ENV_A,
        logicalSessionKey: `env-${ENV_A}:owned`,
        pendingDispatch: { requestId: "native-req-1" },
      },
    ];
    await harness!.service.migrate(ENV_A);
    const manifestText = JSON.stringify(
      await readJsonFile(join(environmentDir(harness!.dir), "manifest.json")),
    );
    const manifest = JSON.parse(manifestText);
    const record = manifest.migration.drafts[draftKey("tab-1")];
    expect(record).toMatchObject({
      state: "cleaned",
      legacyIds: ["with-shot", "no-shot"],
      ownership: { logicalSessionKey: `env-${ENV_A}:tab-1`, pendingDispatch: false },
      screenshots: [
        {
          legacyId: "with-shot",
          referenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          assetId: expect.any(String),
          outcome: "imported",
        },
      ],
    });
    expect(manifest.migration.drafts[owned]).toMatchObject({
      state: "deferred",
      ownership: {
        logicalSessionKey: `env-${ENV_A}:owned`,
        pendingDispatch: true,
        pendingRequestId: "native-req-1",
      },
    });
    expect(manifestText).not.toContain(worktree);
    expect(manifestText).not.toContain("with-shot.png");
    // A note that never had a screenshot is not reported as a failed import.
    const threads = await harness!.service.list({
      environmentId: ENV_A,
      filter: { importedOnly: true },
    });
    for (const item of threads.items) {
      const got = await harness!.service.get(ENV_A, item.id);
      const legacyComment = got.entries.find((entry) => entry.kind === "legacy-comment");
      expect(got.annotation.title).toMatch(/^Imported browser note [0-9a-f]{6}$/);
      expect(got.annotation.title).not.toContain(legacyComment?.body ?? "\u0000");
      if (got.capture?.target.kind !== "legacy-unresolved") continue;
      if (got.capture.target.referenceText.includes("no-shot")) {
        expect(got.capture).toMatchObject({
          state: "stale",
          stateReason: expect.stringContaining("without a screenshot"),
        });
      }
    }
    harness!.host.failSessions = true;
    harness!.host.sessions = [];
    harness!.host.putDraft(draftKey("unknown"), ENV_A, draft([note("unknown-note")]));
    await harness!.service.migrate(ENV_A);
    const later = await readJsonFile(join(environmentDir(harness!.dir), "manifest.json"));
    expect(later.migration.drafts[draftKey("unknown")].ownership).toEqual({
      logicalSessionKey: `env-${ENV_A}:unknown`,
      pendingDispatch: "unknown",
    });
  });
});
