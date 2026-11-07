import { expect, mock, spyOn, test } from "bun:test";
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
    // Defined in the `pull-requests` domain (plan item 7006): unknown keys are
    // dropped, not refused.
    const tolerant = (await command!(
      { environmentId: environment.id, enabled: true, extra: 1 },
      context,
    )) as { autoMerge?: boolean };
    expect(tolerant.autoMerge).toBe(true);
  });
});

test("set_environment_auto_merge records cleanup only with auto-merge, and each call restates it", async () => {
  await withStorage(async (storage) => {
    const environment = await storage.addEnvironment({
      ...createEnvironment("project"),
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
    });
    const context = {
      storage,
      emit: () => undefined,
      runtime: { prMonitor: { requestRefresh: mock(async () => undefined) } },
      prAutoMerge: { evaluate: mock(async () => undefined) },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("set_environment_auto_merge")!;

    const withCleanup = (await command(
      { environmentId: environment.id, enabled: true, cleanupAfterMerge: true },
      context,
    )) as { autoMerge?: boolean; autoMergeCleanup?: boolean };
    expect(withCleanup).toMatchObject({ autoMerge: true, autoMergeCleanup: true });

    await command({ environmentId: environment.id, enabled: true }, context);
    expect((await storage.getEnvironment(environment.id))?.autoMergeCleanup).toBe(false);

    await command(
      { environmentId: environment.id, enabled: true, cleanupAfterMerge: true },
      context,
    );
    await command(
      { environmentId: environment.id, enabled: false, cleanupAfterMerge: true },
      context,
    );
    expect(await storage.getEnvironment(environment.id)).toMatchObject({
      autoMerge: false,
      autoMergeCleanup: false,
    });

    await expect(
      command({ environmentId: environment.id, enabled: true, cleanupAfterMerge: "yes" }, context),
    ).rejects.toThrow();
  });
});

test("set_environment_auto_merge refuses cleanup for a project's home checkout", async () => {
  await withStorage(async (storage) => {
    const environment = await storage.addEnvironment({
      ...createEnvironment("project"),
      projectHome: true,
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
    });
    const context = {
      storage,
      emit: () => undefined,
      runtime: { prMonitor: { requestRefresh: mock(async () => undefined) } },
      prAutoMerge: { evaluate: mock(async () => undefined) },
    } as unknown as CommandContext;
    await expect(
      createCommandRegistry().get("set_environment_auto_merge")!(
        { environmentId: environment.id, enabled: true, cleanupAfterMerge: true },
        context,
      ),
    ).rejects.toThrow("home checkout");
    expect((await storage.getEnvironment(environment.id))?.autoMerge).not.toBe(true);
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
      await storage.updateEnvironment(env.id, { autoMerge: true, autoMergeCleanup: true });
      expect((await storage.getEnvironment(env.id))?.autoMergePrUrl).toBe(env.prUrl);
      const updated = await storage.updateEnvironment(env.id, update);
      expect(updated.autoMerge).toBe(false);
      expect(updated.autoMergePrUrl).toBeNull();
      expect(updated.autoMergeCleanup).toBe(false);
      await storage.updateEnvironment(env.id, {
        prUrl: "https://github.com/o/r/pull/3",
        prState: "open",
      });
      expect((await storage.getEnvironment(env.id))?.autoMerge).toBe(false);
    });
  });
}

for (const enabled of [true, false]) {
  test(`failed automatic cleanup can be withdrawn with enabled=${enabled}`, async () => {
    await withStorage(async (storage) => {
      const env = await storage.addEnvironment({
        ...createEnvironment("project"),
        prUrl: "https://github.com/o/r/pull/1",
        prState: "open",
      });
      await storage.updateEnvironment(env.id, { autoMerge: true, autoMergeCleanup: true });
      const armed = (await storage.getEnvironment(env.id))!;
      const context = {
        storage,
        emit: () => undefined,
        runtime: {
          prMonitor: { requestRefresh: async () => undefined, invalidate: async () => undefined },
        },
        prAutoMerge: { evaluate: async () => undefined },
      } as unknown as CommandContext;
      const commands = createCommandRegistry();
      await expect(
        commands.get("merge_environment_pr")!(
          {
            environmentId: env.id,
            cleanupAfterMerge: true,
            autoMergeEnabledAt: armed.autoMergeEnabledAt,
          },
          context,
        ),
      ).rejects.toThrow();
      expect((await storage.getEnvironment(env.id))?.cleanupAfterMergeRequestedAt).toBeUndefined();
      await commands.get("set_environment_auto_merge")!(
        { environmentId: env.id, enabled },
        context,
      );
      const merged = await storage.updateEnvironment(env.id, { prState: "merged" });
      expect(merged.cleanupAfterMergeRequestedAt).toBeUndefined();
    });
  });
}

