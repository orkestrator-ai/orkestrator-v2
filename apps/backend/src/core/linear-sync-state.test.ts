import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { linearKeyFingerprint } from "./linear-boards.js";
import { applyLinearRevocations, type LinearSyncStorage } from "./linear-sync-state.js";
import { StorageService } from "./storage.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function storage(): Promise<StorageService> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-linear-sync-state-"));
  directories.push(dataDir);
  const service = new StorageService(dataDir);
  services.push(service);
  await service.init();
  return service;
}

/** The service, with the revocation read held until `release` is called. */
function heldRevocations(service: StorageService) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading!: () => void;
  const reached = new Promise<void>((resolve) => {
    reading = resolve;
  });
  const held: LinearSyncStorage = {
    loadProjects: () => service.loadProjects(),
    kanban: service.kanban,
    linear: {
      listLinearBoardLinks: () => service.linear.listLinearBoardLinks(),
      mergeLinearBoardLinks: (links, keys) => service.linear.mergeLinearBoardLinks(links, keys),
      mergeLinearRevocations: (revocations) => service.linear.mergeLinearRevocations(revocations),
      listLinearRevocations: async () => {
        const revocations = await service.linear.listLinearRevocations();
        reading();
        await gate;
        return revocations;
      },
    },
  };
  return { held, release, reached };
}

const KEY = "lin_api_shared";

describe("applyLinearRevocations", () => {
  test("clears a connection made before a disconnect of its key", async () => {
    const service = await storage();
    await service.kanban.saveLinearAuth(KEY, { id: "v", name: "Ada" });
    await Bun.sleep(5);
    service.linear.mergeLinearRevocations([
      { keyFingerprint: linearKeyFingerprint(KEY), revokedAt: new Date().toISOString() },
    ]);
    expect(await applyLinearRevocations(service)).toBe(true);
    expect(await service.kanban.getLinearAuth()).toBeNull();
  });

  for (const [name, nextKey] of [
    ["the same key", KEY],
    ["a different key", "lin_api_other"],
  ] as const) {
    test(`a reconnect with ${name} saved while the disconnects are read survives`, async () => {
      const service = await storage();
      await service.kanban.saveLinearAuth(KEY, { id: "v", name: "Ada" });
      await Bun.sleep(5);
      service.linear.mergeLinearRevocations([
        { keyFingerprint: linearKeyFingerprint(KEY), revokedAt: new Date().toISOString() },
      ]);
      await Bun.sleep(5);
      const { held, release, reached } = heldRevocations(service);
      const applying = applyLinearRevocations(held);
      await reached;
      // The old connection was read; a newer one is saved before the check.
      await service.kanban.saveLinearAuth(nextKey, { id: "v", name: "Ada" });
      release();
      expect(await applying).toBe(false);
      expect((await service.kanban.getLinearAuth())?.apiKey).toBe(nextKey);
    });
  }
});
