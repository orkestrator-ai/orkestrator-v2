import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useLayoutEffect, useRef } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { FIXTURE_TIME } from "@orkestrator/protocol/web-annotations-fixtures";
import {
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import { DRAFT_AUTOSAVE_MS, useAnnotationDraft } from "./useAnnotationDraft";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;
const SETTLE = { timeout: DRAFT_AUTOSAVE_MS * 3 };

function renderDraft(editorId = "editor-1") {
  return renderHook(
    ({ editorId }: { editorId: string }) =>
      useAnnotationDraft({
        environmentId: "env-1",
        editorId,
        context: { pendingCaptureId: "cap-1" },
        enabled: true,
      }),
    { initialProps: { editorId } },
  );
}

function seedDraft(editorId: string, text: string, revision: number) {
  backend.drafts.set(editorId, {
    id: `draft-${editorId}`,
    environmentId: "env-1",
    editorId,
    revision,
    annotationId: null,
    captureId: null,
    pendingCaptureId: "cap-1",
    text,
    operation: null,
    destination: null,
    updatedAt: FIXTURE_TIME,
  });
}

describe("useAnnotationDraft", () => {
  beforeEach(() => {
    window.localStorage.clear();
    bus = installFakeOrkestrator();
    backend = new FakeWebAnnotationBackend("env-1").install();
  });
  afterEach(() => {
    cleanup();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("debounces typing into one revision-checked autosave", async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.status).toBe("idle"));
    act(() => result.current.setText("G"));
    act(() => result.current.setText("Gi"));
    act(() => result.current.setText("Give it room"));
    expect(result.current.status).toBe("dirty");
    expect(backend.callsOf("web_annotation_draft_save")).toHaveLength(0);

    await waitFor(() => expect(result.current.status).toBe("saved"), SETTLE);
    const saves = backend.callsOf("web_annotation_draft_save");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.args).toMatchObject({
      editorId: "editor-1",
      expectedRevision: 0,
      text: "Give it room",
      pendingCaptureId: "cap-1",
    });
    expect(result.current.draftId).toBe("draft-editor-1");

    // The next autosave carries the revision the first one returned.
    act(() => result.current.setText("Give it more room"));
    await waitFor(
      () => expect(backend.callsOf("web_annotation_draft_save")).toHaveLength(2),
      SETTLE,
    );
    expect(backend.callsOf("web_annotation_draft_save")[1]!.args.expectedRevision).toBe(1);
  });

  test("hydrates a saved draft into an untouched editor", async () => {
    seedDraft("editor-1", "Saved earlier", 3);
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(result.current.text).toBe("Saved earlier");
    expect(result.current.draftId).toBe("draft-editor-1");
  });

  test("hydration never overwrites typed text and surfaces a conflict instead", async () => {
    seedDraft("editor-1", "Server version", 2);
    const hold = backend.hold("web_annotation_draft_get");
    const { result } = renderDraft();
    act(() => result.current.setText("Typed first"));
    hold.release();

    await waitFor(() => expect(result.current.status).toBe("conflict"));
    expect(result.current.text).toBe("Typed first");
    expect(result.current.conflict).toEqual({
      local: "Typed first",
      server: "Server version",
      serverRevision: 2,
    });
    // An open conflict blocks autosave.
    await new Promise((resolve) => setTimeout(resolve, DRAFT_AUTOSAVE_MS + 100));
    expect(backend.callsOf("web_annotation_draft_save")).toHaveLength(0);

    act(() => result.current.resolveConflict("keep-local"));
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(backend.callsOf("web_annotation_draft_save")[0]!.args).toMatchObject({
      expectedRevision: 2,
      text: "Typed first",
    });
    expect(backend.drafts.get("editor-1")?.text).toBe("Typed first");
  });

  test("keeps text typed before the editor's identity effect ran (flake 0161)", async () => {
    // A keystroke can arrive after the editor's first commit but before its
    // passive effects; React then flushes the identity effect at the start of
    // the keystroke's own render. A layout effect lands in exactly that
    // window, deterministically.
    const { result } = renderHook(() => {
      const draft = useAnnotationDraft({
        environmentId: "env-1",
        editorId: "editor-1",
        context: { pendingCaptureId: "cap-1" },
        enabled: true,
      });
      const typed = useRef(false);
      useLayoutEffect(() => {
        if (typed.current) return;
        typed.current = true;
        draft.setText("Typed early");
      });
      return draft;
    });

    expect(result.current.text).toBe("Typed early");
    expect(result.current.readText()).toBe("Typed early");
    await waitFor(() => expect(result.current.status).toBe("saved"), SETTLE);
    expect(backend.callsOf("web_annotation_draft_save")[0]!.args).toMatchObject({
      editorId: "editor-1",
      expectedRevision: 0,
      text: "Typed early",
    });
  });

  test("choosing the other version discards local text without saving", async () => {
    seedDraft("editor-1", "Server version", 2);
    const hold = backend.hold("web_annotation_draft_get");
    const { result } = renderDraft();
    act(() => result.current.setText("Typed first"));
    hold.release();
    await waitFor(() => expect(result.current.status).toBe("conflict"));

    act(() => result.current.resolveConflict("use-server"));
    expect(result.current.text).toBe("Server version");
    expect(result.current.status).toBe("saved");
    await new Promise((resolve) => setTimeout(resolve, DRAFT_AUTOSAVE_MS + 100));
    expect(backend.callsOf("web_annotation_draft_save")).toHaveLength(0);
  });

  test("switching editors flushes pending text to the editor it was typed in", async () => {
    const { result, rerender } = renderDraft("editor-1");
    await waitFor(() => expect(result.current.status).toBe("idle"));
    act(() => result.current.setText("Half-written note"));

    rerender({ editorId: "editor-2" });

    await waitFor(() => expect(backend.callsOf("web_annotation_draft_save")).toHaveLength(1));
    expect(backend.callsOf("web_annotation_draft_save")[0]!.args).toMatchObject({
      editorId: "editor-1",
      text: "Half-written note",
    });
    expect(backend.drafts.get("editor-1")?.text).toBe("Half-written note");
    // The new editor starts empty and hydrates its own draft.
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(result.current.text).toBe("");
    expect(backend.drafts.has("editor-2")).toBe(false);
  });

  test("a save conflict keeps the local text and reports the server version", async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.status).toBe("idle"));
    // Another client saved this editor after we hydrated.
    seedDraft("editor-1", "Saved elsewhere", 1);
    act(() => result.current.setText("Mine"));
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.status).toBe("conflict");
    expect(result.current.text).toBe("Mine");
    expect(result.current.conflict).toMatchObject({ local: "Mine", server: "Saved elsewhere" });
  });
});
