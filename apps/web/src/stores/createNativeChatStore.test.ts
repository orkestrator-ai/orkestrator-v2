import { beforeEach, describe, expect, test } from "bun:test";
import { create } from "zustand";
import {
  buildClearEnvironmentPatch,
  buildClearSessionPatch,
  createEventSubscriptionSlice,
  createNativeChatStoreSlice,
  pruneSessionKeyedMap,
  sessionKeyPrefixFor,
  shouldReconnectEventSubscription,
  teardownEventSubscription,
  type NativeChatStoreSlice,
  type NativeEventSubscriptionSlice,
  type NativeEventSubscriptionState,
} from "./createNativeChatStore";
import { seedQueuedPrompt } from "@/stores/testing/queue-projection";

type TestMessage = { id: string; content: string };
type TestAttachment = { id: string; name: string };
type TestQueued = { id: string; text: string };
type TestEvent = { type: string };

type TestStore = NativeChatStoreSlice<
  string,
  TestMessage,
  TestAttachment,
  TestQueued
>;

const useTestStore = create<TestStore>()((set, get, api) => ({
  ...createNativeChatStoreSlice<string, TestMessage, TestAttachment, TestQueued>()(
    set,
    get,
    api,
  ),
}));

const useMergedStore = create<TestStore>()((set, get, api) => ({
  ...createNativeChatStoreSlice<string, TestMessage, TestAttachment, TestQueued>({
    mergeMessages: (existing, incoming) => [...existing, ...incoming],
  })(set, get, api),
}));

const useEventStore = create<NativeEventSubscriptionSlice<TestEvent>>()(
  (set, get, api) => ({
    ...createEventSubscriptionSlice<TestEvent>("TestAgent")(set, get, api),
  }),
);

function resetStore(store: typeof useTestStore | typeof useMergedStore) {
  store.setState({
    serverStatus: new Map(),
    clients: new Map(),
    sessions: new Map(),
    sessionLoadingRevisions: new Map(),
    attachments: new Map(),
    draftText: new Map(),
    draftMentions: new Map(),
    messageQueue: new Map(),
  });
}

