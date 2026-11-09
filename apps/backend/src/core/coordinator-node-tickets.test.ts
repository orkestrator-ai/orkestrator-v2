/**
 * A command node coordinator creating, changing and building tickets on a
 * leaf with `nodeId`: the command node is a real coordinator store and board,
 * the leaf a real storage service in its own data directory, and every call
 * between them goes over in-process links that run the leaf's real commands.
 * No leaf-local ticket id and no relay through the leaf's coordinator.
 */
import { registrarFrom } from "./commands-registry-contracts.js";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MailWorld } from "./agent-mail-world-test-support.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { registerControllerWorkflowCommands } from "./commands-registry-controller-workflows.js";
import { registerCoordinatorNodeCommands } from "./commands-registry-coordinator-nodes.js";
import { registerKanbanCommands } from "./commands-registry-kanban.js";
import { registerTicketSyncCommands } from "./commands-registry-ticket-sync.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { registerCoordinatorNodeTicketCommands } from "./coordinator-node-tickets.js";
import { NodeTicketSync } from "./nodes/node-ticket-sync.js";
import { createProject, StorageService } from "./storage.js";

const BASE = "b".repeat(40);
const REPO = "git@github.com:acme/site.git";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(
  options: { capability?: boolean; buildOriginCapability?: boolean; ignoresLabels?: boolean } = {},
) {
  const world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
  cleanups.push(() => world.close());
  await world.storage.updateProject(world.projectId, { gitUrl: REPO });
  const main = await world.main();
  const scope = {
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: main.conversationId!,
  };

  const leafDir = await mkdtemp(path.join(tmpdir(), "ork-node-tickets-leaf-"));
  const leaf = new StorageService(leafDir);
  await leaf.init();
  cleanups.push(async () => {
    leaf.close();
    await rm(leafDir, { recursive: true, force: true });
  });
  const leafProject = await leaf.addProject(createProject(REPO));
  const started: Array<Record<string, unknown>> = [];
  const leafCommands = new Map<string, CommandHandler>();
  const registerLeaf = registrarFrom((name, handler) => leafCommands.set(name, handler));
  registerTicketSyncCommands(registerLeaf);
  registerKanbanCommands(registerLeaf, {
    conditionalManifestSnapshot: async (
      _args: unknown,
      _storage: unknown,
      _kind: unknown,
      read: () => unknown,
    ) => read(),
  } as unknown as RegistryDependencies);
  registerControllerWorkflowCommands(registerLeaf, { commands: new Map() } as never);
  const leafContext = {
    storage: leaf,
    nodes: { listControllers: () => [{ controllerId: "bk_cmd", displayName: "Command" }] },
    buildPipelines: {
      start: async (input: Record<string, unknown>, coordinatorLaunchId?: string) => {
        started.push(input);
        return {
          id: `pipeline-${started.length}`,
          projectId: leafProject.id,
          coordinatorLaunchId,
        };
      },
    },
  } as unknown as CommandContext;
  const runOnLeaf = async (name: string, args: Record<string, unknown>) => {
    const handler = leafCommands.get(name);
    if (!handler) throw new Error(`Unknown command: ${name}`);
    const input = structuredClone(args);
    if (options.ignoresLabels && (name === "update_kanban_task" || name === "add_kanban_task"))
      delete input.labels;
    return structuredClone(await handler(input, leafContext));
  };

  const state = { connected: true };
  const capabilities: Record<string, number> = {
    "node-attachment": 1,
    ...(options.buildOriginCapability === false ? {} : { "node-coordinator-build-origin": 1 }),
    ...(options.capability === false ? {} : { "ticket-sync": 1 }),
  };
  const link = {
    get connected() {
      return state.connected;
    },
    hello: { capabilities },
    invoke: async <T>(name: string, args: Record<string, unknown> = {}) => {
      if (!state.connected) throw new Error("fetch failed");
      return (await runOnLeaf(name, args)) as T;
    },
  };
  const routed: string[] = [];
  const summaries = async () => ({
    selfId: "bk_cmd",
    nodes: [
      {
        nodeId: "bk_leaf",
        available: state.connected,
        view: { displayName: "Build box" },
        projects: [{ ref: { projectId: leafProject.id }, repositoryHint: "github.com/acme/site" }],
      },
    ],
  });
  const ticketSync = new NodeTicketSync({
    selfId: async () => "bk_cmd",
    link: () => link,
    nodes: async () =>
      (await summaries()).nodes.map((node) => ({
        nodeId: node.nodeId,
        displayName: node.view.displayName,
        available: node.available,
        projects: node.projects.map((project) => ({
          projectId: project.ref.projectId,
          repositoryHint: project.repositoryHint,
        })),
      })),
    localProjects: () => world.storage.loadProjects(),
    ticketSync: world.storage.ticketSync,
    localImage: (imageId) => world.storage.kanban.getKanbanImageData(imageId).catch(() => null),
    emit: () => undefined,
    debounceMs: 1,
    retryDelayMs: 60_000,
  });
  cleanups.push(async () => ticketSync.dispose());
  const context = {
    storage: world.storage,
    coordinators: world.coordinator,
    nodes: {
      status: async () => ({ nodeId: "bk_cmd", mode: "command" }),
      link: (nodeId: string) => (nodeId === "bk_leaf" ? link : null),
    },
    nodePortal: {
      summaries,
      invokeOnNode: async (input: { command: string; args: Record<string, unknown> }) => {
        if (!state.connected) throw new Error("That node is not connected.");
        routed.push(input.command);
        return { outcome: "ok", result: await runOnLeaf(input.command, input.args) };
      },
    },
    nodeCoordination: { ticketSync },
  } as unknown as CommandContext;
  const commands = new Map<string, CommandHandler>();
  registerCoordinatorNodeCommands(registrarFrom((name, handler) => commands.set(name, handler)));
  registerCoordinatorNodeTicketCommands(
    registrarFrom((name, handler) => commands.set(name, handler)),
  );
  const run = (name: string, args: Record<string, unknown>) =>
    commands.get(name)!(args, context) as Promise<Record<string, unknown>>;
  const ticketOnNode = (action: string, input: Record<string, unknown>) =>
    run("coordinator_node_ticket", { scope, nodeId: "bk_leaf", action, input });
  const build = (requestId: string, taskId: string) =>
    run("start_coordinator_node_build_pipeline", {
      scope,
      requestId,
      nodeId: "bk_leaf",
      input: {
        projectId: scope.projectId,
        taskId,
        taskTitle: "Fix",
        environmentType: "local",
        agentType: "codex",
        taskSnapshot: {
          title: "Fix",
          description: "",
          acceptanceCriteria: "",
          comments: [],
          images: [],
        },
        delegationBaseBranch: "main",
        delegationBaseCommit: BASE,
      },
    });
  return {
    context,
    world,
    scope,
    leaf,
    leafProject,
    state,
    routed,
    started,
    ticketSync,
    ticketOnNode,
    build,
  };
}

