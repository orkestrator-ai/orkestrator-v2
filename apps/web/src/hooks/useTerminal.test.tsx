import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  listen,
  NATIVE_EVENT_STREAM_CONNECTED_EVENT,
} from "@/lib/native/events";
import * as realBackend from "@/lib/backend";
import { mockToastError as toastErrorMock } from "../../../../tests/mocks/sonner";

type TestTerminalOutputSnapshot =
  Omit<realBackend.TerminalOutputSnapshot, "truncated"> & {
    truncated?: boolean;
  };

const getTerminalSessionMock = mock(async (_sessionId: string) => ({ id: "session-old", running: true }));
const createLocalTerminalSessionMock = mock(async (_environmentId: string, _cols: number, _rows: number, _track?: boolean, _terminalKey?: string) => ({
  sessionId: "session-new-local",
  created: true,
}));
const startLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const closeLocalTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const createTerminalSessionMock = mock(async (_containerId: string, _cols: number, _rows: number, _user?: string, _track?: boolean, _environmentId?: string, _terminalKey?: string) => ({
  sessionId: "session-new-container",
  created: true,
}));
const startTerminalSessionMock = mock(async (_sessionId: string) => undefined);
const getTerminalOutputSnapshotMock = mock(async (
  _sessionId: string,
): Promise<TestTerminalOutputSnapshot> => ({
  output: "",
  revision: 0,
  generation: 1,
}));
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