for (const prState of ["merged", "closed"] as const) {
  test(`external ${prState} preserves cleanup only for confirmed merge`, async () => {
    await withStorage(async (storage) => {
      const env = await storage.addEnvironment({
        ...createEnvironment("project"),
        prUrl: "https://github.com/o/r/pull/1",
        prState: "open",
      });
      await storage.updateEnvironment(env.id, { autoMerge: true, autoMergeCleanup: true });
      const updated = await storage.updateEnvironment(env.id, { prState });
      expect(Boolean(updated.cleanupAfterMergeRequestedAt)).toBe(prState === "merged");
      expect(updated.autoMergeCleanup).toBe(false);
    });
  });
}

test("completion of another tab cannot release a running Resolve", async () => {
  await withStorage(async (storage) => {
    const env = await storage.addEnvironment({
      ...createEnvironment("project"),
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
      autoMerge: true,
      autoMergeResolveRequestId: "resolve-request",
      prRecheckAfterAgentCompletionArmedAt: "armed",
    });
    const sessions = spyOn(storage, "listNativeAgentSessions");
    const context = {
      storage,
      runtime: { prMonitor: { requestRefresh: async () => undefined } },
    } as unknown as CommandContext;
    const complete = createCommandRegistry().get("pr_monitor_agent_turn_completed")!;
    try {
      sessions.mockResolvedValue([
        { environmentId: env.id, turnOutcomes: [{ requestId: "other-tab" }] },
      ] as never);
      await complete({ environmentId: env.id }, context);
      expect((await storage.getEnvironment(env.id))?.autoMergeResolveCompletedAt).toBeUndefined();
      sessions.mockResolvedValue([
        { environmentId: env.id, turnOutcomes: [{ requestId: "resolve-request" }] },
      ] as never);
      await complete({ environmentId: env.id }, context);
      expect((await storage.getEnvironment(env.id))?.autoMergeResolveCompletedAt).toEqual(
        expect.any(String),
      );
    } finally {
      sessions.mockRestore();
    }
  });
});

test("withdrawing automatic cleanup preserves an independent manual request", async () => {
  await withStorage(async (storage) => {
    const env = await storage.addEnvironment({
      ...createEnvironment("project"),
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
    });
    await storage.updateEnvironment(env.id, {
      autoMerge: true,
      autoMergeCleanup: true,
      cleanupAfterMergeRequestedAt: "manual-request",
    });
    const context = {
      storage,
      runtime: { prMonitor: { requestRefresh: async () => undefined } },
      prAutoMerge: { evaluate: async () => undefined },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("set_environment_auto_merge")!;
    await command({ environmentId: env.id, enabled: false }, context);
    expect((await storage.getEnvironment(env.id))?.cleanupAfterMergeRequestedAt).toBe(
      "manual-request",
    );
    await storage.updateEnvironment(env.id, { lifecycleOperation: "merging" });
    await expect(command({ environmentId: env.id, enabled: true }, context)).rejects.toThrow(
      "merge is in progress",
    );
  });
});

test("manual Resolve does not inherit a completed automatic Resolve identity", async () => {
  await withStorage(async (storage) => {
    const env = await storage.addEnvironment({
      ...createEnvironment("project"),
      prUrl: "https://github.com/o/r/pull/1",
      prState: "open",
      hasMergeConflicts: true,
      autoMergeResolveRequestId: "old",
      autoMergeResolveCompletedAt: new Date().toISOString(),
    });
    await storage.armPrRecheckAfterAgentCompletion(env.id);
    expect((await storage.getEnvironment(env.id))?.autoMergeResolveRequestId).toBeUndefined();
    expect((await storage.getEnvironment(env.id))?.autoMergeResolveCompletedAt).toBeUndefined();
  });
});
