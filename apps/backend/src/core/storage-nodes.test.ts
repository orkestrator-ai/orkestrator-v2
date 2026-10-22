import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { NodeRecord } from "@orkestrator/protocol/command-nodes";
import type { RouteId } from "@orkestrator/protocol/federation";

import { StorageService } from "./storage.js";

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
      expect((await storage.getNodeRegistry()).nodes).toEqual([]);
      await storage.mutateNodeRegistry((current) => ({
        next: { ...current, registrationEnabled: true, nodes: [record] },
        result: undefined,
      }));
      const registry = await storage.getNodeRegistry();
      expect(registry.revision).toBe(1);
      expect(registry.registrationEnabled).toBe(true);
      expect(registry.nodes).toEqual([record]);
      // Kept in the database, not as a plain JSON file beside it.
      await expect(readFile(path.join(dataDir, "node-registry.json"), "utf8")).rejects.toThrow();
      // A mutation that writes nothing leaves the revision alone.
      await storage.mutateNodeRegistry(() => ({ next: null, result: undefined }));
      expect((await storage.getNodeRegistry()).revision).toBe(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("unreadable registry entries are dropped instead of failing the store", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-nodes-"));
    try {
      const storage = new StorageService(dataDir);
      await storage.mutateNodeRegistry((current) => ({
        next: {
          ...current,
          nodes: [record, { ...record, nodeId: "bad id with spaces" as never }],
        },
        result: undefined,
      }));
      expect((await storage.getNodeRegistry()).nodes.map((node) => node.nodeId)).toEqual([
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
      await storage.mutateNodeAttachments((current) => ({
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
      const attachments = await storage.getNodeAttachments();
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
      expect(await storage.getPortalLayout()).toEqual({
        revision: 0,
        machineOrder: [],
        projectOrder: [],
        projectFolders: {},
        repositoryOrder: [],
      });
      await storage.updatePortalLayout({ machineOrder: ["bk_b", "bk_a"] });
      const layout = await storage.updatePortalLayout({
        projectOrder: ['["bk_a","project","p"]'],
        projectFolders: { '["bk_a","project","p"]': "Work" },
      });
      expect(layout).toEqual({
        revision: 2,
        machineOrder: ["bk_b", "bk_a"],
        projectOrder: ['["bk_a","project","p"]'],
        projectFolders: { '["bk_a","project","p"]': "Work" },
        repositoryOrder: [],
      });
      expect(await new StorageService(dataDir).getPortalLayout()).toEqual(layout);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
