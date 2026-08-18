import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  abortSession,
  captureEvents,
  claimPromptDispatch,
  clearPromptSuggestion,
  createOrRecoverSession,
  createSession,
  deleteSession,
  deleteSessionDurably,
  getLastIdleTranscriptSweep,
  getPromptDispatchState,
  getSession,
  getSessionInitData,
  getSessionMessages,
  listSessions,
  mockQuery,
  mockSdkGetSessionInfo,
  nextQueryCall,
  readSessionPreferences,
  sdkIdForClientKey,
  sdkSessionInfo,
  sendPrompt,
  sessionIdForClientKey,
  sessionManagerTestHome,
  setClaudeHomeForTesting,
  setSessionPreferences,
  track,
  waitFor,
  withTemporaryClaudeHome,
  withWorkspaceCwd,
} from "./session-manager-test-harness.js";
import type { SdkSessionInfo } from "./session-manager-test-harness.js";

// ---------------------------------------------------------------------------
// Pure session-state CRUD
// ---------------------------------------------------------------------------

describe("session lifecycle", () => {
  test("reports no idle transcript sweep before the first sweep runs", () => {
    expect(getLastIdleTranscriptSweep()).toBeUndefined();
  });

  test("reports no init data for missing or uninitialized sessions", () => {
    const session = createSession("not initialized");
    track(session.id);

    expect(getSessionInitData(session.id)).toBeUndefined();
    expect(getSessionInitData("session-missing")).toBeUndefined();
  });

  test("createSession produces a session with the expected shape and emits session.updated", () => {
    const { events, stop } = captureEvents();
    try {
      const session = createSession("My title");
      track(session.id);

      expect(session.id).toMatch(/^session-/);
      expect(session.title).toBe("My title");
      expect(session.status).toBe("idle");
      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeInstanceOf(Date);

      const updated = events.find(
        (e) => e.type === "session.updated" && e.sessionId === session.id,
      );
      expect(updated).toBeDefined();
      expect((updated?.data as { status?: string })?.status).toBe("idle");
    } finally {
      stop();
    }
  });

  test("createSession assigns a default title when none is provided", () => {
    const session = createSession();
    track(session.id);
    expect(session.title).toMatch(/^Session /);
  });

  test("createSession reuses one session for the same client key", () => {
    const first = createSession("First title", "env-env-1:startup-agent");
    const second = createSession("Second title", "env-env-1:startup-agent");
    track(first.id);

    expect(first.id).toMatch(/^session-client-/);
    expect(second).toBe(first);
    expect(second.title).toBe("First title");
    expect(listSessions().filter((session) => session.id === first.id)).toHaveLength(1);
  });

  test("recovers a client-key session onto the same SDK rollout after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-client-session-restart-"));
    setClaudeHomeForTesting(directory);
    const clientSessionKey = "env-env-1:startup-agent";
    const first = createSession("Startup agent", clientSessionKey);
    track(first.id);
    try {
      const sdkSessionId = sessionIdForClientKey(clientSessionKey)
        ?.slice("session-client-".length)
        .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
      expect(sdkSessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      if (!sdkSessionId) throw new Error("client session key did not produce an SDK id");

      const firstPrompt = sendPrompt(first.id, "Inspect the workspace");
      const firstCall = await nextQueryCall();
      expect(firstCall.options.sessionId).toBe(sdkSessionId);
      expect(firstCall.options.resume).toBeUndefined();
      firstCall.push({
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      });
      firstCall.push({ type: "result", subtype: "success" });
      firstCall.finish();
      await firstPrompt;

      expect(await readSessionPreferences(sdkSessionId)).toMatchObject({
        clientSessionBridgeId: first.id,
      });

      // Simulate the in-memory registry disappearing while the SDK rollout and
      // bridge-owned preference file survive.
      expect(deleteSession(first.id)).toBe(true);
      mockSdkGetSessionInfo.mockImplementation(async (id) =>
        id === sdkSessionId
          ? sdkSessionInfo({
              sessionId: sdkSessionId,
              customTitle: "Recovered startup agent",
            })
          : undefined,
      );

      const recovered = await createOrRecoverSession("Ignored retry title", clientSessionKey);
      expect(recovered).toMatchObject({
        id: first.id,
        sdkSessionId,
        title: "Recovered startup agent",
      });

      const followUp = sendPrompt(recovered.id, "Continue the work");
      const followUpCall = await nextQueryCall();
      expect(followUpCall.options.resume).toBe(sdkSessionId);
      expect(followUpCall.options.sessionId).toBeUndefined();
      followUpCall.push({ type: "result", subtype: "success" });
      followUpCall.finish();
      await followUp;
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("sessionIdForClientKey refuses keys that cannot carry a stable identity", () => {
    // A refused key falls back to a random session id: the caller loses
    // recovery rather than deriving an id from something unusable.
    expect(sessionIdForClientKey(undefined)).toBeUndefined();
    expect(sessionIdForClientKey(42 as unknown as string)).toBeUndefined();
    expect(sessionIdForClientKey("")).toBeUndefined();
    expect(sessionIdForClientKey("  \t\n  ")).toBeUndefined();
    expect(sessionIdForClientKey("x".repeat(513))).toBeUndefined();

    // The boundary length is accepted, and its payload must still be a valid v4
    // UUID or the SDK id could not be recovered from the bridge id.
    expect(sessionIdForClientKey("x".repeat(512))).toMatch(/^session-client-[0-9a-f]{32}$/);
    expect(sdkIdForClientKey("x".repeat(512))).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("createOrRecoverSession creates an unkeyed session without consulting the SDK", async () => {
    const session = await createOrRecoverSession("Untracked");
    track(session.id);

    expect(session.id).toMatch(
      /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(session.title).toBe("Untracked");
    // With no client key there is no durable identity to point-read.
    expect(mockSdkGetSessionInfo).not.toHaveBeenCalled();
  });

  test("createOrRecoverSession creates the stable id on a first launch", async () => {
    await withTemporaryClaudeHome("claude-first-launch-", async () => {
      const clientSessionKey = "env-env-1:startup-agent";
      // Nothing on disk yet — the ordinary first launch of a startup agent.
      mockSdkGetSessionInfo.mockImplementation(async () => undefined);

      const session = await createOrRecoverSession("Startup agent", clientSessionKey);
      track(session.id);

      expect(session.id).toBe(sessionIdForClientKey(clientSessionKey));
      expect(session.title).toBe("Startup agent");
      expect(session.status).toBe("idle");
      // No rollout, so no durable identity yet and nothing to persist under it.
      expect(session.sdkSessionId).toBeUndefined();
      expect(await readSessionPreferences(sdkIdForClientKey(clientSessionKey))).toBeUndefined();

      // A retried launch must join the same conversation, not mint a second.
      expect(await createOrRecoverSession("Ignored retry title", clientSessionKey)).toBe(session);
      expect(listSessions().filter((entry) => entry.id === session.id)).toHaveLength(1);
    });
  });

  test("createOrRecoverSession converges concurrent callers on one session state", async () => {
    await withTemporaryClaudeHome("claude-concurrent-recover-", async () => {
      const clientSessionKey = "env-env-1:startup-agent";
      const alias = track(sessionIdForClientKey(clientSessionKey)!);
      const sdkSessionId = sdkIdForClientKey(clientSessionKey);
      let releaseInfo: ((info: SdkSessionInfo) => void) | undefined;
      mockSdkGetSessionInfo.mockImplementation(
        async () =>
          new Promise<SdkSessionInfo>((resolve) => {
            releaseInfo = resolve;
          }),
      );

      // Two tabs mounting at once, or a launch retried before the first read
      // returned. A second SessionState here is the duplicate session tab.
      const first = createOrRecoverSession("First", clientSessionKey);
      const second = createOrRecoverSession("Second", clientSessionKey);
      await waitFor(() => releaseInfo !== undefined);
      releaseInfo!(
        sdkSessionInfo({
          sessionId: sdkSessionId,
          customTitle: "From disk",
        }),
      );

      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(a.id).toBe(alias);
      expect(getSession(alias)).toBe(a);
      expect(mockSdkGetSessionInfo).toHaveBeenCalledTimes(1);
      expect(listSessions().filter((entry) => entry.sdkSessionId === sdkSessionId)).toHaveLength(1);
    });
  });

  test("persists no metadata for a session with neither plan mode nor a client key", async () => {
    await withTemporaryClaudeHome("claude-metadata-noop-", async () => {
      const session = createSession("no durable metadata");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);

      const promptPromise = sendPrompt(session.id, "go");
      const call = await nextQueryCall();
      call.push({
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      });
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptPromise;

      expect(session.sdkSessionId).toBe(sdkSessionId);
      // The first init is where a durable key appears, but this session has
      // nothing to store under it. Writing `{}` would leave a file that later
      // reads cannot tell apart from a real stored preference.
      expect(await readSessionPreferences(sdkSessionId)).toBeUndefined();
    });
  });

  test("fails a client-key turn whose alias cannot be journaled, with no plan mode set", async () => {
    await withTemporaryClaudeHome("claude-alias-refused-", async (directory) => {
      const clientSessionKey = "env-env-1:startup-agent";
      const sdkSessionId = sdkIdForClientKey(clientSessionKey);
      const session = createSession("Startup agent", clientSessionKey);
      track(session.id);
      const preferencesDirectory = join(directory, ".claude", "orkestrator", "session-preferences");
      await mkdir(preferencesDirectory, { recursive: true });
      await writeFile(join(preferencesDirectory, `${sdkSessionId}.json`), "{", "utf-8");

      const promptPromise = sendPrompt(session.id, "Inspect the workspace");
      const call = await nextQueryCall();
      call.push({
        type: "system",
        subtype: "init",
        session_id: sdkSessionId,
        mcp_servers: [],
        plugins: [],
        slash_commands: [],
      });
      call.finish();

      // Intent: the alias is written for every client-key session, not only for
      // one that has already toggled plan mode, so this refusal is reachable
      // with `planMode` still undefined. Failing the turn is deliberate —
      // continuing would drop the alias and the next reconcile would adopt this
      // rollout a second time under `session-<uuid>`.
      await expect(promptPromise).rejects.toThrow(
        "refusing to overwrite the durable prompt journal",
      );
      expect(session.status).toBe("error");
      expect(session.planMode).toBeUndefined();
    });
  });

  test("getSession and listSessions return registered sessions", () => {
    const a = createSession("alpha");
    const b = createSession("beta");
    track(a.id);
    track(b.id);

    expect(getSession(a.id)?.title).toBe("alpha");
    expect(getSession("session-does-not-exist")).toBeUndefined();

    const ids = listSessions().map((s) => s.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  test("setSessionPreferences rejects an unknown session", async () => {
    await expect(
      setSessionPreferences("session-does-not-exist", { planMode: true }),
    ).rejects.toMatchObject({
      code: "not_found",
      message: "Session not found",
    });
  });

  test("deleteSession removes the session and returns true; subsequent deletes return false", () => {
    const session = createSession("doomed");
    expect(deleteSession(session.id)).toBe(true);
    expect(getSession(session.id)).toBeUndefined();
    expect(deleteSession(session.id)).toBe(false);
  });

  test("abortSession returns false when nothing is running", () => {
    const session = createSession("idle-session");
    track(session.id);
    expect(abortSession(session.id)).toBe(false);
  });

  test("getSessionMessages returns [] for a fresh session and [] for unknown", () => {
    const session = createSession("empty");
    track(session.id);
    expect(getSessionMessages(session.id)).toEqual([]);
    expect(getSessionMessages("session-missing")).toEqual([]);
  });

  test("clears prompt suggestions authoritatively and emits the removal", () => {
    const session = createSession("suggestion");
    track(session.id);
    session.promptSuggestion = "Try the next step";
    const { events, stop } = captureEvents();
    try {
      expect(clearPromptSuggestion(session.id)).toBe(true);
      expect(session.promptSuggestion).toBeUndefined();
      const removalEvent = {
        type: "session.updated",
        sessionId: session.id,
        data: { promptSuggestion: null },
      } as const;
      expect(events).toContainEqual(removalEvent);
      expect(clearPromptSuggestion(session.id)).toBe(true);
      expect(
        events.filter(
          (event) =>
            event.type === removalEvent.type &&
            event.sessionId === removalEvent.sessionId &&
            (event.data as { promptSuggestion?: string | null }).promptSuggestion === null,
        ),
      ).toHaveLength(1);
      expect(clearPromptSuggestion("session-missing")).toBe(false);
    } finally {
      stop();
    }
  });

  test("durably deduplicates stable prompt request ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-journal-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      let promptTask: Promise<void> | undefined;

      expect(
        await claimPromptDispatch(session.id, "initial-prompt:env-1:tab-1", () => {
          promptTask = sendPrompt(session.id, "Launch once", {
            requestId: "initial-prompt:env-1:tab-1",
          });
          return promptTask;
        }),
      ).toBe("claimed");
      expect(
        await claimPromptDispatch(session.id, "initial-prompt:env-1:tab-1", async () => {
          throw new Error("duplicate dispatch must not start");
        }),
      ).toBe("duplicate");
      expect(await readSessionPreferences(sdkSessionId)).toMatchObject({
        dispatchedRequestIds: ["initial-prompt:env-1:tab-1"],
      });

      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptTask;
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("claimPromptDispatch reports an unknown session without starting work", async () => {
    const dispatch = mock(async () => {});

    await expect(
      claimPromptDispatch("session-does-not-exist", "request-missing", dispatch),
    ).resolves.toBe("not-found");
    expect(dispatch).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: "deleting",
      prepare: (session: ReturnType<typeof createSession>) => {
        session.deleting = true;
      },
      message: "Session is being deleted",
    },
    {
      name: "running",
      prepare: (session: ReturnType<typeof createSession>) => {
        session.status = "running";
        session.structuredOutputRequestId = "different-request";
      },
      message: "Session is already processing a prompt",
    },
    {
      name: "rewinding files",
      prepare: (session: ReturnType<typeof createSession>) => {
        session.rewindInProgress = true;
      },
      message: "Session is restoring files from a checkpoint",
    },
  ])(
    "claimPromptDispatch rejects a $name session before persisting",
    async ({ prepare, message }) => {
      await withTemporaryClaudeHome("claude-dispatch-guard-", async () => {
        const session = createSession("guarded dispatch");
        track(session.id);
        prepare(session);
        const dispatch = mock(async () => {});

        await expect(
          claimPromptDispatch(session.id, "request-guarded", dispatch),
        ).rejects.toMatchObject({ code: "conflict", message });
        expect(dispatch).not.toHaveBeenCalled();
        expect(session.dispatchedRequestIds?.has("request-guarded")).not.toBe(true);
        expect(await readSessionPreferences(session.id.slice("session-".length))).toBeUndefined();
      });
    },
  );

  test("reserves a stable-id turn before its durable claim yields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-race-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      let promptTask: Promise<void> | undefined;

      const claim = claimPromptDispatch(session.id, "initial-prompt:env-1:tab-race", () => {
        promptTask = sendPrompt(session.id, "Launch once", {
          requestId: "initial-prompt:env-1:tab-race",
        });
        return promptTask;
      });

      expect(getSession(session.id)?.status).toBe("running");
      await expect(sendPrompt(session.id, "Competing prompt")).rejects.toThrow(
        "already processing",
      );
      await expect(claim).resolves.toBe("claimed");

      const call = await nextQueryCall();
      call.push({ type: "result", subtype: "success" });
      call.finish();
      await promptTask;
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("same-id concurrent claims join the deferred durable outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-join-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const firstDispatch = mock(async () => {});
      const duplicateDispatch = mock(async () => {});

      const first = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join",
        firstDispatch,
        { beforePersistence: () => persistenceGate },
      );
      expect(session.status).toBe("running");
      expect(typeof session.turnStartedAt).toBe("string");
      const duplicate = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join",
        duplicateDispatch,
      );
      let duplicateSettled = false;
      void duplicate.then(
        () => {
          duplicateSettled = true;
        },
        () => {
          duplicateSettled = true;
        },
      );

      await Promise.resolve();
      expect(duplicateSettled).toBe(false);
      expect(firstDispatch).not.toHaveBeenCalled();
      expect(duplicateDispatch).not.toHaveBeenCalled();

      releasePersistence!();
      await expect(first).resolves.toBe("claimed");
      await expect(duplicate).resolves.toBe("duplicate");
      expect(firstDispatch).toHaveBeenCalledTimes(1);
      expect(duplicateDispatch).not.toHaveBeenCalled();
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("same-id concurrent claims share a deferred persistence failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-join-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const firstDispatch = mock(async () => {});
      const duplicateDispatch = mock(async () => {});

      const first = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join-failure",
        firstDispatch,
        { beforePersistence: () => persistenceGate },
      );
      const duplicate = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-join-failure",
        duplicateDispatch,
      );

      releasePersistence!();
      const [firstResult, duplicateResult] = await Promise.allSettled([first, duplicate]);
      expect(firstResult.status).toBe("rejected");
      expect(duplicateResult.status).toBe("rejected");
      expect(firstDispatch).not.toHaveBeenCalled();
      expect(duplicateDispatch).not.toHaveBeenCalled();
      expect(session.turnStartedAt).toBeUndefined();
      expect(session.status).toBe("idle");
      expect(session.dispatchedRequestIds?.has("initial-prompt:env-1:tab-join-failure")).toBe(
        false,
      );
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("durable deletion waits for an invalidated claim to roll back on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-delete-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const dispatch = mock(async () => {});

      const claim = claimPromptDispatch(session.id, "initial-prompt:env-1:tab-delete", dispatch, {
        beforePersistence: () => persistenceGate,
      });
      const deletion = deleteSessionDurably(session.id);
      expect(session.deleting).toBe(true);

      releasePersistence!();
      await expect(claim).rejects.toMatchObject({ code: "conflict" });
      await expect(deletion).resolves.toBe(true);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readSessionPreferences(sdkSessionId)).toBeUndefined();
      expect(getSession(session.id)).toBeUndefined();
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("post-write invalidation removes the request id from the durable journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-invalidate-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      let releasePersistence: (() => void) | undefined;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const dispatch = mock(async () => {});

      const claim = claimPromptDispatch(
        session.id,
        "initial-prompt:env-1:tab-invalidate",
        dispatch,
        { beforePersistence: () => persistenceGate },
      );
      expect(deleteSession(session.id)).toBe(true);

      releasePersistence!();
      await expect(claim).rejects.toMatchObject({ code: "conflict" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await readSessionPreferences(sdkSessionId)).toEqual({});
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back the turn reservation when request-id persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      await writeFile(join(directory, ".claude"), "not a directory", "utf-8");

      await expect(
        claimPromptDispatch(session.id, "initial-prompt:env-1:tab-failure", async () => {}),
      ).rejects.toBeTruthy();

      expect(getSession(session.id)?.status).toBe("idle");
      expect(getSession(session.id)?.turnStartedAt).toBeUndefined();
      expect(
        getSession(session.id)?.dispatchedRequestIds?.has("initial-prompt:env-1:tab-failure"),
      ).toBe(false);
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back the durable claim when dispatch cannot start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-start-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      session.status = "error";
      session.turnStartedAt = "2026-01-01T00:00:00.000Z";
      const sdkSessionId = session.id.slice("session-".length);

      await expect(
        claimPromptDispatch(session.id, "initial-prompt:env-1:tab-start", () => {
          throw new Error("dispatch refused");
        }),
      ).rejects.toThrow("dispatch refused");

      expect(session.status).toBe("error");
      expect(session.turnStartedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(session.dispatchedRequestIds?.has("initial-prompt:env-1:tab-start")).toBe(false);
      expect(await readSessionPreferences(sdkSessionId)).toEqual({});
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rolls back when prompt preparation fails before the SDK query starts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-dispatch-prequery-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("launch");
      track(session.id);
      const sdkSessionId = session.id.slice("session-".length);
      const requestId = "initial-prompt:env-1:tab-prequery";
      const missingImage = join(directory, "missing.png");

      const claim = withWorkspaceCwd(directory, () =>
        claimPromptDispatch(session.id, requestId, () => {
          let resolveStarted: (() => void) | undefined;
          let rejectStarted: ((error: unknown) => void) | undefined;
          const started = new Promise<void>((resolve, reject) => {
            resolveStarted = resolve;
            rejectStarted = reject;
          });
          const completion = sendPrompt(
            session.id,
            "Describe this image",
            {
              requestId,
              attachments: [{ type: "image", path: missingImage }],
            },
            { onQueryStarted: () => resolveStarted?.() },
          );
          void completion.catch((error) => rejectStarted?.(error));
          return { started, completion };
        }),
      );

      await expect(claim).rejects.toMatchObject({
        name: "ClaudeAttachmentError",
        code: "attachment_read_failed",
      });
      expect(mockQuery).not.toHaveBeenCalled();
      expect(session.status).toBe("idle");
      expect(session.turnStartedAt).toBeUndefined();
      expect(session.dispatchedRequestIds?.has(requestId)).toBe(false);
      expect(await readSessionPreferences(sdkSessionId)).toEqual({});
      expect(getPromptDispatchState(session.id, requestId)).toBe("new");
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("acknowledges explicit plan mode only after it is durable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-plan-mode-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("plan");
      track(session.id);
      const { events, stop } = captureEvents();
      try {
        const updated = await setSessionPreferences(session.id, {
          planMode: true,
        });
        expect(updated.planMode).toBe(true);
      } finally {
        stop();
      }

      expect(await readSessionPreferences(session.id.slice("session-".length))).toEqual({
        planMode: true,
      });
      expect(events).toContainEqual({
        type: "session.updated",
        sessionId: session.id,
        data: { planMode: true },
      });
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("keeps the previous plan mode authoritative when persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-plan-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("plan");
      track(session.id);
      session.planMode = false;
      await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
      const { events, stop } = captureEvents();
      try {
        await expect(setSessionPreferences(session.id, { planMode: true })).rejects.toBeTruthy();
      } finally {
        stop();
      }

      expect(session.planMode).toBe(false);
      expect(events).not.toContainEqual({
        type: "session.updated",
        sessionId: session.id,
        data: { planMode: true },
      });
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("restores a claimed turn when plan-mode persistence fails before SDK startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "claude-plan-startup-failure-"));
    setClaudeHomeForTesting(directory);
    try {
      const session = createSession("plan startup");
      track(session.id);
      const requestId = "initial-prompt:env-1:plan-startup-failure";

      const claim = claimPromptDispatch(session.id, requestId, () => {
        const completion = (async () => {
          await rm(join(directory, ".claude"), {
            recursive: true,
            force: true,
          });
          await writeFile(join(directory, ".claude"), "not a directory", "utf-8");
          await sendPrompt(session.id, "Plan this", {
            permissionMode: "plan",
            requestId,
          });
        })();
        return { started: completion, completion };
      });

      await expect(claim).rejects.toBeTruthy();
      expect(mockQuery).not.toHaveBeenCalled();
      expect(session.status).toBe("idle");
      expect(session.turnStartedAt).toBeUndefined();
      expect(session.abortController).toBeUndefined();
      expect(session.persistedMessagesLoaded).toBeUndefined();
      expect(session.dispatchedRequestIds?.has(requestId)).toBe(false);
      expect(getPromptDispatchState(session.id, requestId)).toBe("new");
    } finally {
      setClaudeHomeForTesting(sessionManagerTestHome);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
