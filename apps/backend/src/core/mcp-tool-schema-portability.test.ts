import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKFLOW_RESULT_KINDS,
  WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import { AgentToolsServer } from "./agent-tools.js";
import {
  ControlMcpServer,
  readControlMcpDescriptor,
  type ControlMcpInvoker,
} from "./control-mcp-server.js";
import { DesignService } from "./design-service.js";
import { createTestRenderer } from "./design-test-support.js";
import { StorageService } from "./storage.js";
import type { WebAnnotationToolHost } from "./web-annotation-contracts.js";
import { WorkflowResultService } from "./workflow-result-service.js";

/**
 * Every tool input schema is sent verbatim to whichever model the agent uses.
 * Providers accept different JSON Schema subsets, and one unsupported keyword
 * fails the whole request before the model runs (for example "Recursive JSON
 * schemas are not currently supported"). Keep published schemas to the subset
 * every provider accepts; the backend validates arguments authoritatively.
 */
const NON_PORTABLE_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "$anchor",
]);
// Guards against runaway growth, not a documented provider limit. Depth counts
// raw JSON nesting (`properties`, `items`, `anyOf` each add a level); the
// deepest current schema, design submit_operation, reaches 15.
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_BYTES = 32 * 1024;

type ListedTool = { name: string; inputSchema?: unknown };

