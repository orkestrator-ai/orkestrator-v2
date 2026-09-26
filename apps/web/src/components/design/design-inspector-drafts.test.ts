import { afterEach, describe, expect, test } from "bun:test";
import {
  INSPECTOR_DRAFT_LIMIT,
  clearInspectorDrafts,
  findEarlierInspectorDraft,
  inspectorDraftCount,
  readInspectorDraft,
  writeInspectorDraft,
} from "./design-inspector-drafts";

const target = (selector: string, structureId?: string) => ({
  environmentKey: "env",
  frameId: "frame",
  selector,
  ...(structureId ? { structureId } : {}),
});
const draft = (value: string) => ({ values: { width: value }, bases: { width: "" } });

afterEach(() => clearInspectorDrafts());

describe("inspector draft retention", () => {
  test("stores, returns copies, and deletes empty drafts", () => {
    writeInspectorDraft(target("#a", "s1"), draft("10px"));
    const read = readInspectorDraft(target("#a", "s1"));
    expect(read).toEqual(draft("10px"));
    read!.values.width = "mutated";
    expect(readInspectorDraft(target("#a", "s1"))?.values.width).toBe("10px");
    expect(readInspectorDraft(target("#a", "s2"))).toBeUndefined();
    writeInspectorDraft(target("#a", "s1"), { values: {}, bases: {} });
    expect(readInspectorDraft(target("#a", "s1"))).toBeUndefined();
  });

  test("keys by environment so namespaces do not collide", () => {
    writeInspectorDraft(target("#a"), draft("10px"));
    expect(
      readInspectorDraft({ environmentKey: "other", frameId: "frame", selector: "#a" }),
    ).toBeUndefined();
  });

  test("is bounded and evicts the least recently used draft", () => {
    for (let index = 0; index < INSPECTOR_DRAFT_LIMIT; index++)
      writeInspectorDraft(target(`#e${index}`), draft(`${index}px`));
    // Touch the oldest so the second oldest is evicted instead.
    expect(readInspectorDraft(target("#e0"))).toBeDefined();
    writeInspectorDraft(target("#extra"), draft("1px"));
    expect(inspectorDraftCount()).toBe(INSPECTOR_DRAFT_LIMIT);
    expect(readInspectorDraft(target("#e0"))).toBeDefined();
    expect(readInspectorDraft(target("#e1"))).toBeUndefined();
    for (let index = 0; index < 40; index++)
      writeInspectorDraft(target(`#f${index}`), draft("1px"));
    expect(inspectorDraftCount()).toBe(INSPECTOR_DRAFT_LIMIT);
  });

  test("finds a draft left under an earlier structure identity", () => {
    writeInspectorDraft(target("#a", "s1"), draft("10px"));
    expect(findEarlierInspectorDraft(target("#a", "s1"))).toBeUndefined();
    expect(findEarlierInspectorDraft(target("#b", "s2"))).toBeUndefined();
    expect(findEarlierInspectorDraft(target("#a", "s2"))).toEqual({
      target: target("#a", "s1"),
      draft: draft("10px"),
    });
  });
});
