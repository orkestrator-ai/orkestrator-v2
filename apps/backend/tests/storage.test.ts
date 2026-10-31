import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StorageService } from "../src/core/storage";
import {
  hasStore,
  readStoredValue,
  seedUnreadableStore,
  storageFilesContain,
} from "../src/core/storage-test-support";
import { storageDatabase } from "../src/core/storage-test-support.js";
import {
  abandonLease,
  createTempDir,
  heldLeases,
  leaseHeld,
  removeTempDirs,
} from "./storage-test-helpers";

const resizeKanbanImageToBuffer = mock(async () => Buffer.from("webp-bytes"));
const transparentPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

mock.module("sharp", () => {
  const pipeline = {
    resize: mock(() => pipeline),
    webp: mock(() => pipeline),
    toBuffer: resizeKanbanImageToBuffer,
  };
  return { default: mock(() => pipeline) };
});

afterEach(async () => {
  resizeKanbanImageToBuffer.mockClear();
  resizeKanbanImageToBuffer.mockImplementation(async () => Buffer.from("webp-bytes"));
  await removeTempDirs();
});

describe("Electron StorageService", () => {
  test("updates and deletes kanban tasks and comments with missing-id errors", async () => {
    const dataDir = await createTempDir("ork-storage-kanban-crud-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const task = await storage.kanban.addKanbanTask("project-1", "Build", "Initial");
    const updated = await storage.kanban.updateKanbanTask(task.id, { title: "Build it" });
    expect(updated.title).toBe("Build it");
    const commented = await storage.kanban.addKanbanComment(task.id, "Looks good");
    const commentId = commented.comments[0]?.id;
    expect(commentId).toBeTruthy();
    expect((await storage.kanban.deleteKanbanComment(task.id, commentId!)).comments).toEqual([]);
    await expect(storage.kanban.addKanbanComment("missing", "x")).rejects.toThrow(
      "Kanban task not found",
    );
    await expect(storage.kanban.deleteKanbanComment(task.id, "missing")).resolves.toMatchObject({
      comments: [],
    });
    await storage.kanban.deleteKanbanTask(task.id);
    await expect(storage.kanban.updateKanbanTask(task.id, { title: "x" })).rejects.toThrow(
      "Kanban task not found",
    );
  });

  test("stores project notes and updates the existing note for the project", async () => {
    const dataDir = await createTempDir("ork-storage-notes-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await expect(storage.kanban.getProjectNotes("project-1")).resolves.toMatchObject({
      projectId: "project-1",
      content: "",
    });

    const first = await storage.kanban.saveProjectNotes("project-1", "initial notes");
    expect(first).toMatchObject({ projectId: "project-1", content: "initial notes" });

    const second = await storage.kanban.saveProjectNotes("project-1", "updated notes");
    expect(second).toMatchObject({ projectId: "project-1", content: "updated notes" });
    await expect(storage.kanban.getProjectNotes("project-1")).resolves.toMatchObject({
      content: "updated notes",
    });
  });

  test("persists feature planning chats and story refinements", async () => {
    const dataDir = await createTempDir("ork-storage-features-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.kanban.createFeaturePlan("project-1");
    expect(feature).toMatchObject({
      projectId: "project-1",
      title: "new feature",
      status: "collecting",
    });
    expect(feature.messages[0]).toMatchObject({
      role: "assistant",
      content: "Tell me about the new feature",
    });

    const withUserMessage = await storage.kanban.appendFeaturePlanMessage(
      feature.id,
      "user",
      "Users can save filters.",
      "pending",
    );
    expect(withUserMessage.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Users can save filters.",
      stateApplication: "pending",
    });

    const storyId = "story-1";
    await storage.kanban.updateFeaturePlan(feature.id, {
      status: "stories",
      summary: "Users can save and reuse filtered views.",
      stories: [
        {
          id: storyId,
          title: "Save a filtered view",
          description: "A user can save the current filters so they can return to that view later.",
          acceptanceCriteria: ["Saved filters can be named", "Saved filters can be reopened"],
          messages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const withStoryChat = await storage.kanban.appendFeatureStoryMessage(
      feature.id,
      storyId,
      "assistant",
      "What should change?",
      "applied",
      "gpt-5.3-codex",
    );
    expect(withStoryChat.stories[0]?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "What should change?",
        stateApplication: "applied",
        modelId: "gpt-5.3-codex",
      }),
    ]);

    const reloaded = new StorageService(dataDir);
    await reloaded.init();
    await expect(reloaded.kanban.getFeaturePlans("project-1")).resolves.toEqual([
      expect.objectContaining({
        id: feature.id,
        status: "stories",
        summary: "Users can save and reuse filtered views.",
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: "Users can save filters.",
            stateApplication: "pending",
          }),
        ]),
        stories: [
          expect.objectContaining({
            id: storyId,
            title: "Save a filtered view",
            acceptanceCriteria: ["Saved filters can be named", "Saved filters can be reopened"],
            messages: [
              expect.objectContaining({
                role: "assistant",
                content: "What should change?",
                stateApplication: "applied",
                modelId: "gpt-5.3-codex",
              }),
            ],
          }),
        ],
      }),
    ]);
  });

  test("preserves feature plan identity and rejects unknown feature/story ids", async () => {
    const dataDir = await createTempDir("ork-storage-features-errors-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.kanban.createFeaturePlan("project-1");

    // id and projectId must not be overwritable through updates.
    const updated = await storage.kanban.updateFeaturePlan(feature.id, {
      title: "renamed",
      id: "hacked-id",
      projectId: "other-project",
    } as never);
    expect(updated.id).toBe(feature.id);
    expect(updated.projectId).toBe("project-1");
    expect(updated.title).toBe("renamed");

    await expect(storage.kanban.updateFeaturePlan("missing", { title: "x" })).rejects.toThrow(
      /not found/i,
    );
    await expect(storage.kanban.appendFeaturePlanMessage("missing", "user", "hi")).rejects.toThrow(
      /not found/i,
    );
    await expect(
      storage.kanban.appendFeatureStoryMessage(feature.id, "missing-story", "user", "hi"),
    ).rejects.toThrow(/not found/i);

    // A failed mutation must not corrupt the persisted plan.
    await expect(storage.kanban.getFeaturePlans("project-1")).resolves.toEqual([
      expect.objectContaining({ id: feature.id, projectId: "project-1", title: "renamed" }),
    ]);
  });

  test("serializes concurrent feature plan mutations without losing writes", async () => {
    const dataDir = await createTempDir("ork-storage-features-concurrency-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.kanban.createFeaturePlan("project-1");
    await storage.kanban.updateFeaturePlan(feature.id, {
      stories: [
        {
          id: "story-1",
          title: "Story one",
          description: "desc",
          acceptanceCriteria: [],
          messages: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    // Fire a feature-chat append and a story append concurrently. With a stale
    // read-modify-write both would clobber each other; the mutation queue must
    // preserve both.
    await Promise.all([
      storage.kanban.appendFeaturePlanMessage(feature.id, "user", "feature note"),
      storage.kanban.appendFeatureStoryMessage(feature.id, "story-1", "user", "story note"),
    ]);

    const [reloaded] = await storage.kanban.getFeaturePlans("project-1");
    expect(reloaded?.messages.some((message) => message.content === "feature note")).toBe(true);
    expect(reloaded?.stories[0]?.messages.some((message) => message.content === "story note")).toBe(
      true,
    );
  });

  test("stores Linear auth separately and tracks completion comments by pipeline", async () => {
    const dataDir = await createTempDir("ork-storage-linear-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await expect(storage.kanban.getLinearAuth()).resolves.toBeNull();

    const auth = await storage.kanban.saveLinearAuth("lin_api_secret", {
      id: "viewer-1",
      name: "Ada",
      email: "ada@example.com",
    });
    expect(auth).toMatchObject({
      apiKey: "lin_api_secret",
      viewer: { id: "viewer-1", name: "Ada" },
    });
    await expect(storage.kanban.getLinearAuth()).resolves.toMatchObject({
      apiKey: "lin_api_secret",
      viewer: { email: "ada@example.com" },
    });
    // The credential lives in the private database file, never in a JSON file.
    expect((await fs.stat(path.join(dataDir, "orkestrator.sqlite"))).mode & 0o777).toBe(0o600);
    expect(readStoredValue(dataDir, "linear-auth.json")).toMatchObject({
      apiKey: "lin_api_secret",
    });

    await storage.kanban.saveLinearAuth("lin_api_reconnected", {
      id: "viewer-2",
      name: "Grace",
    });
    expect((await fs.stat(path.join(dataDir, "orkestrator.sqlite"))).mode & 0o777).toBe(0o600);
    expect(readStoredValue(dataDir, "linear-auth.json")).toMatchObject({
      apiKey: "lin_api_reconnected",
    });
    expect((await fs.readdir(dataDir)).filter((file) => file.startsWith("linear-auth"))).toEqual(
      [],
    );

    const posted = await storage.kanban.saveLinearCompletionComment({
      pipelineId: "pipeline-1",
      issueId: "issue-1",
      status: "posted",
      commentId: "comment-1",
      postedAt: "2026-06-28T12:00:00.000Z",
    });
    expect(posted).toMatchObject({
      pipelineId: "pipeline-1",
      status: "posted",
      commentId: "comment-1",
    });
    await expect(storage.kanban.getLinearCompletionComment("pipeline-1")).resolves.toMatchObject({
      issueId: "issue-1",
      commentId: "comment-1",
    });

    const failed = await storage.kanban.saveLinearCompletionComment({
      pipelineId: "pipeline-1",
      issueId: "issue-1",
      status: "failed",
      error: "Linear API unavailable",
    });
    expect(failed).toMatchObject({
      pipelineId: "pipeline-1",
      status: "failed",
      error: "Linear API unavailable",
    });
    await expect(storage.kanban.getLinearCompletionComment("pipeline-1")).resolves.toMatchObject({
      status: "failed",
      error: "Linear API unavailable",
    });

    await storage.kanban.clearLinearAuth();
    await expect(storage.kanban.getLinearAuth()).resolves.toBeNull();
  });

  test("persists GitHub completion comment outcomes by pipeline", async () => {
    const dataDir = await createTempDir("ork-storage-github-completion-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await expect(storage.kanban.getGitHubCompletionComment("pipeline-github")).resolves.toBeNull();
    await storage.kanban.saveGitHubCompletionComment({
      pipelineId: "pipeline-github",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      status: "posted",
      commentId: "9001",
      postedAt: "2026-07-24T12:00:00.000Z",
    });

    await expect(
      storage.kanban.getGitHubCompletionComment("pipeline-github"),
    ).resolves.toMatchObject({
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      status: "posted",
      commentId: "9001",
    });

    await storage.kanban.saveGitHubCompletionComment({
      pipelineId: "pipeline-github",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      status: "failed",
      error: "GitHub API unavailable",
    });
    await expect(
      storage.kanban.getGitHubCompletionComment("pipeline-github"),
    ).resolves.toMatchObject({
      status: "failed",
      error: "GitHub API unavailable",
    });
    expect(hasStore(dataDir, "github-completion-comments.json")).toBe(true);
  });

  test("serializes GitHub completion comment writes across storage instances", async () => {
    const dataDir = await createTempDir("ork-storage-github-completion-concurrency-");
    const first = new StorageService(dataDir);
    const second = new StorageService(dataDir);
    await Promise.all([first.init(), second.init()]);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const storage = index % 2 === 0 ? first : second;
        return storage.kanban.saveGitHubCompletionComment({
          pipelineId: `pipeline-${index}`,
          repositoryOwner: "acme",
          repositoryName: "widget",
          issueNumber: index + 1,
          status: index % 3 === 0 ? "failed" : "posted",
          ...(index % 3 === 0
            ? { error: `failure-${index}` }
            : { commentId: String(9_000 + index), postedAt: "2026-07-24T12:00:00.000Z" }),
        });
      }),
    );

    const records = readStoredValue<Array<{ pipelineId: string }>>(
      dataDir,
      "github-completion-comments.json",
    )!;
    expect(records).toHaveLength(20);
    expect(new Set(records.map((record) => record.pipelineId)).size).toBe(20);
    await expect(first.kanban.getGitHubCompletionComment("pipeline-0")).resolves.toMatchObject({
      status: "failed",
      error: "failure-0",
    });
    await expect(second.kanban.getGitHubCompletionComment("pipeline-19")).resolves.toMatchObject({
      status: "posted",
      commentId: "9019",
    });
    expect(heldLeases(dataDir)).toEqual([]);
  });

  test("serializes the complete GitHub completion transaction across storage instances", async () => {
    const dataDir = await createTempDir("ork-storage-github-post-lock-");
    const first = new StorageService(dataDir);
    const second = new StorageService(dataDir);
    await Promise.all([first.init(), second.init()]);

    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const firstRun = first.kanban.withGitHubCompletionCommentLock("pipeline-shared", async () => {
      order.push("first-start");
      markFirstEntered();
      await firstGate;
      order.push("first-end");
    });
    await firstEntered;

    const secondRun = second.kanban.withGitHubCompletionCommentLock("pipeline-shared", async () => {
      order.push("second-start");
      order.push("second-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  test("recovers an abandoned GitHub completion transaction lock", async () => {
    const dataDir = await createTempDir("ork-storage-github-stale-post-lock-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const pipelineId = "pipeline-abandoned";
    const key = createHash("sha256").update(pipelineId).digest("hex");
    const lease = `github-completion-comment-locks/${key}`;
    await abandonLease(dataDir, lease);
    expect(leaseHeld(dataDir, lease)).toBe(true);

    await expect(
      storage.kanban.withGitHubCompletionCommentLock(pipelineId, async () => "recovered"),
    ).resolves.toBe("recovered");
    expect(leaseHeld(dataDir, lease)).toBe(false);
  });

  test("recovers GitHub completion comments from malformed persistence", async () => {
    const dataDir = await createTempDir("ork-storage-github-completion-malformed-");
    const storage = new StorageService(dataDir);
    await storage.init();
    seedUnreadableStore(dataDir, "github-completion-comments.json");
    await expect(storage.kanban.getGitHubCompletionComment("missing")).resolves.toBeNull();

    await storage.kanban.saveGitHubCompletionComment({
      pipelineId: "pipeline-recovered",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      status: "failed",
      error: "first attempt failed",
    });
    await storage.kanban.saveGitHubCompletionComment({
      pipelineId: "pipeline-recovered",
      repositoryOwner: "acme",
      repositoryName: "widget",
      issueNumber: 42,
      status: "posted",
      commentId: "9001",
      postedAt: "2026-07-24T12:00:00.000Z",
    });

    // The first write replaced the unreadable store; the latest outcome wins.
    await expect(
      storage.kanban.getGitHubCompletionComment("pipeline-recovered"),
    ).resolves.toMatchObject({
      status: "posted",
      commentId: "9001",
    });
    expect(
      readStoredValue<Array<{ pipelineId: string }>>(dataDir, "github-completion-comments.json"),
    ).toEqual([expect.objectContaining({ pipelineId: "pipeline-recovered", status: "posted" })]);

    // A store that becomes unreadable later still reads leniently as absent.
    seedUnreadableStore(dataDir, "github-completion-comments.json", "{truncated");
    await expect(
      storage.kanban.getGitHubCompletionComment("pipeline-recovered"),
    ).resolves.toBeNull();
  });

  test("leaves no trace of a Linear secret when its write fails", async () => {
    const dataDir = await createTempDir("ork-storage-linear-failed-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const database = storageDatabase(storage);
    const writeStore = spyOn(database, "writeStoreInTransaction").mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    try {
      await expect(storage.kanban.saveLinearAuth("lin_api_failed_secret")).rejects.toThrow(
        "disk full",
      );
    } finally {
      writeStore.mockRestore();
    }

    await expect(storage.kanban.getLinearAuth()).resolves.toBeNull();
    expect(hasStore(dataDir, "linear-auth.json")).toBe(false);
    expect(storageFilesContain(dataDir, "lin_api_failed_secret")).toBe(false);
    expect((await fs.readdir(dataDir)).filter((file) => file.includes("linear-auth"))).toEqual([]);
  });

  test("persists kanban images as retrievable files and removes them when deleted", async () => {
    const dataDir = await createTempDir("ork-storage-kanban-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const task = await storage.kanban.addKanbanTask("project-1", "Build thing", "Details");
    const withImage = await storage.kanban.addKanbanImage(
      task.id,
      "pixel.png",
      transparentPngBase64,
    );
    const image = withImage.images[0];
    expect(image).toMatchObject({ filename: "pixel.png" });

    const encodedWebp = await storage.kanban.getKanbanImageData(image!.id);
    expect(encodedWebp.length).toBeGreaterThan(0);

    const withoutImage = await storage.kanban.deleteKanbanImage(task.id, image!.id);
    expect(withoutImage.images).toHaveLength(0);
    await expect(storage.kanban.getKanbanImageData(image!.id)).rejects.toThrow();
  });

  test("does not persist kanban image metadata when resizing fails", async () => {
    const dataDir = await createTempDir("ork-storage-kanban-resize-failed-");
    const storage = new StorageService(dataDir);
    await storage.init();
    const task = await storage.kanban.addKanbanTask("project-1", "Build thing", "Details");
    resizeKanbanImageToBuffer.mockRejectedValueOnce(new Error("image resize failed"));

    await expect(
      storage.kanban.addKanbanImage(task.id, "pixel.png", transparentPngBase64),
    ).rejects.toThrow("image resize failed");

    expect((await storage.kanban.getKanbanTasks("project-1"))[0]?.images).toEqual([]);
    await expect(fs.readdir(path.join(dataDir, "kanban-images"))).rejects.toThrow();
  });
});
