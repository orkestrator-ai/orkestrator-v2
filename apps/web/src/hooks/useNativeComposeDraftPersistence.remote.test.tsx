/**
 * Compose drafts of an environment on another machine: their legacy browser
 * notes are reconciled, and the draft saved, on that machine's backend, never
 * on this window's.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import type { BackendId } from "@orkestrator/protocol/federation";
import { WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT } from "@orkestrator/protocol/web-annotations";
import type { TranscriptAnnotation } from "@/lib/chat/transcript-annotations";
import { awaitComposeDraftWrites, composeDraftKey } from "@/lib/compose-draft-persistence";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { invokeMock } from "@/test/web-annotation-fakes";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../tests/helpers/controlled-timeout";
import {
  NATIVE_COMPOSE_DRAFT_SAVE_DEBOUNCE_MS,
  useNativeComposeDraftPersistence,
} from "./useNativeComposeDraftPersistence";

const ENV = "env-remote";
const SESSION = "env-remote:tab-1";
const legacy: TranscriptAnnotation = {
  id: "legacy-1",
  source: "browser",
  text: "button Save",
  comment: "pad",
};

interface DraftState {
  draftText: Map<string, string>;
  draftMentions: Map<string, unknown[]>;
  attachments: Map<string, Array<{ id: string; annotationId?: string }>>;
  annotations: Map<string, TranscriptAnnotation[]>;
  setDraftText: (key: string, text: string) => void;
  setDraftMentions: (key: string, mentions: unknown[]) => void;
  clearAttachments: (key: string) => void;
  addAttachment: (key: string, attachment: { id: string; annotationId?: string }) => void;
  setAnnotations: (key: string, annotations: TranscriptAnnotation[]) => void;
}

/** A composer store already holding unsaved text and a legacy browser note. */
function dirtyStore() {
  return createStore<DraftState>((set) => ({
    draftText: new Map([[SESSION, "my unsent text"]]),
    draftMentions: new Map(),
    attachments: new Map([
      [SESSION, [{ id: "att-legacy", annotationId: "legacy-1" }, { id: "att-other" }]],
    ]),
    annotations: new Map([[SESSION, [legacy]]]),
    setDraftText: (key, text) =>
      set((state) => ({ draftText: new Map(state.draftText).set(key, text) })),
    setDraftMentions: (key, mentions) =>
      set((state) => ({ draftMentions: new Map(state.draftMentions).set(key, mentions) })),
    clearAttachments: (key) =>
      set((state) => {
        const attachments = new Map(state.attachments);
        attachments.delete(key);
        return { attachments };
      }),
    addAttachment: (key, attachment) =>
      set((state) => ({
        attachments: new Map(state.attachments).set(key, [
          ...(state.attachments.get(key) ?? []),
          attachment,
        ]),
      })),
    setAnnotations: (key, annotations) =>
      set((state) => ({ annotations: new Map(state.annotations).set(key, annotations) })),
  }));
}

describe("compose draft reconciliation on another machine's environment", () => {
  let windowScope: WindowScope;
  let client: FakeNodeClient;
  let localCalls: string[];
  let saved: Array<Record<string, unknown>>;
  let debounce: ControlledTimeout | undefined;
  let scope: NodeScope;

  beforeEach(() => {
    localCalls = [];
    saved = [];
    // This window's own backend answers everything, so a call routed there
    // would succeed silently instead of failing the test.
    invokeMock.mockImplementation(async (command: string) => {
      localCalls.push(command);
      if (command === "web_annotations_reconcile_draft") {
        return { value: null, references: [{ legacyId: "legacy-1", annotationId: "wrong" }] };
      }
      return null;
    });
    client = new FakeNodeClient({ nodeId: "bk_remote-node" as BackendId });
    client.respond("get_compose_draft", null);
    client.respond("save_compose_draft", (args: Readonly<Record<string, unknown>>) => {
      saved.push({ ...args });
      return {
        draftKey: args.draftKey,
        ownerType: args.ownerType,
        ownerId: args.ownerId,
        value: args.value,
        updatedAt: "2026-11-10T00:00:00.000Z",
        revision: saved.length,
      };
    });
    client.respond("delete_compose_draft", undefined);
    windowScope = new WindowScope();
    scope = windowScope.open({ role: "leaf", client });
  });

  afterEach(async () => {
    // Unmounting flushes the draft; let that write reach the fake before the
    // scope (and its client) is disposed.
    cleanup();
    await awaitComposeDraftWrites(composeDraftKey("claude", ENV, SESSION), scope);
    debounce?.restore();
    debounce = undefined;
    windowScope.dispose();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  function render(store: ReturnType<typeof dirtyStore>) {
    return renderHook(() =>
      useNativeComposeDraftPersistence("claude", ENV, SESSION, store, undefined, scope),
    );
  }

  async function fireSave() {
    await waitFor(() => expect(debounce!.pendingCount()).toBe(1));
    await act(async () => {
      debounce!.advance();
      await awaitComposeDraftWrites(composeDraftKey("claude", ENV, SESSION), scope);
    });
  }

  test("references from the owning node replace the note and keep the text", async () => {
    debounce = installControlledTimeout(NATIVE_COMPOSE_DRAFT_SAVE_DEBOUNCE_MS, {
      label: "draft save debounce",
    });
    client.respond(
      "web_annotations_reconcile_draft",
      (args: Readonly<Record<string, unknown>>) => ({
        value: args.value,
        references: [{ legacyId: "legacy-1", annotationId: "annotation-7" }],
        imported: 1,
        failed: [],
      }),
    );
    const store = dirtyStore();
    render(store);

    await waitFor(() =>
      expect(store.getState().annotations.get(SESSION)?.[0]?.migratedTo).toBe("annotation-7"),
    );
    expect(store.getState().annotations.get(SESSION)).toEqual([
      {
        id: "legacy-1",
        source: "browser",
        text: WEB_ANNOTATION_MIGRATED_REFERENCE_TEXT,
        comment: "",
        migratedTo: "annotation-7",
      },
    ]);
    expect(store.getState().attachments.get(SESSION)).toEqual([{ id: "att-other" }]);
    expect(store.getState().draftText.get(SESSION)).toBe("my unsent text");
    expect(client.calls("web_annotations_reconcile_draft")[0]!.args).toMatchObject({
      environmentId: ENV,
      value: { text: "my unsent text", annotations: [legacy] },
    });

    await fireSave();
    expect(saved.at(-1)).toMatchObject({
      ownerId: ENV,
      value: {
        text: "my unsent text",
        annotations: [{ id: "legacy-1", migratedTo: "annotation-7" }],
      },
    });
    expect(localCalls).toEqual([]);
  });

  test("a failure on the owning node keeps the draft as typed", async () => {
    client.respond("web_annotations_reconcile_draft", () => {
      throw new Error("Gateway disconnected");
    });
    const store = dirtyStore();
    render(store);

    await waitFor(() => expect(client.calls("web_annotations_reconcile_draft")).toHaveLength(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(store.getState().draftText.get(SESSION)).toBe("my unsent text");
    expect(store.getState().annotations.get(SESSION)).toEqual([legacy]);
    expect(store.getState().attachments.get(SESSION)).toEqual([
      { id: "att-legacy", annotationId: "legacy-1" },
      { id: "att-other" },
    ]);
    expect(localCalls).toEqual([]);
  });
});
