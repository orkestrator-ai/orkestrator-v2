import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { unknownCommand } from "@orkestrator/protocol/contract/errors";

import { linearKeyFingerprint } from "../linear-boards.js";
import { applyLinearSyncState, readLinearSyncState } from "../linear-sync-state.js";
import { StorageService } from "../storage.js";
import { NodeLinearSync, type LinearSyncLink } from "./node-linear-sync.js";

const directories: string[] = [];
const services: StorageService[] = [];
const syncs: NodeLinearSync[] = [];

async function storage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-linear-sync-"));
  directories.push(dataDir);
  const service = new StorageService(dataDir);
  services.push(service);
  await service.init();
  return service;
}

afterEach(async () => {
  for (const sync of syncs.splice(0)) sync.dispose();
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const REPO = "repo:github.com/acme/web";
const LEAF = "leaf-node";

/** A leaf behind a fake link that runs the leaf's real handlers on its own storage. */
function leafLink(leaf: StorageService, options: { older?: boolean } = {}) {
  const calls: string[] = [];
  const link: LinearSyncLink = {
    connected: true,
    invokeCommand: (async (def: { name: string }, args: Record<string, unknown>) => {
      calls.push(def.name);
      if (options.older) throw unknownCommand(def.name);
      if (def.name === "get_linear_sync_state") return readLinearSyncState(leaf);
      if (def.name === "apply_linear_sync_state") return applyLinearSyncState(leaf, args);
      throw new Error(`unexpected ${def.name}`);
    }) as LinearSyncLink["invokeCommand"],
  };
  return { link, calls };
}

function commandSync(command: StorageService, link: LinearSyncLink) {
  const sync = new NodeLinearSync({
    selfId: async () => "command-node",
    link: (nodeId) => (nodeId === LEAF ? link : null),
    nodes: async () => [{ nodeId: LEAF, displayName: "Laptop", available: true }],
    storage: command,
    isCommandNode: () => true,
    debounceMs: 1,
  });
  syncs.push(sync);
  return sync;
}

describe("NodeLinearSync", () => {
  test("a link made on the leaf reaches the command node, and one made here reaches the leaf", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    leaf.linear.saveLinearBoardLink(
      { key: REPO, projectId: "leaf-project", teamId: "team-1", teamKey: "ENG" },
      new Set([REPO]),
    );
    const { link } = leafLink(leaf);
    const sync = commandSync(command, link);

    await sync.sync(LEAF);
    const here = await command.linear.getLinearBoardLink(REPO);
    expect(here).toMatchObject({ teamId: "team-1", teamKey: "ENG" });
    // The leaf's project id stays on the leaf.
    expect(here?.projectId).toBeUndefined();

    // Changed on the command node later: the leaf takes it on the next pass.
    await Bun.sleep(5);
    command.linear.saveLinearBoardLink(
      { key: REPO, teamId: "team-2", teamKey: "OPS" },
      new Set([REPO]),
    );
    await sync.sync(LEAF);
    // The leaf finds it by the repository key; a synced link names no project.
    expect(await leaf.linear.getLinearBoardLink(REPO)).toMatchObject({
      teamId: "team-2",
      teamKey: "OPS",
    });

    // A clear travels as a tombstone.
    await Bun.sleep(5);
    leaf.linear.clearLinearBoardLink(REPO);
    await sync.sync(LEAF);
    expect(await command.linear.getLinearBoardLink(REPO)).toBeNull();
  });

  test("project-only links stay on their machine", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    leaf.linear.saveLinearBoardLink(
      { key: "project:p1", teamId: "team-1" },
      new Set(["project:p1"]),
    );
    const sync = commandSync(command, leafLink(leaf).link);
    await sync.sync(LEAF);
    expect(await command.linear.listLinearBoardLinks()).toEqual([]);
  });

  test("a disconnect here clears the same key on the leaf, but not a different key", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    await leaf.kanban.saveLinearAuth("lin_api_shared", { id: "v", name: "Ada" });
    await Bun.sleep(5);
    command.linear.mergeLinearRevocations([
      {
        keyFingerprint: linearKeyFingerprint("lin_api_shared"),
        revokedAt: new Date().toISOString(),
      },
    ]);
    const sync = commandSync(command, leafLink(leaf).link);
    await sync.sync(LEAF);
    expect(await leaf.kanban.getLinearAuth()).toBeNull();
    expect(await sync.nodeConnections()).toEqual([
      expect.objectContaining({ nodeId: LEAF, nodeName: "Laptop", connected: false }),
    ]);

    // A different key on the leaf is left alone.
    await leaf.kanban.saveLinearAuth("lin_api_other", { id: "v", name: "Ada" });
    await sync.sync(LEAF);
    expect((await leaf.kanban.getLinearAuth())?.apiKey).toBe("lin_api_other");
  });

  test("a key connected again after the disconnect stays connected", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    command.linear.mergeLinearRevocations([
      {
        keyFingerprint: linearKeyFingerprint("lin_api_shared"),
        revokedAt: new Date().toISOString(),
      },
    ]);
    await Bun.sleep(5);
    await leaf.kanban.saveLinearAuth("lin_api_shared", { id: "v", name: "Ada" });
    const sync = commandSync(command, leafLink(leaf).link);
    await sync.sync(LEAF);
    expect((await leaf.kanban.getLinearAuth())?.apiKey).toBe("lin_api_shared");
    const [connection] = await sync.nodeConnections();
    expect(connection).toMatchObject({
      connected: true,
      viewerName: "Ada",
      keyFingerprint: linearKeyFingerprint("lin_api_shared"),
    });
    expect(JSON.stringify(connection)).not.toContain("lin_api_shared");
  });

  test("a disconnect on the leaf reaches the command node's key", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    await command.kanban.saveLinearAuth("lin_api_shared", { id: "v", name: "Ada" });
    await Bun.sleep(5);
    leaf.linear.mergeLinearRevocations([
      {
        keyFingerprint: linearKeyFingerprint("lin_api_shared"),
        revokedAt: new Date().toISOString(),
      },
    ]);
    const sync = commandSync(command, leafLink(leaf).link);
    await sync.sync(LEAF);
    expect(await command.kanban.getLinearAuth()).toBeNull();
  });

  test("a reading of a key disconnected since is reported disconnected before the next pass", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    await leaf.kanban.saveLinearAuth("lin_api_shared", { id: "v", name: "Ada" });
    const sync = commandSync(command, leafLink(leaf).link);
    await sync.sync(LEAF);
    expect(await sync.nodeConnections()).toEqual([
      expect.objectContaining({
        connected: true,
        keyFingerprint: linearKeyFingerprint("lin_api_shared"),
      }),
    ]);

    // Disconnect everywhere here; the leaf has not been synced since.
    await Bun.sleep(5);
    command.linear.mergeLinearRevocations([
      {
        keyFingerprint: linearKeyFingerprint("lin_api_shared"),
        revokedAt: new Date().toISOString(),
      },
    ]);
    const [reading] = await sync.nodeConnections();
    expect(reading).toMatchObject({ nodeId: LEAF, connected: false });
    // Nothing left to offer as "Use it here".
    expect(reading?.keyFingerprint).toBeUndefined();
    expect(reading?.viewerName).toBeUndefined();
    // The leaf still holds it until that pass.
    expect((await leaf.kanban.getLinearAuth())?.apiKey).toBe("lin_api_shared");
  });

  test("a change read from one leaf reaches the other leaves on the debounced pass", async () => {
    const [command, leafA, leafB] = await Promise.all([storage(), storage(), storage()]);
    leafA.linear.saveLinearBoardLink({ key: REPO, teamId: "team-1" }, new Set([REPO]));
    const a = leafLink(leafA);
    const b = leafLink(leafB);
    const sync = new NodeLinearSync({
      selfId: async () => "command-node",
      link: (nodeId) => (nodeId === "leaf-a" ? a.link : nodeId === "leaf-b" ? b.link : null),
      nodes: async () => [
        { nodeId: "leaf-a", available: true },
        { nodeId: "leaf-b", available: true },
      ],
      storage: command,
      isCommandNode: () => true,
      debounceMs: 1,
    });
    syncs.push(sync);
    await sync.sync("leaf-a");
    expect(b.calls).toEqual([]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await leafB.linear.getLinearBoardLink(REPO)) break;
      await Bun.sleep(5);
    }
    expect(await leafB.linear.getLinearBoardLink(REPO)).toMatchObject({ teamId: "team-1" });
  });

  test("two machines that link different repositories to one board converge on one owner", async () => {
    const API = "repo:github.com/acme/api";
    const [command, leaf] = await Promise.all([storage(), storage()]);
    // The leaf has both repositories; each was linked to team-1 on a different machine.
    for (const [id, gitUrl] of [
      ["leaf-web", "https://github.com/acme/web.git"],
      ["leaf-api", "https://github.com/acme/api.git"],
    ] as const) {
      await leaf.addProject({
        id,
        name: id,
        gitUrl,
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      });
    }
    leaf.linear.saveLinearBoardLink({ key: REPO, teamId: "team-1" }, new Set([REPO, API]));
    await Bun.sleep(5);
    command.linear.saveLinearBoardLink({ key: API, teamId: "team-1" }, new Set([API]));

    const sync = commandSync(command, leafLink(leaf).link);
    await sync.sync(LEAF);
    // The leaf keeps the newer link (api) and records why web lost its board.
    expect(await leaf.linear.getLinearBoardLink(API)).toMatchObject({ teamId: "team-1" });
    expect(await leaf.linear.getLinearBoardLink(REPO)).toBeNull();
    expect(
      (await leaf.linear.listLinearBoardLinks()).find((link) => link.key === REPO),
    ).toMatchObject({ cleared: true, supersededBy: API });

    // The clear travels back: the command node settles on the same owner.
    await sync.sync(LEAF);
    expect(await command.linear.getLinearBoardLink(REPO)).toBeNull();
    expect(await command.linear.getLinearBoardLink(API)).toMatchObject({ teamId: "team-1" });
  });

  test("an older leaf is left as it is", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    command.linear.saveLinearBoardLink({ key: REPO, teamId: "team-1" }, new Set([REPO]));
    const { link, calls } = leafLink(leaf, { older: true });
    const sync = commandSync(command, link);
    await sync.sync(LEAF);
    expect(calls).toEqual(["get_linear_sync_state"]);
    expect(await sync.nodeConnections()).toEqual([]);
  });

  test("a leaf syncs nothing itself", async () => {
    const [command, leaf] = await Promise.all([storage(), storage()]);
    const { link, calls } = leafLink(leaf);
    const sync = new NodeLinearSync({
      selfId: async () => "x",
      link: () => link,
      nodes: async () => [{ nodeId: LEAF, available: true }],
      storage: command,
      isCommandNode: () => false,
    });
    syncs.push(sync);
    await sync.syncAll();
    await sync.sync(LEAF);
    expect(calls).toEqual([]);
  });
});
