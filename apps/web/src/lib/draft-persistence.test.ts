import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import * as realBackend from "@/lib/backend";
import { mockToastError as toastError } from "../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const saveComposeDraft = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const deleteComposeDraft = mock(
  async (..._args: unknown[]): Promise<void> => undefined,
);
const getComposeDraft = mock(
  async (
    ..._args: unknown[]
  ): Promise<Awaited<ReturnType<typeof realBackend.getComposeDraft>>> => null,
);
const saveFileDraft = mock(
  async (..._args: unknown[]): Promise<unknown> => undefined,
);
const deleteFileDraft = mock(
  async (..._args: unknown[]): Promise<void> => undefined,
);
const getFileDraft = mock(
  async (
    ..._args: unknown[]
  ): Promise<Awaited<ReturnType<typeof realBackend.getFileDraft>>> => null,
);
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  saveComposeDraft,
  deleteComposeDraft,
  getComposeDraft,
  saveFileDraft,
  deleteFileDraft,
  getFileDraft,
}));

const compose = await import("./compose-draft-persistence");
const files = await import("./file-draft-persistence");
const { useDurableComposeDraft } = await import("../hooks/useDurableComposeDraft");
const { useNativeComposeDraftPersistence } = await import(
  "../hooks/useNativeComposeDraftPersistence"
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  cleanup();
  for (const fn of [
    saveComposeDraft,
    deleteComposeDraft,
    getComposeDraft,
    saveFileDraft,
    deleteFileDraft,
    getFileDraft,
  ]) {
    fn.mockReset();
  }
  toastError.mockClear();
  saveComposeDraft.mockImplementation(async () => undefined);
  deleteComposeDraft.mockImplementation(async () => undefined);
  getComposeDraft.mockImplementation(async () => null);
  saveFileDraft.mockImplementation(async () => undefined);
  deleteFileDraft.mockImplementation(async () => undefined);
  getFileDraft.mockImplementation(async () => null);
});

