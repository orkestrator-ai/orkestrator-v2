import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlMcpServer, type ControlMcpInvoker } from "./server.js";

/**
 * Shared setup for the `server*.test.ts` files: a real
 * `ControlMcpServer` on an ephemeral port over a scripted invoker, and the
 * JSON-RPC helpers that call it.
 */

export type RpcBody = {
  result?: {
    tools?: Array<{
      name: string;
      description?: string;
      annotations?: Record<string, boolean>;
      inputSchema?: { properties?: Record<string, { description?: string }> };
    }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { message?: string };
};

export async function rpc(
  url: string,
  token: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<{ response: Response; body: RpcBody }> {
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
  const payload = response.headers.get("content-type")?.startsWith("text/event-stream")
    ? text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice("data: ".length)
    : text;
  return { response, body: payload ? (JSON.parse(payload) as RpcBody) : {} };
}

export async function rpcPayload(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export const BASE = { baseBranch: "main", baseCommit: "a".repeat(40) };

/**
 * Starts the server before each test of the calling `describe` and stops it
 * after. `overrides` replaces a command's answer; `invocations` records every
 * command the server ran. `server` is the current test's instance.
 */
export function useControlMcpServerHarness() {
  let dataDir: string;
  let server: ControlMcpServer;
  const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
  const overrides = new Map<
    string,
    (args: Record<string, unknown>) => unknown | Promise<unknown>
  >();

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-mcp-"));
    invocations.length = 0;
    overrides.clear();
    const invoke: ControlMcpInvoker = async <T>(command: string, args = {}) => {
      invocations.push({ command, args });
      const override = overrides.get(command);
      if (override) return (await override(args)) as T;
      let result: unknown;
      switch (command) {
        case "assert_coordinator_environment_scope":
          // The origin check runs for real in `coordinator-environment-scope.test.ts`.
          result = { allowed: true };
          break;
        case "get_projects":
          result = [
            {
              id: "project-1",
              name: "Orkestrator",
              localPath: "/private/worktree",
              gitUrl: "git@example.invalid:secret/repo.git",
              createdAt: new Date(0).toISOString(),
            },
          ];
          break;
        case "get_project":
          result = { id: "project-1", name: "Orkestrator" };
          break;
        case "get_config":
          result = {
            global: {
              enabledAgentPlatforms: ["codex"],
              agentMessaging: { enabled: true },
              experimentalScheduling: true,
            },
          };
          break;
        case "get_environment_snapshots":
          result = [
            {
              id: "env-1",
              projectId: "project-1",
              name: "Existing environment",
              status: "running",
              setupStatus: "ready",
              environmentType: "local",
            },
          ];
          break;
        case "get_environment":
          result = {
            id: "env-1",
            projectId: "project-1",
            name: "Existing environment",
            status: "running",
            setupStatus: "ready",
            environmentType: "local",
          };
          break;
        case "get_native_agent_model_catalog":
          result = [
            {
              id: "gpt-5.6-codex",
              name: "GPT-5.6 Codex",
              platform: "codex",
              supportsSpeed: true,
              reasoning: [{ id: "high", name: "High" }],
            },
          ];
          break;
        case "get_agent_model_catalog_cache":
          result = { schemaVersion: 1 };
          break;
        case "get_repository_config":
          result = {};
          break;
        case "get_project_base_branch_tip":
          result = { branch: "main", commit: "a".repeat(40), ref: "origin/main", fetched: true };
          break;
        case "verify_project_launch_base":
          result = { contained: true };
          break;
        case "get_pane_layout":
        case "get_coordinator_launch_environment":
        case "get_coordinator_node_launch_environment":
        case "get_opencode_model_catalog_cache":
          result = null;
          break;
        case "launch_control_job":
          result = {
            jobId: "job-1",
            environmentId: "env-1",
            tabId: "agent-job-job-1",
            status: "accepted",
          };
          break;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
      return result as T;
    };
    server = new ControlMcpServer(dataDir, invoke, { port: 0 });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * A ready coordinator conversation's credential. Operator credentials run
   * the shared launch, prompt, ticket and mail tools through public actions
   * (`operator-tools.test.ts`); coordinators keep these
   * implementations, which is what the tests below exercise.
   */
  function coordinatorCredential(capabilities: string[]) {
    overrides.set("get_project_coordinator", () => ({
      workspace: {
        id: "coordinator-1",
        lifecycleState: "ready",
        conversations: [
          { id: "conversation-1", tabId: "coordinator-tab", mailboxIncarnationId: "incarnation-1" },
        ],
      },
    }));
    overrides.set("open_coordinator_delegation", () => ({ opened: false }));
    overrides.set("assert_coordinator_delegation_available", () => ({ available: true }));
    return server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "conversation-1",
      mailboxIncarnationId: "incarnation-1",
      capabilities,
    });
  }

  return {
    invocations,
    overrides,
    coordinatorCredential,
    get server() {
      return server;
    },
  };
}
