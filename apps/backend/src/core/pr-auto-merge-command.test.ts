import { expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { createEnvironment, StorageService } from "./storage.js";

async function withStorage(run: (storage: StorageService, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-auto-merge-"));
  const storage = new StorageService(dir);
  try {
    await storage.init();
    await run(storage, dir);
  } finally {
    storage.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("storage keeps auto-merge across a restart and records off as an explicit false", async () => {
  await withStorage(async (storage, dir) => {
    const environment = await storage.addEnvironment({
      ...createEnvironment("project"),
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
    });
    expect(environment.autoMerge).toBeUndefined();
    await storage.updateEnvironment(environment.id, { autoMerge: true });
    const reopened = new StorageService(dir);
    try {
      await reopened.init();
      expect((await reopened.getEnvironment(environment.id))?.autoMerge).toBe(true);
    } finally {
      reopened.close();
    }
    // A renderer merges records field by field, so "off" must survive as a key.
    await storage.updateEnvironment(environment.id, { autoMerge: false });
    expect((await storage.getEnvironment(environment.id))?.autoMerge).toBe(false);
    await storage.updateEnvironment(environment.id, { autoMerge: "yes" as never });
    expect((await storage.getEnvironment(environment.id))?.autoMerge).toBe(false);
  });
});

test("set_environment_auto_merge persists the flag and waits for the requested monitor reading", async () => {
  await withStorage(async (storage) => {
    const environment = await storage.addEnvironment({
      ...createEnvironment("project"),
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
    });
    const requestRefresh = mock(async () => undefined);
    const evaluate = mock(async () => undefined);
    const context = {
      storage,
      emit: () => undefined,
      runtime: { prMonitor: { requestRefresh } },
      prAutoMerge: { evaluate },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("set_environment_auto_merge");
    expect(command).toBeDefined();

    const enabled = (await command!({ environmentId: environment.id, enabled: true }, context)) as {
      autoMerge?: boolean;
    };
    expect(enabled.autoMerge).toBe(true);
    expect((await storage.getEnvironment(environment.id))?.autoMerge).toBe(true);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(evaluate).not.toHaveBeenCalled();

    const disabled = (await command!(
      { environmentId: environment.id, enabled: false },
      context,
    )) as { autoMerge?: boolean };
    expect(disabled.autoMerge).toBe(false);
    expect(requestRefresh).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(environment.id);

    await expect(command!({ environmentId: environment.id }, context)).rejects.toThrow();
    await expect(
      command!({ environmentId: environment.id, enabled: true, extra: 1 }, context),
    ).rejects.toThrow();
  });
});

test("a monitor refresh failure does not undo turning auto-merge on", async () => {
  await withStorage(async (storage) => {
    const environment = await storage.addEnvironment({
      ...createEnvironment("project"),
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
    });
    const warn = mock(() => undefined);
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      const context = {
        storage,
        emit: () => undefined,
        runtime: {
          prMonitor: {
            requestRefresh: async () => {
              throw new Error("monitor unavailable");
            },
          },
        },
      } as unknown as CommandContext;
      await createCommandRegistry().get("set_environment_auto_merge")!(
        { environmentId: environment.id, enabled: true },
        context,
      );
    } finally {
      console.warn = originalWarn;
    }
    expect((await storage.getEnvironment(environment.id))?.autoMerge).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

for (const update of [
  { prState: "merged" },
  { prState: "closed" },
  { prUrl: "https://github.com/o/r/pull/2", prState: "open" },
  { branch: "main", prUrl: null, prState: null },
]) {
  test(`PR authorization is cleared durably on ${JSON.stringify(update)}`, async () => {
    await withStorage(async (storage) => {
      const env = await storage.addEnvironment({
        ...createEnvironment("project"),
        prUrl: "https://github.com/o/r/pull/1",
        prState: "open",
      });
      await storage.updateEnvironment(env.id, { autoMerge: true });
      expect((await storage.getEnvironment(env.id))?.autoMergePrUrl).toBe(env.prUrl);
      const updated = await storage.updateEnvironment(env.id, update);
      expect(updated.autoMerge).toBe(false);
      expect(updated.autoMergePrUrl).toBeNull();
      await storage.updateEnvironment(env.id, {
        prUrl: "https://github.com/o/r/pull/3",
        prState: "open",
      });
      expect((await storage.getEnvironment(env.id))?.autoMerge).toBe(false);
    });
  });
}