afterAll(() => {
  cleanup();
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("compose draft persistence", () => {
  test("records revisions created by an atomic external draft mutation", async () => {
    const key = "draft:atomic-transfer";
    saveComposeDraft.mockResolvedValueOnce({
      draftKey: key,
      ownerType: "environment",
      ownerId: "env-1",
      value: "edited",
      updatedAt: "2026-07-29T00:00:00.000Z",
      revision: 8,
    });

    compose.recordComposeDraftRevision(key, 7);
    await compose.persistComposeDraft(
      key,
      "environment",
      "env-1",
      "edited",
    );

    expect(saveComposeDraft).toHaveBeenCalledWith(
      key,
      "environment",
      "env-1",
      "edited",
      7,
    );
  });

  test("encodes local keys so separators and Unicode remain one key segment", () => {
    expect(compose.composeDraftKey("linear", "project", "issue:/💾")).toBe(
      "linear:project:issue%3A%2F%F0%9F%92%BE",
    );
  });

  test("serializes save, delete, and subsequent read for the same key", async () => {
    const save = deferred<void>();
    saveComposeDraft.mockImplementationOnce(() => save.promise);
    getComposeDraft.mockImplementationOnce(async () => ({
      draftKey: "draft:serial",
      ownerType: "environment" as const,
      ownerId: "env",
      value: "stored",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    }));

    const saving = compose.persistComposeDraft(
      "draft:serial",
      "environment",
      "env",
      "value",
    );
    const deleting = compose.discardComposeDraft("draft:serial");
    const reading = compose.loadComposeDraft<string>("draft:serial");

    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledTimes(1));
    expect(deleteComposeDraft).not.toHaveBeenCalled();
    expect(getComposeDraft).not.toHaveBeenCalled();

    save.resolve();
    await saving;
    await deleting;
    await reading;

    expect(deleteComposeDraft).toHaveBeenCalledTimes(1);
    expect(getComposeDraft).toHaveBeenCalledTimes(1);
  });

  test("recovers the per-key chain after a rejected write", async () => {
    saveComposeDraft
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    await expect(compose.persistComposeDraft(
      "draft:recover",
      "project",
      "project",
      "first",
    )).rejects.toThrow("disk full");
    await expect(compose.persistComposeDraft(
      "draft:recover",
      "project",
      "project",
      "second",
    )).resolves.toBeUndefined();

    expect(saveComposeDraft).toHaveBeenCalledTimes(2);
  });

  test("does not emit an unhandled rejection when a caller handles failure", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", handler);
    try {
      saveComposeDraft.mockRejectedValueOnce(new Error("expected failure"));
      await compose.persistComposeDraft(
        "draft:handled-rejection",
        "environment",
        "env",
        "value",
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });

  test("carries the hydrated revision through saves and deletes", async () => {
    const key = "draft:revision-aware";
    getComposeDraft.mockResolvedValueOnce({
      draftKey: key,
      ownerType: "project",
      ownerId: "project",
      value: "stored",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 3,
    });
    saveComposeDraft.mockResolvedValueOnce({
      draftKey: key,
      ownerType: "project",
      ownerId: "project",
      value: "edited",
      updatedAt: "2026-07-28T00:01:00.000Z",
      revision: 4,
    });

    await compose.loadComposeDraft(key);
    await compose.persistComposeDraft(key, "project", "project", "edited");
    await compose.discardComposeDraft(key);

    expect(saveComposeDraft).toHaveBeenCalledWith(
      key,
      "project",
      "project",
      "edited",
      3,
    );
    expect(deleteComposeDraft).toHaveBeenCalledWith(key, 4);
  });

  test("blocks later writes after a revision conflict until explicit resolution", async () => {
    const key = "draft:stale-revision";
    getComposeDraft.mockResolvedValueOnce({
      draftKey: key,
      ownerType: "environment",
      ownerId: "env",
      value: "stored",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 2,
    });
    saveComposeDraft.mockRejectedValue(new Error("Compose draft revision conflict"));

    await compose.loadComposeDraft(key);
    await expect(compose.persistComposeDraft(
      key,
      "environment",
      "env",
      "stale",
    )).rejects.toBeInstanceOf(compose.DraftRevisionConflictError);
    await expect(compose.persistComposeDraft(
      key,
      "environment",
      "env",
      "still stale",
    )).rejects.toBeInstanceOf(compose.DraftRevisionConflictError);

    expect(saveComposeDraft.mock.calls.map(
      (call) => (call as unknown[])[4],
    )).toEqual([2]);
  });

  test("keeps revisions isolated between two same-key consumers", async () => {
    const key = "draft:two-consumers";
    const firstState = compose.createDraftRevisionState();
    const secondState = compose.createDraftRevisionState();
    const revisionOne = {
      draftKey: key,
      ownerType: "project" as const,
      ownerId: "project",
      value: "initial",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    };
    getComposeDraft
      .mockResolvedValueOnce(revisionOne)
      .mockResolvedValueOnce(revisionOne)
      .mockResolvedValueOnce({ ...revisionOne, value: "first", revision: 2 });
    saveComposeDraft
      .mockResolvedValueOnce({ ...revisionOne, value: "first", revision: 2 })
      .mockRejectedValueOnce(new Error("Compose draft revision conflict"))
      .mockResolvedValueOnce({ ...revisionOne, value: "second", revision: 3 });

    await compose.loadComposeDraft(key, firstState);
    await compose.loadComposeDraft(key, secondState);
    await compose.persistComposeDraft(
      key,
      "project",
      "project",
      "first",
      firstState,
    );
    await expect(compose.persistComposeDraft(
      key,
      "project",
      "project",
      "second",
      secondState,
    )).rejects.toBeInstanceOf(compose.DraftRevisionConflictError);

    expect(saveComposeDraft.mock.calls.map(
      (call) => (call as unknown[])[4],
    )).toEqual([1, 1]);

    await compose.resolveComposeDraftSaveConflict(
      key,
      "project",
      "project",
      "second",
      secondState,
    );
    expect(saveComposeDraft.mock.calls.map(
      (call) => (call as unknown[])[4],
    )).toEqual([1, 1, 2]);
  });
});

describe("file draft persistence", () => {
  test("keeps independent file keys from blocking each other", async () => {
    const first = deferred<void>();
    saveFileDraft.mockImplementationOnce(() => first.promise);

    const pendingFirst = files.persistFileDraft("env", "first.ts", "a", "");
    const second = files.persistFileDraft("env", "second.ts", "b", "");

    await second;
    expect(saveFileDraft).toHaveBeenCalledTimes(2);
    first.resolve();
    await pendingFirst;
  });

  test("a rapid reopen waits for an in-flight discard and reads authoritative state", async () => {
    const deletion = deferred<void>();
    deleteFileDraft.mockImplementationOnce(() => deletion.promise);
    getFileDraft.mockResolvedValue(null);

    const deleting = files.discardFileDraft("env", "src/index.ts");
    const reopening = files.loadFileDraft("env", "src/index.ts");
    await Promise.resolve();
    expect(getFileDraft).not.toHaveBeenCalled();

    deletion.resolve();
    await deleting;
    expect(await reopening).toBeNull();
    expect(getFileDraft).toHaveBeenCalledTimes(1);
  });

  test("carries file revisions through saves and deletes", async () => {
    const key = files.fileDraftKey("env-revision", "src/index.ts");
    getFileDraft.mockResolvedValueOnce({
      draftKey: key,
      environmentId: "env-revision",
      filePath: "src/index.ts",
      content: "stored",
      originalContent: "disk",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 7,
    });
    saveFileDraft.mockResolvedValueOnce({
      draftKey: key,
      environmentId: "env-revision",
      filePath: "src/index.ts",
      content: "edited",
      originalContent: "disk",
      updatedAt: "2026-07-28T00:01:00.000Z",
      revision: 8,
    });

    await files.loadFileDraft("env-revision", "src/index.ts");
    await files.persistFileDraft("env-revision", "src/index.ts", "edited", "disk");
    await files.discardFileDraft("env-revision", "src/index.ts");

    expect(saveFileDraft).toHaveBeenCalledWith(
      key,
      "env-revision",
      "src/index.ts",
      "edited",
      "disk",
      7,
    );
    expect(deleteFileDraft).toHaveBeenCalledWith(key, 8);
  });

  test("blocks later file writes after a conflict until explicit resolution", async () => {
    const key = files.fileDraftKey("env-stale", "src/index.ts");
    getFileDraft.mockResolvedValueOnce({
      draftKey: key,
      environmentId: "env-stale",
      filePath: "src/index.ts",
      content: "stored",
      originalContent: "disk",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 5,
    });
    saveFileDraft.mockRejectedValue(new Error("File draft revision conflict"));

    await files.loadFileDraft("env-stale", "src/index.ts");
    await expect(files.persistFileDraft(
      "env-stale",
      "src/index.ts",
      "stale",
      "disk",
    )).rejects.toBeInstanceOf(compose.DraftRevisionConflictError);
    await expect(files.persistFileDraft(
      "env-stale",
      "src/index.ts",
      "still stale",
      "disk",
    )).rejects.toBeInstanceOf(compose.DraftRevisionConflictError);

    expect(saveFileDraft.mock.calls.map(
      (call) => (call as unknown[])[5],
    )).toEqual([5]);
  });

  test("a failed stale delete does not hide the newer authoritative file draft", async () => {
    const key = files.fileDraftKey("env-delete-conflict", "src/index.ts");
    const state = files.createDraftRevisionState();
    const stale = {
      draftKey: key,
      environmentId: "env-delete-conflict",
      filePath: "src/index.ts",
      content: "stale",
      originalContent: "disk",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    };
    const current = { ...stale, content: "newer elsewhere", revision: 2 };
    getFileDraft
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(current);
    deleteFileDraft.mockRejectedValueOnce(
      new Error("File draft revision conflict"),
    );

    await files.loadFileDraft(
      "env-delete-conflict",
      "src/index.ts",
      state,
    );
    await expect(files.discardFileDraft(
      "env-delete-conflict",
      "src/index.ts",
      state,
    )).rejects.toBeInstanceOf(compose.DraftRevisionConflictError);

    expect(await files.loadFileDraft(
      "env-delete-conflict",
      "src/index.ts",
      files.createDraftRevisionState(),
    )).toEqual(current);
  });
});

const isString = (value: unknown): value is string => typeof value === "string";
const isBlank = (value: string) => value.length === 0;

describe("useDurableComposeDraft", () => {
  test("preserves local input and offers explicit conflict resolution", async () => {
    const key = "test:project-hook-conflict:value";
    const revisionOne = {
      draftKey: key,
      ownerType: "project" as const,
      ownerId: "project-hook-conflict",
      value: "stored",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    };
    getComposeDraft
      .mockResolvedValueOnce(revisionOne)
      .mockResolvedValueOnce({ ...revisionOne, value: "other edit", revision: 2 });
    saveComposeDraft
      .mockRejectedValueOnce(new Error("Compose draft revision conflict"))
      .mockResolvedValueOnce({ ...revisionOne, value: "local edit", revision: 3 });

    const { result, unmount } = renderHook(() => useDurableComposeDraft({
      ownerType: "project",
      ownerId: "project-hook-conflict",
      namespace: "test",
      localKey: "value",
      initialValue: "",
      isEmpty: isBlank,
      isValid: isString,
      debounceMs: 5,
    }));
    await waitFor(() => expect(result.current[0]).toBe("stored"));

    act(() => result.current[1]("local edit"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(result.current[0]).toBe("local edit");
    const options = toastError.mock.calls.at(-1)?.[1] as {
      action?: { onClick?: () => void };
    };
    expect(typeof options.action?.onClick).toBe("function");

    act(() => options.action?.onClick?.());
    await waitFor(() => expect(saveComposeDraft.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(saveComposeDraft.mock.calls.slice(0, 2).map(
      (call) => (call as unknown[])[4],
    )).toEqual([1, 2]);
    expect(result.current[0]).toBe("local edit");
    unmount();
  });

  test("preserves input typed while hydration is pending and persists it", async () => {
    const snapshot = deferred<Awaited<ReturnType<typeof realBackend.getComposeDraft<string>>>>();
    getComposeDraft.mockImplementationOnce(() => snapshot.promise);

    const { result, unmount } = renderHook(() => useDurableComposeDraft({
      ownerType: "project",
      ownerId: "project-hook-pending",
      namespace: "test",
      localKey: "pending",
      initialValue: "",
      isEmpty: isBlank,
      isValid: isString,
      debounceMs: 5,
    }));

    act(() => result.current[1]("typed while loading"));
    snapshot.resolve({
      draftKey: "test:project-hook-pending:pending",
      ownerType: "project",
      ownerId: "project-hook-pending",
      value: "older stored value",
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });

    await waitFor(() => expect(result.current[0]).toBe("typed while loading"));
    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledWith(
      "test:project-hook-pending:pending",
      "project",
      "project-hook-pending",
      "typed while loading",
      1,
    ));
    unmount();
  });

  test("flushes the latest value on unmount before the debounce expires", async () => {
    getComposeDraft.mockResolvedValueOnce(null);
    const { result, unmount } = renderHook(() => useDurableComposeDraft({
      ownerType: "environment",
      ownerId: "env-hook-unmount",
      namespace: "test",
      localKey: "unmount",
      initialValue: "",
      isEmpty: isBlank,
      isValid: isString,
      debounceMs: 60_000,
    }));
    await waitFor(() => expect(getComposeDraft).toHaveBeenCalled());

    act(() => result.current[1]((previous) => `${previous}latest`));
    unmount();

    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledWith(
      "test:env-hook-unmount:unmount",
      "environment",
      "env-hook-unmount",
      "latest",
      0,
    ));
  });

  test("flushes the old key before hydrating a replacement key", async () => {
    getComposeDraft.mockResolvedValue(null);
    const { result, rerender, unmount } = renderHook(
      ({ localKey }) => useDurableComposeDraft({
        ownerType: "project",
        ownerId: "project-hook-key",
        namespace: "test",
        localKey,
        initialValue: "",
        isEmpty: isBlank,
        isValid: isString,
        debounceMs: 60_000,
      }),
      { initialProps: { localKey: "first" } },
    );
    await waitFor(() => expect(getComposeDraft).toHaveBeenCalled());
    act(() => result.current[1]("first value"));

    rerender({ localKey: "second" });

    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledWith(
      "test:project-hook-key:first",
      "project",
      "project-hook-key",
      "first value",
      0,
    ));
    await waitFor(() => expect(result.current[0]).toBe(""));
    unmount();
  });

  test("ignores malformed stored values and clear resets and deletes", async () => {
    getComposeDraft.mockResolvedValueOnce({
      draftKey: "test:project-hook-malformed:value",
      ownerType: "project",
      ownerId: "project-hook-malformed",
      value: { not: "a string" },
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });
    const { result, unmount } = renderHook(() => useDurableComposeDraft({
      ownerType: "project",
      ownerId: "project-hook-malformed",
      namespace: "test",
      localKey: "value",
      initialValue: "initial",
      isEmpty: isBlank,
      isValid: isString,
      debounceMs: 60_000,
    }));

    await waitFor(() => expect(result.current[0]).toBe("initial"));
    act(() => result.current[1]("changed"));
    await act(async () => result.current[2]());

    expect(result.current[0]).toBe("initial");
    expect(deleteComposeDraft).toHaveBeenCalledWith(
      "test:project-hook-malformed:value",
      1,
    );
    unmount();
    await Promise.resolve();
    expect(saveComposeDraft).not.toHaveBeenCalled();
  });

  test("does not delete an unread draft after a failed load but persists a later edit", async () => {
    getComposeDraft.mockRejectedValueOnce(new Error("backend unavailable"));
    const { result } = renderHook(() => useDurableComposeDraft({
      ownerType: "project",
      ownerId: "project-hook-failed-read",
      namespace: "test",
      localKey: "value",
      initialValue: "",
      isEmpty: isBlank,
      isValid: isString,
      debounceMs: 5,
    }));

    await waitFor(() => expect(getComposeDraft).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deleteComposeDraft).not.toHaveBeenCalled();

    act(() => result.current[1]("authoritative local edit"));
    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledWith(
      "test:project-hook-failed-read:value",
      "project",
      "project-hook-failed-read",
      "authoritative local edit",
      0,
    ));
  });
});

interface NativeState {
  draftText: Map<string, string>;
  draftMentions: Map<string, Array<{
    id: string;
    filename: string;
    relativePath: string;
  }>>;
  attachments: Map<string, Array<{
    id: string;
    type: "file" | "image";
    path: string;
    name: string;
    previewUrl?: string;
  }>>;
  setDraftText: (key: string, value: string) => void;
  setDraftMentions: (key: string, value: NativeState["draftMentions"] extends Map<string, infer T> ? T : never) => void;
  clearAttachments: (key: string) => void;
  addAttachment: (
    key: string,
    value: NativeState["attachments"] extends Map<string, Array<infer T>>
      ? T
      : never,
  ) => void;
}

function createNativeStore() {
  return createStore<NativeState>((set) => ({
    draftText: new Map(),
    draftMentions: new Map(),
    attachments: new Map(),
    setDraftText: (key, value) => set((state) => {
      const draftText = new Map(state.draftText);
      if (value) draftText.set(key, value);
      else draftText.delete(key);
      return { draftText };
    }),
    setDraftMentions: (key, value) => set((state) => {
      const draftMentions = new Map(state.draftMentions);
      if (value.length) draftMentions.set(key, value);
      else draftMentions.delete(key);
      return { draftMentions };
    }),
    clearAttachments: (key) => set((state) => {
      const attachments = new Map(state.attachments);
      attachments.delete(key);
      return { attachments };
    }),
    addAttachment: (key, value) => set((state) => {
      const attachments = new Map(state.attachments);
      attachments.set(key, [...(attachments.get(key) ?? []), value]);
      return { attachments };
    }),
  }));
}

describe("useNativeComposeDraftPersistence", () => {
  test("does not delete an unread backend draft when hydration is cancelled", async () => {
    const snapshot = deferred<Awaited<ReturnType<typeof realBackend.getComposeDraft>>>();
    getComposeDraft.mockImplementationOnce(() => snapshot.promise);
    const store = createNativeStore();
    const hook = renderHook(() => useNativeComposeDraftPersistence(
      "claude",
      "env-cancelled",
      "session",
      store,
    ));

    hook.unmount();
    await Promise.resolve();

    expect(deleteComposeDraft).not.toHaveBeenCalled();
    expect(saveComposeDraft).not.toHaveBeenCalled();
    snapshot.resolve(null);
  });

  test("local input wins over a pending snapshot and cleanup flushes it", async () => {
    const snapshot = deferred<Awaited<ReturnType<typeof realBackend.getComposeDraft>>>();
    getComposeDraft.mockImplementationOnce(() => snapshot.promise);
    const store = createNativeStore();
    const sessionKey = "env-native:tab";
    const { unmount } = renderHook(() => useNativeComposeDraftPersistence(
      "claude",
      "env-native",
      sessionKey,
      store,
    ));

    act(() => store.getState().setDraftText(sessionKey, "local"));
    snapshot.resolve({
      draftKey: compose.composeDraftKey("claude", "env-native", sessionKey),
      ownerType: "environment",
      ownerId: "env-native",
      value: { text: "stored", mentions: ["old"], attachments: [{ id: "old" }] },
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });
    await waitFor(() => expect(store.getState().draftText.get(sessionKey)).toBe("local"));

    unmount();
    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledWith(
      compose.composeDraftKey("claude", "env-native", sessionKey),
      "environment",
      "env-native",
      { text: "local", mentions: [], attachments: [] },
      1,
    ));
  });

  test("a type-then-clear edit blocks a stale pending snapshot", async () => {
    const snapshot = deferred<Awaited<ReturnType<typeof realBackend.getComposeDraft>>>();
    getComposeDraft.mockImplementationOnce(() => snapshot.promise);
    const store = createNativeStore();
    const sessionKey = "env-native-clear:tab";
    const hook = renderHook(() => useNativeComposeDraftPersistence(
      "claude",
      "env-native-clear",
      sessionKey,
      store,
    ));

    act(() => {
      store.getState().setDraftText(sessionKey, "temporary");
      store.getState().setDraftText(sessionKey, "");
    });
    snapshot.resolve({
      draftKey: compose.composeDraftKey("claude", "env-native-clear", sessionKey),
      ownerType: "environment",
      ownerId: "env-native-clear",
      value: { text: "stale stored value", mentions: [], attachments: [] },
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });

    await Promise.resolve();
    expect(store.getState().draftText.has(sessionKey)).toBe(false);
    hook.unmount();
  });

  test("another session changing does not suppress this session's hydration", async () => {
    getComposeDraft.mockResolvedValueOnce({
      draftKey: "claude:env-scoped:session-b",
      ownerType: "environment",
      ownerId: "env-scoped",
      value: { text: "session b restored", mentions: [], attachments: [] },
      updatedAt: "2026-07-28T00:00:00.000Z",
      revision: 1,
    });
    const store = createNativeStore();
    const hook = renderHook(() => useNativeComposeDraftPersistence(
      "claude",
      "env-scoped",
      "session-b",
      store,
    ));

    act(() => store.getState().setDraftText("session-a", "other tab"));

    await waitFor(() => expect(store.getState().draftText.get("session-b")).toBe(
      "session b restored",
    ));
    hook.unmount();
  });

  test("a failed native draft read does not delete the unread backend value", async () => {
    getComposeDraft.mockRejectedValueOnce(new Error("backend unavailable"));
    const store = createNativeStore();
    const hook = renderHook(() => useNativeComposeDraftPersistence(
      "codex",
      "env-failed-read",
      "session",
      store,
    ));

    await waitFor(() => expect(getComposeDraft).toHaveBeenCalled());
    hook.unmount();
    await Promise.resolve();

    expect(deleteComposeDraft).not.toHaveBeenCalled();
    expect(saveComposeDraft).not.toHaveBeenCalled();
  });

  test("closed-tab store cleanup deletes the backend draft on unmount", async () => {
    getComposeDraft.mockResolvedValueOnce(null);
    const store = createNativeStore();
    const sessionKey = "env-close:tab";
    store.getState().setDraftText(sessionKey, "will close");
    const { unmount } = renderHook(() => useNativeComposeDraftPersistence(
      "codex",
      "env-close",
      sessionKey,
      store,
    ));
    await waitFor(() => expect(getComposeDraft).toHaveBeenCalled());

    act(() => {
      store.getState().setDraftText(sessionKey, "");
      store.getState().setDraftMentions(sessionKey, []);
      store.getState().clearAttachments(sessionKey);
    });
    unmount();

    await waitFor(() => expect(deleteComposeDraft).toHaveBeenCalledWith(
      compose.composeDraftKey("codex", "env-close", sessionKey),
      0,
    ));
  });

  test("debounces ordinary store updates after hydration", async () => {
    getComposeDraft.mockResolvedValueOnce(null);
    const store = createNativeStore();
    const sessionKey = "env-debounce:tab";
    const hook = renderHook(() => useNativeComposeDraftPersistence(
      "claude",
      "env-debounce",
      sessionKey,
      store,
    ));
    await waitFor(() => expect(getComposeDraft).toHaveBeenCalled());

    act(() => {
      store.getState().setDraftText(sessionKey, "first");
      store.getState().setDraftText(sessionKey, "latest");
    });

    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledWith(
      compose.composeDraftKey("claude", "env-debounce", sessionKey),
      "environment",
      "env-debounce",
      { text: "latest", mentions: [], attachments: [] },
      0,
    ), { timeout: 1_500 });
    expect(saveComposeDraft).toHaveBeenCalledTimes(1);
    act(() => store.getState().setDraftText(sessionKey, ""));
    hook.unmount();
    await waitFor(() => expect(deleteComposeDraft).toHaveBeenCalled());
  });

  test("hydrates valid fields and ignores malformed records", async () => {
    getComposeDraft
      .mockResolvedValueOnce({
        draftKey: "opencode:env-valid:session",
        ownerType: "environment",
        ownerId: "env-valid",
        value: {
          text: "restored",
          mentions: [{
            id: "mention",
            filename: "a.ts",
            relativePath: "src/a.ts",
          }],
          attachments: [{
            id: "image",
            type: "image",
            path: "/workspace/image.png",
            name: "image.png",
          }],
        },
        updatedAt: "2026-07-28T00:00:00.000Z",
        revision: 1,
      })
      .mockResolvedValueOnce({
        draftKey: "opencode:env-invalid:session",
        ownerType: "environment",
        ownerId: "env-invalid",
        value: { text: 42, mentions: null, attachments: "bad" },
        updatedAt: "2026-07-28T00:00:00.000Z",
        revision: 1,
      });
    const valid = createNativeStore();
    const invalid = createNativeStore();
    const validHook = renderHook(() => useNativeComposeDraftPersistence(
      "opencode",
      "env-valid",
      "session",
      valid,
    ));
    const invalidHook = renderHook(() => useNativeComposeDraftPersistence(
      "opencode",
      "env-invalid",
      "session",
      invalid,
    ));

    await waitFor(() => expect(valid.getState().draftText.get("session")).toBe("restored"));
    expect(valid.getState().draftMentions.get("session")).toEqual([{
      id: "mention",
      filename: "a.ts",
      relativePath: "src/a.ts",
    }]);
    expect(valid.getState().attachments.get("session")).toEqual([{
      id: "image",
      type: "image",
      path: "/workspace/image.png",
      name: "image.png",
    }]);
    expect(invalid.getState().draftText.has("session")).toBe(false);

    validHook.unmount();
    invalidHook.unmount();
  });

  for (const namespace of ["claude", "codex", "opencode"] as const) {
    test(`${namespace} drops malformed mention and attachment elements`, async () => {
      getComposeDraft.mockResolvedValueOnce({
        draftKey: `${namespace}:env-elements:session`,
        ownerType: "environment",
        ownerId: "env-elements",
        value: {
          text: "safe text",
          mentions: [
            null,
            "src/a.ts",
            { id: "partial", filename: "missing-path.ts" },
            { id: "valid", filename: "valid.ts", relativePath: "src/valid.ts" },
          ],
          attachments: [
            null,
            42,
            { id: "partial" },
            {
              id: "valid-image",
              type: "image",
              path: "/workspace/image.png",
              name: "image.png",
            },
            {
              id: "file",
              type: "file",
              path: "/workspace/file.txt",
              name: "file.txt",
            },
          ],
        },
        updatedAt: "2026-07-28T00:00:00.000Z",
        revision: 1,
      });
      const store = createNativeStore();
      const hook = renderHook(() => useNativeComposeDraftPersistence(
        namespace,
        "env-elements",
        "session",
        store,
      ));

      await waitFor(() =>
        expect(store.getState().draftText.get("session")).toBe("safe text"),
      );
      expect(store.getState().draftMentions.get("session")).toEqual([{
        id: "valid",
        filename: "valid.ts",
        relativePath: "src/valid.ts",
      }]);
      expect(store.getState().attachments.get("session")).toEqual(
        namespace === "codex"
          ? [{
              id: "valid-image",
              type: "image",
              path: "/workspace/image.png",
              name: "image.png",
            }]
          : [
              {
                id: "valid-image",
                type: "image",
                path: "/workspace/image.png",
                name: "image.png",
              },
              {
                id: "file",
                type: "file",
                path: "/workspace/file.txt",
                name: "file.txt",
              },
            ],
      );
      hook.unmount();
    });
  }
});
