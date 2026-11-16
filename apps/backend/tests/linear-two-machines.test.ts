import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { linearKeyFingerprint } from "../src/core/linear-boards";
import { NodeLinearSync, type LinearSyncLink } from "../src/core/nodes/node-linear-sync";
import { StorageService } from "../src/core/storage";
import { createCommandFixtures } from "./command-fixtures";

/**
 * To-do 7767 task 10's two-machine walk-through, run deterministically: two
 * machines, each with its own real storage and the real command handlers, a
 * node link that calls the leaf's handlers, the command node's real
 * `NodeLinearSync`, and a faked Linear API. The same steps against two live
 * `dev:test` profiles and a throwaway Linear workspace are in the manual
 * checklist (to-do 7568).
 */

const { createCommandRegistry, createContext, createEnvironment } = await createCommandFixtures();

const originalFetch = globalThis.fetch;
const directories: string[] = [];
const services: StorageService[] = [];
const syncs: NodeLinearSync[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const sync of syncs.splice(0)) sync.dispose();
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const KEY = "lin_api_throwaway_secret";
const COMMAND_ID = "0123456789abcdef0123456789abcdef";
const LEAF_ID = "fedcba9876543210fedcba9876543210";

const TEAM = {
  id: "team-1",
  key: "ENG",
  name: "Engineering",
  projects: { nodes: [{ id: "lp-1", name: "Website", state: "started" }] },
};

type GraphqlRequest = { query: string; variables: Record<string, unknown>; key: string };

/** Linear, answering by operation name; it accepts only `KEY`. */
function fakeLinear() {
  const requests: GraphqlRequest[] = [];
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const parsed = JSON.parse(String(init?.body)) as Omit<GraphqlRequest, "key">;
    const request = { ...parsed, key: headers.Authorization ?? "" };
    requests.push(request);
    const name = /(?:query|mutation)\s+(\w+)/.exec(request.query)?.[1] ?? "";
    const data =
      request.key !== KEY
        ? null
        : name === "OrkestratorLinearViewer"
          ? { viewer: { id: "viewer-1", name: "Ada", email: "ada@example.com" } }
          : name === "OrkestratorLinearTeam"
            ? { team: TEAM }
            : name === "OrkestratorLinearIssues"
              ? {
                  issues: {
                    nodes: [
                      {
                        id: "issue-1",
                        identifier: "ENG-1",
                        title: "Fix the header",
                        updatedAt: "2026-11-16T10:00:00.000Z",
                        state: { id: "state-1", name: "Todo", type: "unstarted", position: 1 },
                        team: { id: "team-1", key: "ENG", name: "Engineering" },
                        project: { id: "lp-1", name: "Website" },
                        labels: { nodes: [] },
                      },
                    ],
                    pageInfo: { hasNextPage: false },
                  },
                }
              : undefined;
    if (data === undefined) throw new Error(`Unexpected Linear operation ${name}`);
    const body = data ? { data } : { errors: [{ message: "Authentication required" }] };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return requests;
}

async function realStorage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-linear-two-machines-"));
  directories.push(dataDir);
  const service = new StorageService(dataDir);
  services.push(service);
  await service.init();
  return service;
}

type Project = { id: string; name: string; gitUrl: string };

/** One machine: real Linear and Kanban stores, its own projects, the real handlers. */
async function machine(projects: Project[]) {
  const real = await realStorage();
  const { context } = createContext(createEnvironment());
  const loadProjects = mock(async () => projects);
  Object.assign(context.storage, {
    kanban: real.kanban,
    linear: real.linear,
    getProject: mock(async (id: string) => projects.find((project) => project.id === id) ?? null),
    loadProjects,
  });
  const commands = createCommandRegistry();
  const run = (name: string, args: Record<string, unknown> = {}) => {
    const handler = commands.get(name);
    if (!handler) throw new Error(`No handler for ${name}`);
    return Promise.resolve(handler(args, context));
  };
  return {
    context,
    real,
    run,
    syncStorage: { loadProjects, kanban: real.kanban, linear: real.linear },
  };
}

