import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import * as realBackend from "@/lib/backend";
import { mockToastError as toastErrorMock } from "../../../../tests/mocks/sonner";

const getTerminalSessionMock = mock(async (_sessionId: string) => ({ id: "session-old", running: true }));
const createLocalTerminalSessionMock = mock(async (_environmentId: string, _cols: number, _rows: number) => "session-new-local");
const startLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const closeLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const createTerminalSessionMock = mock(async (_containerId: string, _cols: number, _rows: number, _user?: string) => "session-new-container");
const startTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const getTerminalOutputBufferMock = mock(async (_sessionId: string) => "");
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
  getTerminalOutputBuffer: getTerminalOutputBufferMock,
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
    getTerminalOutputBufferMock.mockClear();
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
    getTerminalOutputBufferMock.mockImplementation(async () => "");
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

  it("waits for a backend-owned setup session instead of creating a blank replacement terminal", async () => {
    const { result, rerender } = renderHook(
      ({ existingSessionId }: { existingSessionId?: string }) =>
        useTerminal({
          containerId: "container-1",
          isLocal: false,
          existingSessionId,
          persistSession: true,
          attachExistingOnly: true,
          replayOutputBuffer: true,
        }),
      { initialProps: { existingSessionId: undefined as string | undefined } },
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(createTerminalSessionMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();

    getTerminalSessionMock.mockResolvedValue({ id: "env-1:setup", running: true });
    getTerminalOutputBufferMock.mockResolvedValue("[orkestrator] Starting environment setup\r\n");

    rerender({ existingSessionId: "env-1:setup" });
    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.sessionId).toBe("env-1:setup"));
    expect(createTerminalSessionMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(listenMock).toHaveBeenCalledWith("terminal-output-env-1:setup", expect.any(Function));
    expect(getTerminalOutputBufferMock).toHaveBeenCalledWith("env-1:setup");
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
    expect(createLocalTerminalSessionMock).toHaveBeenCalledWith("env-1", 80, 24, false);
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

  it("forwards environment activity tracking to local and container session creation", async () => {
    const local = renderHook(() =>
      useTerminal({
        containerId: null,
        environmentId: "env-local",
        isLocal: true,
        persistSession: true,
        trackEnvironmentActivity: true,
      }),
    );

    await act(async () => {
      await local.result.current.connect();
    });
    expect(createLocalTerminalSessionMock).toHaveBeenCalledWith("env-local", 80, 24, true);
    local.unmount();

    const container = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-container",
        isLocal: false,
        persistSession: true,
        trackEnvironmentActivity: true,
      }),
    );

    await act(async () => {
      await container.result.current.connect();
    });
    expect(createTerminalSessionMock).toHaveBeenCalledWith(
      "container-1",
      80,
      24,
      undefined,
      true,
    );
    container.unmount();
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

  it("replays the buffer before attaching the listener on an attach-only session", async () => {
    const callOrder: string[] = [];
    getTerminalSessionMock.mockResolvedValue({ id: "env-1:setup", running: true });
    getTerminalOutputBufferMock.mockImplementation(async () => {
      callOrder.push("getBuffer");
      return "replayed setup output";
    });
    listenMock.mockImplementation(async () => {
      callOrder.push("listen");
      return unlistenMock;
    });
    const received: Uint8Array[] = [];

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        existingSessionId: "env-1:setup",
        persistSession: true,
        attachExistingOnly: true,
        replayOutputBuffer: true,
        onData: (data) => received.push(data),
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.sessionId).toBe("env-1:setup"));
    // Buffer replay must happen before the live listener is attached so already
    // buffered bytes are not delivered twice.
    expect(callOrder).toEqual(["getBuffer", "listen"]);
    expect(getTerminalOutputBufferMock).toHaveBeenCalledWith("env-1:setup");
    expect(new TextDecoder().decode(received[0])).toBe("replayed setup output");
  });

  it("surfaces an error when an attach-only session is not running", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "env-1:setup", running: false });
    getTerminalOutputBufferMock.mockResolvedValue("partial setup output");

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        existingSessionId: "env-1:setup",
        persistSession: true,
        attachExistingOnly: true,
        replayOutputBuffer: true,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.error).toBe("Backend terminal session is not running"));
    expect(result.current.isConnected).toBe(false);
    // Never falls back to creating a replacement session.
    expect(createTerminalSessionMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    // The buffer is still replayed and the listener attached before the guard.
    expect(getTerminalOutputBufferMock).toHaveBeenCalledWith("env-1:setup");
    expect(listenMock).toHaveBeenCalledWith("terminal-output-env-1:setup", expect.any(Function));
  });

  it("replays the buffer for the replacement session on the reconnect fallback", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "session-old", running: true });
    getTerminalOutputBufferMock.mockResolvedValue("fallback replay output");
    createTerminalSessionMock.mockResolvedValue("session-new-container");
    let listenCalls = 0;
    listenMock.mockImplementation(async () => {
      listenCalls += 1;
      // Fail the first attach (existing session) to drop into the fallback path.
      if (listenCalls === 1) throw new Error("listen failed");
      return unlistenMock;
    });

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.sessionId).toBe("session-new-container"));
    expect(createTerminalSessionMock).toHaveBeenCalled();
    expect(startTerminalSessionMock).toHaveBeenCalledWith("session-new-container");
    expect(getTerminalOutputBufferMock).toHaveBeenCalledWith("session-new-container");
    expect(listenMock).toHaveBeenCalledWith("terminal-output-session-new-container", expect.any(Function));
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
