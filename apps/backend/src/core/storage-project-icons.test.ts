import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

const ICON = "data:image/png;base64,iVBORw0KGgo=";

describe("StorageService project icons", () => {
  let dataDir: string;
  let storage: StorageService;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-project-icons-"));
    storage = new StorageService(dataDir);
    await storage.init();
    await storage.addProject({
      id: "alpha",
      name: "alpha",
      gitUrl: "https://example.invalid/alpha.git",
      localPath: "/projects/alpha",
      addedAt: new Date(0).toISOString(),
      order: 0,
    });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("update_project sets and clears the icon without leaving a null", async () => {
    await storage.updateProject("alpha", { icon: ICON });
    expect((await storage.getProject("alpha"))?.icon).toBe(ICON);
    await storage.updateProject("alpha", { icon: null });
    const cleared = await storage.getProject("alpha");
    expect(cleared?.icon).toBeUndefined();
    expect(cleared && "icon" in cleared).toBe(false);
  });

  test("an update that does not mention the icon leaves it alone", async () => {
    await storage.updateProject("alpha", { icon: ICON });
    await storage.updateProject("alpha", { name: "renamed" });
    expect((await storage.getProject("alpha"))?.icon).toBe(ICON);
  });

  test("rejects an icon that is not a small raster data URL", async () => {
    await storage.updateProject("alpha", { icon: ICON });
    for (const icon of ["data:image/svg+xml;base64,PHN2Zz4=", "https://example.com/icon.png"]) {
      await expect(storage.updateProject("alpha", { icon })).rejects.toThrow(/Project icon/);
    }
    expect((await storage.getProject("alpha"))?.icon).toBe(ICON);
  });
});
