import { beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  claudePlanApprovalDraftKey,
  claudeQuestionDraftKey,
  codexInteractionDraftKey,
  openCodeQuestionDraftKey,
  tmuxElicitationDraftKey,
  tmuxPlanDraftKey,
  tmuxQuestionDraftKey,
  usePromptDraftField,
  usePromptDraftStore,
} from "./promptDraftStore";

beforeEach(() => {
  cleanup();
  usePromptDraftStore.getState().reset();
});

describe("promptDraftStore", () => {
  test("merges fields under one draft key and clears them together", () => {
    const store = usePromptDraftStore.getState();
    store.setDraftValue("k1", "answers", [["A"]]);
    store.setDraftValue("k1", "customTexts", ["draft"]);

    expect(usePromptDraftStore.getState().drafts.get("k1")).toEqual({
      answers: [["A"]],
      customTexts: ["draft"],
    });

    store.clearDraft("k1");
    expect(usePromptDraftStore.getState().drafts.has("k1")).toBe(false);
  });

  test("clearDrafts removes only the given keys and skips misses quietly", () => {
    const store = usePromptDraftStore.getState();
    store.setDraftValue("k1", "f", 1);
    store.setDraftValue("k2", "f", 2);

    const before = usePromptDraftStore.getState().drafts;
    store.clearDrafts(["k1", "missing"]);
    const after = usePromptDraftStore.getState().drafts;

    expect(after.has("k1")).toBe(false);
    expect(after.get("k2")).toEqual({ f: 2 });

    // Clearing nothing must not churn the map reference (avoids rerenders).
    store.clearDrafts(["also-missing"]);
    expect(usePromptDraftStore.getState().drafts).toBe(after);
    expect(before).not.toBe(after);
  });

  test("caps retained drafts by trimming the least recently edited", () => {
    const store = usePromptDraftStore.getState();
    for (let i = 0; i < 100; i++) {
      store.setDraftValue(`k${i}`, "f", i);
    }
    // Editing k0 re-inserts it at the back, so it is no longer the stalest.
    store.setDraftValue("k0", "f", "edited");
    store.setDraftValue("k100", "f", 100);

    const drafts = usePromptDraftStore.getState().drafts;
    expect(drafts.size).toBe(100);
    expect(drafts.has("k0")).toBe(true);
    expect(drafts.has("k100")).toBe(true);
    // k1 was the least recently edited once k0 moved to the back.
    expect(drafts.has("k1")).toBe(false);
  });

  test("namespaces drafts by provider, session, and request identity", () => {
    const keys = [
      claudeQuestionDraftKey("session-a", "request-1"),
      claudeQuestionDraftKey("session-b", "request-1"),
      openCodeQuestionDraftKey("session-a", "request-1"),
      codexInteractionDraftKey("session-a", "request-1"),
    ];

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toContain("session-a");
    expect(keys[0]).toContain("request-1");
  });

  test("renderer restart reset drops every in-memory draft", () => {
    usePromptDraftStore
      .getState()
      .setDraftValue(claudeQuestionDraftKey("session-a", "request-1"), "answers", [["unfinished"]]);

    usePromptDraftStore.getState().reset();
    expect(usePromptDraftStore.getState().drafts.size).toBe(0);
  });

  test("clearDraft is a no-op without map churn when the key is absent", () => {
    const before = usePromptDraftStore.getState().drafts;
    usePromptDraftStore.getState().clearDraft("missing");
    expect(usePromptDraftStore.getState().drafts).toBe(before);
  });

  test("builds every public provider key and URI-encodes scoped identities", () => {
    const session = "session:/雪";
    const request = "request:%/🙂";
    const builders = [
      claudeQuestionDraftKey,
      claudePlanApprovalDraftKey,
      openCodeQuestionDraftKey,
      codexInteractionDraftKey,
      tmuxQuestionDraftKey,
      tmuxPlanDraftKey,
      tmuxElicitationDraftKey,
    ];

    const keys = builders.map((builder) => builder(session, request));
    expect(new Set(keys).size).toBe(builders.length);
    for (const key of keys) {
      expect(key).toContain(encodeURIComponent(session));
      expect(key).toContain(encodeURIComponent(request));
      expect(key).not.toContain("雪");
      expect(key).not.toContain("🙂");
    }
  });
});

describe("usePromptDraftField", () => {
  test("applies functional updates to shared and component-local fields", () => {
    const shared = renderHook(() => usePromptDraftField("draft", "count", () => 1));
    act(() => shared.result.current[1]((value) => value + 1));
    expect(shared.result.current[0]).toBe(2);
    expect(usePromptDraftStore.getState().drafts.get("draft")?.count).toBe(2);
    shared.unmount();

    const local = renderHook(() => usePromptDraftField<number>(undefined, "count", () => 4));
    act(() => local.result.current[1]((value) => value + 3));
    expect(local.result.current[0]).toBe(7);
    expect(usePromptDraftStore.getState().drafts.size).toBe(1);
  });

  test("switches key and field identities without leaking the previous fallback", () => {
    const hook = renderHook(
      ({ draftKey, field, seed }: { draftKey?: string; field: string; seed: number }) =>
        usePromptDraftField(draftKey, field, () => seed),
      { initialProps: { draftKey: "first", field: "count", seed: 1 } },
    );
    act(() => hook.result.current[1](5));
    expect(hook.result.current[0]).toBe(5);

    hook.rerender({ draftKey: "second", field: "count", seed: 10 });
    expect(hook.result.current[0]).toBe(10);
    act(() => hook.result.current[1]((value) => value + 1));
    expect(hook.result.current[0]).toBe(11);
    expect(usePromptDraftStore.getState().drafts.get("first")?.count).toBe(5);

    hook.rerender({ draftKey: "second", field: "other", seed: 20 });
    expect(hook.result.current[0]).toBe(20);
  });

  test("prefers a stored value over a new identity's initializer", () => {
    usePromptDraftStore.getState().setDraftValue("second", "count", 42);
    const hook = renderHook(
      ({ draftKey, seed }: { draftKey: string; seed: number }) =>
        usePromptDraftField(draftKey, "count", () => seed),
      { initialProps: { draftKey: "first", seed: 1 } },
    );

    hook.rerender({ draftKey: "second", seed: 10 });
    expect(hook.result.current[0]).toBe(42);
  });

  test("reinitializes local fallback state when its field identity changes", () => {
    const hook = renderHook(
      ({ field, seed }: { field: string; seed: number }) =>
        usePromptDraftField<number>(undefined, field, () => seed),
      { initialProps: { field: "first", seed: 1 } },
    );
    act(() => hook.result.current[1](9));
    expect(hook.result.current[0]).toBe(9);

    hook.rerender({ field: "second", seed: 2 });
    expect(hook.result.current[0]).toBe(2);
    act(() => hook.result.current[1]((value) => value + 1));
    expect(hook.result.current[0]).toBe(3);
  });
});
