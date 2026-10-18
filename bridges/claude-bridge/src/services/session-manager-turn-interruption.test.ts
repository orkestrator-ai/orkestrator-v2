import { describe, expect, test } from "bun:test";

import {
  PERSISTED_SDK_ID,
  abortSession,
  getSession,
  materializePersistedSession,
  mockSdkListSessions,
  reconcilePersistedSessions,
  createPromptTurnForTesting,
  releaseWithBackgroundWork,
  nextQueryCall,
  readSessionPreferences,
  sendPrompt,
  updateSessionPreferences,
  waitFor,
  withTemporaryClaudeHome,
} from "./session-manager-test-harness.js";
import { setClaudeRuntimeIdleTimingForTesting } from "./session-manager-runtime-idle.js";
import { sessions } from "./session-manager-core.js";
import type { ClaudeTurnInFlightMark } from "./session-preferences.js";

// Loaded after the harness so they bind to the same mocked session-manager graph.
const {
  CLAUDE_RESTARTED_MID_TURN_MESSAGE,
  bridgeInstanceIdForTesting,
  claudeProcessKilledMessage,
  killedClaudeProcessSignal,
} = await import("./session-manager-turn-interruption.js");
const { closeSessionRetainingHistory } = await import("./session-manager-close.js");

/** The mark writes are fire-and-forget, so wait for the file to agree. */
async function storedMark(
  expected: "present" | "absent",
  timeoutMs = 2_000,
  owner?: string,
): Promise<ClaudeTurnInFlightMark | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const mark = (await readSessionPreferences(PERSISTED_SDK_ID))?.turnInFlight;
    if (
      (mark !== undefined) === (expected === "present") &&
      (!owner || mark?.bridgeInstanceId === owner)
    )
      return mark;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the mark to be ${expected}`);
    await Bun.sleep(10);
  }
}

/** A pid that belonged to a process which has since exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

/** What a bridge process that died mid-turn leaves behind. */
async function leaveMarkFromDeadBridge(pid?: number): Promise<void> {
  await updateSessionPreferences(PERSISTED_SDK_ID, {
    turnInFlight: {
      bridgeInstanceId: "a-bridge-that-died",
      pid: pid ?? (await deadPid()),
      startedAt: Date.now() - 60_000,
    },
  });
}

/** The process exit: memory goes, the preferences file stays. */
function forgetInMemory(sessionId: string): void {
  sessions.delete(sessionId);
}

function killedBySignal(signal: string): Error {
  return Object.assign(new Error(`Claude Code process terminated by signal ${signal}`), {
    errorClass: "process_killed_by_signal",
    signal,
  });
}

describe("turn-in-flight mark", () => {
  test("is written while a turn runs and cleared when it completes", async () => {
    await withTemporaryClaudeHome("claude-turn-mark-", async () => {
      const state = await materializePersistedSession();
      const prompt = sendPrompt(state.id, "work", { requestId: "mark-turn" });
      const call = await nextQueryCall();

      const mark = await storedMark("present");
      expect(mark?.bridgeInstanceId).toBe(bridgeInstanceIdForTesting());
      expect(mark?.pid).toBe(process.pid);

      call.push({ type: "result", subtype: "success", result: "done" });
      call.finish();
      await prompt;
      await storedMark("absent");
      expect(getSession(state.id)?.status).toBe("idle");
    });
  });

  test("a user stop clears it, so a later restart does not blame the restart", async () => {
    await withTemporaryClaudeHome("claude-turn-mark-abort-", async () => {
      const state = await materializePersistedSession();
      const prompt = sendPrompt(state.id, "work", { requestId: "mark-abort" });
      await nextQueryCall();
      await storedMark("present");

      expect(abortSession(state.id)).toBe(true);
      await prompt.catch(() => {});
      await storedMark("absent");
      expect(getSession(state.id)?.interruption).toBeUndefined();
    });
  });

  test("a tab close clears it", async () => {
    await withTemporaryClaudeHome("claude-turn-mark-close-", async () => {
      const state = await materializePersistedSession();
      const prompt = sendPrompt(state.id, "work", { requestId: "mark-close" });
      await nextQueryCall();
      await storedMark("present");

      await expect(closeSessionRetainingHistory(state.id)).resolves.toBe("closed");
      await prompt.catch(() => {});
      await storedMark("absent");

      const reopened = await materializePersistedSession();
      expect(reopened.status).toBe("idle");
      expect(reopened.interruption).toBeUndefined();
    });
  });

  test("an ordinary failure clears it and is not an interruption", async () => {
    await withTemporaryClaudeHome("claude-turn-mark-fail-", async () => {
      const state = await materializePersistedSession();
      const prompt = sendPrompt(state.id, "work", { requestId: "mark-fail" });
      const call = await nextQueryCall();
      await storedMark("present");

      call.fail(new Error("Claude Code process exited with code 1"));
      await expect(prompt).rejects.toThrow(/exited with code 1/);
      await storedMark("absent");
      const failed = getSession(state.id)!;
      expect(failed.status).toBe("error");
      expect(failed.error).toBe("Claude Code process exited with code 1");
      expect(failed.interruption).toBeUndefined();
    });
  });
});

describe("restoring a session a restart cut short", () => {
  test("reports the turn failed with interruption restart, then a new turn continues it", async () => {
    await withTemporaryClaudeHome("claude-turn-restored-", async () => {
      await leaveMarkFromDeadBridge();
      const restored = await materializePersistedSession();
      expect(restored).toMatchObject({
        status: "error",
        error: CLAUDE_RESTARTED_MID_TURN_MESSAGE,
        interruption: "restart",
      });

      // A second restart before anything continued it still reports it.
      forgetInMemory(restored.id);
      expect(await materializePersistedSession()).toMatchObject({
        status: "error",
        interruption: "restart",
      });

      const continued = getSession(restored.id)!;
      const prompt = sendPrompt(continued.id, "continue", { requestId: "continuation" });
      const call = await nextQueryCall();
      // The continuation is the turn now; nothing explains a failure any more.
      expect(continued.status).toBe("running");
      expect(continued.interruption).toBeUndefined();
      expect(continued.error).toBeUndefined();
      // Still marked while it runs: a restart now cuts the continuation short.
      const mark = await storedMark("present", 2_000, bridgeInstanceIdForTesting());
      expect(mark?.pid).toBe(process.pid);
      // A second bridge has a different instance id and pid, but sees our live
      // process as the owner of this continuation.
      const observer = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import { restoredTurnInterruption } from ${JSON.stringify(new URL("./session-manager-turn-interruption.ts", import.meta.url).pathname)};
        process.stdout.write(JSON.stringify(restoredTurnInterruption(${JSON.stringify({ turnInFlight: mark })})));
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const observed = await new Response(observer.stdout).json();
      expect(await observer.exited).toBe(0);
      expect(observed).toEqual({ status: "idle" });

      call.push({ type: "result", subtype: "success", result: "done" });
      call.finish();
      await prompt;
      await storedMark("absent");
    });
  });

  test("the startup catalogue restores an owed continuation from its mark", async () => {
    await withTemporaryClaudeHome("claude-turn-catalogue-", async () => {
      await leaveMarkFromDeadBridge();
      mockSdkListSessions.mockResolvedValue([
        {
          sessionId: PERSISTED_SDK_ID,
          summary: "Interrupted continuation",
          lastModified: Date.now(),
        },
      ]);
      await reconcilePersistedSessions();
      const restored = Array.from(sessions.values()).find(
        (session) => session.sdkSessionId === PERSISTED_SDK_ID,
      )!;
      expect(restored).toMatchObject({
        status: "error",
        interruption: "restart",
        turnInFlightMarked: true,
      });
      expect(restored.persistedMessagesLoaded).toBe(false);
    });
  });

  test("blames a dead predecessor that had this process's pid", async () => {
    await withTemporaryClaudeHome("claude-turn-restored-pid-", async () => {
      // Pids repeat across container restarts; the instance id tells them apart.
      await leaveMarkFromDeadBridge(process.pid);
      expect(await materializePersistedSession()).toMatchObject({
        status: "error",
        interruption: "restart",
      });
    });
  });

  test("leaves a turn another live bridge is running alone", async () => {
    await withTemporaryClaudeHome("claude-turn-restored-live-", async () => {
      // Several environments' bridges can share one Claude home.
      await updateSessionPreferences(PERSISTED_SDK_ID, {
        turnInFlight: { bridgeInstanceId: "another-bridge", pid: process.ppid, startedAt: 1 },
      });
      const restored = await materializePersistedSession();
      expect(restored.status).toBe("idle");
      expect(restored.interruption).toBeUndefined();
      expect(restored.error).toBeUndefined();
    });
  });

  test("leaves this process's own mark alone after the session left memory", async () => {
    await withTemporaryClaudeHome("claude-turn-restored-self-", async () => {
      await updateSessionPreferences(PERSISTED_SDK_ID, {
        turnInFlight: {
          bridgeInstanceId: bridgeInstanceIdForTesting(),
          pid: process.pid,
          startedAt: 1,
        },
      });
      const restored = await materializePersistedSession();
      expect(restored.status).toBe("idle");
      expect(restored.interruption).toBeUndefined();
    });
  });

  test("ignores a malformed mark without distrusting the rest of the file", async () => {
    await withTemporaryClaudeHome("claude-turn-restored-bad-", async () => {
      await updateSessionPreferences(PERSISTED_SDK_ID, {
        planMode: false,
        turnInFlight: { bridgeInstanceId: "", pid: -1, startedAt: 0 },
      });
      const restored = await materializePersistedSession();
      expect(restored.status).toBe("idle");
      // An unreadable file fails closed to plan mode; this one stays readable.
      expect(restored.planMode).toBe(false);
      expect(restored.dispatchJournalUnavailable).toBeUndefined();
    });
  });
});

describe("a Claude Code process killed under the turn", () => {
  test("is reported as a restart interruption and keeps the mark", async () => {
    await withTemporaryClaudeHome("claude-turn-killed-", async () => {
      const state = await materializePersistedSession();
      const prompt = sendPrompt(state.id, "work", { requestId: "killed-turn" });
      const call = await nextQueryCall();
      await storedMark("present");

      call.fail(killedBySignal("SIGKILL"));
      await expect(prompt).rejects.toThrow(/SIGKILL/);
      const failed = getSession(state.id)!;
      expect(failed).toMatchObject({
        status: "error",
        error: claudeProcessKilledMessage("SIGKILL"),
        interruption: "restart",
      });
      await waitFor(() => failed.claudeRuntime === undefined);
      // A bridge restart before the continuation still reports it.
      expect(await storedMark("present")).toBeDefined();
    });
  });

  test("a structured turn records the same notice as its provider failure", async () => {
    await withTemporaryClaudeHome("claude-turn-killed-structured-", async () => {
      const state = await materializePersistedSession();
      const prompt = sendPrompt(state.id, "report", {
        requestId: "killed-structured",
        outputSchema: { type: "object", properties: {} },
      });
      const call = await nextQueryCall();
      call.fail(killedBySignal("SIGTERM"));
      await expect(prompt).rejects.toThrow(/SIGTERM/);
      const failed = getSession(state.id)!;
      expect(failed.interruption).toBe("restart");
      expect(failed.structuredOutput).toMatchObject({
        ok: false,
        error: { message: claudeProcessKilledMessage("SIGTERM") },
      });
    });
  });
});

describe("killedClaudeProcessSignal", () => {
  test("reads only the SDK's signal class", () => {
    expect(killedClaudeProcessSignal(killedBySignal("SIGKILL"))).toBe("SIGKILL");
    // An unexpected signal value is not echoed into the notice.
    expect(
      killedClaudeProcessSignal(
        Object.assign(new Error("x"), { errorClass: "process_killed_by_signal", signal: "<b>" }),
      ),
    ).toBe("a signal");
    expect(
      killedClaudeProcessSignal(
        Object.assign(new Error("x"), { errorClass: "process_exited_nonzero", exitCode: 1 }),
      ),
    ).toBeUndefined();
    // The message alone is not evidence: only the SDK's classification is.
    expect(
      killedClaudeProcessSignal(new Error("Claude Code process terminated by signal SIGKILL")),
    ).toBeUndefined();
    expect(killedClaudeProcessSignal(undefined)).toBeUndefined();
  });
});

test("continuation debt sets the mark and stopping the wait clears it", async () => {
  await withTemporaryClaudeHome("claude-continuation-mark-", async () => {
    const state = await materializePersistedSession();
    const { turn } = createPromptTurnForTesting(state, { requestId: "owed-continuation" });
    turn.queryIteratorControl = {} as NonNullable<typeof turn.queryIteratorControl>;
    state.status = "idle";
    const { waitForContinuationAfterNotification, stopWaitingForContinuation } =
      await import("./session-manager-prompt-turn-lifecycle.js");
    waitForContinuationAfterNotification(turn);
    expect(state.retainedContinuationRequestIds?.has("owed-continuation")).toBe(true);
    expect(await storedMark("present")).toBeDefined();
    stopWaitingForContinuation(turn);
    await storedMark("absent");
    expect(state.retainedContinuationRequestIds).toBeUndefined();
    expect(turn.awaitingContinuation).toBe(false);
  });
});

test.each(["completed", "stopped", "killed"] as const)(
  "a background continuation keeps its mark until %s",
  async (outcome) => {
    await withTemporaryClaudeHome("claude-background-mark-", async () => {
      setClaudeRuntimeIdleTimingForTesting({ idleMs: 60_000 });
      const { session, call, firstPrompt } = await releaseWithBackgroundWork(
        "background marker",
        "agent-bg",
        { requestId: "background-request" },
      );
      session.sdkSessionId = PERSISTED_SDK_ID;
      expect(session.status).toBe("idle");
      await storedMark("absent");
      call.push({
        type: "system",
        subtype: "task_notification",
        task_id: "agent-bg",
        tool_use_id: "agent-call",
        status: "completed",
      });
      await waitFor(() => session.claudeRuntime!.latestTurn.isAwaitingContinuation());
      await storedMark("present");
      if (outcome === "killed") {
        // There is no foreground abort owner; the notification still owes an
        // answer and must survive signal death and another bridge restart.
        expect(session.abortController).toBeUndefined();
        call.fail(killedBySignal("SIGKILL"));
        await firstPrompt.catch(() => {});
        await waitFor(() => session.claudeRuntime === undefined);
        expect(session).toMatchObject({ status: "error", interruption: "restart" });
        expect(await storedMark("present")).toBeDefined();
      } else if (outcome === "stopped") {
        expect(abortSession(session.id)).toBe(true);
        await firstPrompt;
        await storedMark("absent");
        expect(session.interruption).toBeUndefined();
      } else {
        call.push({
          type: "assistant",
          parent_tool_use_id: null,
          message: {
            id: "msg-background-resumed",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Done." }],
          },
        });
        await waitFor(() => session.status === "running");
        call.push({ type: "result", subtype: "success" });
        await firstPrompt;
        await storedMark("absent");
        expect(session.retainedContinuationRequestIds).toBeUndefined();
        call.finish();
      }
    });
  },
);
