import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import * as realBackend from "@/lib/backend";
import * as realSonner from "sonner";

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
const toastErrorMock = mock(() => {});

const realBackendSnapshot = { ...realBackend };
const realSonnerSnapshot = { ...realSonner };
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

mock.module("sonner", () => ({
  toast: {
    error: toastErrorMock,
  },
}));

const listenMock = listen as ReturnType<typeof mock>;
const unlistenMock = mock(() => undefined);

const { useTerminal } = await import("./useTerminal");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("sonner", () => realSonnerSnapshot);
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
    toastErrorMock.mockClear();
    listenMock.mockClear();
    unlistenMock.mockClear();

    getTerminalSessionMock.mockImplementation(async (sessionId: string) => ({ id: sessionId, running: true }));
    createLocalTerminalSessionMock.mockImplementation(async () => "session-new-local");
    startLocalTerminalSessionMock.mockImplementation(async () => undefined);
    closeLocalTerminalSessionMock.mockImplementation(async () => undefined);
    createTerminalSessionMock.mockImplementation(async () => "session-new-container");
    startTerminalSessionMock.mockImplementation(async () => undefined);
    detachTerminalMock.mockImplementation(async () => undefined);
    resizeLocalTerminalMock.mockImplementation(async () => undefined);
    resizeTerminalMock.mockImplementation(async () => undefined);
    writeLocalTerminalMock.mockImplementation(async () => undefined);
    writeTerminalMock.mockImplementation(async () => undefined);
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

  it("ignores overlapping connect calls before React connection state updates", async () => {
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        persistSession: true,
      }),
    );

    await act(async () => {
      await Promise.all([
        result.current.connect(),
        result.current.connect(),
      ]);
    });

    await waitFor(() => expect(result.current.sessionId).toBe("session-new-container"));
    expect(createTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(startTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith("terminal-output-session-new-container", expect.any(Function));
  });

  it("does not attach an event listener from a stale in-flight connect after unmount", async () => {
    let resolveCreateSession: (sessionId: string) => void = () => {};
    createTerminalSessionMock.mockImplementation(
      async () =>
        new Promise<string>((resolve) => {
          resolveCreateSession = resolve;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        persistSession: true,
      }),
    );

    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    act(() => {
      unmount();
    });
    resolveCreateSession("session-after-unmount");

    await act(async () => {
      await connectPromise;
    });

    expect(listenMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(detachTerminalMock).toHaveBeenCalledWith("session-after-unmount");
  });

  it("does not surface a stale start failure after unmount", async () => {
    let rejectStartSession: (error: Error) => void = () => {};
    startTerminalSessionMock.mockImplementation(
      async () =>
        new Promise<undefined>((_resolve, reject) => {
          rejectStartSession = reject;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        persistSession: true,
      }),
    );

    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith("terminal-output-session-new-container", expect.any(Function));
    });

    act(() => {
      unmount();
    });
    rejectStartSession(new Error("backend start failed"));

    await act(async () => {
      await connectPromise;
    });

    expect(detachTerminalMock).toHaveBeenCalledWith("session-new-container");
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("disconnects the current container terminal and removes its listener", async () => {
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        persistSession: false,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });
    await waitFor(() => expect(result.current.sessionId).toBe("session-new-container"));

    await act(async () => {
      await result.current.disconnect();
    });

    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(detachTerminalMock).toHaveBeenCalledWith("session-new-container");
    expect(result.current.sessionId).toBeNull();
    expect(result.current.isConnected).toBe(false);
  });

  it("resizes and writes through the connected container session", async () => {
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        persistSession: true,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });
    await waitFor(() => expect(result.current.sessionId).toBe("session-new-container"));

    await act(async () => {
      await result.current.resize(132, 43);
      await result.current.write("echo ok\r");
    });

    expect(resizeTerminalMock).toHaveBeenCalledWith("session-new-container", 132, 43);
    expect(writeTerminalMock).toHaveBeenCalledWith("session-new-container", "echo ok\r");
  });

  it("uses local terminal operations for local resize, write, and disconnect", async () => {
    const { result } = renderHook(() =>
      useTerminal({
        containerId: null,
        environmentId: "env-1",
        isLocal: true,
        persistSession: false,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });
    await waitFor(() => expect(result.current.sessionId).toBe("session-new-local"));

    await act(async () => {
      await result.current.resize(100, 30);
      await result.current.write("pwd\r");
      await result.current.disconnect();
    });

    expect(resizeLocalTerminalMock).toHaveBeenCalledWith("session-new-local", 100, 30);
    expect(writeLocalTerminalMock).toHaveBeenCalledWith("session-new-local", "pwd\r");
    expect(closeLocalTerminalSessionMock).toHaveBeenCalledWith("session-new-local");
  });

  it("detaches the previous session when the container id changes", async () => {
    const { result, rerender } = renderHook(
      ({ containerId }) =>
        useTerminal({
          containerId,
          isLocal: false,
          persistSession: true,
        }),
      { initialProps: { containerId: "container-1" } },
    );

    await act(async () => {
      await result.current.connect();
    });
    await waitFor(() => expect(result.current.sessionId).toBe("session-new-container"));

    rerender({ containerId: "container-2" });

    await waitFor(() => {
      expect(detachTerminalMock).toHaveBeenCalledWith("session-new-container");
    });
    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(result.current.sessionId).toBeNull();
  });
});