const { decodeTerminalOutputPayload, useTerminal } = await import("./useTerminal");

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
    createLocalTerminalSessionMock.mockImplementation(async () => ({
      sessionId: "session-new-local",
      created: true,
    }));
    startLocalTerminalSessionMock.mockImplementation(async () => undefined);
    closeLocalTerminalSessionMock.mockImplementation(async () => undefined);
    createTerminalSessionMock.mockImplementation(async () => ({
      sessionId: "session-new-container",
      created: true,
    }));
    startTerminalSessionMock.mockImplementation(async () => undefined);
    getTerminalOutputSnapshotMock.mockImplementation(async () => ({
      output: "",
      revision: 0,
      generation: 1,
    }));
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
    expect(listenMock).toHaveBeenCalledWith(
      "terminal-output-session-old",
      expect.any(Function),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("attaches once to a backend-owned setup session while preparation is running before its PTY exists", async () => {
    const received: Uint8Array[] = [];
    let emitLiveOutput: ((event: { payload: number[] }) => void) | undefined;
    listenMock.mockImplementation(async (eventName, handler) => {
      if (eventName === "terminal-output-env-1:setup") {
        emitLiveOutput = handler;
      }
      return unlistenMock;
    });
    const outputListenerCalls = () => listenMock.mock.calls.filter(
      ([eventName]) => eventName === "terminal-output-env-1:setup",
    );
    const reconnectListenerCalls = () => listenMock.mock.calls.filter(
      ([eventName]) => eventName === NATIVE_EVENT_STREAM_CONNECTED_EVENT,
    );

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
      generation: 1,
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
    expect(outputListenerCalls()).toHaveLength(1);
    expect(reconnectListenerCalls()).toHaveLength(1);
    expect(listenMock).toHaveBeenCalledWith(
      "terminal-output-env-1:setup",
      expect.any(Function),
      expect.objectContaining({ signal: expect.anything() }),
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
    expect(outputListenerCalls()).toHaveLength(1);
    expect(reconnectListenerCalls()).toHaveLength(1);
    expect(unlistenMock).not.toHaveBeenCalled();
  });

  it("replaces a stale existing local terminal session and starts the replacement", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "session-old", running: false });
    createLocalTerminalSessionMock.mockResolvedValue({
      sessionId: "session-new-local",
      created: true,
    });

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
    expect(listenMock).toHaveBeenCalledWith(
      "terminal-output-session-new-local",
      expect.any(Function),
      expect.objectContaining({ signal: expect.anything() }),
    );
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
    expect(listenMock).toHaveBeenCalledWith(
      "terminal-output-session-new-container",
      expect.any(Function),
      expect.objectContaining({ signal: expect.anything() }),
    );
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
    let resolveCreateSession: (result: {
      sessionId: string;
      created: boolean;
    }) => void = () => {};
    createTerminalSessionMock.mockImplementation(
      async () =>
        new Promise<{ sessionId: string; created: boolean }>((resolve) => {
          resolveCreateSession = resolve;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
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
    resolveCreateSession({ sessionId: "session-after-unmount", created: true });

    await act(async () => {
      await connectPromise;
    });

    expect(listenMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    // Persistent stable sessions are backend-owned and may already have been
    // adopted by another renderer by the time this stale create resolves.
    expect(detachTerminalMock).not.toHaveBeenCalled();
  });

  it("does not release a stable session adopted while its creator start is pending", async () => {
    let rejectStartSession: (error: Error) => void = () => {};
    createTerminalSessionMock
      .mockResolvedValueOnce({ sessionId: "shared-session", created: true })
      .mockResolvedValueOnce({ sessionId: "shared-session", created: false });
    startTerminalSessionMock
      .mockImplementationOnce(
        async () =>
          new Promise<undefined>((_resolve, reject) => {
            rejectStartSession = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);

    const { result, unmount } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
        isLocal: false,
        persistSession: true,
      }),
    );

    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });

    await waitFor(() => {
      expect(listenMock).toHaveBeenCalledWith(
        "terminal-output-shared-session",
        expect.any(Function),
        expect.objectContaining({ signal: expect.anything() }),
      );
    });

    const adopter = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
        isLocal: false,
        persistSession: true,
      }),
    );
    await act(async () => {
      await adopter.result.current.connect();
    });
    expect(adopter.result.current.isConnected).toBe(true);

    act(() => {
      unmount();
    });
    rejectStartSession(new Error("backend start failed"));

    await act(async () => {
      await connectPromise;
    });

    expect(detachTerminalMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(adopter.result.current.sessionId).toBe("shared-session");
    adopter.unmount();
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
      return { output: "replayed setup output", revision: 1, generation: 1 };
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
    expect(callOrder).toEqual(["listen", "listen", "getSnapshot"]);
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledWith("env-1:setup");
    expect(new TextDecoder().decode(received[0])).toBe("replayed setup output");
  });

  it("deduplicates live output emitted while a second client fetches its snapshot", async () => {
    let liveHandler: ((event: { payload: { data: number[]; revision: number; generation: number } }) => void) | undefined;
    listenMock.mockImplementation(async (event, handler) => {
      if (event !== NATIVE_EVENT_STREAM_CONNECTED_EVENT) liveHandler = handler;
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock.mockImplementation(async () => {
      liveHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("already in snapshot")),
          revision: 1,
          generation: 1,
        },
      });
      liveHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("new live output")),
          revision: 2,
          generation: 1,
        },
      });
      return { output: "authoritative buffer", revision: 1, generation: 1 };
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

  it("deduplicates structured output delivered after the snapshot completes", async () => {
    let outputHandler:
      | ((event: { payload: { data: number[]; revision: number; generation: number } }) => void)
      | undefined;
    listenMock.mockImplementation(async (event, handler) => {
      if (event.startsWith("terminal-output-")) outputHandler = handler;
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock.mockResolvedValue({
      output: "through revision two",
      revision: 2,
      generation: 7,
    });
    const received: string[] = [];

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onData: (data) => received.push(new TextDecoder().decode(data)),
      }),
    );

    await act(async () => {
      await result.current.connect();
    });
    act(() => {
      outputHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("duplicate")),
          revision: 2,
          generation: 7,
        },
      });
      outputHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("next")),
          revision: 3,
          generation: 7,
        },
      });
    });

    expect(received).toEqual(["next"]);
  });

  it("rehydrates output missed while the native event stream was disconnected", async () => {
    let reconnectHandler: (() => void) | undefined;
    listenMock.mockImplementation(async (event, handler) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
        reconnectHandler = () => handler({ payload: undefined });
      }
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock
      .mockResolvedValueOnce({
        output: "before disconnect",
        revision: 1,
        generation: 4,
      })
      .mockResolvedValueOnce({
        output: "before disconnect\r\nmissed output",
        revision: 2,
        generation: 4,
      });
    const replayed: string[] = [];

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onReplay: (data) => replayed.push(new TextDecoder().decode(data)),
      }),
    );
    await act(async () => {
      await result.current.connect();
    });
    act(() => reconnectHandler?.());

    await waitFor(() => expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(2));
    expect(replayed).toEqual([
      "before disconnect",
      "before disconnect\r\nmissed output",
    ]);
  });

  it("replaces the view when a live event belongs to a new output generation", async () => {
    let outputHandler:
      | ((event: { payload: { data: number[]; revision: number; generation: number } }) => void)
      | undefined;
    listenMock.mockImplementation(async (event, handler) => {
      if (event.startsWith("terminal-output-")) outputHandler = handler;
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock
      .mockResolvedValueOnce({
        output: "old process output",
        revision: 8,
        generation: 1,
      })
      .mockResolvedValueOnce({
        output: "replacement process output",
        revision: 1,
        generation: 2,
      });
    const replayed: string[] = [];
    const received: string[] = [];

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onReplay: (data) => replayed.push(new TextDecoder().decode(data)),
        onData: (data) => received.push(new TextDecoder().decode(data)),
      }),
    );
    await act(async () => {
      await result.current.connect();
    });
    act(() => {
      outputHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("replacement process output")),
          revision: 1,
          generation: 2,
        },
      });
    });

    await waitFor(() => expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(2));
    expect(replayed).toEqual([
      "old process output",
      "replacement process output",
    ]);
    expect(received).toEqual([]);
  });

  it("preserves the current view on snapshot failure and retries after reconnect", async () => {
    let outputHandler: ((event: { payload: number[] }) => void) | undefined;
    let reconnectHandler: (() => void) | undefined;
    listenMock.mockImplementation(async (event, handler) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
        reconnectHandler = () => handler({ payload: undefined });
      } else {
        outputHandler = handler;
      }
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock
      .mockRejectedValueOnce(new Error("snapshot unavailable"))
      .mockResolvedValueOnce({
        output: "authoritative after retry",
        revision: 2,
        generation: 5,
      });
    const replayed: Array<{
      output: string;
      degraded?: "snapshot-error" | "truncated";
      error?: string;
    }> = [];
    const received: string[] = [];

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onReplay: (data, metadata) => replayed.push({
          output: new TextDecoder().decode(data),
          degraded: metadata.degraded,
          error: metadata.error,
        }),
        onData: (data) => received.push(new TextDecoder().decode(data)),
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(replayed).toEqual([{
      output: "",
      degraded: "snapshot-error",
      error: "snapshot unavailable",
    }]);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.error).toContain("snapshot unavailable");
    act(() => {
      outputHandler?.({
        payload: Array.from(new TextEncoder().encode("legacy live output")),
      });
    });
    expect(received).toEqual(["legacy live output"]);

    act(() => reconnectHandler?.());
    await waitFor(() => expect(replayed).toEqual([
      {
        output: "",
        degraded: "snapshot-error",
        error: "snapshot unavailable",
      },
      {
        output: "authoritative after retry",
        degraded: undefined,
        error: undefined,
      },
    ]));
    expect(result.current.error).toBeNull();
  });

  it("buffers output emitted between listener registration and the first snapshot", async () => {
    const received: string[] = [];
    listenMock.mockImplementation(async (event, handler) => {
      if (event.startsWith("terminal-output-")) {
        handler({
          payload: {
            data: Array.from(new TextEncoder().encode("already snapshotted")),
            revision: 1,
            generation: 3,
          },
        });
      }
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock.mockResolvedValue({
      output: "already snapshotted",
      revision: 1,
      generation: 3,
    });

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onData: (data) => received.push(new TextDecoder().decode(data)),
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(received).toEqual([]);
  });

  it("starts but does not claim ownership of a reused stable replacement session", async () => {
    getTerminalSessionMock.mockResolvedValue({
      id: "stable-session",
      running: false,
    });
    createTerminalSessionMock.mockResolvedValue({
      sessionId: "stable-session",
      created: false,
    });

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "stable-session",
        persistSession: true,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(startTerminalSessionMock).toHaveBeenCalledWith("stable-session");
    expect(detachTerminalMock).not.toHaveBeenCalled();
  });

  it("does not destroy a reused stable session when its connect becomes stale", async () => {
    let resolveCreateSession: (result: {
      sessionId: string;
      created: boolean;
    }) => void = () => {};
    createTerminalSessionMock.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveCreateSession = resolve;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        persistSession: false,
      }),
    );
    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    unmount();
    resolveCreateSession({ sessionId: "shared-session", created: false });
    await act(async () => {
      await connectPromise;
    });

    expect(detachTerminalMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("validates terminal targets before creating sessions", async () => {
    const local = renderHook(() =>
      useTerminal({ containerId: null, isLocal: true }),
    );
    await act(async () => {
      await local.result.current.connect();
    });
    expect(local.result.current.error).toBe(
      "No environment ID provided for local environment",
    );
    local.unmount();

    const container = renderHook(() =>
      useTerminal({ containerId: null, isLocal: false }),
    );
    await act(async () => {
      await container.result.current.connect();
    });
    expect(container.result.current.error).toBe("No container ID provided");
    expect(createLocalTerminalSessionMock).not.toHaveBeenCalled();
    expect(createTerminalSessionMock).not.toHaveBeenCalled();
  });

  it("cleans up a newly created session when startup fails", async () => {
    startTerminalSessionMock.mockRejectedValue(new Error("start failed"));
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        persistSession: false,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(detachTerminalMock).toHaveBeenCalledWith("session-new-container");
    expect(result.current.sessionId).toBeNull();
    expect(result.current.error).toBe("start failed");
  });

  it("cleans up a newly created session when listener registration fails", async () => {
    listenMock.mockRejectedValue(new Error("listener failed"));
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        persistSession: false,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(detachTerminalMock).toHaveBeenCalledWith("session-new-container");
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(result.current.error).toBe("listener failed");
  });

  it("surfaces create failures without trying to clean up an unknown session", async () => {
    createTerminalSessionMock.mockRejectedValue(new Error("create failed"));
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        persistSession: true,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(detachTerminalMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(result.current.error).toBe("create failed");
  });

  it("coalesces reconnect notifications while a reconciliation is in flight", async () => {
    let reconnectHandler: (() => void) | undefined;
    let resolveSecondSnapshot: (
      snapshot: { output: string; revision: number; generation: number },
    ) => void = () => {};
    listenMock.mockImplementation(async (event, handler) => {
      if (event === NATIVE_EVENT_STREAM_CONNECTED_EVENT) {
        reconnectHandler = () => handler({ payload: undefined });
      }
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock
      .mockResolvedValueOnce({ output: "initial", revision: 1, generation: 1 })
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            resolveSecondSnapshot = resolve;
          }),
      )
      .mockResolvedValueOnce({ output: "latest", revision: 3, generation: 1 });

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      reconnectHandler?.();
      await Promise.resolve();
    });
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(2);
    act(() => {
      reconnectHandler?.();
      reconnectHandler?.();
    });

    resolveSecondSnapshot({ output: "middle", revision: 2, generation: 1 });
    await waitFor(() => expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(3));
  });

  it("surfaces an error when an attach-only session is not running", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "env-1:setup", running: false });
    getTerminalOutputSnapshotMock.mockResolvedValue({
      output: "partial setup output",
      revision: 1,
      generation: 1,
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
    expect(listenMock).toHaveBeenCalledWith(
      "terminal-output-env-1:setup",
      expect.any(Function),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("replays and deduplicates output for the replacement session on the reconnect fallback", async () => {
    getTerminalSessionMock.mockResolvedValue({ id: "session-old", running: true });
    let replacementOutputHandler:
      | ((event: { payload: { data: number[]; revision: number; generation: number } }) => void)
      | undefined;
    getTerminalOutputSnapshotMock.mockImplementation(async () => {
      replacementOutputHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("already replayed")),
          revision: 1,
          generation: 1,
        },
      });
      replacementOutputHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("after snapshot")),
          revision: 2,
          generation: 1,
        },
      });
      return {
        output: "fallback replay output",
        revision: 1,
        generation: 1,
      };
    });
    createTerminalSessionMock.mockResolvedValue({
      sessionId: "session-new-container",
      created: true,
    });
    let listenCalls = 0;
    listenMock.mockImplementation(async (event, handler) => {
      listenCalls += 1;
      // Fail the first attach (existing session) to drop into the fallback path.
      if (listenCalls === 1) throw new Error("listen failed");
      if (event.startsWith("terminal-output-")) {
        replacementOutputHandler = handler;
      }
      return unlistenMock;
    });
    const replayed: Array<{
      output: string;
      preserveExisting: boolean;
    }> = [];
    const received: string[] = [];

    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        isLocal: false,
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onReplay: (data, metadata) => replayed.push({
          output: new TextDecoder().decode(data),
          preserveExisting: metadata.preserveExisting,
        }),
        onData: (data) => received.push(new TextDecoder().decode(data)),
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    await waitFor(() => expect(result.current.sessionId).toBe("session-new-container"));
    expect(createTerminalSessionMock).toHaveBeenCalled();
    expect(startTerminalSessionMock).toHaveBeenCalledWith("session-new-container");
    expect(getTerminalOutputSnapshotMock).toHaveBeenCalledWith("session-new-container");
    expect(listenMock).toHaveBeenCalledWith(
      "terminal-output-session-new-container",
      expect.any(Function),
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(replayed).toEqual([{
      output: "fallback replay output",
      preserveExisting: true,
    }]);
    expect(received).toEqual(["after snapshot"]);
  });

  it("lets a stale snapshot dispose only its own listeners after a successor connects", async () => {
    let resolveOldSnapshot: (snapshot: {
      output: string;
      revision: number;
      generation: number;
    }) => void = () => {};
    const oldOutputUnlisten = mock(() => undefined);
    const oldReconnectUnlisten = mock(() => undefined);
    const newOutputUnlisten = mock(() => undefined);
    const newReconnectUnlisten = mock(() => undefined);
    const newOutput: Array<(event: {
      payload: { data: number[]; revision: number; generation: number };
    }) => void> = [];
    let listenIndex = 0;
    listenMock.mockImplementation(async (event, handler) => {
      const current = listenIndex++;
      if (current === 2 && event.startsWith("terminal-output-")) {
        newOutput.push(handler);
      }
      return [
        oldOutputUnlisten,
        oldReconnectUnlisten,
        newOutputUnlisten,
        newReconnectUnlisten,
      ][current] ?? unlistenMock;
    });
    getTerminalOutputSnapshotMock.mockImplementation(async (sessionId: string) => {
      if (sessionId === "session-old") {
        return new Promise((resolve) => {
          resolveOldSnapshot = resolve;
        });
      }
      return {
        output: "new snapshot",
        revision: 1,
        generation: 2,
      };
    });
    const received: string[] = [];
    const { result, rerender } = renderHook(
      ({ existingSessionId }) =>
        useTerminal({
          containerId: "container-1",
          existingSessionId,
          persistSession: true,
          replayOutputBuffer: true,
          onData: (data) => received.push(new TextDecoder().decode(data)),
        }),
      { initialProps: { existingSessionId: "session-old" } },
    );

    let oldConnect!: Promise<void>;
    act(() => {
      oldConnect = result.current.connect();
    });
    await waitFor(() =>
      expect(getTerminalOutputSnapshotMock).toHaveBeenCalledWith("session-old")
    );

    rerender({ existingSessionId: "session-new" });
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.sessionId).toBe("session-new");
    expect(oldOutputUnlisten).toHaveBeenCalledTimes(1);
    expect(oldReconnectUnlisten).toHaveBeenCalledTimes(1);

    resolveOldSnapshot({ output: "old snapshot", revision: 1, generation: 1 });
    await act(async () => {
      await oldConnect;
    });

    expect(newOutputUnlisten).not.toHaveBeenCalled();
    expect(newReconnectUnlisten).not.toHaveBeenCalled();
    act(() => {
      newOutput[0]?.({
        payload: {
          data: Array.from(new TextEncoder().encode("still live")),
          revision: 2,
          generation: 2,
        },
      });
    });
    expect(received).toEqual(["still live"]);
  });

  it("invalidates a pending local create when the environment identity changes", async () => {
    let resolveOldCreate: (result: {
      sessionId: string;
      created: boolean;
    }) => void = () => {};
    createLocalTerminalSessionMock.mockImplementation(async (environmentId: string) => {
      if (environmentId === "env-old") {
        return new Promise((resolve) => {
          resolveOldCreate = resolve;
        });
      }
      return { sessionId: "session-new-env", created: true };
    });
    const { result, rerender } = renderHook(
      ({ environmentId }) =>
        useTerminal({
          containerId: null,
          environmentId,
          isLocal: true,
          terminalKey: "tab-1",
          persistSession: true,
        }),
      { initialProps: { environmentId: "env-old" } },
    );

    let oldConnect!: Promise<void>;
    act(() => {
      oldConnect = result.current.connect();
    });
    await waitFor(() =>
      expect(createLocalTerminalSessionMock).toHaveBeenCalledWith(
        "env-old",
        80,
        24,
        false,
        "tab-1",
      )
    );

    rerender({ environmentId: "env-new" });
    await act(async () => {
      await result.current.connect();
    });
    resolveOldCreate({ sessionId: "session-old-env", created: true });
    await act(async () => {
      await oldConnect;
    });

    expect(result.current.sessionId).toBe("session-new-env");
    expect(startLocalTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(startLocalTerminalSessionMock).toHaveBeenCalledWith("session-new-env");
    expect(closeLocalTerminalSessionMock).not.toHaveBeenCalledWith("session-old-env");
    expect(listenMock).not.toHaveBeenCalledWith(
      "terminal-output-session-old-env",
      expect.any(Function),
    );
  });

  it("keeps the connection when its published session feeds back as existingSessionId", async () => {
    const listenerUnlisten = mock(() => undefined);
    listenMock.mockResolvedValue(listenerUnlisten);
    const { result, rerender } = renderHook(
      ({ existingSessionId }: { existingSessionId?: string }) =>
        useTerminal({
          containerId: "container-1",
          environmentId: "env-1",
          terminalKey: "tab-1",
          existingSessionId,
          persistSession: true,
        }),
      {
        initialProps: {
          existingSessionId: undefined as string | undefined,
        },
      },
    );
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.sessionId).toBe("session-new-container");

    rerender({ existingSessionId: "session-new-container" });

    expect(result.current.sessionId).toBe("session-new-container");
    expect(result.current.isConnected).toBe(true);
    expect(listenerUnlisten).not.toHaveBeenCalled();
    expect(detachTerminalMock).not.toHaveBeenCalled();
  });

  it("cancels listener and snapshot work immediately when disconnected mid-connect", async () => {
    let resolveSnapshot: (snapshot: {
      output: string;
      revision: number;
      generation: number;
    }) => void = () => {};
    const outputUnlisten = mock(() => undefined);
    const reconnectUnlisten = mock(() => undefined);
    listenMock
      .mockResolvedValueOnce(outputUnlisten)
      .mockResolvedValueOnce(reconnectUnlisten);
    getTerminalOutputSnapshotMock.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
        persistSession: true,
        replayOutputBuffer: true,
      }),
    );

    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    await waitFor(() =>
      expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(1)
    );
    await act(async () => {
      await result.current.disconnect();
    });

    expect(outputUnlisten).toHaveBeenCalledTimes(1);
    expect(reconnectUnlisten).toHaveBeenCalledTimes(1);
    expect(detachTerminalMock).toHaveBeenCalledWith("session-new-container");
    expect(result.current.sessionId).toBeNull();

    resolveSnapshot({ output: "stale", revision: 1, generation: 1 });
    await act(async () => {
      await connectPromise;
    });
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(result.current.isConnected).toBe(false);
  });

  it("cancels the output listener while lifecycle listener registration is pending", async () => {
    let resolveLifecycleListen: (unlisten: () => void) => void = () => {};
    const outputUnlisten = mock(() => undefined);
    const reconnectUnlisten = mock(() => undefined);
    listenMock
      .mockResolvedValueOnce(outputUnlisten)
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            resolveLifecycleListen = resolve;
          }),
      );
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
        persistSession: true,
        replayOutputBuffer: true,
      }),
    );

    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    await waitFor(() => expect(listenMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await result.current.disconnect();
    });
    expect(outputUnlisten).toHaveBeenCalledTimes(1);

    resolveLifecycleListen(reconnectUnlisten);
    await act(async () => {
      await connectPromise;
    });

    expect(reconnectUnlisten).toHaveBeenCalledTimes(1);
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBeNull();
  });

  it("invalidates a create that has not published a session when disconnected", async () => {
    let resolveCreate: (result: {
      sessionId: string;
      created: boolean;
    }) => void = () => {};
    createTerminalSessionMock.mockImplementation(
      async () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
        persistSession: true,
      }),
    );

    let connectPromise!: Promise<void>;
    act(() => {
      connectPromise = result.current.connect();
    });
    await act(async () => {
      await result.current.disconnect();
    });
    resolveCreate({ sessionId: "adoptable-session", created: true });
    await act(async () => {
      await connectPromise;
    });

    expect(listenMock).not.toHaveBeenCalled();
    expect(startTerminalSessionMock).not.toHaveBeenCalled();
    expect(detachTerminalMock).not.toHaveBeenCalled();
    expect(result.current.isConnecting).toBe(false);
  });

  it("cleans up the output listener when lifecycle listener registration fails", async () => {
    const outputUnlisten = mock(() => undefined);
    listenMock
      .mockResolvedValueOnce(outputUnlisten)
      .mockRejectedValueOnce(new Error("lifecycle listener failed"));
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        persistSession: false,
        replayOutputBuffer: true,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(outputUnlisten).toHaveBeenCalledTimes(1);
    expect(detachTerminalMock).toHaveBeenCalledWith("session-new-container");
    expect(result.current.error).toBe("lifecycle listener failed");
  });

  it("removes the reconnect listener even when the output disposer throws", async () => {
    const outputUnlisten = mock(() => {
      throw new Error("output disposer failed");
    });
    const reconnectUnlisten = mock(() => undefined);
    listenMock
      .mockResolvedValueOnce(outputUnlisten)
      .mockResolvedValueOnce(reconnectUnlisten);
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
        persistSession: true,
        replayOutputBuffer: true,
      }),
    );
    await act(async () => {
      await result.current.connect();
      await result.current.disconnect();
    });

    expect(outputUnlisten).toHaveBeenCalledTimes(1);
    expect(reconnectUnlisten).toHaveBeenCalledTimes(1);
    expect(result.current.sessionId).toBeNull();
  });

  it("does not create a replacement when attach-only listener registration fails", async () => {
    listenMock.mockRejectedValueOnce(new Error("attach unavailable"));
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "setup-session",
        attachExistingOnly: true,
        persistSession: true,
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(createTerminalSessionMock).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBeNull();
    expect(result.current.error).toBe("attach unavailable");
    expect(toastErrorMock).toHaveBeenCalled();
  });

  it("cleans the partial existing attachment when replacement attachment also fails", async () => {
    const existingOutputUnlisten = mock(() => undefined);
    listenMock
      .mockResolvedValueOnce(existingOutputUnlisten)
      .mockRejectedValueOnce(new Error("existing lifecycle failed"))
      .mockRejectedValueOnce(new Error("replacement output failed"));
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        environmentId: "env-1",
        terminalKey: "tab-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(existingOutputUnlisten).toHaveBeenCalledTimes(1);
    expect(createTerminalSessionMock).toHaveBeenCalledTimes(1);
    expect(result.current.sessionId).toBeNull();
    expect(result.current.error).toContain("replacement output failed");
  });

  it("performs a bounded follow-up reconciliation for a buffered revision gap", async () => {
    let outputHandler:
      | ((event: {
          payload: { data: number[]; revision: number; generation: number };
        }) => void)
      | undefined;
    listenMock.mockImplementation(async (event, handler) => {
      if (event.startsWith("terminal-output-")) outputHandler = handler;
      return unlistenMock;
    });
    getTerminalOutputSnapshotMock
      .mockResolvedValueOnce({ output: "one", revision: 1, generation: 1 })
      .mockResolvedValueOnce({ output: "still one", revision: 1, generation: 1 })
      .mockResolvedValueOnce({ output: "one-two", revision: 2, generation: 1 });
    const received: string[] = [];
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onData: (data) => received.push(new TextDecoder().decode(data)),
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    act(() => {
      outputHandler?.({
        payload: {
          data: Array.from(new TextEncoder().encode("three")),
          revision: 3,
          generation: 1,
        },
      });
    });

    await waitFor(() =>
      expect(getTerminalOutputSnapshotMock).toHaveBeenCalledTimes(3)
    );
    expect(received).toEqual(["three"]);
  });

  it("marks a truncated snapshot as degraded replay", async () => {
    getTerminalOutputSnapshotMock.mockResolvedValue({
      output: "bounded tail",
      revision: 9,
      generation: 2,
      truncated: true,
    });
    const replayed: Array<{
      output: string;
      degraded?: "snapshot-error" | "truncated";
    }> = [];
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        existingSessionId: "session-old",
        persistSession: true,
        replayOutputBuffer: true,
        onReplay: (data, metadata) => replayed.push({
          output: new TextDecoder().decode(data),
          degraded: metadata.degraded,
        }),
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    expect(replayed).toEqual([{
      output: "bounded tail",
      degraded: "truncated",
    }]);
  });

  it("contains resize and write failures without dropping the active session", async () => {
    resizeTerminalMock.mockRejectedValueOnce(new Error("resize failed"));
    writeTerminalMock.mockRejectedValueOnce(new Error("write failed"));
    const { result } = renderHook(() =>
      useTerminal({
        containerId: "container-1",
        persistSession: true,
      }),
    );
    await act(async () => {
      await result.current.connect();
      await result.current.resize(120, 40);
      await result.current.write("input");
    });

    expect(result.current.sessionId).toBe("session-new-container");
    expect(result.current.isConnected).toBe(true);
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

describe("decodeTerminalOutputPayload", () => {
  it("supports base64, legacy byte arrays, and desync notices", () => {
    expect(new TextDecoder().decode(decodeTerminalOutputPayload(btoa("base64"))!)).toBe("base64");
    expect([...decodeTerminalOutputPayload([0, 127, 255])!]).toEqual([0, 127, 255]);
    expect([...decodeTerminalOutputPayload({ bytes: [1, 2, 3] })!]).toEqual([1, 2, 3]);
    expect(decodeTerminalOutputPayload({ desynced: true })).toBeNull();
  });
});
