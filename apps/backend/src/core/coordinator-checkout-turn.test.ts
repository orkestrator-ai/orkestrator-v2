import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { COORDINATOR_CHECKOUT_TURN_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import {
  findCoordinatorCheckoutTurn,
  type CoordinatorCheckoutTurnSources,
} from "./coordinator-checkout-turn.js";
import { CoordinatorService } from "./coordinator-service.js";
import { runCommand } from "./shell.js";
import { StorageService, createProject } from "./storage.js";

let root: string;
let storage: StorageService;
let coordinator: CoordinatorService;
let commands: Map<string, CommandHandler>;
let observed: Map<string, AgentActivityState>;
let projectId: string;
let mainRuntimeId: string;
let mainConversationId: string;

const getProjection = mock(async (): Promise<{ turn: { phase: string } } | null> => null);
const hasActiveCheckoutWork = mock(async () => false);

const nativeAgents = () =>
  ({
    hasActiveCheckoutWork,
    getProjection,
    sessionTurnActivitySnapshot: (environmentId: string) =>
      observed.get(environmentId) ?? "unknown",
  }) as unknown as CoordinatorCheckoutTurnSources["nativeAgents"];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ork-coordinator-checkout-turn-"));
  storage = new StorageService(path.join(root, "data"));
  await storage.init();
  coordinator = new CoordinatorService(storage, () => ({
    enabled: true,
    running: true,
    error: null,
  }));
  commands = createCommandRegistry();
  observed = new Map();
  getProjection.mockReset();
  getProjection.mockImplementation(async () => null);
  hasActiveCheckoutWork.mockReset();
  hasActiveCheckoutWork.mockImplementation(async () => false);

  const checkout = path.join(root, "checkout");
  await mkdir(checkout);
  await runCommand("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  const project = await storage.addProject(createProject("checkout", checkout));
  projectId = project.id;
  const snapshot = await coordinator.ensure(project.id);
  const conversation = snapshot.workspace.conversations[0]!;
  await coordinator.assignConversationAgent(project.id, conversation.id, "claude");
  mainConversationId = conversation.id;
  mainRuntimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (confirmWithProjections: boolean) =>
  findCoordinatorCheckoutTurn(projectId, {
    storage,
    nativeAgents: nativeAgents(),
    confirmWithProjections,
  });

describe("findCoordinatorCheckoutTurn", () => {
  test("names a conversation the observer sees working or waiting", async () => {
    for (const state of ["working", "waiting"] as const) {
      observed.set(mainRuntimeId, state);
      expect(await read(false)).toEqual({
        kind: "conversation",
        conversationId: mainConversationId,
      });
    }
  });

  test("an idle or never observed conversation holds nothing", async () => {
    expect(await read(false)).toBeNull();
    observed.set(mainRuntimeId, "idle");
    expect(await read(false)).toBeNull();
  });

  test("a closed conversation holds nothing", async () => {
    observed.set(mainRuntimeId, "working");
    await coordinator.closeConversation(projectId, mainConversationId);
    expect(await read(false)).toBeNull();
  });

  test("the project home's turn counts as well", async () => {
    const environments = [{ id: "home", projectHome: true }];
    hasActiveCheckoutWork.mockImplementation(async () => true);
    const turn = await findCoordinatorCheckoutTurn(projectId, {
      storage: {
        coordinators: storage.coordinators,
        getEnvironmentsByProject: async () => environments,
      } as unknown as CoordinatorCheckoutTurnSources["storage"],
      nativeAgents: nativeAgents(),
      confirmWithProjections: false,
    });
    expect(turn).toEqual({ kind: "project-home" });
    expect(hasActiveCheckoutWork).toHaveBeenCalledWith("home");
  });

  test("only a mutation's admission reads projections", async () => {
    getProjection.mockImplementation(async () => ({ turn: { phase: "recovering" } }));
    expect(await read(false)).toBeNull();
    expect(getProjection).not.toHaveBeenCalled();

    expect(await read(true)).toEqual({
      kind: "conversation",
      conversationId: mainConversationId,
    });
    expect(getProjection).toHaveBeenCalledTimes(1);
  });

  test("a failed projection read is not a turn", async () => {
    getProjection.mockImplementation(async () => {
      throw new Error("bridge gone");
    });
    expect(await read(true)).toBeNull();
  });
});

describe(COORDINATOR_CHECKOUT_TURN_COMMAND, () => {
  const ask = (context: Partial<CommandContext>, args: Record<string, unknown> = { projectId }) =>
    commands.get(COORDINATOR_CHECKOUT_TURN_COMMAND)!(args, {
      storage,
      ...context,
    } as CommandContext);

  test("answers from the observer without reading a projection", async () => {
    observed.set(mainRuntimeId, "working");
    expect(await ask({ nativeAgents: nativeAgents() as never })).toEqual({
      kind: "conversation",
      conversationId: mainConversationId,
    });
    observed.set(mainRuntimeId, "idle");
    expect(await ask({ nativeAgents: nativeAgents() as never })).toBeNull();
    expect(getProjection).not.toHaveBeenCalled();
  });

  test("answers no turn without a native agent service", async () => {
    expect(await ask({})).toBeNull();
  });

  test("refuses a missing project id", async () => {
    await expect(ask({ nativeAgents: nativeAgents() as never }, {})).rejects.toThrow("projectId");
  });
});
