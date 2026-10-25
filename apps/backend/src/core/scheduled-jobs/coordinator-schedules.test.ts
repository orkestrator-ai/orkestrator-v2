import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import type { CommandContext } from "../commands-context.js";
import { registerScheduledJobCommands } from "../commands-registry-scheduled-jobs.js";
import { rpc } from "../control-mcp-test-support.js";
import { ControlMcpServer, type ControlMcpInvoker } from "../control-mcp-server.js";
import { StorageService } from "../storage.js";
import { ScheduledJobExecutor } from "./executor.js";
import { ScheduledJobService } from "./service.js";

/**
 * Coordinator schedules over the real Control MCP endpoint: the coordinator's
 * credential creates, lists and cancels schedules; a fire runs the
 * coordinator's own tool in-process under the same scope checks, and a
 * reminder to "coordinator" arrives as a backend notice. A side agent cannot
 * schedule what it cannot do.
 */

const COMMIT = "b".repeat(40);
let dataDir: string;
let storage: StorageService;
let server: ControlMcpServer;
let service: ScheduledJobService;
let clock: { now: number };
const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
const mail: Array<{ sender: unknown; input: Record<string, unknown> }> = [];

function workspace(): CoordinatorWorkspace {
  return {
    id: "coordinator-1",
    projectId: "project-1",
    lifecycleState: "ready",
    conversations: [
      { id: "main-1", tabId: "main-tab", role: "main", mailboxIncarnationId: "inc-main" },
      { id: "side-1", tabId: "side-tab", role: "side", mailboxIncarnationId: "inc-side" },
    ],
  } as unknown as CoordinatorWorkspace;
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-coordinator-schedules-"));
  storage = new StorageService(dataDir);
  await storage.init();
  invocations.length = 0;
  mail.length = 0;
  clock = { now: Date.parse("2026-10-25T10:00:00Z") };
  const commands = new Map<
    string,
    (args: Record<string, unknown>, context: CommandContext) => unknown
  >();
  registerScheduledJobCommands((name, handler) => {
    commands.set(name, handler as never);
  });
  const context = {} as CommandContext;
  const invoke: ControlMcpInvoker = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    invocations.push({ command, args });
    const own = commands.get(command);
    if (own) return (await own(args, context)) as T;
    switch (command) {
      case "get_project_coordinator":
        return { workspace: workspace() } as T;
      case "get_config":
        return {
          global: { agentMessaging: { enabled: true }, enabledAgentPlatforms: ["claude"] },
        } as T;
      case "get_project_base_branch_tip":
        return { branch: "main", commit: COMMIT, ref: "origin/main", fetched: true } as T;
      case "verify_project_launch_base":
        return { contained: true } as T;
      case "get_repository_config":
      case "get_project_git_status":
        return {} as T;
      case "get_environment_snapshots":
        return [] as T;
      case "get_opencode_model_catalog_cache":
        return null as T;
      case "get_project":
        return { id: "project-1", name: "Project" } as T;
      case "get_native_agent_model_catalog":
        return [] as T;
      case "get_agent_model_catalog_cache":
        return { schemaVersion: 1 } as T;
      case "launch_coordinator_environment":
        return { environment: { id: "env-new", projectId: "project-1", status: "creating" } } as T;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  };
  server = new ControlMcpServer(dataDir, invoke, { port: 0 });
  await server.start();
  service = new ScheduledJobService({
    store: storage.scheduledJobStore(),
    now: () => clock.now,
    defaultTimeZone: () => "Europe/London",
    executor: new ScheduledJobExecutor({
      invoke,
      storage: {
        async sendAgentMail(sender, input) {
          mail.push({ sender, input });
          return {
            id: `message-${mail.length}`,
            toEnvironmentId: input.toEnvironmentId,
            toTabId: input.toTabId,
          };
        },
        getCoordinatorWorkspace: async () => workspace(),
      },
      controlMcp: {
        credentialPolicy: (id) => server.credentialPolicy(id),
        callCoordinatorTool: (scope, tool, args) => server.callCoordinatorTool(scope, tool, args),
        listCoordinatorTools: (scope) => server.listCoordinatorTools(scope),
      },
    }),
  });
  context.scheduledJobs = service;
});

afterEach(async () => {
  await server.stop();
  storage.close();
  await rm(dataDir, { recursive: true, force: true });
});

