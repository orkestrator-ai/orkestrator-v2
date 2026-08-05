import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realBackend from "@/lib/backend";
import type { Session } from "@/types";

const realBackendSnapshot = { ...realBackend };
const getSessionsByEnvironmentMock = mock<
  (environmentId: string) => Promise<Session[]>
>(async () => []);
const updateSessionStatusMock = mock(async (_sessionId: string, _status: string) => {});
const createSessionMock = mock(async () => makeSession());
const updateSessionActivityMock = mock(async () => makeSession({ lastActivityAt: "later" }));
const deleteSessionMock = mock(async () => {});
const deleteSessionsByEnvironmentMock = mock(async () => {});
const disconnectEnvironmentSessionsMock = mock(async () => [] as Session[]);
const saveSessionBufferMock = mock(async () => {});
const loadSessionBufferMock = mock(async () => null as string | null);
const syncSessionsWithContainerMock = mock(async () => [] as Session[]);
const renameSessionMock = mock(async (_id: string, name: string | null) => makeSession({ name: name ?? undefined }));
const reorderSessionsMock = mock(async () => [] as Session[]);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getSessionsByEnvironment: getSessionsByEnvironmentMock,
  updateSessionStatus: updateSessionStatusMock,
  createSession: createSessionMock,
  updateSessionActivity: updateSessionActivityMock,
  deleteSession: deleteSessionMock,
  deleteSessionsByEnvironment: deleteSessionsByEnvironmentMock,
  disconnectEnvironmentSessions: disconnectEnvironmentSessionsMock,
  saveSessionBuffer: saveSessionBufferMock,
  loadSessionBuffer: loadSessionBufferMock,
  syncSessionsWithContainer: syncSessionsWithContainerMock,
  renameSession: renameSessionMock,
  reorderSessions: reorderSessionsMock,
}));