describe("tickets on a leaf", () => {
  test("a ticket created for a leaf is on the board and on the leaf under one id, and its build runs there", async () => {
    const f = await setup();
    const created = await f.ticketOnNode("create", {
      requestId: "ticket-1",
      title: "Fix the parser",
      description: "It breaks on tabs",
      acceptanceCriteria: "- Tabs parse",
    });
    const ticket = created.ticket as { id: string; projectId: string };
    expect(ticket.projectId).toBe(f.scope.projectId);
    expect(created).toMatchObject({ nodeId: "bk_leaf", synced: true, sync: { state: "in-sync" } });
    expect(await f.leaf.kanban.getKanbanTask(ticket.id)).toMatchObject({
      projectId: f.leafProject.id,
      title: "Fix the parser",
    });
    // The same requestId replays the same ticket rather than making a second.
    const again = await f.ticketOnNode("create", {
      requestId: "ticket-1",
      title: "Fix the parser",
      description: "It breaks on tabs",
      acceptanceCriteria: "- Tabs parse",
    });
    expect((again.ticket as { id: string }).id).toBe(ticket.id);

    const workflow = await f.build("build-1", ticket.id);
    expect(workflow).toMatchObject({ id: "pipeline-1" });
    // The leaf linked the build to its copy of the board's ticket, by the same id.
    expect(f.started).toEqual([
      expect.objectContaining({ source: { type: "kanban", taskId: ticket.id } }),
    ]);
    const board = await f.world.storage.kanban.getKanbanTask(ticket.id);
    expect(board?.sync?.work).toMatchObject({
      nodeId: "bk_leaf",
      nodeName: "Build box",
      buildPipelineId: "pipeline-1",
    });
    // The leaf's build moves its copy; that comes back to the board.
    await f.leaf.kanban.updateKanbanTask(ticket.id, {
      status: "in-progress",
      buildPipelineId: "pipeline-1",
    });
    await f.ticketSync.sync("bk_leaf");
    expect(await f.world.storage.kanban.getKanbanTask(ticket.id)).toMatchObject({
      status: "in-progress",
    });
  });

  test("updates and comments with nodeId change the board and reach the leaf; reads show the leaf's board", async () => {
    const f = await setup();
    const own = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "Only on the leaf", "");
    const created = await f.ticketOnNode("create", { requestId: "t", title: "Shared" });
    const id = (created.ticket as { id: string }).id;
    const updated = await f.ticketOnNode("update", { ticketId: id, status: "review" });
    expect(updated).toMatchObject({ synced: true, sync: { state: "in-sync" } });
    await f.ticketOnNode("comment", { ticketId: id, text: "Ready", requestId: "c1" });
    expect(await f.leaf.kanban.getKanbanTask(id)).toMatchObject({
      status: "review",
      comments: [expect.objectContaining({ text: "Ready" })],
    });
    const listed = await f.ticketOnNode("list", {});
    const tickets = listed.tickets as Array<{ id: string; sync?: { replica?: unknown } }>;
    expect(tickets.map((task) => task.id).sort()).toEqual([id, own.id].sort());
    expect(tickets.find((task) => task.id === id)?.sync?.replica).toBeDefined();
    // A ticket made only on the leaf is changed there.
    const local = await f.ticketOnNode("update", { ticketId: own.id, title: "Renamed there" });
    expect(local).toMatchObject({ synced: false });
    expect((await f.leaf.kanban.getKanbanTask(own.id))?.title).toBe("Renamed there");
  });

  test("with the leaf disconnected, ticket changes wait on the board and a build is refused, not queued", async () => {
    const f = await setup();
    await f.ticketOnNode("create", { requestId: "seen", title: "Seen before" });
    f.state.connected = false;
    const created = await f.ticketOnNode("create", { requestId: "later", title: "Made offline" });
    expect(created).toMatchObject({
      synced: true,
      sync: {
        state: "offline",
        message: expect.stringContaining("Queued until Build box reconnects"),
      },
    });
    const id = (created.ticket as { id: string }).id;
    await expect(f.build("build-offline", id)).rejects.toThrow(
      "launches, builds and reviews on another machine are not queued",
    );
    expect(f.started).toEqual([]);
    // Reads fall back to the board, saying so.
    const listed = await f.ticketOnNode("list", {});
    expect(String(listed.note)).toContain("Build box is not connected");
    f.state.connected = true;
    await f.ticketSync.sync("bk_leaf");
    expect(await f.leaf.kanban.getKanbanTask(id)).toMatchObject({ title: "Made offline" });
    await f.build("build-online", id);
    expect(f.started).toHaveLength(1);
  });
});