describe("createNativeChatStoreSlice", () => {
  beforeEach(() => {
    resetStore(useTestStore);
    resetStore(useMergedStore);
  });

  test("reports the projected queue in order", () => {
    const store = useTestStore.getState();

    seedQueuedPrompt(store, "env-env-1:tab-1", { id: "q-1", text: "first" });
    seedQueuedPrompt(store, "env-env-1:tab-1", { id: "q-2", text: "second" });

    expect(store.getQueueLength("env-env-1:tab-1")).toBe(2);
    expect(store.getQueuedMessages("env-env-1:tab-1")).toEqual([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
    ]);
  });

  test("setQueueProjection replaces one session's queue without touching another", () => {
    /**
     * The projection is overwritten wholesale from an authoritative backend
     * snapshot, so a replacement must not leak across sessions the way an
     * in-place edit of the shared map would.
     */
    const store = useTestStore.getState();

    seedQueuedPrompt(store, "env-env-1:tab-1", { id: "q-1", text: "first" });
    seedQueuedPrompt(store, "env-env-1:tab-2", { id: "other", text: "elsewhere" });

    store.setQueueProjection("env-env-1:tab-1", [{ id: "q-9", text: "authoritative" }]);

    expect(store.getQueuedMessages("env-env-1:tab-1")).toEqual([
      { id: "q-9", text: "authoritative" },
    ]);
    expect(store.getQueuedMessages("env-env-1:tab-2")).toEqual([
      { id: "other", text: "elsewhere" },
    ]);
  });

  test("stores and clears draft text, mentions, and attachments by session key", () => {
    const store = useTestStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setDraftText(sessionKey, "draft");
    store.setDraftMentions(sessionKey, [
      {
        id: "mention-1",
        filename: "app.ts",
        relativePath: "src/app.ts",
      },
    ]);
    store.addAttachment(sessionKey, { id: "att-1", name: "diagram.png" });

    expect(store.getDraftText(sessionKey)).toBe("draft");
    expect(store.getDraftMentions(sessionKey)).toHaveLength(1);
    expect(store.getAttachments(sessionKey)).toEqual([
      { id: "att-1", name: "diagram.png" },
    ]);

    store.setDraftText(sessionKey, "");
    store.setDraftMentions(sessionKey, []);
    store.clearAttachments(sessionKey);

    expect(store.getDraftText(sessionKey)).toBe("");
    expect(store.getDraftMentions(sessionKey)).toEqual([]);
    expect(store.getAttachments(sessionKey)).toEqual([]);
  });

  test("applies a custom merge strategy when setMessages is called", () => {
    const store = useMergedStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [{ id: "existing", content: "existing" }],
      isLoading: false,
    });
    store.setMessages(sessionKey, [{ id: "incoming", content: "incoming" }]);

    expect(store.getSession(sessionKey)?.messages).toEqual([
      { id: "existing", content: "existing" },
      { id: "incoming", content: "incoming" },
    ]);
  });

  test("upserts messages by id without applying the setMessages merge strategy", () => {
    const store = useMergedStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [
        { id: "user", content: "Hello" },
        { id: "assistant", content: "" },
      ],
      isLoading: true,
    });

    store.upsertMessage(sessionKey, { id: "assistant", content: "Streaming" });
    store.upsertMessage(sessionKey, { id: "tool", content: "Done" });

    expect(store.getSession(sessionKey)?.messages).toEqual([
      { id: "user", content: "Hello" },
      { id: "assistant", content: "Streaming" },
      { id: "tool", content: "Done" },
    ]);
  });

  test("replaces messages wholesale when no merge strategy is configured", () => {
    // The default merge is the identity-on-incoming fallback: a store built
    // without `mergeMessages` must not accumulate the previous transcript.
    const store = useTestStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [{ id: "existing", content: "existing" }],
      isLoading: false,
    });
    store.setMessages(sessionKey, [{ id: "incoming", content: "incoming" }]);

    expect(store.getSession(sessionKey)?.messages).toEqual([
      { id: "incoming", content: "incoming" },
    ]);
  });

  test("setSession with null deletes the session entry", () => {
    const store = useTestStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [{ id: "m-1", content: "hi" }],
      isLoading: false,
    });
    store.setSession("env-env-1:tab-2", {
      sessionId: "session-2",
      messages: [],
      isLoading: false,
    });

    store.setSession(sessionKey, null);

    expect(store.getSession(sessionKey)).toBeUndefined();
    expect(useTestStore.getState().sessions.has(sessionKey)).toBe(false);
    // Sibling tabs of the same environment survive.
    expect(store.getSession("env-env-1:tab-2")?.sessionId).toBe("session-2");
  });

  test("advances loading revisions for repeated lifecycle writes but not transcript writes", () => {
    const store = useTestStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [],
      isLoading: false,
    });
    const afterSession = useTestStore
      .getState()
      .sessionLoadingRevisions.get(sessionKey);

    store.setSessionLoading(sessionKey, true);
    const afterRunning = useTestStore
      .getState()
      .sessionLoadingRevisions.get(sessionKey);
    store.setSessionLoading(sessionKey, true);
    const afterRepeatedRunning = useTestStore
      .getState()
      .sessionLoadingRevisions.get(sessionKey);
    store.upsertMessage(sessionKey, { id: "m-1", content: "streaming" });
    const afterTranscript = useTestStore
      .getState()
      .sessionLoadingRevisions.get(sessionKey);
    store.setSessionLoading(sessionKey, false);
    const afterIdle = useTestStore
      .getState()
      .sessionLoadingRevisions.get(sessionKey);
    store.setSessionLoading(sessionKey, false);

    expect(afterSession).toBe(1);
    expect(afterRunning).toBe(2);
    expect(afterRepeatedRunning).toBe(3);
    expect(afterTranscript).toBe(afterRepeatedRunning);
    expect(afterIdle).toBe(4);
    expect(
      useTestStore.getState().sessionLoadingRevisions.get(sessionKey),
    ).toBe(5);
  });

  test("setClient with null deletes the client entry", () => {
    const store = useTestStore.getState();

    store.setClient("env-1", "client-1");
    store.setClient("env-2", "client-2");

    store.setClient("env-1", null);

    expect(store.getClient("env-1")).toBeUndefined();
    expect(useTestStore.getState().clients.has("env-1")).toBe(false);
    expect(store.getClient("env-2")).toBe("client-2");
  });

  test("session mutations are no-ops when the session key holds nothing", () => {
    // Events can arrive for a tab whose session was already torn down; every
    // session-keyed action has to tolerate that rather than resurrect a
    // half-built session with no sessionId.
    const store = useTestStore.getState();
    const sessionKey = "env-env-1:missing";

    const before = useTestStore.getState();
    store.addMessage(sessionKey, { id: "m-1", content: "hi" });
    store.upsertMessage(sessionKey, { id: "m-1", content: "hi" });
    store.removeMessage(sessionKey, "m-1");
    store.setMessages(sessionKey, [{ id: "m-1", content: "hi" }]);
    store.setSessionLoading(sessionKey, true);
    store.setSessionError(sessionKey, "boom");
    store.setSessionTitle(sessionKey, "Title");

    expect(store.getSession(sessionKey)).toBeUndefined();
    expect(useTestStore.getState()).toBe(before);
  });

  test("removeMessage keeps the state object when the message id is absent", () => {
    // Returning a fresh state here would re-render every subscriber for nothing.
    const store = useTestStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.setSession(sessionKey, {
      sessionId: "session-1",
      messages: [{ id: "m-1", content: "kept" }],
      isLoading: false,
    });

    const before = useTestStore.getState();
    store.removeMessage(sessionKey, "not-here");

    expect(useTestStore.getState()).toBe(before);
    expect(store.getSession(sessionKey)?.messages).toEqual([
      { id: "m-1", content: "kept" },
    ]);
  });

  test("removeAttachment keeps the state object when the attachment id is absent", () => {
    const store = useTestStore.getState();
    const sessionKey = "env-env-1:tab-1";

    store.addAttachment(sessionKey, { id: "att-1", name: "diagram.png" });

    const before = useTestStore.getState();
    store.removeAttachment(sessionKey, "not-here");

    expect(useTestStore.getState()).toBe(before);
    expect(store.getAttachments(sessionKey)).toEqual([
      { id: "att-1", name: "diagram.png" },
    ]);
  });

  test("empty attachment, mention, and queue getters return stable references", () => {
    /**
     * React 19 + useSyncExternalStore detects an unstable snapshot and spins in
     * an infinite render loop, so a regression to `?? []` has to fail here —
     * only a reference check catches it.
     */
    const store = useTestStore.getState();

    expect(store.getAttachments("env-env-1:tab-1")).toBe(
      store.getAttachments("env-env-1:tab-1"),
    );
    expect(store.getAttachments("env-env-1:tab-1")).toBe(
      store.getAttachments("env-env-2:tab-9"),
    );

    expect(store.getDraftMentions("env-env-1:tab-1")).toBe(
      store.getDraftMentions("env-env-1:tab-1"),
    );
    expect(store.getDraftMentions("env-env-1:tab-1")).toBe(
      store.getDraftMentions("env-env-2:tab-9"),
    );

    expect(store.getQueuedMessages("env-env-1:tab-1")).toBe(
      store.getQueuedMessages("env-env-1:tab-1"),
    );
    expect(store.getQueuedMessages("env-env-1:tab-1")).toBe(
      store.getQueuedMessages("env-env-2:tab-9"),
    );
  });
});

