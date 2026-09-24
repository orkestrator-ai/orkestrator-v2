import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { StorageService } from "./storage.js";

describe("MCP management rollout gate in global config", () => {
  test("is replaced atomically and survives a renderer settings save that omits it", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-mcp-rollout-"));
    try {
      const storage = new StorageService(dataDir);
      await storage.init();
      expect((await storage.loadConfig()).global.mcpManagement).toBeUndefined();
      const off = { enabled: false, writeProviders: [], applyProviders: [] };
      await storage.updateMcpManagementRollout(off);
      expect((await storage.loadConfig()).global.mcpManagement).toEqual(off);

      // A whole-global save from a renderer that does not know the key.
      const { mcpManagement: _omitted, ...rendererGlobal } = (await storage.loadConfig()).global;
      await storage.updateGlobalConfig({
        ...rendererGlobal,
        terminalAppearance: { ...rendererGlobal.terminalAppearance, fontSize: 17 },
      });
      const after = await storage.loadConfig();
      expect(after.global.terminalAppearance.fontSize).toBe(17);
      expect(after.global.mcpManagement).toEqual(off);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
