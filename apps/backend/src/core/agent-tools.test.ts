import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client as McpClient,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { AgentToolsServer } from "./agent-tools.js";
import { StorageService } from "./storage.js";

type RpcResponse = {
  result?: {
    tools?: Array<{
      name: string;
      annotations?: Record<string, boolean>;
    }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  error?: { message?: string };
};

type RpcCall = {
  response: Response;
  body: RpcResponse;
  rawText: string;
};

describe("agent Kanban tools", () => {
  let dataDir: string;
  let storage: StorageService;
  let server: AgentToolsServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-agent-tools-"));
    storage = new StorageService(dataDir);
    await storage.init();
    server = new AgentToolsServer(storage, "127.0.0.1");
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function rpc(
    url: string,
    token: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<RpcCall> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        ...(params ? { params } : {}),
      }),
    });
    const text = await response.text();
    const payload = response.headers.get("content-type")?.startsWith(
      "text/event-stream",
    )
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length)
      : text;
    return {
      response,
      body: payload ? JSON.parse(payload) as RpcResponse : {},
      rawText: text,
    };
  }

  async function rawRequest(
    url: string,
    token: string,
    options: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      chunks?: string[];
    } = {},
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
    const target = new URL(url);
    return await new Promise((resolve, reject) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: options.path ?? target.pathname,
        method: options.method ?? "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...options.headers,
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
        }));
      });
      request.once("error", reject);
      for (const chunk of options.chunks ?? []) request.write(chunk);
      request.end();
    });
  }

  test("publishes bounded read and write tools with accurate annotations", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const listed = await rpc(connection.url, connection.token, "tools/list");

    expect(listed.response.status).toBe(200);
    expect(listed.body.result?.tools?.map((tool) => tool.name)).toEqual([
      "list_tickets",
      "get_ticket",
      "create_ticket",
      "update_ticket",
      "add_ticket_comment",
    ]);
    expect(listed.body.result?.tools?.find((tool) => tool.name === "get_ticket")?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(listed.body.result?.tools?.find((tool) => tool.name === "update_ticket")?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  test("negotiates MCP 2026-07-28 while retaining the legacy endpoint", async () => {
    const connection = server.connection("env-modern", "project-modern", "host");
    const client = new McpClient(
      { name: "orkestrator-modern-contract", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(connection.url),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${connection.token}` },
        },
      },
    );

    try {
      await client.connect(transport);
      expect(client.getProtocolEra()).toBe("modern");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "list_tickets",
        "get_ticket",
        "create_ticket",
        "update_ticket",
        "add_ticket_comment",
      ]);
    } finally {
      await client.close();
    }
  });

  test("creates, reads, updates, comments on, and paginates project tickets", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const changes: Array<{ resource: string; id: string }> = [];
    storage.setResourceChangeListener((change) => changes.push(change));

    const created = await rpc(connection.url, connection.token, "tools/call", {
      name: "create_ticket",
      arguments: {
        title: "  Agent tools  ",
        description: "Let agents maintain the board.",
        acceptanceCriteria: "Reads and writes are project scoped.",
        status: "in-progress",
      },
    });
    const ticket = created.body.result?.structuredContent?.ticket as {
      id: string;
      title: string;
      status: string;
    };
    expect(ticket).toMatchObject({
      title: "Agent tools",
      status: "in-progress",
    });

    const updated = await rpc(connection.url, connection.token, "tools/call", {
      name: "update_ticket",
      arguments: { ticketId: ticket.id, status: "review" },
    });
    expect(
      (updated.body.result?.structuredContent?.ticket as { status: string }).status,
    ).toBe("review");

    const commented = await rpc(connection.url, connection.token, "tools/call", {
      name: "add_ticket_comment",
      arguments: { ticketId: ticket.id, text: "Implementation complete." },
    });
    expect(
      (commented.body.result?.structuredContent?.ticket as {
        comments: Array<{ text: string }>;
      }).comments,
    ).toEqual([expect.objectContaining({ text: "Implementation complete." })]);

    const read = await rpc(connection.url, connection.token, "tools/call", {
      name: "get_ticket",
      arguments: { ticketId: ticket.id },
    });
    expect(read.body.result?.structuredContent?.ticket).toMatchObject({
      id: ticket.id,
      acceptanceCriteria: "Reads and writes are project scoped.",
      status: "review",
    });

    const listed = await rpc(connection.url, connection.token, "tools/call", {
      name: "list_tickets",
      arguments: { status: "review", limit: 1, offset: 0 },
    });
    expect(listed.body.result?.structuredContent).toMatchObject({
      total: 1,
      hasMore: false,
      tickets: [expect.objectContaining({ id: ticket.id, commentCount: 1 })],
    });
    expect(changes).toHaveLength(3);
    expect(changes.every((change) =>
      change.resource === "kanban" && change.id === "project-1"
    )).toBe(true);
  });

  test("paginates ticket lists and comments across later pages", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const tickets = await Promise.all([
      storage.addKanbanTask("project-1", "First", ""),
      storage.addKanbanTask("project-1", "Second", ""),
      storage.addKanbanTask("project-1", "Third", ""),
    ]);
    for (let index = 0; index < 12; index += 1) {
      await storage.addKanbanComment(tickets[0]!.id, `Comment ${index}`);
    }

    const firstPage = await rpc(connection.url, connection.token, "tools/call", {
      name: "list_tickets",
      arguments: { offset: 0, limit: 2 },
    });
    expect(firstPage.body.result?.structuredContent).toMatchObject({
      total: 3,
      hasMore: true,
      tickets: [{ id: tickets[0]!.id }, { id: tickets[1]!.id }],
    });
    const secondPage = await rpc(connection.url, connection.token, "tools/call", {
      name: "list_tickets",
      arguments: { offset: 2, limit: 2 },
    });
    expect(secondPage.body.result?.structuredContent).toMatchObject({
      total: 3,
      hasMore: false,
      tickets: [{ id: tickets[2]!.id }],
    });

    const comments = await rpc(connection.url, connection.token, "tools/call", {
      name: "get_ticket",
      arguments: { ticketId: tickets[0]!.id, commentOffset: 10, commentLimit: 2 },
    });
    expect(comments.body.result?.structuredContent?.ticket).toMatchObject({
      commentCount: 12,
      commentOffset: 10,
      commentLimit: 2,
      hasMoreComments: false,
      comments: [{ text: "Comment 10" }, { text: "Comment 11" }],
    });
  });

  test("rejects schema boundaries and an update with no editable fields", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const ticket = await storage.addKanbanTask("project-1", "Valid", "");
    const invalidCalls = [
      { name: "create_ticket", arguments: { title: "" } },
      { name: "create_ticket", arguments: { title: "x".repeat(501) } },
      {
        name: "create_ticket",
        arguments: { title: "Valid", description: "x".repeat(100_001) },
      },
      { name: "create_ticket", arguments: { title: "Valid", status: "invalid" } },
      { name: "get_ticket", arguments: { ticketId: "", commentLimit: 1 } },
      { name: "get_ticket", arguments: { ticketId: ticket.id, commentLimit: 11 } },
      { name: "list_tickets", arguments: { offset: -1 } },
      { name: "list_tickets", arguments: { limit: 201 } },
      { name: "update_ticket", arguments: { ticketId: ticket.id } },
      {
        name: "add_ticket_comment",
        arguments: { ticketId: ticket.id, text: "x".repeat(20_001) },
      },
    ];
    for (const call of invalidCalls) {
      const result = await rpc(connection.url, connection.token, "tools/call", call);
      expect(result.body.result?.isError).toBe(true);
    }

    const boundary = await rpc(connection.url, connection.token, "tools/call", {
      name: "create_ticket",
      arguments: {
        title: "x".repeat(500),
        description: "x".repeat(100_000),
        acceptanceCriteria: "x".repeat(100_000),
      },
    });
    expect(boundary.body.result?.isError).not.toBe(true);
  });

  test("keeps credentials project scoped and revokes them with the environment", async () => {
    const projectOne = server.connection("env-1", "project-1", "host");
    const projectTwo = server.connection("env-2", "project-2", "host");
    const projectTwoFromContainer = server.connection(
      "env-2",
      "project-2",
      "container",
    );
    const hidden = await storage.addKanbanTask("project-2", "Other project", "secret");

    expect(projectTwoFromContainer.url).toStartWith("http://host.docker.internal:");
    expect(projectTwoFromContainer.token).toBe(projectTwo.token);

    const crossProjectRead = await rpc(projectOne.url, projectOne.token, "tools/call", {
      name: "get_ticket",
      arguments: { ticketId: hidden.id },
    });
    expect(crossProjectRead.body.result?.isError).toBe(true);
    expect(crossProjectRead.body.result?.content?.[0]?.text).toContain(
      "not found in this project",
    );

    const ownProjectRead = await rpc(projectTwo.url, projectTwo.token, "tools/call", {
      name: "get_ticket",
      arguments: { ticketId: hidden.id },
    });
    expect(ownProjectRead.body.result?.structuredContent?.ticket).toMatchObject({
      id: hidden.id,
    });

    for (const mutation of [
      { name: "update_ticket", arguments: { ticketId: hidden.id, title: "Leaked" } },
      { name: "add_ticket_comment", arguments: { ticketId: hidden.id, text: "Leaked" } },
    ]) {
      const result = await rpc(projectOne.url, projectOne.token, "tools/call", mutation);
      expect(result.body.result?.isError).toBe(true);
    }
    expect((await storage.getKanbanTasks("project-2"))[0]).toMatchObject({
      title: "Other project",
      comments: [],
    });

    server.revokeEnvironment("env-1");
    const revoked = await rpc(projectOne.url, projectOne.token, "tools/list");
    expect(revoked.response.status).toBe(401);
    expect(revoked.response.headers.get("www-authenticate")).toContain("Bearer");

    const reScoped = server.connection("env-2", "project-3", "host");
    expect(reScoped.token).not.toBe(projectTwo.token);
    const staleScope = await rpc(projectTwo.url, projectTwo.token, "tools/list");
    expect(staleScope.response.status).toBe(401);
    expect((await rpc(reScoped.url, reScoped.token, "tools/list")).response.status)
      .toBe(200);
  });

  test("rejects invalid credentials, malformed JSON, and oversized bodies", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const unauthorized = await fetch(connection.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer invalid-invalid-invalid-invalid",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const malformed = await fetch(connection.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const declaredOversized = await fetch(connection.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(512 * 1024) }),
    });
    expect(declaredOversized.status).toBe(413);

  });

  test("returns 404 and 405 at the HTTP boundary", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const missing = await rawRequest(connection.url, connection.token, {
      path: "/missing",
    });
    expect(missing.status).toBe(404);

    const wrongMethod = await rawRequest(connection.url, connection.token, {
      method: "GET",
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("POST");
  });

  test("surfaces storage errors as tool failures without killing the listener", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const original = storage.getKanbanTasks.bind(storage);
    storage.getKanbanTasks = async () => {
      throw new Error("injected storage failure");
    };
    const failed = await rpc(connection.url, connection.token, "tools/call", {
      name: "list_tickets",
      arguments: {},
    });
    expect(failed.response.status).toBe(200);
    expect(failed.body.result?.isError).toBe(true);
    expect(failed.body.result?.content?.[0]?.text).toContain("injected storage failure");

    storage.getKanbanTasks = original;
    const recovered = await rpc(connection.url, connection.token, "tools/call", {
      name: "list_tickets",
      arguments: {},
    });
    expect(recovered.body.result?.isError).not.toBe(true);
  });

  test("serializes lifecycle calls and recovers from bind failures", async () => {
    await Promise.all([server.start(), server.start()]);
    const first = server.connection("env-1", "project-1", "host");
    expect((await rpc(first.url, first.token, "tools/list")).response.status).toBe(200);

    await Promise.all([server.stop(), server.stop()]);
    expect(() => server.connection("env-1", "project-1", "host")).toThrow(
      "not running",
    );
    await server.start();
    const restarted = server.connection("env-1", "project-1", "host");
    expect((await rpc(restarted.url, restarted.token, "tools/list")).response.status)
      .toBe(200);

    const invalid = new AgentToolsServer(storage, "not-a-bind-address.invalid");
    await expect(invalid.start()).rejects.toThrow();
    await expect(invalid.stop()).resolves.toBeUndefined();
  });

  test("keeps an authenticated in-flight read stable across revocation", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const original = storage.getKanbanTasks.bind(storage);
    let releaseRead!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    storage.getKanbanTasks = async (projectId) => {
      markStarted();
      await blocked;
      return await original(projectId);
    };

    const inFlight = rpc(connection.url, connection.token, "tools/call", {
      name: "list_tickets",
      arguments: {},
    });
    await started;
    server.revokeEnvironment("env-1");
    releaseRead();
    expect((await inFlight).response.status).toBe(200);
    expect((await rpc(connection.url, connection.token, "tools/list")).response.status)
      .toBe(401);
    storage.getKanbanTasks = original;
  });

  test("preserves concurrent comment writes", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const ticket = await storage.addKanbanTask("project-1", "Concurrent", "");
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      rpc(connection.url, connection.token, "tools/call", {
        name: "add_ticket_comment",
        arguments: { ticketId: ticket.id, text: `Comment ${index}` },
      })
    ));

    const saved = (await storage.getKanbanTasks("project-1"))[0]!;
    expect(saved.comments).toHaveLength(12);
    expect(new Set(saved.comments.map((comment) => comment.text)).size).toBe(12);
  });

  test("bounds large ticket responses and does not duplicate full content", async () => {
    const connection = server.connection("env-1", "project-1", "host");
    const marker = "unique-large-description-marker";
    const ticket = await storage.addKanbanTask(
      "project-1",
      "😀".repeat(500),
      marker + "\0".repeat(100_000),
      { acceptanceCriteria: "\0".repeat(100_000) },
    );
    for (let index = 0; index < 12; index += 1) {
      await storage.addKanbanComment(ticket.id, "\0".repeat(20_000));
    }

    const result = await rpc(connection.url, connection.token, "tools/call", {
      name: "get_ticket",
      arguments: { ticketId: ticket.id, commentLimit: 10 },
    });
    expect(Buffer.byteLength(result.rawText, "utf8")).toBeLessThan(512 * 1024);
    expect(result.rawText.split(marker)).toHaveLength(2);
    expect(result.body.result?.structuredContent?.ticket).toMatchObject({
      commentCount: 12,
      hasMoreComments: true,
      descriptionTruncated: true,
      acceptanceCriteriaTruncated: true,
    });
    const returnedComments = (
      result.body.result?.structuredContent?.ticket as {
        comments: Array<{ textTruncated?: boolean }>;
      }
    ).comments;
    expect(returnedComments).toHaveLength(10);
    expect(returnedComments.every((comment) => comment.textTruncated)).toBe(true);
  });
});