const { useSessionStore } = await import("./sessionStore");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    environmentId: "env-1",
    containerId: "container-1",
    tabId: "tab-1",
    sessionType: "plain",
    status: "connected",
    createdAt: "2026-07-28T00:00:00.000Z",
    lastActivityAt: "2026-07-28T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("sessionStore.loadSessionsForEnvironment", () => {
  beforeEach(() => {
    getSessionsByEnvironmentMock.mockReset();
    getSessionsByEnvironmentMock.mockResolvedValue([]);
    useSessionStore.setState({
      sessions: new Map(),
      loadingEnvironments: new Set(),
      error: null,
    });
  });

  test("preserves map and session identity for an unchanged snapshot", async () => {
    const session = makeSession();
    const sessions = new Map([[session.id, session]]);
    useSessionStore.setState({ sessions });
    getSessionsByEnvironmentMock.mockResolvedValue([{ ...session }]);

    await useSessionStore.getState().loadSessionsForEnvironment("env-1");

    const state = useSessionStore.getState();
    expect(state.sessions).toBe(sessions);
    expect(state.sessions.get(session.id)).toBe(session);
    expect(state.loadingEnvironments.has("env-1")).toBe(false);
  });

  test("preserves identity when the same session arrives with reordered keys", async () => {
    // A serialized compare is key-order sensitive, so a backend response that
    // emitted its fields in another order would republish identical sessions
    // and rerender every terminal bound to them.
    const session = makeSession();
    const sessions = new Map([[session.id, session]]);
    useSessionStore.setState({ sessions });
    const reordered = Object.fromEntries(
      Object.entries(session).reverse(),
    ) as Session;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(session));
    getSessionsByEnvironmentMock.mockResolvedValue([reordered]);

    await useSessionStore.getState().loadSessionsForEnvironment("env-1");

    const state = useSessionStore.getState();
    expect(state.sessions).toBe(sessions);
    expect(state.sessions.get(session.id)).toBe(session);
  });

  test("adopts a session that only differs by an explicitly undefined field", async () => {
    // A serialized compare erases undefined-valued fields, so a record whose
    // optional field was cleared reads as identical and the stale object is
    // kept instead of the authoritative one.
    const session = makeSession();
    useSessionStore.setState({ sessions: new Map([[session.id, session]]) });
    expect(Object.hasOwn(session, "name")).toBe(false);
    getSessionsByEnvironmentMock.mockResolvedValue([
      { ...session, name: undefined },
    ]);

    await useSessionStore.getState().loadSessionsForEnvironment("env-1");

    const stored = useSessionStore.getState().sessions.get(session.id);
    expect(stored).not.toBe(session);
    expect(Object.hasOwn(stored!, "name")).toBe(true);
  });

  test("reuses unchanged entries while replacing changed entries", async () => {
    const unchanged = makeSession({ id: "session-1", order: 0 });
    const changed = makeSession({ id: "session-2", order: 1, name: "old" });
    useSessionStore.setState({
      sessions: new Map([
        [unchanged.id, unchanged],
        [changed.id, changed],
      ]),
    });
    getSessionsByEnvironmentMock.mockResolvedValue([
      { ...unchanged },
      { ...changed, name: "new" },
    ]);

    await useSessionStore.getState().loadSessionsForEnvironment("env-1");

    const sessions = useSessionStore.getState().sessions;
    expect(sessions.get(unchanged.id)).toBe(unchanged);
    expect(sessions.get(changed.id)).not.toBe(changed);
    expect(sessions.get(changed.id)?.name).toBe("new");
  });

  test("records the latest load error and clears loading state", async () => {
    getSessionsByEnvironmentMock.mockRejectedValue(new Error("sessions unavailable"));

    await useSessionStore.getState().loadSessionsForEnvironment("env-1");

    const state = useSessionStore.getState();
    expect(state.error).toBe("sessions unavailable");
    expect(state.loadingEnvironments.has("env-1")).toBe(false);
  });

  test("does not let an older concurrent load overwrite a newer snapshot", async () => {
    const older = deferred<Session[]>();
    const newer = deferred<Session[]>();
    getSessionsByEnvironmentMock
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const first = useSessionStore.getState().loadSessionsForEnvironment("env-1");
    const second = useSessionStore.getState().loadSessionsForEnvironment("env-1");
    newer.resolve([makeSession({ name: "newer" })]);
    await second;
    older.resolve([makeSession({ name: "older" })]);
    await first;

    const state = useSessionStore.getState();
    expect(state.sessions.get("session-1")?.name).toBe("newer");
    expect(state.loadingEnvironments.has("env-1")).toBe(false);
    expect(state.error).toBeNull();
  });

  test("keeps stale tokens isolated after the latest request settles and cleans up", async () => {
    const oldest = deferred<Session[]>();
    const latest = deferred<Session[]>();
    getSessionsByEnvironmentMock
      .mockImplementationOnce(() => oldest.promise)
      .mockResolvedValueOnce([makeSession({ name: "middle" })])
      .mockImplementationOnce(() => latest.promise);

    const first = useSessionStore.getState().loadSessionsForEnvironment("env-1");
    await useSessionStore.getState().loadSessionsForEnvironment("env-1");
    const third = useSessionStore.getState().loadSessionsForEnvironment("env-1");

    oldest.resolve([makeSession({ name: "oldest" })]);
    await first;
    expect(useSessionStore.getState().sessions.get("session-1")?.name).toBe(
      "middle",
    );
    expect(useSessionStore.getState().loadingEnvironments.has("env-1")).toBe(
      true,
    );

    latest.resolve([makeSession({ name: "latest" })]);
    await third;
    expect(useSessionStore.getState().sessions.get("session-1")?.name).toBe(
      "latest",
    );
    expect(useSessionStore.getState().loadingEnvironments.has("env-1")).toBe(
      false,
    );
  });
});

