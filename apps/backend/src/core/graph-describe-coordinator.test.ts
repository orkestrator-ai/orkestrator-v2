import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PUBLIC_ACTION_NAMES, isPublicActionName } from "@orkestrator/protocol/public-api";
import { ControlMcpServer, readControlMcpDescriptor } from "./control-mcp-server.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import type { ControlMcpInvoker } from "./control-shared-actions.js";

/**
 * D6: the coordinator lists, launches, reads and cancels saved templates; it
 * never creates or edits one. "Describe a graph" (item 215) authors drafts,
 * so no Control MCP tool, gateway action or public action may reach it.
 */

const DESCRIBE_COMMANDS = [
  "graph_describe_start",
  "graph_describe_status",
  "graph_describe_cancel",
  "graph_describe_dismiss",
];
/** Tool or action names that would let a client author a template. */
const AUTHORING =
  /describe.?graph|graph.?describe|author|graph.?template.?(save|import|create|duplicate|delete)/i;

async function listTools(url: string, token: string): Promise<string[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/list" }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  const body = JSON.parse(payload ?? "{}") as { result?: { tools?: Array<{ name: string }> } };
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

describe("Describe a graph is not exposed to the coordinator (D6)", () => {
  let dataDir: string;
  let server: ControlMcpServer;
  const invoked: string[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-graph-describe-d6-"));
    invoked.length = 0;
    const invoke: ControlMcpInvoker = async <T>(command: string) => {
      invoked.push(command);
      switch (command) {
        case "get_project_coordinator":
          return {
            workspace: {
              id: "coordinator-1",
              lifecycleState: "ready",
              conversations: [
                {
                  id: "conversation-1",
                  tabId: "coordinator-tab",
                  mailboxIncarnationId: "incarnation-1",
                },
              ],
            },
          } as T;
        case "open_coordinator_delegation":
          return { opened: false } as T;
        case "assert_coordinator_delegation_available":
          return { available: true } as T;
        case "get_config":
          return { global: { enabledAgentPlatforms: ["codex"] } } as T;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    };
    server = new ControlMcpServer(dataDir, invoke, { port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no public action authors a template or reaches the describe commands", () => {
    expect(PUBLIC_ACTION_NAMES.filter((name) => AUTHORING.test(name))).toEqual([]);
    for (const command of DESCRIBE_COMMANDS) expect(isPublicActionName(command)).toBe(false);
  });

  test("a coordinator credential lists no describe or authoring tool", async () => {
    const credential = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities: coordinatorRoleCapabilities("main"),
    });
    const tools = await listTools(credential.url, credential.token);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((name) => AUTHORING.test(name))).toEqual([]);
    expect(tools.filter((name) => DESCRIBE_COMMANDS.includes(name))).toEqual([]);
  });

  test("the full operator profile lists none either", async () => {
    const descriptor = await readControlMcpDescriptor(server.getInfo()!.descriptorFile);
    const tools = await listTools(descriptor.url, descriptor.token);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.filter((name) => AUTHORING.test(name))).toEqual([]);
    expect(invoked.filter((command) => DESCRIBE_COMMANDS.includes(command))).toEqual([]);
  });
});
