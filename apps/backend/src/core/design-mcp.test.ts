import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolsServer } from "./agent-tools.js";
import { StorageService } from "./storage.js";
import { DesignService } from "./design-service.js";
import { createTestRenderer, trackUnhandledRejections } from "./design-test-support.js";

describe("design MCP", () => {
  let dir: string;
  let worktree: string;
  let storage: StorageService;
  let design: DesignService;
  let server: AgentToolsServer;
  const rejections = trackUnhandledRejections();
  const environmentId = "env-design";
  const projectId = "project";

  beforeEach(async () => {
    rejections.install();
    dir = await mkdtemp(join(tmpdir(), "ork-design-mcp-"));
    worktree = await mkdtemp(join(tmpdir(), "ork-design-mcp-repo-"));
    storage = new StorageService(dir);
    design = new DesignService(dir, () => {}, createTestRenderer());
    server = new AgentToolsServer(storage, "127.0.0.1", undefined, design);
    await storage.init();
    await storage.addProject({
      id: projectId,
      name: "Test",
      gitUrl: "https://github.com/example/test",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    await storage.addEnvironment({
      id: environmentId,
      projectId,
      name: "Design",
      branch: "design",
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
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
    await design.close();
    await rm(dir, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  const client = () => {
    const connection = server.connection(environmentId, projectId, "host");
    const rpc = async (path: string, token: string, method: string, params?: unknown) => {
      const response = await fetch(new URL(path, connection.url), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = await response.text();
      const data = response.headers.get("content-type")?.includes("text/event-stream")
        ? body
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6)
        : body;
      return { status: response.status, body: data ? JSON.parse(data) : {} };
    };
    /** Calls a design tool; returns the parsed JSON text (or the raw error text). */
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await rpc("/design-mcp", connection.token, "tools/call", {
        name,
        arguments: args,
      });
      expect(result.status).toBe(200);
      const text = result.body.result.content[0].text as string;
      if (result.body.result.isError) return { error: true as const, text };
      return { error: false as const, text, value: JSON.parse(text) };
    };
    return { connection, rpc, call };
  };

  test("has a separate tool inventory, authentication and environment boundary", async () => {
    const disabledConnection = server.connection(environmentId, projectId, "host");
    expect(disabledConnection.design).toBeUndefined();
    expect(
      (
        await fetch(new URL("/design-mcp", disabledConnection.url), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${disabledConnection.token}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    await design.create(environmentId, "Workspace");
    const { connection, rpc } = client();
    expect(connection.design).toBe(true);
    expect((await rpc("/design-mcp", "bad", "tools/list")).status).toBe(401);
    const tools = (await rpc("/design-mcp", connection.token, "tools/list")).body.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        "capture_frame",
        "set_element_styles",
        "submit_operation",
        "save_canvas",
      ]),
    );
    expect(tools).not.toContain("send_message");
    const existing = (await rpc("/mcp", connection.token, "tools/list")).body.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(existing).not.toContain("create_canvas");
    const foreign = await design.create("foreign-environment");
    const denied = await rpc("/design-mcp", connection.token, "tools/call", {
      name: "get_canvas",
      arguments: { canvasId: foreign.id },
    });
    expect(denied.body).toMatchObject({ result: { isError: true } });

    const originalList = design.list.bind(design);
    let release!: () => void;
    let started = 0;
    let markAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    design.list = async (environment) => {
      started++;
      if (started === 16) markAllStarted();
      await blocked;
      return originalList(environment);
    };
    const inFlight = Array.from({ length: 16 }, () =>
      rpc("/design-mcp", connection.token, "tools/call", { name: "list_canvases", arguments: {} }),
    );
    await allStarted;
    expect(
      (
        await rpc("/design-mcp", connection.token, "tools/call", {
          name: "list_canvases",
          arguments: {},
        })
      ).status,
    ).toBe(429);
    release();
    expect((await Promise.all(inFlight)).every((result) => result.status === 200)).toBe(true);
    design.list = async () => {
      throw new Error("injected list failure");
    };
    expect(
      (
        await rpc("/design-mcp", connection.token, "tools/call", {
          name: "list_canvases",
          arguments: {},
        })
      ).body.result.isError,
    ).toBe(true);
    design.list = originalList;
    expect(
      (
        await rpc("/design-mcp", connection.token, "tools/call", {
          name: "list_canvases",
          arguments: {},
        })
      ).status,
    ).toBe(200);
    server.revokeEnvironment(environmentId);
    expect((await rpc("/design-mcp", connection.token, "tools/list")).status).toBe(401);
  });

  test("submit_operation is idempotent by correlationId and acts as the agent", async () => {
    const canvas = await design.create(environmentId, "Agent work", undefined, "user");
    const { frame } = await design.createFrame(
      canvas.id,
      environmentId,
      1,
      { name: "Card", x: 0, y: 0, width: 300, height: 200, html: "<h1>Card</h1>" },
      "user",
    );
    const { call } = client();
    const descriptor = {
      canvasId: canvas.id,
      input: { kind: "update_frame", frameId: frame.id, patch: { x: 42 } },
      preconditions: { frameRevision: 1 },
      correlationId: "agent-move-1",
    };
    const first = await call("submit_operation", descriptor);
    expect(first.error).toBe(false);
    if (first.error) return;
    expect(first.value).toMatchObject({
      state: "committed",
      canvasRevision: 3,
      frames: [{ frameId: frame.id, revision: 2 }],
    });
    // A retry after a lost response returns the original outcome without new work.
    const retry = await call("submit_operation", descriptor);
    expect(retry.error ? retry.text : retry.value).toEqual(first.value);
    expect((await design.get(canvas.id, environmentId)).revision).toBe(3);
    // Reusing a settled correlation id never runs new work: it reports the original receipt.
    const changed = await call("submit_operation", {
      ...descriptor,
      input: { ...descriptor.input, patch: { x: 7 } },
    });
    expect(changed.error ? changed.text : changed.value).toEqual(first.value);
    expect((await design.getFrame(canvas.id, environmentId, frame.id)).x).toBe(42);
    expect((await design.get(canvas.id, environmentId)).revision).toBe(3);
    const found = await call("find_operation", {
      canvasId: canvas.id,
      correlationId: "agent-move-1",
    });
    expect(found.error ? found.text : found.value).toEqual(first.value);
    const status = await call("operation_status", {
      canvasId: canvas.id,
      token: (first.value as { token: string }).token,
    });
    expect(status.error ? status.text : status.value).toEqual(first.value);
    expect(
      await call("submit_operation", { ...descriptor, correlationId: undefined }),
    ).toMatchObject({ error: true });
    // Creates reconcile by correlation id too: a retry never makes a second canvas.
    const create = {
      input: { kind: "create_canvas", name: "From agent" },
      correlationId: "agent-create-1",
    };
    const createdA = await call("submit_operation", create);
    const createdB = await call("submit_operation", create);
    if (createdA.error) throw new Error(createdA.text);
    expect(createdA.value).toMatchObject({
      state: "committed",
      createdCanvasId: expect.any(String),
    });
    expect(createdB.error ? createdB.text : createdB.value).toEqual(createdA.value);
    expect(
      (await design.list(environmentId)).filter((entry) => entry.name === "From agent"),
    ).toHaveLength(1);
    // The edit is attributed to the agent.
    expect(await design.historyStatus(canvas.id, environmentId, "agent")).toMatchObject({
      undoCount: 1,
    });
    expect(await design.historyStatus(canvas.id, environmentId, "user")).toMatchObject({
      undoCount: 1,
    });
  });

  test("compact responses omit HTML while full responses keep the legacy shape", async () => {
    const canvas = await design.create(environmentId, "Compact");
    const { call } = client();
    const html = "<main><h1>Big heading</h1><p>Paragraph</p></main>";
    const full = await call("create_frame", {
      canvasId: canvas.id,
      expectedRevision: 1,
      name: "Frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      html,
    });
    if (full.error) throw new Error(full.text);
    expect(full.value).toMatchObject({ canvasRevision: 2, frame: { html, revision: 1 } });
    const frameId = (full.value as { frame: { id: string } }).frame.id;
    const compact = await call("set_element_styles", {
      canvasId: canvas.id,
      frameId,
      expectedRevision: 1,
      selector: "h1",
      styles: { color: "red" },
      response: "compact",
    });
    if (compact.error) throw new Error(compact.text);
    expect(compact.value).toMatchObject({
      state: "committed",
      canvasRevision: 3,
      frames: [{ frameId, revision: 2 }],
    });
    expect(compact.text).not.toContain("<h1");
    expect(compact.text).not.toContain("Paragraph");
    const noop = await call("set_element_styles", {
      canvasId: canvas.id,
      frameId,
      expectedRevision: 2,
      selector: "h1",
      styles: { color: "red" },
      response: "compact",
    });
    expect(noop.error ? noop.text : noop.value).toMatchObject({
      state: "no-op",
      unchangedProperties: ["color"],
    });
    expect((await design.get(canvas.id, environmentId)).revision).toBe(3);
    const summary = await call("get_canvas_summary", { canvasId: canvas.id });
    if (summary.error) throw new Error(summary.text);
    expect(summary.text).not.toContain("<h1");
    expect(summary.value).toMatchObject({
      revision: 3,
      frames: [{ id: frameId, revision: 2, validation: "valid" }],
    });
    const stale = await call("replace_frame_html", {
      canvasId: canvas.id,
      frameId,
      expectedRevision: 1,
      html: "<p>stale</p>",
      response: "compact",
    });
    expect(stale.error).toBe(true);
    expect(stale.text).toStartWith("Design revision conflict:");
    expect(stale.text).toContain('"code":"conflict"');
  });

  test("save_canvas never overwrites without the observed fingerprint", async () => {
    const first = await design.create(environmentId, "First");
    const second = await design.create(environmentId, "Second");
    const { call } = client();
    const saved = await call("save_canvas", {
      canvasId: first.id,
      expectedRevision: 1,
      filePath: "design.orkdes",
    });
    if (saved.error) throw new Error(saved.text);
    expect(saved.value).toMatchObject({
      relativePath: "design.orkdes",
      revision: 1,
      replaced: false,
    });
    expect(saved.text).not.toContain('"frames"');
    const collision = await call("save_canvas", {
      canvasId: second.id,
      expectedRevision: 1,
      filePath: "design.orkdes",
    });
    expect(collision.error).toBe(true);
    expect(collision.text).toContain("export-collision");
    const fingerprint = /"replaceFingerprint":"(sha256:[0-9a-f]{64})"/.exec(collision.text)?.[1];
    expect(fingerprint).toBe((saved.value as { digest: string }).digest);
    expect(JSON.parse(await readFile(join(worktree, "design.orkdes"), "utf8"))).toMatchObject({
      id: first.id,
    });
    const replaced = await call("save_canvas", {
      canvasId: second.id,
      expectedRevision: 1,
      filePath: "design.orkdes",
      replaceFingerprint: fingerprint,
    });
    if (replaced.error) throw new Error(replaced.text);
    expect(replaced.value).toMatchObject({ replaced: true, revision: 1 });
    expect(JSON.parse(await readFile(join(worktree, "design.orkdes"), "utf8"))).toMatchObject({
      id: second.id,
    });
    const escape = await call("save_canvas", {
      canvasId: first.id,
      expectedRevision: 1,
      filePath: "../out.orkdes",
    });
    expect(escape.error).toBe(true);
    expect((await readdir(worktree)).sort()).toEqual(["design.orkdes"]);
  });
});
