import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentToolsServer } from "./agent-tools.js";
import { StorageService } from "./storage.js";
import { DesignService } from "./design-service.js";

test("design MCP has a separate tool inventory, authentication and environment boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ork-design-mcp-"));
  const storage = new StorageService(dir);
  const design = new DesignService(dir, () => {});
  const server = new AgentToolsServer(storage, "127.0.0.1", undefined, design);
  try {
    await storage.init();
    const project = await storage.addProject({
      id: "project",
      name: "Test",
      gitUrl: "https://github.com/example/test",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    const environment = await storage.addEnvironment({
      id: "env-design",
      projectId: project.id,
      name: "Design",
      branch: "design",
      environmentType: "local",
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
    const disabledConnection = server.connection(environment.id, project.id, "host");
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
    await design.create(environment.id, "Workspace");
    const connection = server.connection(environment.id, project.id, "host");
    expect(connection.design).toBe(true);
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
    expect((await rpc("/design-mcp", "bad", "tools/list")).status).toBe(401);
    const tools = (await rpc("/design-mcp", connection.token, "tools/list")).body.result.tools.map(
      (tool: { name: string }) => tool.name,
    );
    expect(tools).toContain("capture_frame");
    expect(tools).toContain("set_element_styles");
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
    design.list = async (environmentId) => {
      started++;
      if (started === 16) markAllStarted();
      await blocked;
      return originalList(environmentId);
    };
    const inFlight = Array.from({ length: 16 }, () =>
      rpc("/design-mcp", connection.token, "tools/call", {
        name: "list_canvases",
        arguments: {},
      }),
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
    server.revokeEnvironment(environment.id);
    expect((await rpc("/design-mcp", connection.token, "tools/list")).status).toBe(401);
  } finally {
    await server.stop();
    await design.close();
    await rm(dir, { recursive: true, force: true });
  }
});
