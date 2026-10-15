import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COORDINATOR_EXECUTION_POLICY,
  COORDINATOR_WORKSPACE_VERSION,
  coordinatorConversationSessionKey,
  type CoordinatorConversation,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import { createEnvironment, StorageService } from "./storage.js";
import { LEGACY_JSON_DIRECTORY } from "./storage-stores.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const storage of services.splice(0)) await storage.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

/**
 * Opens a data directory upgraded from JSON files, each with one backup as the
 * JSON writer kept them, and returns the archive generation the import made.
 */
async function migrated(files: Record<string, unknown>) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-legacy-archive-"));
  directories.push(dataDir);
  for (const [file, value] of Object.entries(files)) {
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    await fs.writeFile(path.join(dataDir, file), raw);
    await fs.writeFile(path.join(dataDir, `${file}.bak.1`), raw);
  }
  const storage = new StorageService(dataDir);
  services.push(storage);
  await storage.init();
  const [stamp] = await fs.readdir(path.join(dataDir, LEGACY_JSON_DIRECTORY));
  return { storage, archive: path.join(dataDir, LEGACY_JSON_DIRECTORY, stamp!) };
}

async function archiveFiles(archive: string): Promise<Record<string, string>> {
  const names = (await fs.readdir(archive)).sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await fs.readFile(path.join(archive, name), "utf8")]),
    ),
  );
}

function composeDraft(draftKey: string, ownerId: string, text: string) {
  return {
    draftKey,
    ownerType: "environment",
    ownerId,
    value: { text },
    revision: 1,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function conversation(
  coordinatorId: string,
  id: string,
  title: string,
  role: "main" | "side",
): CoordinatorConversation {
  const tabId = `tab-${id}`;
  return {
    id,
    tabId,
    logicalSessionKey: coordinatorConversationSessionKey(coordinatorId, { id, tabId }),
    title,
    createdAt: "2026-10-01T00:00:00.000Z",
    mailboxIncarnationId: `mailbox-${id}`,
    role,
    ...(role === "side" ? { sideOrdinal: 1 } : {}),
  } as CoordinatorConversation;
}

function workspace(
  projectId: string,
  conversations: (coordinatorId: string) => CoordinatorConversation[] = () => [],
): CoordinatorWorkspace {
  const id = `coordinator-${projectId}`;
  return {
    version: COORDINATOR_WORKSPACE_VERSION,
    id,
    projectId,
    executionPolicy: COORDINATOR_EXECUTION_POLICY,
    lifecycleState: "ready",
    conversations: conversations(id),
    selectedConversationId: null,
    repositoryContextRevision: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("retired JSON archive", () => {
  test("sensitive saves that remove nothing leave the archive byte-identical", async () => {
    const environment = createEnvironment("project-1");
    const { storage, archive } = await migrated({
      "environments.json": [environment],
      "compose-drafts.json": { draft: composeDraft("draft", environment.id, "archived") },
      "coordinators.json": {
        version: COORDINATOR_WORKSPACE_VERSION,
        revision: 0,
        workspaces: { "project-1": workspace("project-1") },
        workflows: [],
      },
      "linear-auth.json": { apiKey: "lin-archived", connectedAt: "2026-10-01T00:00:00.000Z" },
    });
    const before = await archiveFiles(archive);
    expect(Object.keys(before)).toContain("coordinators.json.bak.1");

    await storage.saveComposeDraft("draft", "environment", environment.id, { text: "edited" });
    await storage.saveComposeDraft("added", "environment", environment.id, { text: "new" });
    await storage.mutateCoordinatorWorkspace("project-1", (current) => ({
      ...current!,
      lifecycleState: "paused",
    }));
    await storage.saveLinearAuth("lin-current");

    expect(await archiveFiles(archive)).toEqual(before);
  });

  test("a delete prunes only the removed content from every archived copy", async () => {
    const environment = createEnvironment("project-1");
    const coordinators = {
      version: COORDINATOR_WORKSPACE_VERSION,
      revision: 0,
      workspaces: {
        "project-1": workspace("project-1", (id) => [
          conversation(id, "removed-main", "ARCHIVED-WORKSPACE-9b2c", "main"),
        ]),
        "project-2": workspace("project-2", (id) => [
          conversation(id, "kept", "Kept conversation", "main"),
          conversation(id, "closed", "ARCHIVED-CONVERSATION-5d1f", "side"),
        ]),
      },
      workflows: [],
    };
    const drafts = {
      draft: composeDraft("draft", environment.id, "ARCHIVED-DRAFT-71c0"),
      other: composeDraft("other", environment.id, "archived"),
    };
    const { storage, archive } = await migrated({
      "environments.json": [environment],
      "compose-drafts.json": drafts,
      "coordinators.json": coordinators,
    });

    // Edits that remove nothing first: the deletes below must not write them.
    await storage.mutateCoordinatorWorkspace("project-2", (current) => ({
      ...current!,
      lifecycleState: "paused",
    }));
    await storage.saveComposeDraft("other", "environment", environment.id, { text: "edited" });

    await storage.mutateCoordinatorWorkspace("project-1", () => null);
    await storage.mutateCoordinatorWorkspace("project-2", (current) => ({
      ...current!,
      conversations: current!.conversations.filter((item) => item.id !== "closed"),
    }));
    await storage.deleteComposeDraft("draft");

    const kept = coordinators.workspaces["project-2"];
    for (const suffix of ["", ".bak.1"]) {
      const coordinatorCopy = await fs.readFile(
        path.join(archive, `coordinators.json${suffix}`),
        "utf8",
      );
      expect(coordinatorCopy).not.toContain("ARCHIVED-WORKSPACE-9b2c");
      expect(coordinatorCopy).not.toContain("ARCHIVED-CONVERSATION-5d1f");
      expect(JSON.parse(coordinatorCopy)).toEqual({
        ...coordinators,
        workspaces: { "project-2": { ...kept, conversations: [kept.conversations[0]] } },
      });
      const draftCopy = await fs.readFile(
        path.join(archive, `compose-drafts.json${suffix}`),
        "utf8",
      );
      expect(draftCopy).not.toContain("ARCHIVED-DRAFT-71c0");
      expect(JSON.parse(draftCopy)).toEqual({ other: drafts.other });
    }
  });

  test("deleting a store removes its archived copies and leaves other stores", async () => {
    const environment = createEnvironment("project-1");
    const { storage, archive } = await migrated({
      "compose-drafts.json": { draft: composeDraft("draft", environment.id, "archived") },
      "linear-auth.json": {
        apiKey: "ARCHIVED-LINEAR-KEY-7e40",
        connectedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    const draftCopy = await fs.readFile(path.join(archive, "compose-drafts.json"), "utf8");

    await storage.clearLinearAuth();

    expect((await fs.readdir(archive)).filter((name) => name.startsWith("linear-auth"))).toEqual(
      [],
    );
    expect(await fs.readFile(path.join(archive, "compose-drafts.json"), "utf8")).toBe(draftCopy);
  });
});
