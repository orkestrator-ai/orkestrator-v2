import { afterEach, describe, expect, test } from "bun:test";
import { useMessagePartExpansionStore } from "./messagePartExpansionStore";

function keys(): ReadonlySet<string> {
  return useMessagePartExpansionStore.getState().expandedKeys;
}

function setExpanded(key: string, expanded: boolean) {
  useMessagePartExpansionStore.getState().setExpanded(key, expanded);
}

describe("messagePartExpansionStore", () => {
  afterEach(() => {
    useMessagePartExpansionStore.getState().reset();
  });

  test("starts empty and records expanded keys", () => {
    expect(keys().size).toBe(0);

    setExpanded("msg-1-part-0", true);

    expect(keys().has("msg-1-part-0")).toBe(true);
  });

  test("collapsing removes the key rather than storing false", () => {
    setExpanded("msg-1-part-0", true);
    setExpanded("msg-1-part-0", false);

    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().size).toBe(0);
  });

  test("keeps keys independent so one part does not toggle another", () => {
    setExpanded("msg-1-part-0", true);
    setExpanded("msg-1-part-1", true);
    setExpanded("msg-1-part-0", false);

    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().has("msg-1-part-1")).toBe(true);
  });

  test("a no-op write keeps the same set instance so subscribers do not re-render", () => {
    setExpanded("msg-1-part-0", true);
    const before = keys();

    setExpanded("msg-1-part-0", true);
    expect(keys()).toBe(before);

    setExpanded("msg-1-part-9", false);
    expect(keys()).toBe(before);
  });

  test("a real write replaces the set instead of mutating it", () => {
    setExpanded("msg-1-part-0", true);
    const before = keys();

    setExpanded("msg-1-part-1", true);

    expect(keys()).not.toBe(before);
    expect(before.has("msg-1-part-1")).toBe(false);
  });

  test("evicts the oldest keys once the cap is exceeded", () => {
    for (let index = 0; index < 505; index++) {
      setExpanded(`msg-1-part-${index}`, true);
    }

    expect(keys().size).toBe(500);
    // The first five expansions were dropped, the newest are retained.
    expect(keys().has("msg-1-part-0")).toBe(false);
    expect(keys().has("msg-1-part-4")).toBe(false);
    expect(keys().has("msg-1-part-5")).toBe(true);
    expect(keys().has("msg-1-part-504")).toBe(true);
  });

  test("reset clears every remembered key", () => {
    setExpanded("msg-1-part-0", true);
    setExpanded("msg-2-part-0", true);

    useMessagePartExpansionStore.getState().reset();

    expect(keys().size).toBe(0);
  });
});
