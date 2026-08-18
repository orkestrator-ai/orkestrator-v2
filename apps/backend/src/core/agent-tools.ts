import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { KanbanStatus, KanbanTask, StorageService } from "./storage.js";

const MAX_MCP_REQUEST_BYTES = 512 * 1024;
const MAX_TITLE_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 100_000;
const MAX_COMMENT_LENGTH = 20_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const DEFAULT_COMMENT_LIMIT = 10;
const MAX_COMMENT_LIMIT = 10;
const MAX_TITLE_OUTPUT_BYTES = 1024;
const MAX_DESCRIPTION_OUTPUT_BYTES = 96 * 1024;
const MAX_COMMENT_OUTPUT_BYTES = 24 * 1024;
const AGENT_MCP_PATH = "/mcp";

export const ORKESTRATOR_AGENT_MCP_URL_ENV = "ORKESTRATOR_AGENT_MCP_URL";
export const ORKESTRATOR_AGENT_MCP_TOKEN_ENV = "ORKESTRATOR_AGENT_MCP_TOKEN";
export const ORKESTRATOR_AGENT_MCP_SERVER_NAME = "orkestrator";

export type AgentToolConnection = {
  url: string;
  token: string;
};

type AgentToolScope = {
  environmentId: string;
  projectId: string;
};

type StoredCredential = AgentToolScope & {
  token: string;
};

class RequestBodyTooLargeError extends Error {}
class InvalidJsonBodyError extends Error {}

function credentialDigest(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function bearerToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization || Array.isArray(authorization)) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
  return match?.[1] ?? null;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_REQUEST_BYTES) {
    request.resume();
    throw new RequestBodyTooLargeError("MCP request body is too large");
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > MAX_MCP_REQUEST_BYTES) {
      request.resume();
      throw new RequestBodyTooLargeError("MCP request body is too large");
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  } catch {
    throw new InvalidJsonBodyError("MCP request body must be valid JSON");
  }
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function ticketSummary(task: KanbanTask): Record<string, unknown> {
  const title = boundedJsonString(task.title, MAX_TITLE_OUTPUT_BYTES);
  return {
    id: task.id,
    title: title.value,
    status: task.status,
    order: task.order,
    createdAt: task.createdAt,
    commentCount: task.comments.length,
    imageCount: task.images.length,
    ...(task.environmentId ? { environmentId: task.environmentId } : {}),
    ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    ...(task.prState ? { prState: task.prState } : {}),
    ...(title.truncated ? { titleTruncated: true } : {}),
  };
}

function boundedJsonString(
  value: string,
  maxSerializedBytes: number,
): { value: string; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maxSerializedBytes) {
    return { value, truncated: false };
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxSerializedBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let end = low;
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff
  ) {
    end -= 1;
  }
  return { value: value.slice(0, end), truncated: true };
}

function ticketDetail(
  task: KanbanTask,
  commentOffset: number,
  commentLimit: number,
): Record<string, unknown> {
  const title = boundedJsonString(task.title, MAX_TITLE_OUTPUT_BYTES);
  const description = boundedJsonString(task.description, MAX_DESCRIPTION_OUTPUT_BYTES);
  const acceptanceCriteria = boundedJsonString(
    task.acceptanceCriteria,
    MAX_DESCRIPTION_OUTPUT_BYTES,
  );
  const comments = task.comments
    .slice(commentOffset, commentOffset + commentLimit)
    .map((comment) => {
      const text = boundedJsonString(comment.text, MAX_COMMENT_OUTPUT_BYTES);
      return {
        id: comment.id,
        text: text.value,
        createdAt: comment.createdAt,
        ...(text.truncated ? { textTruncated: true } : {}),
      };
    });

  return {
    ...ticketSummary(task),
    title: title.value,
    description: description.value,
    acceptanceCriteria: acceptanceCriteria.value,
    comments,
    commentOffset,
    commentLimit,
    hasMoreComments: commentOffset + comments.length < task.comments.length,
    ...(title.truncated ? { titleTruncated: true } : {}),
    ...(description.truncated ? { descriptionTruncated: true } : {}),
    ...(acceptanceCriteria.truncated ? { acceptanceCriteriaTruncated: true } : {}),
    ...(task.buildPipelineId ? { buildPipelineId: task.buildPipelineId } : {}),
  };
}

