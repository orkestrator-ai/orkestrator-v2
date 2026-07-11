import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createEnvironment,
  createProject,
  defaultConfig,
  defaultEnvironmentName,
  extractRepoName,
  parseUpdateObject,
  sanitizeBranchName,
  sanitizeEnvironmentName,
  StorageService,
} from "../../../electron/backend/storage";

mock.module("sharp", () => {
  const pipeline = {
    resize: mock(() => pipeline),
    webp: mock(() => pipeline),
    toBuffer: mock(async () => Buffer.from("webp-bytes")),
  };
  return { default: mock(() => pipeline) };
});

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function withFixedDate<T>(iso: string, fn: () => T): T {
  const RealDate = Date;
  const fixedTime = new RealDate(iso).getTime();

  globalThis.Date = class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(fixedTime);
      } else if (args.length === 1) {
        super(args[0]);
      } else {
        super(
          args[0],
          args[1],
          args[2] ?? 1,
          args[3] ?? 0,
          args[4] ?? 0,
          args[5] ?? 0,
          args[6] ?? 0,
        );
      }
    }

    static now() {
      return fixedTime;
    }
  } as DateConstructor;

  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Electron StorageService", () => {
  test("sanitizes names, extracts repository names, and rejects non-record updates", () => {
    expect(sanitizeEnvironmentName("  My Feature/🚀  ")).toBe("my-feature");
    expect(sanitizeEnvironmentName("🚀")).toBe("env");
    expect(sanitizeEnvironmentName("a".repeat(120))).toHaveLength(100);
    expect(sanitizeBranchName("Feature.One/Two")).toBe("feature-one-two");
    expect(extractRepoName("git@github.com:openai/example.git")).toBe("example");
    expect(parseUpdateObject({ status: "running" })).toEqual({ status: "running" });
    expect(parseUpdateObject(null)).toEqual({});
    expect(parseUpdateObject([])).toEqual({});
  });

  test("creates project records with normalized names and nullable local paths", () => {
    const project = createProject("https://github.com/openai/example.git");
    expect(project).toMatchObject({
      name: "example",
      gitUrl: "https://github.com/openai/example.git",
      localPath: null,
      order: 0,
    });
    expect(project.id).toBeTruthy();
  });

  test("default config uses the shared dark terminal background", () => {
    expect(defaultConfig().global.terminalAppearance.backgroundColor).toBe("#141414");
  });

  test("formats default environment names from UTC timestamps", () => {
    expect(withFixedDate("2026-04-15T12:34:56.789Z", () => defaultEnvironmentName())).toBe(
      "20260415-123456",
    );
  });

  test("creates unnamed environments with legacy-compatible timestamp names", () => {
    const environment = createEnvironment("project-1");

    expect(environment.name).toMatch(/^\d{8}-\d{6}$/);
    expect(environment.branch).toBe(environment.name);
  });

  test("recovers JSON from a rotated backup when the primary file is malformed", async () => {
    const dataDir = await createTempDir("ork-storage-json-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const first = defaultConfig();
    first.global.defaultAgent = "claude";
    await storage.saveConfig(first);

    const second = defaultConfig();
    second.global.defaultAgent = "codex";
    await storage.saveConfig(second);
    await fs.writeFile(path.join(dataDir, "config.json"), "{not-json");

    await expect(storage.loadConfig()).resolves.toMatchObject({
      global: expect.objectContaining({ defaultAgent: "claude" }),
    });
  });

  test("covers project, environment, and configuration CRUD boundaries", async () => {
    const dataDir = await createTempDir("ork-storage-crud-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const firstProject = await storage.addProject(createProject("https://github.com/acme/first.git"));
    const secondProject = await storage.addProject(createProject("https://github.com/acme/second.git", "/tmp/second"));
    await expect(storage.addProject(createProject(firstProject.gitUrl))).rejects.toThrow("Duplicate project URL");
    await expect(storage.updateProject("missing", { name: "x" })).rejects.toThrow("Project not found");
    await storage.updateProject(firstProject.id, { name: "First renamed", localPath: "/tmp/first" });
    expect(await storage.getProject(firstProject.id)).toMatchObject({ name: "First renamed", localPath: "/tmp/first" });
    expect((await storage.reorderProjects([secondProject.id])).map((project) => project.id)).toEqual([
      secondProject.id,
      firstProject.id,
    ]);

    const firstEnvironment = await storage.addEnvironment(createEnvironment(firstProject.id, { name: "first" }));
    const secondEnvironment = await storage.addEnvironment(createEnvironment(firstProject.id, { name: "second" }));
    const otherEnvironment = await storage.addEnvironment(createEnvironment(secondProject.id, { name: "other" }));
    const updated = await storage.updateEnvironment(firstEnvironment.id, {
      containerId: "container-1",
      allowedDomains: ["example.com", 42],
      setupScriptsComplete: true,
      networkAccessMode: "full",
      entryPort: Number.NaN,
    });
    expect(updated).toMatchObject({
      containerId: "container-1",
      allowedDomains: ["example.com"],
      setupScriptsComplete: true,
      networkAccessMode: "full",
      entryPort: undefined,
    });
    await expect(storage.updateEnvironment("missing", {})).rejects.toThrow("Environment not found");
    expect((await storage.reorderEnvironments(firstProject.id, [secondEnvironment.id])).map((environment) => environment.id)).toEqual([
      secondEnvironment.id,
      firstEnvironment.id,
    ]);
    expect((await storage.getEnvironmentsByProject(secondProject.id)).map((environment) => environment.id)).toEqual([otherEnvironment.id]);

    expect(await storage.getRepositoryConfig("missing")).toEqual({ defaultBranch: "main", prBaseBranch: "main" });
    await storage.updateRepositoryConfig(firstProject.id, { defaultBranch: "develop", prBaseBranch: "release" });
    expect(await storage.getRepositoryConfig(firstProject.id)).toEqual({ defaultBranch: "develop", prBaseBranch: "release" });
    const global = defaultConfig().global;
    global.webClientEnabled = false;
    await storage.updateGlobalConfig(global);
    expect((await storage.loadConfig()).global.webClientEnabled).toBe(false);

    await storage.removeEnvironment(otherEnvironment.id);
    await expect(storage.removeEnvironment(otherEnvironment.id)).rejects.toThrow("Environment not found");
    await storage.removeProject(secondProject.id);
    await expect(storage.removeProject(secondProject.id)).rejects.toThrow("Project not found");
  });

  test("persists session buffers, deletes removed session buffers, and cleans orphan buffers", async () => {
    const dataDir = await createTempDir("ork-storage-sessions-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const session = await storage.createSession("env-1", "container-1", "tab-1", "claude");
    await storage.saveSessionBuffer(session.id, "terminal output");
    await expect(storage.loadSessionBuffer(session.id)).resolves.toBe("terminal output");

    await storage.removeSession(session.id);
    await expect(storage.loadSessionBuffer(session.id)).resolves.toBeNull();

    await fs.mkdir(path.join(dataDir, "buffers"), { recursive: true });
    await fs.writeFile(path.join(dataDir, "buffers", "orphan.txt"), "stale");
    await expect(storage.cleanupOrphanedBuffers()).resolves.toEqual(["orphan"]);
    await expect(fs.stat(path.join(dataDir, "buffers", "orphan.txt"))).rejects.toThrow();
  });

  test("updates, reorders, disconnects, and bulk-removes sessions", async () => {
    const dataDir = await createTempDir("ork-storage-session-crud-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const first = await storage.createSession("env-1", "container-1", "tab-1", "terminal");
    const second = await storage.createSession("env-1", "container-1", "tab-2", "claude");
    await expect(storage.updateSession("missing", { name: "x" })).rejects.toThrow("Session not found");
    await storage.updateSession(first.id, { name: "Shell" });
    expect(await storage.getSession(first.id)).toMatchObject({ status: "connected", name: "Shell" });
    expect((await storage.reorderSessions("env-1", [second.id])).map((session) => session.id)).toEqual([second.id, first.id]);
    expect(await storage.disconnectEnvironmentSessions("env-1")).toHaveLength(2);
    expect(await storage.removeSessionsByEnvironment("env-1")).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(await storage.getSessionsByEnvironment("env-1")).toEqual([]);
  });

  test("updates and deletes kanban tasks and comments with missing-id errors", async () => {
    const dataDir = await createTempDir("ork-storage-kanban-crud-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const task = await storage.addKanbanTask("project-1", "Build", "Initial");
    const updated = await storage.updateKanbanTask(task.id, { title: "Build it" });
    expect(updated.title).toBe("Build it");
    const commented = await storage.addKanbanComment(task.id, "Looks good");
    const commentId = commented.comments[0]?.id;
    expect(commentId).toBeTruthy();
    expect((await storage.deleteKanbanComment(task.id, commentId!)).comments).toEqual([]);
    await expect(storage.addKanbanComment("missing", "x")).rejects.toThrow("Kanban task not found");
    await expect(storage.deleteKanbanComment(task.id, "missing")).resolves.toMatchObject({ comments: [] });
    await storage.deleteKanbanTask(task.id);
    await expect(storage.updateKanbanTask(task.id, { title: "x" })).rejects.toThrow("Kanban task not found");
  });

  test("stores project notes and updates the existing note for the project", async () => {
    const dataDir = await createTempDir("ork-storage-notes-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await expect(storage.getProjectNotes("project-1")).resolves.toMatchObject({ projectId: "project-1", content: "" });

    const first = await storage.saveProjectNotes("project-1", "initial notes");
    expect(first).toMatchObject({ projectId: "project-1", content: "initial notes" });

    const second = await storage.saveProjectNotes("project-1", "updated notes");
    expect(second).toMatchObject({ projectId: "project-1", content: "updated notes" });
    await expect(storage.getProjectNotes("project-1")).resolves.toMatchObject({ content: "updated notes" });
  });

  test("persists feature planning chats and story refinements", async () => {
    const dataDir = await createTempDir("ork-storage-features-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.createFeaturePlan("project-1");
    expect(feature).toMatchObject({
      projectId: "project-1",
      title: "new feature",
      status: "collecting",
    });
    expect(feature.messages[0]).toMatchObject({
      role: "assistant",
      content: "Tell me about the new feature",
    });

    const withUserMessage = await storage.appendFeaturePlanMessage(feature.id, "user", "Users can save filters.");
    expect(withUserMessage.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Users can save filters.",
    });

    const storyId = "story-1";
    await storage.updateFeaturePlan(feature.id, {
      status: "stories",
      summary: "Users can save and reuse filtered views.",
      stories: [{
        id: storyId,
        title: "Save a filtered view",
        description: "A user can save the current filters so they can return to that view later.",
        acceptanceCriteria: ["Saved filters can be named", "Saved filters can be reopened"],
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    const withStoryChat = await storage.appendFeatureStoryMessage(feature.id, storyId, "assistant", "What should change?");
    expect(withStoryChat.stories[0]?.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "What should change?",
      }),
    ]);

    const reloaded = new StorageService(dataDir);
    await reloaded.init();
    await expect(reloaded.getFeaturePlans("project-1")).resolves.toEqual([
      expect.objectContaining({
        id: feature.id,
        status: "stories",
        summary: "Users can save and reuse filtered views.",
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "Users can save filters." }),
        ]),
        stories: [
          expect.objectContaining({
            id: storyId,
            title: "Save a filtered view",
            acceptanceCriteria: ["Saved filters can be named", "Saved filters can be reopened"],
            messages: [
              expect.objectContaining({ role: "assistant", content: "What should change?" }),
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

    const feature = await storage.createFeaturePlan("project-1");

    // id and projectId must not be overwritable through updates.
    const updated = await storage.updateFeaturePlan(feature.id, {
      title: "renamed",
      id: "hacked-id",
      projectId: "other-project",
    } as never);
    expect(updated.id).toBe(feature.id);
    expect(updated.projectId).toBe("project-1");
    expect(updated.title).toBe("renamed");

    await expect(storage.updateFeaturePlan("missing", { title: "x" })).rejects.toThrow(/not found/i);
    await expect(storage.appendFeaturePlanMessage("missing", "user", "hi")).rejects.toThrow(/not found/i);
    await expect(storage.appendFeatureStoryMessage(feature.id, "missing-story", "user", "hi")).rejects.toThrow(/not found/i);

    // A failed mutation must not corrupt the persisted plan.
    await expect(storage.getFeaturePlans("project-1")).resolves.toEqual([
      expect.objectContaining({ id: feature.id, projectId: "project-1", title: "renamed" }),
    ]);
  });

  test("serializes concurrent feature plan mutations without losing writes", async () => {
    const dataDir = await createTempDir("ork-storage-features-concurrency-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const feature = await storage.createFeaturePlan("project-1");
    await storage.updateFeaturePlan(feature.id, {
      stories: [{
        id: "story-1",
        title: "Story one",
        description: "desc",
        acceptanceCriteria: [],
        messages: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
    });

    // Fire a feature-chat append and a story append concurrently. With a stale
    // read-modify-write both would clobber each other; the mutation queue must
    // preserve both.
    await Promise.all([
      storage.appendFeaturePlanMessage(feature.id, "user", "feature note"),
      storage.appendFeatureStoryMessage(feature.id, "story-1", "user", "story note"),
    ]);

    const [reloaded] = await storage.getFeaturePlans("project-1");
    expect(reloaded?.messages.some((message) => message.content === "feature note")).toBe(true);
    expect(reloaded?.stories[0]?.messages.some((message) => message.content === "story note")).toBe(true);
  });

  test("stores Linear auth separately and tracks completion comments by pipeline", async () => {
    const dataDir = await createTempDir("ork-storage-linear-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await expect(storage.getLinearAuth()).resolves.toBeNull();

    const auth = await storage.saveLinearAuth("lin_api_secret", {
      id: "viewer-1",
      name: "Ada",
      email: "ada@example.com",
    });
    expect(auth).toMatchObject({
      apiKey: "lin_api_secret",
      viewer: { id: "viewer-1", name: "Ada" },
    });
    await expect(storage.getLinearAuth()).resolves.toMatchObject({
      apiKey: "lin_api_secret",
      viewer: { email: "ada@example.com" },
    });
    expect((await fs.stat(path.join(dataDir, "linear-auth.json"))).mode & 0o777).toBe(0o600);

    await storage.saveLinearAuth("lin_api_reconnected", {
      id: "viewer-2",
      name: "Grace",
    });
    expect((await fs.stat(path.join(dataDir, "linear-auth.json"))).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(dataDir)).not.toContain("linear-auth.json.bak.1");

    const posted = await storage.saveLinearCompletionComment({
      pipelineId: "pipeline-1",
      issueId: "issue-1",
      status: "posted",
      commentId: "comment-1",
      postedAt: "2026-06-28T12:00:00.000Z",
    });
    expect(posted).toMatchObject({ pipelineId: "pipeline-1", status: "posted", commentId: "comment-1" });
    await expect(storage.getLinearCompletionComment("pipeline-1")).resolves.toMatchObject({
      issueId: "issue-1",
      commentId: "comment-1",
    });

    const failed = await storage.saveLinearCompletionComment({
      pipelineId: "pipeline-1",
      issueId: "issue-1",
      status: "failed",
      error: "Linear API unavailable",
    });
    expect(failed).toMatchObject({ pipelineId: "pipeline-1", status: "failed", error: "Linear API unavailable" });
    await expect(storage.getLinearCompletionComment("pipeline-1")).resolves.toMatchObject({
      status: "failed",
      error: "Linear API unavailable",
    });

    await storage.clearLinearAuth();
    await expect(storage.getLinearAuth()).resolves.toBeNull();
  });

  test("removes temporary Linear auth files when a secret write fails", async () => {
    const dataDir = await createTempDir("ork-storage-linear-failed-");
    const storage = new StorageService(dataDir);
    await storage.init();

    await fs.mkdir(path.join(dataDir, "linear-auth.json"));

    await expect(storage.saveLinearAuth("lin_api_secret")).rejects.toThrow();

    const files = await fs.readdir(dataDir);
    expect(files.filter((file) => file.startsWith(".linear-auth.json.") && file.endsWith(".tmp"))).toEqual([]);
  });

  test("persists kanban images as retrievable files and removes them when deleted", async () => {
    const dataDir = await createTempDir("ork-storage-kanban-");
    const storage = new StorageService(dataDir);
    await storage.init();

    const task = await storage.addKanbanTask("project-1", "Build thing", "Details");
    const transparentPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const withImage = await storage.addKanbanImage(task.id, "pixel.png", transparentPngBase64);
    const image = withImage.images[0];
    expect(image).toMatchObject({ filename: "pixel.png" });

    const encodedWebp = await storage.getKanbanImageData(image!.id);
    expect(encodedWebp.length).toBeGreaterThan(0);

    const withoutImage = await storage.deleteKanbanImage(task.id, image!.id);
    expect(withoutImage.images).toHaveLength(0);
    await expect(storage.getKanbanImageData(image!.id)).rejects.toThrow();
  });
});
