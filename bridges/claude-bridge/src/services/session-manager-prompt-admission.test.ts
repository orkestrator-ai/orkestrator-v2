import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structuredOutputFailure } from "@orkestrator/protocol/structured-output";
import type { PromptOptions, SessionState } from "../types/index.js";
import {
  createSession,
  mockQuery,
  releaseTemporaryClaudeHome,
  setClaudeHomeForTesting,
  track,
  blockClaudeConfigDir,
} from "./session-manager-test-harness.js";
import {
  TRANSCRIPT_READ_FAILED,
  admitPrompt,
  applyPromptPlanMode,
  installPromptTranscript,
  promptPlanModeChange,
} from "./session-manager-prompt-admission.js";
import { claimedPromptDispatches } from "./session-manager-core.js";
import { getPromptDispatchRecord, recordPromptDispatch } from "./session-manager-lifecycle.js";
import { captureTurnStartup } from "./session-manager-prompt-turn.js";

function bareSession(fields: Partial<SessionState> = {}): SessionState {
  return { id: "session-admission", messages: [], ...fields } as unknown as SessionState;
}

describe("prompt admission", () => {
  function registeredSession(fields: Partial<SessionState> = {}) {
    const session = createSession("admission");
    track(session.id);
    return Object.assign(session, fields);
  }

  test("claims foreground, hydration and dispatch before another prompt can enter", () => {
    const session = registeredSession({ persistedMessagesLoaded: false });
    const admission = admitPrompt(session.id, { requestId: "  request-1  " })!;
    expect(admission.session).toBe(session);
    expect(admission.dispatchRequestId).toBe("request-1");
    expect(admission.needsTranscriptHydration).toBe(true);
    expect(session.persistedMessagesLoaded).toBe(true);
    expect(session.status).toBe("running");
    expect(session.abortController).toBe(admission.abortController);
    expect(session.latestTurnGeneration).toBe(admission.turnGeneration);
    expect(session.inProgressUsageGeneration).toBe(admission.turnGeneration);
    expect(session.turnStartedAt).toEqual(expect.any(String));
    expect(getPromptDispatchRecord(session.id, "request-1")?.state).toBe("processing");
    expect(admitPrompt(session.id, { requestId: "request-1" })).toBeUndefined();
    expect(() => admitPrompt(session.id, { requestId: "request-2" })).toThrow("already processing");
    expect(getPromptDispatchRecord(session.id, "request-2")).toBeUndefined();
  });

  test("consumes only the matching plain-prompt dispatch claim", () => {
    const session = registeredSession({ status: "running" });
    claimedPromptDispatches.set(session.id, "claimed");
    expect(() => admitPrompt(session.id, { requestId: "other" })).toThrow("already processing");
    expect(claimedPromptDispatches.get(session.id)).toBe("claimed");
    expect(admitPrompt(session.id, { requestId: " claimed " })).toBeDefined();
    expect(claimedPromptDispatches.has(session.id)).toBe(false);
  });

  test.each(["processing", "already-processed"] as const)(
    "deduplicates a %s dispatch without changing the session",
    (state) => {
      const session = registeredSession();
      recordPromptDispatch(session.id, "duplicate", state);
      const before = captureTurnStartup(session);
      expect(admitPrompt(session.id, { requestId: "duplicate" })).toBeUndefined();
      expect(captureTurnStartup(session)).toEqual(before);
    },
  );

  test.each(["running", "settled"])("deduplicates a %s structured request", (state) => {
    const session = registeredSession({
      status: state === "running" ? "running" : "idle",
      structuredOutputRequestId: "structured",
      ...(state === "settled"
        ? {
            structuredOutput: structuredOutputFailure("claude", "interrupted", "Stopped", {
              requestId: "structured",
            }),
          }
        : {}),
    });
    const before = captureTurnStartup(session);
    expect(
      admitPrompt(session.id, { requestId: "structured", outputSchema: { type: "object" } }),
    ).toBeUndefined();
    expect(captureTurnStartup(session)).toEqual(before);
  });

  test.each([
    [{ deleting: true }, "being deleted"],
    [{ status: "running" }, "already processing"],
    [{ rewindInProgress: true }, "restoring files"],
  ] as const)("refuses %p without reserving dispatch or foreground", (fields, message) => {
    const session = registeredSession(fields);
    const before = captureTurnStartup(session);
    expect(() => admitPrompt(session.id, { requestId: "refused" })).toThrow(message);
    expect(captureTurnStartup(session)).toEqual(before);
    expect(getPromptDispatchRecord(session.id, "refused")).toBeUndefined();
  });

  test("refuses a missing session", () => {
    expect(() => admitPrompt("missing", undefined)).toThrow("not found");
  });

  test("failed plan-mode persistence restores all startup reservations and permits retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-admission-rollback-"));
    setClaudeHomeForTesting(directory);
    try {
      await blockClaudeConfigDir(directory);
      const previousAbort = new AbortController();
      const session = registeredSession({
        planMode: false,
        persistedMessagesLoaded: false,
        abortController: previousAbort,
        latestTurnGeneration: 17,
        inProgressUsageGeneration: 17,
        inProgressUsage: {
          usedTokens: 5,
          inputTokens: 3,
          outputTokens: 2,
          source: "claude",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        turnStartedAt: "2026-01-01T00:00:00.000Z",
        error: "previous error",
        structuredOutputRequestId: "previous",
        structuredOutput: structuredOutputFailure("claude", "interrupted", "Stopped", {
          requestId: "previous",
        }),
      });
      const before = captureTurnStartup(session);
      const options = { requestId: "retryable", outputSchema: { type: "object" } };
      const admission = admitPrompt(session.id, options)!;
      const claimedEpoch = session.transcriptEpoch;
      await expect(applyPromptPlanMode(admission, true)).rejects.toBeTruthy();
      expect(captureTurnStartup(session)).toEqual(before);
      expect(session.planMode).toBe(false);
      expect(session.transcriptEpoch).not.toBe(claimedEpoch);
      expect(admission.abortController.signal.aborted).toBe(true);
      expect(previousAbort.signal.aborted).toBe(false);
      expect(getPromptDispatchRecord(session.id, "retryable")).toBeUndefined();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(admitPrompt(session.id, options)).toBeDefined();
    } finally {
      await releaseTemporaryClaudeHome(directory);
    }
  });

  test.each([
    [undefined, "plan", true],
    [false, "plan", true],
    [true, "plan", undefined],
    [true, "bypassPermissions", false],
    [false, "bypassPermissions", undefined],
    [true, "default", undefined],
    [false, "acceptEdits", undefined],
    [true, undefined, undefined],
  ] as const)(
    "a session in plan mode %p sent %p records %p",
    (planMode, permissionMode, expected) => {
      const options: PromptOptions | undefined = permissionMode ? { permissionMode } : undefined;
      expect(promptPlanModeChange(bareSession({ planMode }), options)).toBe(expected);
    },
  );

  test("a failed transcript read installs nothing and is reported", () => {
    const session = bareSession();
    const before = session.messages;
    expect(installPromptTranscript(session, TRANSCRIPT_READ_FAILED)).toBe(true);
    expect(session.messages).toBe(before);
  });

  test("an absent transcript leaves the session as it was", () => {
    const session = bareSession();
    const before = session.messages;
    expect(installPromptTranscript(session, undefined)).toBe(false);
    expect(session.messages).toBe(before);
  });
});

test.each(["default", "acceptEdits", "auto"] as const)(
  "a %s build selection exits plan mode only when it matches approvalMode",
  (mode) => {
    expect(
      promptPlanModeChange(bareSession({ planMode: true }), {
        permissionMode: mode,
        approvalMode: mode,
      }),
    ).toBe(false);
    expect(
      promptPlanModeChange(bareSession({ planMode: false }), {
        permissionMode: mode,
        approvalMode: mode,
      }),
    ).toBeUndefined();
    expect(
      promptPlanModeChange(bareSession({ planMode: true }), { permissionMode: mode }),
    ).toBeUndefined();
    expect(
      promptPlanModeChange(bareSession({ planMode: true }), {
        permissionMode: "dontAsk",
        approvalMode: mode,
      }),
    ).toBeUndefined();
  },
);