describe("sessionStore.updateSessionStatus", () => {
  beforeEach(() => {
    updateSessionStatusMock.mockReset();
    updateSessionStatusMock.mockResolvedValue(undefined);
    const session = makeSession({ status: "connected" });
    useSessionStore.setState({ sessions: new Map([[session.id, session]]), error: null });
  });

  test("keeps the optimistic status after a successful update", async () => {
    await useSessionStore.getState().updateSessionStatus("session-1", "disconnected");

    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("disconnected");
    expect(updateSessionStatusMock).toHaveBeenCalledWith("session-1", "disconnected");
  });

  test("rolls back the latest failed optimistic update", async () => {
    updateSessionStatusMock.mockRejectedValue(new Error("offline"));

    await useSessionStore.getState().updateSessionStatus("session-1", "disconnected");

    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("connected");
  });

  test("does not let an older same-target failure undo a newer success", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    updateSessionStatusMock
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const first = useSessionStore.getState().updateSessionStatus("session-1", "disconnected");
    const second = useSessionStore.getState().updateSessionStatus("session-1", "disconnected");
    older.reject(new Error("older failed"));
    await first;
    newer.resolve();
    await second;

    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("disconnected");
  });

  test("rolls back to the last confirmed status when both updates fail", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    updateSessionStatusMock
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const first = useSessionStore.getState().updateSessionStatus("session-1", "disconnected");
    const second = useSessionStore.getState().updateSessionStatus("session-1", "connected");
    older.reject(new Error("older failed"));
    await first;
    newer.reject(new Error("newer failed"));
    await second;

    // "disconnected" was only ever optimistic, so restoring it would leave a
    // status the backend never accepted.
    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("connected");
  });

  test("restores an older confirmed status when a newer queued update fails", async () => {
    const older = deferred<void>();
    const newer = deferred<void>();
    updateSessionStatusMock
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    const first = useSessionStore.getState().updateSessionStatus("session-1", "disconnected");
    const second = useSessionStore.getState().updateSessionStatus("session-1", "connected");

    // The newer optimistic value remains visible while the first write settles.
    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("connected");
    await Promise.resolve();
    expect(updateSessionStatusMock).toHaveBeenCalledTimes(1);

    older.resolve();
    await first;
    expect(updateSessionStatusMock).toHaveBeenCalledTimes(2);
    newer.reject(new Error("newer failed"));
    await second;

    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("disconnected");
  });

  test("forgets a settled request so a later rollback uses the new baseline", async () => {
    await useSessionStore.getState().updateSessionStatus("session-1", "disconnected");
    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("disconnected");

    updateSessionStatusMock.mockRejectedValueOnce(new Error("offline"));
    await useSessionStore.getState().updateSessionStatus("session-1", "connected");

    // A leaked entry from the successful update would still hold "connected" as
    // its baseline and undo a status the backend has confirmed.
    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("disconnected");
  });

  test("still calls the backend when the session is not currently loaded", async () => {
    useSessionStore.setState({ sessions: new Map() });

    await useSessionStore.getState().updateSessionStatus("missing", "disconnected");

    expect(updateSessionStatusMock).toHaveBeenCalledWith("missing", "disconnected");
    expect(useSessionStore.getState().sessions.has("missing")).toBe(false);
  });
});

