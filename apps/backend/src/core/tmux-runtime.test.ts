import { describe, expect, mock, spyOn, test } from "bun:test";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { deferred, flushMicrotasks, ManualTime } from "./recurring-test-support.js";
import type { StorageService } from "./storage.js";
import type { Environment } from "./models.js";
import { TmuxBackend } from "./tmux-backend.js";
import { TmuxSession } from "./tmux-session-manager.js";

describe("tmux runtime shutdown", () => {
  test("pending reconciliation cannot admit polls after shutdown", async () => {
    const time = new ManualTime();
    const readState = mock(async () => "idle");
    const runtime = new BackendRuntime({
      emit: () => undefined,
      tmux: {
        claudeStatePolls: {
          readState,
          schedule: (callback, ms) => time.setInterval(callback, ms),
          cancel: (timer) => time.clear(timer),
        },
      },
    });
    const environments = deferred<Environment[]>();
    const loadEnvironments = mock(() => environments.promise);
    const context = {
      runtime,
      storage: { loadEnvironments } as unknown as StorageService,
    } as CommandContext;
    try {
      runtime.tmux.claudeStatePolls.start("existing", context);
      expect(time.pendingTimers).toBe(1);
      const pending = runtime.tmux.claudeStatePolls.reconcile(context);
      expect(loadEnvironments).toHaveBeenCalledTimes(1);
      runtime.shutdown();
      environments.resolve([{ id: "env", containerId: "late", status: "running" } as Environment]);
      await pending;
      runtime.tmux.claudeStatePolls.start("direct", context);
      await runtime.tmux.claudeStatePolls.reconcile(context);
      await time.advance(60_000);
      expect(runtime.tmux.claudeStatePolls.status().containers).toBe(0);
      expect(time.pendingTimers).toBe(0);
      // Only the existing poll's initial read ran, before shutdown.
      expect(readState).toHaveBeenCalledTimes(1);
      expect(loadEnvironments).toHaveBeenCalledTimes(1);
    } finally {
      runtime.shutdown();
    }
  });

  for (const phase of ["scheduled", "capturing", "starting"] as const) {
    test(`shutdown detaches interactive panes while ${phase} without reviving snapshot timers`, async () => {
      const time = new ManualTime();
      const emit = mock(() => undefined);
      const runtime = new BackendRuntime({
        emit,
        tmux: {
          interactiveTerminals: {
            schedule: (callback, ms) => time.setTimeout(callback, ms),
            cancel: (timer) => time.clear(timer),
          },
        },
      });
      const session = new TmuxSession("env", "tab", TmuxBackend.local("/tmp"), "/tmp");
      spyOn(session, "resize").mockResolvedValue(undefined);
      const capture = spyOn(session, "capturePane").mockResolvedValue("pane\n");
      const late = deferred<string>();
      if (phase === "starting") capture.mockImplementation(() => late.promise);
      const context = { runtime, emit } as unknown as CommandContext;
      const id = runtime.tmux.interactiveTerminals.create(session, 80, 24);
      try {
        const starting = runtime.tmux.interactiveTerminals.start(id, context);
        await flushMicrotasks();
        if (phase !== "starting") {
          await starting;
          expect(time.pendingTimers).toBe(1);
        }
        if (phase === "capturing") {
          capture.mockImplementation(() => late.promise);
          await time.advance(250);
        }
        const reads = capture.mock.calls.length;
        const frames = emit.mock.calls.length;
        runtime.shutdown();
        late.resolve("late pane\n");
        await starting;
        await flushMicrotasks();
        await time.advance(10_000);
        expect(time.pendingTimers).toBe(0);
        expect(capture).toHaveBeenCalledTimes(reads);
        expect(emit).toHaveBeenCalledTimes(frames);
        await expect(runtime.tmux.interactiveTerminals.resize(id, 90, 30)).rejects.toThrow(
          "not found",
        );
      } finally {
        runtime.shutdown();
      }
    });
  }
});

describe("tmux completion attention across tabs and restart", () => {
  async function fixture() {
    const { promises: fs } = await import("node:fs");
    const os = await import("node:os");
    const { StorageService } = await import("./storage.js");
    const { graphEnvironmentFixture } = await import("./graph-run-test-support.js");
    const root = await fs.mkdtemp(`${os.tmpdir()}/tmux-attention-`);
    const storage = new StorageService(root);
    await storage.init();
    await storage.addEnvironment(graphEnvironmentFixture());
    const runtime = new BackendRuntime({ emit: () => undefined });
    const context = { storage, runtime } as unknown as CommandContext;
    return { storage, runtime, context, root, fs, StorageService };
  }

  test("one tab succeeds while another works, then the sibling stops quietly", async () => {
    const { storage, runtime, context, root, fs } = await fixture();
    const activity = spyOn(runtime.tmux.sessions, "activityState").mockReturnValue("working");
    try {
      await runtime.tmux.persistEnvironmentActivity(context, "e1");
      await runtime.tmux.noteTurnFinished(context, "e1");
      expect(await storage.getEnvironment("e1")).toMatchObject({
        agentActivityState: "working",
        hasUnreadWork: true,
        unreadReason: "agent_finished",
      });
      activity.mockReturnValue("idle");
      await runtime.tmux.persistEnvironmentActivity(context, "e1");
      expect(await storage.getEnvironment("e1")).toMatchObject({
        agentActivityState: "idle",
        hasUnreadWork: true,
        unreadReason: "agent_finished",
      });
    } finally {
      activity.mockRestore();
      runtime.shutdown();
      storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("failure drained after reattach stays deduplicated after another storage restart", async () => {
    const { storage, runtime, context, root, fs, StorageService } = await fixture();
    const activity = spyOn(runtime.tmux.sessions, "activityState").mockReturnValue("idle");
    let restarted: InstanceType<typeof StorageService> | undefined;
    try {
      await storage.setEnvironmentAgentActivity(
        "e1",
        "working",
        new Date().toISOString(),
        "claude-tmux",
      );
      await runtime.tmux.persistEnvironmentActivity(context, "e1");
      await runtime.tmux.noteTurnFailed(context, "e1", "claude-tmux:session:failure");
      expect(await storage.getEnvironment("e1")).toMatchObject({
        agentActivityState: "idle",
        hasUnreadWork: true,
        unreadReason: "agent_failed",
      });
      await storage.setEnvironmentUnread("e1", false);
      restarted = new StorageService(root);
      await restarted.init();
      await runtime.tmux.noteTurnFailed(
        { ...context, storage: restarted },
        "e1",
        "claude-tmux:session:failure",
      );
      expect((await restarted.getEnvironment("e1"))!.hasUnreadWork).toBe(false);
    } finally {
      activity.mockRestore();
      runtime.shutdown();
      restarted?.close();
      storage.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
