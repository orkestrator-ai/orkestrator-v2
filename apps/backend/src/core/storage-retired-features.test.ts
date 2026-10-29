import { afterEach, describe, expect, spyOn, test } from "bun:test";
import syncFs, { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_INTERACTION_JOURNAL_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionResolutionJournal,
} from "@orkestrator/protocol/agent-interactions";
import { StorageService, createEnvironment } from "./storage.js";
import { StorageDatabase, StoreCorruptError } from "./storage-database.js";
import {
  RETIRE_LOOPED_REVIEWS_VERSION,
  LOOPED_REVIEW_CLEANUP_STORE,
  withoutLoopedReviewJournalEntries,
  withoutLoopedReviewSessions,
} from "./storage-retired-features.js";
import {
  LEGACY_JSON_DIRECTORY,
  STORAGE_MIGRATIONS,
  openBackendDatabase,
  storeLayout,
} from "./storage-stores.js";
import { isPersistedNativeAgentSession } from "./storage-shared.js";

const directories: string[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-retired-features-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const timestamp = new Date(0).toISOString();

function nativeSession(key: string, logicalSessionKey: string, origin: string) {
  return {
    version: 1,
    key,
    environmentId: "env-1",
    agent: "codex",
    logicalSessionKey,
    providerSessionId: `provider-${key}`,
    origin,
    interactionPolicy:
      origin === "interactive-native"
        ? INTERACTIVE_AGENT_INTERACTION_POLICY
        : UNATTENDED_AGENT_INTERACTION_POLICY,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function journalEntry(id: string, workflowType: string) {
  return {
    id,
    interactionId: `${id}-question`,
    provider: "codex",
    kind: "question",
    sessionId: `${id}-session`,
    state: "provider-resolved",
    claim: {
      workflowType,
      workflowId: `${id}-workflow`,
      phase: "review",
      fence: "fence-1",
      claimedAt: 1,
    },
    outcome: "auto-declined",
    providerResolvedAt: 2,
  };
}

const SESSIONS = {
  interactive: nativeSession("interactive", "env-env-1:tab-1", "interactive-native"),
  pipeline: nativeSession("pipeline", "build-pipeline:pipeline-1:build", "build-pipeline"),
  looped: nativeSession("looped", "looped-review:workflow-1:discovery:Review", "looped-review"),
  // Multi Review reviewers shared the looped-review origin before it was renamed.
  reviewer: nativeSession("reviewer", "multi-review:workflow-2:reviewer-1", "looped-review"),
  // A pre-policy record the version 3 upgrade turned into an interactive one.
  "legacy-looped": nativeSession(
    "legacy-looped",
    "looped-review:workflow-1:review:round-1",
    "interactive-native",
  ),
};

const JOURNAL = {
  version: AGENT_INTERACTION_JOURNAL_VERSION,
  entries: [journalEntry("pipeline", "build-pipeline"), journalEntry("looped", "looped-review")],
};

describe("retiring Looped Review data", () => {
  test("keeps everything Looped Review did not write", () => {
    expect(withoutLoopedReviewSessions(SESSIONS)).toEqual({
      interactive: SESSIONS.interactive,
      pipeline: SESSIONS.pipeline,
      reviewer: { ...SESSIONS.reviewer, origin: "automated-review" },
    });
    const untouched = { interactive: SESSIONS.interactive };
    expect(withoutLoopedReviewSessions(untouched)).toBe(untouched);
    expect(withoutLoopedReviewSessions("garbage")).toBe("garbage");

    expect(withoutLoopedReviewJournalEntries(JOURNAL)).toEqual({
      ...JOURNAL,
      entries: [JOURNAL.entries[0]],
    });
    const clean = { ...JOURNAL, entries: [JOURNAL.entries[0]] };
    expect(withoutLoopedReviewJournalEntries(clean)).toBe(clean);
    expect(withoutLoopedReviewJournalEntries(null)).toBeNull();
  });

  test("an upgraded database drops the store, its sessions and journal claims, and relabels shared sessions", async () => {
    const directory = await dataDir();
    const before = new StorageDatabase(directory, {
      layoutFor: (store) => (store === "looped-reviews" ? { kind: "record" } : storeLayout(store)),
      migrations: STORAGE_MIGRATIONS.filter(
        (migration) => migration.version < RETIRE_LOOPED_REVIEWS_VERSION,
      ),
    });
    before.writeStore("looped-reviews", {
      "workflow-1": { id: "workflow-1", environmentId: "env-1", snapshot: { phase: "fixing" } },
    });
    before.writeStore("native-agent-sessions", SESSIONS);
    before.writeStore("agent-interaction-resolution-journal", JOURNAL);
    before.close();

    const upgraded = openBackendDatabase(directory);
    try {
      expect(upgraded.schemaVersion()).toBeGreaterThanOrEqual(RETIRE_LOOPED_REVIEWS_VERSION);
      expect(upgraded.hasStore("looped-reviews")).toBe(false);
      expect(upgraded.readStore(LOOPED_REVIEW_CLEANUP_STORE)?.value).toEqual([
        { environmentId: "env-1", agent: "codex", providerSessionId: "provider-looped" },
        { environmentId: "env-1", agent: "codex", providerSessionId: "provider-legacy-looped" },
      ]);
      const sessions = upgraded.readStore("native-agent-sessions")!.value as Record<
        string,
        unknown
      >;
      expect(Object.keys(sessions).sort()).toEqual(["interactive", "pipeline", "reviewer"]);
      expect((sessions.reviewer as { origin: string }).origin).toBe("automated-review");
      for (const [key, session] of Object.entries(sessions)) {
        expect(isPersistedNativeAgentSession(session, key)).toBe(true);
      }
      const journal = upgraded.readStore("agent-interaction-resolution-journal")!.value;
      // The journal fails closed on an unknown workflow type, so the claim must go.
      expect(isAgentInteractionResolutionJournal(JOURNAL)).toBe(false);
      expect(isAgentInteractionResolutionJournal(journal)).toBe(true);
      expect(journal).toEqual({ ...JOURNAL, entries: [JOURNAL.entries[0]] });
    } finally {
      upgraded.close();
    }
  });

  test("purges retired archives and stray backups before an environment can be deleted", async () => {
    const directory = await dataDir();
    const archive = path.join(directory, LEGACY_JSON_DIRECTORY, "old-generation");
    await fs.mkdir(archive, { recursive: true });
    const marker = "private-review-diff-marker";
    const workflow = {
      one: {
        environmentId: "env-1",
        snapshot: {
          agent: "codex",
          sessions: [{ providerSessionId: "archived-turn" }],
          report: marker,
        },
      },
    };
    for (const folder of [directory, archive]) {
      for (const suffix of ["", ".bak.1", ".write.tmp"]) {
        await fs.writeFile(
          path.join(folder, `looped-reviews.json${suffix}`),
          JSON.stringify(workflow),
        );
      }
    }
    await fs.writeFile(path.join(archive, "unrelated.json"), "unrelated-archive-data");
    const storage = new StorageService(directory);
    try {
      await storage.init();
      const environment = { ...createEnvironment("project"), id: "env-1" };
      await storage.addEnvironment(environment);
      await storage.removeEnvironment(environment.id);
    } finally {
      storage.close();
    }
    for (const folder of [directory, archive]) {
      expect((await fs.readdir(folder)).some((file) => file.startsWith("looped-reviews"))).toBe(
        false,
      );
    }
    const generations = await fs.readdir(path.join(directory, LEGACY_JSON_DIRECTORY));
    for (const generation of generations) {
      const folder = path.join(directory, LEGACY_JSON_DIRECTORY, generation);
      for (const file of await fs.readdir(folder)) {
        expect((await fs.readFile(path.join(folder, file), "utf8")).includes(marker)).toBe(false);
      }
    }
    expect(await fs.readFile(path.join(archive, "unrelated.json"), "utf8")).toBe(
      "unrelated-archive-data",
    );
    const reopened = openBackendDatabase(directory);
    try {
      expect(reopened.readStore(LOOPED_REVIEW_CLEANUP_STORE)?.value).toEqual([
        { environmentId: "env-1", agent: "codex", providerSessionId: "archived-turn" },
      ]);
    } finally {
      reopened.close();
    }
  });

  test("archive purge failure retains identities and retries on reopen", async () => {
    const directory = await dataDir();
    const archive = path.join(directory, LEGACY_JSON_DIRECTORY, "old-generation");
    await fs.mkdir(archive, { recursive: true });
    const file = path.join(archive, "looped-reviews.json.bak.1");
    await fs.writeFile(
      file,
      JSON.stringify({
        one: {
          environmentId: "env-1",
          agent: "codex",
          sessions: [{ providerSessionId: "pending-turn" }],
          diff: "sensitive-marker",
        },
      }),
    );
    await fs.writeFile(path.join(archive, "unrelated.json"), "unrelated");
    const remove = syncFs.rmSync;
    const failure = spyOn(syncFs, "rmSync").mockImplementation((target, options) => {
      if (target === file) throw new Error("simulated archive cleanup failure");
      return remove(target, options);
    });
    try {
      expect(() => openBackendDatabase(directory)).toThrow("simulated archive cleanup failure");
      expect((await fs.readFile(file, "utf8")).includes("sensitive-marker")).toBe(true);
    } finally {
      failure.mockRestore();
    }
    const database = openBackendDatabase(directory);
    try {
      expect(database.readStore(LOOPED_REVIEW_CLEANUP_STORE)?.value).toEqual([
        { environmentId: "env-1", agent: "codex", providerSessionId: "pending-turn" },
      ]);
      expect(await fs.readdir(archive)).toEqual(["unrelated.json"]);
    } finally {
      database.close();
    }
  });

  for (const store of ["native-agent-sessions", "agent-interaction-resolution-journal"]) {
    test.each(["unreadable", "corrupt-row"])(`leaves ${store} %s bytes untouched`, async (kind) => {
      const directory = await dataDir();
      const before = new StorageDatabase(directory, {
        layoutFor: storeLayout,
        migrations: STORAGE_MIGRATIONS.filter(
          (migration) => migration.version < RETIRE_LOOPED_REVIEWS_VERSION,
        ),
      });
      if (kind === "unreadable")
        before.transaction(() => before.writeRawDocumentInTransaction(store, "{ unreadable"));
      else {
        before.writeStore(store, store === "native-agent-sessions" ? SESSIONS : JOURNAL);
        if (store === "native-agent-sessions") {
          before.db.query("UPDATE store_rows SET value = '{ torn' WHERE store = ?").run(store);
        } else {
          before.db.query("UPDATE stores SET document = '{ torn' WHERE name = ?").run(store);
        }
      }
      const rows = before.db.query("SELECT * FROM store_rows WHERE store = ?").all(store);
      const header = before.db.query("SELECT * FROM stores WHERE name = ?").get(store);
      before.close();
      const upgraded = openBackendDatabase(directory);
      try {
        expect(upgraded.db.query("SELECT * FROM store_rows WHERE store = ?").all(store)).toEqual(
          rows,
        );
        expect(upgraded.db.query("SELECT * FROM stores WHERE name = ?").get(store)).toEqual(header);
        expect(() => upgraded.readStore(store)).toThrow(StoreCorruptError);
      } finally {
        upgraded.close();
      }
    });
  }
});
