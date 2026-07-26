import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { create } from "zustand";
import { useNativeMessageQueue } from "./useNativeMessageQueue";

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
}: {
  store: ReturnType<typeof createStore>;
  send: (entry: Queued) => Promise<unknown> | undefined;
  onError?: (error: unknown, entry: Queued) => void;
}) {
  const queueLength = store((s) => s.messageQueue.get(SESSION_KEY)?.length ?? 0);
  const isLoading = store((s) => s.sessions.get(SESSION_KEY)?.isLoading ?? false);

  useNativeMessageQueue<Queued>({
    agentLabel: "Test",
    sessionKey: SESSION_KEY,
    store,
    canDrain: true,
    queueLength,
    isLoading,
    blockedByDraft: false,
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

  test("reports a rejected send through onError without stalling the queue", async () => {
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
    // The failure must not strand the rest of the queue.
    await waitFor(() =>
      expect(store.getState().messageQueue.get(SESSION_KEY)).toEqual([]),
    );
  });

  test("does not drain while the composer holds a draft", async () => {
    const store = createStore([{ id: "q-1", text: "first" }]);
    store.setState({ draftText: new Map([[SESSION_KEY, "half typed"]]) });
    const send = mock(async () => {});

    render(<Harness store={store} send={send} />);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(send).not.toHaveBeenCalled();
  });
});
