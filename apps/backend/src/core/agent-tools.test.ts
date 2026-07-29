import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ): Promise<{ response: Response; body: RpcResponse }> {
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
    };
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
      .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
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

    const oversized = await fetch(connection.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(512 * 1024) }),
    });
    expect(oversized.status).toBe(413);
  });
});