/**
 * A laptop (leaf) and a home server (command node) with the same repository
 * under different project ids, the leaf attached to the command node.
 */
async function linkedMachines() {
  const leaf = await machine([
    { id: "laptop-web", name: "Web", gitUrl: "https://github.com/acme/web.git" },
  ]);
  const command = await machine([
    { id: "server-web", name: "Web (server)", gitUrl: "git@github.com:acme/web.git" },
  ]);
  const linkCalls: string[] = [];
  Object.assign(leaf.context, {
    nodes: { mode: () => "leaf", listControllers: () => [{ controllerId: COMMAND_ID }] },
  });
  const link: LinearSyncLink = {
    connected: true,
    invokeCommand: (async (def: { name: string }, args: Record<string, unknown>) => {
      linkCalls.push(def.name);
      return leaf.run(def.name, args);
    }) as LinearSyncLink["invokeCommand"],
  };
  const sync = new NodeLinearSync({
    selfId: async () => COMMAND_ID,
    link: (nodeId) => (nodeId === LEAF_ID ? link : null),
    nodes: async () => [{ nodeId: LEAF_ID, displayName: "Laptop", available: true }],
    storage: command.syncStorage,
    isCommandNode: () => true,
    debounceMs: 60_000,
  });
  syncs.push(sync);
  Object.assign(command.context, {
    nodes: {
      mode: () => "command",
      selfIdentity: async () => COMMAND_ID,
      link: (nodeId: string) => (nodeId === LEAF_ID ? link : null),
    },
    nodeCoordination: { linearSync: sync },
  });
  return { leaf, command, sync, linkCalls };
}

/** Lets a later timestamp differ from an earlier one at millisecond resolution. */
const tick = () => Bun.sleep(5);

