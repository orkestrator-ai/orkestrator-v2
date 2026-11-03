import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { COORDINATOR_ACTIVITY_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { CoordinatorService } from "./coordinator-service.js";
import { runCommand } from "./shell.js";
import { StorageService, createProject } from "./storage.js";

let root: string;
let storage: StorageService;
let coordinator: CoordinatorService;
let commands: Map<string, CommandHandler>;
let observed: Map<string, AgentActivityState>;
type ActivityRead = Parameters<
  NonNullable<CommandContext["nativeAgents"]>["sessionActivitySnapshot"]
>;
let reads: ActivityRead[];

async function addProject(name: string, agent: "claude" | "codex" = "claude") {
  const checkout = path.join(root, name);
  await mkdir(checkout);
  await runCommand("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  const project = await storage.addProject(createProject(name, checkout));
  const snapshot = await coordinator.ensure(project.id);
  const conversation = snapshot.workspace.conversations[0]!;
  await coordinator.assignConversationAgent(project.id, conversation.id, agent);
  return {
    projectId: project.id,
    agent,
    logicalSessionKey: conversation.logicalSessionKey,
    runtimeId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
  };
}

const list = (context: Partial<CommandContext>) =>
  commands.get(COORDINATOR_ACTIVITY_COMMAND)!({}, {
    storage,
    ...context,
  } as CommandContext) as Promise<{ projects: Record<string, string> }>;

const nativeAgents = () => ({
  sessionActivitySnapshot: (...args: ActivityRead) => {
    const [environmentId] = args;
    reads.push(args);
    return observed.get(environmentId) ?? "unknown";
  },
});

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-coordinator-activity-"));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  commands = createCommandRegistry();
  observed = new Map();
  reads = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe(COORDINATOR_ACTIVITY_COMMAND, () => {
  test("reports each project's coordinator from the activity observer", async () => {
    const working = await addProject("working");
    const waiting = await addProject("waiting", "codex");
    const idle = await addProject("idle");
    observed.set(working.runtimeId, "working");
    observed.set(waiting.runtimeId, "waiting");
    observed.set(idle.runtimeId, "idle");

    expect(await list({ nativeAgents: nativeAgents() as never })).toEqual({
      projects: { [working.projectId]: "working", [waiting.projectId]: "waiting" },
    });
    expect(reads).toHaveLength(3);
    for (const project of [working, waiting, idle]) {
      expect(reads).toContainEqual([project.runtimeId, project.agent, project.logicalSessionKey]);
    }
  });

  test("a coordinator never observed reads as idle", async () => {
    await addProject("fresh");
    expect(await list({ nativeAgents: nativeAgents() as never })).toEqual({ projects: {} });
  });

  test("answers no activity without a native agent service", async () => {
    const project = await addProject("headless");
    observed.set(project.runtimeId, "working");
    expect(await list({})).toEqual({ projects: {} });
  });
});
