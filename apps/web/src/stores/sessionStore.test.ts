import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realBackend from "@/lib/backend";
import type { Session } from "@/types";

const realBackendSnapshot = { ...realBackend };
const getSessionsByEnvironmentMock = mock<
  (environmentId: string) => Promise<Session[]>
>(async () => []);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getSessionsByEnvironment: getSessionsByEnvironmentMock,
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