describe("Linear on two linked machines (to-do 7767 task 10)", () => {
  test("a board linked on the leaf reaches the command node, which copies the key once; a disconnect there clears the leaf", async () => {
    const requests = fakeLinear();
    const { leaf, command, sync, linkCalls } = await linkedMachines();

    // 1. Connect on the leaf and link its project to a board.
    const connected = (await leaf.run("connect_linear", { apiKey: ` ${KEY} ` })) as {
      keyFingerprint?: string;
    };
    expect(connected).toMatchObject({ connected: true, keyFingerprint: linearKeyFingerprint(KEY) });
    await leaf.run("set_linear_board_link", {
      projectId: "laptop-web",
      teamId: "team-1",
      linearProjectId: "lp-1",
    });

    // Before a sync pass the command node knows neither.
    await expect(
      command.run("get_linear_board_link", { projectId: "server-web" }),
    ).resolves.toEqual({});
    await expect(command.run("get_linear_connection")).resolves.toEqual({
      connected: false,
      hasToken: false,
    });

    // 2. A sync pass: the same repository's project on the command node gets the board.
    await sync.sync(LEAF_ID);
    expect(linkCalls).toEqual(["get_linear_sync_state", "apply_linear_sync_state"]);
    await expect(
      command.run("get_linear_board_link", { projectId: "server-web" }),
    ).resolves.toMatchObject({
      link: {
        key: "repo:github.com/acme/web",
        teamId: "team-1",
        teamKey: "ENG",
        linearProjectId: "lp-1",
        linearProjectName: "Website",
      },
    });

    // 3. The command node offers "Use it here" for the laptop, without the key.
    const offers = await command.run("get_linear_node_connections");
    expect(offers).toEqual([
      expect.objectContaining({
        nodeId: LEAF_ID,
        nodeName: "Laptop",
        connected: true,
        viewerName: "Ada",
        keyFingerprint: linearKeyFingerprint(KEY),
      }),
    ]);
    expect(JSON.stringify(offers)).not.toContain(KEY);
    // Without a key here, the board cannot be read yet.
    await expect(command.run("get_linear_issues", { projectId: "server-web" })).rejects.toThrow();

    // 4. Use it here: one export over the link, verified, stored; the key is never returned.
    const copied = await command.run("copy_linear_connection_from_node", { nodeId: LEAF_ID });
    expect(linkCalls.at(-1)).toBe("export_linear_connection");
    expect(copied).toMatchObject({
      connected: true,
      viewer: { name: "Ada" },
      keyFingerprint: linearKeyFingerprint(KEY),
    });
    expect(JSON.stringify(copied)).not.toContain(KEY);
    expect((await command.real.kanban.getLinearAuth())?.apiKey).toBe(KEY);

    // The command node now lists the same board, filtered to it.
    await expect(
      command.run("get_linear_issues", { projectId: "server-web" }),
    ).resolves.toMatchObject([{ identifier: "ENG-1" }]);
    expect(requests.at(-1)?.variables.filter).toEqual({
      team: { id: { eq: "team-1" } },
      project: { id: { eq: "lp-1" } },
    });

    // 5. Disconnect on the command node: the next pass clears the leaf's copy.
    await tick();
    await command.run("disconnect_linear");
    // Until that pass the laptop is no longer offered.
    expect(await command.run("get_linear_node_connections")).toEqual([
      expect.objectContaining({ nodeId: LEAF_ID, connected: false }),
    ]);
    expect((await leaf.real.kanban.getLinearAuth())?.apiKey).toBe(KEY);
    await sync.sync(LEAF_ID);
    await expect(leaf.run("get_linear_connection")).resolves.toEqual({
      connected: false,
      hasToken: false,
    });
    await expect(
      command.run("copy_linear_connection_from_node", { nodeId: LEAF_ID }),
    ).rejects.toThrow("That machine is not connected to Linear.");

    // Board links survive the disconnect on both machines, so reconnecting restores everything.
    await expect(
      leaf.run("get_linear_board_link", { projectId: "laptop-web" }),
    ).resolves.toMatchObject({ link: { teamId: "team-1" } });
    await expect(
      command.run("get_linear_board_link", { projectId: "server-web" }),
    ).resolves.toMatchObject({ link: { teamId: "team-1" } });

    // 6. Connecting the same key again after the disconnect stays connected through a pass.
    await tick();
    await leaf.run("connect_linear", { apiKey: KEY });
    await sync.sync(LEAF_ID);
    expect((await leaf.real.kanban.getLinearAuth())?.apiKey).toBe(KEY);
    expect(await command.run("get_linear_node_connections")).toEqual([
      expect.objectContaining({ nodeId: LEAF_ID, connected: true }),
    ]);

    // The key was only ever sent to Linear.
    for (const request of requests) expect(JSON.stringify(request.variables)).not.toContain(KEY);
  });

  test("a disconnect on the leaf clears the command node's copy, and a board cleared there clears the leaf's", async () => {
    fakeLinear();
    const { leaf, command, sync } = await linkedMachines();
    await leaf.run("connect_linear", { apiKey: KEY });
    await leaf.run("set_linear_board_link", { projectId: "laptop-web", teamId: "team-1" });
    await sync.sync(LEAF_ID);
    await command.run("copy_linear_connection_from_node", { nodeId: LEAF_ID });
    expect((await command.real.kanban.getLinearAuth())?.apiKey).toBe(KEY);

    await tick();
    await leaf.run("disconnect_linear");
    await sync.sync(LEAF_ID);
    await expect(command.run("get_linear_connection")).resolves.toEqual({
      connected: false,
      hasToken: false,
    });

    await tick();
    await expect(
      command.run("clear_linear_board_link", { projectId: "server-web" }),
    ).resolves.toEqual({ cleared: true });
    await sync.sync(LEAF_ID);
    await expect(leaf.run("get_linear_board_link", { projectId: "laptop-web" })).resolves.toEqual(
      {},
    );
  });
});
