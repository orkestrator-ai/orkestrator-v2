import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import * as realBackend from "@/lib/backend";

const getTerminalSessionMock = mock(async (_sessionId: string) => ({ id: "session-old", running: true }));
const createLocalTerminalSessionMock = mock(async (_environmentId: string, _cols: number, _rows: number) => "session-new-local");
const startLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const closeLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const createTerminalSessionMock = mock(async (_containerId: string, _cols: number, _rows: number, _user?: string) => "session-new-container");
const startTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const detachTerminalMock = mock(async (_sessionId: string) => undefined);
const resizeLocalTerminalMock = mock(async (_sessionId: string, _cols: number, _rows: number) => undefined);
const resizeTerminalMock = mock(async (_sessionId: string, _cols: number, _rows: number) => undefined);
const writeLocalTerminalMock = mock(async (_sessionId: string, _data: string) => undefined);
const writeTerminalMock = mock(async (_sessionId: string, _data: string) => undefined);

const realBackendSnapshot = { ...realBackend };
mock.module("@/lib/backend", () => ({
  getTerminalSession: getTerminalSessionMock,
  createLocalTerminalSession: createLocalTerminalSessionMock,
  startLocalTerminalSession: startLocalTerminalSessionMock,
  closeLocalTerminalSession: closeLocalTerminalSessionMock,
  createTerminalSession: createTerminalSessionMock,
  startTerminalSession: startTerminalSessionMock,
  detachTerminal: detachTerminalMock,
  resizeLocalTerminal: resizeLocalTerminalMock,
  resizeTerminal: resizeTerminalMock,
  writeLocalTerminal: writeLocalTerminalMock,
  writeTerminal: writeTerminalMock,
}));

const listenMock = listen as ReturnType<typeof mock>;
const unlistenMock = mock(() => undefined);

const { useTerminal } = await import("./useTerminal");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("useTerminal reconnect behavior", () => {
  afterEach(() => {
    cleanup();
    getTerminalSessionMock.mockClear();
    createLocalTerminalSessionMock.mockClear();
    startLocalTerminalSessionMock.mockClear();
    closeLocalTerminalSessionMock.mockClear();
    createTerminalSessionMock.mockClear();
    startTerminalSessionMock.mockClear();
    detachTerminalMock.mockClear();
    resizeLocalTerminalMock.mockClear();
    resizeTerminalMock.mockClear();
    writeLocalTerminalMock.mockClear();
    writeTerminalMock.mockClear();
    listenMock.mockClear();
    unlistenMock.mockClear();

    getTerminalSessionMock.mockImplementation(async (sessionId: string) => ({ id: sessionId, running: true }));
    createLocalTerminalSessionMock.mockImplementation(async () => "session-new-local");
    createTerminalSessionMock.mockImplementation(async () => "session-new-container");
    listenMock.mockImplementation(async () => unlistenMock);
  });

  it("reconnects to a running existing local terminal session without restarting it", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "session-old", running: true });

    const { result } = renderHook(() =>
      useTerminal({
        containerId: null,
        environmentId: "env-1",
        isLocal: true,
        existingSessionId: "session-old",
        persistSession: true,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.sessionId).toBe("session-old"));
    expect(getTerminalSessionMock).toHaveBeenCalledWith("session-old");
    expect(createLocalTerminalSessionMock).not.toHaveBeenCalled();
    expect(startLocalTerminalSessionMock).not.toHaveBeenCalled();
    expect(listenMock).toHaveBeenCalledWith("terminal-output-session-old", expect.any(Function));
  });

  it("replaces a stale existing local terminal session and starts the replacement", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "session-old", running: false });
    createLocalTerminalSessionMock.mockResolvedValue("session-new-local");

    const { result } = renderHook(() =>
      useTerminal({
        containerId: null,
        environmentId: "env-1",
        isLocal: true,
        existingSessionId: "session-old",
        persistSession: true,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.sessionId).toBe("session-new-local"));
    expect(getTerminalSessionMock).toHaveBeenCalledWith("session-old");
    expect(createLocalTerminalSessionMock).toHaveBeenCalledWith("env-1", 80, 24);
    expect(startLocalTerminalSessionMock).toHaveBeenCalledWith("session-new-local");
    expect(listenMock).toHaveBeenCalledWith("terminal-output-session-new-local", expect.any(Function));
  });
});