function toolResult(value: Record<string, unknown>, textSummary: Record<string, unknown> = value) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(textSummary) }],
    structuredContent: value,
  };
}

function ticketResult(task: KanbanTask, commentOffset = 0, commentLimit = DEFAULT_COMMENT_LIMIT) {
  return toolResult(
    { ticket: ticketDetail(task, commentOffset, commentLimit) },
    {
      ticket: ticketSummary(task),
      commentsReturned: Math.min(commentLimit, Math.max(0, task.comments.length - commentOffset)),
    },
  );
}

async function scopedTicket(
  storage: StorageService,
  projectId: string,
  ticketId: string,
): Promise<KanbanTask> {
  const task = (await storage.getKanbanTasks(projectId)).find(
    (candidate) => candidate.id === ticketId,
  );
  if (!task) throw new Error(`Kanban ticket not found in this project: ${ticketId}`);
  return task;
}

function createTicketServer(storage: StorageService, scope: AgentToolScope): McpServer {
  const server = new McpServer(
    { name: "orkestrator-kanban", version: "1.0.0" },
    {
      instructions:
        "Use these tools to read and maintain the current project's Kanban tickets. " +
        "Ticket IDs are project-scoped. Update only fields requested by the user, " +
        "and add a comment when durable implementation context should be preserved.",
    },
  );

  server.registerTool(
    "list_tickets",
    {
      title: "List Kanban tickets",
      description:
        "List summaries of Kanban tickets in the current project, optionally filtered by status.",
      inputSchema: z.object({
        status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ status, offset, limit }) => {
      const all = await storage.getKanbanTasks(scope.projectId);
      const filtered = status ? all.filter((task) => task.status === status) : all;
      const tickets = filtered.slice(offset, offset + limit).map(ticketSummary);
      return toolResult({
        tickets,
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + tickets.length < filtered.length,
      });
    },
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Read a Kanban ticket",
      description:
        "Read one Kanban ticket in the current project, including acceptance criteria and a paginated comment page.",
      inputSchema: z.object({
        ticketId: z.string().trim().min(1).max(200),
        commentOffset: z.number().int().min(0).default(0),
        commentLimit: z.number().int().min(1).max(MAX_COMMENT_LIMIT).default(DEFAULT_COMMENT_LIMIT),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, commentOffset, commentLimit }) => {
      const ticket = await scopedTicket(storage, scope.projectId, ticketId);
      return ticketResult(ticket, commentOffset, commentLimit);
    },
  );

  server.registerTool(
    "create_ticket",
    {
      title: "Create a Kanban ticket",
      description: "Create a Kanban ticket in the current project. New tickets default to backlog.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
        description: z.string().max(MAX_DESCRIPTION_LENGTH).default(""),
        acceptanceCriteria: z.string().max(MAX_DESCRIPTION_LENGTH).default(""),
        status: z.enum(["backlog", "in-progress", "review", "done"]).default("backlog"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ title, description, acceptanceCriteria, status }) => {
      const ticket = await storage.addKanbanTask(scope.projectId, title, description, {
        acceptanceCriteria,
        status,
      });
      return ticketResult(ticket);
    },
  );

  server.registerTool(
    "update_ticket",
    {
      title: "Update a Kanban ticket",
      description:
        "Update editable fields on a Kanban ticket in the current project. Omitted fields are unchanged.",
      inputSchema: z.object({
        ticketId: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(MAX_TITLE_LENGTH).optional(),
        description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
        acceptanceCriteria: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
        status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ ticketId, title, description, acceptanceCriteria, status }) => {
      await scopedTicket(storage, scope.projectId, ticketId);
      const updates: Partial<KanbanTask> = {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
        ...(status !== undefined ? { status: status as KanbanStatus } : {}),
      };
      if (Object.keys(updates).length === 0) {
        throw new Error("Provide at least one ticket field to update");
      }
      const ticket = await storage.updateKanbanTask(ticketId, updates, scope.projectId);
      return ticketResult(ticket);
    },
  );

  server.registerTool(
    "add_ticket_comment",
    {
      title: "Comment on a Kanban ticket",
      description: "Add a durable comment to a Kanban ticket in the current project.",
      inputSchema: z.object({
        ticketId: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(MAX_COMMENT_LENGTH),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ ticketId, text }) => {
      await scopedTicket(storage, scope.projectId, ticketId);
      const ticket = await storage.addKanbanComment(ticketId, text, scope.projectId);
      const commentOffset = Math.max(0, ticket.comments.length - DEFAULT_COMMENT_LIMIT);
      return ticketResult(ticket, commentOffset);
    },
  );

  return server;
}

/**
 * Backend-owned MCP surface for agents.
 *
 * Credentials are random, environment-scoped, and retained only in this
 * process. A bridge receives access to its environment's project, never the
 * general renderer gateway token or a caller-selectable project id.
 */
export class AgentToolsServer {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly credentialsByEnvironment = new Map<string, StoredCredential>();
  private readonly scopesByDigest = new Map<string, AgentToolScope>();
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: StorageService,
    private readonly bindAddress = "0.0.0.0",
  ) {}

  async start(): Promise<void> {
    const start = this.lifecycle.then(async () => {
      if (this.server) return;
      const server = createServer((request, response) => {
        void this.handle(request, response).catch((error: unknown) => {
          if (!response.headersSent) {
            jsonResponse(response, 500, {
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, this.bindAddress, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        throw new Error("Agent tools server did not receive a TCP port");
      }
      this.server = server;
      this.port = address.port;
      // The primary gateway and desktop supervisor own process lifetime. This
      // auxiliary listener must not keep a partially initialized/test backend
      // alive by itself.
      server.unref();
    });
    this.lifecycle = start.catch(() => undefined);
    await start;
  }

  connection(
    environmentId: string,
    projectId: string,
    target: "host" | "container",
  ): AgentToolConnection {
    if (!this.server || !this.port) throw new Error("Agent tools server is not running");
    let credential = this.credentialsByEnvironment.get(environmentId);
    if (credential && credential.projectId !== projectId) {
      this.scopesByDigest.delete(credentialDigest(credential.token));
      this.credentialsByEnvironment.delete(environmentId);
      credential = undefined;
    }
    if (!credential) {
      credential = {
        environmentId,
        projectId,
        token: randomBytes(32).toString("base64url"),
      };
      this.credentialsByEnvironment.set(environmentId, credential);
      this.scopesByDigest.set(credentialDigest(credential.token), {
        environmentId,
        projectId,
      });
    }
    const hostname = target === "container" ? "host.docker.internal" : "127.0.0.1";
    return {
      url: `http://${hostname}:${this.port}${AGENT_MCP_PATH}`,
      token: credential.token,
    };
  }

  revokeEnvironment(environmentId: string): void {
    const credential = this.credentialsByEnvironment.get(environmentId);
    if (!credential) return;
    this.credentialsByEnvironment.delete(environmentId);
    this.scopesByDigest.delete(credentialDigest(credential.token));
  }

  async stop(): Promise<void> {
    const stop = this.lifecycle.then(async () => {
      const server = this.server;
      this.server = null;
      this.port = null;
      this.credentialsByEnvironment.clear();
      this.scopesByDigest.clear();
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      });
    });
    this.lifecycle = stop.catch(() => undefined);
    await stop;
  }

  private authenticate(request: IncomingMessage): AgentToolScope | null {
    const token = bearerToken(request);
    if (!token) return null;
    return this.scopesByDigest.get(credentialDigest(token)) ?? null;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://agent-tools.invalid");
    if (url.pathname !== AGENT_MCP_PATH) {
      jsonResponse(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, {
        allow: "POST",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }

    const scope = this.authenticate(request);
    if (!scope) {
      jsonResponse(
        response,
        401,
        { error: "Invalid agent tools credential" },
        { "www-authenticate": 'Bearer realm="orkestrator-agent-tools"' },
      );
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        jsonResponse(response, 413, { error: error.message });
        return;
      }
      if (error instanceof InvalidJsonBodyError) {
        jsonResponse(response, 400, { error: error.message });
        return;
      }
      throw error;
    }

    // The v2 handler selects the protocol era per request. Modern clients use
    // MCP 2026-07-28's per-request envelope, while OpenCode/Claude releases
    // that still speak the 2025 protocol use the handler's stateless legacy
    // fallback. Both paths create an isolated ticket server for this request.
    const handler = createMcpHandler(() => createTicketServer(this.storage, scope), {
      legacy: "stateless",
    });
    try {
      await toNodeHandler(handler)(request, response, body);
    } finally {
      await handler.close().catch(() => undefined);
    }
  }
}
