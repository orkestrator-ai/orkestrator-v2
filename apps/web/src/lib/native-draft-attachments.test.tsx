/**
 * Draft attachment restoration against the shared capability table (INC-06).
 *
 * Expectations for native platforms are generated from
 * `nativeAgentCapabilities`, the single table the composer and send path use,
 * so a capability change cannot leave restoration behind again. Cursor and
 * Grok also carry explicit literal regressions: their images were once dropped
 * on every reload by a private copy of the rule.
 *
 * Hook tests drive the real native compose store through its two persistence
 * adapters (assigned tab and unassigned tab) and assert on the backend write
 * payload, not only on in-memory state. Reconciliation and dispatch cases
 * render the real unassigned composer, which owns the capability effect.
 *
 * Debounced saves are driven deterministically: the hook's own save timers are
 * captured and fired on demand, and "no further writes" means no save timer is
 * left pending once every queued write for the key has settled — nothing
 * remains that could write, rather than nothing happened to write within an
 * arbitrary sleep.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { nativeAgentCapabilities, type AgentModel } from "@orkestrator/protocol/native-agent";
import * as realBackend from "@/lib/backend";
import { createSessionKey } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { mockToastError as toastError } from "../../../../tests/mocks/sonner";

const realBackendSnapshot = { ...realBackend };
const saveComposeDraft = mock(async (..._args: unknown[]): Promise<unknown> => undefined);
const deleteComposeDraft = mock(async (..._args: unknown[]): Promise<void> => undefined);
const getComposeDraft = mock(
  async (
    ..._args: Parameters<typeof realBackend.getComposeDraft>
  ): Promise<Awaited<ReturnType<typeof realBackend.getComposeDraft>>> => null,
);
const getNativeAgentModelCatalog = mock(
  async (
    _environmentId: string,
    _ensureAgent?: "cursor" | "grok" | "pi",
  ): Promise<AgentModel[]> => [],
);
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  saveComposeDraft,
  deleteComposeDraft,
  getComposeDraft,
  getNativeAgentModelCatalog,
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
}));

const { awaitComposeDraftWrites, composeDraftKey } = await import("./compose-draft-persistence");
const { draftAttachmentPolicy, isPersistedDraftAttachment, restorableDraftAttachments } =
  await import("./native-draft-attachments");
const { NATIVE_COMPOSE_DRAFT_SAVE_DEBOUNCE_MS, useNativeComposeDraftPersistence } =
  await import("../hooks/useNativeComposeDraftPersistence");
const {
  nativeComposePersistenceStore,
  unassignedNativeComposePersistenceStore,
  useNativeComposeStore,
} = await import("../stores/nativeComposeStore");
const { UnassignedNativeAgentComposer } =
  await import("../components/native-agent/AgentNativeTab.helpers");

type StoredDraft = Awaited<ReturnType<typeof realBackend.getComposeDraft>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const file = {
  id: "file-1",
  type: "file" as const,
  path: "/workspace/notes.md",
  name: "notes.md",
};
const image = {
  id: "image-1",
  type: "image" as const,
  path: "/workspace/.orkestrator/attachments/shot.png",
  name: "shot.png",
  previewUrl: "/workspace/.orkestrator/attachments/shot.png",
  annotationId: "annotation-7",
};
const secondImage = {
  id: "image-2",
  type: "image" as const,
  path: "/workspace/diagram.png",
  name: "diagram.png",
};

/** Expected survivors computed from the capability table, not a second copy of it. */
function expectedFor(platform: AgentPlatform, stored: ReadonlyArray<typeof file | typeof image>) {
  const { files, images } = nativeAgentCapabilities(platform).attachments;
  return stored.filter((entry) => (entry.type === "image" ? images : files));
}

function storedDraft(
  namespace: string,
  environmentId: string,
  sessionKey: string,
  value: Record<string, unknown>,
  revision = 1,
): NonNullable<StoredDraft> {
  return {
    draftKey: composeDraftKey(namespace, environmentId, sessionKey),
    ownerType: "environment",
    ownerId: environmentId,
    value,
    updatedAt: "2026-09-26T00:00:00.000Z",
    revision,
  };
}

