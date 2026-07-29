import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { create } from "zustand";
import {
  useNativeMessageQueue,
  type QueueDispatchOutcome,
} from "./useNativeMessageQueue";

type Queued = { id: string; text: string };

interface TestStore {
  draftText: Map<string, string>;
  attachments: Map<string, unknown[]>;
  sessions: Map<string, { isLoading: boolean }>;
  messageQueue: Map<string, Queued[]>;
  removeFromQueue: (sessionKey: string) => Queued | undefined;
  requeueToFront: (sessionKey: string, message: Queued) => void;
}

const SESSION_KEY = "env-env-1:tab-1";

function createStore(queue: Queued[], isLoading = false) {
  return create<TestStore>()((set, get) => ({
    draftText: new Map(),
    attachments: new Map(),
    sessions: new Map([[SESSION_KEY, { isLoading }]]),
    messageQueue: new Map([[SESSION_KEY, queue]]),
    removeFromQueue: (sessionKey) => {
      const current = get().messageQueue.get(sessionKey) ?? [];
      if (current.length === 0) return undefined;
      const [first, ...rest] = current;
      set({ messageQueue: new Map([[sessionKey, rest]]) });
      return first;
    },
    requeueToFront: (sessionKey, message) => {
      const current = get().messageQueue.get(sessionKey) ?? [];
      set({ messageQueue: new Map([[sessionKey, [message, ...current]]]) });
    },
  }));
}

/** Drives the hook and re-renders it whenever the store changes. */
function Harness({
  store,
  send,
  onError = () => {},
  canDrain = true,
  blockedByDraft = false,
  claimHead,
  acknowledgeClaim = async () => {},
  rejectClaim,
}: {
  store: ReturnType<typeof createStore>;
  send: (entry: Queued) => Promise<QueueDispatchOutcome | void> | undefined;
  onError?: (error: unknown, entry: Queued) => void;
  canDrain?: boolean;
  blockedByDraft?: boolean;
  claimHead?: () => Promise<{ entry: Queued; claimToken: string } | null>;
  acknowledgeClaim?: (claimToken: string) => Promise<void>;
  rejectClaim?: (claimToken: string) => Promise<void>;
}) {
  const claimedEntriesRef = useRef(new Map<string, Queued>());
  const queueLength = store((s) => s.messageQueue.get(SESSION_KEY)?.length ?? 0);
  const queueHeadId = store((s) => s.messageQueue.get(SESSION_KEY)?.[0]?.id);
  const isLoading = store((s) => s.sessions.get(SESSION_KEY)?.isLoading ?? false);

  useNativeMessageQueue<Queued>({
    agentLabel: "Test",
    sessionKey: SESSION_KEY,
    store,
    canDrain,
    queueLength,
    queueHeadId,
    isLoading,
    blockedByDraft,
    // The production claim goes through the backend queue mirror; the test
    // double claims from the local store the same way a granted claim resolves.
    claimHead:
      claimHead
      ?? (async () => {
        const entry = store.getState().removeFromQueue(SESSION_KEY);
        if (!entry) return null;
        const claimToken = `claim-${entry.id}`;
        claimedEntriesRef.current.set(claimToken, entry);
        return { entry, claimToken };
      }),
    acknowledgeClaim,
    rejectClaim: rejectClaim ?? (async (claimToken) => {
      const entry = claimedEntriesRef.current.get(claimToken);
      if (!entry) return;
      claimedEntriesRef.current.delete(claimToken);
      store.getState().requeueToFront(SESSION_KEY, entry);
    }),
    send,
    onError,
  });
  return null;
}

afterEach(() => cleanup());

