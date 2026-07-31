import { beforeEach, describe, expect, test } from "bun:test";
import {
  claudeQuestionDraftKey,
  codexInteractionDraftKey,
  openCodeQuestionDraftKey,
  usePromptDraftStore,
} from "./promptDraftStore";

beforeEach(() => {
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
    usePromptDraftStore.getState().setDraftValue(
      claudeQuestionDraftKey("session-a", "request-1"),
      "answers",
      [["unfinished"]],
    );

    usePromptDraftStore.getState().reset();
    expect(usePromptDraftStore.getState().drafts.size).toBe(0);
  });
});
