import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { BackendRuntime } from "./backend-runtime.js";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESIGN_CONFLICT,
  DESIGN_MAX_DOCUMENT_BYTES,
  type DesignCanvas,
} from "@orkestrator/protocol/design-canvas";
import type {
  DesignCommandResult,
  DesignOperationStatus,
  DesignPrepareResult,
} from "@orkestrator/protocol/design-operations";
import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { resolveDesignDestination } from "./design/exports.js";
import { DesignService } from "./design/service.js";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { createTestRenderer, trackUnhandledRejections } from "./design/test-support.js";
import { StorageService } from "./storage.js";

const frame = {
  name: "Home",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  html: "<h1>Hello</h1>",
};

describe("design command registry", () => {
  let dir: string;
  let worktree: string;
  let storage: StorageService;
  let design: DesignService;
  let context: CommandContext;
  let commands: ReturnType<typeof createCommandRegistry>;
  const rejections = trackUnhandledRejections();

  beforeEach(async () => {
    rejections.install();
    dir = await mkdtemp(join(tmpdir(), "ork-design-commands-"));
    worktree = await mkdtemp(join(tmpdir(), "ork-design-commands-repo-"));
    storage = new StorageService(dir);
    await storage.init();
    await storage.addProject({
      id: "project",
      name: "Project",
      gitUrl: "https://example.invalid/project.git",
      localPath: worktree,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    await storage.addEnvironment({
      id: "local",
      projectId: "project",
      name: "Local",
      branch: "main",
      environmentType: "local",
      worktreePath: worktree,
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
    });
    await storage.addEnvironment({
      id: "container",
      projectId: "project",
      name: "Container",
      branch: "container",
      environmentType: "containerized",
      containerId: "container-id",
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 1,
    });
    design = new DesignService(dir, () => {}, createTestRenderer());
    context = {
      storage,
      design,
      runtime: new BackendRuntime({ emit: () => undefined }),
    } as CommandContext;
    commands = createCommandRegistry();
  });

  afterEach(async () => {
    await design.close();
    await rm(dir, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const invoke = (name: string, args: Record<string, unknown>) =>
    Promise.resolve(commands.get(name)!(args, context));
  const typed = async <T = unknown>(name: string, args: Record<string, unknown>) =>
    (await invoke(name, args)) as DesignCommandResult<T>;
  const value = async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ) => {
    const result = await typed<T>(name, args);
    if (!result.ok)
      throw new Error(`${name} failed: ${result.failure.code} ${result.failure.message}`);
    return result.value;
  };

  test("validates environments and exercises action, changes and import", async () => {
    expect(await invoke("design_status", {})).toMatchObject({ ready: true });
    const canvas = (await invoke("design_action", {
      environmentId: "local",
      action: "create_canvas",
      input: { name: "Commands" },
    })) as DesignCanvas;
    expect(
      await invoke("design_changes", {
        environmentId: "local",
        canvasId: canvas.id,
        generation: design.generation,
        after: canvas.revision,
      }),
    ).toMatchObject({ reset: false, revision: 1 });
    const imported = (await invoke("design_import", {
      environmentId: "container",
      document: JSON.stringify(await design.get(canvas.id)),
    })) as DesignCanvas;
    expect(imported).toMatchObject({ environmentId: "container", name: canvas.name });
    expect(imported.id).not.toBe(canvas.id);
    await expect(
      invoke("design_action", {
        environmentId: "missing",
        action: "list_canvases",
        input: {},
      }),
    ).rejects.toThrow("Environment not found");
    await expect(
      invoke("design_import", { environmentId: "missing", document: "{}" }),
    ).rejects.toThrow("Environment not found");
    await expect(
      invoke("design_action", {
        environmentId: "local",
        action: "no_such_action",
        input: {},
      }),
    ).rejects.toThrow("Unknown design action");
  });

  test("imports an .orkdes file picked on the host and rejects other files", async () => {
    const canvas = (await invoke("design_action", {
      environmentId: "local",
      action: "create_canvas",
      input: { name: "Picked" },
    })) as DesignCanvas;
    const file = join(worktree, "picked.orkdes");
    await writeFile(file, JSON.stringify(await design.get(canvas.id)));
    const imported = (await invoke("design_import_host_file", {
      environmentId: "container",
      path: file,
    })) as DesignCanvas;
    expect(imported).toMatchObject({ environmentId: "container", name: canvas.name });
    expect(imported.id).not.toBe(canvas.id);
    await writeFile(join(worktree, "notes.txt"), "{}");
    await expect(
      invoke("design_import_host_file", {
        environmentId: "local",
        path: join(worktree, "notes.txt"),
      }),
    ).rejects.toThrow("Choose an .orkdes design file.");
    await expect(
      invoke("design_import_host_file", {
        environmentId: "local",
        path: join(worktree, "gone.orkdes"),
      }),
    ).rejects.toThrow("does not exist");
    await expect(
      invoke("design_import_host_file", {
        environmentId: "local",
        path: "relative.orkdes",
      }),
    ).rejects.toThrow("Choose an .orkdes design file.");
  });

  test("host import enforces the byte boundary and validates directories and document versions", async () => {
    const canvas = await design.create("local", "Boundary");
    const document = JSON.stringify(canvas);
    const path = join(worktree, "boundary.orkdes");
    await writeFile(
      path,
      document + " ".repeat(DESIGN_MAX_DOCUMENT_BYTES - Buffer.byteLength(document)),
    );
    expect(await invoke("design_import_host_file", { environmentId: "local", path })).toMatchObject(
      { name: "Boundary" },
    );
    await writeFile(
      path,
      document + " ".repeat(DESIGN_MAX_DOCUMENT_BYTES + 1 - Buffer.byteLength(document)),
    );
    await expect(
      invoke("design_import_host_file", { environmentId: "local", path }),
    ).rejects.toThrow("exceeds 4 MiB");
    await writeFile(path, "{");
    await expect(
      invoke("design_import_host_file", { environmentId: "local", path }),
    ).rejects.toThrow("not a valid .orkdes");
    await writeFile(path, JSON.stringify({ ...canvas, version: 2 }));
    await expect(
      invoke("design_import_host_file", { environmentId: "local", path }),
    ).rejects.toThrow("version is not supported");
    const directory = join(worktree, "directory.orkdes");
    await mkdir(directory);
    await expect(
      invoke("design_import_host_file", { environmentId: "local", path: directory }),
    ).rejects.toThrow("does not exist");
    expect(await design.list("local")).toHaveLength(2);
  });

  test("the UI acts as the user through the shared action boundary", async () => {
    const canvas = (await invoke("design_action", {
      environmentId: "local",
      action: "create_canvas",
      input: { name: "Actor" },
    })) as DesignCanvas;
    await invoke("design_action", {
      environmentId: "local",
      action: "create_frame",
      input: { canvasId: canvas.id, expectedRevision: 1, ...frame },
    });
    expect(
      await invoke("design_action", {
        environmentId: "local",
        action: "history_status",
        input: { canvasId: canvas.id },
      }),
    ).toMatchObject({ undoCount: 1, canUndo: true });
    // The agent did not make that edit and cannot undo it.
    expect(await design.historyStatus(canvas.id, "local", "agent")).toMatchObject({
      undoCount: 0,
      canUndo: false,
    });
  });

  test("legacy save writes the exact revision safely into the local worktree", async () => {
    const local = await design.create("local", "Local", undefined, "user");
    const other = await design.create("local", "Other", undefined, "user");
    expect(
      await invoke("design_save", {
        environmentId: "local",
        canvasId: local.id,
        expectedRevision: 1,
        filePath: "local.orkdes",
      }),
    ).toEqual({ filePath: "local.orkdes", revision: 1 });
    expect(JSON.parse(await readFile(join(worktree, "local.orkdes"), "utf8"))).toEqual(
      await design.get(local.id),
    );
    // Saving the same canvas again to its own export replaces it.
    await design.createFrame(local.id, "local", 1, frame, "user");
    expect(
      await invoke("design_save", {
        environmentId: "local",
        canvasId: local.id,
        expectedRevision: 2,
        filePath: "local.orkdes",
      }),
    ).toEqual({ filePath: "local.orkdes", revision: 2 });
    expect(JSON.parse(await readFile(join(worktree, "local.orkdes"), "utf8"))).toMatchObject({
      revision: 2,
    });
    // Another canvas can never silently replace it.
    await expect(
      invoke("design_save", {
        environmentId: "local",
        canvasId: other.id,
        expectedRevision: 1,
        filePath: "local.orkdes",
      }),
    ).rejects.toThrow("already exists");
    await expect(
      invoke("design_save", {
        environmentId: "local",
        canvasId: local.id,
        expectedRevision: 1,
        filePath: "stale.orkdes",
      }),
    ).rejects.toThrow(DESIGN_CONFLICT);
    await expect(
      invoke("design_save", {
        environmentId: "local",
        canvasId: local.id,
        expectedRevision: 2,
        filePath: "../escape.orkdes",
      }),
    ).rejects.toThrow();
    await expect(
      invoke("design_save", {
        environmentId: "container",
        canvasId: local.id,
        expectedRevision: 2,
        filePath: "x.orkdes",
      }),
    ).rejects.toThrow("not found");
    expect((await readdir(worktree)).sort()).toEqual(["local.orkdes"]);
    expect(await resolveDesignDestination(storage, "container")).toEqual({
      kind: "container",
      containerId: "container-id",
    });
  });

  test("v2 operations return typed envelopes and share one backend", async () => {
    expect(await value("design_capabilities", {})).toMatchObject({
      protocolVersion: 2,
      operations: true,
      sync: true,
    });
    expect(await value("design_readiness", {})).toMatchObject({
      storage: { available: true },
      renderer: { ready: true },
    });
    const created = await value<DesignPrepareResult>("design_prepare", {
      environmentId: "local",
      descriptor: {
        input: { kind: "create_canvas", name: "Typed" },
        correlationId: "create-1",
      },
    });
    const committed = await value<DesignOperationStatus>("design_execute", {
      environmentId: "local",
      canvasId: created.canvasId,
      token: created.token,
    });
    expect(committed).toMatchObject({
      state: "committed",
      actor: "user",
      result: { createdCanvasId: created.canvasId },
    });
    const prepared = await value<DesignPrepareResult>("design_prepare", {
      environmentId: "local",
      descriptor: {
        canvasId: created.canvasId,
        input: { kind: "create_frame", frame },
        preconditions: { canvasRevision: 1 },
      },
    });
    expect(
      await value("design_operation_status", {
        environmentId: "local",
        canvasId: created.canvasId,
        token: prepared.token,
      }),
    ).toMatchObject({ state: "prepared" });
    expect(
      await value("design_cancel", {
        environmentId: "local",
        canvasId: created.canvasId,
        token: prepared.token,
      }),
    ).toMatchObject({ state: "canceled" });
    expect(
      await value("design_execute", {
        environmentId: "local",
        canvasId: created.canvasId,
        token: prepared.token,
      }),
    ).toMatchObject({ state: "canceled" });
    expect(
      await value("design_snapshot", {
        environmentId: "local",
        canvasId: created.canvasId,
      }),
    ).toMatchObject({
      kind: "snapshot",
      canvas: { revision: 1, frames: [] },
    });
    expect(
      await value("design_sync", {
        environmentId: "local",
        canvasId: created.canvasId,
        generation: design.generation,
        after: 1,
      }),
    ).toMatchObject({ kind: "status" });
    expect(
      await value("design_library", {
        environmentId: "local",
        query: { search: "typ" },
      }),
    ).toMatchObject({
      entries: [{ id: created.canvasId, name: "Typed" }],
      total: 1,
    });
    // Other environments see nothing; failures are typed, never thrown.
    expect(
      await value("design_snapshot", {
        environmentId: "container",
        canvasId: created.canvasId,
      }),
    ).toMatchObject({
      kind: "missing",
    });
    expect(
      await typed("design_snapshot", {
        environmentId: "missing",
        canvasId: created.canvasId,
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "not-found" },
    });
    expect(
      await typed("design_prepare", {
        environmentId: "local",
        descriptor: { canvasId: created.canvasId, input: { kind: "nope" } },
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await typed("design_execute", {
        environmentId: "container",
        canvasId: created.canvasId,
        token: prepared.token,
      }),
    ).toMatchObject({ ok: false, failure: { code: "not-found" } });
  });

  test("the intent queue is shared by every client through typed commands", async () => {
    expect(await value("design_capabilities", {})).toMatchObject({ intents: true });
    const canvas = await design.create("local", "Intents", undefined, "user");
    const descriptor = {
      canvasId: canvas.id,
      input: { kind: "create_frame", frame },
      preconditions: { canvasRevision: 1 },
      clientId: "tab-a",
      correlationId: "i-1",
    };
    const draft = { id: "i-1", lane: "canvas", label: "Add frame", createdAt: 1, descriptor };
    expect(
      await value("design_intent_save", {
        environmentId: "local",
        canvasId: canvas.id,
        clientId: "tab-a",
        drafts: [draft],
      }),
    ).toEqual({ saved: ["i-1"] });
    // Another client lists the unsent draft.
    expect(
      await value<{ intents: unknown[] }>("design_intents", {
        environmentId: "local",
        canvasId: canvas.id,
      }),
    ).toMatchObject({ intents: [{ id: "i-1", phase: "draft", clientId: "tab-a" }] });
    const run = await value<{ status: DesignOperationStatus }>("design_intent_run", {
      environmentId: "local",
      canvasId: canvas.id,
      intent: draft,
      waitMs: 5000,
    });
    expect(run.status.state).toBe("committed");
    expect(
      await value("design_intent_discard", {
        environmentId: "local",
        canvasId: canvas.id,
        intentId: "i-1",
      }),
    ).toEqual({ discarded: true, mayStillFinish: false });
    expect(
      await typed("design_intents", { environmentId: "container", canvasId: canvas.id }),
    ).toMatchObject({ ok: false, failure: { code: "not-found" } });
  });

  test("design_open_file authorizes environments, validates paths and returns typed results", async () => {
    const canvas = await design.create("local", "Open file", undefined, "user");
    await value("design_export_save", {
      environmentId: "local",
      canvasId: canvas.id,
      relativePath: "designs/open.orkdes",
      revision: 1,
    });
    expect(
      await typed("design_open_file", {
        environmentId: "local",
        relativePath: "designs/open.orkdes",
      }),
    ).toEqual({ ok: true, value: { canvasId: canvas.id, imported: false } });
    expect(
      await typed("design_open_file", {
        environmentId: "missing",
        relativePath: "designs/open.orkdes",
      }),
    ).toMatchObject({ ok: false, failure: { code: "not-found" } });
    for (const relativePath of [
      "../open.orkdes",
      "open.ORKDES",
      "has space.orkdes",
      ".hidden/open.orkdes",
      "a/".repeat(8) + "open.orkdes",
      42,
    ])
      expect(
        await typed("design_open_file", {
          environmentId: "local",
          relativePath,
        }),
      ).toMatchObject({ ok: false, failure: { code: "invalid-input" } });
    expect(
      await typed("design_open_file", {
        environmentId: "local",
        relativePath: "missing.orkdes",
      }),
    ).toMatchObject({ ok: false, failure: { code: "not-found" } });
    expect(await design.list("container")).toEqual([]);
  });

  test("v2 export, history and lifecycle commands", async () => {
    const canvas = await design.create("local", "Exported", undefined, "user");
    const { frame: created } = await design.createFrame(canvas.id, "local", 1, frame, "user");
    const preview = await value<{
      suggestedPath: string;
      target: { exists: boolean };
    }>("design_export_preview", {
      environmentId: "local",
      canvasId: canvas.id,
    });
    expect(preview.target.exists).toBe(false);
    const receipt = await value<{
      relativePath: string;
      revision: number;
      digest: string;
    }>("design_export_save", {
      environmentId: "local",
      canvasId: canvas.id,
      relativePath: preview.suggestedPath,
      revision: 2,
    });
    expect(receipt).toMatchObject({
      relativePath: preview.suggestedPath,
      revision: 2,
    });
    expect(
      await typed("design_export_save", {
        environmentId: "local",
        canvasId: canvas.id,
        relativePath: preview.suggestedPath,
        revision: 2,
      }),
    ).toMatchObject({ ok: false, failure: { code: "export-collision" } });
    expect(
      await value<unknown>("design_export_reconcile", {
        environmentId: "local",
        canvasId: canvas.id,
      }),
    ).toEqual({
      state: "none",
    });
    const history = await value<{ entries: Array<{ id: string }> }>("design_history", {
      environmentId: "local",
      canvasId: canvas.id,
    });
    expect(history.entries).toHaveLength(1);
    expect(
      await value("design_checkpoint", {
        environmentId: "local",
        canvasId: canvas.id,
        entryId: history.entries[0]!.id,
        side: "after",
      }),
    ).toMatchObject({ frames: [{ frameId: created.id }] });
    expect(
      await value("design_validate", {
        environmentId: "local",
        canvasId: canvas.id,
        frameId: created.id,
      }),
    ).toMatchObject({ state: "valid" });
    expect(
      await value("design_capture", {
        environmentId: "local",
        canvasId: canvas.id,
        frameId: created.id,
      }),
    ).toMatchObject({ mimeType: "image/png", revision: 1 });
    const link = await value<{ id: string }>("design_session_link", {
      environmentId: "local",
      canvasId: canvas.id,
      link: { tabId: "tab-1", platform: "claude", role: "design" },
    });
    expect(
      await value<unknown>("design_session_unlink", {
        environmentId: "local",
        canvasId: canvas.id,
        linkId: link.id,
      }),
    ).toEqual({
      unlinked: true,
    });
    expect(
      await typed("design_purge", {
        environmentId: "local",
        canvasId: canvas.id,
      }),
    ).toMatchObject({
      ok: false,
      failure: { code: "conflict" },
    });
    await design.delete(canvas.id, "local", "user");
    expect(
      await value<unknown>("design_purge", {
        environmentId: "local",
        canvasId: canvas.id,
      }),
    ).toEqual({ purged: true });
    expect(
      await value("design_snapshot", {
        environmentId: "local",
        canvasId: canvas.id,
      }),
    ).toMatchObject({
      kind: "missing",
    });
  });
  test("reports linked conversations from durable native-session records and resumes once", async () => {
    const canvas = (await invoke("design_action", {
      environmentId: "local",
      action: "create_canvas",
      input: { name: "Linked" },
    })) as DesignCanvas;
    const retain = (
      environmentId: string,
      agent: "claude" | "codex",
      tabId: string,
      providerSessionId: string,
    ) => {
      const logicalSessionKey = `env-${environmentId}:${tabId}`;
      return storage.getOrCreateNativeAgentSession(
        {
          key: nativeAgentSessionStorageKey(environmentId, agent, logicalSessionKey),
          environmentId,
          agent,
          logicalSessionKey,
        },
        async () => providerSessionId,
      );
    };
    const open = await value<{ id: string }>("design_session_link", {
      environmentId: "local",
      canvasId: canvas.id,
      link: { tabId: "design-chat-1", platform: "claude", role: "design" },
    });
    const closed = await value<{ id: string }>("design_session_link", {
      environmentId: "local",
      canvasId: canvas.id,
      // Recorded by tab teardown: Codex resumes its thread.
      link: { tabId: "design-chat-2", sessionId: "thread-2", platform: "codex", role: "design" },
    });
    // The first tab is open; the same tab id in another environment must never
    // answer for the second.
    await retain("local", "claude", "design-chat-1", "provider-1");
    await retain("container", "codex", "design-chat-2", "provider-elsewhere");

    const report = await value<{
      sessions: { id: string; sessionId?: string }[];
      states: { linkId: string; session: string }[];
    }>("design_session_link_states", { environmentId: "local", canvasId: canvas.id });
    expect(report.states).toEqual([
      { linkId: open.id, session: "retained" },
      { linkId: closed.id, session: "missing" },
    ]);

    // The ordinary native resume: the provider reopens the thread as a new live
    // session mapped to the resume tab.
    const resumeProjectionSession = mock(
      async (input: { environmentId: string; agent: "codex"; logicalSessionKey: string }) => {
        await retain(
          input.environmentId,
          input.agent,
          input.logicalSessionKey.split(":")[1]!,
          "live-2",
        );
        return null;
      },
    );
    context.nativeAgents = { resumeProjectionSession } as unknown as CommandContext["nativeAgents"];
    const resume = { environmentId: "local", canvasId: canvas.id, linkId: closed.id };
    const [first, second] = await Promise.all([
      value("design_session_resume", { ...resume, expectedTabId: "design-chat-2", tabId: "r-1" }),
      value("design_session_resume", { ...resume, expectedTabId: "design-chat-2", tabId: "r-1" }),
    ]);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      link: { tabId: "r-1", sessionId: "thread-2" },
      providerSessionId: "live-2",
    });
    expect(resumeProjectionSession).toHaveBeenCalledTimes(1);
    expect(resumeProjectionSession.mock.calls[0]?.[0]).toMatchObject({
      environmentId: "local",
      agent: "codex",
      logicalSessionKey: "env-local:r-1",
      providerSessionId: "thread-2",
    });
    expect(
      await typed("design_session_resume", {
        ...resume,
        expectedTabId: "design-chat-2",
        tabId: "r-2",
      }),
    ).toMatchObject({ ok: false, failure: { code: "conflict" } });
    expect(
      await typed("design_session_link_states", { environmentId: "missing", canvasId: canvas.id }),
    ).toMatchObject({ ok: false, failure: { code: "not-found" } });
  });
});