describe("labels with nodeId", () => {
  test("creates and updates labels on the shared board and its syncing leaf", async () => {
    const f = await setup();
    const created = await f.ticketOnNode("create", {
      requestId: "labelled",
      title: "Shared",
      labels: ["bug"],
    });
    const id = (created.ticket as { id: string }).id;
    expect(created).toMatchObject({ ticket: { labels: ["bug"] }, sync: { state: "in-sync" } });
    expect((await f.leaf.kanban.getKanbanTask(id))?.labels).toEqual(["bug"]);
    const updated = await f.ticketOnNode("update", { ticketId: id, labels: ["BUG", "ui"] });
    expect(updated).toMatchObject({
      ticket: { labels: ["bug", "ui"] },
      sync: { state: "in-sync" },
    });
    expect((await f.leaf.kanban.getKanbanTask(id))?.labels).toEqual(["bug", "ui"]);
    await f.ticketOnNode("update", { ticketId: id, labels: [] });
    expect((await f.leaf.kanban.getKanbanTask(id))?.labels).toBeUndefined();
  });

  test.each([true, false])(
    "updates leaf-only labels when ticket-sync capability is %s",
    async (capability) => {
      const f = await setup({ capability });
      const ticket = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "Leaf only", "", {
        labels: ["bug"],
      });
      const updated = await f.ticketOnNode("update", {
        ticketId: ticket.id,
        labels: ["BUG", "ui"],
      });
      expect(updated).toMatchObject({ ticket: { labels: ["bug", "ui"] } });
      expect((await f.leaf.kanban.getKanbanTask(ticket.id))?.labels).toEqual(["bug", "ui"]);
      expect(await f.world.storage.kanban.getKanbanTask(ticket.id)).toBeNull();
      const cleared = await f.ticketOnNode("update", { ticketId: ticket.id, labels: [] });
      expect((cleared.ticket as { labels?: string[] }).labels).toBeUndefined();
    },
  );

  test("forwards labels on create to a leaf without ticket sync", async () => {
    const f = await setup({ capability: false });
    const created = await f.ticketOnNode("create", {
      requestId: "leaf",
      title: "Leaf only",
      labels: ["bug"],
    });
    expect(created).toMatchObject({ ticket: { labels: ["bug"] }, synced: false });
    expect((await f.leaf.kanban.getKanbanTasks(f.leafProject.id))[0]?.labels).toEqual(["bug"]);
    expect(await f.world.storage.kanban.getKanbanTasks(f.scope.projectId)).toEqual([]);
  });

  test.each([true, false])(
    "warns when a pre-label leaf ignores update labels (sync=%s)",
    async (capability) => {
      const f = await setup({ capability, ignoresLabels: true });
      const ticket = await f.leaf.kanban.addKanbanTask(f.leafProject.id, "Leaf only", "");
      const updated = await f.ticketOnNode("update", {
        ticketId: ticket.id,
        labels: ["bug"],
        title: "Edited",
      });
      expect(updated).toMatchObject({
        ticket: { title: "Edited" },
        synced: false,
        sync: {
          state: "update-required",
          message: expect.stringContaining("without the requested labels"),
        },
      });
      expect((await f.leaf.kanban.getKanbanTask(ticket.id))?.labels).toBeUndefined();
    },
  );

  test("warns when a pre-label leaf ignores create labels", async () => {
    const f = await setup({ capability: false, ignoresLabels: true });
    expect(
      await f.ticketOnNode("create", {
        requestId: "old-labels",
        title: "Leaf only",
        labels: ["bug"],
      }),
    ).toMatchObject({
      synced: false,
      sync: {
        state: "update-required",
        message: expect.stringContaining("without the requested labels"),
      },
    });
  });
});