describe("pruneSessionKeyedMap", () => {
  test("removes only entries that belong to the targeted environment prefix", () => {
    const pruned = pruneSessionKeyedMap(
      new Map([
        ["env-env-1:tab-1", "remove-a"],
        ["env-env-1:tab-2", "remove-b"],
        ["env-env-2:tab-1", "keep"],
      ]),
      "env-env-1:",
    );

    expect(pruned).toEqual(
      new Map([
        ["env-env-2:tab-1", "keep"],
      ]),
    );
  });
});

describe("sessionKeyPrefixFor", () => {
  test("includes the separator so sibling ids cannot collide", () => {
    // Without the trailing colon, clearing "env-1" would also wipe "env-10".
    expect(sessionKeyPrefixFor("env-1")).toBe("env-env-1:");
    expect("env-env-10:tab-1".startsWith(sessionKeyPrefixFor("env-1"))).toBe(false);
  });
});

describe("buildClearEnvironmentPatch", () => {
  test("drops environment-keyed and session-keyed entries for one environment", () => {
    const state = {
      clients: new Map([["env-1", "client-1"], ["env-2", "client-2"]]),
      draftText: new Map([
        ["env-env-1:tab-1", "gone"],
        ["env-env-2:tab-1", "kept"],
      ]),
    };

    const patch = buildClearEnvironmentPatch(state, "env-1", {
      environmentKeyed: ["clients"],
      sessionKeyed: ["draftText"],
    });

    expect(patch.clients).toEqual(new Map([["env-2", "client-2"]]));
    expect(patch.draftText).toEqual(new Map([["env-env-2:tab-1", "kept"]]));
  });

  test("also drops a legacy environment-keyed entry from a session-keyed map", () => {
    // Some maps were keyed by environmentId in older builds; a stale entry must
    // not outlive the environment it belonged to.
    const state = { selectedModel: new Map([["env-1", "legacy"]]) };

    const patch = buildClearEnvironmentPatch(state, "env-1", {
      environmentKeyed: [],
      sessionKeyed: ["selectedModel"],
    });

    expect(patch.selectedModel).toEqual(new Map());
  });
});