describe("sessionStore remaining actions", () => {
  beforeEach(() => {
    getSessionsByEnvironmentMock.mockReset();
    getSessionsByEnvironmentMock.mockResolvedValue([]);
    for (const backendMock of [
      createSessionMock,
      updateSessionActivityMock,
      deleteSessionMock,
      deleteSessionsByEnvironmentMock,
      disconnectEnvironmentSessionsMock,
      saveSessionBufferMock,
      loadSessionBufferMock,
      syncSessionsWithContainerMock,
      renameSessionMock,
      reorderSessionsMock,
    ]) backendMock.mockReset();
    createSessionMock.mockResolvedValue(makeSession());
    updateSessionActivityMock.mockResolvedValue(makeSession({ lastActivityAt: "later" }));
    deleteSessionMock.mockResolvedValue(undefined);
    deleteSessionsByEnvironmentMock.mockResolvedValue(undefined);
    disconnectEnvironmentSessionsMock.mockResolvedValue([]);
    saveSessionBufferMock.mockResolvedValue(undefined);
    loadSessionBufferMock.mockResolvedValue(null);
    syncSessionsWithContainerMock.mockResolvedValue([]);
    renameSessionMock.mockImplementation(async (_id, name) => makeSession({ name: name ?? undefined }));
    reorderSessionsMock.mockResolvedValue([]);
    useSessionStore.setState({ sessions: new Map(), loadingEnvironments: new Set(), error: null });
  });

  test("creates, updates activity, renames, and forwards buffer operations", async () => {
    const store = useSessionStore.getState();
    await expect(store.createSession("env-1", "container-1", "tab-1", "plain")).resolves.toMatchObject({ id: "session-1" });
    await store.updateSessionActivity("session-1");
    await store.renameSession("session-1", "Renamed");
    await store.saveSessionBuffer("session-1", "buffer");
    loadSessionBufferMock.mockResolvedValueOnce("restored");
    await expect(store.loadSessionBuffer("session-1")).resolves.toBe("restored");
    expect(useSessionStore.getState().sessions.get("session-1")).toMatchObject({ name: "Renamed" });
    expect(saveSessionBufferMock).toHaveBeenCalledWith("session-1", "buffer");
  });

  test("rolls back failed single and environment deletions", async () => {
    const first = makeSession();
    const second = makeSession({ id: "session-2" });
    useSessionStore.setState({ sessions: new Map([[first.id, first], [second.id, second]]) });
    deleteSessionMock.mockRejectedValueOnce(new Error("delete failed"));
    await expect(useSessionStore.getState().deleteSession(first.id)).rejects.toThrow("delete failed");
    expect(useSessionStore.getState().sessions.has(first.id)).toBe(true);

    deleteSessionsByEnvironmentMock.mockRejectedValueOnce(new Error("bulk failed"));
    await expect(useSessionStore.getState().deleteSessionsByEnvironment("env-1")).rejects.toThrow("bulk failed");
    expect(useSessionStore.getState().sessions.size).toBe(2);
  });

  test("applies disconnect and sync snapshots while preserving other environments", async () => {
    const other = makeSession({ id: "other", environmentId: "env-2" });
    useSessionStore.setState({ sessions: new Map([[other.id, other], ["old", makeSession({ id: "old" })]]) });
    disconnectEnvironmentSessionsMock.mockResolvedValueOnce([makeSession({ status: "disconnected" })]);
    await useSessionStore.getState().disconnectEnvironmentSessions("env-1");
    expect(useSessionStore.getState().sessions.get("session-1")?.status).toBe("disconnected");

    syncSessionsWithContainerMock.mockResolvedValueOnce([makeSession({ id: "synced" })]);
    await useSessionStore.getState().syncSessionsWithContainer("env-1", true);
    expect(useSessionStore.getState().sessions.has("old")).toBe(false);
    expect(useSessionStore.getState().sessions.has("synced")).toBe(true);
    expect(useSessionStore.getState().sessions.get("other")).toBe(other);
  });

  test("optimistically reorders and adopts the authoritative response", async () => {
    const first = makeSession({ id: "a", order: 0 });
    const second = makeSession({ id: "b", order: 1 });
    useSessionStore.setState({ sessions: new Map([[first.id, first], [second.id, second]]) });
    reorderSessionsMock.mockResolvedValueOnce([{ ...second, order: 0 }, { ...first, order: 1 }]);
    await useSessionStore.getState().reorderSessions("env-1", ["b", "a"]);
    expect(useSessionStore.getState().getSessionsByEnvironment("env-1").map((s) => s.id)).toEqual(["b", "a"]);
  });

  test("handles remaining backend error paths without publishing false state", async () => {
    const original = makeSession({ name: "original" });
    useSessionStore.setState({ sessions: new Map([[original.id, original]]) });
    createSessionMock.mockRejectedValueOnce(new Error("create failed"));
    await expect(
      useSessionStore.getState().createSession("env-1", "container-1", "tab-1", "plain"),
    ).rejects.toThrow("create failed");

    renameSessionMock.mockRejectedValueOnce(new Error("rename failed"));
    await expect(useSessionStore.getState().renameSession(original.id, "bad")).rejects.toThrow("rename failed");
    expect(useSessionStore.getState().sessions.get(original.id)?.name).toBe("original");

    updateSessionActivityMock.mockRejectedValueOnce(new Error("activity failed"));
    disconnectEnvironmentSessionsMock.mockRejectedValueOnce(new Error("disconnect failed"));
    syncSessionsWithContainerMock.mockRejectedValueOnce(new Error("sync failed"));
    await useSessionStore.getState().updateSessionActivity(original.id);
    await useSessionStore.getState().disconnectEnvironmentSessions("env-1");
    await useSessionStore.getState().syncSessionsWithContainer("env-1", false);
    expect(useSessionStore.getState().sessions.get(original.id)?.name).toBe("original");

    reorderSessionsMock.mockRejectedValueOnce(new Error("reorder failed"));
    getSessionsByEnvironmentMock.mockResolvedValueOnce([original]);
    await useSessionStore.getState().reorderSessions("env-1", [original.id]);
    await Promise.resolve();
    expect(getSessionsByEnvironmentMock).toHaveBeenCalledWith("env-1");
  });

  test("covers local mutations, selectors, and clear-all", () => {
    const store = useSessionStore.getState();
    const later = makeSession({ id: "later", order: 2 });
    const first = makeSession({ id: "first", order: 0 });
    store.addSession(later);
    store.addSession(first);
    store.updateSession("later", { name: "updated" });
    store.updateSession("missing", { name: "ignored" });
    expect(store.getSessionsByEnvironment("env-1").map((s) => s.id)).toEqual(["first", "later"]);
    expect(store.getSession("later")?.name).toBe("updated");
    expect(store.isLoadingEnvironment("env-1")).toBe(false);
    store.removeSession("first");
    store.setError("problem");
    expect(useSessionStore.getState().error).toBe("problem");
    store.clearAllSessions();
    expect(useSessionStore.getState().sessions.size).toBe(0);
  });
});