/** Route reads by key so primary/fallback lookups get exactly what a test stored. */
function serveDrafts(records: Record<string, StoredDraft | Promise<StoredDraft>>): void {
  getComposeDraft.mockImplementation(async (draftKey: string) => (await records[draftKey]) ?? null);
}

function saveCallsFor(key: string): unknown[][] {
  return saveComposeDraft.mock.calls.filter((call) => call[0] === key);
}

function savedAttachments(call: unknown[] | undefined): unknown {
  return (call?.[3] as { attachments?: unknown } | undefined)?.attachments;
}

function draftAttachmentsOf(sessionKey: string) {
  return useNativeComposeStore.getState().drafts.get(sessionKey)?.attachments;
}

/**
 * Captures the persistence hook's debounced save timers so a test can fire
 * them on demand instead of sleeping past the debounce window.
 *
 * Only timers armed with the hook's own delay are intercepted; everything else
 * (Testing Library's polling, Radix) keeps the real clock.
 */
function captureDraftSaveTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Map<unknown, () => void>();
  globalThis.setTimeout = ((handler: unknown, delay?: number, ...args: unknown[]) => {
    if (delay !== NATIVE_COMPOSE_DRAFT_SAVE_DEBOUNCE_MS || typeof handler !== "function") {
      return realSetTimeout(handler as TimerHandler, delay, ...args);
    }
    // The real timer is never allowed to fire: only `settle` runs these, so a
    // save cannot land between two assertions on its own schedule.
    const id = realSetTimeout(() => undefined, 2 ** 31 - 1);
    pending.set(id, () => (handler as (...values: unknown[]) => void)(...args));
    return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(id);
    realClearTimeout(id);
  }) as typeof clearTimeout;
  return {
    pendingCount: () => pending.size,
    /**
     * Fire due saves until none is re-armed, awaiting the write chain between
     * rounds. Returns how many saves fired. A save that keeps re-arming itself
     * is an effect loop and fails loudly rather than spinning.
     */
    async settle(draftKey: string): Promise<number> {
      let fired = 0;
      for (let round = 0; round < 5; round += 1) {
        await act(async () => {
          await awaitComposeDraftWrites(draftKey);
        });
        const due = Array.from(pending.entries());
        if (due.length === 0) return fired;
        fired += due.length;
        await act(async () => {
          for (const [id, run] of due) {
            pending.delete(id);
            realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
            run();
          }
          await awaitComposeDraftWrites(draftKey);
        });
      }
      throw new Error(`Draft saves for ${draftKey} kept re-arming: effect loop`);
    },
    restore() {
      for (const id of pending.keys()) realClearTimeout(id as Parameters<typeof clearTimeout>[0]);
      pending.clear();
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

let saveTimers: ReturnType<typeof captureDraftSaveTimers> | undefined;
let configSnapshot: ReturnType<typeof useConfigStore.getState>["config"];

beforeEach(() => {
  cleanup();
  configSnapshot = useConfigStore.getState().config;
  for (const fn of [saveComposeDraft, deleteComposeDraft, getComposeDraft]) fn.mockReset();
  getNativeAgentModelCatalog.mockReset();
  getNativeAgentModelCatalog.mockImplementation(async () => []);
  toastError.mockClear();
  saveComposeDraft.mockImplementation(async () => undefined);
  deleteComposeDraft.mockImplementation(async () => undefined);
  getComposeDraft.mockImplementation(async () => null);
  useNativeComposeStore.setState({ drafts: new Map() });
});

afterEach(() => {
  cleanup();
  saveTimers?.restore();
  saveTimers = undefined;
  useConfigStore.getState().setConfig(configSnapshot);
});

afterAll(() => {
  cleanup();
  useNativeComposeStore.setState({ drafts: new Map() });
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

describe("draftAttachmentPolicy", () => {
  for (const platform of AGENT_PLATFORMS) {
    test(`${platform} resolves to the shared capability row, assigned or saved`, () => {
      const shared = nativeAgentCapabilities(platform).attachments;
      expect(draftAttachmentPolicy(platform, undefined)).toEqual({
        kind: "platform",
        platform,
        attachments: shared,
      });
      // A known saved platform must have the same eligibility as an assigned tab.
      expect(draftAttachmentPolicy("agent-native", { platform })).toEqual(
        draftAttachmentPolicy(platform, undefined),
      );
    });
  }

  test("an assigned namespace ignores saved metadata naming another platform", () => {
    expect(draftAttachmentPolicy("codex", { platform: "pi" })).toMatchObject({
      platform: "codex",
      attachments: nativeAgentCapabilities("codex").attachments,
    });
  });

  test("claude-tmux keeps its own legacy terminal contract", () => {
    expect(draftAttachmentPolicy("claude-tmux", { platform: "codex" })).toEqual({
      kind: "legacy-terminal",
      attachments: { files: true, images: true },
    });
  });

  test("missing or unknown saved metadata is undecided, not a guessed platform", () => {
    for (const metadata of [
      undefined,
      null,
      "cursor",
      ["cursor"],
      {},
      { platform: 42 },
      { platform: "gpt-9" },
      { platform: "__proto__" },
      { platform: "toString" },
      { platform: "claude-tmux" },
      { platform: "agent-native" },
    ]) {
      expect(draftAttachmentPolicy("agent-native", metadata)).toEqual({ kind: "undecided" });
    }
  });
});

describe("restorableDraftAttachments", () => {
  test("Cursor and Grok keep images and drop files (explicit regression)", () => {
    // Pinned literally as well as generated below: the old validator returned
    // `false` for every Cursor/Grok attachment regardless of type.
    expect(nativeAgentCapabilities("cursor").attachments).toEqual({ files: false, images: true });
    expect(nativeAgentCapabilities("grok").attachments).toEqual({ files: false, images: true });
    for (const platform of ["cursor", "grok"] as const) {
      expect(restorableDraftAttachments(platform, undefined, [file, image])).toEqual([image]);
      expect(restorableDraftAttachments("agent-native", { platform }, [file, image])).toEqual([
        image,
      ]);
    }
  });

  for (const platform of AGENT_PLATFORMS) {
    test(`${platform} follows its capability row in original order`, () => {
      const stored = [image, file, secondImage];
      const expected = stored.filter((entry) =>
        entry.type === "image"
          ? nativeAgentCapabilities(platform).attachments.images
          : nativeAgentCapabilities(platform).attachments.files,
      );
      expect(restorableDraftAttachments(platform, undefined, stored)).toEqual(expected);
      expect(restorableDraftAttachments("agent-native", { platform }, stored)).toEqual(expected);
    });
  }

  test("drops malformed entries before consulting capabilities, keeping order", () => {
    const stored: unknown[] = [
      secondImage,
      null,
      42,
      "image.png",
      [image],
      { id: "partial" },
      { ...image, id: "no-path", path: undefined },
      { ...image, id: "video", type: "video" },
      { ...image, id: "untyped", type: undefined },
      { ...image, id: "bad-preview", previewUrl: 42 },
      { ...image, id: "bad-annotation", annotationId: {} },
      { ...image, id: 7 },
      file,
      image,
    ];
    expect(restorableDraftAttachments("cursor", undefined, stored)).toEqual([secondImage, image]);
    expect(restorableDraftAttachments("claude", undefined, stored)).toEqual([
      secondImage,
      file,
      image,
    ]);
    // Undecided content is preserved provisionally, but never malformed content.
    expect(restorableDraftAttachments("agent-native", undefined, stored)).toEqual([
      secondImage,
      file,
      image,
    ]);
  });

  test("preserves the original records: ids, paths, preview and annotation references", () => {
    const withExtra = { ...image, extra: "kept verbatim" };
    const [restored] = restorableDraftAttachments("grok", undefined, [withExtra]);
    expect(restored).toBe(withExtra);
    expect(isPersistedDraftAttachment(withExtra)).toBe(true);
  });

  test("undecided drafts keep every structurally valid type provisionally", () => {
    for (const metadata of [undefined, { platform: "gpt-9" }, "junk", { modelId: "m" }]) {
      expect(restorableDraftAttachments("agent-native", metadata, [file, image])).toEqual([
        file,
        image,
      ]);
    }
  });

  test("restoration never consults model metadata", () => {
    // A text-only or unknown model is a send-time incompatibility the composer
    // explains; restoring must not destroy the image while the catalogue loads.
    expect(
      restorableDraftAttachments(
        "agent-native",
        { platform: "cursor", modelId: "text-only-model-without-vision" },
        [image],
      ),
    ).toEqual([image]);
  });

  test("an assigned tab adopting a fallback record is not broadened by its metadata", () => {
    expect(restorableDraftAttachments("codex", { platform: "pi" }, [file, image])).toEqual([image]);
  });

  test("claude-tmux restores both kinds regardless of saved metadata", () => {
    expect(restorableDraftAttachments("claude-tmux", { platform: "codex" }, [file, image])).toEqual(
      [file, image],
    );
  });
});

describe("useNativeComposeDraftPersistence attachment restoration", () => {
  for (const platform of ["cursor", "grok"] as const) {
    test(`an assigned ${platform} tab restores its image and re-saves it`, async () => {
      const environmentId = `env-assigned-${platform}`;
      const sessionKey = `${environmentId}:tab`;
      const key = composeDraftKey(platform, environmentId, sessionKey);
      serveDrafts({
        [key]: storedDraft(platform, environmentId, sessionKey, {
          text: "look at this",
          mentions: [],
          attachments: [file, image],
        }),
      });
      const hook = renderHook(() =>
        useNativeComposeDraftPersistence(
          platform,
          environmentId,
          sessionKey,
          nativeComposePersistenceStore,
          "agent-native",
        ),
      );

      await waitFor(() => expect(draftAttachmentsOf(sessionKey)).toEqual([image]));
      // Hydration's autosave must publish the recovered image, not a filtered
      // empty list, against the hydrated revision.
      await waitFor(() => expect(saveCallsFor(key)).toHaveLength(1));
      const [call] = saveCallsFor(key);
      expect(call?.slice(0, 3)).toEqual([key, "environment", environmentId]);
      expect(call?.[3]).toMatchObject({ text: "look at this", attachments: [image] });
      expect(call?.[4]).toBe(1);
      expect(deleteComposeDraft).not.toHaveBeenCalled();
      hook.unmount();
    });
  }

  for (const platform of AGENT_PLATFORMS) {
    test(`an unassigned draft saved for ${platform} restores and re-saves its eligible attachments`, async () => {
      const environmentId = `env-unassigned-${platform}`;
      const sessionKey = `${environmentId}:tab`;
      const key = composeDraftKey("agent-native", environmentId, sessionKey);
      const expected = expectedFor(platform, [file, image]);
      serveDrafts({
        [key]: storedDraft("agent-native", environmentId, sessionKey, {
          text: "provisional",
          mentions: [],
          attachments: [file, image],
          metadata: { platform, fastMode: false, mode: "build" },
        }),
      });
      const hook = renderHook(() =>
        useNativeComposeDraftPersistence(
          "agent-native",
          environmentId,
          sessionKey,
          unassignedNativeComposePersistenceStore,
        ),
      );

      await waitFor(() => expect(saveCallsFor(key)).toHaveLength(1));
      expect(draftAttachmentsOf(sessionKey)).toEqual(expected);
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.platform).toBe(platform);
      const [call] = saveCallsFor(key);
      expect(savedAttachments(call)).toEqual(expected);
      expect(call?.[3]).toMatchObject({ metadata: { platform } });
      expect(call?.[4]).toBe(1);
      hook.unmount();
    });

    test(`an assigned ${platform} tab adopting the provisional record applies its own row`, async () => {
      const environmentId = `env-adopt-${platform}`;
      const sessionKey = `${environmentId}:tab`;
      const key = composeDraftKey(platform, environmentId, sessionKey);
      const fallbackKey = composeDraftKey("agent-native", environmentId, sessionKey);
      const expected = expectedFor(platform, [file, image]);
      serveDrafts({
        [fallbackKey]: storedDraft("agent-native", environmentId, sessionKey, {
          text: "first prompt",
          mentions: [],
          attachments: [file, image],
          metadata: { platform, fastMode: false, mode: "build" },
        }),
      });
      const hook = renderHook(() =>
        useNativeComposeDraftPersistence(
          platform,
          environmentId,
          sessionKey,
          nativeComposePersistenceStore,
          "agent-native",
        ),
      );

      // The adopted content is written under the assigned tab's own key.
      await waitFor(() => expect(saveCallsFor(key)).toHaveLength(1));
      expect(draftAttachmentsOf(sessionKey)).toEqual(expected);
      expect(savedAttachments(saveCallsFor(key)[0])).toEqual(expected);
      hook.unmount();
    });
  }

  test("an attachment-only Cursor draft is restored and re-saved, not deleted", async () => {
    const environmentId = "env-attachment-only";
    const sessionKey = `${environmentId}:tab`;
    const key = composeDraftKey("cursor", environmentId, sessionKey);
    serveDrafts({
      [key]: storedDraft("cursor", environmentId, sessionKey, {
        text: "",
        mentions: [],
        attachments: [image],
      }),
    });
    const hook = renderHook(() =>
      useNativeComposeDraftPersistence(
        "cursor",
        environmentId,
        sessionKey,
        nativeComposePersistenceStore,
      ),
    );

    await waitFor(() => expect(saveCallsFor(key)).toHaveLength(1));
    expect(savedAttachments(saveCallsFor(key)[0])).toEqual([image]);
    expect(deleteComposeDraft).not.toHaveBeenCalled();
    hook.unmount();
    // The visibility unmount flushes the same non-empty draft rather than deleting it.
    await waitFor(() => expect(saveCallsFor(key)).toHaveLength(2));
    expect(savedAttachments(saveCallsFor(key)[1])).toEqual([image]);
    expect(deleteComposeDraft).not.toHaveBeenCalled();
  });

  test("an attachment added while a fallback read is pending wins over the late snapshot", async () => {
    const environmentId = "env-race";
    const sessionKey = `${environmentId}:tab`;
    const key = composeDraftKey("grok", environmentId, sessionKey);
    const fallbackKey = composeDraftKey("agent-native", environmentId, sessionKey);
    const fallback = deferred<StoredDraft>();
    serveDrafts({ [key]: null, [fallbackKey]: fallback.promise });
    const hook = renderHook(() =>
      useNativeComposeDraftPersistence(
        "grok",
        environmentId,
        sessionKey,
        nativeComposePersistenceStore,
        "agent-native",
      ),
    );
    await waitFor(() => expect(getComposeDraft).toHaveBeenCalledWith(fallbackKey));

    act(() =>
      useNativeComposeStore.getState().updateDraft(sessionKey, { attachments: [secondImage] }),
    );
    fallback.resolve(
      storedDraft("agent-native", environmentId, sessionKey, {
        text: "older saved text",
        mentions: [],
        attachments: [image],
        metadata: { platform: "grok" },
      }),
    );

    await waitFor(() => expect(saveCallsFor(key)).toHaveLength(1));
    expect(draftAttachmentsOf(sessionKey)).toEqual([secondImage]);
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.text).toBe("");
    expect(savedAttachments(saveCallsFor(key)[0])).toEqual([secondImage]);
    hook.unmount();
  });

  test("a conflicting autosave keeps the restored image until the user chooses Save mine", async () => {
    const environmentId = "env-conflict";
    const sessionKey = `${environmentId}:tab`;
    const key = composeDraftKey("cursor", environmentId, sessionKey);
    const stored = storedDraft("cursor", environmentId, sessionKey, {
      text: "mine",
      mentions: [],
      attachments: [image],
    });
    getComposeDraft
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce({ ...stored, value: { text: "theirs" }, revision: 2 });
    saveComposeDraft
      .mockRejectedValueOnce(new Error("Compose draft revision conflict"))
      .mockResolvedValueOnce({ ...stored, revision: 3 });
    const hook = renderHook(() =>
      useNativeComposeDraftPersistence(
        "cursor",
        environmentId,
        sessionKey,
        nativeComposePersistenceStore,
      ),
    );

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // No automatic overwrite: one rejected write, the image still in the composer.
    expect(saveComposeDraft).toHaveBeenCalledTimes(1);
    expect(draftAttachmentsOf(sessionKey)).toEqual([image]);
    const options = toastError.mock.calls.at(-1)?.[1] as { action?: { onClick?: () => void } };
    expect(typeof options.action?.onClick).toBe("function");

    act(() => options.action?.onClick?.());
    await waitFor(() => expect(saveComposeDraft).toHaveBeenCalledTimes(2));
    expect(saveCallsFor(key).map((call) => call[4])).toEqual([1, 2]);
    expect(saveComposeDraft.mock.calls.map((call) => savedAttachments(call as unknown[]))).toEqual([
      [image],
      [image],
    ]);
    hook.unmount();
  });

  test("an undecided draft with unreadable metadata keeps its content for the composer", async () => {
    const environmentId = "env-undecided";
    const sessionKey = `${environmentId}:tab`;
    const key = composeDraftKey("agent-native", environmentId, sessionKey);
    serveDrafts({
      [key]: storedDraft("agent-native", environmentId, sessionKey, {
        text: "not yet assigned",
        mentions: [],
        attachments: [file, { ...image, previewUrl: 42 }, secondImage],
        metadata: { platform: "gpt-9" },
      }),
    });
    const hook = renderHook(() =>
      useNativeComposeDraftPersistence(
        "agent-native",
        environmentId,
        sessionKey,
        unassignedNativeComposePersistenceStore,
      ),
    );

    await waitFor(() => expect(saveCallsFor(key)).toHaveLength(1));
    expect(draftAttachmentsOf(sessionKey)).toEqual([file, secondImage]);
    // The unknown platform is not adopted, so nothing claims a capability.
    expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.platform).toBeUndefined();
    expect(savedAttachments(saveCallsFor(key)[0])).toEqual([file, secondImage]);
    hook.unmount();
  });

  test("the legacy tmux namespace restores files and images", async () => {
    const environmentId = "env-tmux";
    const sessionKey = `${environmentId}:tab`;
    const key = composeDraftKey("claude-tmux", environmentId, sessionKey);
    serveDrafts({
      [key]: storedDraft("claude-tmux", environmentId, sessionKey, {
        text: "terminal",
        mentions: [],
        attachments: [file, image],
      }),
    });
    const hook = renderHook(() =>
      useNativeComposeDraftPersistence(
        "claude-tmux",
        environmentId,
        sessionKey,
        nativeComposePersistenceStore,
      ),
    );

    await waitFor(() => expect(saveCallsFor(key)).toHaveLength(1));
    expect(savedAttachments(saveCallsFor(key)[0])).toEqual([file, image]);
    hook.unmount();
  });
});

describe("UnassignedNativeAgentComposer draft restoration", () => {
  const environmentId = "env-composer";
  const codexModel: AgentModel = { platform: "codex", id: "gpt-5.4", label: "GPT-5.4" };
  const piModel: AgentModel = { platform: "pi", id: "pi-model", label: "Pi Model" };

  /** Backend drafts that advance their revision like the real store. */
  function persistDraftsInMemory(records: Map<string, NonNullable<StoredDraft>>): void {
    getComposeDraft.mockImplementation(async (draftKey: string) => records.get(draftKey) ?? null);
    saveComposeDraft.mockImplementation(async (...args: unknown[]) => {
      const [draftKey, ownerType, ownerId, value] = args as [
        string,
        "environment",
        string,
        unknown,
      ];
      const saved = {
        draftKey,
        ownerType,
        ownerId,
        value,
        updatedAt: "2026-09-26T00:00:01.000Z",
        revision: (records.get(draftKey)?.revision ?? 0) + 1,
      };
      records.set(draftKey, saved);
      return saved;
    });
  }

  /**
   * Every attachment list the store published for one draft once hydration
   * had added the whole restored list, in order. Earlier entries are
   * hydration's own clear-and-add steps, not reconciliation.
   */
  function recordAttachmentHistory(sessionKey: string, restored: readonly unknown[]) {
    const history: unknown[][] = [];
    const unsubscribe = useNativeComposeStore.subscribe((state, previous) => {
      const current = state.drafts.get(sessionKey)?.attachments;
      if (current && current !== previous.drafts.get(sessionKey)?.attachments) {
        history.push(current);
      }
    });
    const sinceRestore = () => {
      const index = history.findIndex(
        (entry) =>
          entry.length === restored.length &&
          entry.every((attachment, position) => attachment === restored[position]),
      );
      return index === -1 ? [] : history.slice(index);
    };
    return { sinceRestore, unsubscribe };
  }

  function renderComposer(tabId: string, onSend = mock((..._args: unknown[]) => undefined)) {
    const view = render(
      <UnassignedNativeAgentComposer
        tabId={tabId}
        environmentId={environmentId}
        disabled={false}
        onSend={onSend}
      />,
    );
    return { ...view, onSend };
  }

  for (const [label, metadata] of [
    ["missing", undefined],
    ["unreadable", { platform: "gpt-9", fastMode: false, mode: "build" }],
  ] as const) {
    test(`an undecided draft with ${label} metadata is reconciled once for the default provider after hydration`, async () => {
      // Codex is image-only, so the restored file cannot be dispatched to it.
      useConfigStore.getState().updateGlobalConfig({
        enabledAgentPlatforms: ["claude", "codex", "pi"],
        agentSettings: { defaultAgent: "codex" },
      } as never);
      const tabId = `tab-undecided-${label}`;
      const sessionKey = createSessionKey(environmentId, tabId);
      const key = composeDraftKey("agent-native", environmentId, sessionKey);
      const records = new Map([
        [
          key,
          storedDraft("agent-native", environmentId, sessionKey, {
            text: "restore me",
            mentions: [],
            attachments: [file, image],
            ...(metadata ? { metadata } : {}),
          }),
        ],
      ]);
      persistDraftsInMemory(records);
      saveTimers = captureDraftSaveTimers();
      const attachmentHistory = recordAttachmentHistory(sessionKey, [file, image]);

      const { onSend } = renderComposer(tabId);

      await waitFor(() => expect(draftAttachmentsOf(sessionKey)).toEqual([image]));
      await waitFor(() => expect(saveTimers?.pendingCount()).toBe(1));
      // Restoration keeps the undecided draft whole; the composer's existing
      // capability reconciliation then removes the file exactly once.
      expect(attachmentHistory.sinceRestore()).toEqual([[file, image], [image]]);
      expect(await saveTimers!.settle(key)).toBe(1);
      expect(saveCallsFor(key)).toHaveLength(1);
      expect(savedAttachments(saveCallsFor(key)[0])).toEqual([image]);
      expect(saveCallsFor(key)[0]?.[4]).toBe(1);
      expect(records.get(key)?.revision).toBe(2);
      // Nothing is left armed: no follow-up write and no effect loop.
      expect(saveTimers!.pendingCount()).toBe(0);
      expect(attachmentHistory.sinceRestore()).toHaveLength(2);

      // Dispatch is not broadened by the missing metadata: the file is not sent.
      fireEvent.click(screen.getByTitle("Start agent"));
      expect(onSend).toHaveBeenCalledTimes(1);
      const [platform, prompt] = onSend.mock.calls[0] as [AgentPlatform, string];
      expect(platform).toBe("codex");
      expect(prompt).toContain(image.path);
      expect(prompt).not.toContain(file.path);
      attachmentHistory.unsubscribe();
    });
  }

  test("a platform change after restore reconciles exactly once and writes once", async () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex", "pi"],
      favoriteModels: [{ platform: "codex", modelId: codexModel.id }],
      agentSettings: { defaultAgent: "claude" },
    } as never);
    getNativeAgentModelCatalog.mockImplementation(async () => [codexModel, piModel]);
    const tabId = "tab-switch";
    const sessionKey = createSessionKey(environmentId, tabId);
    const key = composeDraftKey("agent-native", environmentId, sessionKey);
    const records = new Map([
      [
        key,
        storedDraft("agent-native", environmentId, sessionKey, {
          text: "switch me",
          mentions: [],
          attachments: [file, image],
          metadata: { platform: "pi", fastMode: false, mode: "build" },
        }),
      ],
    ]);
    persistDraftsInMemory(records);
    saveTimers = captureDraftSaveTimers();
    const attachmentHistory = recordAttachmentHistory(sessionKey, [file, image]);

    renderComposer(tabId);
    await waitFor(() => expect(saveTimers?.pendingCount()).toBe(1));
    expect(await saveTimers!.settle(key)).toBe(1);
    // Pi accepts files, so the restore-time reconciliation had nothing to do.
    expect(savedAttachments(saveCallsFor(key)[0])).toEqual([file, image]);
    expect(attachmentHistory.sinceRestore()).toEqual([[file, image]]);
    await waitFor(() =>
      expect(document.querySelector("[data-native-model-platform='pi']")).toBeTruthy(),
    );

    // Switch to Codex through the real picker.
    fireEvent.pointerDown(await screen.findByTitle(/^Choose /));
    fireEvent.click(await screen.findByRole("button", { name: "Favorite models" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /GPT-5\.4/ }));
    await waitFor(() =>
      expect(useNativeComposeStore.getState().drafts.get(sessionKey)?.platform).toBe("codex"),
    );

    expect(draftAttachmentsOf(sessionKey)).toEqual([image]);
    // One filtering step for the switch; the capability effect that follows
    // finds nothing left to remove.
    expect(attachmentHistory.sinceRestore()).toEqual([[file, image], [image]]);
    expect(await saveTimers!.settle(key)).toBe(1);
    expect(saveCallsFor(key)).toHaveLength(2);
    expect(savedAttachments(saveCallsFor(key)[1])).toEqual([image]);
    expect(saveCallsFor(key)[1]?.[3]).toMatchObject({ metadata: { platform: "codex" } });
    expect(saveCallsFor(key)[1]?.[4]).toBe(2);
    expect(saveTimers!.pendingCount()).toBe(0);
    expect(attachmentHistory.sinceRestore()).toHaveLength(2);
    attachmentHistory.unsubscribe();
  });

  test("an unavailable model catalogue neither destroys the image nor broadens dispatch", async () => {
    useConfigStore.getState().updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex", "cursor"],
      agentSettings: { defaultAgent: "claude" },
    } as never);
    getNativeAgentModelCatalog.mockImplementation(async () => {
      throw new Error("bridge unavailable");
    });
    const tabId = "tab-no-catalog";
    const sessionKey = createSessionKey(environmentId, tabId);
    const key = composeDraftKey("agent-native", environmentId, sessionKey);
    const records = new Map([
      [
        key,
        storedDraft("agent-native", environmentId, sessionKey, {
          text: "",
          mentions: [],
          // Malformed optional fields are dropped; the file is not Cursor's.
          attachments: [file, { ...secondImage, previewUrl: 42 }, image],
          metadata: { platform: "cursor", modelId: "text-only-model", fastMode: false },
        }),
      ],
    ]);
    persistDraftsInMemory(records);
    saveTimers = captureDraftSaveTimers();

    const { onSend } = renderComposer(tabId);
    await waitFor(() => expect(saveTimers?.pendingCount()).toBe(1));
    // Cursor's first-use catalogue request and its single automatic retry both fail.
    const cursorCatalogRequests = () =>
      getNativeAgentModelCatalog.mock.calls.filter((call) => call[1] === "cursor").length;
    await waitFor(() => expect(cursorCatalogRequests()).toBe(2));
    expect(await saveTimers!.settle(key)).toBe(1);
    expect(draftAttachmentsOf(sessionKey)).toEqual([image]);
    expect(savedAttachments(saveCallsFor(key)[0])).toEqual([image]);
    expect(saveTimers!.pendingCount()).toBe(0);

    // An attachment-only draft is sendable, and only the eligible image goes.
    fireEvent.click(screen.getByTitle("Start agent"));
    expect(onSend).toHaveBeenCalledTimes(1);
    const [platform, prompt, options] = onSend.mock.calls[0] as [
      AgentPlatform,
      string,
      { modelId?: string },
    ];
    expect(platform).toBe("cursor");
    expect(prompt).toContain(image.path);
    expect(prompt).not.toContain(file.path);
    expect(prompt).not.toContain(secondImage.path);
    // No catalogue, so no model is claimed on the user's behalf.
    expect(options.modelId).toBeUndefined();
  });
});