function portabilityIssues(schema: unknown): string[] {
  const issues: string[] = [];
  const visit = (node: unknown, path: string, depth: number) => {
    if (depth > MAX_SCHEMA_DEPTH) {
      issues.push(`${path}: nested deeper than ${MAX_SCHEMA_DEPTH}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (NON_PORTABLE_KEYWORDS.has(key)) issues.push(`${path}.${key}: non-portable keyword`);
      visit(value, `${path}.${key}`, depth + 1);
    }
  };
  visit(schema, "inputSchema", 0);
  const bytes = new TextEncoder().encode(JSON.stringify(schema)).length;
  if (bytes > MAX_SCHEMA_BYTES)
    issues.push(`inputSchema: ${bytes} bytes exceeds ${MAX_SCHEMA_BYTES}`);
  return issues;
}

/** Lists tools the way OpenCode does: the legacy stateless JSON-RPC endpoint. */
async function listTools(url: string, token: string): Promise<ListedTool[]> {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  do {
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
        method: "tools/list",
        ...(cursor ? { params: { cursor } } : {}),
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length)
      : text;
    const body = JSON.parse(payload ?? "{}") as {
      result?: { tools?: ListedTool[]; nextCursor?: string };
    };
    tools.push(...(body.result?.tools ?? []));
    cursor = body.result?.nextCursor;
  } while (cursor);
  return tools;
}

function expectPortable(surface: string, tools: ListedTool[]): void {
  const failures = tools.flatMap((tool) =>
    portabilityIssues(tool.inputSchema).map((issue) => `${surface}/${tool.name} ${issue}`),
  );
  expect(failures).toEqual([]);
}

describe("portabilityIssues", () => {
  test("flags recursion, references, excessive depth, and size", () => {
    expect(
      portabilityIssues({
        type: "object",
        properties: { result: { $ref: "#/$defs/json" } },
        $defs: { json: { anyOf: [{ type: "string" }] } },
      }),
    ).toEqual([
      "inputSchema.properties.result.$ref: non-portable keyword",
      "inputSchema.$defs: non-portable keyword",
    ]);
    let deep: Record<string, unknown> = { type: "string" };
    for (let level = 0; level < MAX_SCHEMA_DEPTH; level += 1) deep = { items: deep };
    expect(portabilityIssues(deep)).toEqual([
      expect.stringContaining(`nested deeper than ${MAX_SCHEMA_DEPTH}`),
    ]);
    expect(portabilityIssues({ description: "x".repeat(MAX_SCHEMA_BYTES) })).toEqual([
      expect.stringContaining("exceeds"),
    ]);
    expect(
      portabilityIssues({
        type: "object",
        properties: { result: { type: "object", additionalProperties: {} } },
      }),
    ).toEqual([]);
  });
});

describe("published MCP tool schemas are provider-portable", () => {
  const environmentId = "env-portable";
  const projectId = "project-portable";
  const tabId = "agent-portable";
  let dataDir: string;
  let worktree: string;
  let storage: StorageService;
  let design: DesignService;
  let workflowResults: WorkflowResultService;
  let agentTools: AgentToolsServer;
  let control: ControlMcpServer;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ork-mcp-portability-"));
    worktree = await mkdtemp(join(tmpdir(), "ork-mcp-portability-repo-"));
    storage = new StorageService(dataDir);
    await storage.init();
    await storage.addProject({
      id: projectId,
      name: projectId,
      gitUrl: `https://example.invalid/${projectId}.git`,
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
    await storage.addEnvironment({
      id: environmentId,
      projectId,
      name: environmentId,
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
      setupPhase: "ready",
      setupScriptsComplete: true,
    });
    design = new DesignService(dataDir, () => {}, createTestRenderer());
    workflowResults = new WorkflowResultService(dataDir);
    agentTools = new AgentToolsServer(storage, "127.0.0.1", workflowResults, design);
    await agentTools.start();
    // Registration never calls the host; only tools/list is exercised here.
    agentTools.setWebAnnotationToolHost({} as WebAnnotationToolHost);

    const invoke: ControlMcpInvoker = async <T>(command: string) => {
      switch (command) {
        case "get_config":
          return { global: { agentMessaging: { enabled: true } } } as T;
        case "get_projects":
          return [{ id: projectId, name: projectId }] as T;
        case "get_project_coordinator":
          return {
            workspace: {
              id: "coordinator-portable",
              lifecycleState: "ready",
              conversations: [{ id: "conversation-portable", mailboxIncarnationId: "incarnation" }],
            },
          } as T;
        default:
          return null as T;
      }
    };
    control = new ControlMcpServer(dataDir, invoke, { port: 0 });
    await control.start();
  });

  afterAll(async () => {
    await control.stop();
    await agentTools.stop();
    await design.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  });

  test("agent tools: Kanban, messaging, and web annotations", async () => {
    const connection = agentTools.connection(environmentId, projectId, "host", tabId);
    const tools = await listTools(connection.url, connection.token);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["list_tickets", "send_message", "get_annotation_request"]),
    );
    expectPortable("orkestrator", tools);
  });

  test("design tools", async () => {
    await design.create(environmentId, "Workspace");
    const connection = agentTools.connection(environmentId, projectId, "host");
    const tools = await listTools(new URL("/design-mcp", connection.url).href, connection.token);
    expect(tools.length).toBeGreaterThan(0);
    expectPortable("orkestrator-design", tools);
  });

  test("OpenCode workflow-result broker", async () => {
    const resultKey = crypto.randomUUID();
    await workflowResults.prepare({
      resultKey,
      kind: "validation-plan",
      environmentId,
      projectId,
      provider: "opencode",
    });
    const connection = agentTools.workflowResultConnection(
      environmentId,
      projectId,
      "host",
      resultKey,
      "opencode",
    );
    const tools = await listTools(connection.url, connection.token);
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        WORKFLOW_RESULT_VALIDATION_TOOL_NAME,
        ...WORKFLOW_RESULT_KINDS.map(workflowResultToolName),
      ]),
    );
    expectPortable("orkestrator_workflow_result", tools);
  });

  test.each([...WORKFLOW_RESULT_KINDS])(
    "attempt-scoped workflow result tools: %s",
    async (kind) => {
      const resultKey = crypto.randomUUID();
      await workflowResults.prepare({
        resultKey,
        kind,
        environmentId,
        projectId,
        provider: "codex",
      });
      const connection = agentTools.workflowResultConnection(
        environmentId,
        projectId,
        "host",
        resultKey,
      );
      const tools = await listTools(connection.url, connection.token);
      expect(tools.map((tool) => tool.name)).toContain(workflowResultToolName(kind));
      expectPortable(`orkestrator-workflow-result/${kind}`, tools);
    },
  );

  test("control tools", async () => {
    const descriptor = await readControlMcpDescriptor(control.getInfo()!.descriptorFile);
    const tools = await listTools(descriptor.url, descriptor.token);
    expect(tools.length).toBeGreaterThan(0);
    expectPortable("orkestrator-control", tools);
  });

  test("coordinator control tools", async () => {
    const credential = control.issueCoordinatorCredential({
      role: "coordinator",
      projectId,
      coordinatorId: "coordinator-portable",
      conversationId: "conversation-portable",
      mailboxIncarnationId: "incarnation",
      capabilities: [
        "discovery",
        "tickets",
        "environments",
        "jobs",
        "build-pipelines",
        "multi-review",
        "mail",
      ],
    });
    const tools = await listTools(credential.url, credential.token);
    expect(tools.map((tool) => tool.name)).toContain("launch_multi_review");
    expectPortable("orkestrator-control/coordinator", tools);
  });
});