describe("useNativeMessageQueue", () => {
  test("puts the entry back when the sender is not ready yet", async () => {
    /**
     * `removeFromQueue` runs before `send` is consulted, so a sender that is not
     * ready would otherwise drop the user's prompt with no error and no
     * transcript record. All three tabs pass `handleSendRef.current?.(...)`,
     * which is genuinely undefined until the ref populates.
     */
    const store = createStore([{ id: "q-1", text: "first" }]);
    const send = mock(() => undefined);

    render(<Harness store={store} send={send} />);

    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([
      { id: "q-1", text: "first" },
    ]);
  });

  test("acknowledges an accepted dispatch with its durable claim token", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    const acknowledgeClaim = mock(async () => {});

    render(
      <Harness
        store={store}
        send={async (): Promise<QueueDispatchOutcome> => "accepted"}
        acknowledgeClaim={acknowledgeClaim}
      />,
    );

    await waitFor(() =>
      expect(acknowledgeClaim).toHaveBeenCalledWith("claim-q-1"),
    );
    expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([]);
  });

  test("retains an ambiguous dispatch claim instead of risking loss or duplication", async () => {
    const store = createStore([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
    ]);
    const acknowledgeClaim = mock(async () => {});
    const rejectClaim = mock(async () => {});
    const send = mock(async () => "unknown" as const);

    render(
      <Harness
        store={store}
        send={send}
        acknowledgeClaim={acknowledgeClaim}
        rejectClaim={rejectClaim}
      />,
    );

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acknowledgeClaim).not.toHaveBeenCalled();
    expect(rejectClaim).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([
      { id: "q-2", text: "second" },
    ]);
  });

  test("retries a failed reject and reports that the prompt is awaiting recovery", async () => {
    const entry = { id: "q-1", text: "first" };
    const store = createStore([entry]);
    const onError = mock(() => {});
    let attempts = 0;
    const rejectClaim = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("backend unavailable");
      store.getState().requeueToFront(SESSION_KEY, entry);
    });

    render(
      <Harness
        store={store}
        send={() => undefined}
        rejectClaim={rejectClaim}
        onError={onError}
      />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String((onError.mock.calls[0] as unknown[])[0])).toContain(
      "could not yet be restored to the queue",
    );
    await waitFor(
      () => {
        expect(rejectClaim).toHaveBeenCalledTimes(2);
        expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([entry]);
      },
      { timeout: 1_000 },
    );
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("retries a failed acknowledgement without dispatching the prompt twice", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    const onError = mock(() => {});
    const send = mock(async () => "accepted" as const);
    let attempts = 0;
    const acknowledgeClaim = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("backend unavailable");
    });

    render(
      <Harness
        store={store}
        send={send}
        acknowledgeClaim={acknowledgeClaim}
        onError={onError}
      />,
    );

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(String((onError.mock.calls[0] as unknown[])[0])).toContain(
      "queue claim could not be acknowledged",
    );
    await waitFor(
      () => expect(acknowledgeClaim).toHaveBeenCalledTimes(2),
      { timeout: 1_000 },
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("drains queued prompts one at a time and in order", async () => {
    const store = createStore([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
    ]);
    const sent: string[] = [];
    const send = mock(async (entry: Queued) => {
      sent.push(entry.text);
    });

    render(<Harness store={store} send={send} />);

    await waitFor(() => expect(sent).toEqual(["first", "second"]));
    expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([]);
  });

  test("re-drives itself when the turn settles during an in-flight send", async () => {
    /**
     * The driving effect can fire *while* a send is in flight, where the
     * re-entrancy guard turns it into a no-op. If the turn also settles in that
     * same pass there is no later dependency change to retry on, so the rest of
     * the queue would strand — the bug Claude's timer-based version had.
     */
    const store = createStore(
      [{ id: "q-1", text: "first" }, { id: "q-2", text: "second" }],
    );
    const sent: string[] = [];
    const send = mock(async (entry: Queued) => {
      sent.push(entry.text);
      // Settle the turn mid-send, mimicking an SSE idle frame.
      store.setState({ sessions: new Map([[SESSION_KEY, { isLoading: false }]]) });
    });

    render(<Harness store={store} send={send} />);

    await waitFor(() => expect(sent).toEqual(["first", "second"]));
  });

  test("waits for a running turn before draining", async () => {
    const store = createStore([{ id: "q-1", text: "first" }], true);
    const send = mock(async () => {});

    render(<Harness store={store} send={send} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();

    store.setState({ sessions: new Map([[SESSION_KEY, { isLoading: false }]]) });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  test("reports a rejected send and restores it ahead of later work", async () => {
    const store = createStore([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
    ]);
    const onError = mock(() => {});
    const send = mock(async (entry: Queued) => {
      if (entry.id === "q-1") throw new Error("send failed");
    });

    render(<Harness store={store} send={send} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    // A definitive failure nacks the durable claim. It must not skip ahead and
    // send later prompts out of order.
    await waitFor(() =>
      expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([
        { id: "q-1", text: "first" },
        { id: "q-2", text: "second" },
      ]),
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("does not drain while the composer holds a draft", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    store.setState({ draftText: new Map([[SESSION_KEY, "half typed"]]) });
    const send = mock(async () => {});

    render(<Harness store={store} send={send} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
  });

  test("does not drain while dispatch is unavailable", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    const send = mock(async () => {});
    const view = render(
      <Harness store={store} send={send} canDrain={false} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
    expect(store.getState().messageQueue.get(SESSION_KEY)).toHaveLength(1);

    view.rerender(<Harness store={store} send={send} canDrain />);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  test("does not drain while the composer holds only attachments", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    store.setState({ attachments: new Map([[SESSION_KEY, [{ id: "a-1" }]]]) });
    const send = mock(async () => {});

    render(<Harness store={store} send={send} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
  });

  test("drains after blockedByDraft changes from true to false", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    const send = mock(async () => {});
    const view = render(
      <Harness store={store} send={send} blockedByDraft />,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();

    view.rerender(
      <Harness store={store} send={send} blockedByDraft={false} />,
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  test("does not remove queued work when the session is missing", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    store.setState({ sessions: new Map() });
    const send = mock(async () => {});

    render(<Harness store={store} send={send} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
    expect(store.getState().messageQueue.get(SESSION_KEY)).toHaveLength(1);
  });

  test("does nothing for an empty queue", async () => {
    const store = createStore([]);
    const send = mock(async () => {});

    render(<Harness store={store} send={send} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(send).not.toHaveBeenCalled();
    expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([]);
  });

  test("treats a synchronous send throw like a rejection and restores the head", async () => {
    /**
     * `send`'s contract allows a non-async implementation. A synchronous throw
     * escaping `process()` would leave the re-entrancy flag stuck at true,
     * silently killing the drain for the rest of the mount.
     */
    const store = createStore([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
    ]);
    const onError = mock(() => {});
    const send = mock((entry: Queued): Promise<void> | undefined => {
      if (entry.id === "q-1") throw new Error("sync boom");
      return Promise.resolve();
    });

    render(<Harness store={store} send={send} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect((onError.mock.calls[0] as unknown[])[1]).toEqual({ id: "q-1", text: "first" });
    await waitFor(() => expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
    ]));
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("retries after a failed claim without losing queued work", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    const send = mock(async () => {});
    let claimAttempts = 0;
    const claimHead = mock(async () => {
      claimAttempts += 1;
      if (claimAttempts === 1) throw new Error("backend unreachable");
      const entry = store.getState().removeFromQueue(SESSION_KEY);
      return entry ? { entry, claimToken: `claim-${entry.id}` } : null;
    });

    const view = render(<Harness store={store} send={send} claimHead={claimHead} />);

    await waitFor(() => expect(claimHead).toHaveBeenCalledTimes(1));
    // Nothing was dequeued by the failed claim.
    expect(store.getState().messageQueue.get(SESSION_KEY)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();

    // The next drive (here: a dependency change) retries the claim.
    view.rerender(<Harness store={store} send={send} claimHead={claimHead} blockedByDraft />);
    view.rerender(
      <Harness store={store} send={send} claimHead={claimHead} blockedByDraft={false} />,
    );
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  test("does not spin when the backend denies the claim", async () => {
    /**
     * The local mirror can show entries whose head another client has claimed.
     * A null claim must not re-drive the drain — that would hot-loop against a
     * queue this client does not own.
     */
    const store = createStore([{ id: "q-1", text: "first" }]);
    const send = mock(async () => {});
    const claimHead = mock(async () => null);

    render(<Harness store={store} send={send} claimHead={claimHead} />);

    await waitFor(() => expect(claimHead).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claimHead).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  test("retries a denied stale claim when the authoritative head changed", async () => {
    const store = createStore([{ id: "stale", text: "stale" }]);
    const send = mock(async () => {});
    let attempts = 0;
    const claimHead = mock(async () => {
      attempts += 1;
      if (attempts === 1) {
        store.setState({
          messageQueue: new Map([
            [SESSION_KEY, [{ id: "current", text: "current" }]],
          ]),
        });
        return null;
      }
      const entry = store.getState().removeFromQueue(SESSION_KEY);
      return entry ? { entry, claimToken: `claim-${entry.id}` } : null;
    });

    render(<Harness store={store} send={send} claimHead={claimHead} />);

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith({ id: "current", text: "current" });
      expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([]);
    });
  });

  test("does not re-enter from the settle path while a new turn is running", async () => {
    /**
     * The finally-block re-drive exists for a queue stranded with an idle
     * session. When the send left the session loading again, the effect watching
     * `isLoading` owns the next drain — re-entering here would race it.
     */
    const store = createStore([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
    ]);
    const sent: string[] = [];
    const send = mock(async (entry: Queued) => {
      sent.push(entry.text);
      // The dispatched prompt starts a turn that has not settled yet.
      store.setState({ sessions: new Map([[SESSION_KEY, { isLoading: true }]]) });
    });

    render(<Harness store={store} send={send} />);

    await waitFor(() => expect(sent).toEqual(["first"]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second entry waits for the running turn to settle.
    expect(sent).toEqual(["first"]);
    expect(store.getState().messageQueue.get(SESSION_KEY)).toHaveLength(1);

    store.setState({ sessions: new Map([[SESSION_KEY, { isLoading: false }]]) });
    await waitFor(() => expect(sent).toEqual(["first", "second"]));
  });
});
