import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { createEnvironment, StorageService } from "./storage.js";

const prUrl = "https://github.com/o/r/pull/1";

async function fixture(
  run: (storage: StorageService, context: CommandContext, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "auto-resolve-launch-"));
  const storage = new StorageService(dir);
  await storage.init();
  await storage.addEnvironment({
    ...createEnvironment("project"),
    id: "env",
    environmentType: "local",
    worktreePath: dir,
    status: "running",
    setupPhase: "ready",
    prUrl,
    prState: "open",
    hasMergeConflicts: true,
  });
  await storage.updateEnvironment("env", { autoMerge: true });
  const context = {
    storage,
    prAutoMerge: { isActive: () => true },
    nativeAgents: {
      ensureSession: mock(async () => ({ providerSessionId: "session" })),
      dispatchIntent: mock(async () => ({ outcome: "accepted" })),
    },
  } as unknown as CommandContext;
  try {
    await run(storage, context, dir);
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const launch = createCommandRegistry().get("launch_native_agent_job")!;
const args = {
  environmentId: "env",
  requestId: "attempt-1",
  agent: "claude",
  prompt: "Resolve conflicts",
  title: "Resolve",
  completionAction: "refresh-pr-after-agent-completion",
  autoMergePrUrl: prUrl,
};

test("automatic Resolve conditionally claims the episode and preserves a manual owner's token", async () => {
  await fixture(async (storage, context) => {
    const manual = await launch(
      { ...args, autoMergePrUrl: undefined, requestId: "manual" },
      context,
    );
    expect(manual).toMatchObject({ status: "accepted" });
    const token = (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt;
    expect(await launch(args, context)).toMatchObject({ status: "skipped" });
    expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
    expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(token);
  });
});

test("pre-dispatch setup failures reuse the durable tab and recover across changing retry IDs", async () => {
  await fixture(async (storage, context) => {
    const ensure = mock(async () => {
      throw new Error("setup unavailable");
    });
    context.nativeAgents!.ensureSession = ensure as never;
    for (let attempt = 0; attempt < 4; attempt++) {
      await expect(launch({ ...args, requestId: `retry-${attempt}` }, context)).rejects.toThrow(
        "setup unavailable",
      );
      expect(
        (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt,
      ).toBeUndefined();
      const layout = await storage.getPaneLayout("env");
      expect(layout!.root).toMatchObject({
        kind: "leaf",
        tabs: [expect.objectContaining({ displayTitle: "Resolve" })],
      });
    }
    context.nativeAgents!.ensureSession = mock(async () => ({
      providerSessionId: "session",
    })) as never;
    expect(await launch({ ...args, requestId: "recovered" }, context)).toMatchObject({
      status: "accepted",
    });
    expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
    expect((await storage.getPaneLayout("env"))!.root).toMatchObject({
      kind: "leaf",
      tabs: [
        expect.objectContaining({
          nativeAgentData: expect.objectContaining({ sessionId: "session" }),
        }),
      ],
    });
  });
});

for (const outcome of ["unknown", "throw"] as const) {
  test(`uncertain dispatch (${outcome}) retains ownership and cannot duplicate Resolve`, async () => {
    await fixture(async (storage, context) => {
      context.nativeAgents!.dispatchIntent = mock(async () => {
        if (outcome === "throw") throw new Error("transport lost");
        return { outcome: "unknown" };
      }) as never;
      if (outcome === "throw")
        await expect(launch(args, context)).rejects.toThrow("transport lost");
      else expect(await launch(args, context)).toMatchObject({ status: "unknown" });
      const token = (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt;
      expect(token).toBeTruthy();
      expect(await launch({ ...args, requestId: "retry" }, context)).toMatchObject({
        status: "skipped",
      });
      expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(1);
      expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(
        token,
      );
    });
  });
}

for (const action of ["disable", "dispose", "manual"] as const) {
  test(`command preparation fences ${action} before any tab or prompt is published`, async () => {
    await fixture(async (storage, context) => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const config = await storage.loadConfig();
      const loading = spyOn(storage, "loadConfig").mockImplementationOnce(async () => {
        entered();
        await gate;
        return config;
      });
      try {
        const automatic = launch(args, context);
        await started;
        if (action === "disable") await storage.updateEnvironment("env", { autoMerge: false });
        if (action === "dispose") context.prAutoMerge = { isActive: () => false } as never;
        let token: string | undefined;
        if (action === "manual") {
          expect(
            await launch({ ...args, autoMergePrUrl: undefined, requestId: "manual" }, context),
          ).toMatchObject({ status: "accepted" });
          token = (await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt;
        }
        release();
        expect(await automatic).toMatchObject({ status: "skipped" });
        expect(context.nativeAgents!.dispatchIntent).toHaveBeenCalledTimes(
          action === "manual" ? 1 : 0,
        );
        if (action !== "manual") expect(await storage.getPaneLayout("env")).toBeNull();
        else
          expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(
            token,
          );
      } finally {
        release();
        loading.mockRestore();
      }
    });
  });
}

test("rollback of a failed setup leaves a newer manual Resolve token intact", async () => {
  await fixture(async (storage, context) => {
    let token: string | null = null;
    context.nativeAgents!.ensureSession = mock(async () => {
      token = (await storage.armPrRecheckAfterAgentCompletion("env")).armedAt;
      throw new Error("failed setup");
    }) as never;
    await expect(launch(args, context)).rejects.toThrow("failed setup");
    expect(token).toBeTruthy();
    expect((await storage.getEnvironment("env"))!.prRecheckAfterAgentCompletionArmedAt).toBe(
      token!,
    );
  });
});

test("a failed Resolve keeps its recoverable identity through storage restart", async () => {
  await fixture(async (storage, context, dir) => {
    context.nativeAgents!.ensureSession = mock(async () => {
      throw new Error("not ready");
    }) as never;
    await expect(launch(args, context)).rejects.toThrow("not ready");
    const requestId = (await storage.getEnvironment("env"))!.autoMergeResolveRequestId;
    const reopened = new StorageService(dir);
    try {
      await reopened.init();
      context.storage = reopened;
      context.nativeAgents!.ensureSession = mock(async () => ({
        providerSessionId: "session",
      })) as never;
      expect(await launch({ ...args, requestId: "after-restart" }, context)).toMatchObject({
        status: "accepted",
      });
      expect((await reopened.getEnvironment("env"))!.autoMergeResolveRequestId).toBe(requestId);
      expect((await reopened.getPaneLayout("env"))!.root).toMatchObject({
        kind: "leaf",
        tabs: [expect.anything()],
      });
    } finally {
      reopened.close();
    }
  });
});
