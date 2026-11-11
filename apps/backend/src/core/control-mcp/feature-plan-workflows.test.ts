/**
 * The coordinator's feature-plan workflow surface over the real Control MCP
 * endpoint (todo 0395 task 3): `launch_feature_plan` says the conversation is
 * woken, `list_workflows` lists a `feature-plan` association with its plan and
 * follow, and an association kind this backend does not know is listed with no
 * resource rather than failing the list. Backend commands are scripted.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlMcpServer, type ControlMcpInvoker } from "./server.js";
import { rpc } from "./test-support.js";

let dataDir: string;
let server: ControlMcpServer;
const invoked: string[] = [];

const plan = {
  featureId: "plan-1",
  title: "Dark mode",
  status: "collecting",
  summary: "",
  stories: [],
  planning: null,
  lastReply: "Which screens need it?",
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-mcp-feature-plan-"));
  invoked.length = 0;
  const invoke: ControlMcpInvoker = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    invoked.push(command);
    switch (command) {
      case "get_config":
        return { global: { agentMessaging: { enabled: true } } } as T;
      case "get_project_coordinator":
        return {
          workspace: {
            id: "coordinator-1",
            lifecycleState: "ready",
            conversations: [{ id: "conversation-1", mailboxIncarnationId: "incarnation-1" }],
          },
          workflows: [
            {
              id: "association-plan",
              kind: "feature-plan",
              resourceId: "plan-1",
              requestId: "feature-plan:plan",
              createdAt: new Date(0).toISOString(),
              featurePlan: { operationId: "planning-coordinator-abc" },
              statusNotice: { key: "ready", notifiedAt: new Date(1).toISOString() },
              terminalNotifiedAt: new Date(1).toISOString(),
            },
            {
              id: "association-future",
              kind: "future-kind",
              resourceId: "resource-1",
              requestId: "future",
              createdAt: new Date(0).toISOString(),
            },
          ],
        } as T;
      case "get_coordinator_feature_plan":
        expect(args.featureId).toBe("plan-1");
        return plan as T;
      case "launch_coordinator_feature_plan":
        return { featureId: "plan-1", phase: "dispatching", reused: false } as T;
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

function credential() {
  return server.issueCoordinatorCredential({
    role: "coordinator",
    projectId: "project-1",
    coordinatorId: "coordinator-1",
    conversationId: "conversation-1",
    mailboxIncarnationId: "incarnation-1",
    capabilities: ["discovery", "tickets"],
  });
}

describe("feature-plan workflows over Control MCP", () => {
  test("list_workflows lists the plan and its follow, and an unknown kind with no resource", async () => {
    const { url, token } = credential();
    const listed = await rpc(url, token, "tools/call", { name: "list_workflows", arguments: {} });
    expect(listed.body.result?.isError).not.toBe(true);
    expect(listed.body.result?.structuredContent).toEqual({
      total: 2,
      workflows: [
        expect.objectContaining({
          id: "association-plan",
          kind: "feature-plan",
          resourceId: "plan-1",
          follow: { following: false, lastReportedState: "ready" },
          resource: plan,
        }),
        expect.objectContaining({
          id: "association-future",
          kind: "future-kind",
          resourceId: "resource-1",
          resource: null,
        }),
      ],
    });
    expect(invoked.filter((command) => command === "get_coordinator_feature_plan")).toHaveLength(1);
  });

  test("launch_feature_plan tells the coordinator it is woken, not to schedule a check", async () => {
    const { url, token } = credential();
    const launched = await rpc(url, token, "tools/call", {
      name: "launch_feature_plan",
      arguments: { requestId: "plan", message: "Add dark mode" },
    });
    const result = launched.body.result?.structuredContent as Record<string, unknown>;
    expect(result).toMatchObject({ featureId: "plan-1", delivery: "async" });
    expect(result.wake).toContain("woken once when the planning reply is ready");
    expect(result.wake).not.toContain("create_schedule");
  });
});
