import { afterEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { linearKeyFingerprint } from "../src/core/linear-boards";
import { NodeLinearSync, type LinearSyncLink } from "../src/core/nodes/node-linear-sync";
import { StorageService } from "../src/core/storage/service";
import { createCommandFixtures } from "./command-fixtures";

/**
 * To-do 7767 (retired) task 10's two-machine walk-through, run deterministically: two
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

const MERGED = { id: "label-merged", name: "merged" };
/** What was written to Linear's one issue. */
const written = { labels: [] as Array<typeof MERGED>, comments: [] as string[] };

/** Linear, answering by operation name; it accepts only `KEY`. */
function fakeLinear() {
  written.labels = [];
  written.comments = [];
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
            : name === "OrkestratorLinearIssueLabels"
              ? {
                  issue: {
                    id: "issue-1",
                    team: { id: "team-1" },
                    labels: { nodes: written.labels, pageInfo: { hasNextPage: false } },
                  },
                }
              : name === "OrkestratorLinearLabelsByName"
                ? { issueLabels: { nodes: [MERGED], pageInfo: { hasNextPage: false } } }
                : name === "OrkestratorLinearIssueAddLabel"
                  ? (written.labels.push(MERGED), { issueAddLabel: { success: true } })
                  : name === "OrkestratorLinearCompletionComments"
                    ? {
                        issue: {
                          comments: {
                            nodes: written.comments.map((body, index) => ({
                              id: `comment-${index + 1}`,
                              body,
                            })),
                            pageInfo: { hasNextPage: false },
                          },
                        },
                      }
                    : name === "OrkestratorLinearCompletionComment"
                      ? (written.comments.push(String(request.variables.body)),
                        {
                          commentCreate: {
                            success: true,
                            comment: {
                              id: `comment-${written.comments.length}`,
                              createdAt: "2026-11-25T12:00:00.000Z",
                            },
                          },
                        })
                      : name === "OrkestratorLinearIssues"
                        ? {
                            issues: {
                              nodes: [
                                {
                                  id: "issue-1",
                                  identifier: "ENG-1",
                                  title: "Fix the header",
                                  updatedAt: "2026-11-16T10:00:00.000Z",
                                  state: {
                                    id: "state-1",
                                    name: "Todo",
                                    type: "unstarted",
                                    position: 1,
                                  },
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
type LinkCall = { name: string; args: Record<string, unknown>; result: unknown };

/** Only the explicit key-copy response may carry a credential across the link. */
function expectKeyOnlyInExport(linkCalls: LinkCall[]) {
  expect(linkCalls.some((call) => call.name === "get_linear_sync_state")).toBe(true);
  expect(linkCalls.some((call) => call.name === "apply_linear_sync_state")).toBe(true);
  expect(
    linkCalls.filter(
      (call) =>
        call.name === "export_linear_connection" && JSON.stringify(call.result).includes(KEY),
    ),
  ).toHaveLength(1);
  for (const call of linkCalls) {
    expect(JSON.stringify(call.args)).not.toContain(KEY);
    if (call.name !== "export_linear_connection") {
      expect(JSON.stringify(call.result)).not.toContain(KEY);
    }
  }
}

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
  const linkCalls: LinkCall[] = [];
  Object.assign(leaf.context, {
    nodes: { mode: () => "leaf", listControllers: () => [{ controllerId: COMMAND_ID }] },
  });
  const link: LinearSyncLink = {
    connected: true,
    invokeCommand: (async (def: { name: string }, args: Record<string, unknown>) => {
      const capturedArgs = structuredClone(args);
      const result = await leaf.run(def.name, args);
      linkCalls.push({ name: def.name, args: capturedArgs, result: structuredClone(result) });
      return result;
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

describe("Linear on two linked machines (to-do 7767 (retired) task 10)", () => {
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
    expect(linkCalls.map((call) => call.name)).toEqual([
      "get_linear_sync_state",
      "apply_linear_sync_state",
    ]);
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
    expect(linkCalls.at(-1)?.name).toBe("export_linear_connection");
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

    expectKeyOnlyInExport(linkCalls);
  });

  test("a disconnect on the leaf clears the command node's copy, and a board cleared there clears the leaf's", async () => {
    fakeLinear();
    const { leaf, command, sync, linkCalls } = await linkedMachines();
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
    expectKeyOnlyInExport(linkCalls);
  });
});

describe("a build on a machine that is not connected to Linear", () => {
  const PR = "https://github.com/acme/web/pull/12";

  /** A leaf that owes a `merged` label and a completion comment, as its queues hold them. */
  function oweWrites(leaf: Awaited<ReturnType<typeof machine>>) {
    const now = new Date(Date.now() - 1_000);
    leaf.real.linear.enqueueLinearMergedLabel(
      {
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        pipelineId: "pipeline-1",
        projectId: "laptop-web",
        prUrl: PR,
      },
      now,
    );
    leaf.real.linear.enqueueLinearPendingComment(
      {
        pipelineId: "pipeline-1",
        projectId: "laptop-web",
        issueId: "issue-1",
        issueIdentifier: "ENG-1",
        outcome: "complete",
        body: "Build completed",
      },
      { error: "Linear is not connected on this machine", nextAttemptAt: now },
      now,
    );
  }

  test("has its label and comment written by the command node, whose key never travels", async () => {
    fakeLinear();
    const { leaf, command, sync, linkCalls } = await linkedMachines();
    await command.run("connect_linear", { apiKey: KEY });
    oweWrites(leaf);
    const posted: unknown[] = [];
    leaf.context.runtime.linearCompletionComments.onPosted(async (comment) => {
      posted.push(comment);
    });

    await sync.sync(LEAF_ID);
    await sync.deliverWrites(LEAF_ID);

    expect(written.labels).toEqual([MERGED]);
    expect(written.comments).toEqual([
      "Build completed\n\n<!-- orkestrator-linear-run:pipeline-1:complete -->",
    ]);
    expect(await leaf.real.linear.listLinearMergedLabels()).toMatchObject([
      { status: "applied", outcome: "added" },
    ]);
    expect(await leaf.real.linear.listLinearPendingComments()).toEqual([]);
    expect(posted).toEqual([
      {
        pipelineId: "pipeline-1",
        outcome: "complete",
        commentId: "comment-1",
        postedAt: "2026-11-25T12:00:00.000Z",
      },
    ]);
    expect(await leaf.real.kanban.getLinearCompletionComment("pipeline-1")).toMatchObject({
      status: "posted",
      outcome: "complete",
      commentId: "comment-1",
    });
    expect(JSON.stringify(linkCalls)).not.toContain(KEY);
    expect(await leaf.real.kanban.getLinearAuth()).toBeNull();

    // The next pass finds nothing owed.
    await sync.deliverWrites(LEAF_ID);
    expect(written.comments).toHaveLength(1);
  });

  test("keeps them for the next pass when Linear refuses, with the reason", async () => {
    fakeLinear();
    const { leaf, command, sync } = await linkedMachines();
    // A key Linear refuses: every write fails.
    await command.real.kanban.saveLinearAuth("lin_api_wrong_workspace", { id: "v", name: "Ada" });
    oweWrites(leaf);
    await sync.deliverWrites(LEAF_ID);

    expect(written).toEqual({ labels: [], comments: [] });
    const [label] = await leaf.real.linear.listLinearMergedLabels();
    const [comment] = await leaf.real.linear.listLinearPendingComments();
    expect(label).toMatchObject({ status: "pending", lastError: "Authentication required" });
    expect(comment).toMatchObject({ attempts: 2, lastError: "Authentication required" });
    for (const record of [label!, comment!]) {
      expect(Date.parse(record.nextAttemptAt)).toBeGreaterThan(Date.now());
    }
  });

  test("a lost report is not a second comment, and two command nodes never take the same write", async () => {
    fakeLinear();
    const { leaf, command } = await linkedMachines();
    await command.run("connect_linear", { apiKey: KEY });
    oweWrites(leaf);
    const first = (await leaf.run("claim_linear_writes", { controllerId: COMMAND_ID })) as {
      writes: Array<{ kind: string }>;
    };
    expect(first.writes.map((write) => write.kind)).toEqual(["completion-comment", "merged-label"]);
    // Claimed: nothing is left for another pass until the claim runs out.
    expect(await leaf.run("claim_linear_writes", { controllerId: COMMAND_ID })).toEqual({
      writes: [],
    });
    const { claimLinearWrites, performLinearWrite, parseLinearOwedWrite, LINEAR_WRITE_CLAIM_MS } =
      await import("../src/core/linear-write-relay");
    const write = parseLinearOwedWrite(first.writes[0])!;
    const stop = new AbortController().signal;
    expect(await performLinearWrite(KEY, write, stop)).toMatchObject({ commentId: "comment-1" });
    // Its report never arrived; the claim runs out and it is taken again.
    const again = await claimLinearWrites(
      leaf.real,
      new Date(Date.now() + LINEAR_WRITE_CLAIM_MS + 1_000),
    );
    expect(again).toHaveLength(2);
    expect(await performLinearWrite(KEY, again[0]!, stop)).toMatchObject({
      commentId: "comment-1",
    });
    expect(written.comments).toHaveLength(1);
  });

  test("a connected leaf writes for itself, and a command node without a key claims nothing", async () => {
    fakeLinear();
    const { leaf, command, sync, linkCalls } = await linkedMachines();
    oweWrites(leaf);
    await sync.deliverWrites(LEAF_ID);
    expect(linkCalls).toEqual([]);

    await command.run("connect_linear", { apiKey: KEY });
    await leaf.real.kanban.saveLinearAuth(KEY);
    await sync.deliverWrites(LEAF_ID);
    expect(linkCalls.map((call) => [call.name, call.result])).toEqual([
      ["claim_linear_writes", { writes: [] }],
    ]);
  });

  test("only an attached command node may claim or settle, and malformed results are ignored", async () => {
    const { leaf } = await linkedMachines();
    oweWrites(leaf);
    for (const name of ["claim_linear_writes", "settle_linear_writes"]) {
      await expect(leaf.run(name, { controllerId: "0".repeat(32), results: [] })).rejects.toThrow();
    }
    expect(
      await leaf.run("settle_linear_writes", {
        controllerId: COMMAND_ID,
        results: [
          null,
          { kind: "merged-label", key: "unknown", applied: "added" },
          { kind: "merged-label", key: `issue-1 ${PR}`, applied: "removed" },
          { kind: "completion-comment", key: "pipeline-1", outcome: "failed", commentId: "c" },
          { kind: "completion-comment", key: "pipeline-1", outcome: "complete" },
        ],
      }),
    ).toEqual({ settled: 0 });
    expect(await leaf.real.linear.listLinearPendingComments()).toHaveLength(1);
    expect((await leaf.real.linear.listLinearMergedLabels())[0]?.status).toBe("pending");
  });

  test("a write no build makes is refused by the command node", async () => {
    const { parseLinearOwedWrite } = await import("../src/core/linear-write-relay");
    for (const write of [
      { kind: "delete-issue", key: "k", issueId: "issue-1" },
      { kind: "completion-comment", key: "x --> y", issueId: "i", outcome: "complete", body: "b" },
      { kind: "completion-comment", key: "p", issueId: "i", outcome: "other", body: "b" },
      {
        kind: "completion-comment",
        key: "p",
        issueId: "i",
        outcome: "complete",
        body: "b".repeat(10_001),
      },
      { kind: "merged-label", key: "k" },
    ]) {
      expect(parseLinearOwedWrite(write)).toBeNull();
    }
  });
});
