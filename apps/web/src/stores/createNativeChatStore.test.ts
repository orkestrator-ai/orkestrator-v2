import { beforeEach, describe, expect, test } from "bun:test";
import { create } from "zustand";
import {
  buildClearEnvironmentPatch,
  buildClearSessionPatch,
  createNativeChatStoreSlice,
  pruneSessionKeyedMap,
  sessionKeyPrefixFor,
  type NativeChatStoreSlice,
} from "./createNativeChatStore";

type TestMessage = { id: string; content: string };
type TestAttachment = { id: string; name: string };
type TestQueued = { id: string; text: string };

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

function resetStore(store: typeof useTestStore | typeof useMergedStore) {
  store.setState({
    serverStatus: new Map(),
    clients: new Map(),
    sessions: new Map(),
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

  test("returns FIFO queue items and leaves the remaining queue intact", () => {
    const store = useTestStore.getState();

    store.addToQueue("env-env-1:tab-1", { id: "q-1", text: "first" });
    store.addToQueue("env-env-1:tab-1", { id: "q-2", text: "second" });

    expect(store.getQueueLength("env-env-1:tab-1")).toBe(2);
    expect(store.removeFromQueue("env-env-1:tab-1")).toEqual({
      id: "q-1",
      text: "first",
    });
    expect(store.getQueuedMessages("env-env-1:tab-1")).toEqual([
      { id: "q-2", text: "second" },
    ]);
  });

  test("requeueToFront restores an entry ahead of the rest of the queue", () => {
    /**
     * The drain dequeues before it knows the sender is ready, so an entry it
     * cannot dispatch goes back where it came from. Appending would silently
     * reorder the user's prompts.
     */
    const store = useTestStore.getState();

    store.addToQueue("env-env-1:tab-1", { id: "q-1", text: "first" });
    store.addToQueue("env-env-1:tab-1", { id: "q-2", text: "second" });
    const taken = store.removeFromQueue("env-env-1:tab-1")!;
    store.requeueToFront("env-env-1:tab-1", taken);

    expect(store.getQueuedMessages("env-env-1:tab-1")).toEqual([
      { id: "q-1", text: "first" },
      { id: "q-2", text: "second" },
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
