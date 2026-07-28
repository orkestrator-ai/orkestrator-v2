import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { listen } from "@/lib/native/events";
import * as realBackend from "@/lib/backend";
import { mockToastError as toastErrorMock } from "../../../../tests/mocks/sonner";

const getTerminalSessionMock = mock(async (_sessionId: string) => ({ id: "session-old", running: true }));
const createLocalTerminalSessionMock = mock(async (_environmentId: string, _cols: number, _rows: number, _track?: boolean, _terminalKey?: string) => "session-new-local");
const startLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const closeLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const createTerminalSessionMock = mock(async (_containerId: string, _cols: number, _rows: number, _user?: string, _track?: boolean, _environmentId?: string, _terminalKey?: string) => "session-new-container");
const startTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const getTerminalOutputSnapshotMock = mock(async (_sessionId: string) => ({ output: "", revision: 0 }));
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
  getTerminalOutputSnapshot: getTerminalOutputSnapshotMock,
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
    getTerminalOutputSnapshotMock.mockClear();
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
    getTerminalOutputSnapshotMock.mockImplementation(async () => ({ output: "", revision: 0 }));
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

  it("attaches once to a backend-owned setup session while preparation is running before its PTY exists", async () => {
    const received: Uint8Array[] = [];
    let emitLiveOutput: ((event: { payload: number[] }) => void) | undefined;
    listenMock.mockImplementation(async (_eventName, handler) => {
      emitLiveOutput = handler;
      return unlistenMock;
    });

    const { result, rerender } = renderHook(
      ({ existingSessionId }: { existingSessionId?: string }) =>
        useTerminal({
          containerId: "container-1",
          environmentId: "env-1",
          isLocal: false,
          existingSessionId,
          persistSession: true,
          attachExistingOnly: true,
          replayOutputBuffer: true,
          onData: (data) => received.push(data),
          onReplay: (data) => received.push(data),
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
    getTerminalOutputSnapshotMock.mockResolvedValue({
      output: "[orkestrator] Starting environment setup\r\n",
      revision: 1,
    });

    rerender({ existingSessionId: "env-1:setup" });
    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => {
      expect(result.current.sessionId).toBe("env-1:setup");
      expect(result.current.isConnected).toBe(true);
    });
    expect(createTerminalSessionMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(getTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(1);
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledWith("env-1:setup");
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledWith(
      "terminal-output-env-1:setup",
      expect.any(Function),
    );
    expect(new TextDecoder().decode(received[0])).toBe(
      "[orkestrator] Starting environment setup\r\n",
    );

    act(() => {
      emitLiveOutput?.({
        payload: Array.from(new TextEncoder().encode("Cloning repository...\r\n")),
      });
    });
    expect(new TextDecoder().decode(received[1])).toBe("Cloning repository...\r\n");

    // PersistentTerminal may rerender and re-run its connection effect while
    // preparation advances. A logically running pre-PTY setup session must
    // remain connected rather than replaying its buffer and subscribing again.
    rerender({ existingSessionId: "env-1:setup" });
    await act(async () => {
      await result.current.connect();
      await result.current.connect();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.error).toBeNull();
    expect(getTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(1);
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(unlistenMock).not.toHaveBeenCalled();
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
    expect(createLocalTerminalSessionMock).toHaveBeenCalledWith("env-1", 80, 24, false, undefined);
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
    expect(createLocalTerminalSessionMock).toHaveBeenCalledWith("env-local", 80, 24, true, undefined);
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
      "env-container",
      undefined,
    );
    container.unmount();
  });

  it("preserves environment activity tracking when replacing stale local and container sessions", async () => {
    getTerminalSessionMock.mockImplementation(async (sessionId: string) => ({
      id: sessionId,
      running: false,
    }));

    const local = renderHook(() =>
      useTerminal({
        containerId: null,
        environmentId: "env-local",
        isLocal: true,
        existingSessionId: "session-stale-local",
        persistSession: true,
        trackEnvironmentActivity: true,
      }),
    );

    await act(async () => {
      await local.result.current.connect();
    });
    expect(getTerminalSessionMock).toHaveBeenCalledWith("session-stale-local");
    expect(createLocalTerminalSessionMock).toHaveBeenCalledWith("env-local", 80, 24, true, undefined);
    local.unmount();

    const container = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-container",
        isLocal: false,
        existingSessionId: "session-stale-container",
        persistSession: true,
        trackEnvironmentActivity: true,
      }),
    );

    await act(async () => {
      await container.result.current.connect();
    });
    expect(getTerminalSessionMock).toHaveBeenCalledWith("session-stale-container");
    expect(createTerminalSessionMock).toHaveBeenCalledWith(
      "container-1",
      80,
      24,
      undefined,
      true,
      "env-container",
      undefined,
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

  it("attaches the listener before replaying an authoritative snapshot", async () => {
    const callOrder: string[] = [];
    getTerminalSessionMock.mockResolvedValue({ id: "env-1:setup", running: true });
    getTerminalOutputSnapshotMock.mockImplementation(async () => {
      callOrder.push("getSnapshot");
      return { output: "replayed setup output", revision: 1 };
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
        onReplay: (data) => received.push(data),
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.sessionId).toBe("env-1:setup"));
    expect(callOrder).toEqual(["listen", "getSnapshot"]);
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledWith("env-1:setup");
    expect(new TextDecoder().decode(received[0])).toBe("replayed setup output");
  });

  it("deduplicates live output emitted while a second client fetches its snapshot", async () => {
    let liveHandler: ((event: { payload: { data: number[]; revision: number } }) => void) | undefined;
    listenMock.mockImplementation(async (_event, handler) => {
      liveHandler = handler;
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock.mockImplementation(async () => {
      liveHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("already in snapshot")),
          revision: 1,
        },
      });
      liveHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("new live output")),
          revision: 2,
        },
      });
      return { output: "authoritative buffer", revision: 1 };
    });
    const replayed: string[] = [];
    const received: string[] = [];

    const { result } = renderHook(() =>
      useTerminal({
        containerId: null,
        environmentId: "env-1",
        isLocal: true,
        terminalKey: "plain-tab",
        persistSession: true,
        replayOutputBuffer: true,
        onReplay: (data) => replayed.push(new TextDecoder().decode(data)),
        onData: (data) => received.push(new TextDecoder().decode(data)),
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(createLocalTerminalSessionMock).toHaveBeenCalledWith(
      "env-1",
      80,
      24,
      false,
      "plain-tab",
    );
    expect(replayed).toEqual(["authoritative buffer"]);
    expect(received).toEqual(["new live output"]);
  });

  it("surfaces an error when an attach-only session is not running", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "env-1:setup", running: false });
    getTerminalOutputSnapshotMock.mockResolvedValue({
      output: "partial setup output",
      revision: 1,
    });

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
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledWith("env-1:setup");
    expect(listenMock).toHaveBeenCalledWith("terminal-output-env-1:setup", expect.any(Function));
  });

  it("replays the buffer for the replacement session on the reconnect fallback", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "session-old", running: true });
    getTerminalOutputSnapshotMock.mockResolvedValue({
      output: "fallback replay output",
      revision: 1,
    });
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
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledWith("session-new-container");
    expect(listenMock).toHaveBeenCalledWith("terminal-output-session-new-container", expect.any(Function));
  });

  it("does not terminate a backend-owned persistent session when renderer props change", async () => {
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

    await waitFor(() => expect(unlistenMock).toHaveBeenCalledTimes(1));
    expect(detachTerminalMock).not.toHaveBeenCalled();
    expect(unlistenMock).toHaveBeenCalledTimes(1);
    expect(result.current.sessionId).toBeNull();
  });
});
