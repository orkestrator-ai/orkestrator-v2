import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_INTERACTION_JOURNAL_VERSION,
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  isAgentInteractionResolutionJournal,
} from "@orkestrator/protocol/agent-interactions";
import { StorageDatabase } from "./storage-database.js";
import {
  RETIRE_LOOPED_REVIEWS_VERSION,
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

  test("a stray legacy JSON file is archived rather than left beside the database", async () => {
    const directory = await dataDir();
    await fs.writeFile(path.join(directory, "looped-reviews.json"), "{}\n");
    await fs.writeFile(path.join(directory, "looped-reviews.json.bak.1"), "{}\n");

    const database = openBackendDatabase(directory);
    database.close();

    const entries = await fs.readdir(directory);
    expect(entries.filter((entry) => entry.startsWith("looped-reviews"))).toEqual([]);
    const [stamp] = await fs.readdir(path.join(directory, LEGACY_JSON_DIRECTORY));
    expect((await fs.readdir(path.join(directory, LEGACY_JSON_DIRECTORY, stamp!))).sort()).toEqual([
      "looped-reviews.json",
      "looped-reviews.json.bak.1",
    ]);
  });
});
