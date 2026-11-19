import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { NodeRecord } from "@orkestrator/protocol/command-nodes";
import type { BackendId, RouteId } from "@orkestrator/protocol/federation";

import { LeafControllerSettings } from "./nodes/node-controller-settings.js";
import { StorageService } from "./storage.js";
import { StorageContext } from "./storage-context.js";

const record: NodeRecord = {
  nodeId: "bk_leaf" as never,
  enabled: true,
  routes: [{ id: "primary" as RouteId, kind: "https", enabled: true, origin: "https://leaf.test" }],
  routeOrder: ["primary" as RouteId],
  credential: { token: "leaf-gateway-token-value" },
  fallbackName: "leaf",
  attachment: { status: "attached", attachedAt: "2026-10-21T00:00:00.000Z" },
  addedAt: "2026-10-21T00:00:00.000Z",
  source: "portal",
};

describe("RG-01/RG-02 command-node stores", () => {
  test("the registry round-trips through the sensitive store and the revision advances", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-nodes-"));
    try {
      const storage = new StorageService(dataDir);
      expect((await storage.nodes.getNodeRegistry()).nodes).toEqual([]);
      await storage.nodes.mutateNodeRegistry((current) => ({
        next: { ...current, registrationEnabled: true, nodes: [record] },
        result: undefined,
      }));
      const registry = await storage.nodes.getNodeRegistry();
      expect(registry.revision).toBe(1);
      expect(registry.registrationEnabled).toBe(true);
      expect(registry.nodes).toEqual([record]);
      // Kept in the database, not as a plain JSON file beside it.
      await expect(readFile(path.join(dataDir, "node-registry.json"), "utf8")).rejects.toThrow();
      // A mutation that writes nothing leaves the revision alone.
      await storage.nodes.mutateNodeRegistry(() => ({ next: null, result: undefined }));
      expect((await storage.nodes.getNodeRegistry()).revision).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("unreadable registry entries are dropped instead of failing the store", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-nodes-"));
    try {
      const storage = new StorageService(dataDir);
      await storage.nodes.mutateNodeRegistry((current) => ({
        next: {
          ...current,
          nodes: [record, { ...record, nodeId: "bad id with spaces" as never }],
        },
        result: undefined,
      }));
      await expect(storage.nodes.getNodeRegistry(true)).rejects.toThrow("Incomplete node registry");
      expect((await storage.nodes.getNodeRegistry()).nodes.map((node) => node.nodeId)).toEqual([
        "bk_leaf" as never,
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("attachments round-trip without credentials", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-nodes-"));
    try {
      const storage = new StorageService(dataDir);
      await storage.nodes.mutateNodeAttachments((current) => ({
        next: {
          ...current,
          controllers: [
            {
              controllerId: "bk_command" as never,
              displayName: "Desk",
              portalOrigins: ["https://desk.test"],
              attachedAt: "2026-10-21T00:00:00.000Z",
              lastContactAt: "2026-10-21T00:00:01.000Z",
            },
          ],
        },
        result: undefined,
      }));
      const attachments = await storage.nodes.getNodeAttachments();
      expect(attachments.controllers.map((entry) => entry.portalOrigins)).toEqual([
        ["https://desk.test"],
      ]);
      expect(attachments.detachedControllers).toEqual([]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("portal sidebar layout", () => {
  test("updates replace only the fields they name and the revision advances", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-nodes-"));
    try {
      const storage = new StorageService(dataDir);
      expect(await storage.nodes.getPortalLayout()).toEqual({
        revision: 0,
        machineOrder: [],
        projectOrder: [],
        projectFolders: {},
        repositoryOrder: [],
        environmentOrder: {},
        manualOrderSupported: true,
      });
      await storage.nodes.updatePortalLayout({ machineOrder: ["bk_b", "bk_a"] });
      await storage.nodes.updatePortalLayout({
        projectOrder: ['["bk_a","project","p"]'],
        projectFolders: { '["bk_a","project","p"]': "Work" },
      });
      const layout = await storage.nodes.updateRepositoryEnvironmentOrder({
        repositoryKey: "github.com/o/r",
        order: ['["bk_a","environment","e"]'],
      });
      expect(layout).toEqual({
        revision: 3,
        machineOrder: ["bk_b", "bk_a"],
        projectOrder: ['["bk_a","project","p"]'],
        projectFolders: { '["bk_a","project","p"]': "Work" },
        repositoryOrder: [],
        environmentOrder: { "github.com/o/r": ['["bk_a","environment","e"]'] },
        manualOrderSupported: true,
      });
      expect(await new StorageService(dataDir).nodes.getPortalLayout()).toEqual(layout);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  test("imports an earlier EL01 order before a downgrade can rewrite the legacy file", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-nodes-"));
    const legacy = new StorageContext(dataDir);
    try {
      const file = legacy.file("portal-layout.json");
      await legacy.saveJson(file, { version: 1, revision: 1, environmentOrder: { repo: ["a"] } });
      expect((await new StorageService(dataDir).nodes.getPortalLayout()).environmentOrder).toEqual({
        repo: ["a"],
      });
      await legacy.saveJson(file, { version: 1, revision: 2, machineOrder: ["b"] });
      expect(await new StorageService(dataDir).nodes.getPortalLayout()).toMatchObject({
        revision: 2,
        machineOrder: ["b"],
        environmentOrder: { repo: ["a"] },
      });
    } finally {
      legacy.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("independent repository saves survive concurrent clients and an older layout rewrite", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-nodes-"));
    try {
      const first = new StorageService(dataDir);
      const second = new StorageService(dataDir);
      await first.nodes.updatePortalLayout({ machineOrder: ["old-machine"] });
      expect(await first.nodes.getPortalLayout()).toEqual(await second.nodes.getPortalLayout());
      await Promise.all([
        first.nodes.updateRepositoryEnvironmentOrder({ repositoryKey: "a", order: ["a2", "a1"] }),
        second.nodes.updateRepositoryEnvironmentOrder({ repositoryKey: "b", order: ["b2", "b1"] }),
      ]);
      // The older layout writer serializes only its known fields to its original file.
      const legacy = new StorageContext(dataDir);
      await legacy.saveJson(legacy.file("portal-layout.json"), {
        version: 1,
        revision: 2,
        machineOrder: ["new-machine"],
        projectOrder: [],
        projectFolders: {},
        repositoryOrder: [],
      });
      legacy.close();
      expect(await new StorageService(dataDir).nodes.getPortalLayout()).toMatchObject({
        revision: 4,
        machineOrder: ["new-machine"],
        environmentOrder: { a: ["a2", "a1"], b: ["b2", "b1"] },
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("controller settings round-trip, filter corruption and ignore detached controllers", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-controller-store-"));
  try {
    const storage = new StorageService(dataDir);
    const entry = {
      controllerId: "bk_command" as BackendId,
      changedAt: "2026-10-22T00:00:00.000Z",
      settings: { reviewInstruction: "Controller review" },
    };
    await storage.nodes.mutateControllerSettings(() => ({
      next: { version: 1, entries: [entry] },
      result: undefined,
    }));
    const reopened = new StorageService(dataDir);
    expect((await reopened.nodes.getControllerSettings()).entries).toEqual([entry]);
    await storage.nodes.mutateControllerSettings(() => ({
      next: {
        version: 1,
        entries: [entry, { ...entry, controllerId: "bad id" }, { ...entry, settings: [] }],
      } as never,
      result: undefined,
    }));
    expect((await reopened.nodes.getControllerSettings()).entries).toEqual([entry]);
    const leaf = new LeafControllerSettings({
      storage: reopened,
      attachedName: () => null,
      onChange: () => undefined,
      now: Date.now,
    });
    await leaf.start();
    expect(leaf.current()).toBeNull();
    expect(leaf.source()).toBeUndefined();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
