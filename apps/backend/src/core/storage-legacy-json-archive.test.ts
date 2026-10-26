import { afterEach, describe, expect, spyOn, test } from "bun:test";
import syncFs, { promises as fs } from "node:fs";
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
import { seedUnreadableStore, storageDatabase } from "./storage-test-support.js";

class ArchiveProbe extends StorageService {
  committed(store: string): unknown {
    return storageDatabase(this).readStore(store)?.value;
  }
}

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
  const storage = new ArchiveProbe(dataDir);
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
    await storage.coordinators.mutateCoordinatorWorkspace("project-1", (current) => ({
      ...current!,
      lifecycleState: "paused",
    }));
    await storage.kanban.saveLinearAuth("lin-current");

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
    await storage.coordinators.mutateCoordinatorWorkspace("project-2", (current) => ({
      ...current!,
      lifecycleState: "paused",
    }));
    await storage.saveComposeDraft("other", "environment", environment.id, { text: "edited" });

    await storage.coordinators.mutateCoordinatorWorkspace("project-1", () => null);
    await storage.coordinators.mutateCoordinatorWorkspace("project-2", (current) => ({
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

  test.each(["same mutation", "unrelated save", "restart"])(
    "replays a failed coordinator prune on %s",
    async (recovery) => {
      const coordinators = {
        version: COORDINATOR_WORKSPACE_VERSION,
        revision: 0,
        workspaces: {
          "project-1": workspace("project-1", (id) => [
            conversation(id, "main", "RETRY-SECRET", "main"),
          ]),
          "project-2": workspace("project-2"),
        },
        workflows: [],
      };
      const { storage, archive } = await migrated({ "coordinators.json": coordinators });
      const originalRename = syncFs.renameSync;
      let renames = 0;
      const rename = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
        if (++renames === 2) throw new Error("archive rename failed");
        return originalRename(from, to);
      });
      try {
        await expect(
          storage.coordinators.mutateCoordinatorWorkspace("project-1", () => null),
        ).rejects.toThrow("archive rename failed");
        expect(
          (storage.committed("coordinators") as typeof coordinators).workspaces["project-1"],
        ).toBeUndefined();
        // Directory enumeration order is unspecified: either copy may be first.
        const copies = Object.values(await archiveFiles(archive));
        expect(copies.filter((copy) => copy.includes("RETRY-SECRET"))).toHaveLength(1);
      } finally {
        rename.mockRestore();
      }
      if (recovery === "same mutation") {
        // The workspace is already gone: the retried mutation does no write.
        await storage.coordinators.mutateCoordinatorWorkspace("project-1", () => null);
      } else if (recovery === "unrelated save") {
        await storage.kanban.saveLinearAuth("new-key");
      } else {
        storage.close();
        const reopened = new ArchiveProbe(storage.getDataDir());
        services.push(reopened);
        await reopened.init();
      }
      for (const copy of Object.values(await archiveFiles(archive))) {
        expect(copy).not.toContain("RETRY-SECRET");
        expect(copy).toContain("project-2");
      }
      // Subsequent ordinary saves must not bring archived content back.
      await storage.kanban.saveLinearAuth("another-key");
      expect(Object.values(await archiveFiles(archive)).join("")).not.toContain("RETRY-SECRET");
    },
  );

  test("replays failed whole-store deletion after reopening", async () => {
    const { storage, archive } = await migrated({ "linear-auth.json": { apiKey: "DELETE-RETRY" } });
    const original = syncFs.rmSync;
    const remove = spyOn(syncFs, "rmSync").mockImplementation((file, options) => {
      if (String(file).includes("linear-auth.json")) throw new Error("archive removal failed");
      return original(file, options);
    });
    try {
      await expect(storage.kanban.clearLinearAuth()).rejects.toThrow("archive removal failed");
      expect(storage.committed("linear-auth")).toBeUndefined();
    } finally {
      remove.mockRestore();
    }
    storage.close();
    const reopened = new ArchiveProbe(storage.getDataDir());
    services.push(reopened);
    await reopened.init();
    expect(await archiveFiles(archive)).toEqual({});
  });

  test.each([false, true])(
    "first saves preserve missing-store history and prune corrupt stores (corrupt=%s)",
    async (corrupt) => {
      const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-peer-archive-"));
      directories.push(dataDir);
      const first = new ArchiveProbe(dataDir);
      services.push(first);
      await first.init();
      const environment = await first.addEnvironment(createEnvironment("project-1"));
      first.close();
      const peer = { peer: composeDraft("peer", environment.id, "UNIMPORTED-PEER") };
      for (const suffix of ["", ".bak.1"]) {
        await fs.writeFile(
          path.join(dataDir, `compose-drafts.json${suffix}`),
          JSON.stringify(peer),
        );
      }
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      const storage = new ArchiveProbe(dataDir);
      services.push(storage);
      try {
        await storage.init();
      } finally {
        warn.mockRestore();
      }
      if (corrupt) seedUnreadableStore(dataDir, "compose-drafts.json");
      // An initial write is addition evidence only; unreadability is different.
      await storage.saveComposeDraft("local", "environment", environment.id, { text: "new" });
      const [stamp] = await fs.readdir(path.join(dataDir, LEGACY_JSON_DIRECTORY));
      for (const copy of Object.values(
        await archiveFiles(path.join(dataDir, LEGACY_JSON_DIRECTORY, stamp!)),
      )) {
        expect(copy.includes("UNIMPORTED-PEER")).toBe(!corrupt);
      }
    },
  );

  test.each(["root", "nested"])(
    "deletion clears incompatible %s archive containers",
    async (shape) => {
      const coordinators = {
        version: COORDINATOR_WORKSPACE_VERSION,
        revision: 0,
        workspaces: { "project-1": workspace("project-1"), "project-2": workspace("project-2") },
        workflows: [],
      };
      const { storage, archive } = await migrated({ "coordinators.json": coordinators });
      const malformed =
        shape === "root"
          ? [{ title: "INCOMPATIBLE-SECRET" }]
          : { ...coordinators, workspaces: [{ title: "INCOMPATIBLE-SECRET" }] };
      await fs.writeFile(path.join(archive, "coordinators.json.bak.1"), JSON.stringify(malformed));
      await storage.coordinators.mutateCoordinatorWorkspace("project-1", () => null);
      for (const copy of Object.values(await archiveFiles(archive)))
        expect(copy).not.toContain("INCOMPATIBLE-SECRET");
    },
  );

  test("routine environment saves preserve archive bytes before attributable attachment cleanup", async () => {
    const environment = createEnvironment("project-1");
    environment.initialPromptAttachments = [
      { id: "a", name: "private.png", base64Data: "ENVIRONMENT-SECRET" },
    ];
    const { storage, archive } = await migrated({ "environments.json": [environment] });
    const before = await archiveFiles(archive);
    await storage.updateEnvironment(environment.id, { name: "renamed", status: "running" });
    expect(await archiveFiles(archive)).toEqual(before);
    await storage.updateEnvironment(environment.id, { initialPromptAttachments: null });
    for (const copy of Object.values(await archiveFiles(archive))) {
      expect(copy).not.toContain("ENVIRONMENT-SECRET");
      expect(copy).toContain(environment.id);
    }
  });

  test("queue transitions prune moved heads and acknowledged in-flight copies without rewriting other queues", async () => {
    const environment = createEnvironment("project-1");
    const queue = {
      queueKey: "queue",
      environmentId: environment.id,
      revision: 1,
      updatedAt: new Date().toISOString(),
      messages: [
        { id: "head", text: "QUEUED-SECRET" },
        { id: "tail", text: "kept" },
      ],
    };
    const completed = {
      ...queue,
      queueKey: "completed",
      messages: [],
      inFlight: {
        message: { id: "sent", text: "IN-FLIGHT-SECRET" },
        requestId: "sent",
        reservedAt: new Date().toISOString(),
      },
    };
    const { storage, archive } = await migrated({
      "environments.json": [environment],
      "prompt-queues.json": { queue, completed },
    });
    const reservation = await storage.reservePromptQueueHeadForDispatch("queue");
    expect(reservation?.message).toEqual(queue.messages[0]);
    // The archive retains its old shape; the head has left that location.
    for (const suffix of ["", ".bak.1"]) {
      const copy = await fs.readFile(path.join(archive, `prompt-queues.json${suffix}`), "utf8");
      expect(copy).not.toContain("QUEUED-SECRET");
      expect(copy).toContain("IN-FLIGHT-SECRET");
      expect(copy).toContain("kept");
    }
    const beforeFence = await archiveFiles(archive);
    await storage.markPromptQueueDispatchSubmitting("queue", "head");
    await storage.markPromptQueueDispatchSubmitted("queue", "head");
    expect(await archiveFiles(archive)).toEqual(beforeFence);
    await storage.acknowledgePromptQueueDispatch("completed", "sent");
    await storage.acknowledgePromptQueueDispatch("queue", "head");
    for (const suffix of ["", ".bak.1"]) {
      const copy = await fs.readFile(path.join(archive, `prompt-queues.json${suffix}`), "utf8");
      expect(copy).not.toContain("IN-FLIGHT-SECRET");
      expect(copy).toContain("kept");
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

    await storage.kanban.clearLinearAuth();

    expect((await fs.readdir(archive)).filter((name) => name.startsWith("linear-auth"))).toEqual(
      [],
    );
    expect(await fs.readFile(path.join(archive, "compose-drafts.json"), "utf8")).toBe(draftCopy);
  });
});