describe("buildClearSessionPatch", () => {
  test("drops only the closed tab's entries across every named map", () => {
    const state = {
      draftText: new Map([
        ["env-env-1:tab-1", "gone"],
        ["env-env-1:tab-2", "kept"],
      ]),
      selectedModel: new Map([["env-env-1:tab-1", "opus"]]),
      attachments: new Map([["env-env-1:tab-2", ["kept"]]]),
    };

    const patch = buildClearSessionPatch(state, "env-env-1:tab-1", [
      "draftText",
      "selectedModel",
      "attachments",
    ]);

    expect(patch.draftText).toEqual(new Map([["env-env-1:tab-2", "kept"]]));
    expect(patch.selectedModel).toEqual(new Map());
    // Untouched maps are omitted entirely rather than replaced, so unrelated
    // subscribers do not re-render on a tab close.
    expect(patch.attachments).toBeUndefined();
  });

  test("returns an empty patch for a session key that holds nothing", () => {
    const state = { draftText: new Map([["env-env-1:tab-1", "kept"]]) };
    expect(buildClearSessionPatch(state, "env-env-1:tab-9", ["draftText"])).toEqual(
      {},
    );
  });
});

describe("teardownEventSubscription", () => {
  function subscriptionWithStream(
    stream: AsyncIterable<TestEvent> | null,
  ): NativeEventSubscriptionState<TestEvent> {
    return { abortController: new AbortController(), stream, isActive: true };
  }

  test("tolerates an undefined subscription", () => {
    // `clearEnvironment` calls this for environments that never subscribed.
    expect(() => teardownEventSubscription<TestEvent>(undefined)).not.toThrow();
  });

  test("aborts and drains the iterator", () => {
    let returned = false;
    const stream: AsyncIterable<TestEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
        return: () => {
          returned = true;
          return Promise.resolve({ done: true as const, value: undefined });
        },
      }),
    };
    const subscription = subscriptionWithStream(stream);

    teardownEventSubscription(subscription);

    // Aborting without returning the iterator leaks the generator.
    expect(subscription.abortController.signal.aborted).toBe(true);
    expect(returned).toBe(true);
  });

  test("still aborts when the stream has no async iterator", () => {
    const subscription = subscriptionWithStream(
      {} as unknown as AsyncIterable<TestEvent>,
    );

    expect(() => teardownEventSubscription(subscription)).not.toThrow();
    expect(subscription.abortController.signal.aborted).toBe(true);
  });

  test("still aborts when the iterator has no return method", () => {
    const stream = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    } as unknown as AsyncIterable<TestEvent>;
    const subscription = subscriptionWithStream(stream);

    expect(() => teardownEventSubscription(subscription)).not.toThrow();
    expect(subscription.abortController.signal.aborted).toBe(true);
  });

  test("aborts a subscription that never received a stream", () => {
    const subscription = subscriptionWithStream(null);

    expect(() => teardownEventSubscription(subscription)).not.toThrow();
    expect(subscription.abortController.signal.aborted).toBe(true);
  });
});

