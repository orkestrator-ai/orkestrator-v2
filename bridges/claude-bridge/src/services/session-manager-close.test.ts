import { describe, expect, mock, test } from "bun:test";

import {
  PERSISTED_SDK_ID,
  claimPromptDispatch,
  createSession,
  deleteSessionDurably,
  getPendingPlanApprovals,
  getSession,
  materializePersistedSession,
  mockSdkDeleteSession,
  mockSdkListSessions,
  nextQueryCall,
  queryControlOverrides,
  readSessionPreferences,
  reconcilePersistedSessions,
  sdkSessionInfo,
  sendPrompt,
  track,
  updateSessionPreferences,
  waitFor,
} from "./session-manager-test-harness.js";

// Loaded after the harness so it binds to the same mocked session-manager graph.
const { SessionCloseNotConfirmedError, closeSessionRetainingHistory } =
  await import("./session-manager-close.js");

describe("closeSessionRetainingHistory", () => {
  test("releases a completed session but keeps its rollout, preferences and listing", async () => {
    const state = await materializePersistedSession();
    await updateSessionPreferences(PERSISTED_SDK_ID, {
      planMode: true,
      dispatchedRequestIds: ["close-retains-request"],
    });
    const prompt = sendPrompt(state.id, "finish a turn", { requestId: "close-turn" });
    const call = await nextQueryCall();
    call.push({ type: "result", subtype: "success", result: "done" });
    call.finish();
    await prompt;

    await expect(closeSessionRetainingHistory(state.id)).resolves.toBe("closed");

    expect(mockSdkDeleteSession).not.toHaveBeenCalled();
    expect(getSession(state.id)).toBeUndefined();
    // The durable dispatch journal survives, so a resumed tab cannot replay a
    // prompt this conversation already ran.
    expect((await readSessionPreferences(PERSISTED_SDK_ID))?.dispatchedRequestIds).toContain(
      "close-retains-request",
    );

    // History stays discoverable: the SDK listing re-adopts it as an idle,
    // resumable session under the same bridge id.
    mockSdkListSessions.mockImplementation(async () => [sdkSessionInfo()]);
    await reconcilePersistedSessions();
    const listed = getSession(state.id);
    expect(listed).toBeDefined();
    expect(listed).not.toBe(state);
    expect(listed?.status).toBe("idle");
    expect(listed?.sdkSessionId).toBe(PERSISTED_SDK_ID);
  });

  test("answers an unknown or already-closed id as missing, so a lost response retries safely", async () => {
    await expect(closeSessionRetainingHistory("session-never-existed")).resolves.toBe("missing");

    const state = createSession("close twice");
    track(state.id);
    await expect(closeSessionRetainingHistory(state.id)).resolves.toBe("closed");
    await expect(closeSessionRetainingHistory(state.id)).resolves.toBe("missing");
    expect(mockSdkDeleteSession).not.toHaveBeenCalled();
  });

  test("stops a running turn, refuses new prompts while closing, and shares one close", async () => {
    const state = await materializePersistedSession();
    let finishClose: (() => void) | undefined;
    const close = mock(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const abort = new AbortController();
    state.abortController = abort;
    state.status = "running";
    state.queryControl = { close };

    const first = closeSessionRetainingHistory(state.id);
    const second = closeSessionRetainingHistory(state.id);
    expect(second).toBe(first);
    expect(abort.signal.aborted).toBe(true);
    expect(state.deleting).toBe(true);
    await expect(sendPrompt(state.id, "too late")).rejects.toMatchObject({ code: "conflict" });
    await expect(deleteSessionDurably(state.id)).rejects.toMatchObject({ code: "conflict" });

    await waitFor(() => finishClose !== undefined);
    // Close has not been confirmed while the query is still shutting down.
    expect(getSession(state.id)).toBe(state);
    finishClose!();
    await expect(first).resolves.toBe("closed");
    expect(close).toHaveBeenCalledTimes(1);
    expect(getSession(state.id)).toBeUndefined();
    expect(mockSdkDeleteSession).not.toHaveBeenCalled();
  });

  test("denies a pending plan approval rather than leaving it answerable", async () => {
    const state = createSession("close-plan");
    track(state.id);
    const prompt = sendPrompt(state.id, "plan", { permissionMode: "plan" });
    const call = await nextQueryCall();
    const tool = call.options.canUseTool!("ExitPlanMode", {});
    await waitFor(() => getPendingPlanApprovals(state.id).length === 1);

    await expect(closeSessionRetainingHistory(state.id)).resolves.toBe("closed");
    expect((await tool).behavior).toBe("deny");
    expect(getPendingPlanApprovals(state.id)).toEqual([]);
    await prompt.catch(() => undefined);
  });

  test("refuses to report a close while a permanent deletion owns the session", async () => {
    const state = await materializePersistedSession();
    let finishDelete: (() => void) | undefined;
    mockSdkDeleteSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishDelete = resolve;
        }),
    );
    const deletion = deleteSessionDurably(state.id);
    await expect(closeSessionRetainingHistory(state.id)).rejects.toMatchObject({
      code: "conflict",
    });
    await waitFor(() => finishDelete !== undefined);
    finishDelete!();
    await expect(deletion).resolves.toBe(true);
  });

  test("keeps a session registered and fenced when query close throws, then a retry closes it", async () => {
    const state = await materializePersistedSession();
    let failClose = true;
    const close = mock(() => {
      if (failClose) throw new Error("/home/user/.claude/projects/secret.jsonl: EPERM");
    });
    // Installed on the real SDK query of a live turn.
    queryControlOverrides.close = close;
    const prompt = sendPrompt(state.id, "long turn");
    await nextQueryCall();
    await waitFor(() => state.queryControl !== undefined);

    await expect(closeSessionRetainingHistory(state.id)).rejects.toBeInstanceOf(
      SessionCloseNotConfirmedError,
    );
    // Stop is not proven: the session is still addressable and still fenced.
    expect(getSession(state.id)).toBe(state);
    expect(state.deleting).toBe(true);
    await expect(sendPrompt(state.id, "sneak in")).rejects.toMatchObject({ code: "conflict" });
    await expect(deleteSessionDurably(state.id)).rejects.toMatchObject({ code: "conflict" });
    await prompt.catch(() => undefined);

    // The retry takes the stalled claim over and closes the same query again
    // (the aborted turn's own best-effort close may have run in between).
    failClose = false;
    const closesBeforeRetry = close.mock.calls.length;
    await expect(closeSessionRetainingHistory(state.id)).resolves.toBe("closed");
    expect(close.mock.calls.length).toBe(closesBeforeRetry + 1);
    expect(getSession(state.id)).toBeUndefined();
    expect(mockSdkDeleteSession).not.toHaveBeenCalled();
  });

  test("answers not confirmed when query close outlives the budget, then a retry closes it", async () => {
    const state = await materializePersistedSession();
    const close = mock()
      .mockImplementationOnce(() => new Promise<void>(() => {}))
      .mockImplementation(async () => {});
    state.queryControl = { close };

    await expect(closeSessionRetainingHistory(state.id, { budgetMs: 20 })).rejects.toBeInstanceOf(
      SessionCloseNotConfirmedError,
    );
    expect(getSession(state.id)).toBe(state);
    expect(state.deleting).toBe(true);

    await expect(closeSessionRetainingHistory(state.id, { budgetMs: 20 })).resolves.toBe("closed");
    expect(close).toHaveBeenCalledTimes(2);
    expect(getSession(state.id)).toBeUndefined();
  });

  test("answers not confirmed while a racing dispatch claim is unsettled", async () => {
    const state = await materializePersistedSession();
    let persist: (() => void) | undefined;
    const dispatch = mock(() => {
      throw new Error("a claim racing close must not start its turn");
    });
    const claim = claimPromptDispatch(state.id, "close-race-request", dispatch, {
      beforePersistence: () =>
        new Promise<void>((resolve) => {
          persist = resolve;
        }),
    });
    await waitFor(() => persist !== undefined);

    await expect(closeSessionRetainingHistory(state.id, { budgetMs: 20 })).rejects.toBeInstanceOf(
      SessionCloseNotConfirmedError,
    );
    expect(getSession(state.id)).toBe(state);

    // The claim sees the close's fence, rolls its journal entry back and fails.
    persist!();
    await expect(claim).rejects.toMatchObject({ code: "conflict" });
    expect(dispatch).not.toHaveBeenCalled();
    await expect(closeSessionRetainingHistory(state.id)).resolves.toBe("closed");
    expect(
      (await readSessionPreferences(PERSISTED_SDK_ID))?.dispatchedRequestIds ?? [],
    ).not.toContain("close-race-request");
  });
});