describe("an older leaf", () => {
  test("keeps its own tickets, says to update it, and refuses to build a board ticket", async () => {
    const f = await setup({ capability: false });
    const created = await f.ticketOnNode("create", { requestId: "old", title: "Made there" });
    expect(created).toMatchObject({
      synced: false,
      sync: { state: "update-required", message: expect.stringContaining("Update that machine") },
    });
    const id = (created.ticket as { id: string; projectId: string }).id;
    expect((created.ticket as { projectId: string }).projectId).toBe(f.leafProject.id);
    expect(await f.world.storage.kanban.getKanbanTask(id)).toBeNull();
    // A leaf-local id builds as before.
    await f.build("build-local", id);
    expect(f.started).toEqual([
      expect.objectContaining({ source: { type: "kanban", taskId: id } }),
    ]);
    // A board ticket cannot be built there; nothing is sent.
    const board = await f.world.storage.kanban.addKanbanTask(f.scope.projectId, "Board only", "");
    await expect(f.build("build-board", board.id)).rejects.toThrow(
      "cannot sync tickets, so it cannot build ticket",
    );
    expect(f.started).toHaveLength(1);
    expect(f.routed).not.toContain("apply_ticket_sync");
  });
});

test("offline first contact keeps create and update on the command board", async () => {
  const f = await setup();
  f.state.connected = false;
  const created = await f.ticketOnNode("create", { requestId: "first-offline", title: "Queued" });
  const id = (created.ticket as { id: string }).id;
  await f.ticketOnNode("update", { ticketId: id, title: "Updated offline" });
  expect(await f.world.storage.kanban.getKanbanTask(id)).toMatchObject({
    title: "Updated offline",
  });
  f.state.connected = true;
  await f.ticketSync.sync("bk_leaf");
  expect(await f.leaf.kanban.getKanbanTask(id)).toMatchObject({ title: "Updated offline" });
});

test("remote admission uses completed sync and leaf copy despite unrelated behind status", async () => {
  const f = await setup();
  const task = await f.world.storage.kanban.addKanbanTask(f.scope.projectId, "Target", "");
  const sync = f.ticketSync.sync.bind(f.ticketSync);
  let concurrent: Promise<unknown> | undefined;
  f.ticketSync.sync = async (nodeId) => {
    const result = await sync(nodeId);
    await f.world.storage.kanban.addKanbanTask(f.scope.projectId, "Unrelated change", "");
    concurrent = sync(nodeId);
    return result;
  };
  await f.build("racing-status", task.id);
  await concurrent;
  expect(f.started).toHaveLength(1);
});

test("a started build returns a warning if work location cannot be persisted", async () => {
  const f = await setup();
  const task = await f.world.storage.kanban.addKanbanTask(f.scope.projectId, "Target", "");
  f.world.storage.ticketSync.recordTicketRemoteWork = async () => {
    throw new Error("disk failure");
  };
  const result = await f.build("work-write-failed", task.id);
  expect(result.warning).toContain("build started");
  expect(f.started).toHaveLength(1);
});

test("a leaf without build-origin capability refuses before ticket sync or build admission", async () => {
  const f = await setup({ buildOriginCapability: false });
  const task = await f.world.storage.kanban.addKanbanTask(f.scope.projectId, "Target", "");
  await expect(f.build("legacy-build-origin", task.id)).rejects.toThrow(
    "Update this node before launching a coordinator build",
  );
  expect(f.started).toEqual([]);
  expect(f.routed).not.toContain("apply_ticket_sync");
  expect(f.routed).not.toContain("start_controller_build_pipeline");
  expect(
    await f.world.storage.coordinators.listCoordinatorWorkflowAssociations(f.scope.projectId),
  ).toEqual([]);
});