function credential(role: "main" | "side") {
  return server.issueCoordinatorCredential({
    role: "coordinator",
    projectId: "project-1",
    coordinatorId: "coordinator-1",
    conversationId: role === "main" ? "main-1" : "side-1",
    mailboxIncarnationId: role === "main" ? "inc-main" : "inc-side",
    capabilities:
      role === "main"
        ? [
            "discovery",
            "tickets",
            "environments",
            "jobs",
            "build-pipelines",
            "multi-review",
            "mail",
            "schedules",
          ]
        : ["discovery", "mail", "schedules"],
  });
}

async function call(role: "main" | "side", name: string, args: Record<string, unknown>) {
  const issued = credential(role);
  const { body } = await rpc(issued.url, issued.token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(body.error.message);
  return body.result!;
}

async function fire() {
  await service.tick();
  await service.idle();
}

describe("coordinator schedules", () => {
  test("wake me at 03:12: a reminder to the coordinator address, as a backend notice", async () => {
    const created = await call("main", "create_schedule", {
      requestId: "wake-1",
      at: "03:12",
      action: {
        type: "send_message",
        toEnvironmentId: "coordinator",
        body: "Resume stalled workers.",
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      state: "active",
      timeZone: "Europe/London",
      nextFireAt: "2026-10-26T03:12:00.000Z",
    });
    const job = service.list({ kind: "operator" })[0]!;
    expect(job.owner).toEqual({
      kind: "coordinator",
      projectId: "project-1",
      coordinatorId: "coordinator-1",
      conversationId: "main-1",
      role: "main",
    });
    clock.now = Date.parse("2026-10-26T03:12:00Z");
    await fire();
    expect(mail).toEqual([
      {
        sender: { kind: "system", projectId: "project-1", source: "workflow", resourceId: job.id },
        input: expect.objectContaining({
          requestId: `sched:${job.id}@${Date.parse("2026-10-26T03:12:00Z")}`,
          toEnvironmentId: "coordinator",
          body: expect.stringContaining("Resume stalled workers."),
        }),
      },
    ]);
    expect(service.get({ kind: "operator" }, job.id)).toMatchObject({ state: "completed" });
  });

  test("a scheduled launch runs the coordinator's own launch_environment with the base resolved at fire time", async () => {
    const created = await call("main", "create_schedule", {
      requestId: "launch-1",
      everyMinutes: 60,
      action: {
        type: "launch_environment",
        projectId: "project-1",
        agent: "claude",
        prompt: "Nightly audit",
      },
    });
    expect(created.isError).not.toBe(true);
    clock.now += 60 * 60_000;
    await fire();
    const launch = invocations.find((entry) => entry.command === "launch_coordinator_environment");
    expect(launch).toBeDefined();
    expect(JSON.stringify(launch?.args)).toContain(COMMIT);
    const job = service.list({ kind: "operator" })[0]!;
    expect(job.lastFire).toMatchObject({ state: "succeeded" });
    expect(service.get({ kind: "operator" }, job.id).fires[0]!.outcome).toMatchObject({
      baseBranch: "main",
      baseCommit: COMMIT,
    });
  });

  test("a side agent may schedule mail to the main coordinator but not a launch", async () => {
    const refused = await call("side", "create_schedule", {
      requestId: "side-launch",
      at: "+1h",
      action: { type: "launch_environment", projectId: "project-1", agent: "claude", prompt: "x" },
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("cannot call launch_environment");
    const allowed = await call("side", "create_schedule", {
      requestId: "side-mail",
      at: "+1h",
      action: { type: "send_message", toEnvironmentId: "coordinator", body: "ping main" },
    });
    expect(allowed.isError).not.toBe(true);
    const mainList = await call("main", "list_schedules", {});
    const sideList = await call("side", "list_schedules", {});
    expect((sideList.structuredContent!.schedules as unknown[]).length).toBe(1);
    // The main coordinator manages its side agents' schedules too.
    expect((mainList.structuredContent!.schedules as unknown[]).length).toBe(1);
    const id = (sideList.structuredContent!.schedules as Array<{ scheduleId: string }>)[0]!
      .scheduleId;
    const cancelled = await call("side", "cancel_schedule", { scheduleId: id });
    expect(cancelled.structuredContent).toMatchObject({ deleted: true });
  });

  test("schedule tools are listed to both roles", async () => {
    for (const role of ["main", "side"] as const) {
      const issued = credential(role);
      const { body } = await rpc(issued.url, issued.token, "tools/list");
      const names = body.result!.tools!.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining(["create_schedule", "list_schedules", "cancel_schedule"]),
      );
    }
  });
});
