import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT } from "@orkestrator/protocol/web-annotations";
import {
  composeDraftSessionKey,
  extractLegacyBrowserAnnotations,
  removeLegacyBrowserAnnotations,
} from "./web-annotation-migration.js";
import {
  ENV_A,
  ENV_B,
  createHarness,
  makePng,
  type ServiceHarness,
} from "./web-annotation-test-support.js";

let harness: ServiceHarness;
let worktree: string;
let outside: string;

beforeEach(async () => {
  worktree = await mkdtemp(join(tmpdir(), "ork-wa-worktree-"));
  outside = await mkdtemp(join(tmpdir(), "ork-wa-outside-"));
  await mkdir(join(worktree, ".orkestrator", "annotations"), { recursive: true });
});
afterEach(async () => {
  await harness?.cleanup();
  await rm(worktree, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const draftKey = (tabId: string, environmentId = ENV_A, namespace = "claude") =>
  `${namespace}:${environmentId}:${encodeURIComponent(`env-${environmentId}:${tabId}`)}`;

function legacyDraft(
  items: Array<{ id: string; comment: string; text?: string; screenshot?: string | null }>,
  extra: Record<string, unknown> = {},
) {
  return {
    text: "unrelated prompt text",
    mentions: [{ id: "m1", filename: "a.ts", relativePath: "src/a.ts" }],
    attachments: [
      ...items.map((item) => ({
        id: `att-${item.id}`,
        type: "image",
        path: item.screenshot ?? `${worktree}/.orkestrator/annotations/${item.id}.png`,
        name: `${item.id}.png`,
        annotationId: item.id,
      })),
      { id: "att-file", type: "file", path: `${worktree}/README.md`, name: "README.md" },
    ],
    annotations: [
      ...items.map((item) => ({
        id: item.id,
        source: "browser",
        text: item.text ?? "Browser element annotation\n\nCSS path: form > button",
        comment: item.comment,
        ...(item.screenshot === null
          ? {}
          : {
              screenshotPath:
                item.screenshot ?? `${worktree}/.orkestrator/annotations/${item.id}.png`,
            }),
      })),
      { id: "transcript-1", text: "assistant said something", comment: "keep me" },
    ],
    metadata: { platform: "claude" },
    ...extra,
  };
}

async function setup() {
  harness = await createHarness();
  harness.host.environments.set(ENV_A, {
    id: ENV_A,
    environmentType: "local",
    worktreePath: worktree,
    containerId: null,
  });
  harness.host.environments.set(ENV_B, {
    id: ENV_B,
    environmentType: "local",
    worktreePath: worktree,
    containerId: null,
  });
}

async function importedThreads(environmentId = ENV_A) {
  const list = await harness.service.list({
    environmentId,
    filter: { importedOnly: true, state: "all" },
  });
  return Promise.all(list.items.map((item) => harness.service.get(environmentId, item.id)));
}

describe("legacy draft helpers", () => {
  test("extracts only valid browser annotations and removes only their attachments", () => {
    const value = legacyDraft([{ id: "l1", comment: "c" }]);
    const found = extractLegacyBrowserAnnotations(value);
    expect(found.map((item) => item.id)).toEqual(["l1"]);
    const cleaned = removeLegacyBrowserAnnotations(value, new Set(["l1"])) as ReturnType<
      typeof legacyDraft
    >;
    expect(cleaned.annotations.map((item) => item.id)).toEqual(["transcript-1"]);
    expect(cleaned.attachments.map((item) => item.id)).toEqual(["att-file"]);
    expect(cleaned.text).toBe(value.text);
    expect(cleaned.mentions).toEqual(value.mentions);
    expect(cleaned.metadata).toEqual(value.metadata);
    expect(Object.keys(cleaned)).toEqual(Object.keys(value));
    expect(composeDraftSessionKey(draftKey("tab-1"), ENV_A)).toBe(`env-${ENV_A}:tab-1`);
  });
});

describe("web annotation legacy migration", () => {
  test("imports identical copies once, preserves unrelated draft content, and completes", async () => {
    await setup();
    await writeFile(join(worktree, ".orkestrator", "annotations", "l1.png"), makePng());
    harness.host.putDraft(
      draftKey("tab-1"),
      ENV_A,
      legacyDraft([{ id: "l1", comment: "Make it bigger" }]),
      3,
    );
    harness.host.putDraft(
      draftKey("tab-2"),
      ENV_A,
      legacyDraft([{ id: "l1", comment: "Make it bigger" }]),
      5,
    );
    const status = await harness.service.migrate(ENV_A);
    expect(status).toMatchObject({
      importedAnnotations: 1,
      pendingDrafts: 0,
      deferredDrafts: 0,
      failedDrafts: 0,
    });
    expect(status.completedAt).not.toBeNull();
    const threads = await importedThreads();
    expect(threads).toHaveLength(1);
    const thread = threads[0]!;
    expect(thread.annotation).toMatchObject({
      imported: true,
      state: "open",
      latestIntent: null,
      resolution: null,
      targetKind: "legacy-unresolved",
    });
    expect(thread.capture).toMatchObject({ producer: "legacy-import", state: "stale" });
    expect(thread.capture?.assetIds).toHaveLength(1);
    expect(thread.capture?.target).toMatchObject({
      kind: "legacy-unresolved",
      referenceText: expect.stringContaining("CSS path"),
    });
    expect(thread.entries.map((entry) => [entry.provenance, entry.kind])).toEqual([
      ["system", "lifecycle"],
      ["legacy-page-comment", "legacy-comment"],
    ]);
    // A neutral, trusted title: page-origin comment text never becomes chrome.
    expect(thread.annotation.title).toMatch(/^Imported browser note [0-9a-f]{6}$/);
    for (const key of [draftKey("tab-1"), draftKey("tab-2")]) {
      const draft = harness.host.drafts.get(key)!;
      const value = draft.value as ReturnType<typeof legacyDraft>;
      // The browser note is replaced by a lightweight migrated reference.
      expect(value.annotations).toEqual([
        {
          id: "l1",
          source: "browser",
          text: WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT,
          comment: "",
          migratedTo: thread.annotation.id,
        },
        { id: "transcript-1", text: "assistant said something", comment: "keep me" },
      ] as never);
      expect(value.attachments.map((item) => item.id)).toEqual(["att-file"]);
      expect(value.text).toBe("unrelated prompt text");
    }
    // Validation succeeded: private backups are removed.
    expect(existsSync(join(harness.dir, "web-annotations", ENV_A, "migration-backups"))).toBe(
      false,
    );
    // Idempotent.
    expect((await harness.service.migrate(ENV_A)).importedAnnotations).toBe(1);
    expect(await importedThreads()).toHaveLength(1);
  });

  test("divergent comment variants are preserved as distinct entries in one thread", async () => {
    await setup();
    harness.host.putDraft(
      draftKey("tab-1"),
      ENV_A,
      legacyDraft([{ id: "l1", comment: "Make it bigger" }]),
    );
    harness.host.putDraft(
      draftKey("tab-2"),
      ENV_A,
      legacyDraft([{ id: "l1", comment: "Make it bigger and red" }]),
    );
    await harness.service.migrate(ENV_A);
    const threads = await importedThreads();
    expect(threads).toHaveLength(1);
    const comments = threads[0]!.entries
      .filter((entry) => entry.kind === "legacy-comment")
      .map((entry) => entry.body);
    expect(comments).toEqual(["Make it bigger", "Make it bigger and red"]);
  });

  test("a crash between import commit and draft cleanup is retried without duplicates", async () => {
    await setup();
    harness.host.putDraft(draftKey("tab-1"), ENV_A, legacyDraft([{ id: "l1", comment: "note" }]));
    const save = harness.host.saveComposeDraft.bind(harness.host);
    let failures = 1;
    harness.host.saveComposeDraft = async (...args) => {
      if (failures-- > 0) throw new Error("disk full");
      return save(...args);
    };
    const first = await harness.service.migrate(ENV_A);
    expect(first).toMatchObject({ importedAnnotations: 1, pendingDrafts: 1, completedAt: null });
    expect(
      extractLegacyBrowserAnnotations(harness.host.drafts.get(draftKey("tab-1"))!.value),
    ).toHaveLength(1);
    expect(
      await readdir(join(harness.dir, "web-annotations", ENV_A, "migration-backups")),
    ).toHaveLength(1);
    const restarted = await harness.restart();
    const second = await restarted.migrate(ENV_A);
    expect(second).toMatchObject({ importedAnnotations: 1, pendingDrafts: 0 });
    expect(await importedThreads()).toHaveLength(1);
    expect(
      extractLegacyBrowserAnnotations(harness.host.drafts.get(draftKey("tab-1"))!.value),
    ).toHaveLength(0);
  });

  test("a draft changed concurrently is left intact and retried from its new revision", async () => {
    await setup();
    const key = draftKey("tab-1");
    harness.host.putDraft(key, ENV_A, legacyDraft([{ id: "l1", comment: "note" }]));
    harness.host.onGetDraft = (read) => {
      if (read !== key) return;
      harness.host.onGetDraft = null;
      const current = harness.host.drafts.get(key)!;
      harness.host.putDraft(
        key,
        ENV_A,
        { ...(current.value as object), text: "user kept typing" },
        current.revision + 1,
      );
    };
    const first = await harness.service.migrate(ENV_A);
    expect(first.pendingDrafts).toBe(1);
    // The CAS read saw the old revision snapshot; the user's newer text wins.
    expect((harness.host.drafts.get(key)!.value as { text: string }).text).toBe("user kept typing");
    expect(extractLegacyBrowserAnnotations(harness.host.drafts.get(key)!.value)).toHaveLength(1);
    const second = await harness.service.migrate(ENV_A);
    expect(second.pendingDrafts).toBe(0);
    const value = harness.host.drafts.get(key)!.value as { text: string };
    expect(value.text).toBe("user kept typing");
    expect(extractLegacyBrowserAnnotations(value)).toHaveLength(0);
    expect(await importedThreads()).toHaveLength(1);
  });

  test("a draft whose session has a pending or unknown native dispatch is never mutated", async () => {
    await setup();
    const key = draftKey("tab-1");
    const original = legacyDraft([{ id: "l1", comment: "note" }]);
    harness.host.putDraft(key, ENV_A, original, 7);
    harness.host.sessions = [
      {
        environmentId: ENV_A,
        logicalSessionKey: `env-${ENV_A}:tab-1`,
        pendingDispatch: { requestId: "x" },
      },
    ];
    const status = await harness.service.migrate(ENV_A);
    expect(status).toMatchObject({ deferredDrafts: 1, pendingDrafts: 0, completedAt: null });
    expect(harness.host.drafts.get(key)).toMatchObject({ revision: 7, value: original });
    expect(await importedThreads()).toHaveLength(1);
    harness.host.sessions = [];
    harness.host.failSessions = true;
    expect((await harness.service.migrate(ENV_A)).deferredDrafts).toBe(1);
    expect(harness.host.drafts.get(key)!.revision).toBe(7);
    harness.host.failSessions = false;
    const settled = await harness.service.migrate(ENV_A);
    expect(settled).toMatchObject({ deferredDrafts: 0, pendingDrafts: 0 });
    expect(await importedThreads()).toHaveLength(1);
  });

  test("missing or escaping screenshots become explicit missing evidence", async () => {
    await setup();
    await writeFile(join(outside, "secret.png"), makePng());
    await symlink(
      join(outside, "secret.png"),
      join(worktree, ".orkestrator", "annotations", "link.png"),
    );
    harness.host.putDraft(
      draftKey("tab-1"),
      ENV_A,
      legacyDraft([
        { id: "missing", comment: "a" },
        {
          id: "escape",
          comment: "b",
          screenshot: join(worktree, ".orkestrator", "annotations", "link.png"),
        },
        { id: "absolute-outside", comment: "c", screenshot: join(outside, "secret.png") },
      ]),
    );
    await harness.service.migrate(ENV_A);
    const threads = await importedThreads();
    expect(threads).toHaveLength(3);
    for (const thread of threads) {
      expect(thread.capture).toMatchObject({ state: "missing", assetIds: [] });
    }
  });

  test("the same legacy id in another environment is separate feedback", async () => {
    await setup();
    harness.host.putDraft(draftKey("tab-1"), ENV_A, legacyDraft([{ id: "l1", comment: "A" }]));
    harness.host.putDraft(
      draftKey("tab-1", ENV_B),
      ENV_B,
      legacyDraft([{ id: "l1", comment: "B" }]),
    );
    await harness.service.migrate(ENV_A);
    await harness.service.migrate(ENV_B);
    const a = await importedThreads(ENV_A);
    const b = await importedThreads(ENV_B);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.annotation.id).not.toBe(b[0]!.annotation.id);
    expect(b[0]!.entries.find((entry) => entry.kind === "legacy-comment")?.body).toBe("B");
  });
});
