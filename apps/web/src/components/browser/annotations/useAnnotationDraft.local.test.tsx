import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { readLocalDraft } from "@/lib/web-annotations/local-drafts";
import {
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import { unsavedRemainder, useAnnotationDraft } from "./useAnnotationDraft";

let backend: FakeWebAnnotationBackend;
let bus: ReturnType<typeof installFakeOrkestrator>;

function renderDraft(editorId = "editor-local") {
  return renderHook(() =>
    useAnnotationDraft({
      environmentId: "env-1",
      editorId,
      context: { annotationId: "annotation-1" },
      enabled: true,
    }),
  );
}

describe("useAnnotationDraft local copy", () => {
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

  test("text typed while the backend is down survives unmount and is flushed later", async () => {
    const first = renderDraft();
    await waitFor(() => expect(first.result.current.status).toBe("idle"));
    backend.fail("web_annotation_draft_save", new Error("Gateway disconnected"), { times: 5 });
    act(() => first.result.current.setText("Typed offline"));
    await act(async () => {
      await first.result.current.flush();
    });
    expect(first.result.current.status).toBe("error");
    expect(first.result.current.localOnly).toBe(true);
    expect(readLocalDraft("env-1", "editor-local")?.text).toBe("Typed offline");
    first.unmount();

    // A later mount (reload) restores the text immediately and flushes it.
    backend.failures.clear();
    const second = renderDraft();
    expect(second.result.current.text).toBe("Typed offline");
    await waitFor(() => expect(second.result.current.status).toBe("saved"));
    expect(backend.drafts.get("editor-local")?.text).toBe("Typed offline");
    expect(readLocalDraft("env-1", "editor-local")).toBeNull();
  });

  test("a reconnect flushes unsaved text", async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.status).toBe("idle"));
    backend.fail("web_annotation_draft_save", new Error("Gateway disconnected"));
    act(() => result.current.setText("Retry me"));
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.status).toBe("error");
    await act(async () => {
      bus.emit(NATIVE_EVENT_STREAM_CONNECTED_EVENT, {});
    });
    await waitFor(() => expect(result.current.status).toBe("saved"));
    expect(backend.drafts.get("editor-local")?.text).toBe("Retry me");
  });

  test("a restored copy never overwrites a newer server draft", async () => {
    window.localStorage.setItem(
      "orkestrator.web-annotations.local-drafts.v1",
      JSON.stringify({
        "env-1\u0000editor-local": { text: "Old local", baseRevision: 1, updatedAt: Date.now() },
      }),
    );
    backend.drafts.set("editor-local", {
      id: "draft-editor-local",
      environmentId: "env-1",
      editorId: "editor-local",
      revision: 3,
      annotationId: null,
      captureId: null,
      pendingCaptureId: null,
      text: "Newer elsewhere",
      operation: null,
      destination: null,
      updatedAt: "2026-09-21T12:00:00.000Z",
    });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.status).toBe("conflict"));
    expect(result.current.text).toBe("Old local");
    expect(result.current.conflict).toMatchObject({ server: "Newer elsewhere", serverRevision: 3 });
  });

  test("clearing after a publish keeps text typed during the save", async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.status).toBe("idle"));
    act(() => result.current.setText("First part"));
    act(() => result.current.setText("First part and more"));
    let remainder = "";
    await act(async () => {
      remainder = await result.current.clearSaved("First part");
    });
    expect(remainder).toBe("and more");
    expect(result.current.text).toBe("and more");
    expect(unsavedRemainder("same", "same")).toBe("");
    expect(unsavedRemainder("abc", "xyz")).toBe("xyz");
  });
});