describe("createEventSubscriptionSlice", () => {
  beforeEach(() => {
    useEventStore.setState({ eventSubscriptions: new Map() });
  });

  test("setEventStream is a no-op for an unknown environment", () => {
    // A stream can resolve after the environment was cleared; it must not
    // resurrect a subscription that nothing will ever tear down.
    const store = useEventStore.getState();
    const stream: AsyncIterable<TestEvent> = {
      [Symbol.asyncIterator]: async function* () {},
    };

    const before = useEventStore.getState();
    store.setEventStream("env-unknown", stream);

    expect(useEventStore.getState()).toBe(before);
    expect(useEventStore.getState().eventSubscriptions.has("env-unknown")).toBe(
      false,
    );
    expect(store.hasActiveEventSubscription("env-unknown")).toBe(false);
  });

  test("closeEventSubscription is a no-op for an unknown environment", () => {
    const store = useEventStore.getState();

    const before = useEventStore.getState();
    expect(() => store.closeEventSubscription("env-unknown")).not.toThrow();

    expect(useEventStore.getState()).toBe(before);
  });

  test("getOrCreateEventSubscription always returns a subscription", () => {
    // The callers dropped their null checks on the strength of this contract.
    const store = useEventStore.getState();

    const created = store.getOrCreateEventSubscription("env-1");
    expect(created).toBeDefined();
    expect(created.isActive).toBe(true);
    // An active subscription is reused rather than duplicated.
    expect(store.getOrCreateEventSubscription("env-1")).toBe(created);

    // An inactive one is replaced, and the replacement gets its own controller
    // so a stale loop can tell that it has been superseded.
    store.setEventStream("env-1", null);
    const replacement = store.getOrCreateEventSubscription("env-1");
    expect(replacement).not.toBe(created);
    expect(replacement.abortController).not.toBe(created.abortController);
    expect(replacement.isActive).toBe(true);
  });

  test("a superseded subscription cannot clear the stream of its replacement", () => {
    /*
     * A dropped loop runs its teardown asynchronously. By the time it calls
     * `setEventStream(id, null)` the environment may already belong to a fresh
     * subscription, and clearing that one would strand a running loop behind a
     * store entry that reads as "nothing is listening".
     */
    const store = useEventStore.getState();
    const stream: AsyncIterable<TestEvent> = {
      [Symbol.asyncIterator]: async function* () {},
    };
    const dropped = store.getOrCreateEventSubscription("env-1");
    store.setEventStream("env-1", null, dropped.abortController);
    const replacement = store.getOrCreateEventSubscription("env-1");
    store.setEventStream("env-1", stream, replacement.abortController);

    // The dropped loop's trailing teardown, arriving late.
    store.setEventStream("env-1", null, dropped.abortController);

    const current = useEventStore.getState().eventSubscriptions.get("env-1");
    expect(current?.abortController).toBe(replacement.abortController);
    expect(current?.stream).toBe(stream);
    expect(store.hasActiveEventSubscription("env-1")).toBe(true);
  });

  test("an owner-less setEventStream still applies, for callers that predate ownership", () => {
    const store = useEventStore.getState();
    const stream: AsyncIterable<TestEvent> = {
      [Symbol.asyncIterator]: async function* () {},
    };
    store.getOrCreateEventSubscription("env-1");

    store.setEventStream("env-1", stream);
    expect(store.hasActiveEventSubscription("env-1")).toBe(true);

    store.setEventStream("env-1", null);
    expect(store.hasActiveEventSubscription("env-1")).toBe(false);
  });
});

describe("shouldReconnectEventSubscription", () => {
  function subscription(
    abortController: AbortController,
    isActive: boolean,
  ): NativeEventSubscriptionState<TestEvent> {
    return { abortController, stream: null, isActive };
  }

  test("reconnects only the dropped subscription that still owns the environment", () => {
    const owner = new AbortController();

    expect(shouldReconnectEventSubscription(subscription(owner, false), owner))
      .toBe(true);
  });

  test("refuses to resurrect an explicitly closed subscription", () => {
    // `closeEventSubscription`/`clearEnvironment` delete the entry outright.
    // Reconnecting here would restart a stream the app deliberately stopped.
    expect(shouldReconnectEventSubscription(undefined, new AbortController()))
      .toBe(false);
  });

  test("stands down when a replacement subscription owns the environment", () => {
    const owner = new AbortController();
    const replacement = new AbortController();

    // Running both loops against one environment would double every event.
    expect(
      shouldReconnectEventSubscription(subscription(replacement, true), owner),
    ).toBe(false);
    expect(
      shouldReconnectEventSubscription(subscription(replacement, false), owner),
    ).toBe(false);
  });

  test("stands down while its own subscription is still active", () => {
    const owner = new AbortController();

    expect(shouldReconnectEventSubscription(subscription(owner, true), owner))
      .toBe(false);
  });
});
